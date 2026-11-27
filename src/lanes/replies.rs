//! A lifecycle request owns only its first answer; the lane actor owns continuing recovery.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::oneshot;

use super::{Lanes, Posted};
use crate::host::Runtime;
use crate::jobs::event::{Emit, EventKind, Severity};
use crate::store::host::episode::Episode;

#[derive(Default)]
pub(super) struct Reply {
    first: Option<oneshot::Sender<String>>,
    continuing: bool,
}

impl Reply {
    pub(super) fn pending(&self) -> bool {
        self.first.is_some()
    }

    fn send(&mut self, text: String) -> bool {
        self.first
            .take()
            .is_some_and(|first| first.send(text).is_ok())
    }

    pub(super) fn recovering(
        &mut self,
        key: &str,
        episode: &Episode,
        delay: Duration,
    ) -> Result<(), String> {
        let deadline =
            jiff::Timestamp::from_millisecond(episode.deadline_ms).map_err(|e| e.to_string())?;
        let text = format!(
            "recovering: retry attempt {} of ≤5, next retry in {} s, episode ends by {deadline}; the work and worktree are kept. Watch cataly lane status {key} and the lane's thread",
            episode.retries,
            delay.as_millis().div_ceil(1000)
        );
        self.continuing = true;
        self.send(text);
        Ok(())
    }
}

impl<R: Runtime> Lanes<R> {
    pub(super) async fn reopen(
        self: &Arc<Self>,
        key: &str,
        note: Option<&str>,
    ) -> Result<String, String> {
        let (first, answer) = oneshot::channel();
        let mut reply = Reply {
            first: Some(first),
            continuing: false,
        };
        let lanes = Arc::clone(self);
        let key = key.to_string();
        let note = note.map(str::to_string);
        tokio::spawn(async move {
            let result = lanes.reopen_task(&key, note.as_deref(), &mut reply).await;
            let (resumed, text) = match result {
                Ok(text) => (true, text),
                Err(why) => {
                    lanes.reopen_refused(&key, &why).await;
                    (
                        false,
                        format!("held: {why}; the work and worktree are kept"),
                    )
                }
            };
            if reply.continuing {
                lanes.reopen_finished(&key, &text, resumed).await;
            } else {
                reply.send(text);
            }
        });
        answer
            .await
            .map_err(|_| "the lifecycle request ended without an answer; work is retained".into())
    }

    async fn reopen_refused(&self, key: &str, why: &str) {
        let Ok((mut rec, rev)) = self.load(key).await else {
            return;
        };
        if self.session(key).is_some()
            || rec.start_note.as_deref() == Some("start failed; work retained")
        {
            return;
        }
        super::cleanup::hold_failed(&mut rec, why);
        self.announce_hold(&rec, rev, why).await;
    }

    async fn reopen_finished(&self, key: &str, text: &str, resumed: bool) {
        // Terminal failure already emits the owner-facing start-held event at the failure owner.
        if resumed {
            self.emit(
                Emit::new(EventKind::LaneRecap, Severity::Info, true, key)
                    .for_owner()
                    .with("lane", key)
                    .with("detail", text),
            );
        }
        let rec = match self.load(key).await {
            Ok((rec, _)) => rec,
            Err(why) => {
                self.alert(
                    key,
                    "recovery result thread unavailable",
                    &format!("{text}; {why}"),
                    true,
                );
                return;
            }
        };
        let Some(thread) = rec
            .thread
            .as_deref()
            .and_then(|thread| thread.strip_prefix("discord:"))
        else {
            return;
        };
        let seed = format!(
            "lane-recovery:{key}:{}:{}",
            rec.run_id,
            crate::sys::now_ms()
        );
        match self.env.threads.post(thread, text, &seed).await {
            Posted::Confirmed => {}
            Posted::Rejected(why) | Posted::Uncertain(why) => {
                self.alert(key, "recovery result not posted", &why, true);
            }
        }
    }
}
