//! Stock OMP policy contract at the real provider boundary. No paid models or owner profile.
//! Run: `CATALY_CONTRACT_OMP=1 cargo test --release --test contract_hosted_tools -- --nocapture`
#[path = "support/hosted_controls.rs"]
mod hosted_controls;
#[path = "support/hosted_harness.rs"]
mod hosted_harness;
#[path = "support/hosted_red.rs"]
mod hosted_red;
#[path = "support/hosted_surface.rs"]
mod hosted_surface;
#[path = "../src/omp/tools.rs"]
mod policy;
#[path = "support/hosted_schema.rs"]
mod schema;
mod support;

use hosted_controls::eval_call;
use hosted_harness::{Hosted, WAIT, enabled};
use hosted_surface::{Purpose, Surface, Violation, audit, execution_violations};
use policy::{LANE_BRIDGE, LEAD_BRIDGE, Role};
use serde_json::Value;

#[derive(Clone, Copy)]
enum Witness<'a> {
    Lead,
    Lane(&'a str),
    Child,
}

fn request(host: &Hosted, from: usize, target: Witness<'_>) -> Surface {
    let session = match target {
        Witness::Lane(key) => Some(host.lane_session(key)),
        Witness::Lead | Witness::Child => None,
    };
    host.hub.until(WAIT, || {
        host.model
            .bodies()
            .iter()
            .skip(from)
            .map(Surface::parse)
            .find(|surface| {
                surface.purpose == Purpose::Coding
                    && match target {
                        Witness::Lead => surface.tools.contains(LEAD_BRIDGE.name),
                        Witness::Lane(_) => {
                            surface.tools.contains(LANE_BRIDGE.name)
                                && surface
                                    .agent
                                    .as_ref()
                                    .is_some_and(|agent| Some(&agent.session) == session.as_ref())
                        }
                        Witness::Child => surface
                            .agent
                            .as_ref()
                            .is_some_and(|agent| agent.kind == "sub"),
                    }
            })
    })
}

fn headless_profile(commands: bool) {
    let mut host = Hosted::new("headless", "");
    // Both lower-precedence layers deliberately disagree with the hosted hard policy.
    let attempt = format!(
        "eval:\n  py: true\n  js: true\narchive:\n  enabled: true\ntools:\n  commands: {commands}\n  approval:\n    eval: allow\n"
    );
    std::fs::write(host.hub.root.join("agent/config.yml"), &attempt).unwrap();
    std::fs::write(host.hub.root.join("work/.omp/config.yml"), &attempt).unwrap();
    host.start();
    let from = host.lead("Lead capability witness");
    let lead = request(&host, from, Witness::Lead);
    lead.witness(Role::Lead, &format!("lead commands={commands}"));
    for name in ["ast_edit", "debug", "lsp"] {
        assert!(
            if commands {
                lead.commands.contains(name)
            } else {
                lead.tools.contains(name)
            },
            "missing {name} on expected surface: {lead:#?}"
        );
    }
    for language in ["py", "js"] {
        let marker = host.hub.root.join(format!("lead-{language}-executed"));
        let from = host.lead(&eval_call(&marker, language));
        let result = host.result(from, "eval", None);
        assert_eq!(
            execution_violations(&result, marker.exists()),
            [],
            "lead {language}: {result}"
        );
    }
    let before = host.model.bodies().len();
    host.open("active-witness", false);
    request(&host, before, Witness::Lane("active-witness")).witness(Role::Lane, "lane initial");
    let from = host.send("active-witness", "Witness after goal activation");
    let lane = request(&host, from, Witness::Lane("active-witness"));
    assert!(
        lane.tools.contains("goal"),
        "lane after activation: {lane:?}"
    );
    lane.witness(Role::Lane, "lane active goal");
    let goal = host.lead("CALL goal {\"op\":\"set\",\"text\":\"hidden-lead-goal-marker\"}");
    let result = host.result(goal, "goal", None);
    assert_eq!(
        execution_violations(&result, false),
        [],
        "lead goal: {result}"
    );
    for language in ["py", "js"] {
        let marker = host.hub.root.join(format!("child-{language}-executed"));
        let name = format!("PolicyWitness{language}");
        let from = host.child("active-witness", &name, &eval_call(&marker, language));
        let result = host.result(from, "eval", Some("active-witness"));
        assert_eq!(
            execution_violations(&result, marker.exists()),
            [],
            "child {language}: {result}"
        );
        let child = request(&host, from, Witness::Child);
        child.witness(Role::Subagent, &name);
        let identity = child.agent.unwrap();
        assert!(
            identity.id.to_lowercase().contains(&name.to_lowercase())
                || identity.name.to_lowercase().contains(&name.to_lowercase()),
            "wrong named child: {identity:?}"
        );
    }
    let from = host.child(
        "active-witness",
        "ShellWitness",
        "CALL bash {\"command\":\"echo cataly-denied-in-subagent\"}",
    );
    let result = host.result(from, "bash", Some("active-witness"));
    assert!(result.contains("Blocked by shell rule"), "{result}");
    let before = host.model.bodies().len();
    host.open("look-witness", true);
    request(&host, before, Witness::Lane("look-witness"))
        .witness(Role::LookOnly, "look-only initial");
    let from = host.send("look-witness", "Look-only active capability witness");
    let look = request(&host, from, Witness::Lane("look-witness"));
    assert!(look.tools.contains("goal"), "{look:?}");
    assert!(
        !look.tools.contains("bash"),
        "not a look-only lane: {look:?}"
    );
    for name in policy::selection(Role::LookOnly).unwrap().split(',') {
        assert!(
            look.tools.contains(name),
            "inspection tool {name} missing: {look:?}"
        );
    }
    look.witness(Role::LookOnly, "look-only active goal");
    audit(
        &host.model.bodies(),
        &[
            (&lead, Role::Lead),
            (&lane, Role::Lane),
            (&look, Role::LookOnly),
        ],
    );
    assert!(host.hub.stop().success());
}

