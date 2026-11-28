//! Only the hub can acknowledge that a token is no longer referenced by durable recovery state.

use super::{AttemptState, Attempts, RECORD_MAX, Record, birth, fs, token_ok};

impl Attempts {
    /// Forgets a reconciled token only after proving its writer is gone. Missing is idempotent;
    /// unreadable, malformed, running and unknown records are retained. Age is not authority.
    pub(crate) async fn forget(&self, token: &str) -> Result<(), String> {
        if !token_ok(token) {
            return Err("invalid attempt token".into());
        }
        let path = self.path(token);
        let (path, bytes) = tokio::task::spawn_blocking(move || {
            fs::read_private(&path, RECORD_MAX).map(|bytes| (path, bytes))
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        let Some(bytes) = bytes else {
            return Ok(());
        };
        let record: Record = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if record.attempt != token {
            return Err("attempt token does not match its receipt".into());
        }
        match record.ended {
            Some(AttemptState::Reaped { .. }) => {}
            Some(AttemptState::Running { .. } | AttemptState::Unknown { .. }) | None => {
                let (Some(pid), Some(saved)) = (record.pid, record.birth) else {
                    return Err("attempt exit is unknown; kept".into());
                };
                if birth(pid).await?.as_ref() == Some(&saved) {
                    return Err("attempt is still running; kept".into());
                }
            }
        }
        tokio::task::spawn_blocking(move || std::fs::remove_file(path))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())
    }
}
