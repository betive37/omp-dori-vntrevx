//! Positive lead binding registry; attempts cannot select or replace an identity.

use rusqlite::{OptionalExtension, Transaction, params};

use super::{HostDone, Reads, SESSION_COLUMNS, SessionRow, SessionUpdate, session_from_row};

#[derive(Debug)]
pub(crate) struct Selection {
    pub(crate) row: Option<SessionRow>,
    pub(crate) ever_started: bool,
    pub(crate) intent: String,
    pub(crate) hold: Option<String>,
    pub(crate) provenance: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum Intent {
    Fresh,
    Resume,
}

pub(super) fn intent(tx: &Transaction<'_>, intent: Intent) -> rusqlite::Result<HostDone> {
    tx.execute("UPDATE lead_anchor SET intent = ?1 WHERE singleton = 1",
        [match intent { Intent::Fresh => "fresh", Intent::Resume => "resume" }])?;
    Ok(HostDone::Done)
}

pub(super) fn bound(tx: &Transaction<'_>, update: &SessionUpdate, now: i64) -> rusqlite::Result<HostDone> {
    let (Some(id), Some(file)) = (&update.session_id, &update.session_file) else {
        return Err(rusqlite::Error::InvalidQuery);
    };
    if update.fault.is_some() {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let done = super::update(tx, update, now)?;
    let written = tx.execute(
        "INSERT INTO lead_bindings(handle, session_id, session_file, cwd, runtime, provenance, bound_ms) \
         SELECT handle, ?2, ?3, cwd, runtime, 'two exact get_state identities and accepted model', ?4 \
         FROM sessions WHERE handle = ?1 AND role = 'lead'",
        params![update.handle, id, file, now])?;
    if written != 1 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    tx.execute("UPDATE lead_anchor SET handle = ?1, ever_started = 1, intent = 'resume', hold = NULL WHERE singleton = 1", [&update.handle])?;
    tx.execute("UPDATE startup_episodes SET state = 'bound', next_ms = NULL WHERE target = 'lead'", [])?;
    Ok(done)
}

impl Reads {
    /// The only resolver for current and pinned lead identity. Unbound attempts are never candidates.
    pub(crate) fn lead_target(&self, pin: Option<&str>) -> rusqlite::Result<Selection> {
        let (current, ever_started, intent, mut hold): (Option<String>, bool, String, Option<String>) = self.0.query_row(
            "SELECT handle, ever_started, intent, hold FROM lead_anchor WHERE singleton = 1", [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        let handle = match pin {
            None => current,
            Some(id) => {
                let distinct: i64 = self.0.query_row(
                    "SELECT COUNT(*) FROM (SELECT session_file, cwd, runtime FROM lead_bindings WHERE session_id = ?1 GROUP BY session_file, cwd, runtime)",
                    [id], |r| r.get(0))?;
                if distinct != 1 {
                    hold = Some(format!("required lead session {id} has {distinct} verified identities; held, never substituted"));
                    None
                } else {
                    hold = None;
                    self.0.query_row("SELECT handle FROM lead_bindings WHERE session_id = ?1 ORDER BY bound_ms DESC, rowid DESC LIMIT 1", [id], |r| r.get(0)).optional()?
                }
            }
        };
        let provenance = match &handle {
            Some(handle) => self.0.query_row("SELECT provenance FROM lead_bindings WHERE handle = ?1", [handle], |r| r.get(0)).optional()?,
            None => None,
        };
        let row = match handle {
            None => None,
            Some(handle) => self.0.query_row(&format!("SELECT {SESSION_COLUMNS} FROM sessions WHERE handle = ?1"), [handle], session_from_row).optional()?,
        };
        if self.0.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE role = 'lead' AND session_id IS NULL AND state IN ('starting', 'held', 'orphan_held'))", [], |r| r.get::<_, bool>(0))? {
            hold = Some("an earlier unbound lead attempt has unknown process ownership; held until its exit is reconciled".into());
        }
        Ok(Selection { row, ever_started, intent, hold, provenance })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use crate::store::host::{HostWrite, maintain, write};

    fn database() -> Connection {
        let mut db = Connection::open_in_memory().unwrap();
        crate::store::schema::migrate(&mut db, std::path::Path::new("/unused")).unwrap();
        db
    }

    fn attempt(db: &mut Connection, handle: &str, mode: &str, now: i64) {
        let tx = db.transaction().unwrap();
        write(&tx, &HostWrite::Record(SessionRow {
            handle: handle.into(), role: "lead".into(), runtime: "headless".into(),
            cwd: "/work".into(), name: "lead".into(), model: "fake/primary".into(), thinking: None,
            mode: mode.into(), expected_id: None, expected_file: None, state: "failed".into(),
            session_id: None, session_file: None, pid: None, started_ms: now, updated_ms: now,
            stop_how: None, stop_detail: None, stop_ms: None, fault: None,
        }), now).unwrap();
        tx.commit().unwrap();
    }

    fn bind(db: &mut Connection, handle: &str, id: &str, now: i64) {
        let tx = db.transaction().unwrap();
        bound(&tx, &SessionUpdate {
            handle: handle.into(), state: Some("stopped".into()), session_id: Some(id.into()),
            session_file: Some(format!("/sessions/{id}.jsonl")), ..SessionUpdate::default()
        }, now).unwrap();
        tx.commit().unwrap();
    }

    #[test]
    fn failed_attempt_and_retention_never_replace_the_anchor() {
        let mut db = database();
        attempt(&mut db, "bound", "fresh", 1);
        bind(&mut db, "bound", "A", 1);
        attempt(&mut db, "timeout", "resume", 2);
        let tx = db.transaction().unwrap();
        maintain(&tx, 32 * 24 * 3600 * 1000).unwrap();
        tx.commit().unwrap();
        let selected = Reads(db).lead_target(None).unwrap();
        assert_eq!(selected.row.unwrap().session_id.as_deref(), Some("A"));
        assert_eq!(selected.intent, "resume");
    }

    #[test]
    fn pins_select_older_bindings_and_failed_fresh_requires_owner_choice() {
        let mut db = database();
        attempt(&mut db, "a", "fresh", 1);
        bind(&mut db, "a", "A", 1);
        attempt(&mut db, "b", "fresh", 1);
        bind(&mut db, "b", "B", 1);
        attempt(&mut db, "failed-fresh", "fresh", 2);
        let reads = Reads(db);
        let pinned = reads.lead_target(Some("A")).unwrap();
        assert_eq!(pinned.row.unwrap().handle, "a");
        let current = reads.lead_target(None).unwrap();
        assert_eq!(current.row.unwrap().session_id.as_deref(), Some("B"));
        assert_eq!(current.intent, "fresh_failed");
        assert!(reads.lead_target(Some("missing")).unwrap().hold.is_some());
    }

    #[test]
    fn inconsistent_binding_locations_hold_instead_of_guessing() {
        let mut db = database();
        attempt(&mut db, "a", "fresh", 1);
        bind(&mut db, "a", "A", 1);
        attempt(&mut db, "b", "resume", 2);
        bind(&mut db, "b", "A", 2);
        db.execute("UPDATE lead_bindings SET cwd = '/other' WHERE handle = 'b'", []).unwrap();
        let selected = Reads(db).lead_target(Some("A")).unwrap();
        assert!(selected.row.is_none());
        assert!(selected.hold.unwrap().contains("2 verified identities"));
    }

    #[test]
    fn an_uncommitted_binding_cannot_advance_identity() {
        let mut db = database();
        attempt(&mut db, "a", "fresh", 1);
        bind(&mut db, "a", "A", 1);
        attempt(&mut db, "bad", "fresh", 2);
        let tx = db.transaction().unwrap();
        assert!(bound(&tx, &SessionUpdate {
            handle: "bad".into(), session_id: Some("B".into()), session_file: Some("/b".into()),
            fault: Some("model mismatch".into()), ..SessionUpdate::default()
        }, 2).is_err());
        tx.rollback().unwrap();
        assert_eq!(Reads(db).lead_target(None).unwrap().row.unwrap().session_id.as_deref(), Some("A"));
    }
}
