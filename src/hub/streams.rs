//! The lead's stream jobs (WS-02, WS-04; WS req. 71-75): a long-running command whose output lines
//! that match a filter become events for the lead. Restart policy with backoff, an optional silence
//! alert, oversized lines to a private file. The hub owns them: they outlive the lead's OMP process,
//! are kept in the store and start again with the hub. The lead's tool forwards start, stop and list.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::AsyncReadExt;
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
/// How much output one read takes; a line in memory never exceeds `LINE_MAX` plus this.
const CHUNK: usize = 8 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Spec {
    name: String,
    argv: Vec<String>,
    filter: String,
    restarts: u32,
    delay_s: u64,
    silence_m: Option<u64>,
    low: bool,
}

#[derive(Debug, Clone)]
struct State {
    phase: &'static str,
    restarts: u32,
    last_exit: Option<String>,
    next_restart: Option<Instant>,
    stop: watch::Sender<bool>,
}

/// Running stream jobs.
pub(crate) struct Streams {
    jobs: Jobs,
    store: Store,
    cwd: PathBuf,
    files: PathBuf,
    running: Mutex<HashMap<String, State>>,
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
    })
}

impl Streams {
    pub(crate) fn new(jobs: Jobs, store: Store, cwd: PathBuf, files: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            jobs,
            store,
            cwd,
            files,
            running: Mutex::new(HashMap::new()),
        })
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, State>> {
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Starts the stream jobs kept in the store (WS-04: the hub restores its own jobs).
    pub(crate) async fn resume(self: &Arc<Self>) {
        let kept = self
            .store
            .read(crate::store::Reads::stream_jobs)
            .await
            .unwrap_or_default();
        for (name, spec) in kept {
            match serde_json::from_str::<Spec>(&spec) {
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
                restarts: 0,
                last_exit: None,
                next_restart: None,
                stop,
            },
        );
        let me = Arc::clone(self);
        tokio::spawn(async move { me.run(spec, stopped).await });
    }

    fn update(&self, name: &str, f: impl FnOnce(&mut State)) {
        if let Some(s) = self.lock().get_mut(name) {
            f(s);
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

    /// Runs the command until it is stopped or its restarts are used up (WS req. 73).
    async fn run(self: Arc<Self>, spec: Spec, mut stopped: watch::Receiver<bool>) {
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
        let mut attempt: u32 = 0;
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
            self.update(&spec.name, |s| s.last_exit = Some(exit.clone()));
            if attempt >= spec.restarts {
                self.update(&spec.name, |s| s.phase = "exhausted");
                let reason = format!("exited ({exit}) and no restart is left");
                self.emit(EventKind::StreamEnded, &spec, !spec.low, &reason)
                    .await;
                return;
            }
            let wait =
                Duration::from_secs(spec.delay_s.saturating_mul(1 << attempt.min(10)).min(3600));
            attempt += 1;
            self.update(&spec.name, |s| {
                s.restarts = attempt;
                s.phase = "waiting";
                s.next_restart = Some(Instant::now() + wait);
            });
            tokio::select! {
                () = tokio::time::sleep(wait) => {}
                _ = stopped.changed() => return,
            }
            self.update(&spec.name, |s| {
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
        let mut stdout = child.take_stdout()?;
        let mut chunk = vec![0u8; CHUNK];
        let mut line = Line::new(self.files.join("streams"), &spec.name);
        let silence = spec.silence_m.map(|m| Duration::from_secs(m * 60));
        let mut quiet_since = Instant::now();
        let mut alerted = false;
        loop {
            let wait = silence.map_or(Duration::from_secs(3600), |s| {
                s.saturating_sub(quiet_since.elapsed())
                    .max(Duration::from_secs(1))
            });
            let read = tokio::select! {
                read = stdout.read(&mut chunk) => read,
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
            let Ok(n @ 1..) = read else { break };
            quiet_since = Instant::now();
            alerted = false;
            let mut parts = chunk[..n].split(|&b| b == b'\n');
            if let Some(first) = parts.next() {
                line.push(first);
            }
            for part in parts {
                self.line_ended(spec, filter, line.finish()).await;
                line.push(part);
            }
        }
        if !line.is_empty() {
            self.line_ended(spec, filter, line.finish()).await;
        }
        let (exit, _) = child.close(Duration::from_secs(5), KILL_GRACE).await;
        Some(match exit {
            Exit::Code(c) => format!("status {c}"),
            Exit::Signal(s) => format!("signal {s}"),
            Exit::Unknown => "unknown status".into(),
        })
    }

    async fn line_ended(&self, spec: &Spec, filter: &regex::Regex, ended: Ended) {
        match ended {
            Ended::Text(text) if filter.is_match(&text) => {
                self.emit(
                    EventKind::StreamLine,
                    spec,
                    !spec.low,
                    &one_line(&text, 300),
                )
                .await;
            }
            Ended::Text(_) => {}
            Ended::Saved(note) => {
                self.emit(EventKind::StreamLine, spec, !spec.low, &note)
                    .await;
            }
        }
    }
}

/// A line that ended: its text, or the note about the private file a long line went to.
enum Ended {
    Text(String),
    Saved(String),
}

/// The output line being read. Up to `LINE_MAX` bytes stay in memory; a longer line continues in a
/// private file (WS req. 72), so output without line ends never grows the hub's memory.
struct Line {
    dir: PathBuf,
    name: String,
    bytes: Vec<u8>,
    spill: Option<Spill>,
}

struct Spill {
    path: PathBuf,
    file: Result<std::fs::File, String>,
    len: usize,
}

impl Line {
    fn new(dir: PathBuf, name: &str) -> Self {
        Self {
            dir,
            name: name.into(),
            bytes: Vec::new(),
            spill: None,
        }
    }

    fn is_empty(&self) -> bool {
        self.bytes.is_empty() && self.spill.is_none()
    }

    fn push(&mut self, part: &[u8]) {
        if let Some(spill) = &mut self.spill {
            spill.write(part);
            return;
        }
        self.bytes.extend_from_slice(part);
        if self.bytes.len() > LINE_MAX {
            let path = self
                .dir
                .join(format!("{}-{}.txt", self.name, crate::sys::now_ms()));
            let file = crate::sys::fs::create_private(&path).map_err(|e| e.to_string());
            let mut spill = Spill { path, file, len: 0 };
            spill.write(&std::mem::take(&mut self.bytes));
            self.spill = Some(spill);
        }
    }

    fn finish(&mut self) -> Ended {
        let Some(spill) = self.spill.take() else {
            let mut bytes = std::mem::take(&mut self.bytes);
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            return Ended::Text(String::from_utf8_lossy(&bytes).into_owned());
        };
        Ended::Saved(match spill.file {
            Ok(_) => format!(
                "a line of {} bytes, saved in {}",
                spill.len,
                spill.path.display()
            ),
            Err(e) => format!("a line of {} bytes that could not be saved: {e}", spill.len),
        })
    }
}

impl Spill {
    fn write(&mut self, part: &[u8]) {
        use std::io::Write as _;
        self.len += part.len();
        if let Ok(file) = &mut self.file
            && let Err(e) = file.write_all(part)
        {
            self.file = Err(e.to_string());
        }
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

    /// WS req. 72: a line without an end goes to its file while it grows, not into memory first.
    #[tokio::test]
    async fn a_long_line_goes_to_a_file_before_it_ends() {
        let (ctx, _stop, dir) = crate::jobs::tests::ctx_with("", "streams-long-line");
        let files = dir.join("files");
        let streams = Streams::new(
            crate::jobs::tests::jobs_of(&ctx),
            ctx.store.clone(),
            dir.to_path_buf(),
            files.clone(),
        );
        crate::sys::fs::ensure_private_dir(&files.join("streams")).unwrap();
        let gate = dir.join("gate");
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&gate)
                .status()
                .unwrap()
                .success()
        );
        // 200 KiB without a line end, then the line stays open until the test opens the gate.
        let spec = spec_of(&json!({
            "name": "long",
            "argv": ["sh", "-c", "head -c 204800 /dev/zero | tr '\\0' x; cat \"$0\"", gate],
        }))
        .unwrap();
        let filter = regex::Regex::new(&spec.filter).unwrap();
        let child = command::attach(&spec.argv, Some(&dir), &[], None, 0).unwrap();
        let (_stop_tx, mut stop_rx) = watch::channel(false);
        let reader = Arc::clone(&streams);
        let watching = tokio::spawn(async move {
            reader
                .watch_output(&spec, &filter, child, &mut stop_rx)
                .await
        });

        let mut polls = 0;
        let saved = loop {
            let found = std::fs::read_dir(files.join("streams"))
                .unwrap()
                .map(|e| e.unwrap().path())
                .find(|p| std::fs::metadata(p).is_ok_and(|m| m.len() > LINE_MAX as u64));
            if let Some(path) = found {
                break path;
            }
            assert!(!watching.is_finished(), "the job ended early");
            polls += 1;
            assert!(polls < 500, "no file while the line is still open");
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        let events = |ctx: &Arc<crate::jobs::Ctx>| {
            let store = ctx.store.clone();
            async move { store.read(|r| r.events_after(0, 10)).await.unwrap() }
        };
        assert!(
            events(&ctx).await.is_empty(),
            "no event before the line ends"
        );

        let opened = gate.clone();
        tokio::task::spawn_blocking(move || std::fs::write(opened, b"tail\n"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(watching.await.unwrap().as_deref(), Some("status 0"));
        let events = events(&ctx).await;
        assert_eq!(events.len(), 1, "{events:?}");
        let note = format!("a line of 204804 bytes, saved in {}", saved.display());
        assert!(format!("{:?}", events[0]).contains(&note), "{events:?}");
        assert_eq!(std::fs::metadata(&saved).unwrap().len(), 204_804);
    }
}
