//! Shared startup limits and evidence. A retry is permitted only after a timeout and proven exit.

use std::time::Duration;

use serde::{Deserialize, Serialize};

pub(crate) use crate::store::host::episode::Begin;

pub(crate) const STARTUP_BUDGET: Duration = Duration::from_secs(60);
pub(crate) const STARTUP_NOTICE: Duration = Duration::from_secs(15);
// Includes bounded stdin shutdown, input grace, TERM, KILL/reap, and stderr drainage.
pub(crate) const STARTUP_CLEANUP_BUDGET: Duration = Duration::from_secs(30);
pub(crate) const EPISODE_BUDGET: Duration = Duration::from_secs(300);
pub(crate) const RETRY_DELAYS: [Duration; 5] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
    Duration::from_secs(8),
    Duration::from_secs(16),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StartupStage {
    Prepare,
    Spawn,
    Ready,
    Protocol,
    Binding,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StartupOutcome {
    Timeout,
    Rejected,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Cleanup {
    NotSpawned,
    LocalReaped,
    WorkerReaped,
    #[default]
    Unknown,
}

impl Cleanup {
    pub(crate) const fn confirmed(self) -> bool {
        match self {
            Self::NotSpawned | Self::LocalReaped | Self::WorkerReaped => true,
            Self::Unknown => false,
        }
    }
}

/// Persisted episode operations shared by lead and lane supervision. Callers still own lease
/// checking and cancellation; neither an episode nor a timeout authorizes changing identity.
pub(crate) struct Recovery<'a> {
    pub(crate) store: &'a crate::store::Store,
    pub(crate) target: &'a str,
}

impl Recovery<'_> {
    /// Waits out a persisted backoff without losing cancellation or the absolute episode cap. An
    /// automatic start: it continues the live episode, else begins a fresh one (see `Begin::Renew`).
    pub(crate) async fn admit(
        &self,
        session_id: &str,
        mut cancel: tokio::sync::watch::Receiver<bool>,
    ) -> Result<(), String> {
        let episode = self.begin(session_id, Begin::Renew).await?;
        if let Some(next) = episode.next_ms {
            let wait = Duration::from_millis(
                u64::try_from(next.saturating_sub(crate::sys::now_ms())).unwrap_or(0),
            );
            tokio::select! {
                biased;
                () = cancelled(&mut cancel) => return Err("startup retry cancelled".into()),
                () = tokio::time::sleep(wait) => {},
            }
            self.begin(session_id, Begin::Continue).await?;
        }
        Ok(())
    }

    pub(crate) async fn begin(
        &self,
        session_id: &str,
        mode: Begin,
    ) -> Result<crate::store::host::episode::Episode, String> {
        self.change(crate::store::host::episode::Change::Begin {
            target: self.target.into(),
            session_id: session_id.into(),
            mode,
        })
        .await?;
        let episode = self
            .read()
            .await?
            .ok_or("recovery episode was not recorded")?;
        if episode.session_id != session_id || episode.state != "active" {
            // The first cause stays visible after a hub restart or an update finds the hold.
            let cause = episode
                .detail
                .as_deref()
                .map_or_else(String::new, |d| format!(" ({d})"));
            return Err(format!(
                "recovery is {}{cause}; explicit owner retry required",
                episode.state
            ));
        }
        let reserve = i64::try_from((STARTUP_BUDGET + STARTUP_CLEANUP_BUDGET).as_millis())
            .unwrap_or(i64::MAX);
        if crate::sys::now_ms().saturating_add(reserve) > episode.deadline_ms {
            self.end(
                "held",
                Some("300 s recovery episode has no startup and cleanup budget remaining".into()),
            )
            .await?;
            return Err("300 s recovery episode exhausted; conversation retained".into());
        }
        Ok(episode)
    }

    pub(crate) async fn retry(
        &self,
        error: &crate::host::StartError,
    ) -> Result<Option<Duration>, String> {
        if !error.retryable() {
            self.end("held", Some(error.to_string())).await?;
            return Ok(None);
        }
        self.change(crate::store::host::episode::Change::Retry {
            target: self.target.into(),
            detail: error.to_string(),
        })
        .await?;
        Ok(self
            .read()
            .await?
            .and_then(|episode| episode.next_ms)
            .map(|next| {
                Duration::from_millis(
                    u64::try_from(next.saturating_sub(crate::sys::now_ms())).unwrap_or(0),
                )
            }))
    }

    pub(crate) async fn read(
        &self,
    ) -> Result<Option<crate::store::host::episode::Episode>, String> {
        let target = self.target.to_string();
        self.store
            .read(move |reads| reads.startup_episode(&target))
            .await
            .map_err(|e| e.to_string())
    }

    pub(crate) async fn end(&self, state: &str, detail: Option<String>) -> Result<(), String> {
        self.change(crate::store::host::episode::Change::End {
            target: self.target.into(),
            state: state.into(),
            detail,
        })
        .await
    }

    async fn change(&self, change: crate::store::host::episode::Change) -> Result<(), String> {
        self.store
            .host(crate::store::host::HostWrite::Episode(change))
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

pub(crate) async fn cancelled(cancel: &mut tokio::sync::watch::Receiver<bool>) {
    loop {
        if *cancel.borrow_and_update() {
            return;
        }
        if cancel.changed().await.is_err() {
            return;
        }
    }
}

/// Reports prolonged startup once without dropping the owned startup/cleanup future.
pub(crate) async fn with_notice<F: Future>(start: F, notice: impl FnOnce()) -> F::Output {
    tokio::pin!(start);
    tokio::select! {
        result = &mut start => result,
        () = tokio::time::sleep(STARTUP_NOTICE) => {
            notice();
            start.await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[tokio::test(start_paused = true)]
    async fn prolonged_start_notifies_at_fifteen_seconds_without_cancelling() {
        let began = tokio::time::Instant::now();
        let noticed = Cell::new(None);
        let result = with_notice(
            async {
                tokio::time::sleep(Duration::from_secs(59)).await;
                "bound A"
            },
            || noticed.set(Some(began.elapsed())),
        )
        .await;
        assert_eq!(noticed.get(), Some(Duration::from_secs(15)));
        assert_eq!(result, "bound A");
        assert_eq!(began.elapsed(), Duration::from_secs(59));
    }

    /// An automatic start continues only a live episode: 250 s into its window, with less left
    /// than one attempt and its cleanup, it holds (the cap stays). A window that closed long ago,
    /// or an episode that ended bound, begins a fresh episode; a held or cancelled episode stays
    /// the hold until the owner's retry.
    #[tokio::test]
    async fn an_automatic_start_renews_only_an_ended_or_expired_episode() {
        let state = crate::sys::fs::tests::scratch("episode-renewal");
        let db = state.join("store.db");
        let (store, writer) = crate::store::Store::open(&db, &state.join("backup")).unwrap();
        let conn = rusqlite::Connection::open(&db).unwrap();
        let set = |started: i64, state: &str, retries: i64| {
            conn.execute(
                "INSERT INTO startup_episodes(target, session_id, started_ms, deadline_ms, retries, state) \
                 VALUES ('lead', 'A', ?1, ?2, ?3, ?4) ON CONFLICT(target) DO UPDATE SET \
                 started_ms = excluded.started_ms, deadline_ms = excluded.deadline_ms, \
                 retries = excluded.retries, state = excluded.state, next_ms = NULL, detail = NULL",
                rusqlite::params![started, started + 300_000, retries, state],
            )
            .unwrap();
        };
        let recovery = Recovery {
            store: &store,
            target: "lead",
        };
        let (_cancel, cancelled) = tokio::sync::watch::channel(false);
        let now = crate::sys::now_ms();

        set(now - 250_000, "active", 2);
        let held = recovery.admit("A", cancelled.clone()).await.unwrap_err();
        assert!(held.contains("300 s recovery episode exhausted"), "{held}");
        let episode = recovery.read().await.unwrap().unwrap();
        assert_eq!(
            (episode.state.as_str(), episode.started_ms, episode.retries),
            ("held", now - 250_000, 2)
        );

        for (started, ended) in [(now - 7_200_000, "active"), (now - 86_400_000, "bound")] {
            set(started, ended, 3);
            recovery.admit("A", cancelled.clone()).await.unwrap();
            let episode = recovery.read().await.unwrap().unwrap();
            assert_eq!(episode.state, "active", "{ended}");
            assert!(episode.started_ms >= now, "{ended}: {episode:?}");
            assert_eq!(episode.deadline_ms, episode.started_ms + 300_000);
            assert_eq!(episode.retries, 0, "{ended}");
        }

        for hold in ["held", "cancelled"] {
            set(now - 7_200_000, hold, 5);
            let refused = recovery.admit("A", cancelled.clone()).await.unwrap_err();
            assert!(
                refused.starts_with(&format!("recovery is {hold}")),
                "{refused}"
            );
            let episode = recovery.read().await.unwrap().unwrap();
            assert_eq!(episode.started_ms, now - 7_200_000, "{hold} stays");
            recovery.begin("A", Begin::Reset).await.unwrap();
        }
        drop(conn);
        drop(store);
        writer.join().unwrap().unwrap();
    }
}
