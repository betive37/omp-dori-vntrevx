//! Worker protocol 2 over the real stream (docs/design/workers.md 2.2, 2.4): each remote OMP start
//! carries the hub's attempt token; the worker acknowledges the reaped exit once, on the attempt's
//! channel; and after a drop, a reconnected worker answers for each token: running, reaped or
//! unknown. `tests/support/fake-ssh` plays the worker's sshd and applies the forced command, so the
//! real `cataly worker serve` answers while this test plays the hub's end frame by frame. An older
//! worker is refused by the real hub.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

mod support;

use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use support::{BIN, TestHub, path_without_omp, patience};

const OPEN: u8 = 1;
const DATA: u8 = 2;
const EOF: u8 = 4;
const PING: u8 = 6;
const EXIT: u8 = 7;

fn wait() -> Duration {
    patience(Duration::from_secs(60))
}

/// A hub with worker `box` enrolled in both steps: the worker's own home, a fake OMP that runs
/// rpc-ui sessions, and the real forced command in its `authorized_keys`.
struct Enrolled {
    hub: TestHub,
    worker: PathBuf,
    hub_id: String,
    fingerprint: String,
}

impl Enrolled {
    fn new() -> Self {
        let mut hub = TestHub::new("");
        for fake in ["ssh", "ssh-keyscan"] {
            hub.install_fake(fake);
        }
        let hosts = hub.root.join("bin/ssh-data/hosts");
        std::fs::create_dir_all(&hosts).unwrap();
        let path = std::env::join_paths(
            std::iter::once(hub.root.join("bin")).chain(std::env::split_paths(&path_without_omp())),
        )
        .unwrap();
        hub.env.push(("PATH".into(), PathBuf::from(path)));
        let worker = hub.root.join("w-box");
        for dir in ["home", "config", "state", "run", "bin/omp-data"] {
            std::fs::create_dir_all(worker.join(dir)).unwrap();
        }
        let omp = worker.join("bin/omp");
        std::fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support/fake-omp"),
            &omp,
        )
        .unwrap();
        std::fs::set_permissions(&omp, std::os::unix::fs::PermissionsExt::from_mode(0o700))
            .unwrap();
        std::fs::write(worker.join("bin/omp-data/rpc"), "").unwrap();
        let made = Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-f"])
            .arg(worker.join("hostkey"))
            .status()
            .unwrap();
        assert!(made.success());
        std::fs::copy(worker.join("hostkey.pub"), hosts.join("box_22.pub")).unwrap();
        let path = std::env::join_paths(
            std::iter::once(worker.join("bin")).chain(std::env::split_paths(&path_without_omp())),
        )
        .unwrap();
        let env = format!(
            "HOME={}\nXDG_CONFIG_HOME={}\nXDG_STATE_HOME={}\nXDG_RUNTIME_DIR={}\nPATH={}\n",
            worker.join("home").display(),
            worker.join("config").display(),
            worker.join("state").display(),
            worker.join("run").display(),
            path.to_string_lossy()
        );
        std::fs::write(hosts.join("box_22"), &env).unwrap();

        let first = hub.cli(&["worker", "add", "dev@box"]);
        assert!(first.status.success(), "{first:?}");
        let text = String::from_utf8_lossy(&first.stdout).into_owned();
        let key = after(&text, "--hub-key '")
            .split('\'')
            .next()
            .unwrap()
            .to_string();
        let mut init = Command::new(BIN);
        init.env_clear();
        for line in env.lines() {
            if let Some((k, v)) = line.split_once('=') {
                init.env(k, v);
            }
        }
        let host_key = worker.join("hostkey.pub");
        let out = init
            .args(["worker", "init", "--hub-key", &key, "--host-key-file"])
            .arg(&host_key)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(out.status.success(), "{out:?}");
        let fingerprint = after(&String::from_utf8_lossy(&out.stdout), "--host-key ")
            .split_whitespace()
            .next()
            .unwrap()
            .to_string();
        let added = hub.cli(&["worker", "add", "dev@box", "--host-key", &fingerprint]);
        assert!(added.status.success(), "{added:?}");
        assert!(
            String::from_utf8_lossy(&added.stdout).contains("(compatible)"),
            "{added:?}"
        );
        Self {
            hub,
            worker,
            hub_id: after(&key, "cataly-hub-").to_string(),
            fingerprint,
        }
    }

    /// `<state>/worker/<hub>` on the worker.
    fn root(&self) -> PathBuf {
        self.worker.join("state/cataly/worker").join(&self.hub_id)
    }

    /// The PID of the `serve` that holds this hub's connection now.
    fn serve_pid(&self) -> String {
        std::fs::read_to_string(self.root().join("serve.lock"))
            .unwrap()
            .trim()
            .to_string()
    }
}

