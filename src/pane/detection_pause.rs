//! Cooperative suspension between complete detector iterations.
//!
//! Acknowledgement covers preceding mutations and publication attempts, not
//! application of queued events by their owner. Never cancel an iteration to
//! acknowledge a pause: it may be holding task-local authority or publishing.

use std::{io, time::Duration};
use tokio::sync::watch;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Request {
    Running,
    Pause(u64),
}

pub(super) struct Controller {
    request: watch::Sender<Request>,
    acknowledged: watch::Receiver<u64>,
    generation: u64,
}

pub(super) struct Worker {
    request: watch::Receiver<Request>,
    acknowledged: watch::Sender<u64>,
}

pub(super) struct Paused {
    request: watch::Sender<Request>,
    generation: u64,
}

pub(super) fn channel() -> (Controller, Worker) {
    let (request_tx, request_rx) = watch::channel(Request::Running);
    let (ack_tx, ack_rx) = watch::channel(0);
    (
        Controller {
            request: request_tx,
            acknowledged: ack_rx,
            generation: 0,
        },
        Worker {
            request: request_rx,
            acknowledged: ack_tx,
        },
    )
}

// The capture coordinator is private and Unix-only until complete runtime
// handoff exists. Windows detectors still use the same checkpoint contract.
#[allow(dead_code)]
impl Controller {
    pub(super) async fn pause(&mut self, timeout: Duration) -> io::Result<Paused> {
        if *self.request.borrow() != Request::Running {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "detector already paused",
            ));
        }
        let generation = self
            .generation
            .checked_add(1)
            .ok_or_else(|| io::Error::other("detector pause generation exhausted"))?;
        self.generation = generation;
        // Own cancellation cleanup before either publishing or awaiting.
        let paused = Paused {
            request: self.request.clone(),
            generation,
        };
        self.request
            .send(Request::Pause(generation))
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "detector task exited"))?;
        tokio::time::timeout(timeout, async {
            loop {
                if *self.acknowledged.borrow_and_update() == generation {
                    return Ok::<(), io::Error>(());
                }
                self.acknowledged.changed().await.map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::BrokenPipe,
                        "detector exited before pause acknowledgement",
                    )
                })?;
            }
        })
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "timed out pausing detector"))??;
        Ok(paused)
    }
}

impl Drop for Paused {
    fn drop(&mut self) {
        self.request.send_if_modified(|request| {
            if *request == Request::Pause(self.generation) {
                *request = Request::Running;
                true
            } else {
                false
            }
        });
    }
}

impl Worker {
    /// Call only between complete iterations, outside terminal locks. A pause
    /// retains all task-local variables on this suspended future's stack.
    pub(super) async fn checkpoint(&mut self) -> bool {
        loop {
            if self.request.has_changed().is_err() {
                return false;
            }
            let request = *self.request.borrow_and_update();
            match request {
                Request::Running => return true,
                Request::Pause(generation) => {
                    self.acknowledged.send_replace(generation);
                }
            }
            // Running -> Pause(new) may coalesce while suspended. Loop and
            // acknowledge the new generation without requiring a Running edge.
            if self.request.changed().await.is_err() {
                return false;
            }
        }
    }

