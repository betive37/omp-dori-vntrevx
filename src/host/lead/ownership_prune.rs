//! Prune settled attempt receipts only after all durable consumers have released their handles.

use std::path::Path;

use super::{Evidence, reconcile_attempt};
use crate::store::Store;

async fn referenced(store: &Store, handle: &str, evidence: &Evidence) -> Result<bool, String> {
    let handle = handle.to_string();
    let session = evidence.session.clone();
    let created = evidence.created_ms;
    store
        .read(move |reads| reads.startup_referenced(&handle, session.as_deref(), created))
        .await
        .map_err(|e| e.to_string())
}

pub(crate) async fn prune(state: &Path, store: &Store) -> Result<(), String> {
    let entries = match std::fs::read_dir(state.join("startup")) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let Some(handle) = name.to_str().and_then(|name| name.strip_suffix(".json")) else {
            continue;
        };
        let Some(bytes) =
            crate::sys::fs::read_private(&entry.path(), 4096).map_err(|e| e.to_string())?
        else {
            continue;
        };
        let evidence: Evidence = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        // Legacy records lack the episode coordinate; an absent coordinate is not proof.
        if evidence.created_ms == 0 || referenced(store, handle, &evidence).await? {
            continue;
        }
        let cleanup = reconcile_attempt(state, handle, evidence.worker.as_deref()).await?;
        if !cleanup.confirmed() || referenced(store, handle, &evidence).await? {
            continue;
        }
        if let Some(worker) = &evidence.worker {
            crate::worker::link::connect(worker)
                .await?
                .forget_attempts(&[handle])
                .await?;
        }
        // Handles are one-use; a superseded handle is never installed back into a lane record.
        match std::fs::remove_file(entry.path()) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::lead::ownership::{Ownership, recorded};
    use crate::host::startup::Cleanup;

    #[tokio::test]
    async fn pruning_keeps_referenced_and_unknown_attempts_without_an_age_cutoff() {
        let state = crate::sys::fs::tests::scratch("attempt-retention");
        let db = state.join("store.db");
        let (store, writer) = Store::open(&db, &state.join("backup")).unwrap();
        for handle in ["unused", "lane", "episode", "unknown"] {
            let owner = Ownership::prepare(&state, handle).unwrap();
            owner.identify(Some(handle), None).unwrap();
            if handle != "unknown" {
                owner.finished(Cleanup::LocalReaped).unwrap();
            }
        }
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute(
            "INSERT INTO lanes(key,state,opened_ms,revision,record) VALUES('lane','closed',0,1,?1)",
            [r#"{"handle":"lane"}"#],
        )
        .unwrap();
        conn.execute("INSERT INTO startup_episodes(target,session_id,started_ms,deadline_ms,state) VALUES('lane:episode','episode',0,300000,'held')", []).unwrap();
        prune(&state, &store).await.unwrap();
        assert!(!recorded(&state, "unused").unwrap());
        for handle in ["lane", "episode", "unknown"] {
            assert!(recorded(&state, handle).unwrap(), "lost {handle}");
        }
        conn.execute("DELETE FROM lanes", []).unwrap();
        conn.execute("DELETE FROM startup_episodes", []).unwrap();
        prune(&state, &store).await.unwrap();
        assert!(!recorded(&state, "lane").unwrap());
        assert!(!recorded(&state, "episode").unwrap());
        assert!(recorded(&state, "unknown").unwrap());
        drop(conn);
        drop(store);
        writer.join().unwrap().unwrap();
    }
}
