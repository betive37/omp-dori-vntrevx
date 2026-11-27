//! Positive lead binding registry; attempts cannot select or replace an identity.

use rusqlite::{OptionalExtension, Transaction, params};

use super::{HostDone, Reads, SESSION_COLUMNS, SessionRow, SessionUpdate, session_from_row};

#[derive(Debug)]
pub(crate) struct Selection {
    pub(crate) row: Option<SessionRow>,
    pub(crate) ever_started: bool,
    pub(crate) ever_bound: bool,
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
    tx.execute(
        "UPDATE lead_anchor SET intent = ?1, hold = CASE WHEN ?1 = 'fresh' THEN NULL ELSE hold END WHERE singleton = 1",
        [match intent {
            Intent::Fresh => "fresh",
            Intent::Resume => "resume",
        }],
    )?;
    Ok(HostDone::Done)
}

pub(super) fn bound(
    tx: &Transaction<'_>,
    update: &SessionUpdate,
    now: i64,
) -> rusqlite::Result<HostDone> {
    let (Some(id), Some(file)) = (&update.session_id, &update.session_file) else {
        return Err(rusqlite::Error::InvalidQuery);
    };
    if update.fault.is_some() {
        return Err(rusqlite::Error::InvalidQuery);
    }
    let done = super::update(tx, update, now)?;
    tx.execute(
        "UPDATE sessions SET fault = NULL WHERE handle = ?1",
        [&update.handle],
    )?;
    let written = tx.execute(
        "INSERT INTO lead_bindings(handle, session_id, session_file, cwd, runtime, provenance, bound_ms) \
         SELECT handle, ?2, ?3, cwd, runtime, \
         CASE runtime WHEN 'headless' THEN 'two exact get_state identities and accepted model' \
         ELSE 'validated terminal bridge identity and accepted model' END, ?4 \
         FROM sessions s WHERE handle = ?1 AND role = 'lead' AND NOT EXISTS ( \
             SELECT 1 FROM lead_bindings b WHERE b.session_id = ?2 \
             AND (b.session_file <> ?3 OR b.cwd <> s.cwd OR b.runtime <> s.runtime))",
        params![update.handle, id, file, now])?;
    if written != 1 {
        return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
            std::io::Error::other("lead binding conflicts with previously proven identity"),
        )));
    }
    tx.execute("UPDATE lead_anchor SET handle = ?1, ever_started = 1, intent = 'resume', hold = NULL WHERE singleton = 1", [&update.handle])?;
    tx.execute(
        "UPDATE startup_episodes SET state = 'bound', next_ms = NULL WHERE target = 'lead'",
        [],
    )?;
    Ok(done)
}

impl Reads {
    /// The only resolver for current and pinned lead identity. Unbound attempts are never candidates.
    pub(crate) fn lead_target(&self, pin: Option<&str>) -> rusqlite::Result<Selection> {
        let (current, ever_started, intent, mut hold): (
            Option<String>,
            bool,
            String,
            Option<String>,
        ) = self.0.query_row(
            "SELECT handle, ever_started, intent, hold FROM lead_anchor WHERE singleton = 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
        let handle = match pin {
            None => current,
            Some(id) => {
                let distinct: i64 = self.0.query_row(
                    "SELECT COUNT(*) FROM (SELECT session_file, cwd, runtime FROM lead_bindings WHERE session_id = ?1 GROUP BY session_file, cwd, runtime)",
                    [id], |r| r.get(0))?;
                if distinct == 1 {
                    hold = None;
                    self.0.query_row("SELECT handle FROM lead_bindings WHERE session_id = ?1 ORDER BY bound_ms DESC, rowid DESC LIMIT 1", [id], |r| r.get(0)).optional()?
                } else {
                    hold = Some(format!(
                        "required lead session {id} has {distinct} verified identities; held, never substituted"
                    ));
                    None
                }
            }
        };
        let provenance = match &handle {
            Some(handle) => self
                .0
                .query_row(
                    "SELECT provenance FROM lead_bindings WHERE handle = ?1",
                    [handle],
                    |r| r.get(0),
                )
                .optional()?,
            None => None,
        };
        let row = match handle {
            None => None,
            Some(handle) => self
                .0
                .query_row(
                    &format!("SELECT {SESSION_COLUMNS} FROM sessions WHERE handle = ?1"),
                    [handle],
                    session_from_row,
                )
                .optional()?,
        };
        if self.0.query_row("SELECT EXISTS(SELECT 1 FROM sessions WHERE role = 'lead' AND session_id IS NULL AND state IN ('starting', 'held', 'orphan_held'))", [], |r| r.get::<_, bool>(0))? {
            hold = Some("an earlier unbound lead attempt has unknown process ownership; held until its exit is reconciled".into());
        }
        let ever_bound = self.0.query_row(
            "SELECT EXISTS(SELECT 1 FROM lead_bindings) OR EXISTS(SELECT 1 FROM sessions WHERE role = 'lead' AND session_id IS NOT NULL)",
            [], |r| r.get(0),
        )?;
        Ok(Selection {
            row,
            ever_started,
            intent,
            ever_bound,
            hold,
            provenance,
        })
    }

    /// Current/pinned bindings, any lane record and the episode containing an attempt retain it.
    pub(crate) fn startup_referenced(
        &self,
        handle: &str,
        session: Option<&str>,
        created_ms: i64,
    ) -> rusqlite::Result<bool> {
        self.0.query_row(
            "SELECT EXISTS(SELECT 1 FROM lead_bindings WHERE handle = ?1) \
             OR EXISTS(SELECT 1 FROM lanes WHERE json_extract(record, '$.handle') = ?1) \
             OR EXISTS(SELECT 1 FROM startup_episodes WHERE session_id = ?2 AND started_ms <= ?3)",
            params![handle, session, created_ms],
            |r| r.get(0),
        )
    }
}

#[cfg(test)]
#[path = "anchor_tests.rs"]
mod tests;
