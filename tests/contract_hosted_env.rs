//! Stock OMP's setting environment variables against the hosted policy (DESIGN 12.2 A13). OMP ranks
//! a setting's own variable above every `--config` overlay and fills an unset or empty one from
//! `.env` files, the working tree's included. Every launch therefore sets each bound variable to the
//! overlay's value (`src/omp/tools.rs` `ENV`). This contract finds every binding of a pinned setting
//! through stock OMP's public `config set --json` report, and proves that hostile values inherited
//! or in a project `.env` cannot re-enable eval in a Tern lead or lane or a headless lead.
//! Run: `CATALY_CONTRACT_OMP=1 cargo test --release --test contract_hosted_env -- --nocapture`

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

#[expect(
    dead_code,
    reason = "shared fixtures also serve the tool contracts' execution probes"
)]
#[path = "support/hosted_harness.rs"]
mod hosted_harness;
#[expect(
    dead_code,
    reason = "the core contract owns execution and aggregate audits"
)]
#[path = "support/hosted_surface.rs"]
mod hosted_surface;
#[expect(
    dead_code,
    reason = "this contract reads the policy's tables, not its renderers"
)]
#[path = "../src/omp/tools.rs"]
mod policy;
mod support;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use hosted_harness::{Hosted, WAIT, enabled, installed_omp};
use hosted_surface::{Purpose, Surface};
use policy::{ENV, LANE_BRIDGE, LEAD_BRIDGE, Role};
use serde_json::{Map, Value};
use support::path_without_omp;

/// Records each request's pinned settings as stock OMP resolves them, through its public registry.
/// The pins are read from the session's own `--config` overlay, as the hub wrote it.
const READBACK: &str = r"
import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { lookup } from '@oh-my-pi/pi-coding-agent/config/registry';
import { appendFileSync, readFileSync } from 'node:fs';
export default function (pi: ExtensionAPI) {
  const arg = process.argv.find(a => a.startsWith('--config='));
  const overlay = arg ? JSON.parse(readFileSync(arg.slice('--config='.length), 'utf8')) : {};
  pi.on('before_provider_request', (_event, ctx) => {
    const pins: Record<string, unknown> = {};
    const walk = (value: Record<string, unknown>, prefix: string) => {
      for (const [key, pinned] of Object.entries(value)) {
        const id = prefix ? `${prefix}.${key}` : key;
        const setting = lookup(id);
        if (setting) pins[id] = { pinned, effective: setting.get(pi.pi.settings) };
        else if (pinned && typeof pinned === 'object' && !Array.isArray(pinned)) walk(pinned as Record<string, unknown>, id);
        else pins[id] = { pinned, unknown: true };
      }
    };
    walk(overlay, '');
    const env: Record<string, string | null> = {};
    for (const name of NAMES) env[name] = process.env[name] ?? null;
    appendFileSync(FILE, JSON.stringify({ session: ctx.sessionManager.getSessionId(), pins, env }) + '\n');
  });
}
";

/// The text a launch sets or `config set` writes for one overlay value.
fn text(value: &Value) -> String {
    value
        .as_str()
        .map_or_else(|| value.to_string(), str::to_owned)
}

/// The hostile environment: every tabled binding set to `1`, which re-enables its eval kernel.
fn hostile_env() -> Vec<(&'static str, &'static str)> {
    ENV.iter().map(|b| (b.name, "1")).collect()
}

/// A stock session as an adversarial owner environment leaves it: a hostile project `.env` for
/// every launch, and the read-back extension next to the harness's request witness.
fn hosted(runtime: &str, fallback: bool) -> Hosted {
    let host = Hosted::new(runtime, "");
    let root = &host.hub.root;
    let dotenv = hostile_env()
        .iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(root.join("work/.env"), dotenv).unwrap();
    let names: Vec<&str> = ENV.iter().map(|b| b.name).collect();
    let extension = READBACK
        .replace("NAMES", &serde_json::to_string(&names).unwrap())
        .replace(
            "FILE",
            &serde_json::to_string(&root.join("readback.jsonl")).unwrap(),
        );
    std::fs::write(root.join("agent/extensions/readback.ts"), extension).unwrap();
    if fallback {
        let config = std::fs::read_to_string(host.hub.config_path()).unwrap();
        host.hub.write_config(&format!(
            "{config}\n[fallback]\non = \"usage-limit\"\n[fallback.chains]\ndefault = [\"fake/primary\"]\n"
        ));
    }
    host
}

