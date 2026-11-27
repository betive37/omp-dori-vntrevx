//! Lane supervision uses the host's shared deadline, cleanup evidence and durable retry cap.
//! Only an exact-identity timeout with proven exit may retry; every attempt rechecks the lease.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;

use super::Lanes;
use super::record::Record;
use crate::host::startup::{self, Cleanup, Recovery, StartupOutcome, StartupStage};
use crate::host::{Control, Runtime, StartError, StartSpec, Started};
use crate::store::lanes::Revision;
use crate::sys::now_ms;

pub(super) struct Launch<'a> {
    pub(super) record: &'a mut Record,
    pub(super) revision: &'a mut Revision,
    pub(super) spec: StartSpec,
    pub(super) reply: &'a mut super::replies::Reply,
}

pub(super) struct Stopped {
    pub(super) detail: String,
    pub(super) cleanup: Cleanup,
}

pub(super) fn cleanup(error: &StartError) -> Cleanup {
    match error {
        StartError::Refused(_) => Cleanup::NotSpawned,
        StartError::Failed(_) => Cleanup::Unknown,
        StartError::Startup { cleanup, .. } => *cleanup,
    }
}

fn rejected(detail: String, cleanup: Cleanup) -> StartError {
    StartError::Startup {
        stage: StartupStage::Spawn,
        outcome: StartupOutcome::Rejected,
        cleanup,
        detail,
    }
}

fn cancelled() -> StartError {
    StartError::Startup {
        stage: StartupStage::Spawn,
        outcome: StartupOutcome::Cancelled,
        cleanup: Cleanup::NotSpawned,
        detail: "lane startup cancelled; work retained".into(),
    }
}

impl<R: Runtime> Lanes<R> {
    pub(super) async fn supervise(
        &self,
        runtime: &R,
        mut launch: Launch<'_>,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<(Arc<R::Session>, Started), StartError> {
        let target = format!("lane:{}", launch.record.key);
        let recovery = launch.spec.expected_id.as_ref().map(|_| Recovery {
            store: &self.env.store,
            target: &target,
        });
        loop {
            if let Err(error) = self
                .ready_attempt(&mut launch, recovery.as_ref(), &mut cancel)
                .await
            {
                if let Some(recovery) = &recovery {
                    recovery
                        .end("held", Some(error.to_string()))
                        .await
                        .map_err(|detail| rejected(detail, cleanup(&error)))?;
                }
                return Err(error);
            }
            let result = self.run_attempt(runtime, &launch, cancel.clone()).await;
            let error = match result {
                Ok((session, started)) if *cancel.borrow() => {
                    let stopped = stop(&*session).await;
                    StartError::Startup {
                        stage: StartupStage::Binding,
                        outcome: StartupOutcome::Cancelled,
                        cleanup: stopped.cleanup,
                        detail: format!(
                            "startup cancelled after binding {}: {}",
                            started.session_id, stopped.detail
                        ),
                    }
                }
                Ok(pair) => return Ok(pair),
                Err(error) => error,
            };
            launch.record.startup_cleanup = cleanup(&error);
            *launch.revision = self
                .save(
                    launch.record,
                    Some(*launch.revision),
                    Some(error.to_string()),
                )
                .await
                .map_err(|detail| rejected(detail, cleanup(&error)))?;
            let Some(recovery) = &recovery else {
                return Err(error);
            };
            let Some(delay) = recovery
                .retry(&error)
                .await
                .map_err(|detail| rejected(detail, cleanup(&error)))?
            else {
                return Err(error);
            };
            if launch.reply.pending() {
                let episode = recovery
                    .read()
                    .await
                    .map_err(|detail| rejected(detail, cleanup(&error)))?
                    .ok_or_else(|| {
                        rejected("recovery episode disappeared".into(), cleanup(&error))
                    })?;
                launch
                    .reply
                    .recovering(&launch.record.key, &episode, delay)
                    .map_err(|detail| rejected(detail, cleanup(&error)))?;
            }
        }
    }

