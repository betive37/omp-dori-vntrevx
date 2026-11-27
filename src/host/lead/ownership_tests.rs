use super::*;
use crate::sys::command;
use std::time::Duration;

#[tokio::test]
async fn prebind_crash_reconciliation_requires_the_recorded_process_to_exit() {
    let dir = crate::sys::fs::tests::scratch("startup-owner");
    assert_eq!(reconcile(&dir, "missing").await.unwrap(), Cleanup::Unknown);
    let owner = Ownership::prepare(&dir, "attempt").unwrap();
    let argv = ["sh".into(), "-c".into(), "read line".into()];
    let child = command::attach(&argv, Some(&dir), &[], None, 4096).unwrap();
    owner.spawned(child.pid()).await.unwrap();
    assert_eq!(reconcile(&dir, "attempt").await.unwrap(), Cleanup::Unknown);
    let (exit, _) = child
        .close(Duration::from_secs(1), Duration::from_secs(1))
        .await;
    assert_ne!(exit, command::Exit::Unknown);
    // No finish receipt: this is the hub-crash path, reconciled from process birth identity.
    assert_eq!(
        reconcile(&dir, "attempt").await.unwrap(),
        Cleanup::LocalReaped
    );
}

#[tokio::test]
async fn only_a_worker_reap_confirms_a_remote_attempt() {
    use crate::host::lead::Lease;
    let reaped = |exit| AttemptState::Reaped {
        exit,
        lease: Lease::Unknown,
    };
    for exit in [Reaped::Code(0), Reaped::Signal(9), Reaped::Gone] {
        assert_eq!(worker_cleanup(&reaped(exit)), Cleanup::WorkerReaped);
    }
    assert_eq!(
        worker_cleanup(&reaped(Reaped::NotSpawned)),
        Cleanup::NotSpawned
    );
    assert_eq!(
        worker_cleanup(&AttemptState::Running { pid: 7 }),
        Cleanup::Unknown
    );
    let unknown = AttemptState::Unknown {
        reason: "the worker connection ended before the exit acknowledgement".into(),
    };
    assert_eq!(worker_cleanup(&unknown), Cleanup::Unknown);
    // A worker that cannot be asked is unknown ownership, never an exit.
    let dir = crate::sys::fs::tests::scratch("startup-owner-remote");
    let asked = reconcile_attempt(&dir, "attempt", Some("box")).await;
    assert!(
        asked
            .as_ref()
            .is_err_and(|e| e.contains("ownership of attempt attempt on box is unknown")),
        "{asked:?}"
    );
    assert_eq!(
        reconcile_attempt(&dir, "missing", None).await.unwrap(),
        Cleanup::Unknown
    );
}
