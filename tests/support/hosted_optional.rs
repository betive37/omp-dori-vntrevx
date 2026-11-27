//! Offline fixtures for conditional stock surfaces; no owner profile or external MCP service.
use std::path::PathBuf;

use serde_json::{Value, json};

use crate::hosted_harness::{Hosted, WAIT};
use crate::hosted_surface::{Purpose, Surface};
use crate::policy::{self, Role};

// A real stdio MCP server, using only Node's standard library. Discovery waits on a file event,
// not a sleep, so the test can prove registration happened after the hosted session was live.
const MCP: &str = r"
import { createInterface } from 'node:readline';
import { existsSync, watch, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const [gate, started] = process.argv.slice(2);
writeFileSync(started, 'started');
async function ready() {
  if (existsSync(gate)) return;
  await new Promise(resolve => {
    const finish = () => { if (existsSync(gate)) { watcher.close(); resolve(); } };
    const watcher = watch(dirname(gate), finish);
    finish();
  });
}
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  switch (request.method) {
    case 'initialize':
      result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'offline-browser', version: '1' } };
      break;
    case 'tools/list':
      await ready();
      result = { tools: [{ name: 'inspect', description: 'Offline browser capability fixture.', inputSchema: { type: 'object', properties: {} } }] };
      break;
    case 'tools/call':
      result = { content: [{ type: 'text', text: 'offline fixture' }] };
      break;
    case 'ping':
      result = {};
      break;
    default:
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
      continue;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
";

pub(crate) fn browser_fixture(host: &Hosted, ready: bool) -> PathBuf {
    let root = &host.hub.root;
    let script = root.join("browser.mjs");
    let gate = root.join("browser-ready");
    std::fs::write(&script, MCP).unwrap();
    if ready {
        std::fs::write(&gate, "ready").unwrap();
    }
    let node = std::env::split_paths(&std::env::var_os("PATH").expect("PATH"))
        .map(|dir| dir.join("node"))
        .find(|path| path.is_file())
        .expect("Node is installed on the contract runner");
    std::fs::write(
        root.join("agent/mcp.json"),
        json!({"mcpServers": {"browser": {
            "type": "stdio", "command": node, "args": [script, gate, root.join("browser-started")],
            "instructions": false, "timeout": 15000,
        }}})
        .to_string(),
    )
    .unwrap();
    gate
}

pub(crate) fn main_surface(host: &Hosted, from: usize) -> Surface {
    host.hub.until(WAIT, || {
        host.model
            .bodies()
            .iter()
            .skip(from)
            .map(Surface::parse)
            .find(|surface| {
                surface.purpose == Purpose::Coding
                    && surface.agent.as_ref().is_some_and(|a| a.kind == "main")
            })
    })
}

pub(crate) fn child_surface(host: &Hosted, name: &str) -> Surface {
    host.hub.until(WAIT, || {
        host.approve("nested-witness");
        host.model
            .bodies()
            .iter()
            .map(Surface::parse)
            .find(|surface| {
                surface.purpose == Purpose::Coding
                    && surface.agent.as_ref().is_some_and(|a| {
                        a.kind == "sub" && (a.name.contains(name) || a.id.contains(name))
                    })
            })
    })
}

pub(crate) fn print_profile(host: &Hosted, role: Role, extra: &[&str]) -> Surface {
    let mut overlay = serde_json::Map::new();
    policy::apply(&mut overlay, role);
    let path = host.hub.root.join("optional-overlay.json");
    std::fs::write(&path, Value::Object(overlay).to_string()).unwrap();
    let selection = policy::selection(role);
    let mut args = vec![
        "--print",
        "--no-session",
        "--no-skills",
        "--no-rules",
        "--no-context-files",
        "--model=fake/primary",
        "--config",
        path.to_str().unwrap(),
    ];
    if let Some(selection) = selection.as_deref() {
        args.extend(["--tools", selection, "--approval-mode", "always-ask"]);
    }
    args.extend(extra);
    args.push("Record this conditional tool surface.");
    host.stock(&args);
    main_surface(host, 0)
}
