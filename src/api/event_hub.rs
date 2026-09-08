#[derive(Clone, Default)]
pub struct EventHub {
    inner: std::sync::Arc<std::sync::Mutex<EventHubState>>,
}

#[derive(Default)]
struct EventHubState {
    next_sequence: u64,
    next_notification_subscriber: u64,
    notification_subscribers: std::collections::HashMap<
        u64,
        std::sync::mpsc::SyncSender<crate::api::schema::EventEnvelope>,
    >,
    events: Vec<(u64, crate::api::schema::EventEnvelope)>,
}

impl EventHub {
    const MAX_EVENTS: usize = 512;

    pub fn push(&self, event: crate::api::schema::EventEnvelope) {
        let Ok(mut state) = self.inner.lock() else {
            return;
        };
        state.next_sequence += 1;
        let sequence = state.next_sequence;
        state.events.push((sequence, event));
        let overflow = state.events.len().saturating_sub(Self::MAX_EVENTS);
        if overflow > 0 {
            state.events.drain(0..overflow);
        }
    }

    pub fn events_after(&self, sequence: u64) -> Vec<(u64, crate::api::schema::EventEnvelope)> {
        let Ok(state) = self.inner.lock() else {
            return Vec::new();
        };
        state
            .events
            .iter()
            .filter(|(event_sequence, _)| *event_sequence > sequence)
            .cloned()
            .collect()
    }

    pub fn current_sequence(&self) -> u64 {
        let Ok(state) = self.inner.lock() else {
            return 0;
        };
        state.next_sequence
    }
}

/// A delivery sink exists only while its subscription connection is alive.
pub(crate) struct SemanticNotificationSubscription {
    hub: EventHub,
    id: u64,
    receiver: std::sync::mpsc::Receiver<crate::api::schema::EventEnvelope>,
}

impl SemanticNotificationSubscription {
    pub(crate) fn poll(&self) -> Option<crate::api::schema::EventEnvelope> {
        self.receiver.try_recv().ok()
    }
}

impl Drop for SemanticNotificationSubscription {
    fn drop(&mut self) {
        if let Ok(mut state) = self.hub.inner.lock() {
            state.notification_subscribers.remove(&self.id);
        }
    }
}

impl EventHub {
    pub(crate) fn subscribe_semantic_notifications(&self) -> SemanticNotificationSubscription {
        let (sender, receiver) = std::sync::mpsc::sync_channel(Self::MAX_EVENTS);
        let mut state = self.inner.lock().unwrap_or_else(|error| error.into_inner());
        state.next_notification_subscriber += 1;
        let id = state.next_notification_subscriber;
        state.notification_subscribers.insert(id, sender);
        SemanticNotificationSubscription {
            hub: self.clone(),
            id,
            receiver,
        }
    }

    pub(crate) fn has_semantic_notification_subscribers(&self) -> bool {
        self.inner
            .lock()
            .is_ok_and(|state| !state.notification_subscribers.is_empty())
    }

    /// Success means at least one live sink accepted this bounded event.
    pub(crate) fn publish_semantic_notification(
        &self,
        notification: crate::api::schema::SemanticNotificationEvent,
    ) -> bool {
        let event = crate::api::schema::EventEnvelope {
            event: crate::api::schema::EventKind::NotificationSemantic,
            data: crate::api::schema::EventData::NotificationSemantic { notification },
        };
        let Ok(mut state) = self.inner.lock() else {
            return false;
        };
        let mut delivered = false;
        state
            .notification_subscribers
            .retain(|_, sender| match sender.try_send(event.clone()) {
                Ok(()) => {
                    delivered = true;
                    true
                }
                Err(std::sync::mpsc::TrySendError::Full(_)) => true,
                Err(std::sync::mpsc::TrySendError::Disconnected(_)) => false,
            });
        delivered
    }
}

#[cfg(test)]
mod notification_tests {
    use super::*;

    fn notification() -> crate::api::schema::SemanticNotificationEvent {
        crate::api::schema::SemanticNotificationEvent {
            kind: crate::api::schema::SemanticNotificationKind::Custom,
            title: "event".into(),
            body: None,
            sound: None,
            agent: None,
            workspace_id: None,
            tab_id: None,
            pane_id: None,
            terminal_id: None,
            position: None,
        }
    }

    #[test]
    fn semantic_notification_sinks_are_bounded_ephemeral_and_scoped() {
        let hub = EventHub::default();
        assert!(!hub.publish_semantic_notification(notification()));
        let subscription = hub.subscribe_semantic_notifications();
        assert!(
            subscription.poll().is_none(),
            "new subscriptions must not replay old notifications"
        );
        for _ in 0..EventHub::MAX_EVENTS {
            assert!(hub.publish_semantic_notification(notification()));
        }
        assert!(
            !hub.publish_semantic_notification(notification()),
            "full sink must not claim delivery"
        );
        assert!(subscription.poll().is_some());
        assert!(hub.publish_semantic_notification(notification()));
        let second = hub.subscribe_semantic_notifications();
        assert!(second.poll().is_none());
        assert!(
            hub.publish_semantic_notification(notification()),
            "one full sink must not block another"
        );
        assert!(second.poll().is_some());
        drop(subscription);
        drop(second);
        assert!(!hub.has_semantic_notification_subscribers());
        assert!(!hub.publish_semantic_notification(notification()));
        assert!(
            hub.events_after(0).is_empty(),
            "semantic events are not historical lifecycle events"
        );
    }
}
