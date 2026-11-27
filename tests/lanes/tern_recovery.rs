use super::*;
use std::os::unix::fs::DirBuilderExt as _;

const SESSION: &str = "0b6f2c1e-5a4d-4c3b-9a2e-1f0e9d8c7b6a";

fn bridge_block(hub: &TestHub, file: &Path, number: usize) -> std::thread::JoinHandle<()> {
    let block: Value = hub.until(WAIT, || {
        std::fs::read_to_string(data(hub).join("tui.jsonl"))
            .ok()?
            .lines()
            .nth(number)
            .and_then(|line| serde_json::from_str(line).ok())
    });
    let socket = hub.socket();
    let file = file.to_path_buf();
    std::thread::spawn(move || {
        let mut wire = UnixStream::connect(socket).unwrap();
        wire.set_read_timeout(Some(WAIT)).unwrap();
        let mut reader = BufReader::new(wire.try_clone().unwrap());
        let mut sequence = 1;
        let hello = json!({"v":1,"id":sequence,"method":"bridge.hello", "params":{
            "ext":1,"token":block["token"],"session":SESSION,"file":file,
            "pid":block["pid"],"agent":"main","idle":true,"model":"fake/primary"
        }});
        writeln!(wire, "{hello}").unwrap();
        let mut status = "active";
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).unwrap() == 0 {
                break;
            }
            let response: Value = serde_json::from_str(&line).unwrap();
            let cmd = &response["item"]["cmd"];
            let Some(op) = cmd["op"].as_str() else {
                continue;
            };
            match op {
                "goal" => {
                    status = if cmd["action"] == "pause" {
                        "paused"
                    } else {
                        "active"
                    }
                }
                "deliver" => {
                    let mut transcript = std::fs::OpenOptions::new()
                        .append(true)
                        .open(&file)
                        .unwrap();
                    let entry = json!({"type":"custom_message","customType":"cataly-delivery","content":cmd["text"],"display":true,"details":{"delivery":cmd["id"]}});
                    writeln!(transcript, "{entry}").unwrap();
                }
                "shutdown" => {
                    let killed = Command::new("kill")
                        .arg(block["pid"].to_string())
                        .output()
                        .unwrap();
                    assert!(killed.status.success(), "{killed:?}");
                }
                "state" => {}
                other => panic!("unexpected command {other}: {cmd}"),
            }
            sequence += 1;
            let reply = json!({"v":1,"id":sequence,"method":"bridge.reply","params":{
                "n":cmd["n"],"idle":true,"session":SESSION,"file":file,
                "goal":{"status":status,"objective":"Work."}
            }});
            writeln!(wire, "{reply}").unwrap();
            if op == "shutdown" {
                sequence += 1;
                writeln!(wire, "{}", json!({"v":1,"id":sequence,"method":"bridge.event","params":{"session":SESSION,"kind":"session_shutdown"}})).unwrap();
                return;
            }
        }
    })
}

#[test]
fn tern_lane_reconciles_its_exit_journal_after_block_shutdown() {
    let (mut hub, work) = lane_hub("");
    let tern = hub.install_fake("tern");
    hub.fixture("omp", "tui", Some(""));
    hub.fixture(
        "omp",
        "usage.json",
        Some(
            &json!({
                "generatedAt":1, "reports":[{"provider":"fake","limits":[{
                    "id":"fake:5h","label":"5h","scope":{"provider":"fake","windowId":"5h"},
                    "amount":{"used":1,"limit":100,"unit":"percent"}
                }]}],"accountsWithoutUsage":[],"disabledCredentials":[],"capacity":{}
            })
            .to_string(),
        ),
    );
    let config = std::fs::read_to_string(hub.config_path()).unwrap();
    hub.write_config(&format!(
        "{config}\n[sessions]\nruntime = \"tern\"\ntern = \"{}\"\n",
        tern.display()
    ));
    start(&mut hub);
    let directory = std::fs::canonicalize(hub.state())
        .unwrap()
        .join("sessions/lanes/tern-lane");
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&directory)
        .unwrap();
    let file = directory.join(format!("2026-11-25T10-00-00-000Z_{SESSION}.jsonl"));
    std::fs::write(&file, format!("{}\n", json!({"type":"session","version":3,"id":SESSION,"cwd":std::fs::canonicalize(work).unwrap()}))).unwrap();
    let params = json!({"key":"tern-lane","title":"Tern lane","brief":"Work.","checks":[{"kind":"command","argv":["true"]}]}).to_string();
    let mut opening = hub
        .command(&["lane", "open", "--json", "--params", &params])
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let first = bridge_block(&hub, &file, 0);
    assert!(opening.wait().unwrap().success());
    let before = record(&hub, "tern-lane");
    assert_eq!(before["live"], true);
    assert_eq!(before["state"], "running");
    hub.stop();
    first.join().unwrap();
    // Simulate a crash after the runtime journal was saved but before the lane snapshot caught up.
    rusqlite::Connection::open(hub.state().join("cataly.db"))
        .unwrap()
        .execute("UPDATE lanes SET record=json_set(record, '$.startup_cleanup', 'unknown') WHERE key='tern-lane'", [])
        .unwrap();
    start(&mut hub);
    let second = bridge_block(&hub, &file, 1);
    let after = hub.until(WAIT, || {
        let rec = record(&hub, "tern-lane");
        (rec["live"] == true && rec["lost"].is_null()).then_some(rec)
    });
    assert_eq!(after["session_id"], before["session_id"]);
    assert_eq!(after["session_file"], before["session_file"]);
    assert_eq!(after["run_id"], before["run_id"]);
    hub.stop();
    second.join().unwrap();
}
