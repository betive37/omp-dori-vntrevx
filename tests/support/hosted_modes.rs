//! Inspection and interactive planning are distinct stock launch surfaces.
use std::io::Write;

use serde_json::{Value, json};

use crate::hosted_harness::{Hosted, WAIT, enabled};
use crate::optional::main_surface;
use crate::policy::{self, Role};

#[test]
fn builtin_reviewer_uses_the_generated_policy() {
    if !enabled() {
        return;
    }
    let mut reviewer = Hosted::new("headless", "");
    reviewer.hub.install_fake("gh");
    let mut path = reviewer.hub.root.join("bin").into_os_string();
    path.push(":");
    path.push(crate::support::path_without_omp());
    reviewer.hub.env.push(("PATH".into(), path.into()));
    std::fs::write(
        reviewer.hub.root.join("agent/models.yml"),
        crate::support::model::models_yml(reviewer.model.port, &["primary", "reviewer"]),
    )
    .unwrap();
    let head = "a".repeat(40);
    reviewer.hub.fixture("gh", "repos_o_r_pulls_7.json",
        Some(&json!({"head":{"sha":head},"title":"Policy review","body":"Surface fixture","changed_files":0}).to_string()));
    reviewer
        .hub
        .fixture("gh", "repos_o_r_pulls_7_files.json", Some("[]"));
    reviewer.start();
    let from = reviewer.model.bodies().len();
    let result = reviewer.lane("review", &json!({"pr":"o/r#7","model":"fake/reviewer"}));
    assert!(result.as_str().unwrap().contains("approve"), "{result}");
    let surface = main_surface(&reviewer, from);
    surface.witness(Role::Reviewer, "print/no-session reviewer");
    for name in policy::selection(Role::Reviewer).unwrap().split(',') {
        assert!(surface.tools.contains(name), "{surface:?}");
    }
    assert!(!surface.tools.contains("bash"), "{surface:?}");
    let metadata = reviewer
        .model
        .bodies()
        .iter()
        .filter_map(|body| serde_json::from_str::<Value>(body["user"].as_str()?).ok())
        .find(|meta| meta["session"] == surface.agent.as_ref().unwrap().session)
        .unwrap();
    assert_eq!(
        metadata["hostedGoalEnabled"], false,
        "reviewer used the wrong effective policy"
    );
    assert!(reviewer.hub.stop().success());
}

#[test]
fn active_plan_mode_keeps_the_hosted_policy() {
    if !enabled() {
        return;
    }

    let mut plan = Hosted::new(
        "tern",
        "modelRoles:\n  smol: fake/primary\n  plan: fake/primary\n",
    );
    // omp://extensions.md: modes cannot transition during session_start restoration. Invoke a
    // documented extension command through the actual terminal after the hub reports it ready.
    plan.extension(
        r"
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default function(pi: ExtensionAPI) {
  pi.registerCommand('contract-plan', { handler: async (_args, ctx) => {
    const result = await ctx.sessionModes?.set({ mode: 'plan', action: 'enter' });
    writeFileSync(join(ctx.cwd, 'plan-transition.json'), JSON.stringify({ result, state: ctx.sessionModes?.getState() }));
  }});
}
",
    );
    let fifo = plan.hub.root.join("bin/tern-data/input");
    assert!(
        std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    let writer =
        std::thread::spawn(move || std::fs::OpenOptions::new().write(true).open(fifo).unwrap());
    plan.start();
    let mut input = writer.join().unwrap();
    input.write_all(b"/contract-plan\r").unwrap();
    input.flush().unwrap();
    // Stock 19.1.1 can leave the first command in the editor after its Enter (seen with the
    // slash-command completion open); press Enter again while no transition is recorded. On an
    // empty editor Enter does nothing.
    let mut pressed = std::time::Instant::now();
    let transition: Value = plan.hub.until(WAIT, || {
        let text = std::fs::read_to_string(plan.hub.root.join("work/plan-transition.json")).ok();
        if text.is_none() && pressed.elapsed() > std::time::Duration::from_secs(3) {
            input.write_all(b"\r").unwrap();
            input.flush().unwrap();
            pressed = std::time::Instant::now();
        }
        serde_json::from_str(&text?).ok()
    });
    assert_eq!(transition["result"]["ok"], true, "{transition}");
    assert_eq!(
        transition["state"]["plan"]["status"], "active",
        "{transition}"
    );
    let from = plan.lead("Plan-mode capability witness");
    let surface = main_surface(&plan, from);
    surface.witness(Role::Lead, "read-only plan mode");
    assert!(plan.hub.stop().success());
}
