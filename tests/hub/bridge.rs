//! Role transitions on a real hub connection, with fake OMP sessions.

use std::io::{BufRead as _, BufReader, Write as _};
use std::os::unix::net::UnixStream;
use std::time::Duration;

use serde_json::{Value, json};

use super::support::TestHub;

struct Bridge {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
    next: u64,
}

impl Bridge {
    fn lead(hub: &TestHub, session: &Value) -> Self {
        let writer = UnixStream::connect(hub.socket()).unwrap();
        writer
            .set_read_timeout(Some(Duration::from_secs(20)))
            .unwrap();
        let mut bridge = Self {
            reader: BufReader::new(writer.try_clone().unwrap()),
            writer,
            next: 0,
        };
        let answer = bridge.call(
            "bridge.hello",
            &json!({
                "ext": 1, "marker": true, "session": session["session_id"], "agent": "main",
            }),
        );
        assert_eq!(answer["ok"]["role"], "lead", "{answer}");
        bridge
    }

    fn call(&mut self, method: &str, params: &Value) -> Value {
        self.next += 1;
        writeln!(
            self.writer,
            "{}",
            json!({"v":1,"id":self.next,"method":method,"params":params})
        )
        .unwrap();
        loop {
            let mut line = String::new();
            assert!(
                self.reader.read_line(&mut line).unwrap() > 0,
                "bridge closed"
            );
            let reply: Value = serde_json::from_str(&line).unwrap();
            if reply["id"] == self.next {
                return reply;
            }
        }
    }

    fn switch(&mut self, session: &Value, reason: &str) -> Value {
        self.call(
            "bridge.switch",
            &json!({
                "session": session["session_id"], "file": session["session_file"], "reason": reason,
            }),
        )["ok"]
            .clone()
    }
}

fn lead_hub() -> (TestHub, Value) {
    let mut hub = TestHub::new("");
    let omp = hub.install_fake("omp");
    hub.fixture("omp", "rpc", Some(""));
    let work = hub.root.join("work");
    std::fs::create_dir_all(&work).unwrap();
    hub.write_config(&format!(
        "[omp]\npath = \"{}\"\n[lead]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n\
         [lanes]\nmodel = \"fake/primary\"\ncwd = \"{}\"\n",
        omp.display(),
        work.display(),
        work.display(),
    ));
    hub.start();
    let session = hub.until(Duration::from_secs(20), || {
        let status = hub.json(&["lead", "status", "--json"]);
        (status["phase"] == "live").then(|| status["session"].clone())
    });
    (hub, session)
}

#[test]
fn bridge_switch_to_unrelated_session_revokes_lead_tools() {
    let (mut hub, lead) = lead_hub();
    let unrelated = json!({"session_id":"unrelated","session_file":"/unrelated.jsonl"});
    let mut bridge = Bridge::lead(&hub, &lead);
    assert_eq!(bridge.switch(&unrelated, "resume")["role"], "none");
    let refused = bridge.call(
        "bridge.tool",
        &json!({"call":"after-switch","input":{"op":"requests"}}),
    );
    assert_eq!(refused["err"]["code"], "bad_request", "{refused}");
    assert!(
        refused["err"]["message"]
            .as_str()
            .unwrap()
            .contains("no role")
    );
    drop(bridge);
    hub.stop();
}

#[test]
fn bridge_switch_rechecks_lead_and_lane_identity_except_for_new() {
    let (mut hub, lead) = lead_hub();
    let mut bridge = Bridge::lead(&hub, &lead);
    let fresh = json!({"session_id":"fresh","session_file":"/fresh.jsonl"});
    assert_eq!(bridge.switch(&fresh, "new")["role"], "lead");
    assert_eq!(bridge.switch(&lead, "resume")["role"], "lead");

    let params = json!({"key":"switch-lane","title":"Switch lane","brief":"Inspect only.",
        "look_only":true,"checks":[{"kind":"command","argv":["true"]}]})
    .to_string();
    hub.json(&["lane", "open", "--params", &params, "--json"]);
    let lane = hub.until(Duration::from_secs(20), || {
        let lanes = hub.json(&["lane", "list", "--json"]);
        lanes
            .as_array()
            .unwrap()
            .iter()
            .find(|lane| lane["session_id"].is_string())
            .cloned()
    });
    let answer = bridge.switch(&lane, "resume");
    assert_eq!(answer["role"], "lane", "{answer}");
    assert_eq!(answer["tools"][0]["name"], "cataly_lane");
    let refused = bridge.call(
        "bridge.tool",
        &json!({"call":"lane-not-lead","input":{"op":"requests"}}),
    );
    assert_eq!(refused["ok"]["error"], true, "{refused}");
    let steps = bridge.call(
        "bridge.tool",
        &json!({"call":"lane-steps","input":{"op":"steps"}}),
    );
    assert_eq!(steps["ok"]["error"], false, "{steps}");

    assert_eq!(bridge.switch(&lead, "resume")["role"], "lead");
    let copied = json!({"session_id":lead["session_id"],"session_file":"/a-copy.jsonl"});
    assert_eq!(bridge.switch(&copied, "resume")["role"], "none");
    drop(bridge);
    hub.stop();
}
