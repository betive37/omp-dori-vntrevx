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
        let path = entry.path();
        let bytes = match crate::sys::fs::read_private(&path, 4096) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => continue,
            Err(error) => {
                crate::log::warn(
                    "startup receipt unreadable; retained",
                    &[("handle", &handle), ("error", &error)],
                );
                continue;
            }
        };
        let evidence: Evidence = match serde_json::from_slice(&bytes) {
            Ok(evidence) => evidence,
            Err(error) => {
                crate::log::warn(
                    "startup receipt invalid; retained",
                    &[("handle", &handle), ("error", &error)],
                );
                continue;
            }
        };
        // Legacy records lack the episode coordinate; an absent coordinate is not proof.
        if evidence.created_ms == 0 || referenced(store, handle, &evidence).await? {
            continue;
        }
        let cleanup = match reconcile_attempt(state, handle, evidence.worker.as_deref()).await {
            Ok(cleanup) => cleanup,
            Err(error) => {
                crate::log::warn(
                    "startup receipt retained",
                    &[("handle", &handle), ("error", &error)],
                );
                continue;
            }
        };
        if !cleanup.confirmed() || referenced(store, handle, &evidence).await? {
            continue;
        }
        if let Some(worker) = &evidence.worker {
            let forgotten = match crate::worker::link::connect(worker).await {
                Ok(link) => link.forget_attempts(&[handle]).await,
                Err(error) => Err(error),
            };
            if let Err(error) = forgotten {
                crate::log::warn(
                    "worker receipt retained",
                    &[("handle", &handle), ("error", &error)],
                );
                continue;
            }
        }
        // Handles are one-use; a superseded handle is never installed back into a lane record.
        match std::fs::remove_file(&path) {
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
        for handle in [
            "unused", "lane", "episode", "anchor", "pinned", "unknown", "offline",
        ] {
            let owner = Ownership::prepare(&state, handle).unwrap();
            owner
                .identify(Some(handle), (handle == "offline").then_some("offline"))
                .unwrap();
            if handle != "unknown" && handle != "offline" {
                owner.finished(Cleanup::LocalReaped).unwrap();
            }
            let mut evidence = owner.evidence.lock().unwrap();
            evidence.created_ms = 1;
            owner.save(&evidence).unwrap();
        }
        crate::sys::fs::write_atomic(&state.join("startup/corrupt.json"), b"{").unwrap();
        let conn = rusqlite::Connection::open(&db).unwrap();
        for handle in ["anchor", "pinned"] {
            conn.execute("INSERT INTO sessions(handle,role,runtime,cwd,name,model,mode,state,started_ms,updated_ms) VALUES(?1,'lead','headless','/work','lead','fake/primary','fresh','stopped',0,0)", [handle]).unwrap();
            conn.execute("INSERT INTO lead_bindings(handle,session_id,session_file,cwd,runtime,provenance,bound_ms) VALUES(?1,?1,'/file','/work','headless','test binding',0)", [handle]).unwrap();
        }
        conn.execute(
            "INSERT INTO lanes(key,state,opened_ms,revision,record) VALUES('lane','closed',0,1,?1)",
            [r#"{"handle":"lane"}"#],
        )
        .unwrap();
        conn.execute("INSERT INTO startup_episodes(target,session_id,started_ms,deadline_ms,state) VALUES('lane:episode','episode',0,300000,'held')", []).unwrap();
        prune(&state, &store).await.unwrap();
        assert!(!recorded(&state, "unused").unwrap());
        for handle in ["lane", "episode", "anchor", "pinned", "unknown", "offline"] {
            assert!(recorded(&state, handle).unwrap(), "lost {handle}");
        }
        conn.execute("DELETE FROM lanes", []).unwrap();
        conn.execute("DELETE FROM startup_episodes", []).unwrap();
        conn.execute("DELETE FROM lead_bindings", []).unwrap();
        prune(&state, &store).await.unwrap();
        assert!(!recorded(&state, "lane").unwrap());
        assert!(!recorded(&state, "episode").unwrap());
        assert!(!recorded(&state, "anchor").unwrap());
        assert!(!recorded(&state, "pinned").unwrap());
        assert!(recorded(&state, "unknown").unwrap());
        assert!(recorded(&state, "corrupt").unwrap());
        assert!(recorded(&state, "offline").unwrap());
        drop(conn);
        drop(store);
        writer.join().unwrap().unwrap();
    }

    #[tokio::test]
    async fn duplicate_binding_maintenance_and_restart_keep_current_and_pinned_journals() {
        let state = crate::sys::fs::tests::scratch("binding-receipt-retention");
        let db = state.join("store.db");
        let (store, writer) = Store::open(&db, &state.join("backup")).unwrap();
        let conn = rusqlite::Connection::open(&db).unwrap();
        for (handle, id, time) in [
            ("a1", "A", 1),
            ("a2", "A", 2),
            ("a3", "A", 3),
            ("b", "B", 4),
        ] {
            let file = format!("/{id}");
            conn.execute(
                "INSERT INTO sessions(handle,role,runtime,cwd,name,model,mode,state,session_id,session_file,started_ms,updated_ms) \
                 VALUES(?1,'lead','headless','/work','lead','fake/primary','fresh','stopped',?2,?3,?4,?4)",
                rusqlite::params![handle, id, file, time],
            ).unwrap();
            conn.execute(
                "INSERT INTO lead_bindings(handle,session_id,session_file,cwd,runtime,provenance,bound_ms) \
                 VALUES(?1,?2,?3,'/work','headless','test binding',?4)",
                rusqlite::params![handle, id, file, time],
            ).unwrap();
            let owner = Ownership::prepare(&state, handle).unwrap();
            owner.identify(Some(id), None).unwrap();
            owner.finished(Cleanup::LocalReaped).unwrap();
        }
        conn.execute("UPDATE lead_anchor SET handle='b',ever_started=1", [])
            .unwrap();
        store.maintain(10).await.unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM lead_bindings", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
        // Simulate a hub exit after the pure binding transaction, before file pruning.
        assert!(recorded(&state, "a1").unwrap());
        drop(conn);
        drop(store);
        writer.join().unwrap().unwrap();
        let (store, writer) = Store::open(&db, &state.join("backup")).unwrap();
        let (anchor, pinned) = store
            .read(|reads| {
                Ok((
                    reads.lead_target(None)?.row.map(|row| row.handle),
                    reads.lead_target(Some("A"))?.row.map(|row| row.handle),
                ))
            })
            .await
            .unwrap();
        assert_eq!(anchor.as_deref(), Some("b"));
        assert_eq!(pinned.as_deref(), Some("a3"));
        prune(&state, &store).await.unwrap();
        for handle in ["a1", "a2"] {
            assert!(!recorded(&state, handle).unwrap());
        }
        for handle in ["a3", "b"] {
            assert!(recorded(&state, handle).unwrap());
        }
        drop(store);
        writer.join().unwrap().unwrap();
    }
}
