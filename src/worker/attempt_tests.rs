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
    let live = link.spawn(&argv, &cwd, &[], "live", None).await.unwrap();
    link.call(
        "forget_attempts",
        json!({"attempts":["old", "missing"]}),
        Duration::from_secs(15),
    )
    .await
    .unwrap();
    assert!(
        link.call(
            "forget_attempts",
            json!({"attempts":["live"]}),
            Duration::from_secs(15)
        )
        .await
        .is_err()
    );
    assert!(!root.join("attempts/old.json").exists());
    assert!(root.join("attempts/retained.json").exists());
    assert!(root.join("attempts/live.json").exists());
    let states = link.attempts(&["retained", "live"]).await.unwrap();
    assert!(matches!(states["retained"], AttemptState::Reaped { .. }));
    assert!(matches!(states["live"], AttemptState::Running { .. }));
    drop(live);
    link.mux.close();
    assert_eq!(serving.await.unwrap(), crate::cli::exit::OK);
}
