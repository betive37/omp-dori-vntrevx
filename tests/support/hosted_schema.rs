//! Validate every catalog gate, including offered rows, through stock OMP's public settings CLI.
use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::hosted_harness::{Hosted, enabled};
use crate::policy::{Hiding, STOCK};

fn values() -> BTreeMap<&'static str, Value> {
    let mut values = BTreeMap::new();
    for tool in STOCK {
        match tool.hiding {
            Hiding::Features(settings) => {
                for &(key, value) in settings {
                    let value = Value::from(value);
                    if let Some(previous) = values.insert(key, value.clone()) {
                        assert_eq!(previous, value, "inconsistent shared gate {key}");
                    }
                }
            }
            Hiding::LaunchSelection | Hiding::NoSwitch => {}
        }
    }
    values
}

fn validate(host: &Hosted, values: &BTreeMap<&str, Value>) -> Vec<String> {
    let schema: Value = serde_json::from_str(&host.stock(&["config", "list", "--json"])).unwrap();
    let mut invalid = Vec::new();
    for (key, value) in values {
        if schema.get(key).is_none() {
            invalid.push(format!("unknown setting {key}"));
            continue;
        }
        let rendered = value
            .as_str()
            .map_or_else(|| value.to_string(), str::to_owned);
        // `config set` uses the installed schema's type, enum and numeric-range validation.
        // It only changes this disposable profile; no model or hosted process is started here.
        if let Err(error) = host.stock_result(&["config", "set", key, &rendered]) {
            invalid.push(format!("{key}={rendered}: {error}"));
        }
    }
    invalid
}

#[test]
fn every_catalog_gate_value_is_valid_in_stock_omp() {
    if !enabled() {
        return;
    }
    let host = Hosted::new("headless", "");
    assert_eq!(validate(&host, &values()), Vec::<String>::new());
}

#[test]
fn invalid_hidden_gate_value_fails_the_stock_schema_contract() {
    if !enabled() {
        return;
    }
    let host = Hosted::new("headless", "");
    let mut gates = values();
    *gates.get_mut("eval.py").expect("production H gate") = json!("not-a-boolean");
    let invalid = validate(&host, &gates);
    assert_eq!(invalid.len(), 1, "{invalid:?}");
    assert!(invalid[0].starts_with("eval.py="), "{invalid:?}");
    eprintln!("red invalid H gate value: {}", invalid[0]);
}
