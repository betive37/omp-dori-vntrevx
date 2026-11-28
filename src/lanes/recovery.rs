//! Durable recovery decisions, including the pre-supervisor lane-record upgrade boundary.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use super::Lanes;
use super::life::goal_to;
use super::record::{Record, State};
use crate::host::dialogs::GoalStatus;
use crate::host::lead::ownership;
use crate::host::startup::{Cleanup, Recovery};
use crate::host::{Control, Runtime};
use crate::jobs::event::{Emit, EventKind, Severity};
use crate::log;

impl<R: Runtime> Lanes<R> {
    pub(super) async fn admit_restart(
        &self,
        config: &crate::config::Config,
        rec: &Record,
    ) -> Result<PathBuf, String> {
        let exe = self
            .admission(
                config,
                std::path::Path::new(&rec.cwd),
                rec.worker.as_deref(),
            )
            .await?;
        self.tern_spend(config, rec).await?;
        Ok(exe)
    }

    /// `None` is the legacy no-journal case: the caller must still prove a free lease.
    pub(super) async fn previous_exit(&self, rec: &Record) -> Result<Option<Cleanup>, String> {
        if let Some(cleanup) = rec.startup_cleanup.filter(|cleanup| cleanup.confirmed()) {
            return Ok(Some(cleanup));
        }
        let Some(handle) = &rec.handle else {
            return Ok(Some(Cleanup::Unknown));
        };
        // 0.2.6 had no journal or cleanup field. HOST-20 closed its processes on shutdown;
        // retain its lease-based recovery only at that precise on-disk migration boundary.
        if rec.startup_cleanup.is_none() && !ownership::recorded(&self.env.state_dir, handle)? {
            return Ok(None);
        }
        ownership::reconcile_attempt(&self.env.state_dir, handle, rec.worker.as_deref())
            .await
            .map(Some)
    }

    pub(super) async fn hold_episode(
        &self,
        recovery: &Recovery<'_>,
        why: &str,
    ) -> Result<(), String> {
        if !self.starts.stopping.load(Ordering::Acquire)
            && recovery
                .read()
                .await?
                .is_some_and(|episode| episode.state == "active")
        {
            recovery.end("held", Some(why.to_string())).await?;
        }
        Ok(())
    }

    pub(super) async fn recovery_hold(&self, rec: &Record) -> Result<Option<String>, String> {
        if rec.state == State::Held
            && (rec.pending_reopen.is_none()
                || rec.start_note.as_deref() == Some("start held: model"))
        {
            return Ok(Some(
                rec.lost
                    .as_ref()
                    .or(rec.hold_reason.as_ref())
                    .cloned()
                    .unwrap_or_else(|| "startup held for inspection".into()),
            ));
        }
        let target = format!("lane:{}", rec.key);
        let episode = Recovery {
            store: &self.env.store,
            target: &target,
        }
        .read()
        .await?;
        if let Some(pending) = &rec.pending_reopen
            && episode
                .as_ref()
                .is_none_or(|episode| episode.started_ms != pending.episode_ms)
        {
            return Err("pending reopen belongs to a different or missing recovery episode".into());
        }
        Ok(episode
            .filter(|episode| episode.state == "held")
            .map(|episode| {
                episode
                    .detail
                    .unwrap_or_else(|| "explicit owner retry required".into())
            }))
    }

    pub(super) async fn prune_attempts(&self) {
        if let Err(error) = ownership::prune(&self.env.state_dir, &self.env.store).await {
            crate::log::warn("lane attempt records retained", &[("error", &error)]);
        }
    }

    /// Hub start (LANE req. 70; decision 9): finish recorded intents, bring every lane that was
    /// running back on its exact file once the lease is free, resume goals that were active, leave
    /// held lanes held, then give the lead one recap.
    pub(crate) async fn recover(self: &Arc<Self>) {
        let rows = match self.env.store.read(|r| r.lanes(true)).await {
            Ok(rows) => rows,
            Err(e) => {
                log::warn("lane recovery skipped", &[("error", &e)]);
                return;
            }
        };
        let mut lines = Vec::new();
        for row in rows {
            let line = self.recover_one(&row.key).await;
            lines.push(format!("{}: {line}", row.key));
        }
        if !lines.is_empty() {
            self.emit(
                Emit::new(EventKind::LaneRecap, Severity::Info, true, "lanes")
                    .for_owner()
                    .with("detail", lines.join("; ")),
            );
        }
        let mut resumed: Vec<String> = self
            .live_map()
            .iter()
            .filter(|(_, s)| s.alive())
            .map(|(key, _)| key.clone())
            .collect();
        resumed.sort();
        let _ = self.resumed.set(resumed);
        self.nudge.notify_one();
        self.prune_attempts().await;
    }

