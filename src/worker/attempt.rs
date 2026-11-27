//! Attempt identity (docs/design/workers.md 2.4). Each remote OMP start carries the hub's attempt
//! token. The worker records it under `<root>/attempts` before the process exists, adds the
//! process identity once it does, and how it ended once the worker reaped it; only then does it
//! acknowledge on the attempt's channel. After a reconnect the hub asks for its tokens' states. What
//! this worker cannot prove either way is [`AttemptState::Unknown`]: a missing record, an unreadable
//! one, or no process identity to check is never taken for an exit.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::host::lead::Lease;
use crate::sys::command::Exit;
use crate::sys::fs;

#[path = "attempt_retention.rs"]
mod retention;

/// Longest attempt token.
const TOKEN_MAX: usize = 64;
/// Tokens one `attempts` question names, at most.
pub(crate) const QUERY_MAX: usize = 64;
/// Largest record file.
const RECORD_MAX: u64 = 4096;

/// What the worker knows of one attempt: the `attempts` answer per token, and the state an exit
/// acknowledgement carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub(crate) enum AttemptState {
    /// Its OMP still runs: the recorded process identity is alive. Reported only; the worker never
    /// kills or adopts an earlier attempt's process.
    Running { pid: u32 },
    /// Its OMP no longer runs, proven on the worker. `lease` is OMP's answer for the attempt's
    /// session right after the reap (`unknown` when no session was named or OMP could not say); a
    /// retry still checks the lease afresh.
    Reaped {
        exit: Reaped,
        #[serde(with = "lease_wire")]
        lease: Lease,
    },
    /// Neither can be proven: the hub holds the attempt as of unknown ownership.
    Unknown { reason: String },
}

/// How an attempt's OMP ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Reaped {
    /// The worker waited for it: its exit code.
    Code(i32),
    /// The worker waited for it: the signal that ended it.
    Signal(i32),
    /// Its recorded process identity no longer exists, but the `serve` that started it ended
    /// before waiting for it (a crash or SIGKILL), so there is no status.
    Gone,
    /// The spawn failed before a process existed.
    NotSpawned,
}

/// The exit acknowledgement's payload: the token and its state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Report {
    pub(crate) attempt: String,
    #[serde(flatten)]
    pub(crate) state: AttemptState,
}

impl AttemptState {
    /// The state of an attempt whose OMP the worker closed with this result.
    pub(crate) fn closed(exit: Exit, lease: Lease) -> Self {
        match exit {
            Exit::Code(c) => Self::Reaped {
                exit: Reaped::Code(c),
                lease,
            },
            Exit::Signal(s) => Self::Reaped {
                exit: Reaped::Signal(s),
                lease,
            },
            Exit::Unknown => Self::Unknown {
                reason: "the worker could not reap its OMP after KILL".into(),
            },
        }
    }

    fn unknown(reason: impl Into<String>) -> Self {
        Self::Unknown {
            reason: reason.into(),
        }
    }
}

/// `free`, `held` or `unknown` on the wire; anything else reads as `unknown`.
mod lease_wire {
    use serde::{Deserialize as _, Deserializer, Serializer};

    use crate::host::lead::Lease;

    #[allow(clippy::trivially_copy_pass_by_ref)]
    pub(super) fn serialize<S: Serializer>(lease: &Lease, out: S) -> Result<S::Ok, S::Error> {
        out.serialize_str(match lease {
            Lease::Free => "free",
            Lease::Held => "held",
            Lease::Unknown => "unknown",
        })
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(input: D) -> Result<Lease, D::Error> {
        Ok(match String::deserialize(input)?.as_str() {
            "free" => Lease::Free,
            "held" => Lease::Held,
            _ => Lease::Unknown,
        })
    }
}

/// Whether `token` can name an attempt: 1 to 64 ASCII letters, digits, `-` or `_`.
pub(crate) fn token_ok(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= TOKEN_MAX
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// One attempt as the worker keeps it.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct Record {
    attempt: String,
    session: Option<String>,
    started_ms: i64,
    pid: Option<u32>,
    /// Process identity of `pid` (boot and start time), so a reused PID is never taken for it.
    birth: Option<String>,
    /// The state the worker acknowledged once it closed the OMP.
    ended: Option<AttemptState>,
    ended_ms: Option<i64>,
}

/// The records of one hub's attempts on this worker: `<root>/attempts/<token>.json`.
pub(crate) struct Attempts {
    dir: PathBuf,
}

impl Attempts {
    pub(crate) fn new(root: &Path) -> Self {
        Self {
            dir: root.join("attempts"),
        }
    }

