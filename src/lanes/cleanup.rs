//! Failed-start ownership: retain established runs and roll back only unused fresh allocations.

use super::Lanes;
use super::record::{Intent, Record, State};
use super::startup::Ownership;
use super::supervisor;
use crate::host::{Runtime, StartError};
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
        let why = failure.to_string();
        let cleanup = supervisor::cleanup(&failure);
        if self
            .starts
            .stopping
            .load(std::sync::atomic::Ordering::Acquire)
            && matches!(ownership, Ownership::ResumeExisting(_))
        {
            if let Err(error) = self
                .save(
                    &rec,
                    Some(rev),
                    Some("startup interrupted by hub shutdown; recovery retained".into()),
                )
                .await
            {
                crate::log::warn(
                    "lane shutdown recovery not saved",
                    &[("lane", &rec.key), ("error", &error)],
                );
            }
            return "interrupted by hub shutdown; recovery and work retained".into();
        }
        match ownership {
            Ownership::ResumeExisting((id, file)) => {
                rec.session_id = Some(id.clone());
                rec.session_file = Some(file.display().to_string());
                let target = format!("lane:{}", rec.key);
                if let Err(error) = self
                    .hold_episode(
                        &crate::host::startup::Recovery {
                            store: &self.env.store,
                            target: &target,
                        },
                        &why,
                    )
                    .await
                {
                    rec.receipt
                        .push(format!("recovery hold not recorded: {error}"));
                }
            }
            Ownership::FreshAttempt => {
                rec.startup_cleanup = Some(cleanup);
                // A bound attempt may already have background writers. It is not unused.
                if rec.session_id.is_none() && cleanup.confirmed() {
                    rec.intent = Some(Intent {
                        outcome: "fresh-rollback".into(),
                        note: why.clone(),
                        condition: None,
                        checks: Vec::new(),
                        step: "rollback".into(),
                        receipt: Vec::new(),
                        lesson: None,
                        quiescence: cleanup,
                    });
                    match self
                        .save(&rec, Some(rev), Some(format!("fresh rollback: {why}")))
                        .await
                    {
                        Ok(saved) => {
                            rev = saved;
                            if self.rollback_allocation(&mut rec, rev).await {
                                return format!("failed: {why}; unused allocation rolled back");
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
        hold_failed(&mut rec, &why);
        rec.receipt.push(format!("startup cleanup: {cleanup:?}"));
        let detail = format!(
            "{why}; conversation and work retained; correct the cause then reopen the lane"
        );
        self.announce_hold(&rec, rev, &detail).await;
        format!("failed: {detail}")
    }

    /// The fresh rollback deletes its record only when every owned worktree was removed.
    async fn rollback_allocation(&self, rec: &mut Record, rev: Revision) -> bool {
        let mut removed = true;
        for path in &rec.worktrees {
            match self.remove_worktree(rec, path).await {
                Ok(()) => rec.receipt.push(format!("worktree {path} removed")),
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
                Ok(LaneDone::Done) => return true,
                Ok(answer) => rec.receipt.push(format!("record retained: {answer:?}")),
                Err(error) => rec.receipt.push(format!("record retained: {error}")),
            }
        }
        false
    }

    pub(super) async fn announce_hold(&self, rec: &Record, rev: Revision, detail: &str) {
        if let Err(error) = self.save(rec, Some(rev), Some(detail.to_string())).await {
            self.alert(
                &rec.key,
                "failed start record not saved",
                &format!("{detail}; {error}"),
                true,
            );
        } else {
            self.alert(&rec.key, "start held", detail, true);
        }
    }
}

pub(super) fn hold_failed(rec: &mut Record, why: &str) {
    if rec.state != State::Held {
        rec.prev = Some(rec.state);
        rec.held_by = Some("hub".into());
    }
    rec.state = State::Held;
    rec.hold_reason.get_or_insert_with(|| why.to_string());
    rec.lost = Some(why.to_string());
    rec.start_note = Some("start failed; work retained".into());
}