/// Replaces the Tern stand-in with a terminal whose tabs inherit the hostile variables. The red
/// control also drops the hub's pins from the block's command line, as a hub without them would.
fn hostile_terminal(host: &Hosted, drop_pins: bool) {
    let bin = host.hub.root.join("bin");
    std::fs::rename(bin.join("tern"), bin.join("tern-stand-in")).unwrap();
    let exports: Vec<String> = hostile_env()
        .iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect();
    let drop = if drop_pins {
        let names: Vec<String> = ENV.iter().map(|b| format!("{}=*", b.name)).collect();
        format!(
            "for a do shift; case \"$a\" in {}) ;; *) set -- \"$@\" \"$a\" ;; esac; done\n",
            names.join("|")
        )
    } else {
        String::new()
    };
    let script = format!(
        "#!/bin/sh\nexport {}\n{drop}exec \"$(dirname \"$0\")/tern-stand-in\" \"$@\"\n",
        exports.join(" ")
    );
    std::fs::write(bin.join("tern"), script).unwrap();
    std::fs::set_permissions(
        bin.join("tern"),
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )
    .unwrap();
}

/// The first coding request of the lead (`None`) or of one lane after `from`.
fn request(host: &Hosted, from: usize, lane: Option<&str>) -> Surface {
    let session = lane.map(|key| host.lane_session(key));
    host.hub.until(WAIT, || {
        host.model
            .bodies()
            .iter()
            .skip(from)
            .map(Surface::parse)
            .find(|s| {
                s.purpose == Purpose::Coding
                    && match &session {
                        None => s.tools.contains(LEAD_BRIDGE.name),
                        Some(session) => {
                            s.tools.contains(LANE_BRIDGE.name)
                                && s.agent.as_ref().is_some_and(|a| &a.session == session)
                        }
                    }
            })
    })
}

/// Everything that makes a hosted session break the policy: an advertised H tool or helper, and a
/// pinned setting stock OMP does not resolve to its overlay value (records: each pinned entry).
fn failures(host: &Hosted, surface: &Surface, role: Role, label: &str) -> Vec<String> {
    let mut out: Vec<String> = surface
        .violations(role)
        .into_iter()
        .map(|v| format!("{label}: {v:?}"))
        .collect();
    let session = &surface.agent.as_ref().expect("request witness").session;
    let readback = std::fs::read_to_string(host.hub.root.join("readback.jsonl")).unwrap();
    let record: Value = readback
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|r| r["session"] == *session.as_str())
        .unwrap_or_else(|| panic!("{label}: no read-back for session {session}"));
    let pins = record["pins"].as_object().expect("pins");
    assert!(
        pins.contains_key("eval.py") && pins.contains_key("ask.timeout"),
        "{label}: not the hosted overlay: {record}"
    );
    for (id, pin) in pins {
        let (pinned, effective) = (&pin["pinned"], &pin["effective"]);
        let holds = match pinned {
            _ if pin["unknown"] == true => false,
            Value::Object(entries) => entries.iter().all(|(k, v)| &effective[k] == v),
            _ => effective == pinned,
        };
        if !holds {
            out.push(format!(
                "{label}: {id} pinned {pinned} resolved {effective}"
            ));
        }
    }
    eprintln!(
        "{label}: tools={:?} env={} eval.py={} eval.js={} failures={}",
        surface.tools,
        record["env"],
        pins["eval.py"]["effective"],
        pins["eval.js"]["effective"],
        out.len()
    );
    out
}

fn lead(host: &Hosted, label: &str) -> Vec<String> {
    let from = host.lead(&format!("{label} environment witness"));
    failures(host, &request(host, from, None), Role::Lead, label)
}

fn lane(host: &Hosted, key: &str, label: &str) -> Vec<String> {
    let before = host.model.bodies().len();
    host.open(key, false);
    let mut out = failures(host, &request(host, before, Some(key)), Role::Lane, label);
    let from = host.send(key, "Witness after goal activation");
    out.extend(failures(
        host,
        &request(host, from, Some(key)),
        Role::Lane,
        &format!("{label} active goal"),
    ));
    out
}

/// Every setting leaf of the overlays the hub wrote, keyed as stock OMP's schema names them.
fn pinned_settings(state: &Path, schema: &Map<String, Value>) -> BTreeMap<String, Value> {
    fn walk(
        value: &Map<String, Value>,
        prefix: &str,
        schema: &Map<String, Value>,
        out: &mut BTreeMap<String, Value>,
    ) {
        for (key, pinned) in value {
            let id = if prefix.is_empty() {
                key.clone()
            } else {
                format!("{prefix}.{key}")
            };
            match pinned {
                _ if schema.contains_key(&id) => {
                    out.insert(id, pinned.clone());
                }
                Value::Object(inner) => walk(inner, &id, schema, out),
                _ => panic!("overlay key {id} is not a stock setting"),
            }
        }
    }
    let mut out = BTreeMap::new();
    let mut files = 0;
    for entry in std::fs::read_dir(state).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if name.starts_with("omp-overlay") {
            let overlay: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            walk(overlay.as_object().unwrap(), "", schema, &mut out);
            files += 1;
        }
    }
    assert!(files >= 3, "lead, lane and look-only overlays: {files}");
    out
}

