//! The lead's stream jobs (WS-02, WS-04; WS req. 71-75): a long-running command whose output lines
//! that match a filter become events for the lead. Restart policy with backoff, an optional silence
//! alert, oversized lines to a private file. The hub owns them: they outlive the lead's OMP process,
//! are kept in the store with their used restarts and start again with the hub unless they ended.
//! The lead's tool forwards start, stop and list.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::watch;

use crate::jobs::Jobs;
use crate::jobs::event::{Emit, EventKind, Severity, one_line};
use crate::log;
use crate::params as p;
use crate::store::Store;
use crate::store::lead::LeadWrite;
use crate::sys::command::{self, Exit, KILL_GRACE};

/// A line longer than this is not filtered; it goes to a private file (WS req. 72).
const LINE_MAX: usize = 64 * 1024;
const JOBS_MAX: usize = 16;
const ARGV_MAX: usize = 64;
const STDERR_CAP: u64 = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Spec {
    name: String,
    argv: Vec<String>,
    filter: String,
    restarts: u32,
    delay_s: u64,
    silence_m: Option<u64>,
    low: bool,
    /// Restarts used so far, kept so a hub restart continues the count (WS req. 73).
    #[serde(default)]
    used: u32,
    /// The restarts are used up: the job stays listed but the hub does not start it again.
    #[serde(default)]
    ended: bool,
    /// How the last child ended, kept for the list after a hub restart.
    #[serde(default)]
    last_exit: Option<String>,
    /// Which start this is: progress is written only to the row of the same start.
    #[serde(default)]
    run: String,
}

/// How long an ended child waits for the hub's own stop to show: under systemd the control
/// group's TERM can reach the child before the hub. Such an exit is not the job's and not counted.
const STOP_GRACE: Duration = Duration::from_secs(1);

fn run_id() -> String {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{}-{n}", crate::sys::now_ms())
}

#[derive(Debug, Clone)]
struct State {
    phase: &'static str,
    restarts: u32,
    last_exit: Option<String>,
    next_restart: Option<Instant>,
    stop: watch::Sender<bool>,
    /// The start this state belongs to; a stopped start's task never touches a later one.
    run: String,
}

/// Running stream jobs.
pub(crate) struct Streams {
    jobs: Jobs,
    store: Store,
    cwd: PathBuf,
    files: PathBuf,
    running: Mutex<HashMap<String, State>>,
    shutdown: watch::Receiver<bool>,
}

fn spec_of(input: &Value) -> Result<Spec, String> {
    let name = p::NAME.text(input).unwrap_or_default();
    let valid = !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    if !valid {
        return Err("name: 1 to 64 letters, digits, '-', '_' or '.'".into());
    }
    let argv: Vec<String> = p::ARGV.list(input);
    if argv.is_empty() || argv.len() > ARGV_MAX {
        return Err("argv: the command and its arguments, 1 to 64 words (no shell)".into());
    }
    let filter = p::FILTER.text(input).unwrap_or(".").to_string();
    regex::RegexBuilder::new(&filter)
        .size_limit(1 << 20)
        .build()
        .map_err(|e| format!("filter: {e}"))?;
    let restarts = p::RESTARTS.uint(input).unwrap_or(5);
    let delay_s = p::DELAY.uint(input).unwrap_or(10);
    let silence_m = p::SILENCE.uint(input);
    if restarts > 100
        || !(1..=3600).contains(&delay_s)
        || silence_m.is_some_and(|m| !(1..=1440).contains(&m))
    {
        return Err("restarts 0 to 100, delay 1 to 3600 s, silence 1 to 1440 minutes".into());
    }
    Ok(Spec {
        name: name.to_string(),
        argv,
        filter,
        restarts: u32::try_from(restarts).unwrap_or(5),
        delay_s,
        silence_m,
        low: p::LOW.flag(input),
        used: 0,
        ended: false,
        last_exit: None,
        run: run_id(),
    })
}

