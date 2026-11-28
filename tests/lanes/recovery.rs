use super::*;

pub(super) fn db(hub: &TestHub) -> rusqlite::Connection {
    let db = rusqlite::Connection::open(hub.state().join("cataly.db")).unwrap();
    db.busy_timeout(WAIT).unwrap();
    db
}

#[test]
fn legacy_lane_resumes_without_a_startup_journal() {
    let (mut hub, _) = lane_hub("");
    start(&mut hub);
    open(&hub, "legacy", &json!({}));
    let before = record(&hub, "legacy");
    hub.stop();
    db(&hub).execute("UPDATE lanes SET record = json_remove(record, '$.startup_cleanup', '$.pending_reopen') WHERE key = 'legacy'", []).unwrap();
    std::fs::remove_dir_all(hub.state().join("startup")).unwrap();
    start(&mut hub);
    let after = hub.until(WAIT, || {
        let rec = record(&hub, "legacy");
        (rec["live"] == true).then_some(rec)
    });
    assert_eq!(after["session_id"], before["session_id"]);
    assert_eq!(after["session_file"], before["session_file"]);
    assert_eq!(after["run_id"], before["run_id"]);
    hub.stop();
}

#[test]
fn shutdown_during_recovery_leaves_the_episode_resumable() {
    let (mut hub, _) = lane_hub("");
    start(&mut hub);
    open(&hub, "interrupted", &json!({}));
    let before = record(&hub, "interrupted");
    hub.stop();
    stall_resumes(&hub);
    start(&mut hub);
    hub.until(WAIT, || {
        data(&hub).join("resume-started").exists().then_some(())
    });
    let deadline: i64 = db(&hub)
        .query_row(
            "SELECT deadline_ms FROM startup_episodes WHERE target = 'lane:interrupted'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    hub.stop();
    let episode: (String, i64) = db(&hub)
        .query_row(
            "SELECT state, deadline_ms FROM startup_episodes WHERE target = 'lane:interrupted'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(episode, ("active".into(), deadline));
    std::fs::rename(hub.root.join("bin/omp-real"), hub.root.join("bin/omp")).unwrap();
    start(&mut hub);
    let after = hub.until(WAIT, || {
        let rec = record(&hub, "interrupted");
        (rec["live"] == true && rec["lost"].is_null()).then_some(rec)
    });
    assert_eq!(after["session_id"], before["session_id"]);
    assert_eq!(after["run_id"], before["run_id"]);
    assert!(
        events_of(&hub, "lane.alert")
            .iter()
            .all(|event| !event.to_string().contains("start held"))
    );
    hub.stop();
}

/// The same interrupted recovery, found again only after its window closed (the hub was down for
/// hours), is nobody's live episode any more: the lane resumes in a fresh one instead of holding.
#[test]
fn an_interrupted_recovery_found_past_its_window_resumes_in_a_fresh_episode() {
    let (mut hub, _) = lane_hub("");
    start(&mut hub);
    open(&hub, "late", &json!({}));
    let before = record(&hub, "late");
    hub.stop();
    stall_resumes(&hub);
    start(&mut hub);
    hub.until(WAIT, || {
        data(&hub).join("resume-started").exists().then_some(())
    });
    hub.stop();
    let aged = db(&hub)
        .execute(
            "UPDATE startup_episodes SET started_ms = started_ms - 7200000, \
             deadline_ms = deadline_ms - 7200000 WHERE target = 'lane:late' AND state = 'active'",
            [],
        )
        .unwrap();
    assert_eq!(aged, 1);
    std::fs::rename(hub.root.join("bin/omp-real"), hub.root.join("bin/omp")).unwrap();
    start(&mut hub);
    let after = hub.until(WAIT, || {
        let rec = record(&hub, "late");
        assert_ne!(rec["state"], "held", "{rec}");
        (rec["live"] == true && rec["lost"].is_null()).then_some(rec)
    });
    assert_eq!(after["session_id"], before["session_id"]);
    assert_eq!(after["run_id"], before["run_id"]);
    hub.until(WAIT, || {
        let state: String = db(&hub)
            .query_row(
                "SELECT state FROM startup_episodes WHERE target = 'lane:late'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        (state == "bound").then_some(())
    });
    hub.stop();
}

/// A reopen that comes up fenced (a model mismatch) recorded its startup, so its episode ends.
/// Once the owner continues the lane and its process exits, recovery four minutes into that old
/// window retries normally instead of reading the window and holding at once.
#[test]
fn a_fenced_reopen_ends_its_episode_and_a_later_exit_recovers() {
    let (mut hub, _) = lane_hub("");
    start(&mut hub);
    open(&hub, "fenced", &json!({}));
    let before = record(&hub, "fenced");
    lane(&hub, "park", &json!({"key":"fenced","reason":"later"})).unwrap();
    hub.fixture("omp", "model", Some("fake/other"));
    let _ = lane(&hub, "reopen", &json!({"key":"fenced"}));
    let fenced = hub.until(WAIT, || {
        let rec = record(&hub, "fenced");
        (rec["live"] == true && rec["state"] == "held").then_some(rec)
    });
    assert!(
        fenced["status"]
            .as_str()
            .unwrap()
            .contains("start held: model"),
        "{fenced}"
    );
    let episode = |hub: &TestHub| -> (String, i64) {
        db(hub)
            .query_row(
                "SELECT state, started_ms FROM startup_episodes WHERE target = 'lane:fenced'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
    };
    let (state, began) = episode(&hub);
    assert_eq!(state, "bound", "the fenced startup ended its episode");
    hub.fixture("omp", "model", None);
    lane(&hub, "resume", &json!({"key":"fenced"})).unwrap();
    let status = Command::new("kill")
        .args(["-KILL", &fenced["pid"].to_string()])
        .status()
        .unwrap();
    assert!(status.success());
    hub.until(WAIT, || {
        (!record(&hub, "fenced")["lost"].is_null()).then_some(())
    });
    hub.stop();
    // Four minutes into that window: one minute left, less than an attempt and its cleanup. The
    // start time stays, since the pending reopen names its episode by it.
    let now = i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap();
    db(&hub)
        .execute(
            "UPDATE startup_episodes SET deadline_ms = ?1 WHERE target = 'lane:fenced'",
            [now + 60_000],
        )
        .unwrap();
    start(&mut hub);
    let after = hub.until(WAIT, || {
        let rec = record(&hub, "fenced");
        (rec["live"] == true && rec["lost"].is_null() && rec["state"] != "held").then_some(rec)
    });
    assert_eq!(after["session_id"], before["session_id"]);
    let renewed = hub.until(WAIT, || {
        let (state, renewed) = episode(&hub);
        (state == "bound").then_some(renewed)
    });
    assert!(renewed > began, "a fresh episode");
    hub.stop();
}

#[test]
fn held_recovery_keeps_its_first_reason_without_starting_or_alerting_again() {
    let (mut hub, _) = lane_hub("");
    start(&mut hub);
    open(&hub, "held", &json!({}));
    stall_resumes(&hub);
    std::fs::write(hub.root.join("bin/omp"),
        "#!/bin/sh\nfor arg do\n case \"$arg\" in --resume=*) exit 1;; esac\ndone\nexec \"$(dirname \"$0\")/omp-real\" \"$@\"\n").unwrap();
    lane(&hub, "park", &json!({"key":"held", "reason":"test"})).unwrap();
    lane(&hub, "reopen", &json!({"key":"held"})).unwrap();
    let before = record(&hub, "held");
    assert_eq!(before["state"], "held");
    assert_eq!(before["live"], false);
    let alerts = hub.until(WAIT, || {
        let alerts = events_of(&hub, "lane.alert");
        (!alerts.is_empty()).then_some(alerts)
    });
    hub.stop();
    start(&mut hub);
    hub.until(WAIT, || {
        (!events_of(&hub, "lane.recap").is_empty()).then_some(())
    });
    let after = record(&hub, "held");
    assert_eq!(after["reason"], before["reason"]);
    assert_eq!(after["lost"], before["lost"]);
    assert_eq!(after["live"], false);
    assert_eq!(
        after["revision"], before["revision"],
        "no new startup attempt"
    );
    assert_eq!(after["pid"], before["pid"]);
    assert_eq!(events_of(&hub, "lane.alert"), alerts);
    hub.stop();
}

#[test]
fn refused_reopen_leaves_closed_and_parked_lanes_unchanged() {
    for op in ["park", "abandon"] {
        let (mut hub, _) = lane_hub("");
        start(&mut hub);
        open(&hub, "closed", &json!({}));
        lane(&hub, op, &json!({"key":"closed", "reason":"owner stop"})).unwrap();
        let before = record(&hub, "closed");
        let file = before["session_file"].as_str().unwrap();
        let contents = std::fs::read(file).unwrap();
        std::fs::remove_file(file).unwrap();
        let refusal = lane(&hub, "reopen", &json!({"key":"closed"})).unwrap();
        assert!(refusal.as_str().unwrap().contains("missing"));
        assert_eq!(record(&hub, "closed"), before);
        std::fs::write(file, contents).unwrap();
        hub.stop();
        stall_resumes(&hub);
        start(&mut hub);
        // A new lane completes startup after recover() inspected the retained closed record.
        open(&hub, "witness", &json!({}));
        assert_eq!(record(&hub, "closed"), before);
        assert!(!data(&hub).join("resume-started").exists());
        hub.stop();
    }
}

#[test]
fn in_doubt_deliveries_allow_lifecycle_settlement_but_keep_worktrees() {
    let (mut hub, work) = lane_hub("");
    let repo = pushed_repo(&work);
    start(&mut hub);
    let keys = ["park", "abandon", "close", "settle"];
    for key in keys {
        let tree = work.join(key);
        open(
            &hub,
            key,
            &json!({"cwd":repo,"worktree":{"path":tree,"branch":key,"base":"HEAD"}}),
        );
    }
    hub.stop();
    for key in keys {
        db(&hub).execute("INSERT INTO inbox(target,sender,text,urgent,owner,state,created_ms,updated_ms) VALUES (?1,'owner','uncertain instruction',1,1,'in_doubt',1,1)", [key]).unwrap();
    }
    start(&mut hub);
    hub.until(WAIT, || {
        keys.iter()
            .all(|key| record(&hub, key)["live"] == true)
            .then_some(())
    });
    for key in keys {
        let tree = work.join(key);
        let status = hub.json(&["lane", "status", key, "--json"]);
        match key {
            "park" | "abandon" => {
                lane(&hub, key, &json!({"key":key,"reason":"owner stop"})).unwrap();
            }
            "close" => {
                lane(&hub, "close", &json!({"key":key,"note":"done"})).unwrap();
            }
            "settle" => {
                lane(
                    &hub,
                    "claim",
                    &json!({"key":key,"evidence":"checks complete"}),
                )
                .unwrap();
            }
            _ => unreachable!(),
        }
        let after = hub.until(WAIT, || {
            let rec = record(&hub, key);
            (rec["state"] == "closed").then_some(rec)
        });
        assert!(status.as_str().unwrap().contains("in doubt"), "{status}");
        assert!(tree.exists());
        assert!(after["receipt"].to_string().contains("in doubt"), "{after}");
        let count: i64 = db(&hub)
            .query_row(
                "SELECT count(*) FROM inbox WHERE target=?1 AND state='in_doubt'",
                [key],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }
    hub.stop();
}
