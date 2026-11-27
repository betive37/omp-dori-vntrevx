//! Pre-bind process ownership. An absent or incomplete journal is unknown, never proof of exit. A
//! start on a worker is reconciled by its attempt token there; a disconnect alone proves nothing.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::host::startup::Cleanup;
use crate::sys::fs;
use crate::worker::attempt::{AttemptState, Reaped, birth};

#[derive(Debug, Deserialize, Serialize)]
struct Evidence {
    pid: Option<u32>,
    birth: Option<String>,
    reaped: bool,
}

#[derive(Debug)]
pub(crate) struct Ownership {
    path: PathBuf,
    evidence: std::sync::Mutex<Evidence>,
}

impl Ownership {
    pub(crate) fn prepare(state: &Path, handle: &str) -> Result<Self, String> {
        let dir = state.join("startup");
        fs::ensure_private_dir(&dir).map_err(|e| e.to_string())?;
        let evidence = Evidence {
            pid: None,
            birth: None,
            reaped: false,
        };
        let bytes = serde_json::to_vec(&evidence).map_err(|e| e.to_string())?;
        let owner = Self {
            path: dir.join(format!("{handle}.json")),
            evidence: std::sync::Mutex::new(evidence),
        };
        fs::create_atomic(&owner.path, &bytes).map_err(|e| e.to_string())?;
        Ok(owner)
    }

    pub(crate) async fn spawned(&self, pid: Option<u32>) -> Result<(), String> {
        let birth = match pid {
            Some(pid) => birth(pid).await?,
            None => None,
        };
        let mut evidence = self
            .evidence
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        evidence.pid = pid;
        evidence.birth = birth;
        self.save(&evidence)
    }

    pub(crate) fn finished(&self, cleanup: Cleanup) -> Result<(), String> {
        let mut evidence = self
            .evidence
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        evidence.reaped = cleanup.confirmed();
        self.save(&evidence)
    }

    fn save(&self, evidence: &Evidence) -> Result<(), String> {
        let bytes = serde_json::to_vec(evidence).map_err(|e| e.to_string())?;
        fs::write_atomic(&self.path, &bytes).map_err(|e| e.to_string())
    }
}

pub(crate) async fn reconcile(state: &Path, handle: &str) -> Result<Cleanup, String> {
    let path = state.join("startup").join(format!("{handle}.json"));
    let Some(bytes) = fs::read_private(&path, 4096).map_err(|e| e.to_string())? else {
        return Ok(Cleanup::Unknown);
    };
    let evidence: Evidence = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if evidence.reaped {
        return Ok(Cleanup::LocalReaped);
    }
    match (evidence.pid, evidence.birth) {
        (Some(pid), Some(saved)) => match birth(pid).await? {
            None => Ok(Cleanup::LocalReaped),
            Some(current) if current != saved => Ok(Cleanup::LocalReaped),
            Some(_) => Ok(Cleanup::Unknown),
        },
        _ => Ok(Cleanup::Unknown),
    }
}

/// Reconciles attempt `handle`: from its journal here when `worker` is `None`, else by asking the
/// worker for its token after a reconnect. Only proof of exit is confirmed. A process of the attempt
/// that still runs is reported in the error, never killed or adopted; unknown ownership is an error
/// too, and both hold.
pub(crate) async fn reconcile_attempt(
    state: &Path,
    handle: &str,
    worker: Option<&str>,
) -> Result<Cleanup, String> {
    let Some(worker) = worker else {
        return reconcile(state, handle).await;
    };
    match crate::worker::link::reconcile(worker, handle).await {
        AttemptState::Running { pid } => Err(format!(
            "attempt {handle} still runs on {worker} as process {pid}; it is reported, never killed \
             or adopted"
        )),
        AttemptState::Unknown { reason } => Err(format!(
            "ownership of attempt {handle} on {worker} is unknown: {reason}"
        )),
        reaped @ AttemptState::Reaped { .. } => Ok(worker_cleanup(&reaped)),
    }
}

/// The cleanup a worker's state for an attempt proves: an exit acknowledgement or an `attempts`
/// answer. Only a reap on the worker confirms; running and unknown do not.
pub(crate) fn worker_cleanup(state: &AttemptState) -> Cleanup {
    match state {
        AttemptState::Reaped {
            exit: Reaped::NotSpawned,
            ..
        } => Cleanup::NotSpawned,
        AttemptState::Reaped { .. } => Cleanup::WorkerReaped,
        AttemptState::Running { .. } | AttemptState::Unknown { .. } => Cleanup::Unknown,
    }
}

#[cfg(test)]
mod tests {
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
}
