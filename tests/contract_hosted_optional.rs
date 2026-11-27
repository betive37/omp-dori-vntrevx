//! Conditional stock capabilities and trusted integrations, always with isolated fake inference.
#[path = "support/hosted_children.rs"]
mod children;
#[expect(
    dead_code,
    reason = "shared fixtures also serve the core policy contract binary"
)]
#[path = "support/hosted_controls.rs"]
mod hosted_controls;
#[path = "support/hosted_harness.rs"]
mod hosted_harness;
#[expect(
    dead_code,
    reason = "the core contract owns aggregate multi-role auditing"
)]
#[path = "support/hosted_surface.rs"]
mod hosted_surface;
#[path = "support/hosted_modes.rs"]
mod modes;
#[path = "support/hosted_optional.rs"]
mod optional;
#[path = "../src/omp/tools.rs"]
mod policy;
mod support;

use hosted_controls::Control;
use hosted_harness::{Hosted, WAIT, enabled};
use hosted_surface::{Purpose, Surface, Violation};
use optional::{browser_fixture, main_surface, print_profile};
use policy::Role;
use serde_json::json;

#[test]
fn optional_stock_features_are_classified_and_owner_disables_survive() {
    if !enabled() {
        return;
    }
    let expected = [
        "ast_grep",
        "github",
        "checkpoint",
        "rewind",
        "context_notes",
        "new_context",
        "manage_skill",
        "security_scan",
        "think",
        "find",
        "learn",
    ];
    for backend in ["off", "local", "mnemopi"] {
        let on = backend != "off";
        let settings = json!({
            "startup": {"setupWizard": false},
            "tools": {"commands": false}, "astGrep": {"enabled": on}, "github": {"enabled": on},
            "checkpoint": {"enabled": on}, "compaction": {"experimentalContextManagement": on},
            "autolearn": {"enabled": on}, "security": {"enabled": on}, "externalThinking": on,
            "debug": {"enabled": on}, "lsp": {"enabled": on}, "find": {"enabled": if on { "on" } else { "off" }},
            "memory": {"backend": backend},
            "modelRoles": {"default":"fake/primary", "smol":"fake/primary", "slow":"fake/primary", "tiny":"fake/primary", "memory":"fake/primary"},
        });
        let host = Hosted::new("headless", "");
        std::fs::write(host.hub.root.join("agent/config.yml"), settings.to_string()).unwrap();
        let models = json!({"providers":{"fake":{
            "baseUrl":format!("http://127.0.0.1:{}/v1", host.model.port),
            "api":"anthropic-messages", "auth":"none",
            "models":[{"id":"primary","name":"Reasoning fake","reasoning":true,"input":["text"],
                "contextWindow":32768,"maxTokens":16384}],
        }}});
        std::fs::write(host.hub.root.join("agent/models.yml"), models.to_string()).unwrap();
        let surface = print_profile(&host, Role::Lead, &[]);
        surface.witness(Role::Lead, &format!("optional enabled={on}"));
        for name in expected.iter().chain(["debug", "lsp"].iter()) {
            assert_eq!(
                surface.tools.contains(*name),
                on,
                "{name}, enabled={on}: {surface:?}"
            );
        }
        for name in ["retain", "recall", "reflect", "memory_edit"] {
            assert_eq!(
                surface.tools.contains(name),
                backend == "mnemopi",
                "{backend}: {surface:?}"
            );
        }
    }
}

#[test]
fn browser_replacement_and_delayed_mcp_inventory_reach_real_status() {
    if !enabled() {
        return;
    }
    let native = Hosted::new("headless", "mcp:\n  shared: false\n");
    browser_fixture(&native, true);
    native.standalone(Control::DenyRetained, "Native browser reference profile");
    let surface = main_surface(&native, 0);
    assert!(surface.tools.contains("eval"), "{surface:?}");
    assert!(
        !surface
            .tools
            .union(&surface.commands)
            .any(|name| name.starts_with("mcp__browser")),
        "{surface:?}"
    );
    assert!(
        !native.hub.root.join("browser-started").exists(),
        "native eval should replace browser MCP before it starts"
    );

    let mut hosted = Hosted::new("headless", "mcp:\n  shared: false\n  startupTimeoutMs: 1\n");
    let gate = browser_fixture(&hosted, false);
    hosted.start();
    let from = hosted.lead("Before delayed MCP discovery");
    let before = main_surface(&hosted, from);
    before.witness(Role::Lead, "before delayed MCP discovery");
    assert!(
        !before
            .tools
            .union(&before.commands)
            .any(|name| name.starts_with("mcp__browser"))
    );
    let session = &before.agent.as_ref().unwrap().session;
    let initial = hosted.hub.until(WAIT, || {
        let status = hosted.hub.json(&["lead", "status", "--json"]);
        status["tools"]
            .as_array()?
            .iter()
            .find(|report| report["session"] == *session)
            .map(|report| report["nonstock"].clone())
    });
    assert_eq!(
        initial,
        json!([]),
        "stock tools misreported as integrations"
    );
    hosted.hub.until(WAIT, || {
        hosted
            .hub
            .root
            .join("browser-started")
            .exists()
            .then_some(())
    });
    std::fs::write(gate, "release tools/list").unwrap();
    let name = hosted.hub.until(WAIT, || {
        let status = hosted.hub.json(&["lead", "status", "--json"]);
        let report = status["tools"]
            .as_array()?
            .iter()
            .find(|report| report["session"] == *session)?;
        let names = report["nonstock"].as_array()?;
        let name = names
            .iter()
            .filter_map(serde_json::Value::as_str)
            .find(|name| name.starts_with("mcp__browser") && name.ends_with("inspect"))?;
        assert_eq!(
            names.as_slice(),
            [json!(name)],
            "unexpected non-stock inventory"
        );
        Some(name.to_owned())
    });
    let from = hosted.lead("After delayed MCP discovery");
    let mut after = main_surface(&hosted, from);
    let direct = after.tools.remove(&name);
    let mounted = after.commands.remove(&name);
    assert!(
        direct || mounted,
        "reported live tool absent from model: {after:?}"
    );
    after.witness(Role::Lead, "stock surface alongside trusted browser MCP");
    let status = hosted.hub.cli(&["status"]);
    assert!(String::from_utf8_lossy(&status.stdout).contains(&name));
    assert!(hosted.hub.stop().success());
}

#[test]
fn public_stock_catalog_has_no_unclassified_optional_name() {
    if !enabled() {
        return;
    }
    let host = Hosted::new("headless", "");
    let help = host.stock(&["--help"]);
    let catalog = help
        .split("Built-in Tools (names accepted by --tools):")
        .nth(1)
        .expect("public built-in catalog");
    let mut names = std::collections::BTreeSet::new();
    for line in catalog
        .lines()
        .take_while(|line| !line.starts_with("Plugin Options:"))
    {
        if let Some((name, _)) = line.trim().split_once(" - ") {
            names.insert(name.trim().to_owned());
        }
    }
    assert!(
        names.contains("eval") && names.contains("memory_edit"),
        "incomplete public catalog: {names:?}"
    );
    let surface = Surface {
        purpose: Purpose::Coding,
        agent: None,
        tools: names,
        aliases: std::collections::BTreeSet::new(),
        commands: std::collections::BTreeSet::new(),
        references: std::collections::BTreeSet::new(),
    };
    assert!(
        !surface
            .violations(Role::Lead)
            .iter()
            .any(|v| matches!(v, Violation::Unknown(_))),
        "{surface:?}"
    );
}