    pub(super) async fn recover_one(self: &Arc<Self>, key: &str) -> String {
        let Ok(_turn) = self.turn(key).await else {
            return "busy".into();
        };
        let Ok((mut rec, rev)) = self.load(key).await else {
            return "record unreadable".into();
        };
        if rec.intent.is_some() {
            return match self.finish_close(rec, rev).await {
                Ok(done) => format!("{done} (finished the recorded close)"),
                Err(e) => format!("close held: {e}"),
            };
        }
        match self.recovery_hold(&rec).await {
            Ok(Some(reason)) => return format!("held: {reason}; work retained"),
            Ok(None) => {}
            Err(reason) => return format!("held: recovery state unreadable: {reason}"),
        }
        let (Some(id), Some(file)) = (rec.session_id.clone(), rec.session_file.clone()) else {
            if rec.state == State::Starting {
                let _ = self.unconfirmed(&mut rec, rev,
                    "the hub stopped during startup; writer ownership is unknown; work retained").await;
                return "start interrupted; held for inspection; work retained".into();
            }
            return "no session to restart".into();
        };
        if rec.state == State::Starting {
            let _ = self
                .unconfirmed(&mut rec, rev, "the hub stopped during the start")
                .await;
            return "start unconfirmed; held for inspection".into();
        }
        let config = self.cfg();
        let exe = match self.admit_restart(&config, &rec).await {
            Ok(exe) => exe,
            Err(e) => {
                rec.lost = Some(format!("not restarted: {e}"));
                let _ = self.save(&rec, Some(rev), Some(format!("lost: {e}"))).await;
                return format!("lost: {e}");
            }
        };
        rec.lost = None;
        let was_active = matches!(rec.state, State::Running | State::Rejected | State::Claimed);
        let reopening = rec.pending_reopen.is_some();
        if reopening {
            rec.prev = Some(State::Running);
            rec.state = State::Held;
        }
        let rev = match self.save(&rec, Some(rev), None).await {
            Ok(r) => r,
            Err(e) => return format!("not restarted: {e}"),
        };
        let outcome = self
            .start(
                rec,
                rev,
                exe,
                &config,
                super::startup::Ownership::ResumeExisting((id.clone(), PathBuf::from(&file))),
                &mut super::replies::Reply::default(),
            )
            .await;
        if outcome != "started" {
            return format!("not restarted: {outcome}");
        }
        let Some(session) = self.session(key) else {
            return format!("not restarted: {outcome}");
        };
        if session.snapshot().session_id.as_deref() != Some(id.as_str()) {
            return "restarted on another session; held for inspection".into();
        }
        if reopening {
            return match self.finish_reopen(key).await {
                Ok(done) => done,
                Err(why) => {
                    self.reopen_failed_locked(key, &why).await;
                    format!("held: {why}; reopen intent and work retained")
                }
            };
        }
        if !was_active {
            return "restarted; stays held (goal paused)".into();
        }
        match goal_to(
            &*session,
            "resume",
            &[GoalStatus::Active, GoalStatus::Complete],
        )
        .await
        {
            Ok(g) => format!("restarted; goal {g:?}").to_lowercase(),
            Err(e) => {
                self.keep(key, |r| r.lost = Some(format!("goal not resumed: {e}")))
                    .await;
                format!("restarted; goal not resumed: {e}")
            }
        }
    }

    /// Hub shutdown: lanes are closed with end of input so their files stay theirs; the next hub
    /// brings them back (decision 9). Records keep their state.
    pub(crate) async fn shutdown(&self) {
        self.starts.cancel_all().await;
        let sessions: Vec<(String, Arc<R::Session>)> = self.live_map().drain().collect();
        let closes = sessions.iter().map(|(key, s)| async move {
            let stopped = super::supervisor::stop(&**s).await;
            self.keep(key, |rec| rec.startup_cleanup = Some(stopped.cleanup))
                .await;
        });
        futures_util::future::join_all(closes).await;
    }
}
