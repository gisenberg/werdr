//! Owner-retained events staged while a capture is waiting for producers.
//!
//! Staging never runs handlers and never sends back into the bounded channel.
//! The inbox, not a capture future, owns removed events so cancellation cannot
//! lose them. Every normal receive observes staged events before later arrivals.

use std::collections::VecDeque;
use tokio::sync::mpsc;

pub(crate) struct OwnerInbox<T> {
    channel: mpsc::Receiver<T>,
    staged: VecDeque<T>,
}

impl<T> OwnerInbox<T> {
    pub(crate) fn new(channel: mpsc::Receiver<T>) -> Self {
        Self {
            channel,
            staged: VecDeque::new(),
        }
    }

    pub(crate) async fn recv(&mut self) -> Option<T> {
        match self.staged.pop_front() {
            Some(event) => Some(event),
            None => self.channel.recv().await,
        }
    }

    pub(crate) fn try_recv(&mut self) -> Result<T, mpsc::error::TryRecvError> {
        match self.staged.pop_front() {
            Some(event) => Ok(event),
            None => self.channel.try_recv(),
        }
    }

    #[cfg(unix)]
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
    use super::*;
    use std::{future::Future, task::Poll};

    #[tokio::test]
    async fn staged_events_precede_channel_events_for_both_receive_paths() {
        let (tx, rx) = mpsc::channel(2);
        let mut inbox = OwnerInbox::new(rx);
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
        let (tx, rx) = mpsc::channel(1);
        let mut inbox = OwnerInbox::new(rx);
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
