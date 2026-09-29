use super::*;
use std::{future::Future, task::Poll};

async fn pending<F: Future>(mut future: std::pin::Pin<&mut F>) {
    std::future::poll_fn(|cx| {
        assert!(future.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
}

#[tokio::test]
async fn reserved_capacity_is_outside_cut_and_publication_orders_reservations() {
    let (sender, mut inbox) = channel(2);
    let first = sender.channel.reserve().await.unwrap();
    let second = sender.channel.reserve().await.unwrap();
    let empty = inbox.admission_cut().unwrap();
    assert_eq!(empty.sequence, 0);
    sender
        .publish(second, "second reservation published first")
        .unwrap();
    let cut = inbox.admission_cut().unwrap();
    sender
        .publish(first, "first reservation published second")
        .unwrap();
    assert_eq!(inbox.try_recv_through(&empty).unwrap(), None);
    assert_eq!(
        inbox.try_recv_through(&cut).unwrap(),
        Some("second reservation published first")
    );
    assert_eq!(inbox.try_recv_through(&cut).unwrap(), None);
    assert_eq!(
        inbox.recv().await,
        Some("first reservation published second")
    );
    assert_eq!(inbox.try_recv_through(&cut).unwrap(), None);
}

#[tokio::test]
async fn cancellation_and_full_queue_do_not_consume_sequence_or_lock_admission() {
    let (sender, mut inbox) = channel(1);
    sender.send(1).await.unwrap();
    let mut blocked = Box::pin(sender.send(2));
    pending(blocked.as_mut()).await;
    assert_eq!(inbox.admission_cut().unwrap().sequence, 1);
    assert!(matches!(
        sender.try_send(3),
        Err(mpsc::error::TrySendError::Full(3))
    ));
    drop(blocked);
    assert_eq!(inbox.recv().await, Some(1));
    let reserved = sender.channel.reserve().await.unwrap();
    drop(reserved);
    assert_eq!(inbox.admission_cut().unwrap().sequence, 1);
    sender.try_send(4).unwrap();
    let cut = inbox.admission_cut().unwrap();
    assert_eq!(cut.sequence, 2);
    assert_eq!(inbox.try_recv_through(&cut).unwrap(), Some(4));
    assert_eq!(inbox.try_recv_through(&cut).unwrap(), None);
}

#[tokio::test]
async fn completed_publication_cannot_be_retracted_by_dropping_send_future() {
    let (sender, mut inbox) = channel(1);
    let mut sending = Box::pin(sender.send(7));
    std::future::poll_fn(|cx| {
        assert!(matches!(sending.as_mut().poll(cx), Poll::Ready(Ok(()))));
        Poll::Ready(())
    })
    .await;
    drop(sending);
    assert_eq!(inbox.admission_cut().unwrap().sequence, 1);
    assert_eq!(inbox.try_recv().unwrap(), 7);
}

#[tokio::test]
async fn cloned_async_and_nonblocking_senders_share_one_finite_cut() {
    let (sender, mut inbox) = channel(64);
    let mut threads = Vec::new();
    for thread in 0..4 {
        let sender = sender.clone();
        threads.push(std::thread::spawn(move || {
            for event in 0..8 {
                sender.try_send((thread, event)).unwrap();
            }
        }));
    }
    for event in 0..8 {
        sender.send((4, event)).await.unwrap();
    }
    for thread in threads {
        thread.join().unwrap();
    }
    let cut = inbox.admission_cut().unwrap();
    assert_eq!(cut.sequence, 40);
    let mut received = std::collections::HashSet::new();
    while let Some(event) = inbox.try_recv_through(&cut).unwrap() {
        assert!(received.insert(event));
        // Model a handler publishing later work. It cannot extend this cut.
        if event == (4, 7) {
            sender.try_send((5, 0)).unwrap();
        }
    }
    assert_eq!(received.len(), 40);
    assert_eq!(inbox.recv().await, Some((5, 0)));
}

#[cfg(unix)]
#[tokio::test]
async fn staged_envelopes_survive_cancelled_capture_and_keep_delivery_separate() {
    let (sender, mut inbox) = channel(2);
    sender.send(1).await.unwrap();
    sender.send(2).await.unwrap();
    inbox.stage_next(4).await.unwrap();
    let cut = inbox.admission_cut().unwrap();
    sender.send(3).await.unwrap();
    assert_eq!(inbox.try_recv_through(&cut).unwrap(), Some(1));
    assert_eq!(inbox.try_recv_through(&cut).unwrap(), Some(2));
    assert_eq!(inbox.try_recv_through(&cut).unwrap(), None);
    inbox.stage_next(4).await.unwrap();
    let mut staging = Box::pin(inbox.stage_next(4));
    pending(staging.as_mut()).await;
    drop(staging);
    sender.try_send(4).unwrap();
    assert_eq!(inbox.recv().await, Some(3));
    assert_eq!(inbox.try_recv().unwrap(), 4);
}

#[test]
fn blocking_publication_works_without_an_entered_runtime() {
    let (sender, mut inbox) = channel(1);
    sender.try_send(1).unwrap();
    let thread = std::thread::spawn(move || sender.blocking_send(2));
    let cut = inbox.admission_cut().unwrap();
    assert_eq!(cut.sequence, 1);
    assert_eq!(inbox.try_recv_through(&cut).unwrap(), Some(1));
    thread.join().unwrap().unwrap();
    assert_eq!(inbox.try_recv_through(&cut).unwrap(), None);
    assert_eq!(inbox.try_recv().unwrap(), 2);
}

#[test]
fn blocking_publication_retains_wake_before_park_and_wakes_on_owner_loss() {
    for close_owner in [false, true] {
        let (sender, mut inbox) = channel(1);
        sender.try_send(1).unwrap();
        let (pending_tx, pending_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            let mut first_pending = Some((pending_tx, release_rx));
            sender.blocking_send_with_pending(2, || {
                if let Some((pending, release)) = first_pending.take() {
                    pending.send(()).unwrap();
                    release.recv().unwrap();
                }
            })
        });
        pending_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        assert_eq!(inbox.admission_cut().unwrap().sequence, 1);
        if close_owner {
            // The reservation future has actually been polled to Pending.
            // Dropping the receiver must wake it and return the original event.
            drop(inbox);
            release_tx.send(()).unwrap();
            assert_eq!(thread.join().unwrap().unwrap_err().0, 2);
        } else {
            // Free capacity while the sender is held before park. The wake token
            // must survive until park, otherwise the join would never finish.
            assert_eq!(inbox.try_recv().unwrap(), 1);
            release_tx.send(()).unwrap();
            thread.join().unwrap().unwrap();
            assert_eq!(inbox.try_recv().unwrap(), 2);
        }
    }
}

#[tokio::test]
async fn receiver_drop_and_reserved_permits_keep_tokio_closure_semantics() {
    let (sender, inbox) = channel(2);
    let permit = sender.channel.reserve().await.unwrap();
    drop(inbox);
    // A reserved permit may report successful publication after receiver drop,
    // exactly as with raw Tokio channels. This is not a delivery acknowledgement.
    sender.publish(permit, 1).unwrap();
    assert_eq!(sender.send(2).await.unwrap_err().0, 2);
    assert!(matches!(
        sender.try_send(3),
        Err(mpsc::error::TrySendError::Closed(3))
    ));
}

#[tokio::test]
async fn exhausted_sequence_and_poison_return_payload_without_wrapping() {
    let (sender, mut inbox) = channel(1);
    sender.admission.lock().unwrap().published = u64::MAX;
    assert_eq!(sender.send("retained").await.unwrap_err().0, "retained");
    assert!(matches!(
        sender.try_send("also retained"),
        Err(mpsc::error::TrySendError::Closed("also retained"))
    ));
    assert_eq!(sender.channel.capacity(), 1);
    assert_eq!(inbox.admission_cut().unwrap().sequence, u64::MAX);
    assert!(inbox.try_recv().is_err());
    let admission = sender.admission.clone();
    assert!(std::thread::spawn(move || {
        let _guard = admission.lock().unwrap();
        panic!("test poison");
    })
    .join()
    .is_err());
    assert_eq!(
        sender.send("after poison").await.unwrap_err().0,
        "after poison"
    );
    assert!(inbox.admission_cut().is_err());
}

#[test]
fn foreign_cuts_and_impossible_prefixes_fail_without_waiting() {
    let (sender, mut inbox) = channel(2);
    let (_, other) = channel::<u32>(1);
    sender.try_send(1).unwrap();
    assert!(inbox
        .try_recv_through(&other.admission_cut().unwrap())
        .unwrap_err()
        .contains("another inbox"));
    assert_eq!(inbox.try_recv().unwrap(), 1);
    let impossible = AdmissionCut {
        admission: sender.admission.clone(),
        sequence: 2,
    };
    assert!(inbox
        .try_recv_through(&impossible)
        .unwrap_err()
        .contains("unavailable"));
}
