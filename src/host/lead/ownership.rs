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
    #[serde(default)]
    created_ms: i64,
    #[serde(default)]
    session: Option<String>,
    #[serde(default)]
    worker: Option<String>,
    #[serde(default)]
    terminal: Option<Terminal>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Terminal {
    program: PathBuf,
    block: String,
}

#[path = "ownership_prune.rs"]
mod retention;
pub(crate) use retention::prune;

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
            created_ms: crate::sys::now_ms(),
            session: None,
            worker: None,
            terminal: None,
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

    pub(crate) fn identify(
        &self,
        session: Option<&str>,
        worker: Option<&str>,
    ) -> Result<(), String> {
        let mut evidence = self
            .evidence
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        evidence.session = session.map(str::to_string);
        evidence.worker = worker.map(str::to_string);
        self.save(&evidence)
    }

    pub(crate) fn terminal(&self, program: &Path, block: &str) -> Result<(), String> {
        let mut evidence = self
            .evidence
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        evidence.terminal = Some(Terminal {
            program: program.to_path_buf(),
            block: block.into(),
        });
        self.save(&evidence)
    }

    pub(crate) fn cleanup(&self) -> Cleanup {
        if self
            .evidence
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .reaped
        {
            Cleanup::LocalReaped
        } else {
            Cleanup::Unknown
        }
    }

    pub(crate) async fn exited(&self) -> Result<Cleanup, String> {
        let (pid, saved, reaped) = {
            let evidence = self
                .evidence
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            (evidence.pid, evidence.birth.clone(), evidence.reaped)
        };
        process_exit(pid, saved.as_deref(), reaped).await
    }

    pub(crate) async fn close_terminal(&self) -> Result<Cleanup, String> {
        let proof = self.exited().await?;
        if proof.confirmed() {
            self.finished(proof)?;
            return Ok(proof);
        }
        let terminal = self
            .evidence
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .terminal
            .clone();
        let Some(terminal) = terminal else {
            return Ok(Cleanup::Unknown);
        };
        let argv = [
            terminal.program.display().to_string(),
            "close".into(),
            terminal.block,
        ];
        let result = crate::sys::command::run(&crate::sys::command::Spec {
            argv: &argv,
            cwd: None,
            env: &[],
            timeout: std::time::Duration::from_secs(10),
            kill_grace: crate::sys::command::KILL_GRACE,
            output_cap: 64 * 1024,
            output: crate::sys::command::Output::Capture,
        })
        .await
        .map_err(|e| e.to_string())?;
        if result.success() {
            self.finished(Cleanup::LocalReaped)?;
            Ok(Cleanup::LocalReaped)
        } else {
            Ok(Cleanup::Unknown)
        }
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

pub(crate) fn recorded(state: &Path, handle: &str) -> Result<bool, String> {
    fs::read_private(&state.join("startup").join(format!("{handle}.json")), 4096)
        .map(|record| record.is_some())
        .map_err(|e| e.to_string())
}

pub(crate) async fn reconcile(state: &Path, handle: &str) -> Result<Cleanup, String> {
    let path = state.join("startup").join(format!("{handle}.json"));
    let Some(bytes) = fs::read_private(&path, 4096).map_err(|e| e.to_string())? else {
        return Ok(Cleanup::Unknown);
    };
    let evidence: Evidence = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    process_exit(evidence.pid, evidence.birth.as_deref(), evidence.reaped).await
}

async fn process_exit(
    pid: Option<u32>,
    saved: Option<&str>,
    reaped: bool,
) -> Result<Cleanup, String> {
    if reaped {
        return Ok(Cleanup::LocalReaped);
    }
    match (pid, saved) {
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
#[path = "ownership_tests.rs"]
mod tests;
