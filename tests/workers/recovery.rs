use super::*;

#[test]
fn legacy_worker_lane_resumes_without_attempt_records() {
    let (mut hub, repo) = lane_hub("");
    let w = WorkerBox::new(&hub, "box", 22);
    let hub_id = enrol(&hub, &w, "dev@box", &[]);
    start(&mut hub);
    lane(&hub, "open", &json!({"key":"legacy", "title":"Legacy remote", "brief":"Work.", "checks":[{"kind":"command","argv":["true"]}], "cwd":repo,"worker":"box"})).unwrap();
    let before = record(&hub, "legacy");
    hub.stop();
    let db = rusqlite::Connection::open(hub.state().join("cataly.db")).unwrap();
    db.execute(
        "UPDATE lanes SET record=json_remove(record, '$.startup_cleanup', '$.pending_reopen') WHERE key='legacy'",
        [],
    )
    .unwrap();
    let journal = hub.state().join("startup");
    if journal.exists() {
        std::fs::remove_dir_all(journal).unwrap();
    }
    std::fs::remove_dir_all(
        w.root
            .join("state/cataly/worker")
            .join(&hub_id)
            .join("attempts"),
    )
    .unwrap();
    start(&mut hub);
    let after = hub.until(WAIT, || {
        let rec = record(&hub, "legacy");
        (rec["live"] == true && rec["lost"].is_null()).then_some(rec)
    });
    assert_eq!(after["session_id"], before["session_id"]);
    assert_eq!(after["session_file"], before["session_file"]);
    assert_eq!(after["run_id"], before["run_id"]);
    assert_eq!(w.tokens(&before["session_id"]).len(), 2);
    hub.stop();
}
