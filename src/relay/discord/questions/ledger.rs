//! Buttons on the questions the lead records with `question.ask` (EVR req. 34-40; DISC-OUT req.
//! 67-69): one per option when buttons arrive over the Gateway, the recommended one styled primary
//! but never chosen by itself. The owner's press answers the question like a reply naming the
//! option and tells the lead; anyone else's is refused. However the question is settled, its
//! message then says so and loses its buttons.

use std::fmt::Write as _;
use std::sync::Arc;

use serde_json::{Value, json};

use super::super::intake::Intake;
use super::super::types::Press;
use super::super::{Rest, Snowflake};
use super::{EDIT_BUDGET, LABEL_MAX, neutral};
use crate::host::Runtime;
use crate::jobs::event::{Emit, EventKind, Severity};
use crate::log;
use crate::relay::intake::Health;
use crate::relay::text::DISCORD_LIMIT;
use crate::store::lead::{LeadDone, LeadWrite, QuestionRow};

/// The question as posted: its ID, text, numbered options with the recommended one marked, and how
/// to answer it.
pub(crate) fn body(id: &str, text: &str, options: &[String], recommended: Option<i64>) -> String {
    let mut body = format!("**Question {id}**\n{}", neutral(text));
    for (n, o) in options.iter().enumerate() {
        let mark = if recommended == i64::try_from(n + 1).ok() {
            " (recommended)"
        } else {
            ""
        };
        let _ = write!(body, "\n{}. {}{mark}", n + 1, neutral(o));
    }
    body.push_str("\nReply to this message with a number or your answer.");
    body
}

/// Buttons can be pressed: Discord intake runs and presses reach it over the Gateway (DISC-OUT
/// req. 68), as for the lead's dialogs.
pub(crate) fn buttons_ready(discord: &Health) -> bool {
    discord.buttons && matches!(discord.state.as_str(), "connecting" | "connected")
}

/// One button per option, labelled with its number and cut to Discord's limit; the recommended one
/// primary. Button IDs carry the question ID.
pub(crate) fn buttons(id: &str, options: &[String], recommended: Option<i64>) -> Value {
    let labels: Vec<String> = options
        .iter()
        .enumerate()
        .map(|(n, o)| format!("{}. {o}", n + 1).chars().take(LABEL_MAX).collect())
        .collect();
    let recommended = recommended
        .and_then(|r| usize::try_from(r).ok())
        .and_then(|r| r.checked_sub(1));
    super::buttons(id, &labels, recommended, false, "")
}

fn option(q: &QuestionRow, n: usize) -> &str {
    n.checked_sub(1)
        .and_then(|i| q.options.get(i))
        .map_or("", String::as_str)
}

/// Option `n` (from 1) as the ledger records it.
pub(crate) fn picked(q: &QuestionRow, n: usize) -> String {
    format!("option {n} ({})", option(q, n))
}

/// Option `n` (from 1) as the question's message lists it.
pub(crate) fn shown(q: &QuestionRow, n: usize) -> String {
    format!("{n}. {}", neutral(option(q, n)))
}

/// The question's text in the lead's event is cut to this many characters, so the event's one line
/// (`jobs::event::TEXT_MAX`) always holds the question ID and the whole chosen option first.
const EXCERPT_MAX: usize = 100;

/// Told privately when a press was acknowledged but could not be recorded.
const NOT_RECORDED: &str = "Your answer could not be recorded. Press the button again.";

fn excerpt(text: &str) -> String {
    if text.chars().count() <= EXCERPT_MAX {
        return text.to_string();
    }
    let mut out: String = text.chars().take(EXCERPT_MAX - 1).collect();
    out.push('…');
    out
}

/// The question's body followed by `status`, within one Discord message: a body too long to leave
/// room for the status is cut at its end and marked with "…", so the status always shows.
fn closed(body: &str, status: &str) -> String {
    const CUT: &str = "…";
    let tail = format!("\n\n{status}");
    let full = body.encode_utf16().count() + tail.encode_utf16().count();
    if full <= DISCORD_LIMIT {
        return format!("{body}{tail}");
    }
    let room =
        DISCORD_LIMIT.saturating_sub(tail.encode_utf16().count() + CUT.encode_utf16().count());
    let mut used = 0;
    let head: String = body
        .chars()
        .take_while(|c| {
            used += c.len_utf16();
            used <= room
        })
        .collect();
    // A cut right after an escaping backslash would escape the mark instead.
    let escaping = head.chars().rev().take_while(|c| *c == '\\').count() % 2 == 1;
    let head = if escaping {
        head.strip_suffix('\\').unwrap_or(&head)
    } else {
        &head
    };
    format!("{head}{CUT}{tail}")
}

/// Edits a settled question's message to end with `status` and drop its buttons; best effort,
/// in the background.
pub(crate) fn close(rest: Arc<Rest>, q: &QuestionRow, status: &str) {
    let (Some(room), Some(message)) = (
        q.room.as_deref().and_then(Snowflake::parse),
        q.message.as_deref().and_then(Snowflake::parse),
    ) else {
        return;
    };
    let content = closed(&body(&q.id, &q.text, &q.options, q.recommended), status);
    let edit = json!({ "content": content, "components": [] });
    tokio::spawn(async move {
        match tokio::time::timeout(EDIT_BUDGET, rest.edit(room, message, edit)).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => log::info("recorded question not updated", &[("error", &e)]),
            Err(_) => log::info("recorded question not updated within 3 s", &[]),
        }
    });
}

