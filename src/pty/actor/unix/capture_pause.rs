//! Private capture leases. Cancellation is an actor command, never a blocking
//! receive or caller-side guess that input admission has reopened.

use super::*;
use tokio::sync::oneshot;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum GateOwner {
    Running,
    Legacy(u64),
    Capture(u64),
    Closed,
}

pub(super) struct CaptureRequest {
    generation: u64,
    gate: Arc<Mutex<UserWriteGate>>,
    pub(super) reply: Option<oneshot::Sender<std::io::Result<()>>>,
    pub(super) deadline: Instant,
}

pub(crate) struct CapturePause {
    actor: PtyIoActorHandle,
    generation: u64,
    armed: bool,
}

impl PtyIoActorHandle {
    pub(crate) async fn pause_for_capture(
        &self,
        timeout: Duration,
    ) -> std::io::Result<CapturePause> {
        let (reply, acknowledgement) = oneshot::channel();
        let lease = {
            let mut gate = self.user_writes.lock().unwrap_or_else(|p| p.into_inner());
            if gate.owner != GateOwner::Running {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WouldBlock,
                    "PTY handoff is already in progress",
                ));
            }
            let generation = gate
                .generation
                .checked_add(1)
                .ok_or_else(|| std::io::Error::other("PTY capture generation exhausted"))?;
            gate.generation = generation;
            gate.owner = GateOwner::Capture(generation);
            let mut lease = CapturePause {
                actor: self.clone(),
                generation,
                armed: true,
            };
            if self
                .control_tx
                .send(PtyIoControlCommand::Capture(CaptureRequest {
                    generation,
                    gate: self.user_writes.clone(),
                    reply: Some(reply),
                    deadline: Instant::now() + timeout,
                }))
                .is_err()
            {
                gate.owner = GateOwner::Closed;
                lease.armed = false;
                return Err(closed());
            }
            self.wake_actor();
            lease
        };
        // Dropping this future after publication drops the armed lease even
        // when the actor's successful acknowledgement has not been observed.
        wait(acknowledgement, timeout).await?;
        Ok(lease)
    }
}

impl CapturePause {
    pub(crate) async fn resume(mut self, timeout: Duration) -> std::io::Result<()> {
        let (reply, acknowledgement) = oneshot::channel();
        self.actor
            .control_tx
            .send(PtyIoControlCommand::ResumeCapture {
                generation: self.generation,
                reply: Some(reply),
            })
            .map_err(|_| closed())?;
        self.actor.wake_actor();
        wait(acknowledgement, timeout).await?;
        self.armed = false;
        Ok(())
    }
}

impl Drop for CapturePause {
    fn drop(&mut self) {
        if self.armed {
            if self
                .actor
                .control_tx
                .send(PtyIoControlCommand::ResumeCapture {
                    generation: self.generation,
                    reply: None,
                })
                .is_ok()
            {
                self.actor.wake_actor();
            } else {
                warn!(
                    generation = self.generation,
                    "capture cleanup could not reach PTY actor"
                );
            }
        }
    }
}

async fn wait(
    reply: oneshot::Receiver<std::io::Result<()>>,
    timeout: Duration,
) -> std::io::Result<()> {
    tokio::time::timeout(timeout, reply)
        .await
        .map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "timed out waiting for PTY capture acknowledgement",
            )
        })?
        .map_err(|_| closed())?
}

fn closed() -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::BrokenPipe,
        "PTY actor closed during capture",
    )
}

impl PtyIoActorRunner {
    pub(super) fn start_capture(&mut self, request: CaptureRequest) {
        let owned = request.gate.lock().unwrap_or_else(|p| p.into_inner()).owner
            == GateOwner::Capture(request.generation);
        if !owned || self.capture.is_some() || self.state != ActorState::Running {
            // A matching reservation with inconsistent actor state must fail
            // closed, not leave a phantom capture that no actor can resume.
            if owned {
                request.gate.lock().unwrap_or_else(|p| p.into_inner()).owner = GateOwner::Closed;
            }
            if let Some(reply) = request.reply {
                let _ = reply.send(Err(closed()));
            }
            return;
        }
        self.capture = Some(request);
    }