/// Upper-case string literals of the installed executable: every name stock OMP could read.
/// Names that relocate the profile, select the runtime or are process plumbing are left alone; they
/// change which settings are read, not one setting's value.
fn candidates(exe: &Path) -> BTreeSet<String> {
    const PLUMBING: [&str; 20] = [
        "PATH",
        "HOME",
        "USER",
        "LOGNAME",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "TZ",
        "SHELL",
        "TERM",
        "PWD",
        "OLDPWD",
        "IFS",
        "ENV",
        "CDPATH",
        "PI_CODING_AGENT_DIR",
        "PI_CONFIG_DIR",
        "PI_CONFIG_FILES",
        "OMP_PROFILE",
        "PI_PROFILE",
    ];
    const PREFIXES: [&str; 9] = [
        "LD_", "DYLD_", "BUN_", "NODE_", "XDG_", "MALLOC", "NPM_", "UV_", "PYTHON",
    ];
    let bytes = std::fs::read(exe).unwrap();
    let mut out = BTreeSet::new();
    let mut i = 0;
    while i < bytes.len() {
        let quote = bytes[i];
        i += 1;
        if !matches!(quote, b'"' | b'\'' | b'`') {
            continue;
        }
        let start = i;
        while i < bytes.len() && i - start <= 64 {
            let b = bytes[i];
            let ok = b.is_ascii_uppercase() || (i > start && (b.is_ascii_digit() || b == b'_'));
            if !ok {
                break;
            }
            i += 1;
        }
        if i - start >= 2 && i < bytes.len() && bytes[i] == quote {
            let name = String::from_utf8_lossy(&bytes[start..i]).into_owned();
            if !PLUMBING.contains(&name.as_str()) && !PREFIXES.iter().any(|p| name.starts_with(p)) {
                out.insert(name);
            }
        }
    }
    for binding in ENV {
        assert!(
            out.contains(binding.name),
            "installed OMP does not expose the known binding {} as a literal",
            binding.name
        );
    }
    assert!(
        out.contains("PI_EDIT_VARIANT"),
        "installed OMP lacks the independent documented environment-binding witness"
    );
    out
}

/// Which variable, if any, stock OMP reports as overriding `id` when every candidate is `probe`.
fn overridden_by(
    dir: &Path,
    names: &BTreeSet<String>,
    id: &str,
    value: &str,
    probe: &str,
) -> Option<String> {
    for sub in ["home", "agent", "work"] {
        std::fs::create_dir_all(dir.join(sub)).unwrap();
    }
    let out = Command::new(installed_omp())
        .env_clear()
        .envs(names.iter().map(|n| (n.as_str(), probe)))
        .env("PATH", path_without_omp())
        .env("HOME", dir.join("home"))
        .env("PI_CODING_AGENT_DIR", dir.join("agent"))
        .current_dir(dir.join("work"))
        .args(["config", "set", id, value, "--json"])
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "config set {id} under {probe}: {out:?}"
    );
    let report: Value = serde_json::from_slice(&out.stdout).unwrap();
    let provenance = report
        .get("overriddenBy")
        .expect("stock config set must report override provenance");
    assert!(
        provenance.is_null() || provenance.as_str().is_some_and(|name| names.contains(name)),
        "config set {id} under {probe} has an unclassified override: {provenance}"
    );
    provenance.as_str().map(str::to_owned)
}

/// The (setting, variable) pairs the table lacks or names wrongly.
fn mismatches(found: &BTreeSet<(String, String)>, table: &[(&str, &str)]) -> Vec<String> {
    let table: BTreeSet<(String, String)> = table
        .iter()
        .map(|(s, n)| ((*s).to_owned(), (*n).to_owned()))
        .collect();
    let mut out: Vec<String> = found
        .difference(&table)
        .map(|(s, n)| format!("stock binds {n} to pinned {s}; add it to policy ENV"))
        .collect();
    out.extend(
        table
            .difference(found)
            .map(|(s, n)| format!("policy ENV binds {n} to {s}; stock does not")),
    );
    out
}

