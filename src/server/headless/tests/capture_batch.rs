use super::*;
use bytes::Bytes;
use std::{
    io::Write,
    os::fd::{FromRawFd, OwnedFd},
    pin::Pin,
};

const TIMEOUT: Duration = Duration::from_secs(2);
const BUDGET: usize = 64 << 20;

fn detached(server: &mut HeadlessServer, runtime: TerminalRuntime) -> TerminalId {
    let id = TerminalId::alloc();
    server.app.state.terminals.insert(
        id.clone(),
        crate::terminal::TerminalState::new(id.clone(), std::env::temp_dir()),
    );
    server.app.terminal_runtimes.insert(id.clone(), runtime);
    id
}

async fn paused<F: Future>(mut capture: Pin<&mut F>, actor: &crate::pty::actor::PtyIoActorHandle) {
    tokio::time::timeout(TIMEOUT, async {
        loop {
            std::future::poll_fn(|cx| {
                assert!(capture.as_mut().poll(cx).is_pending());
                Poll::Ready(())
            })
            .await;
            if let Ok(fd) = actor.duplicate_for_handoff() {
                // The query only duplicates an already-quiesced test actor FD.
                drop(unsafe { OwnedFd::from_raw_fd(fd) });
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
}

async fn assert_resumed(actor: &crate::pty::actor::PtyIoActorHandle) {
    tokio::time::timeout(TIMEOUT, async {
        while actor
            .try_write_user_input(Bytes::from_static(b"resumed"))
            .is_err()
        {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn batch_holds_first_actor_until_delayed_detached_runtime_is_captured() {
    let (mut server, first_id, _) = fixture();
    let (first, actor, mut peer, reads) = TerminalRuntime::test_for_draft_capture_with_actor();
    server.app.terminal_runtimes.insert(first_id.clone(), first);
    let (second, release) =
        TerminalRuntime::test_for_draft_capture_with_delayed_detector(b"detached");
    let second_id = detached(&mut server, second);
    let mut capture = Box::pin(server.capture_terminal_batch(
        crate::pane::draft_test_limits(),
        BUDGET,
        2,
        TIMEOUT,
    ));
    paused(capture.as_mut(), &actor).await;
    assert!(actor
        .try_write_user_input(Bytes::from_static(b"blocked"))
        .is_err());
    // This output must remain unread until the entire terminal batch is built.
    peer.write_all(b"after-cut").unwrap();
    release.send(()).unwrap();
    let drafts = capture.await.unwrap();
    assert_eq!(drafts.len(), 2);
    assert!(drafts.windows(2).all(|w| w[0].0.as_str() < w[1].0.as_str()));
    for (id, draft) in drafts {
        let text = draft.test_restored_text();
        if id == first_id {
            assert!(!text.contains("after-cut"));
        } else {
            assert_eq!(id, second_id);
            assert!(text.contains("detached"));
        }
    }
    assert_eq!(reads.recv_timeout(TIMEOUT).unwrap(), b"after-cut");
    assert_resumed(&actor).await;
    server.app.state.assert_invariants_for_test();
}

#[tokio::test]
async fn batch_cancellation_keeps_all_runtimes_and_releases_partial_acquisition() {
    let (mut server, first_id, _) = fixture();
    let (first, actor, _peer, _reads) = TerminalRuntime::test_for_draft_capture_with_actor();
    server.app.terminal_runtimes.insert(first_id, first);
    let (second, release) =
        TerminalRuntime::test_for_draft_capture_with_delayed_detector(b"detached");
    detached(&mut server, second);
    let mut capture = Box::pin(server.capture_terminal_batch(
        crate::pane::draft_test_limits(),
        BUDGET,
        2,
        TIMEOUT,
    ));
    paused(capture.as_mut(), &actor).await;
    drop(capture);
    release.send(()).unwrap();
    assert_resumed(&actor).await;
    assert_eq!(server.app.terminal_runtimes.len(), 2);
    server
        .capture_terminal_batch(crate::pane::draft_test_limits(), BUDGET, 2, TIMEOUT)
        .await
        .unwrap();
    server.app.state.assert_invariants_for_test();
}

#[tokio::test]
async fn batch_aggregate_and_serialization_failures_resume_all_sources() {
    let (mut server, first_id, _) = fixture();
    let (first, actor, _peer, _reads) = TerminalRuntime::test_for_draft_capture_with_actor();
    server.app.terminal_runtimes.insert(first_id, first);
    detached(
        &mut server,
        TerminalRuntime::test_for_draft_capture(b"detached"),
    );
    let drafts = server
        .capture_terminal_batch(crate::pane::draft_test_limits(), BUDGET, 2, TIMEOUT)
        .await
        .unwrap();
    let charge: usize = drafts
        .iter()
        .map(|(id, draft)| {
            draft.retained_bytes().unwrap() + id.as_str().len() + std::mem::size_of::<TerminalId>()
        })
        .sum();
    drop(drafts);
    let error = server
        .capture_terminal_batch(crate::pane::draft_test_limits(), charge - 1, 2, TIMEOUT)
        .await
        .err()
        .unwrap();
    assert!(error.contains("retained payload"), "{error}");
    assert_resumed(&actor).await;
    let mut limits = crate::pane::draft_test_limits();
    limits.native_bytes = 0;
    let error = server
        .capture_terminal_batch(limits, BUDGET, 2, TIMEOUT)
        .await
        .err()
        .unwrap();
    assert!(error.contains("native snapshot"), "{error}");
    assert_resumed(&actor).await;
    server
        .capture_terminal_batch(crate::pane::draft_test_limits(), BUDGET, 2, TIMEOUT)
        .await
        .unwrap();
}

#[tokio::test]
async fn batch_resume_failure_does_not_skip_other_acquired_actors() {
    let (mut server, first_id, _) = fixture();
    let (first, first_actor, _first_peer, _first_reads) =
        TerminalRuntime::test_for_draft_capture_with_actor();
    server.app.terminal_runtimes.insert(first_id, first);
    let (second, second_actor, _second_peer, _second_reads) =
        TerminalRuntime::test_for_draft_capture_with_actor();
    detached(&mut server, second);
    let (delayed, release) =
        TerminalRuntime::test_for_draft_capture_with_delayed_detector(b"delayed");
    detached(&mut server, delayed);
    let mut capture = Box::pin(server.capture_terminal_batch(
        crate::pane::draft_test_limits(),
        BUDGET,
        3,
        TIMEOUT,
    ));
    paused(capture.as_mut(), &first_actor).await;
    paused(capture.as_mut(), &second_actor).await;
    first_actor.shutdown();
    release.send(()).unwrap();
    let error = capture.await.err().unwrap();
    assert!(error.contains("resume failed"), "{error}");
    assert_resumed(&second_actor).await;
}

#[tokio::test]
async fn batch_checks_entire_registry_identity_and_count_before_pausing() {
    let (mut server, _, _) = fixture();
    let detached_id = detached(&mut server, TerminalRuntime::test_for_draft_capture(b"old"));
    let identities: Vec<_> = server
        .app
        .terminal_runtimes
        .iter()
        .map(|(id, runtime)| (id.clone(), runtime.capture_identity()))
        .collect();
    server
        .app
        .terminal_runtimes
        .insert(detached_id, TerminalRuntime::test_for_draft_capture(b"new"));
    assert!(server
        .validate_capture_runtime_set(&identities)
        .unwrap_err()
        .contains("replaced"));
    detached(
        &mut server,
        TerminalRuntime::test_for_draft_capture(b"added"),
    );
    assert!(server
        .validate_capture_runtime_set(&identities)
        .unwrap_err()
        .contains("set changed"));
    assert!(server
        .capture_terminal_batch(crate::pane::draft_test_limits(), BUDGET, 1, TIMEOUT)
        .await
        .err()
        .unwrap()
        .contains("count"));
}

#[tokio::test]
async fn batch_empty_registry_has_an_empty_draft() {
    let mut server = test_headless_server();
    assert!(server
        .capture_terminal_batch(crate::pane::draft_test_limits(), 0, 0, TIMEOUT)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn batch_staging_exhaustion_retains_fifo_and_releases_acquired_actor() {
    let (mut server, first_id, pane_id) = fixture();
    let (first, actor, _peer, _reads) = TerminalRuntime::test_for_draft_capture_with_actor();
    server.app.terminal_runtimes.insert(first_id, first);
    let (sender, receiver) = mpsc::channel(1);
    server.app.event_tx = sender.clone();
    server.app.event_rx = crate::events::OwnerInbox::new(receiver);
    let event_count = crate::app::APP_EVENT_CHANNEL_CAPACITY + 2;
    let events = (0..event_count)
        .map(|count| AppEvent::TerminalBell {
            pane_id,
            count: u16::try_from(count).unwrap(),
        })
        .collect();
    let (second, release) =
        TerminalRuntime::test_for_draft_capture_with_publishing_detector(sender, events);
    detached(&mut server, second);
    let mut capture = Box::pin(server.capture_terminal_batch(
        crate::pane::draft_test_limits(),
        BUDGET,
        2,
        TIMEOUT,
    ));
    paused(capture.as_mut(), &actor).await;
    release.send(()).unwrap();
    let error = capture.await.err().unwrap();
    assert!(error.contains("staging limit"), "{error}");
    assert!(error.contains("without acknowledgement"), "{error}");
    assert_eq!(server.app.terminal_runtimes.len(), 2);
    for expected in 0..event_count {
        let event = tokio::time::timeout(TIMEOUT, server.app.event_rx.recv())
            .await
            .unwrap();
        assert!(
            matches!(event, Some(AppEvent::TerminalBell { count, .. }) if usize::from(count) == expected)
        );
    }
    assert_resumed(&actor).await;
    server
        .capture_terminal_batch(crate::pane::draft_test_limits(), BUDGET, 2, TIMEOUT)
        .await
        .unwrap();
    server.app.state.assert_invariants_for_test();
}

#[tokio::test]
async fn batch_later_acquisition_failure_resumes_an_already_paused_actor() {
    let (mut server, first_id, _) = fixture();
    let (first, actor, _peer, _reads) = TerminalRuntime::test_for_draft_capture_with_actor();
    server.app.terminal_runtimes.insert(first_id, first);
    let (second, release) =
        TerminalRuntime::test_for_draft_capture_with_delayed_detector(b"detached");
    detached(&mut server, second);
    let mut capture = Box::pin(server.capture_terminal_batch(
        crate::pane::draft_test_limits(),
        BUDGET,
        2,
        TIMEOUT,
    ));
    paused(capture.as_mut(), &actor).await;
    drop(release);
    let error = capture.await.err().unwrap();
    assert!(error.contains("detector"), "{error}");
    assert_resumed(&actor).await;
    assert_eq!(server.app.terminal_runtimes.len(), 2);
}

#[tokio::test]
async fn batch_pumps_bounded_inbox_and_rejects_observed_effects_without_applying_them() {
    let (mut server, first_id, pane_id) = fixture();
    let (first, actor, _peer, _reads) = TerminalRuntime::test_for_draft_capture_with_actor();
    server.app.terminal_runtimes.insert(first_id, first);
    let (sender, receiver) = mpsc::channel(1);
    server.app.event_tx = sender.clone();
    server.app.event_rx = crate::events::OwnerInbox::new(receiver);
    let (second, release) = TerminalRuntime::test_for_draft_capture_with_publishing_detector(
        sender,
        vec![
            AppEvent::TerminalBell { pane_id, count: 1 },
            AppEvent::PaneDied {
                pane_id,
                exit_reason: crate::platform::ChildExitReason::Exited,
            },
        ],
    );
    detached(&mut server, second);
    let mut capture = Box::pin(server.capture_terminal_batch(
        crate::pane::draft_test_limits(),
        BUDGET,
        2,
        TIMEOUT,
    ));
    paused(capture.as_mut(), &actor).await;
    release.send(()).unwrap();
    let error = capture.await.err().unwrap();
    assert!(error.contains("events arrived"), "{error}");
    assert_eq!(server.app.terminal_runtimes.len(), 2);
    assert!(matches!(
        server.app.event_rx.recv().await,
        Some(AppEvent::TerminalBell { count: 1, .. })
    ));
    assert!(matches!(
        server.app.event_rx.recv().await,
        Some(AppEvent::PaneDied { .. })
    ));
    assert_resumed(&actor).await;
    server.app.state.assert_invariants_for_test();
}
