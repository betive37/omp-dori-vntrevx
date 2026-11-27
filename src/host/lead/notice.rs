//! What the owner hears directly while the lead cannot start: once when a start passes the 15 s
//! notice, and once per hold. Both go to his home room as hub events, never only through the lead,
//! which is the session that is not available. The words are in his language and say that the
//! conversation and work are kept and how to go on after fixing the cause; a fresh lead is never
//! the suggested repair. What was said survives a hub restart, so a hold that a restart or an
//! update finds again is not told again. `cataly lead status` and `cataly health` show the same
//! hold text.

use tokio::sync::{mpsc, watch};

use super::{AnchorView, Events, LEAD};
use crate::config::{Config, Language};
use crate::jobs::event::{Emit, EventKind, Severity, one_line};
use crate::log;
use crate::store::host::episode::Episode;
use crate::store::{Apply, MemoryWrite, Store};

/// The memory that keeps what the owner was told; no configured job has this name.
const JOB: &str = "@lead";
const SUBJECT: &str = "notice";
const HELD: &str = "held";
const SLOW: &str = "slow";
/// Longest reason quoted to the owner.
const REASON_MAX: usize = 300;

/// What the notice task is asked to do, in order.
#[derive(Debug)]
pub(super) enum Notice {
    /// A start passed the 15 s notice: the attempt's handle and the session it resumes.
    Slow {
        handle: String,
        session: Option<String>,
    },
    /// The lead is held, with the reason the hub gave.
    Held(String),
    /// The lead bound a session: a later hold is a new one.
    Bound,
}

/// The sending side, kept by the lead; the task takes the receiver once.
pub(super) struct Notices {
    tx: mpsc::UnboundedSender<Notice>,
    rx: std::sync::Mutex<Option<mpsc::UnboundedReceiver<Notice>>>,
}

impl Default for Notices {
    fn default() -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        Self {
            tx,
            rx: std::sync::Mutex::new(Some(rx)),
        }
    }
}

impl Notices {
    pub(super) fn send(&self, notice: Notice) {
        // Closed only when the hub's runtime shuts down.
        let _ = self.tx.send(notice);
    }

    pub(super) fn take(&self) -> Option<mpsc::UnboundedReceiver<Notice>> {
        self.rx
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
    }
}

/// A hold as the owner hears it: what identifies it across hub restarts, and its reason. A hold
/// of the recovery episode (a rejected start, the retries spent, the owner's stop) is that
/// episode's, whose reason is the first cause, not the "recovery is held" a restart finds; any
/// other hold is its reason.
pub(crate) fn hold(episode: Option<&Episode>, reason: &str) -> (String, String) {
    match episode {
        Some(e) if e.state != "active" && e.state != "bound" => (
            format!("episode:{}:{}:{}", e.session_id, e.started_ms, e.state),
            e.detail.clone().unwrap_or_else(|| reason.to_string()),
        ),
        _ => (format!("reason:{reason}"), reason.to_string()),
    }
}

/// The hold text: the reason, what is kept, the command after the fix, and that an update does
/// not lift the hold.
pub(crate) fn held_text(language: Language, reason: &str, anchor: Option<&AnchorView>) -> String {
    let reason = one_line(reason, REASON_MAX);
    if anchor.is_none() {
        return match language {
            Language::Korean => format!(
                "Cataly: lead가 보류되어 스스로 시작하지 않습니다.\n원인: {reason}\n\
                 보존: 기존 대화 파일과 작업, 대기 중인 메시지. 아무것도 교체하거나 삭제하지 않았습니다.\n\
                 원인을 해결한 뒤 `cataly lead start`를 실행하세요. 이전에 확인된 대화가 없을 때만 최초 시작을 다시 시도합니다. \
                 새 대화를 명시적으로 선택하려면 `cataly lead start --fresh`를 쓰세요.\n\
                 업데이트나 허브 재시작만으로는 이 보류가 풀리지 않습니다."
            ),
            Language::English => format!(
                "Cataly: the lead is held and will not start by itself.\nReason: {reason}\n\
                 Kept: existing transcript files, work and queued messages; nothing was replaced or deleted.\n\
                 After fixing the cause, run `cataly lead start`; it retries the initial start only if no conversation was ever bound. \
                 Choose `cataly lead start --fresh` explicitly for a new conversation.\n\
                 An update or a hub restart does not lift this hold by itself."
            ),
        };
    }
    let which = |ko: bool| {
        anchor.map_or_else(String::new, |a| {
            if ko {
                format!("(세션 {}, {})", a.session_id, a.session_file)
            } else {
                format!(" (session {}, {})", a.session_id, a.session_file)
            }
        })
    };
    match language {
        Language::Korean => format!(
            "Cataly: lead가 보류되어 스스로 시작하지 않습니다.\n\
             원인: {reason}\n\
             보존: 대화{}와 작업, 대기 중인 메시지. 아무것도 교체하거나 삭제하지 않았습니다.\n\
             원인을 해결한 뒤 `cataly lead start`로 이 대화를 이어서 시작하세요(새 대화를 원할 때만 `cataly lead start --fresh`).\n\
             업데이트나 허브 재시작만으로는 이 보류가 풀리지 않습니다.",
            which(true)
        ),
        Language::English => format!(
            "Cataly: the lead is held and will not start by itself.\n\
             Reason: {reason}\n\
             Kept: the conversation{}, its work and your queued messages; nothing was replaced or deleted.\n\
             After fixing the cause, run `cataly lead start` to resume this conversation (`cataly lead start --fresh` only if you want a new conversation instead).\n\
             An update or a hub restart does not lift this hold by itself.",
            which(false)
        ),
    }
}