    /// The folder, for `serve` to create.
    pub(crate) fn dir(&self) -> &Path {
        &self.dir
    }

    fn path(&self, token: &str) -> PathBuf {
        self.dir.join(format!("{token}.json"))
    }

    /// Records a new attempt before its process exists. A token that is already recorded is
    /// refused: its evidence is never overwritten. Records are never removed here: only the hub
    /// knows which attempts its recovery still refers to.
    pub(crate) fn begin(&self, token: &str, session: Option<&str>) -> Result<Attempt, String> {
        if !token_ok(token) {
            return Err("spawn needs an attempt token of 1 to 64 letters, digits, - or _".into());
        }
        if session.is_some_and(|s| s.is_empty() || s.contains(['\n', '\0'])) {
            return Err("spawn names an invalid session".into());
        }
        let record = Record {
            attempt: token.to_string(),
            session: session.map(str::to_string),
            started_ms: crate::sys::now_ms(),
            ..Record::default()
        };
        let path = self.path(token);
        let bytes = serde_json::to_vec(&record).map_err(|e| e.to_string())?;
        fs::create_atomic(&path, &bytes).map_err(|e| {
            if path.exists() {
                format!("attempt {token} is already recorded on this worker")
            } else {
                format!("attempt {token} not recorded: {e}")
            }
        })?;
        Ok(Attempt { path, record })
    }

    /// What the record of `token` proves now. A recorded process whose identity is still alive is
    /// running; one whose identity is gone ended. Everything else is unknown.
    pub(crate) async fn state(&self, token: &str) -> AttemptState {
        if !token_ok(token) {
            return AttemptState::unknown(format!("{token:?} is not an attempt token"));
        }
        let path = self.path(token);
        let read = tokio::task::spawn_blocking(move || fs::read_private(&path, RECORD_MAX)).await;
        let bytes = match read {
            Ok(Ok(Some(bytes))) => bytes,
            Ok(Ok(None)) => {
                return AttemptState::unknown(format!(
                    "no record of attempt {token} on this worker"
                ));
            }
            Ok(Err(e)) => return AttemptState::unknown(e.to_string()),
            Err(e) => return AttemptState::unknown(e.to_string()),
        };
        let record: Record = match serde_json::from_slice(&bytes) {
            Ok(r) => r,
            Err(e) => return AttemptState::unknown(format!("attempt {token}'s record: {e}")),
        };
        if record.attempt != token {
            return AttemptState::unknown(format!(
                "attempt token {token} does not match its recorded receipt"
            ));
        }
        if let Some(ended @ AttemptState::Reaped { .. }) = record.ended {
            return ended;
        }
        let (Some(pid), Some(saved)) = (record.pid, record.birth) else {
            return AttemptState::unknown(format!(
                "attempt {token} has no recorded process identity"
            ));
        };
        match birth(pid).await {
            Ok(Some(now)) if now == saved => AttemptState::Running { pid },
            Ok(_) => AttemptState::Reaped {
                exit: Reaped::Gone,
                lease: Lease::Unknown,
            },
            Err(e) => AttemptState::unknown(format!("process {pid}: {e}")),
        }
    }
}

/// One attempt's record while its spawn goes on.
pub(crate) struct Attempt {
    path: PathBuf,
    record: Record,
}

impl Attempt {
    pub(crate) fn token(&self) -> &str {
        &self.record.attempt
    }

    pub(crate) fn session(&self) -> Option<&str> {
        self.record.session.as_deref()
    }

    /// Adds the process and its identity. Without an identity the attempt could never be
    /// reconciled, so the caller ends the process on an error.
    pub(crate) async fn spawned(&mut self, pid: Option<u32>) -> Result<(), String> {
        let pid = pid.ok_or("the OMP child has no PID")?;
        let born = birth(pid)
            .await?
            .ok_or_else(|| format!("process {pid} ended before its identity was read"))?;
        self.record.pid = Some(pid);
        self.record.birth = Some(born);
        self.save()
    }

    /// Records how the attempt ended, before it is acknowledged.
    pub(crate) fn ended(&mut self, state: &AttemptState) -> Result<(), String> {
        self.record.ended = Some(state.clone());
        self.record.ended_ms = Some(crate::sys::now_ms());
        self.save()
    }

