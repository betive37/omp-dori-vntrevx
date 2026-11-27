//! Live negative controls for the hosted stock-tool contract.
use super::hosted_controls::{
    CHILD_POLICY_CONTROL, Control, UNKNOWN, UNKNOWN_EXTENSION, eval_call,
};
use super::hosted_harness::{Hosted, enabled};
use super::hosted_surface::{Purpose, Surface, Violation, execution_violations};
use super::policy::Role;
use super::{Witness, request};

#[test]
fn removing_either_kernel_gate_exposes_a_hidden_capability() {
    if !enabled() {
        return;
    }
    for control in [Control::PythonGate, Control::JavascriptGate] {
        let host = Hosted::new("headless", "eval:\n  py: true\n  js: true\n");
        host.standalone(control, "Stock gate control witness");
        let surface = host
            .model
            .bodies()
            .iter()
            .map(Surface::parse)
            .find(|surface| surface.purpose == Purpose::Coding)
            .expect("stock coding request");
        let violations = surface.violations(Role::Lead);
        assert!(
            violations.contains(&Violation::Hidden("eval".into())),
            "{control:?}: {surface:#?}"
        );
        assert!(
            violations.contains(&Violation::Helper("commit.draft".into())),
            "{control:?}: {violations:?}"
        );
        eprintln!("RED CONTROL {control:?}: comparison rejected {violations:?}");
    }
}

#[test]
fn removing_deny_executes_when_availability_is_open() {
    if !enabled() {
        return;
    }
    for control in [Control::DenyRetained, Control::DenyRemoved] {
        let host = Hosted::new("headless", "");
        let marker = host.hub.root.join("deny-control-executed");
        host.standalone(control, &eval_call(&marker, "js"));
        let result = host.result(0, "eval", None);
        let violations = execution_violations(&result, marker.exists());
        match control {
            Control::DenyRetained => assert_eq!(violations, [], "{result}"),
            Control::DenyRemoved => {
                assert!(
                    violations.contains(&Violation::Executed),
                    "marker did not execute: {result}"
                );
                eprintln!("RED CONTROL DenyRemoved: comparison rejected {violations:?}");
            }
            Control::PythonGate | Control::JavascriptGate => unreachable!(),
        }
    }
}

#[test]
fn unknown_stock_fixture_requires_a_policy_decision() {
    if !enabled() {
        return;
    }
    let mut host = Hosted::new("headless", "");
    host.extension(UNKNOWN_EXTENSION);
    host.start();
    let from = host.lead("Unknown stock surface witness");
    let surface = request(&host, from, Witness::Lead);
    let violations = surface.violations(Role::Lead);
    assert!(
        violations.contains(&Violation::Unknown(UNKNOWN.into())),
        "{surface:#?}"
    );
    eprintln!("RED CONTROL unknown stock fixture: comparison rejected {violations:?}");
    assert!(host.hub.stop().success());
}

#[test]
fn subagent_without_inherited_hiding_is_rejected() {
    if !enabled() {
        return;
    }
    let mut host = Hosted::new("headless", "");
    host.extension(CHILD_POLICY_CONTROL);
    host.start();
    let from = host.lead("Parent retains hosted policy");
    request(&host, from, Witness::Lead).assert_clean(Role::Lead);
    host.open("inheritance-control", false);
    let from = host.child(
        "inheritance-control",
        "MissingPolicyWitness",
        "Observe inherited capabilities.",
    );
    host.result(from, "task", Some("inheritance-control"));
    let surface = request(&host, from, Witness::Child);
    let violations = surface.violations(Role::Subagent);
    assert!(
        violations.contains(&Violation::Hidden("eval".into())),
        "{surface:#?}"
    );
    eprintln!("RED CONTROL missing subagent inheritance: comparison rejected {violations:?}");
    assert!(host.hub.stop().success());
}