    async fn ready_attempt(
        &self,
        launch: &mut Launch<'_>,
        recovery: Option<&Recovery<'_>>,
        cancel: &mut watch::Receiver<bool>,
    ) -> Result<(), StartError> {
        if *cancel.borrow() {
            return Err(cancelled());
        }
        if let (Some(recovery), Some(id)) = (recovery, &launch.spec.expected_id) {
            let episode = recovery
                .begin(id, false)
                .await
                .map_err(|detail| rejected(detail, Cleanup::Unknown))?;
            if let Some(next) = episode.next_ms {
                let delay = Duration::from_millis(
                    u64::try_from(next.saturating_sub(now_ms())).unwrap_or(0),
                );
                tokio::select! {
                    () = startup::cancelled(cancel) => return Err(cancelled()),
                    () = tokio::time::sleep(delay) => {}
                }
                recovery
                    .begin(id, false)
                    .await
                    .map_err(|detail| rejected(detail, Cleanup::Unknown))?;
            }
            let prior = previous_exit(&self.env.state_dir, launch.record)
                .await
                .map_err(|detail| rejected(detail, Cleanup::Unknown))?;
            if !prior.confirmed() {
                return Err(rejected(
                    "previous startup writer exit is unconfirmed; work retained".into(),
                    prior,
                ));
            }
            if self.lease_free(launch.record.worker.as_deref(), id).await != Some(true) {
                return Err(rejected(
                    "session lease is held or unknown; work retained".into(),
                    prior,
                ));
            }
            launch.record.start_note = Some(format!(
                "starting existing session; attempt {}",
                episode.retries.saturating_add(1)
            ));
        }
        if *cancel.borrow() {
            return Err(cancelled());
        }
        if launch.record.handle.as_deref() == Some(launch.spec.handle.as_str()) {
            launch.spec.handle = crate::host::random_hex(8);
        }
        launch.record.handle = Some(launch.spec.handle.clone());
        launch.record.startup_cleanup = Cleanup::Unknown;
        *launch.revision = self
            .save(launch.record, Some(*launch.revision), None)
            .await
            .map_err(StartError::Refused)?;
        Ok(())
    }

    async fn run_attempt(
        &self,
        runtime: &R,
        launch: &Launch<'_>,
        cancel: watch::Receiver<bool>,
    ) -> Result<(Arc<R::Session>, Started), StartError> {
        let started = runtime.start_supervised(launch.spec.clone(), cancel);
        tokio::pin!(started);
        tokio::select! {
            result = &mut started => result,
            () = tokio::time::sleep(startup::STARTUP_NOTICE) => {
                let detail = match &launch.spec.expected_id {
                    Some(id) => format!("still starting existing session {id}; conversation and work retained"),
                    None => "still starting the new lane session".into(),
                };
                self.alert(&launch.record.key, "session starting", &detail, true);
                started.await
            }
        }
    }
}

async fn previous_exit(state: &std::path::Path, rec: &Record) -> Result<Cleanup, String> {
    if rec.startup_cleanup.confirmed() {
        return Ok(rec.startup_cleanup);
    }
    let Some(handle) = &rec.handle else {
        return Ok(Cleanup::Unknown);
    };
    match &rec.worker {
        None => crate::host::lead::ownership::reconcile(state, handle).await,
        // A transport disconnect is not a worker-side exit receipt.
        Some(_) => Ok(Cleanup::Unknown),
    }
}

pub(super) async fn stop<S: Control>(session: &S) -> Stopped {
    match tokio::time::timeout(crate::host::lead::STOP_BUDGET, session.close(true)).await {
        Ok(Ok(stopped)) => Stopped {
            detail: format!("{}: {:?}", stopped.how, stopped.detail),
            cleanup: stopped.cleanup,
        },
        Ok(Err(detail)) => Stopped {
            detail,
            cleanup: Cleanup::Unknown,
        },
        Err(_) => Stopped {
            detail: "stop deadline passed; process exit is unconfirmed".into(),
            cleanup: Cleanup::Unknown,
        },
    }
}
