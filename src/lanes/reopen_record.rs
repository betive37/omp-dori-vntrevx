//! The new run and the reopen checkpoint are committed atomically.

use super::{Lanes, Step};
use crate::host::Runtime;
use crate::lanes::record::{Record, State, Watch};
use crate::store::lanes::{LaneDone, LaneWrite, Revision};
use crate::sys::now_ms;

impl<R: Runtime> Lanes<R> {
    pub(super) async fn commit_reopen(
        &self,
        rec: &mut Record,
        rev: Revision,
    ) -> Result<Revision, String> {
        let pending = rec
            .pending_reopen
            .as_mut()
            .ok_or("no pending reopen intent")?;
        let Step::Starting { run_id } = std::mem::replace(&mut pending.step, Step::RunCommitted)
        else {
            return Err("the reopened run is already committed".into());
        };
        let now = now_ms();
        new_run(rec, now, run_id);
        let write = LaneWrite::Save {
            key: rec.key.clone(),
            state: rec.state.name().into(),
            outcome: None,
            thread: rec.thread.clone(),
            opened_ms: now,
            closed_ms: None,
            record: serde_json::to_string(rec).map_err(|e| e.to_string())?,
            expect: Some(rev),
            note: Some(format!("reopened with run {}", rec.run_id)),
            reopen: true,
        };
        match self
            .env
            .store
            .lanes(write)
            .await
            .map_err(|e| e.to_string())?
        {
            LaneDone::Saved(rev) => Ok(rev),
            LaneDone::Refused(why) => Err(why),
            other => Err(format!("unexpected store answer {other:?}")),
        }
    }
}

fn new_run(rec: &mut Record, now: i64, run_id: String) {
    rec.opened_ms = now;
    rec.closed_ms = None;
    rec.run_id = run_id;
    rec.claim = None;
    rec.objection.clear();
    rec.receipt.clear();
    rec.intent = None;
    rec.outcome = None;
    rec.lost = None;
    rec.doubt = None;
    rec.spend = None;
    rec.start_note = None;
    rec.prev = Some(State::Running);
    rec.state = State::Held;
    rec.held_by = Some("reopen".into());
    rec.watch = Watch {
        round_ms: now,
        active_ms: now,
        ..Watch::default()
    };
}
