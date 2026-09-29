//! Publication order for internal owner events, not an effect-commit journal.
//!
//! Capacity is reserved before locking. Sequence assignment and insertion share
//! the watermark lock, so a sampled cut cannot include an unpublished event.
//! Reserved capacity and producer-local work remain outside that cut.
//! Receiver closure keeps Tokio semantics: a previously reserved permit can
//! still publish. Neither channel closure nor a cut is a producer fence.

use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

pub(super) struct Envelope<T> {
    pub(super) sequence: u64,
    pub(super) event: T,
}

#[cfg(test)]
mod tests;

#[derive(Default)]
pub(super) struct Admission {
    pub(super) published: u64,
    pub(super) work: super::work::WorkLedger,
    pub(super) failure: Option<&'static str>,
}

/// Identity-bearing process-local boundary. Not a transferable runtime token.
#[cfg(any(unix, test))]
pub(crate) struct AdmissionCut {
    pub(super) admission: Arc<Mutex<Admission>>,
    pub(super) sequence: u64,
}

pub(crate) struct AdmissionSender<T> {
    channel: mpsc::Sender<Envelope<T>>,
    admission: Arc<Mutex<Admission>>,
}

impl<T> Clone for AdmissionSender<T> {
    fn clone(&self) -> Self {
        Self {
            channel: self.channel.clone(),
            admission: self.admission.clone(),
        }
    }
}

pub(crate) fn channel<T>(capacity: usize) -> (AdmissionSender<T>, super::OwnerInbox<T>) {
    let (sender, receiver) = mpsc::channel(capacity);
    let admission = Arc::new(Mutex::new(Admission::default()));
    (
        AdmissionSender {
            channel: sender,
            admission: admission.clone(),
        },
        super::OwnerInbox::new(receiver, admission),
    )
}

impl<T> AdmissionSender<T> {
    /// Register before spawning, then start before the worker's first effect.
    pub(crate) fn register_work(
        &self,
        kind: super::BackgroundWork,
    ) -> super::work::WorkRegistration {
        super::work::WorkRegistration::new(self.admission.clone(), kind)
    }

    #[cfg(all(test, unix))]
    pub(crate) fn capacity(&self) -> usize {
        self.channel.capacity()
    }

    fn publish(
        &self,
        permit: mpsc::Permit<'_, Envelope<T>>,
        event: T,
    ) -> Result<(), mpsc::error::SendError<T>> {
        let Ok(mut admission) = self.admission.lock() else {
            return Err(mpsc::error::SendError(event));
        };
        if admission.failure.is_some() {
            return Err(mpsc::error::SendError(event));
        }
        let Some(sequence) = admission.published.checked_add(1) else {
            admission.failure = Some("event admission sequence exhausted");
            return Err(mpsc::error::SendError(event));
        };
        permit.send(Envelope { sequence, event });
        admission.published = sequence;
        Ok(())
    }

    pub(crate) async fn send(&self, event: T) -> Result<(), mpsc::error::SendError<T>> {
        let Ok(permit) = self.channel.reserve().await else {
            return Err(mpsc::error::SendError(event));
        };
        self.publish(permit, event)
    }

    pub(crate) fn try_send(&self, event: T) -> Result<(), mpsc::error::TrySendError<T>> {
        let permit = match self.channel.try_reserve() {
            Ok(permit) => permit,
            Err(mpsc::error::TrySendError::Full(_)) => {
                return Err(mpsc::error::TrySendError::Full(event));
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                return Err(mpsc::error::TrySendError::Closed(event));
            }
        };
        self.publish(permit, event)
            .map_err(|err| mpsc::error::TrySendError::Closed(err.0))
    }

    /// For background OS threads or spawn_blocking only, never an async worker.
    /// The Tokio reservation future needs a waker, not an entered runtime.
    /// Unlike Tokio's blocking_send, this adapter cannot detect executor-worker
    /// misuse: calling it there can deadlock that worker. All production callers
    /// run on dedicated OS threads.
    pub(crate) fn blocking_send(&self, event: T) -> Result<(), mpsc::error::SendError<T>> {
        self.blocking_send_with_pending(event, || {})
    }

    fn blocking_send_with_pending(
        &self,
        event: T,
        mut before_park: impl FnMut(),
    ) -> Result<(), mpsc::error::SendError<T>> {
        use std::future::Future;
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::task::{Context, Poll, Wake, Waker};
        struct ThreadWake {
            thread: std::thread::Thread,
            notified: AtomicBool,
        }
        impl Wake for ThreadWake {
            fn wake(self: Arc<Self>) {
                self.wake_by_ref();
            }
            fn wake_by_ref(self: &Arc<Self>) {
                self.notified.store(true, Ordering::Release);
                self.thread.unpark();
            }
        }
        let wake = Arc::new(ThreadWake {
            thread: std::thread::current(),
            notified: AtomicBool::new(false),
        });
        let waker = Waker::from(wake.clone());
        let mut context = Context::from_waker(&waker);
        let mut sending = std::pin::pin!(self.send(event));
        loop {
            wake.notified.store(false, Ordering::Release);
            match sending.as_mut().poll(&mut context) {
                Poll::Ready(result) => return result,
                Poll::Pending => {
                    before_park();
                    // Other synchronization on this thread may consume an
                    // unpark token. Retain notification independently, and
                    // tolerate spurious wakes without losing real readiness.
                    while !wake.notified.swap(false, Ordering::AcqRel) {
                        std::thread::park();
                    }
                }
            }
        }
    }
}