impl Streams {
    pub(crate) fn new(
        jobs: Jobs,
        store: Store,
        cwd: PathBuf,
        files: PathBuf,
        shutdown: watch::Receiver<bool>,
    ) -> Arc<Self> {
        Arc::new(Self {
            jobs,
            store,
            cwd,
            files,
            running: Mutex::new(HashMap::new()),
            shutdown,
        })
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, State>> {
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Starts the stream jobs kept in the store (WS-04: the hub restores its own jobs). An ended job
    /// is listed again but not started; a running one continues its restart count.
    pub(crate) async fn resume(self: &Arc<Self>) {
        let kept = self
            .store
            .read(crate::store::Reads::stream_jobs)
            .await
            .unwrap_or_default();
        for (name, spec) in kept {
            match serde_json::from_str::<Spec>(&spec) {
                Ok(spec) if spec.ended => {
                    self.lock().insert(
                        spec.name,
                        State {
                            phase: "exhausted",
                            restarts: spec.used,
                            last_exit: spec.last_exit,
                            next_restart: None,
                            stop: watch::channel(true).0,
                            run: spec.run,
                        },
                    );
                }
                Ok(spec) => self.spawn(spec),
                Err(e) => log::warn("stream job not restored", &[("job", &name), ("error", &e)]),
            }
        }
    }

    pub(crate) async fn start(self: &Arc<Self>, input: &Value) -> Result<String, String> {
        let spec = spec_of(input)?;
        {
            let running = self.lock();
            if running.contains_key(&spec.name) {
                return Err(format!(
                    "a stream job named {} exists; stop it first",
                    spec.name
                ));
            }
            if running.len() >= JOBS_MAX {
                return Err(format!("at most {JOBS_MAX} stream jobs"));
            }
        }
        let saved = serde_json::to_string(&spec).map_err(|e| e.to_string())?;
        self.store
            .lead(LeadWrite::StreamSave {
                name: spec.name.clone(),
                spec: saved,
            })
            .await
            .map_err(|e| e.to_string())?;
        let name = spec.name.clone();
        self.spawn(spec);
        Ok(format!(
            "stream job {name} started; matching lines arrive as [event stream.line]"
        ))
    }

    pub(crate) async fn stop(&self, name: &str) -> Result<String, String> {
        let state = self
            .lock()
            .remove(name)
            .ok_or(format!("no stream job named {name}"))?;
        let _ = state.stop.send(true);
        self.store
            .lead(LeadWrite::StreamRemove { name: name.into() })
            .await
            .map_err(|e| e.to_string())?;
        Ok(format!("stream job {name} stopped"))
    }

    pub(crate) fn list(&self) -> String {
        let running = self.lock();
        if running.is_empty() {
            return "no stream jobs".into();
        }
        let mut names: Vec<&String> = running.keys().collect();
        names.sort();
        let mut out = String::new();
        for name in names {
            let Some(s) = running.get(name) else { continue };
            let _ = write!(
                out,
                "- {name}: {}, {} restart(s), last exit {}",
                s.phase,
                s.restarts,
                s.last_exit.as_deref().unwrap_or("none")
            );
            if let Some(at) = s.next_restart {
                let _ = write!(
                    out,
                    ", next restart in {} s",
                    at.saturating_duration_since(Instant::now()).as_secs()
                );
            }
            out.push('\n');
        }
        out.trim_end().to_string()
    }

    fn spawn(self: &Arc<Self>, spec: Spec) {
        let (stop, stopped) = watch::channel(false);
        self.lock().insert(
            spec.name.clone(),
            State {
                phase: "running",
                restarts: spec.used,
                last_exit: None,
                next_restart: None,
                stop,
                run: spec.run.clone(),
            },
        );
        let me = Arc::clone(self);
        tokio::spawn(async move { me.run(spec, stopped).await });
    }

    /// Changes the job's state if it still belongs to this start; false when it does not.
    fn update(&self, spec: &Spec, f: impl FnOnce(&mut State)) -> bool {
        match self.lock().get_mut(&spec.name) {
            Some(s) if s.run == spec.run => {
                f(s);
                true
            }
            _ => false,
        }
    }

    async fn emit(&self, kind: EventKind, spec: &Spec, urgent: bool, value: &str) {
        let field = if kind == EventKind::StreamLine {
            "line"
        } else {
            "reason"
        };
        let emit = Emit::new(kind, Severity::Info, urgent, &spec.name)
            .with("job", &spec.name)
            .with(field, value);
        if let Err(e) = self.jobs.hub_event(emit).await {
            log::warn(
                "stream event not recorded",
                &[("job", &spec.name), ("error", &e)],
            );
        }
    }

    /// Keeps the restarts used and the ended mark with the job, so the hub's next start honours them.
    async fn keep_progress(&self, spec: &Spec) {
        let write = serde_json::to_string(spec).map(|saved| LeadWrite::StreamProgress {
            name: spec.name.clone(),
            run: spec.run.clone(),
            spec: saved,
        });
        let result = match write {
            Ok(write) => self.store.lead(write).await.map_err(|e| e.to_string()),
            Err(e) => Err(e.to_string()),
        };
        if let Err(e) = result {
            log::warn(
                "stream job progress not kept",
                &[("job", &spec.name), ("error", &e)],
            );
        }
    }

    /// Whether the hub or this job is stopping, waiting `STOP_GRACE` for either stop to show.
    async fn stopping(&self, stopped: &mut watch::Receiver<bool>) -> bool {
        let mut shutdown = self.shutdown.clone();
        let _ = tokio::time::timeout(STOP_GRACE, async {
            tokio::select! {
                _ = shutdown.wait_for(|stop| *stop) => {}
                _ = stopped.wait_for(|stop| *stop) => {}
            }
        })
        .await;
        *shutdown.borrow() || *stopped.borrow()
    }

    /// Runs the command until it is stopped or its restarts are used up (WS req. 73).
    async fn run(self: Arc<Self>, mut spec: Spec, mut stopped: watch::Receiver<bool>) {
        let Ok(filter) = regex::RegexBuilder::new(&spec.filter)
            .size_limit(1 << 20)
            .build()
        else {
            return;
        };
        let stderr = self
            .files
            .join("streams")
            .join(format!("{}.err", spec.name));
        let _ = crate::sys::fs::ensure_private_dir(&self.files.join("streams"));
        let mut attempt = spec.used;
        loop {
            let ended = match command::attach(
                &spec.argv,
                Some(&self.cwd),
                &[],
                Some(&stderr),
                STDERR_CAP,
            ) {
                Ok(child) => self.watch_output(&spec, &filter, child, &mut stopped).await,
                Err(e) => Some(format!("not started: {e}")),
            };
            let Some(exit) = ended else {
                return;
            };
            if self.stopping(&mut stopped).await
                || !self.update(&spec, |s| s.last_exit = Some(exit.clone()))
            {
                return;
            }
            spec.last_exit = Some(exit.clone());
            if attempt >= spec.restarts {
                if !self.update(&spec, |s| s.phase = "exhausted") {
                    return;
                }
                spec.ended = true;
                self.keep_progress(&spec).await;
                let reason = format!("exited ({exit}) and no restart is left");
                self.emit(EventKind::StreamEnded, &spec, !spec.low, &reason)
                    .await;
                return;
            }
            let wait =
                Duration::from_secs(spec.delay_s.saturating_mul(1 << attempt.min(10)).min(3600));
            attempt += 1;
            spec.used = attempt;
            self.keep_progress(&spec).await;
            self.update(&spec, |s| {
                s.restarts = attempt;
                s.phase = "waiting";
                s.next_restart = Some(Instant::now() + wait);
            });
            tokio::select! {
                () = tokio::time::sleep(wait) => {}
                _ = stopped.changed() => return,
            }
            self.update(&spec, |s| {
                s.phase = "running";
                s.next_restart = None;
            });
        }
    }

    /// Reads one child's output; `None` when the job was stopped, else how the child ended.
    async fn watch_output(
        &self,
        spec: &Spec,
        filter: &regex::Regex,
        mut child: command::Attached,
        stopped: &mut watch::Receiver<bool>,
    ) -> Option<String> {
        let stdout = child.take_stdout()?;
        let mut lines = BufReader::new(stdout).lines();
        let silence = spec.silence_m.map(|m| Duration::from_secs(m * 60));
        let mut quiet_since = Instant::now();
        let mut alerted = false;
        loop {
            let wait = silence.map_or(Duration::from_secs(3600), |s| {
                s.saturating_sub(quiet_since.elapsed())
                    .max(Duration::from_secs(1))
            });
            let line = tokio::select! {
                line = lines.next_line() => line,
                () = tokio::time::sleep(wait) => {
                    if let Some(s) = silence && !alerted && quiet_since.elapsed() >= s {
                        alerted = true;
                        let text = format!("no output for {} minute(s); still running", s.as_secs() / 60);
                        self.emit(EventKind::StreamLine, spec, !spec.low, &text).await;
                    }
                    continue;
                }
                _ = stopped.changed() => {
                    child.close(Duration::ZERO, KILL_GRACE).await;
                    return None;
                }
            };
            let Ok(Some(line)) = line else { break };
            quiet_since = Instant::now();
            alerted = false;
            if line.len() > LINE_MAX {
                let path = self.files.join("streams").join(format!(
                    "{}-{}.txt",
                    spec.name,
                    crate::sys::now_ms()
                ));
                let note = match crate::sys::fs::write_atomic(&path, line.as_bytes()) {
                    Ok(()) => format!(
                        "a line of {} bytes, saved in {}",
                        line.len(),
                        path.display()
                    ),
                    Err(e) => format!(
                        "a line of {} bytes that could not be saved: {e}",
                        line.len()
                    ),
                };
                self.emit(EventKind::StreamLine, spec, !spec.low, &note)
                    .await;
            } else if filter.is_match(&line) {
                self.emit(
                    EventKind::StreamLine,
                    spec,
                    !spec.low,
                    &one_line(&line, 300),
                )
                .await;
            }
        }
        let (exit, _) = child.close(Duration::from_secs(5), KILL_GRACE).await;
        Some(match exit {
            Exit::Code(c) => format!("status {c}"),
            Exit::Signal(s) => format!("signal {s}"),
            Exit::Unknown => "unknown status".into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn specs_are_checked() {
        assert!(spec_of(&json!({"name": "x", "argv": ["tail"]})).is_ok());
        assert!(spec_of(&json!({"name": "bad name", "argv": ["tail"]})).is_err());
        assert!(spec_of(&json!({"name": "x", "argv": []})).is_err());
        assert!(spec_of(&json!({"name": "x", "argv": ["a"], "filter": "("})).is_err());
        assert!(spec_of(&json!({"name": "x", "argv": ["a"], "restarts": 101})).is_err());
    }

    /// WS req. 73: an exhausted job stays ended when the hub starts again.
    #[tokio::test]
    async fn an_exhausted_job_is_not_started_again_with_the_hub() {
        let (ctx, _stop, dir) = crate::jobs::tests::ctx_with("", "streams-exhausted");
        let hub = |ctx: &Arc<crate::jobs::Ctx>| {
            Streams::new(
                crate::jobs::tests::jobs_of(ctx),
                ctx.store.clone(),
                dir.to_path_buf(),
                dir.join("files"),
                watch::channel(false).1,
            )
        };
        let first = hub(&ctx);
        first
            .start(&json!({"name": "once", "argv": ["sh", "-c", "exit 1"], "restarts": 0}))
            .await
            .unwrap();
        let mut polls = 0;
        while !first.list().contains("exhausted") {
            polls += 1;
            assert!(polls < 500, "the job did not end: {}", first.list());
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let ended = |ctx: &Arc<crate::jobs::Ctx>| {
            let store = ctx.store.clone();
            async move {
                store
                    .read(|r| r.events_after(0, 10))
                    .await
                    .unwrap()
                    .into_iter()
                    .filter(|e| e.kind == "stream.ended")
                    .count()
            }
        };
        let mut polls = 0;
        while ended(&ctx).await == 0 {
            polls += 1;
            assert!(polls < 500, "no stream.ended event");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        // The hub starts again: the job is listed as ended and no child runs for it.
        let second = hub(&ctx);
        second.resume().await;
        let list = second.list();
        assert!(
            list.starts_with("- once: exhausted, 0 restart(s), last exit status 1"),
            "{list}"
        );
        assert_eq!(ended(&ctx).await, 1);
        second.stop("once").await.unwrap();
        let kept = ctx
            .store
            .read(crate::store::Reads::stream_jobs)
            .await
            .unwrap();
        assert!(kept.is_empty(), "{kept:?}");
    }

    async fn kept_specs(ctx: &Arc<crate::jobs::Ctx>) -> Vec<Spec> {
        ctx.store
            .read(crate::store::Reads::stream_jobs)
            .await
            .unwrap()
            .into_iter()
            .map(|(_, spec)| serde_json::from_str(&spec).unwrap())
            .collect()
    }

    async fn save(ctx: &Arc<crate::jobs::Ctx>, spec: &Spec) {
        ctx.store
            .lead(LeadWrite::StreamSave {
                name: spec.name.clone(),
                spec: serde_json::to_string(spec).unwrap(),
            })
            .await
            .unwrap();
    }

    /// WS-04: a child that ends while the hub stops (systemd's TERM to the whole control group) is
    /// not counted against the job, so it starts again with the hub.
    #[tokio::test]
    async fn an_exit_while_the_hub_stops_is_not_counted() {
        let (ctx, _stop, dir) = crate::jobs::tests::ctx_with("", "streams-hub-stop");
        let (_stopping, shutdown) = watch::channel(true);
        let streams = Streams::new(
            crate::jobs::tests::jobs_of(&ctx),
            ctx.store.clone(),
            dir.to_path_buf(),
            dir.join("files"),
            shutdown,
        );
        let spec = spec_of(&json!({"name": "term", "argv": ["sh", "-c", "exit 1"], "restarts": 0}))
            .unwrap();
        save(&ctx, &spec).await;
        let (_job_stop, stopped) = watch::channel(false);
        Arc::clone(&streams).run(spec, stopped).await;
        let kept = kept_specs(&ctx).await;
        assert_eq!(kept.len(), 1);
        assert!(!kept[0].ended && kept[0].used == 0, "{kept:?}");
        let events = ctx.store.read(|r| r.events_after(0, 10)).await.unwrap();
        assert!(events.is_empty(), "{events:?}");
    }

    /// A task of a stopped job never writes over the job started again under its name.
    #[tokio::test]
    async fn a_stopped_start_writes_no_progress() {
        let (ctx, _stop, dir) = crate::jobs::tests::ctx_with("", "streams-stale");
        let streams = Streams::new(
            crate::jobs::tests::jobs_of(&ctx),
            ctx.store.clone(),
            dir.to_path_buf(),
            dir.join("files"),
            watch::channel(false).1,
        );
        let input = json!({"name": "same", "argv": ["true"]});
        let mut old = spec_of(&input).unwrap();
        save(&ctx, &old).await;
        ctx.store
            .lead(LeadWrite::StreamRemove {
                name: "same".into(),
            })
            .await
            .unwrap();
        let new = spec_of(&input).unwrap();
        save(&ctx, &new).await;
        old.ended = true;
        streams.keep_progress(&old).await;
        let kept = kept_specs(&ctx).await;
        assert!(
            kept.len() == 1 && !kept[0].ended && kept[0].run == new.run,
            "{kept:?}"
        );
        let mut new = new;
        new.used = 2;
        streams.keep_progress(&new).await;
        assert_eq!(kept_specs(&ctx).await[0].used, 2);
    }

    /// The late exit of a stopped start changes nothing of the job started again under its name.
    #[tokio::test]
    async fn a_stopped_start_does_not_touch_the_new_job() {
        let (ctx, _stop, dir) = crate::jobs::tests::ctx_with("", "streams-late-exit");
        let streams = Streams::new(
            crate::jobs::tests::jobs_of(&ctx),
            ctx.store.clone(),
            dir.to_path_buf(),
            dir.join("files"),
            watch::channel(false).1,
        );
        streams
            .start(&json!({"name": "same", "argv": ["sleep", "1000"]}))
            .await
            .unwrap();
        let old = spec_of(&json!({"name": "same", "argv": ["sh", "-c", "exit 1"], "restarts": 0}))
            .unwrap();
        let (_old_stop, stopped) = watch::channel(false);
        Arc::clone(&streams).run(old, stopped).await;
        let list = streams.list();
        assert!(
            list.starts_with("- same: running, 0 restart(s), last exit none"),
            "{list}"
        );
        let events = ctx.store.read(|r| r.events_after(0, 10)).await.unwrap();
        assert!(events.is_empty(), "{events:?}");
        streams.stop("same").await.unwrap();
    }
}