impl<T: Runtime> Intake<T> {
    /// A press on a message bound to an open recorded question; `false` when there is none. The
    /// owner's press records the option, tells the lead and closes the buttons; anyone else's, or
    /// a button the question does not have, is refused. The press counts only once acknowledged,
    /// and only the first answer settles the question.
    pub(super) async fn ledger_press(&self, press: &Press) -> bool {
        let (room, message) = (press.channel.to_string(), press.message.to_string());
        let Ok(Some(q)) = self
            .store
            .read(move |r| r.question_at(&room, &message))
            .await
        else {
            return false;
        };
        if !press.by_owner(self.application, self.owner) {
            self.refuse(press, "Only the owner can answer this.").await;
            return true;
        }
        let Some(n) = press
            .custom_id
            .strip_prefix(&format!("cy:{}:", q.id))
            .and_then(|i| i.parse::<usize>().ok())
            .filter(|i| *i < q.options.len())
        else {
            self.refuse(press, "This button is not part of the question.")
                .await;
            return true;
        };
        let ack = json!({ "type": 6 });
        if let Err(e) = self.rest.callback(&press.id, &press.token, ack).await {
            log::info("press not acknowledged", &[("error", &e)]);
            return true;
        }
        let picked = picked(&q, n + 1);
        let write = LeadWrite::QuestionSettle {
            id: q.id.clone(),
            state: "answered".into(),
            outcome: format!("owner press {}: {picked}", press.id),
        };
        match self.store.lead(write).await {
            Ok(LeadDone::Done) => {}
            // Settled a moment earlier by a reply or the lead, which closed it.
            Ok(_) => return true,
            Err(e) => {
                log::warn("question answer not recorded", &[("error", &e)]);
                // Acknowledged but not recorded: the owner hears so privately and may press again.
                let note = json!({ "content": NOT_RECORDED, "flags": 64 });
                if let Err(e) = self
                    .rest
                    .follow_up(self.application, &press.token, note)
                    .await
                {
                    log::info("unrecorded press not reported", &[("error", &e)]);
                }
                return true;
            }
        }
        (self.events)(
            Emit::new(EventKind::QuestionAnswered, Severity::Info, true, &q.id)
                .with("question", &q.id)
                .with("outcome", &picked)
                .with("text", excerpt(&q.text)),
        );
        let status = format!("Answered by the owner: {}", shown(&q, n + 1));
        close(Arc::clone(&self.rest), &q, &status);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buttons_number_every_option_and_fit_discord() {
        let mut options: Vec<String> = (1..=9).map(|n| format!("choice {n}")).collect();
        options[6] = "x".repeat(200);
        let rows = buttons("0a1b2c3d", &options, Some(3));
        let rows = rows.as_array().unwrap();
        assert_eq!(rows.len(), 2, "5 per row");
        assert_eq!(rows[0]["components"].as_array().unwrap().len(), 5);
        assert_eq!(rows[1]["components"].as_array().unwrap().len(), 4);
        let third = &rows[0]["components"][2];
        assert_eq!(third["label"], "3. choice 3");
        assert_eq!(third["style"], 1, "recommended is primary");
        assert_eq!(third["custom_id"], "cy:0a1b2c3d:2");
        assert_eq!(rows[0]["components"][0]["style"], 2);
        let long = rows[1]["components"][1]["label"].as_str().unwrap();
        assert!(long.starts_with("7. x"), "{long}");
        assert_eq!(long.chars().count(), LABEL_MAX);
    }

    #[test]
    fn a_long_question_is_cut_so_its_status_shows() {
        let options = vec!["o".repeat(200); 4];
        let body = body("0a1b2c3d", &"q".repeat(1000), &options, Some(2));
        let status = format!("Answered by the owner: 2. {}", "o".repeat(200));
        let short = closed("short", &status);
        assert_eq!(short, format!("short\n\n{status}"));
        let cut = closed(&body, &status);
        assert!(cut.encode_utf16().count() <= DISCORD_LIMIT);
        assert!(cut.starts_with("**Question 0a1b2c3d**"), "{cut}");
        assert!(cut.ends_with(&format!("…\n\n{status}")), "{cut}");
        let escaped = closed(
            &format!("{}\\*{}", "a".repeat(1986), "b".repeat(10)),
            "Withdrawn.",
        );
        assert!(!escaped.contains("\\…"), "{escaped}");
        assert!(excerpt(&"q".repeat(900)).chars().count() == EXCERPT_MAX);
    }

    #[test]
    fn buttons_need_intake_with_gateway_presses() {
        let mut h = Health {
            state: "connected".into(),
            buttons: true,
            ..Health::default()
        };
        assert!(buttons_ready(&h));
        h.state = "stopped".into();
        assert!(!buttons_ready(&h));
        h.state = "connecting".into();
        h.buttons = false;
        assert!(!buttons_ready(&h));
    }
}
