use super::recovery::db;
use super::*;

fn reopen_in_background(hub: &TestHub, key: &str, note: &str) -> std::process::Child {
    hub.command(&[
        "lane",
        "reopen",
        "--json",
        "--params",
        &json!({"key":key,"note":note}).to_string(),
    ])
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .spawn()
    .unwrap()
}

fn reopen_count(hub: &TestHub, key: &str) -> i64 {
    db(hub)
        .query_row(
            "SELECT count(*) FROM lane_history WHERE key=?1 AND note LIKE 'reopened with run %'",
            [key],
            |row| row.get(0),
        )
        .unwrap()
}

fn prompt_count(hub: &TestHub, note: &str) -> usize {
    std::fs::read_to_string(data(hub).join("prompts"))
        .unwrap_or_default()
        .lines()
        .filter(|line| line.contains(note))
        .count()
}

#[test]
fn interrupted_reopen_finishes_one_run_goal_and_note_on_the_same_episode() {
    let (mut hub, _) = lane_hub("");
    start(&mut hub);
    open(&hub, "reopen-stop", &json!({}));
    lane(&hub, "park", &json!({"key":"reopen-stop","reason":"later"})).unwrap();
    let before = record(&hub, "reopen-stop");
    stall_resumes(&hub);
    let mut request = reopen_in_background(&hub, "reopen-stop", "DURABLE-REOPEN-NOTE");
    hub.until(WAIT, || {
        data(&hub).join("resume-started").exists().then_some(())
    });
    let episode: i64 = db(&hub)
        .query_row(
            "SELECT started_ms FROM startup_episodes WHERE target='lane:reopen-stop'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    hub.stop();
    request.wait().unwrap();
    std::fs::rename(hub.root.join("bin/omp-real"), hub.root.join("bin/omp")).unwrap();
    start(&mut hub);
    let after = hub.until(WAIT, || {
        let rec = record(&hub, "reopen-stop");
        (rec["state"] == "running" && prompt_count(&hub, "DURABLE-REOPEN-NOTE") == 1).then_some(rec)
    });
    assert_eq!(after["session_id"], before["session_id"]);
    assert_eq!(after["session_file"], before["session_file"]);
    assert_ne!(after["run_id"], before["run_id"]);
    assert_eq!(goal(&hub, &after["session_id"]), "active");
    assert_eq!(reopen_count(&hub, "reopen-stop"), 1);
    let continued: i64 = db(&hub).query_row("SELECT count(*) FROM lane_history WHERE key='reopen-stop' AND note LIKE 'continued; goal %'", [], |row| row.get(0)).unwrap();
    assert_eq!(continued, 1);
    let final_episode: (i64, String) = hub.until(WAIT, || {
        let value: (i64, String) = db(&hub)
            .query_row(
                "SELECT started_ms,state FROM startup_episodes WHERE target='lane:reopen-stop'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        (value.1 == "bound").then_some(value)
    });
    assert_eq!(final_episode.0, episode);
    hub.stop();
    start(&mut hub);
    hub.until(WAIT, || {
        (record(&hub, "reopen-stop")["live"] == true).then_some(())
    });
    assert_eq!(record(&hub, "reopen-stop")["run_id"], after["run_id"]);
    assert_eq!(reopen_count(&hub, "reopen-stop"), 1);
    assert_eq!(prompt_count(&hub, "DURABLE-REOPEN-NOTE"), 1);
    hub.stop();
}

#[test]
fn an_in_doubt_reopen_note_is_never_resent_after_hub_stop() {
    let (mut hub, _) = lane_hub("");
    start(&mut hub);
    open(&hub, "uncertain-note", &json!({}));
    lane(
        &hub,
        "park",
        &json!({"key":"uncertain-note","reason":"later"}),
    )
    .unwrap();
    let before = record(&hub, "uncertain-note");
    let file = before["session_file"].as_str().unwrap();
    let contents = std::fs::read(file).unwrap();
    hub.fixture("omp", "noentry", Some(""));
    let mut request = reopen_in_background(&hub, "uncertain-note", "UNCERTAIN-REOPEN-NOTE");
    hub.until(WAIT, || {
        (prompt_count(&hub, "UNCERTAIN-REOPEN-NOTE") == 1).then_some(())
    });
    let mut transcript = std::fs::OpenOptions::new().append(true).open(file).unwrap();
    writeln!(transcript, "{{broken").unwrap();
    drop(transcript);
    hub.stop();
    request.wait().unwrap();
    hub.fixture("omp", "noentry", None);
    start(&mut hub);
    hub.until(WAIT, || {
        (record(&hub, "uncertain-note")["live"] == true).then_some(())
    });
    hub.until(WAIT, || {
        let count: i64 = db(&hub).query_row("SELECT count(*) FROM inbox WHERE target='uncertain-note' AND state='in_doubt' AND text LIKE '%UNCERTAIN-REOPEN-NOTE%'", [], |row| row.get(0)).unwrap();
        (count == 1).then_some(())
    });
    assert_eq!(
        record(&hub, "uncertain-note")["session_id"],
        before["session_id"]
    );
    assert_eq!(reopen_count(&hub, "uncertain-note"), 1);
    assert_eq!(prompt_count(&hub, "UNCERTAIN-REOPEN-NOTE"), 1);
    let status = hub.json(&["lane", "status", "uncertain-note", "--json"]);
    assert!(status.as_str().unwrap().contains("in doubt"), "{status}");
    hub.stop();
    std::fs::write(file, contents).unwrap();
    start(&mut hub);
    hub.until(WAIT, || {
        (record(&hub, "uncertain-note")["live"] == true).then_some(())
    });
    assert_eq!(prompt_count(&hub, "UNCERTAIN-REOPEN-NOTE"), 1);
    assert_eq!(reopen_count(&hub, "uncertain-note"), 1);
    hub.stop();
}

#[test]
fn an_owner_paused_lane_stays_down_after_restart() {
    let (mut hub, _) = lane_hub("");
    start(&mut hub);
    open(&hub, "paused", &json!({}));
    lane(
        &hub,
        "pause",
        &json!({"key":"paused","reason":"owner said wait"}),
    )
    .unwrap();
    let before = record(&hub, "paused");
    hub.stop();
    let launches = std::fs::read(data(&hub).join("launch")).unwrap();
    start(&mut hub);
    hub.until(WAIT, || {
        (!events_of(&hub, "lane.recap").is_empty()).then_some(())
    });
    let after = record(&hub, "paused");
    assert_eq!(after["live"], false);
    assert_eq!(after["state"], "held");
    assert_eq!(after["reason"], before["reason"]);
    assert_eq!(after["run_id"], before["run_id"]);
    assert_eq!(std::fs::read(data(&hub).join("launch")).unwrap(), launches);
    hub.stop();
}
