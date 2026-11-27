//! The voice connection's owner-facing state, shared by CLI status and the ops panel.

use crate::config::Language;

#[cfg_attr(
    not(feature = "voice"),
    expect(dead_code, reason = "only voice builds produce connection states")
)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Voice {
    Waiting(u64),
    Joining(u64),
    InCall(u64),
    Held(String),
    Stopped(String),
}

impl Voice {
    pub(crate) fn text(&self, language: Language) -> String {
        match (self, language) {
            (Self::Waiting(channel), Language::English) => {
                format!("waiting for you in <#{channel}>")
            }
            (Self::Waiting(channel), Language::Korean) => {
                format!("<#{channel}>에서 너를 기다리는 중")
            }
            (Self::Joining(channel), Language::English) => format!("joining <#{channel}>"),
            (Self::Joining(channel), Language::Korean) => format!("<#{channel}>에 연결 중"),
            (Self::InCall(channel), Language::English) => format!("in the call in <#{channel}>"),
            (Self::InCall(channel), Language::Korean) => format!("<#{channel}>에서 통화 중"),
            (Self::Held(reason), Language::English) => format!("held: {reason}"),
            (Self::Held(reason), Language::Korean) => format!("보류: {reason}"),
            (Self::Stopped(reason), Language::English) => format!("stopped: {reason}"),
            (Self::Stopped(reason), Language::Korean) => format!("멈춤: {reason}"),
        }
    }
}