    /// Runs once per ordinary actor iteration. Unlike legacy handoff's drain,
    /// partial writes and submission delays leave control dispatch responsive.
    pub(super) fn advance_capture(&mut self) {
        let Some(request) = self.capture.as_ref() else {
            return;
        };
        if request.reply.is_none() {
            return;
        }
        let generation = request.generation;
        if Instant::now() >= request.deadline {
            if let Some(reply) = self
                .capture
                .as_mut()
                .and_then(|request| request.reply.take())
            {
                let _ = reply.send(Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "PTY capture drain timed out",
                )));
            }
            let _ = self.resume_capture(generation);
            return;
        }
        if self.active_submission.is_some()
            || !self.data_rx.is_empty()
            || !self.pending_writes.is_empty()
        {
            return;
        }
        self.state = ActorState::Quiesced;
        if let Some(reply) = self
            .capture
            .as_mut()
            .and_then(|request| request.reply.take())
        {
            if reply.send(Ok(())).is_err() {
                let _ = self.resume_capture(generation);
            }
        }
    }

    pub(super) fn resume_capture(&mut self, generation: u64) -> std::io::Result<()> {
        if self
            .capture
            .as_ref()
            .is_none_or(|request| request.generation != generation)
        {
            // A stale cancellation must never affect a newer capture or legacy pause.
            return Ok(());
        }
        let Some(request) = self.capture.take() else {
            return Ok(());
        };
        let mut gate = request.gate.lock().unwrap_or_else(|p| p.into_inner());
        if self.state == ActorState::Released || gate.owner == GateOwner::Closed {
            return Err(closed());
        }
        if gate.owner == GateOwner::Capture(generation) {
            self.state = ActorState::Running;
            gate.owner = GateOwner::Running;
        }
        Ok(())
    }

    pub(super) fn close_capture(&mut self) {
        if let Some(request) = self.capture.take() {
            let mut gate = request.gate.lock().unwrap_or_else(|p| p.into_inner());
            if gate.owner == GateOwner::Capture(request.generation) {
                gate.owner = GateOwner::Closed;
            }
            if let Some(reply) = request.reply {
                let _ = reply.send(Err(closed()));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{future::Future, os::unix::net::UnixStream, pin::Pin, task::Poll};

    fn manual_actor() -> (PtyIoActorHandle, PtyIoActorRunner, UnixStream) {
        let (mut runner, peer) = super::super::tests::actor_runner_for_unit_test();
        let (data_tx, data_rx) = mpsc::channel(4);
        let (control_tx, control_rx) = std_mpsc::channel();
        let wake = fd::create_wake_pipe().unwrap();
        runner.data_rx = data_rx;
        runner.control_rx = control_rx;
        runner.wake_read_fd = wake.read_fd;
        let handle = PtyIoActorHandle {
            data_tx,
            control_tx,
            wake: wake.writer,
            user_writes: Arc::new(Mutex::new(UserWriteGate::new(true))),
            controls: runner.controls.clone(),
            response_order: runner.response_order.clone(),
        };
        (handle, runner, peer)
    }

    async fn pending<F: Future>(mut future: Pin<&mut F>) {
        std::future::poll_fn(|cx| {
            assert!(future.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
    }

    #[tokio::test]
    async fn capture_cancel_before_processing_is_nonblocking_and_keeps_admission_closed_until_actor(
    ) {
        let (handle, mut runner, _peer) = manual_actor();
        let mut pause = Box::pin(handle.pause_for_capture(Duration::from_secs(2)));
        pending(pause.as_mut()).await;
        drop(pause);
        assert_eq!(
            handle.user_writes.lock().unwrap().owner,
            GateOwner::Capture(1)
        );
        assert!(!runner.drain_control_commands());
        assert_eq!(handle.user_writes.lock().unwrap().owner, GateOwner::Running);
        assert!(runner.capture.is_none());
        assert_eq!(runner.state, ActorState::Running);
    }

    #[tokio::test]
    async fn capture_cancel_after_ack_and_stale_cleanup_cannot_resume_new_generation() {
        let (handle, mut runner, _peer) = manual_actor();
        let mut pause = Box::pin(handle.pause_for_capture(Duration::from_secs(2)));
        pending(pause.as_mut()).await;
        runner.drain_control_commands();
        runner.advance_capture();
        assert_eq!(runner.state, ActorState::Quiesced);
        // Cancel before observing the already-delivered acknowledgement.
        drop(pause);
        runner.drain_control_commands();
        let mut newer = Box::pin(handle.pause_for_capture(Duration::from_secs(2)));
        pending(newer.as_mut()).await;
        runner.drain_control_commands();
        runner.advance_capture();
        let newer = newer.await.unwrap();
        runner.resume_capture(1).unwrap();
        assert_eq!(runner.state, ActorState::Quiesced);
        assert_eq!(
            handle.user_writes.lock().unwrap().owner,
            GateOwner::Capture(2)
        );
        assert!(handle.rollback_handoff().is_err());
        assert!(handle.begin_handoff(Duration::ZERO).is_err());
        drop(newer);
        runner.drain_control_commands();
        assert_eq!(handle.user_writes.lock().unwrap().owner, GateOwner::Running);
    }

    #[tokio::test]
    async fn capture_cancel_during_backpressure_preserves_accepted_writes() {
        let (handle, mut runner, _peer) = manual_actor();
        let accepted = Bytes::from(vec![b'x'; 4 * 1024 * 1024]);
        handle.try_write_user_input(accepted).unwrap();
        let mut pause = Box::pin(handle.pause_for_capture(Duration::from_secs(2)));
        pending(pause.as_mut()).await;
        runner.drain_commands();
        runner.flush_pending_writes_once().unwrap();
        assert!(!runner.pending_writes.is_empty());
        let offset = runner.current_write_offset;
        runner.advance_capture();
        pending(pause.as_mut()).await;
        drop(pause);
        runner.drain_control_commands();
        assert_eq!(runner.current_write_offset, offset);
        assert!(!runner.pending_writes.is_empty());
        assert_eq!(runner.state, ActorState::Running);
        assert_eq!(handle.user_writes.lock().unwrap().owner, GateOwner::Running);
    }

    #[tokio::test]
    async fn capture_cancelled_resume_and_shutdown_never_reopen_closed_gate() {
        let (handle, mut runner, _peer) = manual_actor();
        let mut pause = Box::pin(handle.pause_for_capture(Duration::from_secs(2)));
        pending(pause.as_mut()).await;
        runner.drain_control_commands();
        runner.advance_capture();
        let pause = pause.await.unwrap();
        let mut resume = Box::pin(pause.resume(Duration::from_secs(2)));
        pending(resume.as_mut()).await;
        handle.shutdown();
        drop(resume);
        assert!(runner.drain_control_commands());
        runner.close_capture();
        assert_eq!(handle.user_writes.lock().unwrap().owner, GateOwner::Closed);
        assert!(handle
            .try_write_user_input(Bytes::from_static(b"blocked"))
            .is_err());
    }

    #[tokio::test]
    async fn capture_lost_ack_rolls_back_and_cancelled_resume_is_idempotent() {
        let (handle, mut runner, _peer) = manual_actor();
        let mut pause = Box::pin(handle.pause_for_capture(Duration::from_secs(2)));
        pending(pause.as_mut()).await;
        runner.drain_control_commands();
        drop(pause);
        // Attempt ack before dispatching the queued cancellation.
        runner.advance_capture();
        assert_eq!(runner.state, ActorState::Running);
        assert_eq!(handle.user_writes.lock().unwrap().owner, GateOwner::Running);
        runner.drain_control_commands();
        let mut pause = Box::pin(handle.pause_for_capture(Duration::from_secs(2)));
        pending(pause.as_mut()).await;
        runner.drain_control_commands();
        runner.advance_capture();
        let mut resume = Box::pin(pause.await.unwrap().resume(Duration::from_secs(2)));
        pending(resume.as_mut()).await;
        runner.drain_control_commands();
        drop(resume);
        runner.drain_control_commands();
        assert_eq!(runner.state, ActorState::Running);
        assert_eq!(handle.user_writes.lock().unwrap().owner, GateOwner::Running);
    }

    #[tokio::test]
    async fn capture_respects_other_owners_and_generation_exhaustion() {
        let (handle, mut runner, _peer) = manual_actor();
        handle.user_writes.lock().unwrap().owner = GateOwner::Legacy(0);
        assert!(handle.pause_for_capture(Duration::ZERO).await.is_err());
        assert_eq!(
            handle.user_writes.lock().unwrap().owner,
            GateOwner::Legacy(0)
        );
        handle.user_writes.lock().unwrap().owner = GateOwner::Running;
        let mut pause = Box::pin(handle.pause_for_capture(Duration::from_secs(2)));
        pending(pause.as_mut()).await;
        assert!(handle
            .clone()
            .pause_for_capture(Duration::ZERO)
            .await
            .is_err());
        drop(pause);
        runner.drain_control_commands();
        handle.user_writes.lock().unwrap().generation = u64::MAX;
        assert!(handle.pause_for_capture(Duration::ZERO).await.is_err());
        assert_eq!(handle.user_writes.lock().unwrap().owner, GateOwner::Running);
    }

    #[tokio::test]
    async fn capture_deadline_and_exit_release_pending_ack_without_reopening_closed_actor() {
        let (handle, mut runner, _peer) = manual_actor();
        let mut pause = Box::pin(handle.pause_for_capture(Duration::from_secs(2)));
        pending(pause.as_mut()).await;
        runner.drain_control_commands();
        runner.capture.as_mut().unwrap().deadline = Instant::now();
        runner.advance_capture();
        assert_eq!(
            pause.await.err().unwrap().kind(),
            std::io::ErrorKind::TimedOut
        );
        runner.drain_control_commands();
        assert_eq!(handle.user_writes.lock().unwrap().owner, GateOwner::Running);
        let mut pause = Box::pin(handle.pause_for_capture(Duration::from_secs(2)));
        pending(pause.as_mut()).await;
        runner.drain_control_commands();
        runner.close_capture();
        assert!(pause.await.is_err());
        runner.drain_control_commands();
        assert_eq!(handle.user_writes.lock().unwrap().owner, GateOwner::Closed);
    }

    #[tokio::test]
    async fn capture_real_actor_ack_allows_owner_inbox_to_unblock_publication_and_drain_replies() {
        let (socket, mut peer) = UnixStream::pair().unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let (events, receiver) = crate::events::channel(1);
        let mut inbox = receiver;
        let (entered, started) = oneshot::channel();
        let mut entered = Some(entered);
        let (release, wait) = std_mpsc::channel();
        let mut wait = Some(wait);
        let handle = PtyIoActor::spawn(PtyIoActorConfig {
            pane_id: 1,
            master_fd: OwnedFd::from(socket),
            initially_quiesced: false,
            on_read: Box::new(move |_| {
                if let Some(wait) = wait.take() {
                    entered.take().unwrap().send(()).unwrap();
                    wait.recv().unwrap();
                    events.blocking_send(1).unwrap();
                    events.blocking_send(2).unwrap();
                }
                PtyReadResult {
                    terminal_responses: vec![Bytes::from_static(b"reply")],
                }
            }),
            on_reader_exit: None,
        })
        .unwrap();
        peer.write_all(b"trigger").unwrap();
        started.await.unwrap();
        let mut pause = Box::pin(handle.pause_for_capture(Duration::from_secs(2)));
        pending(pause.as_mut()).await;
        release.send(()).unwrap();
        let pause = loop {
            tokio::select! {
                paused = &mut pause => break paused.unwrap(),
                staged = inbox.stage_next(4) => { assert!(staged.unwrap()); }
            }
        };
        assert_eq!(inbox.recv().await, Some(1));
        assert_eq!(inbox.recv().await, Some(2));
        let mut reply = [0; 5];
        peer.read_exact(&mut reply).unwrap();
        assert_eq!(&reply, b"reply");
        assert!(handle
            .try_write_user_input(Bytes::from_static(b"blocked"))
            .is_err());
        pause.resume(Duration::from_secs(2)).await.unwrap();
        handle
            .try_write_user_input(Bytes::from_static(b"input"))
            .unwrap();
        peer.read_exact(&mut reply).unwrap();
        assert_eq!(&reply, b"input");
        handle.shutdown();
    }

    #[tokio::test]
    async fn capture_rejects_inconsistent_actor_state_without_leaking_reservation() {
        let (handle, mut runner, _peer) = manual_actor();
        runner.state = ActorState::Quiesced;
        let mut pause = Box::pin(handle.pause_for_capture(Duration::from_secs(2)));
        pending(pause.as_mut()).await;
        runner.drain_control_commands();
        assert!(pause.await.is_err());
        runner.drain_control_commands();
        assert_eq!(handle.user_writes.lock().unwrap().owner, GateOwner::Closed);
        assert!(runner.capture.is_none());
    }

    #[tokio::test]
    async fn stale_legacy_rollback_cannot_reopen_newer_legacy_or_capture_owner() {
        let (handle, mut runner, _peer) = manual_actor();
        handle.user_writes.lock().unwrap().owner = GateOwner::Legacy(1);
        runner.state = ActorState::Quiesced;
        let (ack, delayed_ack) = std_mpsc::channel();
        runner.handle_control_command(PtyIoControlCommand::RollbackHandoff {
            generation: 1,
            gate: handle.user_writes.clone(),
            reply: ack,
        });
        assert_eq!(handle.user_writes.lock().unwrap().owner, GateOwner::Running);
        // B starts before the caller observes A's successful acknowledgement.
        handle.user_writes.lock().unwrap().owner = GateOwner::Legacy(2);
        runner.state = ActorState::Quiesced;
        delayed_ack.recv().unwrap().unwrap();
        let (ack, stale_ack) = std_mpsc::channel();
        runner.handle_control_command(PtyIoControlCommand::RollbackHandoff {
            generation: 1,
            gate: handle.user_writes.clone(),
            reply: ack,
        });
        stale_ack.recv().unwrap().unwrap();
        assert_eq!(
            handle.user_writes.lock().unwrap().owner,
            GateOwner::Legacy(2)
        );
        assert_eq!(runner.state, ActorState::Quiesced);
        assert!(handle.pause_for_capture(Duration::ZERO).await.is_err());
        let (ack, _) = std_mpsc::channel();
        runner.handle_control_command(PtyIoControlCommand::RollbackHandoff {
            generation: 2,
            gate: handle.user_writes.clone(),
            reply: ack,
        });
        let mut pause = Box::pin(handle.pause_for_capture(Duration::from_secs(2)));
        pending(pause.as_mut()).await;
        runner.drain_control_commands();
        runner.advance_capture();
        let pause = pause.await.unwrap();
        let (ack, _) = std_mpsc::channel();
        runner.handle_control_command(PtyIoControlCommand::RollbackHandoff {
            generation: 2,
            gate: handle.user_writes.clone(),
            reply: ack,
        });
        assert_eq!(runner.state, ActorState::Quiesced);
        assert!(matches!(
            handle.user_writes.lock().unwrap().owner,
            GateOwner::Capture(_)
        ));
        drop(pause);
        runner.drain_control_commands();
    }
}
