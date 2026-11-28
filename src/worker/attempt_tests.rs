use super::attempt::AttemptState;
use super::link::tests::served;
use serde_json::json;
use std::time::Duration;
use tokio::io::AsyncWriteExt as _;

#[tokio::test]
async fn only_acknowledged_reaped_attempts_are_forgotten() {
    let root = crate::sys::fs::tests::scratch("worker-forget");
    let (link, serving) = served(&root);
    let cwd = root.display().to_string();
    let argv = vec!["omp".into(), "-c".into(), "exec cat >/dev/null".into()];
    let mut old = link.spawn(&argv, &cwd, &[], "old", None).await.unwrap();
    old.stream.shutdown().await.unwrap();
    assert!(matches!(old.exit.wait().await, AttemptState::Reaped { .. }));
    let mut retained = link
        .spawn(&argv, &cwd, &[], "retained", None)
        .await
        .unwrap();
    retained.stream.shutdown().await.unwrap();
    assert!(matches!(
        retained.exit.wait().await,
        AttemptState::Reaped { .. }
    ));
    // An earlier connection's process still exists. Its lifetime is owned by the fixture,
    // not the current worker channel, so the forget request must consult its saved identity.
    let mut live = tokio::process::Command::new("sleep")
        .arg("60")
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut live_record = super::attempt::Attempts::new(&root)
        .begin("live", None)
        .unwrap();
    live_record.spawned(live.id()).await.unwrap();
    let observed = link.attempts(&["live"]).await.unwrap();
    assert!(
        matches!(observed["live"], AttemptState::Running { .. }),
        "{observed:?}"
    );
    link.forget_attempts(&["old", "missing"]).await.unwrap();
    let refusal = link
        .call(
            "forget_attempts",
            json!({"attempts":["live"]}),
            Duration::from_secs(15),
        )
        .await;
    assert!(refusal.is_err(), "{refusal:?}");
    assert!(!root.join("attempts/old.json").exists());
    assert!(root.join("attempts/retained.json").exists());
    assert!(root.join("attempts/live.json").exists());
    super::attempt::Attempts::new(&root)
        .begin("unknown", None)
        .unwrap();
    assert!(link.forget_attempts(&["unknown"]).await.is_err());
    assert!(root.join("attempts/unknown.json").exists());
    let states = link.attempts(&["retained", "live"]).await.unwrap();
    assert!(matches!(states["retained"], AttemptState::Reaped { .. }));
    assert!(matches!(states["live"], AttemptState::Running { .. }));
    live.kill().await.unwrap();
    link.mux.close();
    assert_eq!(serving.await.unwrap(), crate::cli::exit::OK);
}
