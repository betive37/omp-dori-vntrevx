use super::*;
use crate::store::host::{HostWrite, maintain, write};
use rusqlite::Connection;

fn database() -> Connection {
    let mut db = Connection::open_in_memory().unwrap();
    crate::store::schema::migrate(&mut db, std::path::Path::new("/unused")).unwrap();
    db
}

fn attempt(db: &mut Connection, handle: &str, mode: &str, now: i64) {
    let tx = db.transaction().unwrap();
    write(
        &tx,
        &HostWrite::Record(SessionRow {
            handle: handle.into(),
            role: "lead".into(),
            runtime: "headless".into(),
            cwd: "/work".into(),
            name: "lead".into(),
            model: "fake/primary".into(),
            thinking: None,
            mode: mode.into(),
            expected_id: None,
            expected_file: None,
            state: "failed".into(),
            session_id: None,
            session_file: None,
            pid: None,
            started_ms: now,
            updated_ms: now,
            stop_how: None,
            stop_detail: None,
            stop_ms: None,
            fault: None,
        }),
        now,
    )
    .unwrap();
    tx.commit().unwrap();
}

fn bind(db: &mut Connection, handle: &str, id: &str, now: i64) {
    let tx = db.transaction().unwrap();
    bound(
        &tx,
        &SessionUpdate {
            handle: handle.into(),
            state: Some("stopped".into()),
            session_id: Some(id.into()),
            session_file: Some(format!("/sessions/{id}.jsonl")),
            ..SessionUpdate::default()
        },
        now,
    )
    .unwrap();
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
    db.execute(
        "UPDATE lead_bindings SET cwd = '/other' WHERE handle = 'b'",
        [],
    )
    .unwrap();
    let tx = db.transaction().unwrap();
    maintain(&tx, 3).unwrap();
    tx.commit().unwrap();
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
    assert!(
        bound(
            &tx,
            &SessionUpdate {
                handle: "bad".into(),
                session_id: Some("B".into()),
                session_file: Some("/b".into()),
                fault: Some("model mismatch".into()),
                ..SessionUpdate::default()
            },
            2
        )
        .is_err()
    );
    tx.rollback().unwrap();
    assert_eq!(
        Reads(db)
            .lead_target(None)
            .unwrap()
            .row
            .unwrap()
            .session_id
            .as_deref(),
        Some("A")
    );
}

fn migrate_history(db: &Connection) {
    db.execute_batch(
        "DROP TABLE lead_anchor; DROP TABLE lead_bindings; DROP TABLE startup_episodes;",
    )
    .unwrap();
    db.execute_batch(include_str!("../migrations/0011_lead_anchor.sql"))
        .unwrap();
}

#[test]
fn migration_preserves_fresh_intent_behind_a_newer_failed_resume() {
    let mut db = database();
    attempt(&mut db, "a", "fresh", 1);
    bind(&mut db, "a", "A", 1);
    attempt(&mut db, "fresh-request", "fresh", 2);
    attempt(&mut db, "later-timeout", "resume", 3);
    migrate_history(&db);
    let selected = Reads(db).lead_target(None).unwrap();
    assert_eq!(selected.row.unwrap().session_id.as_deref(), Some("A"));
    assert_eq!(selected.intent, "fresh_failed");
}

#[test]
fn migration_orders_equal_timestamps_by_rowid_and_accepts_an_exact_pin() {
    let mut db = database();
    attempt(&mut db, "a", "fresh", 1);
    bind(&mut db, "a", "A", 1);
    attempt(&mut db, "b", "fresh", 1);
    bind(&mut db, "b", "B", 1);
    migrate_history(&db);
    let reads = Reads(db);
    let current = reads.lead_target(None).unwrap();
    assert!(current.hold.is_none());
    assert_eq!(current.row.unwrap().session_id.as_deref(), Some("B"));
    let pinned = reads.lead_target(Some("A")).unwrap();
    assert!(pinned.hold.is_none());
    assert_eq!(pinned.row.unwrap().session_id.as_deref(), Some("A"));
}

#[test]
fn migration_keeps_the_latest_of_successive_conversations() {
    let mut db = database();
    for (handle, id, mode, now) in [
        ("a1", "A", "fresh", 1),
        ("a2", "A", "resume", 2),
        ("b1", "B", "fresh", 3),
        ("b2", "B", "resume", 4),
    ] {
        attempt(&mut db, handle, mode, now);
        bind(&mut db, handle, id, now);
        db.execute(
            "UPDATE sessions SET expected_id = session_id, expected_file = session_file WHERE handle = ?1 AND mode = 'resume'",
            [handle],
        ).unwrap();
    }
    migrate_history(&db);
    let selected = Reads(db).lead_target(None).unwrap();
    assert!(selected.hold.is_none(), "{selected:?}");
    assert_eq!(selected.row.unwrap().handle, "b2");
}

#[test]
fn explicit_fresh_intent_lifts_a_migrated_unbound_hold() {
    let mut db = database();
    attempt(&mut db, "only-failed-resume", "resume", 1);
    migrate_history(&db);
    let mut reads = Reads(db);
    assert!(reads.lead_target(None).unwrap().hold.is_some());
    let tx = reads.0.transaction().unwrap();
    intent(&tx, Intent::Fresh).unwrap();
    tx.commit().unwrap();
    let selected = reads.lead_target(None).unwrap();
    assert!(selected.hold.is_none(), "{selected:?}");
    assert_eq!(selected.intent, "fresh");
    assert!(selected.row.is_none());
}

#[test]
fn explicit_fresh_binding_supersedes_only_older_unknown_attempt_holds() {
    let mut db = database();
    attempt(&mut db, "old", "fresh", 1);
    bind(&mut db, "old", "A", 1);
    attempt(&mut db, "unknown-old", "resume", 2);
    db.execute(
        "UPDATE sessions SET state = 'held' WHERE handle = 'unknown-old'",
        [],
    )
    .unwrap();
    let mut reads = Reads(db);
    assert!(reads.lead_target(None).unwrap().hold.is_some());
    attempt(&mut reads.0, "chosen-fresh", "fresh", 3);
    bind(&mut reads.0, "chosen-fresh", "B", 3);
    assert!(reads.lead_target(None).unwrap().hold.is_none());
    let retained: String = reads
        .0
        .query_row(
            "SELECT state FROM sessions WHERE handle = 'unknown-old'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        retained, "held",
        "the old uncertain ownership record remains"
    );
    attempt(&mut reads.0, "unknown-new", "resume", 4);
    reads
        .0
        .execute(
            "UPDATE sessions SET state = 'held' WHERE handle = 'unknown-new'",
            [],
        )
        .unwrap();
    assert!(reads.lead_target(None).unwrap().hold.is_some());
}
