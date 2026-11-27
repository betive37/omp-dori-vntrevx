//! Negative controls change only disposable harness configuration, never production code.
use std::process::{Child, Command, Stdio};

use serde_json::{Value, json};

use crate::hosted_harness::{Hosted, WAIT, installed_omp};
use crate::policy::{self, Role};
use crate::support::path_without_omp;

pub(crate) const UNKNOWN: &str = "unclassified_stock_fixture";
pub(crate) const UNKNOWN_EXTENSION: &str = r"
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'unclassified_stock_fixture', label: 'Unclassified stock fixture',
    description: 'A future stock tool requiring a policy decision.',
    parameters: pi.zod.object({}),
    async execute() { return { content: [{ type: 'text', text: 'fixture' }], details: {} }; }
  });
}
";

// Remove the two hiding controls at the task-construction boundary. The child is still a real
// OMP task, with the real bridge and parent session; no request-body or fake-model substitution.
// Public API: omp://extensions.md, "Runtime setting overrides". Registry handles replaced
// string-path settings in OMP 18.3; lookup(id).override(scope, value) is the documented interface.
pub(crate) const CHILD_POLICY_CONTROL: &str = r"
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { lookup } from '@oh-my-pi/pi-coding-agent/config/registry';
export default function (pi: ExtensionAPI) {
  pi.on('tool_call', (event, ctx) => {
    if (ctx.agent.kind === 'main' && event.toolName === 'task') {
      lookup('eval.py')?.override(pi.pi.settings, true);
      lookup('eval.js')?.override(pi.pi.settings, true);
    }
  });
}
";

#[derive(Clone, Copy, Debug)]
pub(crate) enum Control {
    PythonGate,
    JavascriptGate,
    DenyRetained,
    DenyRemoved,
}

struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        if self.0.try_wait().unwrap().is_none() {
            self.0.kill().unwrap();
            self.0.wait().unwrap();
        }
    }
}

impl Hosted {
    pub(crate) fn extension(&self, source: &str) {
        std::fs::write(self.hub.root.join("agent/extensions/control.ts"), source).unwrap();
    }

    pub(crate) fn standalone(&self, control: Control, prompt: &str) {
        let mut overlay = serde_json::Map::new();
        policy::apply(&mut overlay, Role::Lead);
        let mut overlay = Value::Object(overlay);
        match control {
            Control::PythonGate => {
                overlay["eval"].as_object_mut().unwrap().remove("py");
            }
            Control::JavascriptGate => {
                overlay["eval"].as_object_mut().unwrap().remove("js");
            }
            Control::DenyRetained => {
                overlay["eval"] = json!({"py": false, "js": true});
            }
            Control::DenyRemoved => {
                // Availability is intentionally held open in both deny arms: otherwise removal
                // of denial is masked by not-found, and the defence-in-depth test is vacuous.
                overlay["eval"] = json!({"py": false, "js": true});
                overlay["tools"]["approval"]
                    .as_object_mut()
                    .unwrap()
                    .remove("eval");
            }
        }
        let config = self.hub.root.join("control.json");
        std::fs::write(&config, overlay.to_string()).unwrap();
        self.stock(&[
            "--print",
            "--no-session",
            "--no-skills",
            "--no-rules",
            "--no-context-files",
            "--model",
            "fake/primary",
            "--config",
            config.to_str().unwrap(),
            prompt,
        ]);
    }

    pub(crate) fn stock(&self, args: &[&str]) -> String {
        let stdout = self.hub.root.join("stock.stdout");
        let stderr = self.hub.root.join("stock.stderr");
        let mut command = Command::new(installed_omp());
        command
            .env_clear()
            .env("PATH", path_without_omp())
            .env("HOME", self.hub.root.join("home"))
            .env("XDG_CONFIG_HOME", self.hub.root.join("config"))
            .env("XDG_STATE_HOME", self.hub.root.join("state"))
            .env("PI_CODING_AGENT_DIR", self.hub.root.join("agent"))
            .current_dir(self.hub.root.join("work"))
            .args(args)
            .stdin(Stdio::null())
            .stdout(std::fs::File::create(&stdout).unwrap())
            .stderr(std::fs::File::create(&stderr).unwrap());
        let mut running = Running(command.spawn().unwrap());
        let status = self.hub.until(WAIT, || running.0.try_wait().unwrap());
        let stdout = std::fs::read_to_string(stdout).unwrap();
        assert!(
            status.success(),
            "stock {args:?}: {stdout}\n{}",
            std::fs::read_to_string(stderr).unwrap()
        );
        stdout
    }
}

pub(crate) fn eval_call(marker: &std::path::Path, language: &str) -> String {
    let path = serde_json::to_string(marker.to_str().unwrap()).unwrap();
    let code = match language {
        "js" => format!("await Bun.write({path}, 'executed')"),
        "py" => format!("from pathlib import Path\nPath({path}).write_text('executed')"),
        _ => panic!("unknown test kernel"),
    };
    format!("CALL eval {}", json!({"language": language, "code": code}))
}