/// The 15 s text: not a failure yet, what is kept, the limits, and where to watch.
pub(crate) fn slow_text(language: Language, session: Option<&str>, attempt: u32) -> String {
    match (language, session) {
        (Language::Korean, Some(id)) => format!(
            "Cataly: lead가 기존 대화를 15초째 여는 중입니다(세션 {id}, {attempt}번째 시도). 아직 실패가 아닙니다. 대화와 작업, 대기 중인 메시지는 보존되며 준비되면 그 대화로 전달됩니다.\n\
             한 번의 시도는 최대 60초, 재시도는 최대 5분까지 이어집니다. 진행 상황은 `cataly lead status`로 볼 수 있고, 결국 보류되면 한 번 더 알려드립니다."
        ),
        (Language::Korean, None) => "Cataly: 요청하신 새 lead 대화를 15초째 시작하는 중입니다. 아직 실패가 아닙니다. 대기 중인 메시지는 보존되며 준비되면 전달되고, 이전 대화 기록도 그대로 남아 있습니다.\n\
             한 번의 시도는 최대 60초입니다. 진행 상황은 `cataly lead status`로 볼 수 있고, 결국 보류되면 한 번 더 알려드립니다."
            .into(),
        (Language::English, Some(id)) => format!(
            "Cataly: the lead has been starting its existing conversation for 15 s (session {id}, attempt {attempt}). This is not a failure yet: the conversation, its work and your queued messages are kept, and the messages go to it once it is ready.\n\
             Each attempt may take up to 60 s; retries continue for up to 5 minutes. `cataly lead status` shows progress; you hear once more only if it ends held."
        ),
        (Language::English, None) => "Cataly: the lead has been starting the new conversation you asked for for 15 s. This is not a failure yet: your queued messages are kept and go to it once it is ready, and the earlier conversation stays recorded.\n\
             An attempt may take up to 60 s. `cataly lead status` shows progress; you hear once more only if it ends held."
            .into(),
    }
}

/// What the notice task reads from the hub.
pub(super) struct Env {
    pub(super) store: Store,
    pub(super) config: watch::Receiver<std::sync::Arc<Config>>,
    pub(super) events: Events,
}

/// Tells the owner, in order, what the lead asks; runs until the lead is dropped.
pub(super) async fn serve(mut rx: mpsc::UnboundedReceiver<Notice>, env: Env) {
    while let Some(notice) = rx.recv().await {
        if let Err(e) = one(&env, notice).await {
            log::warn("owner notice not given", &[("error", &e)]);
        }
    }
}

