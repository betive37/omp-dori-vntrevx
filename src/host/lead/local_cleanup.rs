//! A failed local start retains its process until exit evidence and its durable receipt exist.

use super::{
    Attached, CLOSE_WAIT, Cleanup, Exit, KILL_GRACE, StartError, StartupOutcome, StartupStage,
};
use crate::host::lead::ownership::Ownership;

pub(super) struct Failure {
    pub(super) stage: StartupStage,
    pub(super) outcome: StartupOutcome,
    pub(super) detail: String,
}

impl Failure {
    pub(super) fn rpc(error: &super::RpcError, cancelled: bool) -> Self {
        Self {
            stage: if *error == super::RpcError::Timeout("ready frame") {
                StartupStage::Ready
            } else {
                StartupStage::Protocol
            },
            outcome: if cancelled {
                StartupOutcome::Cancelled
            } else if matches!(error, super::RpcError::Timeout(_)) {
                StartupOutcome::Timeout
            } else {
                StartupOutcome::Rejected
            },
            detail: format!("rpc-ui startup failed: {error}"),
        }
    }
}

pub(super) async fn finish(child: Attached, ownership: &Ownership, failure: Failure) -> StartError {
    let (exit, step) = child.close(CLOSE_WAIT, KILL_GRACE).await;
    let mut cleanup = if exit == Exit::Unknown {
        Cleanup::Unknown
    } else {
        Cleanup::LocalReaped
    };
    let mut detail = format!("{} (OMP cleanup: {step:?}, {exit:?})", failure.detail);
    if let Err(error) = ownership.finished(cleanup) {
        cleanup = Cleanup::Unknown;
        detail.push_str("; cleanup receipt could not be committed: ");
        detail.push_str(&error);
    }
    StartError::Startup {
        stage: failure.stage,
        outcome: failure.outcome,
        cleanup,
        detail,
    }
}