/// Every stock binding of every pinned setting, whatever its value type, through the public
/// `omp config set --json` provenance report. A binding new in a later OMP fails this contract.
fn stock_bindings(host: &Hosted) -> BTreeSet<(String, String)> {
    let schema: Value = {
        let dir = host.hub.root.join("sweep/schema");
        for sub in ["home", "agent", "work"] {
            std::fs::create_dir_all(dir.join(sub)).unwrap();
        }
        let out = Command::new(installed_omp())
            .env_clear()
            .env("PATH", path_without_omp())
            .env("HOME", dir.join("home"))
            .env("PI_CODING_AGENT_DIR", dir.join("agent"))
            .current_dir(dir.join("work"))
            .args(["config", "list", "--json"])
            .output()
            .unwrap();
        serde_json::from_slice(&out.stdout).unwrap()
    };
    let pinned = pinned_settings(&host.hub.state(), schema.as_object().unwrap());
    for binding in ENV {
        assert!(
            pinned.contains_key(binding.setting),
            "ENV names unpinned {}",
            binding.setting
        );
    }
    let names = candidates(&installed_omp());
    // Any non-empty text sets a boolean; numbers, enums and JSON values take their own text.
    let mut jobs: Vec<(String, String, String)> = Vec::new();
    for (id, value) in &pinned {
        let value = text(value);
        let mut probes = vec![
            "0".to_owned(),
            "1".to_owned(),
            "yes".to_owned(),
            value.clone(),
        ];
        probes.sort();
        probes.dedup();
        for probe in probes {
            jobs.push((id.clone(), value.clone(), probe));
        }
    }
    let mut found = BTreeSet::new();
    let root = host.hub.root.join("sweep");
    for (batch, chunk) in jobs.chunks(8).enumerate() {
        std::thread::scope(|scope| {
            let handles: Vec<_> = chunk
                .iter()
                .enumerate()
                .map(|(n, (id, value, probe))| {
                    let dir: PathBuf = root.join(format!("{batch}-{n}"));
                    let names = &names;
                    scope.spawn(move || {
                        overridden_by(&dir, names, id, value, probe).map(|name| (id.clone(), name))
                    })
                })
                .collect();
            for handle in handles {
                found.extend(handle.join().unwrap());
            }
        });
    }
    eprintln!(
        "swept {} pinned settings x {} candidate names ({} probes): bindings {found:?}",
        pinned.len(),
        names.len(),
        jobs.len()
    );
    found
}

#[test]
fn headless_lead_and_lane_keep_pins_against_listed_and_dotenv_variables() {
    if !enabled() {
        return;
    }
    let mut host = hosted("headless", true);
    // The owner lists the bound variables as "credentials" and the hub has them: passed on, unless
    // the launch pins them last.
    let config = std::fs::read_to_string(host.hub.config_path()).unwrap();
    let names: Vec<String> = ENV.iter().map(|b| format!("\"{}\"", b.name)).collect();
    host.hub.write_config(&config.replacen(
        "[sessions]\n",
        &format!("[sessions]\ncredentials = [{}]\n", names.join(", ")),
        1,
    ));
    for (name, value) in hostile_env() {
        host.hub.env.push((name.into(), value.into()));
    }
    host.start();
    let mut out = lead(&host, "headless lead");
    out.extend(lane(&host, "env-lane", "headless lane"));
    let before = host.model.bodies().len();
    host.open("env-look", true);
    out.extend(failures(
        &host,
        &request(&host, before, Some("env-look")),
        Role::LookOnly,
        "headless look-only",
    ));
    assert_eq!(out, Vec::<String>::new());
    let found = stock_bindings(&host);
    let table: Vec<(&str, &str)> = ENV.iter().map(|b| (b.setting, b.name)).collect();
    assert_eq!(mismatches(&found, &table), Vec::<String>::new());
    // Red control: a table that forgets one stock binding fails the comparison.
    let red = mismatches(&found, &table[1..]);
    assert_eq!(red.len(), 1, "{red:?}");
    eprintln!("red stale binding table: {}", red[0]);
    assert!(host.hub.stop().success());
}

#[test]
fn tern_lead_and_lane_keep_pins_against_inherited_and_dotenv_variables() {
    if !enabled() {
        return;
    }
    let mut host = hosted("tern", false);
    hostile_terminal(&host, false);
    host.start();
    let mut out = lead(&host, "Tern lead");
    out.extend(lane(&host, "env-lane", "Tern lane"));
    assert_eq!(out, Vec::<String>::new());
    assert!(host.hub.stop().success());
}

#[test]
fn tern_without_the_pins_fails_the_contract() {
    if !enabled() {
        return;
    }
    let mut host = hosted("tern", false);
    hostile_terminal(&host, true);
    host.start();
    let red = lead(&host, "red Tern lead without pins");
    assert!(
        red.iter().any(|f| f.contains("Hidden(\"eval\")")),
        "eval must be advertised again: {red:?}"
    );
    assert!(
        red.iter().any(|f| f.contains("eval.py pinned false")),
        "the eval pin must break: {red:?}"
    );
    eprintln!("red Tern without pins: {red:?}");
    assert!(host.hub.stop().success());
}