async fn one(env: &Env, notice: Notice) -> Result<(), String> {
    let config = std::sync::Arc::clone(&env.config.borrow());
    let language = config.hub.language;
    let pin = config.lead.as_ref().and_then(|l| l.session_id.clone());
    let (selected, episode, said) = env
        .store
        .read(move |r| {
            Ok((
                r.lead_target(pin.as_deref())?,
                r.startup_episode(LEAD)?,
                r.memory(JOB, false)?,
            ))
        })
        .await
        .map_err(|e| e.to_string())?;
    let told = |condition: &str| {
        said.iter()
            .find(|(s, c, _)| s == SUBJECT && c == condition)
            .map(|(_, _, v)| v.clone())
    };
    match notice {
        Notice::Bound => {
            if told(HELD).is_some() {
                remember(env, HELD, None).await?;
            }
        }
        Notice::Slow { handle, session } => {
            let active = episode
                .as_ref()
                .filter(|e| e.state == "active" && session.as_deref() == Some(&e.session_id));
            let key = active.map_or_else(
                || format!("attempt:{handle}"),
                |e| format!("episode:{}:{}", e.session_id, e.started_ms),
            );
            if told(SLOW).as_deref() == Some(key.as_str()) {
                return Ok(());
            }
            remember(env, SLOW, Some(key)).await?;
            let attempt = active.map_or(1, |e| e.retries.saturating_add(1));
            let text = slow_text(language, session.as_deref(), attempt);
            (env.events)(
                Emit::new(EventKind::LeadSlow, Severity::Warning, true, LEAD)
                    .with("notice", text)
                    .with("session", session.unwrap_or_default())
                    .for_owner(),
            );
        }
        Notice::Held(reason) => {
            let (key, reason) = hold(episode.as_ref(), &reason);
            if told(HELD).as_deref() == Some(key.as_str()) {
                return Ok(());
            }
            remember(env, HELD, Some(key)).await?;
            let anchor = super::anchor_view(selected);
            let text = held_text(language, &reason, anchor.as_ref());
            (env.events)(
                Emit::new(EventKind::LeadHeld, Severity::Warning, true, LEAD)
                    .with("notice", text)
                    .with("reason", reason)
                    .with("session", anchor.map_or_default(|a| a.session_id))
                    .for_owner(),
            );
        }
    }
    Ok(())
}

/// Records what was told before it is said: a crash in between loses one notice, never repeats one.
async fn remember(env: &Env, condition: &str, value: Option<String>) -> Result<(), String> {
    env.store
        .apply(Apply {
            memory: vec![MemoryWrite {
                job: JOB.into(),
                subject: SUBJECT.into(),
                condition: condition.into(),
                dry: false,
                value,
            }],
            ..Apply::default()
        })
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn episode(state: &str) -> Episode {
        Episode {
            target: LEAD.into(),
            session_id: "s1".into(),
            started_ms: 7,
            deadline_ms: 300_007,
            retries: 0,
            next_ms: None,
            state: state.into(),
            detail: Some("startup Ready Rejected: wrong protocol".into()),
        }
    }

    /// A hold the restart finds again ("recovery is held") is the same hold as the rejection
    /// that made it, with that first cause as its reason; any other hold is its own reason.
    #[test]
    fn a_hold_is_known_again_after_a_restart() {
        let first = hold(
            Some(&episode("held")),
            "startup Ready Rejected: wrong protocol",
        );
        let again = hold(
            Some(&episode("held")),
            "recovery is held; explicit owner retry required",
        );
        assert_eq!(first, again);
        assert_eq!(first.1, "startup Ready Rejected: wrong protocol");
        let other = hold(Some(&episode("bound")), "lease held");
        assert_eq!(other, ("reason:lease held".into(), "lease held".into()));
    }

    #[test]
    fn the_hold_text_says_reason_kept_command_and_update() {
        let anchor = AnchorView {
            session_id: "s1".into(),
            session_file: "/x/s1.jsonl".into(),
            cwd: "/".into(),
            runtime: "headless".into(),
            provenance: None,
        };
        for language in [Language::English, Language::Korean] {
            let text = held_text(language, "startup Ready Rejected: bad", Some(&anchor));
            assert!(text.contains("startup Ready Rejected: bad"), "{text}");
            assert!(
                text.contains("s1") && text.contains("/x/s1.jsonl"),
                "{text}"
            );
            assert!(text.contains("`cataly lead start`"), "{text}");
            assert!(text.contains("`cataly lead start --fresh`"), "{text}");
            assert!(text.lines().count() == 5, "{text}");
        }
        let en = held_text(Language::English, "r", None);
        assert!(en.contains("Kept: the conversation, its work"), "{en}");
        assert!(en.contains("does not lift this hold"), "{en}");
        let ko = held_text(Language::Korean, "r", None);
        assert!(
            ko.contains("보존") && ko.contains("풀리지 않습니다"),
            "{ko}"
        );
        // Fresh is offered only as a different conversation, never as the repair.
        assert!(!en.contains("fix it with --fresh"));
        let slow = slow_text(Language::English, Some("s1"), 2);
        assert!(
            slow.contains("15 s") && slow.contains("attempt 2") && slow.contains("not a failure")
        );
        assert!(slow.contains("kept") && !slow.contains("--fresh"), "{slow}");
        let slow = slow_text(Language::Korean, Some("s1"), 1);
        assert!(slow.contains("15초") && slow.contains("보존"), "{slow}");
    }
}
