//! The only worktree removal boundary. Durable authority is necessary, never sufficient.

use std::path::Path;
use std::time::Duration;

use super::record::{Intent, Record, State};
use super::startup::Ownership;
use super::supervisor::StartError;
use super::{Lanes, git};
use crate::host::Runtime;
use crate::store::lanes::{LaneDone, LaneWrite, Revision};

impl<R: Runtime> Lanes<R> {
    /// A failed attempt cannot revoke an established run's identity or resources.
    pub(super) async fn start_failed(
        &self,
        mut rec: Record,
        mut rev: Revision,
        ownership: &Ownership,
        failure: StartError,
    ) -> String {
        if self
            .session(&rec.key)
            .is_none_or(|s| !crate::host::Control::alive(&*s))
        {
            self.drop_session(&rec.key);
        }
        let why = failure.detail;
        match ownership {
            Ownership::ResumeExisting((id, file)) => {
                rec.session_id = Some(id.clone());
                rec.session_file = Some(file.display().to_string());
            }
            Ownership::FreshAttempt => {
                // A bound attempt may already have background writers. It is not unused.
                if rec.session_id.is_none() && failure.cleanup.confirmed() {
                    rec.intent = Some(Intent {
                        outcome: "fresh-rollback".into(),
                        note: why.clone(),
                        condition: None,
                        checks: Vec::new(),
                        step: "rollback".into(),
                        receipt: Vec::new(),
                        lesson: None,
                        quiescence: failure.cleanup,
                    });
                    match self
                        .save(&rec, Some(rev), Some(format!("fresh rollback: {why}")))
                        .await
                    {
                        Ok(saved) => {
                            rev = saved;
                            let mut removed = true;
                            for path in &rec.worktrees {
                                match self.remove_worktree(&rec, path).await {
                                    Ok(()) => {
                                        rec.receipt.push(format!("worktree {path} removed"));
                                    }
                                    Err(detail) => {
                                        removed = false;
                                        rec.receipt.push(format!("worktree {path} kept: {detail}"));
                                    }
                                }
                            }
                            if removed {
                                match self
                                    .env
                                    .store
                                    .lanes(LaneWrite::Delete {
                                        key: rec.key.clone(),
                                        expect: rev,
                                    })
                                    .await
                                {
                                    Ok(LaneDone::Done) => {
                                        return format!(
                                            "failed: {why}; unused allocation rolled back"
                                        );
                                    }
                                    Ok(answer) => {
                                        rec.receipt.push(format!("record retained: {answer:?}"));
                                    }
                                    Err(error) => {
                                        rec.receipt.push(format!("record retained: {error}"));
                                    }
                                }
                            }
                        }
                        Err(error) => rec
                            .receipt
                            .push(format!("rollback authority not saved: {error}")),
                    }
                    rec.intent = None;
                }
            }
        }
        if rec.state != State::Held {
            rec.prev = Some(rec.state);
            rec.held_by = Some("hub".into());
        }
        rec.state = State::Held;
        rec.hold_reason.get_or_insert_with(|| why.clone());
        rec.lost = Some(why.clone());
        rec.start_note = Some("start failed; work retained".into());
        rec.receipt
            .push(format!("startup cleanup: {:?}", failure.cleanup));
        let detail = format!(
            "{why}; conversation and work retained; correct the cause then reopen the lane"
        );
        if let Err(error) = self.save(&rec, Some(rev), Some(detail.clone())).await {
            self.alert(
                &rec.key,
                "failed start record not saved",
                &format!("{detail}; {error}"),
                true,
            );
        } else {
            self.alert(&rec.key, "start held", &detail, true);
        }
        format!("failed: {detail}")
    }

    /// Re-read authority and preservation immediately before non-forced Git removal, locally
    /// or on the worker. Every unknown is a keep, including ignored files and stale ownership.
    pub(super) async fn remove_worktree(&self, rec: &Record, path: &str) -> Result<(), String> {
        let (saved, _) = self.load(&rec.key).await?;
        if saved.run_id != rec.run_id || !saved.worktrees.iter().any(|p| p == path) {
            return Err("worktree ownership changed".into());
        }
        let intent = saved
            .intent
            .as_ref()
            .ok_or("no durable removal authority")?;
        match intent.outcome.as_str() {
            "completed" => {}
            "fresh-rollback" if saved.session_id.is_none() => {}
            _ => return Err("the intent does not authorize removal".into()),
        }
        if !intent.quiescence.confirmed() {
            return Err(
                "writer exit is unconfirmed (worker removal requires a reap acknowledgement)"
                    .into(),
            );
        }
        if self
            .session(&rec.key)
            .is_some_and(|s| crate::host::Control::alive(&*s))
        {
            return Err("a lane writer is still live".into());
        }
        if saved.doubt.is_some() || self.undelivered(&rec.key).await > 0 {
            return Err("input is pending or uncertain".into());
        }
        if self.holds_published(path).await {
            return Err("it holds a published file".into());
        }
        if let Some(id) = &saved.session_id
            && self.lease_free(saved.worker.as_deref(), id).await != Some(true)
        {
            return Err("session lease is held or unknown".into());
        }
        let place = saved.place();
        let dir = Path::new(path);
        let limit = Duration::from_secs(60);
        let (ok, status) = git::git(
            &place,
            dir,
            &[
                "status",
                "--porcelain",
                "--untracked-files=all",
                "--ignored",
            ],
            limit,
        )
        .await?;
        if !ok || !status.is_empty() {
            return Err(
                "tracked, untracked or ignored content exists, or status is unreadable".into(),
            );
        }
        let (ok, commits) = git::git(
            &place,
            dir,
            &["rev-list", "--count", "HEAD", "--not", "--remotes"],
            limit,
        )
        .await?;
        if !ok || commits.trim() != "0" {
            return Err("unpushed commits exist or commit preservation is unknown".into());
        }
        let (ok, _) = git::git(&place, dir, &["worktree", "remove", path], limit).await?;
        if ok {
            Ok(())
        } else {
            Err("git worktree remove refused; retained".into())
        }
    }
}

/// Restore only the hub's failed-start hold; an owner's paused goal remains paused.
pub(super) fn prepare_restart(rec: &mut Record) -> bool {
    if rec.start_note.as_deref() == Some("start failed; work retained") {
        if rec.held_by.as_deref() == Some("hub") {
            rec.state = rec.prev.unwrap_or(rec.state);
            rec.prev = None;
            rec.held_by = None;
            rec.hold_reason = None;
        }
        rec.start_note = None;
    }
    rec.lost = None;
    matches!(rec.state, State::Running | State::Rejected | State::Claimed)
}
