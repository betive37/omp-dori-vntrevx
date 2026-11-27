//! Recovery episodes are independent of the attempt log and never roll their deadline forward.

use rusqlite::{OptionalExtension, Transaction, params};
use serde::Serialize;

use super::{HostDone, Reads};
use crate::host::startup::{EPISODE_BUDGET, RETRY_DELAYS, STARTUP_BUDGET, STARTUP_CLEANUP_BUDGET};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct Episode {
    pub(crate) target: String,
    pub(crate) session_id: String,
    pub(crate) started_ms: i64,
    pub(crate) deadline_ms: i64,
    pub(crate) retries: u32,
    pub(crate) next_ms: Option<i64>,
    pub(crate) state: String,
    pub(crate) detail: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) enum Change {
    Begin { target: String, session_id: String, reset: bool },
    Retry { target: String, detail: String },
    End { target: String, state: String, detail: Option<String> },
}

fn millis(duration: std::time::Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

pub(super) fn write(tx: &Transaction<'_>, change: &Change, now: i64) -> rusqlite::Result<HostDone> {
    let target = match change {
        Change::Begin { target, session_id, reset } => {
            tx.execute(
                "INSERT INTO startup_episodes(target, session_id, started_ms, deadline_ms, state) VALUES (?1, ?2, ?3, ?4, 'active') \
                 ON CONFLICT(target) DO UPDATE SET session_id = excluded.session_id, started_ms = excluded.started_ms, deadline_ms = excluded.deadline_ms, \
                 state = 'active', retries = 0, next_ms = NULL, detail = NULL WHERE ?5 OR startup_episodes.state = 'bound'",
                params![target, session_id, now, now.saturating_add(millis(EPISODE_BUDGET)), reset])?;
            target
        }
        Change::Retry { target, detail } => {
            let count: u32 = tx.query_row("SELECT retries FROM startup_episodes WHERE target = ?1", [target], |r| r.get(0))?;
            let delay = RETRY_DELAYS.get(usize::try_from(count).unwrap_or(usize::MAX)).copied();
            let next = delay.map(|d| now.saturating_add(millis(d)));
            let reserve = millis(STARTUP_BUDGET + STARTUP_CLEANUP_BUDGET);
            tx.execute(
                "UPDATE startup_episodes SET retries = CASE WHEN ?2 IS NOT NULL AND ?2 + ?3 <= deadline_ms AND state = 'active' THEN retries + 1 ELSE retries END, \
                 next_ms = CASE WHEN ?2 IS NOT NULL AND ?2 + ?3 <= deadline_ms AND state = 'active' THEN ?2 ELSE NULL END, \
                 state = CASE WHEN ?2 IS NOT NULL AND ?2 + ?3 <= deadline_ms AND state = 'active' THEN 'active' ELSE 'held' END, detail = ?4 WHERE target = ?1",
                params![target, next, reserve, detail])?;
            target
        }
        Change::End { target, state, detail } => {
            tx.execute("UPDATE startup_episodes SET state = ?2, next_ms = NULL, detail = ?3 WHERE target = ?1", params![target, state, detail])?;
            target
        }
    };
    tx.execute("UPDATE startup_episodes SET state = 'held', next_ms = NULL, detail = '300 s recovery episode exhausted' WHERE target = ?1 AND state = 'active' AND deadline_ms <= ?2", params![target, now])?;
    Ok(HostDone::Done)
}

impl Reads {
    pub(crate) fn startup_episode(&self, target: &str) -> rusqlite::Result<Option<Episode>> {
        self.0.query_row(
            "SELECT target, session_id, started_ms, deadline_ms, retries, next_ms, state, detail FROM startup_episodes WHERE target = ?1",
            [target], |r| Ok(Episode { target: r.get(0)?, session_id: r.get(1)?, started_ms: r.get(2)?, deadline_ms: r.get(3)?, retries: r.get(4)?, next_ms: r.get(5)?, state: r.get(6)?, detail: r.get(7)? })).optional()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn apply(db: &mut Connection, change: Change, now: i64) {
        let tx = db.transaction().unwrap();
        write(&tx, &change, now).unwrap();
        tx.commit().unwrap();
    }

    fn database() -> Connection {
        let mut db = Connection::open_in_memory().unwrap();
        crate::store::schema::migrate(&mut db, std::path::Path::new("/unused")).unwrap();
        db
    }

    fn begin(reset: bool) -> Change {
        Change::Begin { target: "lead".into(), session_id: "A".into(), reset }
    }

    #[test]
    fn retries_and_deadline_survive_reopening_the_episode() {
        let mut db = database();
        apply(&mut db, begin(false), 100);
        for (index, delay) in [1000, 2000, 4000, 8000, 16000].into_iter().enumerate() {
            let now = 200 + i64::try_from(index).unwrap();
            apply(&mut db, Change::Retry { target: "lead".into(), detail: "timeout, reaped".into() }, now);
            apply(&mut db, begin(false), now + 1);
            let (next, deadline): (i64, i64) = db.query_row("SELECT next_ms, deadline_ms FROM startup_episodes", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
            assert_eq!(next, now + delay);
            assert_eq!(deadline, 300_100);
        }
        apply(&mut db, Change::Retry { target: "lead".into(), detail: "sixth retry".into() }, 210);
        let episode = Reads(db).startup_episode("lead").unwrap().unwrap();
        assert_eq!(episode.retries, 5);
        assert_eq!(episode.state, "held");
        assert_eq!(episode.next_ms, None);
    }

    #[test]
    fn episode_reserves_cleanup_and_never_rolls_its_cap_forward() {
        let mut db = database();
        apply(&mut db, begin(false), 0);
        apply(&mut db, Change::Retry { target: "lead".into(), detail: "late timeout".into() }, 213_000);
        apply(&mut db, begin(false), 900_000);
        let reads = Reads(db);
        let episode = reads.startup_episode("lead").unwrap().unwrap();
        assert_eq!(episode.deadline_ms, 300_000);
        assert_eq!(episode.state, "held");
        assert_eq!(episode.next_ms, None);
    }
}