/// The text after `marker`.
fn after<'a>(text: &'a str, marker: &str) -> &'a str {
    let at = text
        .find(marker)
        .unwrap_or_else(|| panic!("no {marker} in {text}"));
    &text[at + marker.len()..]
}

fn kill(signal: &str, pid: &str) -> bool {
    Command::new("kill")
        .args([signal, pid])
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success()
}

/// Ends a process the test left running, even when an assertion failed first.
struct Reap(String);

impl Drop for Reap {
    fn drop(&mut self) {
        kill("-KILL", &self.0);
    }
}

struct Frame {
    channel: u32,
    kind: u8,
    payload: Vec<u8>,
}

/// The hub's end of one worker stream, through the fake `ssh` exactly as the hub starts it.
struct Stream {
    ssh: Child,
    input: Option<ChildStdin>,
    frames: mpsc::Receiver<Frame>,
    /// Frames that arrived while the test waited for something else.
    held: Vec<Frame>,
    /// Channel-0 bytes not yet read as answers.
    control: Vec<u8>,
    next: u64,
}

impl Stream {
    fn connect(e: &Enrolled) -> Self {
        let config = e.hub.root.join("config/cataly");
        let mut ssh = Command::new("/bin/sh")
            .arg(e.hub.root.join("bin/ssh"))
            .args(["-F", "none", "-T", "-i"])
            .arg(config.join("secrets/worker-box"))
            .args(["-p", "22", "-o"])
            .arg(format!(
                "UserKnownHostsFile={}",
                config.join("known_hosts").display()
            ))
            .args(["--", "dev@box", "cataly-worker-v1"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut out = ssh.stdout.take().unwrap();
        let (tx, frames) = mpsc::channel();
        std::thread::spawn(move || {
            loop {
                let mut header = [0u8; 9];
                if out.read_exact(&mut header).is_err() {
                    return;
                }
                let len = u32::from_be_bytes(header[0..4].try_into().unwrap());
                let channel = u32::from_be_bytes(header[4..8].try_into().unwrap());
                let mut payload = vec![0u8; usize::try_from(len).unwrap()];
                if out.read_exact(&mut payload).is_err() {
                    return;
                }
                let frame = Frame {
                    channel,
                    kind: header[8],
                    payload,
                };
                if tx.send(frame).is_err() {
                    return;
                }
            }
        });
        Self {
            input: ssh.stdin.take(),
            ssh,
            frames,
            held: Vec::new(),
            control: Vec::new(),
            next: 1,
        }
    }

    fn send(&mut self, channel: u32, kind: u8, payload: &[u8]) {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&u32::try_from(payload.len()).unwrap().to_be_bytes());
        bytes.extend_from_slice(&channel.to_be_bytes());
        bytes.push(kind);
        bytes.extend_from_slice(payload);
        let input = self.input.as_mut().unwrap();
        input.write_all(&bytes).unwrap();
        input.flush().unwrap();
    }

    /// Keeps a frame the test is not waiting for.
    fn keep(&mut self, frame: Frame) {
        match (frame.channel, frame.kind) {
            (0, DATA) => self.control.extend(frame.payload),
            (_, PING) => {}
            _ => self.held.push(frame),
        }
    }

    /// One worker-protocol call: its `ok`, or its error message.
    fn call(&mut self, method: &str, params: &Value) -> Result<Value, String> {
        let id = self.next;
        self.next += 1;
        let line = format!(
            "{}\n",
            json!({ "v": 1, "id": id, "method": method, "params": params })
        );
        self.send(0, DATA, line.as_bytes());
        let deadline = Instant::now() + wait();
        loop {
            while let Some(at) = self.control.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = self.control.drain(..=at).collect();
                let reply: Value = serde_json::from_slice(&line).unwrap();
                if reply["id"] == id {
                    return match reply.get("ok") {
                        Some(ok) => Ok(ok.clone()),
                        None => Err(reply["err"]["message"].as_str().unwrap().to_string()),
                    };
                }
            }
            let left = deadline.saturating_duration_since(Instant::now());
            let frame = self
                .frames
                .recv_timeout(left)
                .unwrap_or_else(|_| panic!("no answer to {method}"));
            self.keep(frame);
        }
    }