    /// Wake an idle detector so the next top-level checkpoint can acknowledge.
    pub(super) async fn changed(&mut self) {
        let _ = self.request.changed().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{future::Future, pin::Pin, task::Poll};
    use tokio::sync::{mpsc, oneshot};

    const TIMEOUT: Duration = Duration::from_secs(2);

    async fn assert_pending<F: Future>(mut future: Pin<&mut F>) {
        std::future::poll_fn(|cx| {
            assert!(future.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
    }

    fn counting_worker(
        mut worker: Worker,
    ) -> (
        mpsc::Sender<oneshot::Sender<u32>>,
        tokio::task::JoinHandle<()>,
    ) {
        let (work_tx, mut work_rx) = mpsc::channel::<oneshot::Sender<u32>>(8);
        let task = tokio::spawn(async move {
            let mut count = 0;
            while worker.checkpoint().await {
                tokio::select! {
                    _ = worker.changed() => continue,
                    work = work_rx.recv() => {
                        let Some(reply) = work else { break; };
                        count += 1;
                        let _ = reply.send(count);
                    }
                }
            }
        });
        (work_tx, task)
    }

    #[tokio::test]
    async fn repeated_pauses_preserve_local_state_and_hold_queued_work() {
        let (mut controller, worker) = channel();
        let (work, task) = counting_worker(worker);
        for expected in 1..=3 {
            let pause = controller.pause(TIMEOUT).await.unwrap();
            let (reply_tx, mut reply_rx) = oneshot::channel();
            work.send(reply_tx).await.unwrap();
            tokio::task::yield_now().await;
            assert!(matches!(
                reply_rx.try_recv(),
                Err(oneshot::error::TryRecvError::Empty)
            ));
            drop(pause);
            assert_eq!(reply_rx.await.unwrap(), expected);
        }
        drop(controller);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn blocked_publication_prevents_ack_and_timeout_does_not_cancel_it() {
        let (mut controller, mut worker) = channel();
        let (events, mut events_rx) = mpsc::channel(1);
        events.send(1).await.unwrap();
        let (entered_tx, entered_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            entered_tx.send(()).unwrap();
            events.send(2).await.unwrap();
            while worker.checkpoint().await {
                worker.changed().await;
            }
        });
        entered_rx.await.unwrap();
        let error = controller.pause(Duration::ZERO).await.err().unwrap();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert_eq!(*controller.request.borrow(), Request::Running);
        assert_eq!(*controller.acknowledged.borrow(), 0);
        assert_eq!(events_rx.recv().await, Some(1));
        assert_eq!(events_rx.recv().await, Some(2));
        let pause = controller.pause(TIMEOUT).await.unwrap();
        drop(pause);
        drop(controller);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn cancelled_request_reopens_and_stale_ack_cannot_complete_retry() {
        let (mut controller, worker) = channel();
        let (release_tx, release_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            release_rx.await.unwrap();
            let mut worker = worker;
            while worker.checkpoint().await {
                worker.changed().await;
            }
        });
        let mut first = Box::pin(controller.pause(TIMEOUT));
        assert_pending(first.as_mut()).await;
        drop(first);
        assert_eq!(*controller.request.borrow(), Request::Running);
        let mut retry = Box::pin(controller.pause(TIMEOUT));
        assert_pending(retry.as_mut()).await;
        release_tx.send(()).unwrap();
        let lease = retry.await.unwrap();
        assert_eq!(*controller.acknowledged.borrow(), 2);
        drop(lease);
        drop(controller);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn replacement_generation_is_acknowledged_without_running_edge() {
        let (mut controller, worker) = channel();
        let (_work, task) = counting_worker(worker);
        let first = controller.pause(TIMEOUT).await.unwrap();
        let stale = Paused {
            request: first.request.clone(),
            generation: first.generation,
        };
        drop(first);
        // No executor yield between resume and the replacement request: the
        // worker sees Pause(2), not the intervening Running state.
        let mut next = Box::pin(controller.pause(TIMEOUT));
        assert_pending(next.as_mut()).await;
        drop(stale);
        let second = next.await.unwrap();
        assert_eq!(*controller.request.borrow(), Request::Pause(2));
        assert_eq!(*controller.acknowledged.borrow(), 2);
        drop(second);
        drop(controller);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_after_ack_still_releases_pause() {
        let (mut controller, worker) = channel();
        let mut ack = controller.acknowledged.clone();
        let (_work, task) = counting_worker(worker);
        let mut request = Box::pin(controller.pause(TIMEOUT));
        assert_pending(request.as_mut()).await;
        ack.changed().await.unwrap();
        assert_eq!(*ack.borrow(), 1);
        // The controller future has not been polled to receive the lease yet.
        drop(request);
        assert_eq!(*controller.request.borrow(), Request::Running);
        let retry = controller.pause(TIMEOUT).await.unwrap();
        drop(retry);
        drop(controller);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn closed_channels_and_exhaustion_fail_without_false_acknowledgement() {
        let (mut controller, worker) = channel();
        drop(worker);
        let err = controller.pause(TIMEOUT).await.err().unwrap();
        assert_eq!(err.kind(), io::ErrorKind::BrokenPipe);
        assert_eq!(*controller.request.borrow(), Request::Running);

        let (mut controller, mut worker) = channel();
        controller.generation = u64::MAX;
        let err = controller.pause(TIMEOUT).await.err().unwrap();
        assert!(err.to_string().contains("exhausted"));
        assert_eq!(*controller.request.borrow(), Request::Running);
        drop(controller);
        assert!(!worker.checkpoint().await);
    }

    #[tokio::test]
    async fn overlapping_request_does_not_release_existing_pause() {
        let (mut controller, worker) = channel();
        let (_work, task) = counting_worker(worker);
        let paused = controller.pause(TIMEOUT).await.unwrap();
        let err = controller.pause(TIMEOUT).await.err().unwrap();
        assert_eq!(err.kind(), io::ErrorKind::WouldBlock);
        assert_eq!(*controller.request.borrow(), Request::Pause(1));
        drop(paused);
        drop(controller);
        task.await.unwrap();
    }
}
