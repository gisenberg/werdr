use super::*;
use crate::events::channel;
use std::{future::Future, task::Poll};

#[test]
fn work_registration_precedes_spawn_and_unstarted_drop_is_safe() {
    let (sender, inbox) = channel::<()>(1);
    let before = inbox.work_checkpoint().unwrap();
    let registration = sender.register_work(BackgroundWork::WorktreeRead);
    assert!(inbox.work_checkpoint().err().unwrap().contains("active"));
    // Failed spawn drops the never-run closure and its unstarted registration.
    let never_spawned = move || {
        let work = registration.start();
        work.complete();
    };
    drop(never_spawned);
    let after = inbox.work_checkpoint().unwrap();
    inbox.validate_work_checkpoint(&after).unwrap();
    assert!(inbox
        .validate_work_checkpoint(&before)
        .unwrap_err()
        .contains("started during"));
}

#[test]
fn completed_work_between_checks_invalidates_epoch_without_numeric_aba() {
    let (sender, inbox) = channel::<()>(1);
    let cut = inbox.work_checkpoint().unwrap();
    for _ in 0..32 {
        sender
            .register_work(BackgroundWork::GitRefresh)
            .start()
            .complete();
    }
    assert!(inbox
        .validate_work_checkpoint(&cut)
        .unwrap_err()
        .contains("started during"));
    inbox
        .validate_work_checkpoint(&inbox.work_checkpoint().unwrap())
        .unwrap();
    let (_, other) = channel::<()>(1);
    assert!(other
        .validate_work_checkpoint(&cut)
        .unwrap_err()
        .contains("another inbox"));
}

#[tokio::test]
async fn work_remains_active_through_backpressured_result_publication() {
    let (sender, mut inbox) = channel(1);
    sender.send(1).await.unwrap();
    let work = sender.register_work(BackgroundWork::WorktreeAdd).start();
    let mut publishing = Box::pin(sender.send(2));
    std::future::poll_fn(|cx| {
        assert!(publishing.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    assert!(inbox.work_checkpoint().is_err());
    assert_eq!(inbox.recv().await, Some(1));
    publishing.await.unwrap();
    assert!(inbox.work_checkpoint().is_err());
    work.complete();
    let checkpoint = inbox.work_checkpoint().unwrap();
    assert_eq!(inbox.recv().await, Some(2));
    inbox.validate_work_checkpoint(&checkpoint).unwrap();
}

#[tokio::test]
async fn aborted_started_worker_leaves_uncertainty_after_queue_is_empty() {
    let (sender, inbox) = channel::<()>(1);
    let registration = sender.register_work(BackgroundWork::StatusCommand);
    let (started, ready) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let work = registration.start();
        started.send(()).unwrap();
        std::future::pending::<()>().await;
        work.complete();
    });
    ready.await.unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(inbox.is_empty());
    let error = inbox.work_checkpoint().err().unwrap();
    assert!(
        error.contains("uncertain") && error.contains("StatusCommand"),
        "{error}"
    );
    // Later successful work cannot erase the missing completion acknowledgement.
    sender
        .register_work(BackgroundWork::GitRefresh)
        .start()
        .complete();
    assert!(inbox.work_checkpoint().is_err());
}

#[test]
fn panicking_worker_is_uncertain_and_poisoned_tracking_never_looks_idle() {
    let (sender, inbox) = channel::<()>(1);
    let registration = sender.register_work(BackgroundWork::PluginCommand);
    assert!(std::thread::spawn(move || {
        let _work = registration.start();
        panic!("worker failed after starting");
    })
    .join()
    .is_err());
    assert!(inbox.work_checkpoint().err().unwrap().contains("uncertain"));

    let (sender, inbox) = channel::<()>(1);
    let registration = sender.register_work(BackgroundWork::UpdateCheck);
    let admission = registration.0.admission.clone();
    assert!(std::thread::spawn(move || {
        let _state = admission.lock().unwrap();
        panic!("poison admission");
    })
    .join()
    .is_err());
    drop(registration);
    sender
        .register_work(BackgroundWork::ManifestUpdate)
        .start()
        .complete();
    assert!(inbox.work_checkpoint().err().unwrap().contains("poisoned"));
}

#[tokio::test]
async fn failed_publication_cannot_be_acknowledged_as_an_idle_capture() {
    let (sender, mut inbox) = channel(1);
    let before = inbox.work_checkpoint().unwrap();
    let registration = sender.register_work(BackgroundWork::ManifestUpdate);
    registration.0.admission.lock().unwrap().published = u64::MAX;
    let work = registration.start();
    assert_eq!(sender.send("result").await.unwrap_err().0, "result");
    // A wrapper may hide publication failure. The shared failure remains
    // authoritative even after its worker reports normal function return.
    work.complete();
    assert!(inbox.try_recv().is_err());
    assert!(inbox.work_checkpoint().err().unwrap().contains("exhausted"));
    assert!(inbox
        .validate_work_checkpoint(&before)
        .unwrap_err()
        .contains("exhausted"));
}