    /// The next frame `wanted` picks, held or still to come.
    fn take(&mut self, what: &str, wanted: impl Fn(&Frame) -> bool) -> Frame {
        if let Some(at) = self.held.iter().position(&wanted) {
            return self.held.remove(at);
        }
        let deadline = Instant::now() + wait();
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let frame = self
                .frames
                .recv_timeout(left)
                .unwrap_or_else(|_| panic!("no {what}"));
            if wanted(&frame) {
                return frame;
            }
            self.keep(frame);
        }
    }

    /// Starts the worker's fake OMP in `mode` for `attempt`, and waits for its channel; returns the
    /// channel and the PID.
    fn spawn(&mut self, attempt: &str, mode: &str, session: Option<&str>) -> (u32, String) {
        let reply = self
            .call(
                "spawn",
                &json!({ "argv": ["omp", "--mode", mode], "attempt": attempt, "session": session }),
            )
            .unwrap();
        assert_eq!(reply["attempt"], attempt, "{reply}");
        let channel = u32::try_from(reply["channel"].as_u64().unwrap()).unwrap();
        let open = self.take("open frame", |f| f.channel == channel && f.kind == OPEN);
        let header: Value = serde_json::from_slice(&open.payload).unwrap();
        assert_eq!(
            (header["kind"].as_str(), header["attempt"].as_str()),
            (Some("spawn"), Some(attempt))
        );
        (channel, reply["pid"].as_u64().unwrap().to_string())
    }

    /// Waits for the rpc-ui ready frame of the OMP on `channel`.
    fn ready(&mut self, channel: u32) {
        self.take("ready frame", |f| {
            f.channel == channel
                && f.kind == DATA
                && String::from_utf8_lossy(&f.payload).contains("\"type\":\"ready\"")
        });
    }

    /// The exit acknowledgement on `channel`.
    fn exit_of(&mut self, channel: u32) -> Value {
        let frame = self.take("exit acknowledgement", |f| {
            f.channel == channel && f.kind == EXIT
        });
        serde_json::from_slice(&frame.payload).unwrap()
    }

    /// Whether no further acknowledgement arrives on `channel` for `quiet`.
    fn no_more_exits(&mut self, channel: u32, quiet: Duration) -> bool {
        let deadline = Instant::now() + quiet;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.frames.recv_timeout(left) {
                Ok(frame) if frame.channel == channel && frame.kind == EXIT => return false,
                Ok(frame) => self.keep(frame),
                Err(_) => break,
            }
        }
        !self
            .held
            .iter()
            .any(|f| f.channel == channel && f.kind == EXIT)
    }

    fn states(&mut self, tokens: &[&str]) -> Value {
        self.call("attempts", &json!({ "attempts": tokens }))
            .unwrap()["attempts"]
            .clone()
    }

    /// Ends the stream as sshd does once it noticed the drop: the worker's input ends. Waits until
    /// that `serve` ended.
    fn hang_up(mut self) {
        drop(self.input.take());
        let deadline = Instant::now() + wait();
        while self.ssh.try_wait().unwrap().is_none() {
            assert!(
                Instant::now() < deadline,
                "serve did not end after its input"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        drop(self.input.take());
        let _ = self.ssh.kill();
        let _ = self.ssh.wait();
    }
}

/// A normal exit and a kill are each acknowledged once, on the attempt's channel, with the exit
/// code or the signal; the worker keeps the record `attempts` answers from. A start without a token,
/// or with one already used, is refused; a token never recorded is unknown.
#[test]
fn each_attempt_is_acknowledged_once_with_its_exit() {
    let e = Enrolled::new();
    let mut s = Stream::connect(&e);
    assert_eq!(s.call("hello", &json!({})).unwrap()["protocol"], 2);
    let tokenless = s
        .call("spawn", &json!({ "argv": ["omp", "--mode", "rpc-ui"] }))
        .unwrap_err();
    assert!(tokenless.contains("attempt token"), "{tokenless}");

    let (normal, _) = s.spawn("a1", "rpc-ui", Some("s-1"));
    s.ready(normal);
    // The hub ends the OMP's input; the acknowledgement comes once the worker reaped it.
    s.send(normal, EOF, &[]);
    assert_eq!(
        s.exit_of(normal),
        json!({ "attempt": "a1", "state": "reaped", "exit": { "code": 0 }, "lease": "free" })
    );
    assert!(s.no_more_exits(normal, Duration::from_secs(1)));
    let reused = s
        .call(
            "spawn",
            &json!({ "argv": ["omp", "--mode", "rpc-ui"], "attempt": "a1" }),
        )
        .unwrap_err();
    assert!(reused.contains("already recorded"), "{reused}");

    let (killed, _) = s.spawn("a2", "rpc-ui", None);
    s.ready(killed);
    s.call("signal", &json!({ "channel": killed, "signal": "KILL" }))
        .unwrap();
    assert_eq!(
        s.exit_of(killed),
        json!({ "attempt": "a2", "state": "reaped", "exit": { "signal": 9 }, "lease": "unknown" })
    );
    assert!(s.no_more_exits(killed, Duration::from_secs(1)));

    let states = s.states(&["a1", "a2", "never"]);
    assert_eq!(
        states["a1"],
        json!({ "state": "reaped", "exit": { "code": 0 }, "lease": "free" })
    );
    assert_eq!(
        states["a2"],
        json!({ "state": "reaped", "exit": { "signal": 9 }, "lease": "unknown" })
    );
    assert_eq!(states["never"]["state"], "unknown", "{states}");
    assert!(e.root().join("attempts/a1.json").exists());
}

/// A drop before the acknowledgement leaves the hub nothing but the token; the reconnected worker
/// answers for it: reaped once the old `serve` closed the OMP (on its input's end, or on a newer
/// `serve`'s TERM), running while the process of a crashed `serve` still lives (never killed or
/// adopted), and gone once it ended. A token the worker never recorded is unknown.
#[test]
fn a_drop_before_the_acknowledgement_is_reconciled_by_token() {
    let e = Enrolled::new();
    let mut s = Stream::connect(&e);
    let (first, _) = s.spawn("b1", "rpc-ui", None);
    s.ready(first);
    s.hang_up();

    let mut s = Stream::connect(&e);
    assert_eq!(
        s.states(&["b1"])["b1"],
        json!({ "state": "reaped", "exit": { "code": 0 }, "lease": "unknown" })
    );
    // Half open: this stream stays, a newer connection takes over with TERM.
    let (second, _) = s.spawn("b2", "rpc-ui", None);
    s.ready(second);
    let mut newer = Stream::connect(&e);
    assert_eq!(
        newer.states(&["b2"])["b2"],
        json!({ "state": "reaped", "exit": { "code": 0 }, "lease": "unknown" })
    );
    drop(s);

    // A crash: SIGKILL ends `serve` and leaves its OMP running.
    std::fs::write(e.worker.join("bin/omp-data/tui"), "").unwrap();
    let (_, pid) = newer.spawn("b3", "tui", None);
    let orphan = Reap(pid.clone());
    assert!(kill("-KILL", &e.serve_pid()));
    drop(newer);
    let mut s = Stream::connect(&e);
    let states = s.states(&["b3", "never"]);
    assert_eq!(
        states["b3"],
        json!({ "state": "running", "pid": pid.parse::<u64>().unwrap() })
    );
    assert_eq!(states["never"]["state"], "unknown", "{states}");
    assert!(
        kill("-0", &pid),
        "the worker never kills an earlier attempt's process"
    );
    drop(orphan);
    let deadline = Instant::now() + wait();
    loop {
        let state = s.states(&["b3"])["b3"].clone();
        if state["state"] == "reaped" {
            assert_eq!(
                state,
                json!({ "state": "reaped", "exit": "gone", "lease": "unknown" })
            );
            break;
        }
        assert_eq!(state["state"], "running", "{state}");
        assert!(Instant::now() < deadline, "b3 still running");
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// A worker that still speaks protocol 1 is refused by the hub with the existing clear message, and
/// nothing is enrolled: a v1 `spawn` has no attempt token and its channel no acknowledgement.
#[test]
fn an_older_worker_is_refused() {
    let e = Enrolled::new();
    // An older `cataly worker serve`: it answers the hub's hello as protocol 1 did, then waits.
    let old = e.worker.join("old-worker.sh");
    std::fs::write(
        &old,
        r#"reply='{"v":1,"id":1,"ok":{"protocol":1,"bridge":1,"version":"0.1.0","os":"linux","arch":"x86_64"}}'
dd bs=9 count=1 >/dev/null 2>&1
n=$((${#reply} + 1))
byte() { printf "\\$(printf '%03o' "$1")"; }
byte 0; byte 0; byte $((n / 256)); byte $((n % 256)); byte 0; byte 0; byte 0; byte 0; byte 2
printf '%s\n' "$reply"
cat >/dev/null
"#,
    )
    .unwrap();
    let keys = e.worker.join("home/.ssh/authorized_keys");
    let line = std::fs::read_to_string(&keys).unwrap();
    let forced = format!("command=\"{BIN} worker serve --hub {}\"", e.hub_id);
    assert!(line.contains(&forced), "{line}");
    std::fs::write(
        &keys,
        line.replace(&forced, &format!("command=\"/bin/sh {}\"", old.display())),
    )
    .unwrap();
    let refused = e
        .hub
        .cli(&["worker", "add", "dev@box", "--host-key", &e.fingerprint]);
    assert!(!refused.status.success(), "{refused:?}");
    let text = String::from_utf8_lossy(&refused.stderr);
    assert!(
        text.contains(
            "box: incompatible: the cataly on box speaks worker protocol 1 where this hub speaks 2; \
             run cataly update on box; nothing was enrolled"
        ),
        "{text}"
    );
}
