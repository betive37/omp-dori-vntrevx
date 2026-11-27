//! Real rpc-ui handshake and binding under a paused monotonic clock.

use super::*;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

struct Delays {
    factory: u64,
    hook: u64,
    binding: u64,
    change_identity: bool,
}

async fn start(delays: Delays) -> (Result<Started, StartError>, Duration) {
    let (client, server) = tokio::io::duplex(4096);
    let began = tokio::time::Instant::now();
    let deadline = began + STARTUP_BUDGET;
    let peer = tokio::spawn(async move {
        let (read, mut write) = tokio::io::split(server);
        tokio::time::sleep(Duration::from_secs(delays.factory)).await;
        if write
            .write_all(
                b"{\"type\":\"ready\",\"protocolVersion\":1,\"supportedProtocolVersions\":[1,2]}\n",
            )
            .await
            .is_err()
        {
            return;
        }
        let mut lines = BufReader::new(read).lines();
        let mut identities = 0;
        while let Ok(Some(line)) = lines.next_line().await {
            let command: Value = serde_json::from_str(&line).unwrap();
            let kind = command["type"].as_str().unwrap();
            let data = match kind {
                "negotiate_protocol" => {
                    tokio::time::sleep(Duration::from_secs(delays.hook)).await;
                    json!({"protocolVersion":2})
                }
                "get_state" => {
                    if identities == 0 {
                        tokio::time::sleep(Duration::from_secs(delays.binding)).await;
                    }
                    identities += 1;
                    json!({"sessionId": if delays.change_identity && identities == 2 { "B" } else { "A" },
                        "sessionFile":"/tmp/owned-A.jsonl", "isStreaming":false,"isCompacting":false,
                        "queuedMessageCount":0,"isSettled":true,"goal":null,
                        "model":{"provider":"fake","id":"primary"}})
                }
                _ => Value::Null,
            };
            let response = json!({"type":"response","id":command["id"],"command":kind,"success":true,"data":data});
            if write
                .write_all(format!("{response}\n").as_bytes())
                .await
                .is_err()
            {
                return;
            }
        }
    });
    let (read, write) = tokio::io::split(client);
    let (tx, rx) = mpsc::channel(EVENT_QUEUE);
    let result = match Rpc::connect(read, write, STARTUP_BUDGET, Some(tx)).await {
        Ok(rpc) => {
            let settings = Settings {
                deadline: Some(deadline),
                ..Settings::default()
            };
            match Session::bind(
                rpc,
                rx,
                Proc::Fake,
                crate::host::testing::spec("deadline", None),
                settings,
            )
            .await
            {
                Ok((session, started)) => {
                    session.close(true).await.unwrap();
                    Ok(started)
                }
                Err(error) => Err(error),
            }
        }
        Err(error) => Err(StartError::Failed(error.to_string())),
    };
    let elapsed = began.elapsed();
    peer.abort();
    if let Err(error) = peer.await {
        assert!(error.is_cancelled());
    }
    (result, elapsed)
}

#[tokio::test(start_paused = true)]
async fn factory_hook_and_binding_share_the_same_sixty_second_deadline() {
    for (factory, hook, binding, accepted, seconds) in [
        (59, 0, 0, true, 59),
        (61, 0, 0, false, 60),
        (0, 59, 0, true, 59),
        (0, 61, 0, false, 60),
        (30, 29, 0, true, 59),
        (40, 21, 0, false, 60),
        (30, 0, 29, true, 59),
        (30, 0, 31, false, 60),
    ] {
        let (result, elapsed) = start(Delays {
            factory,
            hook,
            binding,
            change_identity: false,
        })
        .await;
        assert_eq!(
            result.is_ok(),
            accepted,
            "factory={factory} hook={hook} binding={binding}: {result:?}"
        );
        assert_eq!(elapsed, Duration::from_secs(seconds));
    }
}

#[tokio::test(start_paused = true)]
async fn repeated_identity_mismatch_holds_without_retry_permission() {
    let (result, _) = start(Delays {
        factory: 0,
        hook: 0,
        binding: 0,
        change_identity: true,
    })
    .await;
    let error = result.unwrap_err();
    assert!(matches!(
        error,
        StartError::Startup {
            stage: StartupStage::Binding,
            outcome: StartupOutcome::Rejected,
            cleanup: Cleanup::LocalReaped,
            ..
        }
    ));
    assert!(!error.retryable());
}

#[tokio::test]
async fn hosted_forwards_cancellation_for_lead_and_lane_before_spawn() {
    let dir = crate::sys::fs::tests::scratch("hosted-cancel");
    let runtime = crate::host::hosted::Hosted::Headless(Headless {
        exe: dir.join("missing-omp"),
        state: dir.join("state"),
        socket: dir.join("socket"),
        logs: dir.join("logs"),
        credentials: Vec::new(),
        extra_flags: Vec::new(),
        spend_phrases: Vec::new(),
        agent_start: Latency::default(),
        links: Arc::new(crate::host::bridge::Links::default()),
    });
    for role in [Role::Lead, Role::Lane] {
        let (_keep, cancel) = watch::channel(true);
        let mut spec = crate::host::testing::spec("cancelled", None);
        spec.role = role;
        let Err(error) = runtime.start_supervised(spec, cancel).await else {
            panic!("cancelled start launched a session");
        };
        assert!(
            matches!(
                error,
                StartError::Startup {
                    stage: StartupStage::Spawn,
                    outcome: StartupOutcome::Cancelled,
                    cleanup: Cleanup::NotSpawned,
                    ..
                }
            ),
            "{error:?}"
        );
    }
    assert!(!dir.join("logs").exists());
}
