//! Inspection and interactive planning are distinct stock launch surfaces.
use std::io::Write;

use serde_json::Value;

use crate::hosted_harness::{Hosted, WAIT, enabled};
use crate::optional::{main_surface, print_profile};
use crate::policy::{self, Role};

#[test]
fn reviewer_and_plan_surfaces_follow_the_generated_policy() {
    if !enabled() {
        return;
    }
    let reviewer = Hosted::new("headless", "");
    let surface = print_profile(&reviewer, Role::Reviewer, &[]);
    surface.witness(Role::Reviewer, "print/no-session reviewer");
    for name in policy::selection(Role::Reviewer).unwrap().split(',') {
        assert!(surface.tools.contains(name), "{surface:?}");
    }
    assert!(!surface.tools.contains("bash"), "{surface:?}");

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
    let transition: Value = plan.hub.until(WAIT, || {
        let text = std::fs::read_to_string(plan.hub.root.join("work/plan-transition.json")).ok()?;
        serde_json::from_str(&text).ok()
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
