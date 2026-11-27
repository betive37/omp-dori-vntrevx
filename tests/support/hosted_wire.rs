//! Normalize provider envelopes into the tool-surface contract's typed representation.
use std::collections::BTreeSet;

use serde_json::Value;

use super::{Purpose, Surface};

fn canonical(name: &str) -> &str {
    name.strip_prefix("functions.")
        .or_else(|| name.strip_prefix("functions__"))
        .unwrap_or(name)
}

fn tools(value: &Value, namespace: &str, out: &mut Surface) {
    for tool in value.as_array().into_iter().flatten() {
        let name = tool["function"]["name"]
            .as_str()
            .or_else(|| tool["name"].as_str())
            .expect("tool schema has a wire name");
        let alias = if namespace.is_empty() {
            name.to_owned()
        } else {
            format!("{namespace}.{name}")
        };
        if let Some(children) = tool.get("tools") {
            tools(children, &alias, out);
        } else {
            let name = canonical(&alias).to_owned();
            out.tools.insert(name.clone());
            out.aliases.insert((name, alias));
            for description in [tool.get("description"), tool["function"].get("description")]
                .into_iter()
                .flatten()
            {
                text(description, &mut |text| {
                    references(text, &mut out.references)
                });
            }
        }
    }
}

fn text(value: &Value, visit: &mut impl FnMut(&str)) {
    match value {
        Value::String(value) => visit(value),
        Value::Array(parts) => {
            for part in parts {
                if let Some(value) = part.get("text") {
                    text(value, visit);
                }
            }
        }
        Value::Null => {}
        Value::Bool(_) | Value::Number(_) | Value::Object(_) => {
            panic!("unrecognized prompt content: {value}")
        }
    }
}

fn references(text: &str, out: &mut BTreeSet<String>) {
    // Match capability addresses, including references without a call's parentheses.
    for token in text.split(|c: char| !(c.is_ascii_alphanumeric() || "_./:-".contains(c))) {
        let token = token.trim_end_matches('.');
        if token.starts_with("help://eval/")
            || token.split_once('.').is_some_and(|(namespace, _)| {
                matches!(
                    namespace,
                    "commit"
                        | "browser"
                        | "computer"
                        | "dsm"
                        | "archive"
                        | "tool"
                        | "judge"
                        | "completion"
                )
            })
        {
            out.insert(token.to_owned());
        }
    }
}

fn commands(text: &str, out: &mut BTreeSet<String>) {
    let mut catalog_depth = None;
    for line in text.lines() {
        if line.starts_with('#') {
            let depth = line.bytes().take_while(|byte| *byte == b'#').count();
            if line.trim_start_matches('#').trim() == "Tool Commands" {
                catalog_depth = Some(depth);
            } else if catalog_depth.is_some_and(|start| depth <= start) {
                catalog_depth = None;
            }
        }
        if catalog_depth.is_some()
            && let Some(name) = line
                .trim()
                .strip_prefix("- `")
                .and_then(|s| s.split_once('`'))
                .map(|(name, _)| name)
        {
            out.insert(canonical(name).to_owned());
        }
    }
}

impl Surface {
    pub(crate) fn parse(body: &Value) -> Self {
        // OpenAI chat, Responses and Anthropic envelopes share schema names but differ in content.
        let body = body.get("request").unwrap_or(body);
        let mut out = Self {
            purpose: Purpose::ToolFree,
            agent: body["user"]
                .as_str()
                .map(|s| serde_json::from_str(s).expect("observer agent identity")),
            tools: BTreeSet::new(),
            aliases: BTreeSet::new(),
            commands: BTreeSet::new(),
            references: BTreeSet::new(),
        };
        tools(&body["tools"], "", &mut out);
        let mut instruction = |value: &Value| {
            text(value, &mut |text| {
                commands(text, &mut out.commands);
                references(text, &mut out.references);
            })
        };
        for key in ["system", "instructions"] {
            if let Some(value) = body.get(key) {
                instruction(value);
            }
        }
        for message in body["messages"].as_array().into_iter().flatten() {
            if matches!(message["role"].as_str(), Some("system" | "developer")) {
                instruction(&message["content"]);
            }
        }
        out.purpose = if out.tools.is_empty() {
            Purpose::ToolFree
        } else if out.tools.len() == 1 && out.tools.contains("submit_judgment") {
            Purpose::Judgment
        } else {
            Purpose::Coding
        };
        out
    }
}
