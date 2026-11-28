use super::store_floor;
use crate::sys::fs::tests::scratch;
use rusqlite::Connection;
use std::time::Duration;

#[test]
fn preflight_reads_committed_wal_state_without_blocking_the_active_writer() {
    let dir = scratch("install-floor-writer");
    let path = dir.join("store.db");
    let mut writer = Connection::open(&path).unwrap();
    writer.busy_timeout(Duration::ZERO).unwrap();
    writer
        .execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA user_version=11; \
             CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); \
             INSERT INTO meta VALUES ('min_reader', '11');",
        )
        .unwrap();
    let tx = writer
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .unwrap();
    tx.execute("UPDATE meta SET value = '12' WHERE key = 'min_reader'", [])
        .unwrap();

    // A writer owns the WAL while preflight reads the last committed floor, not its dirty page.
    assert_eq!(store_floor(&path).unwrap(), Some(11));
    tx.commit().unwrap();
    assert_eq!(store_floor(&path).unwrap(), Some(12));
    writer
        .execute("UPDATE meta SET value = '13' WHERE key = 'min_reader'", [])
        .unwrap();
    assert_eq!(store_floor(&path).unwrap(), Some(13));
}

#[test]
fn an_exclusively_locked_floor_refuses_promptly_instead_of_waiting_for_the_writer() {
    let dir = scratch("install-floor-locked");
    let path = dir.join("store.db");
    let writer = Connection::open(&path).unwrap();
    writer
        .execute_batch("PRAGMA user_version=11; BEGIN EXCLUSIVE;")
        .unwrap();
    std::thread::scope(|scope| {
        let (send, receive) = std::sync::mpsc::channel();
        let path = &path;
        let reader = scope.spawn(move || send.send(store_floor(path)).unwrap());
        let result = receive.recv_timeout(Duration::from_secs(2));
        // Always release the fixture lock before joining, including the broken long-wait case.
        writer.execute_batch("ROLLBACK;").unwrap();
        reader.join().unwrap();
        assert!(
            result.is_ok_and(|value| value.is_err_and(|error| error.contains("locked"))),
            "preflight must refuse while the exclusive writer still owns the store"
        );
    });
}
