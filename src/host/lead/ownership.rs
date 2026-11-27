//! Pre-bind process ownership. An absent or incomplete journal is unknown, never proof of exit.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::host::startup::Cleanup;
use crate::sys::fs;

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

#[cfg(target_os = "linux")]
async fn birth(pid: u32) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Ok(stat) => {
                let (_, fields) = stat.rsplit_once(')').ok_or("invalid process identity")?;
                let born = fields
                    .split_whitespace()
                    .nth(19)
                    .ok_or("missing process birth identity")?;
                let boot = std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
                    .map_err(|e| e.to_string())?;
                Ok(Some(format!("{}:{born}", boot.trim())))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(not(target_os = "linux"))]
async fn birth(pid: u32) -> Result<Option<String>, String> {
    use crate::sys::command::{self, Exit, Output, Spec};
    let argv = [
        "ps".into(),
        "-p".into(),
        pid.to_string(),
        "-o".into(),
        "lstart=".into(),
    ];
    let result = command::run(&Spec {
        argv: &argv,
        cwd: None,
        env: &[],
        timeout: std::time::Duration::from_secs(2),
        kill_grace: std::time::Duration::from_secs(1),
        output_cap: 4096,
        output: Output::Capture,
    })
    .await
    .map_err(|e| e.to_string())?;
    match result.exit {
        Exit::Code(0) => Ok(Some(
            String::from_utf8(result.stdout)
                .map_err(|e| e.to_string())?
                .trim()
                .to_string(),
        )),
        Exit::Code(1) => Ok(None),
        Exit::Code(_) | Exit::Signal(_) | Exit::Unknown => {
            Err("process identity query failed".into())
        }
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
}
