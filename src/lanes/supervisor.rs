//! Lane startup/stop contract for the shared host supervisor.
//!
//! `start` must cover spawn, ready, negotiation and exact binding under one deadline;
//! its `StartError` carries cleanup evidence. Recovery must use the same identity,
//! 1/2/4/8/16 s backoff, five retries and a durable 300 s episode budget. `stop`
//! returns a `StopRecord` with confirmed exit; workers require a worker-side reap
//! acknowledgement, never transport EOF. Until the host exposes that evidence,
//! this adapter classifies it as Unknown and cannot authorize removal or retries.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::record::Record;
use crate::host::{Control, Runtime, StartSpec, Started};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Quiescence {
    NotSpawned,
    ExitConfirmed,
    WorkerReaped,
    #[default]
    Unknown,
}

impl Quiescence {
    pub(super) fn confirmed(self) -> bool {
        match self {
            Self::NotSpawned | Self::ExitConfirmed | Self::WorkerReaped => true,
            Self::Unknown => false,
        }
    }
}

pub(super) struct StartError {
    pub(super) detail: String,
    pub(super) cleanup: Quiescence,
}

pub(super) struct StopRecord {
    pub(super) detail: String,
    pub(super) cleanup: Quiescence,
}

pub(super) async fn start<R: Runtime>(
    runtime: &R,
    spec: StartSpec,
    budget: Duration,
) -> Result<(Arc<R::Session>, Started), StartError> {
    match tokio::time::timeout(budget, runtime.start(spec)).await {
        Ok(Ok(started)) => Ok(started),
        Ok(Err(error)) => {
            let cleanup = match &error {
                crate::host::StartError::Refused(_) => Quiescence::NotSpawned,
                crate::host::StartError::Failed(_) => Quiescence::Unknown,
            };
            Err(StartError {
                detail: error.to_string(),
                cleanup,
            })
        }
        Err(_) => Err(StartError {
            detail: "the start deadline passed; process exit is unconfirmed".into(),
            cleanup: Quiescence::Unknown,
        }),
    }
}

pub(super) async fn stop<S: Control>(session: &S, rec: &Record) -> StopRecord {
    let was_live = session.alive();
    match tokio::time::timeout(crate::host::lead::STOP_BUDGET, session.close(true)).await {
        Ok(Ok(stopped)) => {
            // Today's local headless clean/forced receipt is produced after wait returned
            // Code(0). Other receipts, terminal blocks and remote EOF do not prove reap.
            let cleanup = if was_live
                && rec.worker.is_none()
                && rec.runtime == crate::config::session::RuntimeKind::Headless
                && matches!(stopped.how.as_str(), "clean" | "forced")
                && stopped.detail.is_none()
                && !session.alive()
            {
                Quiescence::ExitConfirmed
            } else {
                Quiescence::Unknown
            };
            StopRecord {
                detail: format!("{}: {:?}", stopped.how, stopped.detail),
                cleanup,
            }
        }
        Ok(Err(detail)) => StopRecord {
            detail,
            cleanup: Quiescence::Unknown,
        },
        Err(_) => StopRecord {
            detail: "stop deadline passed; process exit is unconfirmed".into(),
            cleanup: Quiescence::Unknown,
        },
    }
}
