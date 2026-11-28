//! Compare typed model capabilities with the production hosted policy.
#[path = "hosted_wire.rs"]
mod wire;

use std::collections::BTreeSet;

use serde::Deserialize;
use serde_json::Value;

use crate::policy::{Class, LANE_BRIDGE, LEAD_BRIDGE, Role, STOCK};

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Purpose {
    Coding,
    Judgment,
    ToolFree,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Agent {
    pub(crate) kind: String,
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) session: String,
}

#[derive(Debug)]
pub(crate) struct Surface {
    pub(crate) purpose: Purpose,
    pub(crate) agent: Option<Agent>,
    pub(crate) tools: BTreeSet<String>,
    pub(crate) aliases: BTreeSet<(String, String)>,
    pub(crate) commands: BTreeSet<String>,
    pub(crate) references: BTreeSet<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Violation {
    Unknown(String),
    Hidden(String),
    Helper(String),
    Executed,
    RefusalMissing,
}

impl Surface {
    pub(crate) fn violations(&self, role: Role) -> Vec<Violation> {
        match self.purpose {
            Purpose::Judgment | Purpose::ToolFree => return Vec::new(),
            Purpose::Coding => {}
        }
        let mut violations = Vec::new();
        for name in self.tools.union(&self.commands) {
            match STOCK
                .iter()
                .chain([&LEAD_BRIDGE, &LANE_BRIDGE])
                .find(|tool| tool.name == name)
            {
                Some(tool) => match tool.class(role) {
                    Class::Offered => {}
                    Class::Hidden => violations.push(Violation::Hidden(name.clone())),
                },
                None => violations.push(Violation::Unknown(name.clone())),
            }
        }
        for tool in STOCK
            .iter()
            .filter(|tool| tool.class(role) == Class::Hidden)
        {
            for reference in tool.unavailable_helpers {
                if self.references.contains(*reference) {
                    violations.push(Violation::Helper((*reference).to_owned()));
                }
            }
        }
        violations
    }

    pub(crate) fn assert_clean(&self, role: Role) {
        let violations = self.violations(role);
        assert!(violations.is_empty(), "{role:?}: {violations:?}; {self:#?}");
    }

    pub(crate) fn witness(&self, role: Role, label: &str) {
        assert_eq!(self.purpose, Purpose::Coding, "{label}: no coding request");
        let agent = self
            .agent
            .as_ref()
            .expect("request observed through public extension API");
        assert_ne!(agent.id, "");
        self.assert_clean(role);
        eprintln!(
            "witness {label}: agent={}/{}/{} tools={:?} aliases={:?} mounted={:?} helpers={:?}",
            agent.kind,
            agent.name,
            agent.id,
            self.tools,
            self.aliases,
            self.commands,
            self.references
        );
    }
}

pub(crate) fn execution_violations(result: &str, marker: bool) -> Vec<Violation> {
    let mut out = Vec::new();
    if marker {
        out.push(Violation::Executed);
    }
    if !(result.contains("not found")
        || result.contains("blocked by user policy")
        || result.contains("denied"))
    {
        out.push(Violation::RefusalMissing);
    }
    out
}

pub(crate) fn audit(bodies: &[Value], witnesses: &[(&Surface, Role)]) {
    let mut counts = [0_usize; 3];
    for body in bodies {
        let surface = Surface::parse(body);
        match surface.purpose {
            Purpose::Judgment => counts[1] += 1,
            Purpose::ToolFree => counts[2] += 1,
            Purpose::Coding => {
                counts[0] += 1;
                let agent = surface.agent.as_ref().expect("coding request identity");
                let role = if agent.kind == "sub" {
                    Role::Subagent
                } else {
                    witnesses
                        .iter()
                        .find_map(|(witness, role)| {
                            (witness.agent.as_ref().unwrap().session == agent.session)
                                .then_some(*role)
                        })
                        .expect("every coding session has a role witness")
                };
                surface.assert_clean(role);
            }
        }
    }
    eprintln!(
        "request categories: coding={} judgment={} tool-free={}",
        counts[0], counts[1], counts[2]
    );
}
