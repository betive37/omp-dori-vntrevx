//! Hosted stock-tool policy: availability and execution approval have one owner.
//! Offered tools retain the owner's feature gates and approvals; this is not a sandbox.

use serde::Serialize;
use serde_json::{Map, Value, json};

#[path = "tools/catalog.rs"]
mod catalog;
pub(crate) use catalog::STOCK;

/// A model-facing role, independent of its headless, terminal or remote transport.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub(crate) enum Role {
    Lead,
    Lane,
    Subagent,
    Reviewer,
    LookOnly,
}

/// Offered means available only when the owner and OMP enable it, never approval allow.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub(crate) enum Class {
    Offered,
    Hidden,
}

/// The settings schema's scalar values used by stock feature gates.
#[derive(Clone, Copy, Debug, Serialize)]
pub(crate) enum SettingValue {
    Bool(bool),
    Number(u64),
    Text(&'static str),
}

impl From<SettingValue> for Value {
    fn from(value: SettingValue) -> Self {
        match value {
            SettingValue::Bool(v) => Self::Bool(v),
            SettingValue::Number(v) => Self::from(v),
            SettingValue::Text(v) => Self::from(v),
        }
    }
}

/// Stock has no universal tool-disable switch. Some tools require CLI selection instead.
#[derive(Clone, Copy, Debug, Serialize)]
pub(crate) enum Hiding {
    Features(&'static [(&'static str, SettingValue)]),
    LaunchSelection,
    NoSwitch,
}

/// One canonical stock name and its complete hosted policy.
#[derive(Debug, Serialize)]
pub(crate) struct Tool {
    pub(crate) name: &'static str,
    pub(crate) reason: &'static str,
    pub(crate) offered_in: &'static [Role],
    pub(crate) hiding: Hiding,
    /// Runtime API references that cannot be advertised when this tool is hidden.
    pub(crate) unavailable_helpers: &'static [&'static str],
    /// The inspection CLI profile; special/extension tools may still be added by stock OMP.
    pub(crate) inspection: bool,
}

/// Cataly's essential tools are approved by the bridge, never by the stock O/H renderer.
pub(crate) const LEAD_BRIDGE: Tool = Tool {
    name: "cataly_lead",
    reason: "essential lead bridge; hub authorizes each operation",
    offered_in: &[Role::Lead],
    hiding: Hiding::NoSwitch,
    unavailable_helpers: &[],
    inspection: false,
};

pub(crate) const LANE_BRIDGE: Tool = Tool {
    name: "cataly_lane",
    reason: "essential lane bridge; absent from generic subagents",
    offered_in: &[Role::Lane, Role::LookOnly],
    hiding: Hiding::NoSwitch,
    unavailable_helpers: &[],
    inspection: false,
};

impl Tool {
    pub(crate) fn class(&self, role: Role) -> Class {
        if self.offered_in.contains(&role) {
            Class::Offered
        } else {
            Class::Hidden
        }
    }
}

/// A stock environment variable bound to a setting the hosted overlay pins. OMP ranks it above
/// every `--config` overlay and fills it from `.env` files (the working tree's included) when it is
/// unset or empty, so removing it is not enough: each launch sets it to the overlay's own value.
/// `contract_hosted_env` fails when stock OMP binds a pinned setting that this table omits.
#[derive(Debug, Serialize)]
pub(crate) struct EnvBinding {
    pub(crate) name: &'static str,
    pub(crate) setting: &'static str,
    /// Where stock OMP declares the binding.
    pub(crate) source: &'static str,
}

/// Every binding of a pinned setting in stock OMP 19.1.1 and 19.2.1.
pub(crate) const ENV: &[EnvBinding] = &[
    EnvBinding {
        name: "PI_PY",
        setting: "eval.py",
        source: "19.1.1 src/eval/settings.ts cfgEvalPy `env: \"PI_PY\"`; \
                 19.2.1 omp://settings.md Environment overrides; `omp config set --json` overriddenBy",
    },
    EnvBinding {
        name: "PI_JS",
        setting: "eval.js",
        source: "19.1.1 src/eval/settings.ts cfgEvalJs `env: \"PI_JS\"`; \
                 19.2.1 omp://settings.md Environment overrides; `omp config set --json` overriddenBy",
    },
];

/// Adds only H settings and H denials. Never enables or approves an offered stock tool. Returns
/// the environment that pins every bound setting of the completed overlay ([`env`]).
pub(crate) fn apply(root: &mut Map<String, Value>, role: Role) -> Vec<(&'static str, String)> {
    let mut denied = Map::new();
    for tool in STOCK.iter().filter(|t| t.class(role) == Class::Hidden) {
        match tool.hiding {
            Hiding::Features(settings) => {
                for &(key, value) in settings {
                    let (section, key) = key.split_once('.').unwrap_or((key, ""));
                    if key.is_empty() {
                        root.insert(section.into(), value.into());
                    } else {
                        let entry = root.entry(section).or_insert_with(|| json!({}));
                        if let Value::Object(section) = entry {
                            section.insert(key.into(), value.into());
                        }
                    }
                }
            }
            // Selection is generated independently for launches. NoSwitch rows remain offered:
            // classifying one H requires an upstream control, not a pretend overlay setting.
            Hiding::LaunchSelection | Hiding::NoSwitch => {}
        }
        denied.insert(tool.name.into(), json!("deny"));
    }
    root.insert("tools".into(), json!({ "approval": denied }));
    env(root)
}

/// Each [`ENV`] binding whose setting `root` pins, as the text OMP parses to the pinned value:
/// booleans `1`/`0` (OMP's flag parser), other values as written. Unpinned settings stay the owner's.
pub(crate) fn env(root: &Map<String, Value>) -> Vec<(&'static str, String)> {
    ENV.iter()
        .filter_map(|binding| {
            let mut segments = binding.setting.split('.');
            let first = root.get(segments.next()?)?;
            let value = segments.try_fold(first, |value, segment| value.get(segment))?;
            let text = match value {
                Value::Null => return None,
                Value::Bool(on) => if *on { "1" } else { "0" }.to_owned(),
                Value::String(text) => text.clone(),
                Value::Number(_) | Value::Array(_) | Value::Object(_) => value.to_string(),
            };
            Some((binding.name, text))
        })
        .collect()
}

/// An explicit inspection selection, derived from the same catalog as the overlay.
pub(crate) fn selection(role: Role) -> Option<String> {
    match role {
        Role::Lead | Role::Lane | Role::Subagent => None,
        Role::Reviewer | Role::LookOnly => {
            let mut names = String::new();
            for tool in STOCK
                .iter()
                .filter(|t| t.inspection && t.class(role) == Class::Offered)
            {
                if !names.is_empty() {
                    names.push(',');
                }
                names.push_str(tool.name);
            }
            Some(names)
        }
    }
}
