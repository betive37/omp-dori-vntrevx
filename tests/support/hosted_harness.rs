//! Isolated stock OMP sessions; only the loopback fake model receives requests.
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Value, json};

use crate::support::TestHub;
use crate::support::model::{FakeModel, models_yml};

pub(crate) const WAIT: Duration = Duration::from_secs(120);
pub(crate) const OBSERVER: &str = r"
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { lookup } from '@oh-my-pi/pi-coding-agent/config/registry';
export default function (pi: ExtensionAPI) {
  pi.on('before_provider_request', (event, ctx) => {
    if (typeof event.payload !== 'object' || event.payload === null) return;
    return { ...event.payload, user: JSON.stringify({ ...ctx.agent, session: ctx.sessionManager.getSessionId(),
      hostedGoalEnabled: lookup('goal.enabled')?.get(pi.pi.settings) }) };
  });
}
";

pub(crate) fn enabled() -> bool {
    let enabled = std::env::var("CATALY_CONTRACT_OMP").as_deref() == Ok("1");
    if !enabled {
        eprintln!("skipped: set CATALY_CONTRACT_OMP=1 to run the OMP contract suite");
    }
    enabled
}

pub(crate) fn installed_omp() -> PathBuf {
    std::env::var_os("CATALY_CONTRACT_OMP_PATH").map_or_else(
        || {
            std::env::split_paths(&std::env::var_os("PATH").expect("PATH"))
                .map(|dir| dir.join("omp"))
                .find(|p| p.is_file())
                .expect("installed stock omp")
        },
        PathBuf::from,
    )
}

pub(crate) struct Hosted {
    pub(crate) hub: TestHub,
    pub(crate) model: FakeModel,
}

impl Hosted {
    pub(crate) fn new(runtime: &str, settings: &str) -> Self {
        let mut hub = TestHub::new("");
        let agent = hub.root.join("agent");
        let work = hub.root.join("work");
        std::fs::create_dir_all(agent.join("extensions")).unwrap();
        std::fs::create_dir_all(work.join(".omp")).unwrap();
        let model = FakeModel::start();
        std::fs::write(
            agent.join("models.yml"),
            models_yml(model.port, &["primary"]),
        )
        .unwrap();
        std::fs::write(
            agent.join("config.yml"),
            format!("startup:\n  setupWizard: false\n{settings}"),
        )
        .unwrap();
        std::fs::write(agent.join("extensions/witness.ts"), OBSERVER).unwrap();
        let tern = hub.install_fake("tern");
        hub.env.push(("PI_CODING_AGENT_DIR".into(), agent));
        hub.write_config(&format!(
            "[omp]\npath = \"{}\"\n[sessions]\nruntime = \"{runtime}\"\ntern = \"{}\"\n\
             extra_flags = [\"--no-skills\", \"--no-rules\", \"--no-context-files\"]\n\
             [lead]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n\
             [lanes]\nmodel = \"fake/primary\"\ncwd = \"{}\"\nobjection = \"2s\"\n\
             [lanes.shell]\ndeny = [\"echo cataly-denied.*\"]\n",
            installed_omp().display(),
            tern.display(),
            work.display(),
            work.display(),
        ));
        Self { hub, model }
    }

    pub(crate) fn start(&mut self) {
        self.hub.start();
        self.settled();
    }

    pub(crate) fn settled(&self) {
        self.hub.until(WAIT, || {
            let status = self.hub.json(&["lead", "status", "--json"]);
            (status["phase"] == "live"
                && status["bridge"]["connected"] == true
                && status["session"]["status"] == "idle"
                && status["sent"] == 0
                && status["waiting"] == 0)
                .then_some(())
        });
    }

    pub(crate) fn lead(&self, text: &str) -> usize {
        self.settled();
        let before = self.model.bodies().len();
        let out = self.hub.cli(&["lead", "send", text]);
        assert!(out.status.success(), "{out:?}");
        self.hub
            .until(WAIT, || (self.model.bodies().len() > before).then_some(()));
        before
    }

    pub(crate) fn lane(&self, op: &str, params: &Value) -> Value {
        self.hub
            .json(&["lane", op, "--json", "--params", &params.to_string()])
    }

    pub(crate) fn open(&self, key: &str, look_only: bool) {
        self.lane(
            "open",
            &json!({
                "key": key, "title": key, "brief": format!("Witness {key}."),
                "look_only": look_only, "checks": [{"kind": "command", "argv": ["true"]}],
            }),
        );
        self.hub.until(WAIT, || {
            let read = self.lane("read", &json!({"key": key, "count": 1}));
            (read["goal"]["status"]
                .as_str()
                .is_some_and(|s| s.eq_ignore_ascii_case("active")))
            .then_some(())
        });
    }

    pub(crate) fn lane_session(&self, key: &str) -> String {
        let lanes = self.lane("list", &json!({"all": true}));
        lanes
            .as_array()
            .unwrap()
            .iter()
            .find(|lane| lane["key"] == key)
            .unwrap()["session_id"]
            .as_str()
            .expect("live lane session id")
            .to_owned()
    }

    pub(crate) fn send(&self, key: &str, text: &str) -> usize {
        let before = self.model.bodies().len();
        self.lane("send", &json!({"key": key, "text": text}));
        before
    }

    pub(crate) fn approve(&self, key: &str) {
        let read = self.lane("read", &json!({"key": key, "count": 1}));
        for dialog in read["dialogs"].as_array().into_iter().flatten() {
            self.lane(
                "answer",
                &json!({"key": key, "dialog": dialog["id"],
                "answer": {"value": "Approve"}}),
            );
        }
    }

    pub(crate) fn result(&self, from: usize, tool: &str, lane: Option<&str>) -> String {
        self.hub.until(WAIT, || {
            let result = self
                .model
                .bodies()
                .iter()
                .skip(from)
                .find_map(|body| tool_result(body, tool, from));
            if result.is_none()
                && let Some(key) = lane
            {
                self.approve(key);
            }
            result
        })
    }

    pub(crate) fn child(&self, key: &str, name: &str, call: &str) -> usize {
        let task = json!({"context": "Stock hosted-tool contract.", "tasks": [{
            "name": name, "solutionSpace": "given", "task": call,
        }]});
        self.send(key, &format!("Spawn the named witness.\nCALL task {task}"))
    }
}

pub(crate) fn tool_result(body: &Value, tool: &str, from: usize) -> Option<String> {
    let messages = body["messages"].as_array()?;
    for call in messages.iter().rev() {
        for entry in call["tool_calls"].as_array().into_iter().flatten() {
            // A later request repeats earlier history. Bind the result to a call the scripted
            // fake issued after this action, not the first same-named tool in that history.
            let current = entry["id"]
                .as_str()?
                .strip_prefix("call_named_")
                .and_then(|number| number.parse::<usize>().ok())
                .is_some_and(|number| number > from);
            if current && entry["function"]["name"] == tool {
                let result = messages.iter().find(|message| {
                    message["role"] == "tool" && message["tool_call_id"] == entry["id"]
                })?;
                return Some(result["content"].to_string());
            }
        }
    }
    None
}