    fn save(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec(&self.record).map_err(|e| e.to_string())?;
        fs::write_atomic(&self.path, &bytes).map_err(|e| e.to_string())
    }
}

/// A process's identity: boot ID and start time, `None` once it no longer exists.
#[cfg(target_os = "linux")]
pub(crate) async fn birth(pid: u32) -> Result<Option<String>, String> {
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

/// A process's identity: its start time as `ps` reports it, `None` once it no longer exists.
#[cfg(not(target_os = "linux"))]
pub(crate) async fn birth(pid: u32) -> Result<Option<String>, String> {
    use crate::sys::command::{self, Output, Spec};
    use std::time::Duration;
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
        timeout: Duration::from_secs(2),
        kill_grace: Duration::from_secs(1),
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

    #[test]
    fn states_cross_the_wire_in_their_documented_shapes() {
        let cases = [
            (
                AttemptState::Running { pid: 7 },
                serde_json::json!({"attempt": "a1", "state": "running", "pid": 7}),
            ),
            (
                AttemptState::Reaped {
                    exit: Reaped::Code(0),
                    lease: Lease::Free,
                },
                serde_json::json!({"attempt": "a1", "state": "reaped", "exit": {"code": 0}, "lease": "free"}),
            ),
            (
                AttemptState::Reaped {
                    exit: Reaped::Signal(9),
                    lease: Lease::Held,
                },
                serde_json::json!({"attempt": "a1", "state": "reaped", "exit": {"signal": 9}, "lease": "held"}),
            ),
            (
                AttemptState::Reaped {
                    exit: Reaped::Gone,
                    lease: Lease::Unknown,
                },
                serde_json::json!({"attempt": "a1", "state": "reaped", "exit": "gone", "lease": "unknown"}),
            ),
            (
                AttemptState::Unknown {
                    reason: "why".into(),
                },
                serde_json::json!({"attempt": "a1", "state": "unknown", "reason": "why"}),
            ),
        ];
        for (state, wire) in cases {
            let report = Report {
                attempt: "a1".into(),
                state,
            };
            assert_eq!(serde_json::to_value(&report).unwrap(), wire);
            assert_eq!(serde_json::from_value::<Report>(wire).unwrap(), report);
        }
        assert!(token_ok("0123abcd-_Z") && !token_ok("") && !token_ok("../x"));
        assert!(!token_ok(&"a".repeat(65)));
    }

    #[tokio::test]
    async fn records_prove_running_reaped_gone_or_unknown() {
        let dir = crate::sys::fs::tests::scratch("worker-attempts");
        let attempts = Attempts::new(&dir);
        crate::sys::fs::ensure_private_dir(attempts.dir()).unwrap();
        assert!(matches!(
            attempts.state("never").await,
            AttemptState::Unknown { reason } if reason.contains("no record")
        ));
        // Recorded but no process identity yet: a crash in between is unknown, not gone.
        let mut first = attempts.begin("first", Some("s-1")).unwrap();
        assert!(matches!(
            attempts.state("first").await,
            AttemptState::Unknown { .. }
        ));
        assert!(
            attempts.begin("first", None).is_err(),
            "a token is used once"
        );
        let argv = ["sh".into(), "-c".into(), "read line".into()];
        let child = command::attach(&argv, Some(&dir), &[], None, 4096).unwrap();
        first.spawned(child.pid()).await.unwrap();
        assert_eq!(
            attempts.state("first").await,
            AttemptState::Running {
                pid: child.pid().unwrap()
            }
        );
        // Reaped by someone else (the serve that started it is gone): proven ended, no status.
        let (exit, _) = child
            .close(Duration::from_secs(1), Duration::from_secs(1))
            .await;
        assert_ne!(exit, Exit::Unknown);
        assert_eq!(
            attempts.state("first").await,
            AttemptState::Reaped {
                exit: Reaped::Gone,
                lease: Lease::Unknown
            }
        );
        // Reaped and recorded by the worker: the status it acknowledged.
        let done = AttemptState::closed(Exit::Signal(15), Lease::Free);
        first.ended(&done).unwrap();
        assert_eq!(attempts.state("first").await, done);
        assert_eq!(first.token(), "first");
        assert_eq!(first.session(), Some("s-1"));
    }

    #[tokio::test]
    async fn another_attempts_receipt_cannot_prove_termination() {
        let dir = crate::sys::fs::tests::scratch("worker-wrong-receipt");
        let attempts = Attempts::new(&dir);
        crate::sys::fs::ensure_private_dir(attempts.dir()).unwrap();
        let mut first = attempts.begin("first", None).unwrap();
        attempts.begin("second", None).unwrap();
        first
            .ended(&AttemptState::Reaped {
                exit: Reaped::NotSpawned,
                lease: Lease::Free,
            })
            .unwrap();
        std::fs::copy(attempts.path("first"), attempts.path("second")).unwrap();
        assert!(matches!(
            attempts.state("second").await,
            AttemptState::Unknown { reason } if reason.contains("token")
        ));
    }
}
