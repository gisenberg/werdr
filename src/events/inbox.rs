//! Owner-retained events staged while a capture is waiting for producers.
//!
//! Staging never runs handlers and never sends back into the bounded channel.
//! The inbox, not a capture future, owns removed events so cancellation cannot
//! lose them. Every normal receive observes staged events before later arrivals.

#[cfg(any(unix, test))]
use super::admission::AdmissionCut;
use super::admission::{Admission, Envelope};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

pub(crate) struct OwnerInbox<T> {
    channel: mpsc::Receiver<Envelope<T>>,
    staged: VecDeque<Envelope<T>>,
    #[cfg(any(unix, test))]
    admission: Arc<Mutex<Admission>>,
    delivered: u64,
}

impl<T> OwnerInbox<T> {
    pub(super) fn new(
        channel: mpsc::Receiver<Envelope<T>>,
        _admission: Arc<Mutex<Admission>>,
    ) -> Self {
        Self {
            channel,
            staged: VecDeque::new(),
            #[cfg(any(unix, test))]
            admission: _admission,
            delivered: 0,
        }
    }

    pub(crate) async fn recv(&mut self) -> Option<T> {
        let envelope = match self.staged.pop_front() {
            Some(event) => Some(event),
            None => self.channel.recv().await,
        }?;
        self.delivered = envelope.sequence;
        Some(envelope.event)
    }

    pub(crate) fn try_recv(&mut self) -> Result<T, mpsc::error::TryRecvError> {
        let envelope = match self.staged.pop_front() {
            Some(event) => Ok(event),
            None => self.channel.try_recv(),
        }?;
        self.delivered = envelope.sequence;
        Ok(envelope.event)
    }

    #[cfg(any(unix, test))]
    pub(crate) fn admission_cut(&self) -> Result<AdmissionCut, &'static str> {
        let admission = self
            .admission
            .lock()
            .map_err(|_| "event admission lock poisoned")?;
        Ok(AdmissionCut {
            admission: self.admission.clone(),
            sequence: admission.published,
        })
    }

    /// Delivery is not handler completion. Capture must run each returned event
    /// before requesting the next. A normal receive may already have passed cut.
    #[cfg(any(unix, test))]
    pub(crate) fn try_recv_through(
        &mut self,
        cut: &AdmissionCut,
    ) -> Result<Option<T>, &'static str> {
        if !Arc::ptr_eq(&self.admission, &cut.admission) {
            return Err("event admission cut belongs to another inbox");
        }
        if self.delivered >= cut.sequence {
            return Ok(None);
        }
        // Publication occurred synchronously before the cut was sampled, so
        // an absent next event is an invariant failure, never a reason to wait.
        let envelope = match self.staged.pop_front() {
            Some(event) => event,
            None => self
                .channel
                .try_recv()
                .map_err(|_| "admitted event prefix is unavailable")?,
        };
        if Some(envelope.sequence) != self.delivered.checked_add(1)
            || envelope.sequence > cut.sequence
        {
            self.staged.push_front(envelope);
            return Err("admitted event prefix has a sequence gap");
        }
        self.delivered = envelope.sequence;
        Ok(Some(envelope.event))
    }

    #[cfg(all(test, unix))]
    pub(crate) fn len(&self) -> usize {
        self.staged.len() + self.channel.len()
    }

    #[cfg(any(unix, test))]
    pub(crate) fn is_empty(&self) -> bool {
        self.staged.is_empty() && self.channel.is_empty()
    }

    /// Bounds additional retained event *count*, not their existing heap payloads.
    /// No event is removed unless storage has been reserved first. In particular,
    /// limit/allocation failure leaves the next event in the channel untouched.
    #[cfg(unix)]
    pub(crate) async fn stage_next(&mut self, limit: usize) -> Result<bool, &'static str> {
        if self.staged.len() >= limit {
            return Err("capture event staging limit reached");
        }
        self.staged
            .try_reserve(1)
            .map_err(|_| "capture event staging allocation failed")?;
        match self.channel.recv().await {
            Some(event) => {
                self.staged.push_back(event);
                Ok(true)
            }
            None => Ok(false),
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::{future::Future, task::Poll};

    #[tokio::test]
    async fn staged_events_precede_channel_events_for_both_receive_paths() {
        let (tx, mut inbox) = super::super::channel(2);
        tx.send(1).await.unwrap();
        tx.send(2).await.unwrap();
        assert!(inbox.stage_next(2).await.unwrap());
        tx.send(3).await.unwrap();
        assert_eq!(inbox.len(), 3);
        assert_eq!(inbox.recv().await, Some(1));
        assert_eq!(inbox.try_recv().unwrap(), 2);
        assert_eq!(inbox.recv().await, Some(3));
        assert!(inbox.is_empty());
    }

    #[tokio::test]
    async fn exhaustion_and_cancelled_receive_do_not_drop_or_reorder_events() {
        let (tx, mut inbox) = super::super::channel(1);
        tx.send(1).await.unwrap();
        inbox.stage_next(1).await.unwrap();
        tx.send(2).await.unwrap();
        assert!(inbox.stage_next(1).await.is_err());
        assert_eq!(inbox.try_recv().unwrap(), 1);
        assert_eq!(inbox.try_recv().unwrap(), 2);
        let mut pending = Box::pin(inbox.stage_next(1));
        std::future::poll_fn(|cx| {
            assert!(pending.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        drop(pending);
        tx.send(3).await.unwrap();
        inbox.stage_next(1).await.unwrap();
        drop(tx);
        assert_eq!(inbox.recv().await, Some(3));
        assert_eq!(inbox.recv().await, None);
    }
}