fn tern_profile(commands: bool) {
    let settings = if commands {
        ""
    } else {
        "tools:\n  commands: false\n"
    };
    let mut tern = Hosted::new("tern", settings);
    tern.start();
    let from = tern.lead("Tern lead capability witness");
    request(&tern, from, Witness::Lead)
        .witness(Role::Lead, &format!("Tern lead commands={commands}"));
    assert!(tern.hub.stop().success());
}

#[test]
fn stock_default_profile_witnesses_every_hosted_role() {
    if enabled() {
        headless_profile(true);
        tern_profile(true);
    }
}

#[test]
fn stock_direct_profile_witnesses_every_hosted_role() {
    if enabled() {
        headless_profile(false);
        tern_profile(false);
    }
}

#[test]
fn transport_normalization_keeps_side_requests_separate() {
    let envelopes: [Value; 3] = [
        serde_json::json!({"tools": [{"type":"function", "function":{"name":"eval"}}]}),
        serde_json::json!({"request":{"tools":[{"type":"function", "name":"functions.eval"}]}}),
        serde_json::json!({"tools":[{"type":"namespace", "name":"functions", "tools":[{"name":"eval"}]}]}),
    ];
    for body in envelopes {
        assert_eq!(
            Surface::parse(&body).violations(Role::Lead),
            [Violation::Hidden("eval".into())]
        );
    }
    for (body, purpose) in [
        (
            serde_json::json!({"tools":[{"name":"submit_judgment"}]}),
            Purpose::Judgment,
        ),
        (serde_json::json!({"messages":[]}), Purpose::ToolFree),
    ] {
        let surface = Surface::parse(&body);
        assert_eq!(surface.purpose, purpose);
        assert_eq!(surface.violations(Role::Lead), []);
    }
}

#[test]
fn protocol_cross_references_do_not_advertise_eval_but_calls_and_preludes_do() {
    let cases = [
        (
            "- history://<id>: query as `archive.transcript`: ?budget=4000",
            false,
        ),
        ("Use archive.transcript for history.", true),
        ("await archive.transcript('session')", true),
        ("Use commit.draft before committing.", true),
        ("Read help://eval/archive for the archive namespace.", true),
        (
            "<namespaces>\narchive: use archive.transcript\n</namespaces>",
            true,
        ),
        ("- history://<id>: call archive.transcript('session')", true),
        ("- history://<id>: read help://eval/archive", true),
        (
            "- history://<id>: use `commit.draft` before committing",
            true,
        ),
        ("- skill://commit: commit with commit.draft", true),
        ("- agent://<id>: drive pages with `browser.open`", true),
    ];
    for (instruction, forbidden) in cases {
        let body = serde_json::json!({
            "tools":[{"type":"function","function":{"name":"read"}}],
            "messages":[{"role":"system","content":instruction}],
        });
        let violations = Surface::parse(&body).violations(Role::Lead);
        assert_eq!(
            !violations.is_empty(),
            forbidden,
            "{instruction}: {violations:?}"
        );
    }
}
