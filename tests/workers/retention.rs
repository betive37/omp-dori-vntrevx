use super::*;

#[test]
fn superseded_worker_attempt_is_pruned_only_after_lane_reconciliation() {
    let (mut hub, repo) = lane_hub("");
    let w = WorkerBox::new(&hub, "box", 22);
    let hub_id = enrol(&hub, &w, "dev@box", &[]);
    start(&mut hub);
    lane(&hub, "open", &json!({"key":"retention", "title":"Remote retention", "brief":"Work.", "checks":[{"kind":"command","argv":["true"]}], "cwd":repo,"worker":"box"})).unwrap();
    let before = record(&hub, "retention");
    let dir = w
        .root
        .join("state/cataly/worker")
        .join(hub_id)
        .join("attempts");
    let old: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(old.len(), 1);
    hub.stop();
    assert!(
        old[0].exists(),
        "the lane still references this reaped attempt"
    );
    start(&mut hub);
    hub.until(WAIT, || {
        let rec = record(&hub, "retention");
        (rec["live"] == true && !old[0].exists()).then_some(())
    });
    assert_eq!(
        record(&hub, "retention")["session_id"],
        before["session_id"]
    );
    let current: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(current.len(), 1);
    hub.stop();
    assert!(
        current[0].exists(),
        "the current lane attempt stays reconcilable"
    );
}
