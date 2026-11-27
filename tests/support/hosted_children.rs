//! Inherited policy across nested/structured tasks and real session resume.
use serde_json::json;

use crate::hosted_controls::eval_call;
use crate::hosted_harness::{Hosted, enabled};
use crate::hosted_surface::{Purpose, Surface, execution_violations};
use crate::optional::{child_surface, main_surface};
use crate::policy::Role;

#[test]
fn nested_and_structured_children_keep_the_hosted_surface() {
    if !enabled() {
        return;
    }
    let mut host = Hosted::new(
        "headless",
        "task:\n  maxRecursionDepth: 3\nasync:\n  enabled: false\n",
    );
    host.start();
    host.open("nested-witness", false);
    let marker = host.hub.root.join("nested-eval-marker");
    let nested = json!({"context":"Inherited policy at a second depth.", "tasks":[{
        "name":"PolicyGrandchild", "solutionSpace":"given", "task":eval_call(&marker, "js"),
    }]});
    let from = host.child(
        "nested-witness",
        "PolicyParent",
        &format!("CALL task {nested}"),
    );
    let result = host.result(from, "eval", Some("nested-witness"));
    assert_eq!(
        execution_violations(&result, marker.exists()),
        [],
        "{result}"
    );
    let parent = child_surface(&host, "PolicyParent");
    let grandchild = child_surface(&host, "PolicyGrandchild");
    parent.witness(Role::Subagent, "nested parent");
    grandchild.witness(Role::Subagent, "nested grandchild");
    assert!(
        grandchild.agent.as_ref().unwrap().id.contains('.'),
        "not a nested child: {grandchild:?}"
    );

    let structured = json!({"context":"Structured policy witness.", "tasks":[{
        "name":"StructuredPolicy", "solutionSpace":"given", "task":"RETURN {\"result\":\"structured\"}",
        "outputSchema":{"type":"object","properties":{"result":{"type":"string"}},"required":["result"],"additionalProperties":false},
        "schemaMode":"strict",
    }]});
    let from = host.send("nested-witness", &format!("CALL task {structured}"));
    let child = child_surface(&host, "StructuredPolicy");
    child.witness(Role::Subagent, "structured child");
    let result = host.result(from, "task", Some("nested-witness"));
    assert!(
        result.contains("structured") && !result.contains("invalid"),
        "structured result refused: {result}"
    );
    let lane_id = host.lane_session("nested-witness");
    let lead = host.hub.json(&["lead", "status", "--json"]);
    for body in host.model.bodies() {
        let surface = Surface::parse(&body);
        if surface.purpose != Purpose::Coding {
            continue;
        }
        let agent = surface.agent.as_ref().unwrap();
        let role = match agent.kind.as_str() {
            "sub" => Role::Subagent,
            "main" if agent.session == lane_id => Role::Lane,
            "main" => {
                assert_eq!(agent.session, lead["session"]["session_id"]);
                Role::Lead
            }
            other => panic!("unclassified agent kind: {other}"),
        };
        surface.assert_clean(role);
    }
    assert!(host.hub.stop().success());
}

#[test]
fn resumed_lead_keeps_its_identity_and_hosted_policy() {
    if !enabled() {
        return;
    }
    let mut host = Hosted::new(
        "headless",
        "eval:\n  py: true\n  js: true\narchive:\n  enabled: true\n",
    );
    host.start();
    let from = host.lead("History gate witness before resume");
    let first = main_surface(&host, from);
    first.witness(Role::Lead, "before resume");
    let read = json!({
        "i": "Reading current transcript",
        "path": format!("history://{}", first.agent.as_ref().unwrap().id),
    });
    let from = host.lead(&format!("CALL read {read}"));
    let transcript = host.result(from, "read", None);
    assert!(
        transcript.contains("History gate witness before resume"),
        "{transcript}"
    );
    host.settled();
    assert!(host.hub.cli(&["lead", "stop"]).status.success());
    assert!(host.hub.cli(&["lead", "start"]).status.success());
    let from = host.lead("Policy after resume");
    let resumed = main_surface(&host, from);
    resumed.witness(Role::Lead, "after resume");
    assert_eq!(first.agent.unwrap().session, resumed.agent.unwrap().session);
    assert!(host.hub.stop().success());
}
