//! One owner message in the retained native wire format. Source fingerprints retain TypeScript parity;
//! URL-free attachment references are opt-in, while default native records keep their historical fields.

use std::fmt::Write as _;

use anyhow::{Result, bail};
use reqwest::Url;
use serde_json::{Number, Value};
use sha2::{Digest, Sha256};

use super::Snowflake;

mod json;

const IS_VOICE_MESSAGE: u32 = 13;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ReplyStatus {
    Unresolved,
    Unavailable,
}

/// Reply context is data; compare the author ID with the owner and bot identifiers from `INBOUND_READY`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct InboundReply {
    pub(super) id: Snowflake,
    pub(super) author: Option<Snowflake>,
    pub(super) text: Option<String>,
    pub(super) status: Option<ReplyStatus>,
}

/// One owner attachment, retaining Discord field names and the exact expiring signed CDN URL.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct InboundAttachment {
    pub(super) id: Option<Snowflake>,
    pub(super) filename: String,
    pub(super) content_type: Option<String>,
    pub(super) size: i64,
    pub(super) url: String,
    /// Set by the message's `IS_VOICE_MESSAGE` flag.
    pub(super) voice: bool,
    pub(super) duration_secs: Option<Number>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Inbound {
    pub(super) channel: Snowflake,
    pub(super) message: Snowflake,
    pub(super) reference: Option<Snowflake>,
    pub(super) text: String,
    pub(super) reply_to: Option<InboundReply>,
    pub(super) attachments: Vec<InboundAttachment>,
    pub(super) unreferenced_text: bool,
}

/// A locally detected response fault (TS `inboundProtocolError`); it is never classified as transient.
fn protocol(message: &str) -> anyhow::Error {
    anyhow::anyhow!("{message}")
}

fn snowflake(raw: Option<&Value>) -> Option<Snowflake> {
    match raw {
        Some(Value::String(id)) => Snowflake::try_from(id.clone()).ok(),
        _ => None,
    }
}

impl Inbound {
    /// `toInbound` (discord-inbound-api.ts:139-184) for a message whose `id` and `channel_id` are snowflakes.
    pub(super) fn from_raw(raw: &Value) -> Result<Self> {
        let (Some(message), Some(channel)) =
            (snowflake(raw.get("id")), snowflake(raw.get("channel_id")))
        else {
            return Err(protocol("Discord inbound message response is invalid"));
        };
        let Some(Value::String(text)) = raw.get("content") else {
            bail!(
                "Discord inbound owner message content is unavailable; enable Message Content Intent"
            );
        };
        let reference_record = raw.get("message_reference");
        let is_reply = match reference_record.and_then(|value| value.get("type")) {
            None | Some(Value::Null) => true,
            kind => json::is_zero(kind),
        };
        let reference = if is_reply {
            reference_record.and_then(|value| value.get("message_id"))
        } else {
            None
        };
        let replied = if is_reply {
            raw.get("referenced_message")
        } else {
            None
        };
        let reference_channel = if is_reply {
            reference_record.and_then(|value| value.get("channel_id"))
        } else {
            None
        };
        if reference_channel.is_some()
            && !json::strict_equal(reference_channel, raw.get("channel_id"))
        {
            return Err(protocol(
                "Discord inbound reply belongs to a different channel or thread",
            ));
        }
        if json::truthy(replied) {
            let snapshot_channel = replied.and_then(|value| value.get("channel_id"));
            let snapshot_id = replied.and_then(|value| value.get("id"));
            if (snapshot_channel.is_some()
                && !json::strict_equal(snapshot_channel, raw.get("channel_id")))
                || (reference.is_some() && !json::strict_equal(snapshot_id, reference))
            {
                return Err(protocol(
                    "Discord inbound reply snapshot does not match its message and channel",
                ));
            }
        }
        let mut reply_to = None;
        let mut reference_id = None;
        if reference.is_some() {
            let Some(id) = snowflake(reference) else {
                return Err(protocol("Discord inbound reply reference is invalid"));
            };
            reference_id = Some(id);
            let content = replied.and_then(|value| value.get("content"));
            reply_to = Some(InboundReply {
                id,
                author: snowflake(
                    replied
                        .and_then(|value| value.get("author"))
                        .and_then(|value| value.get("id")),
                ),
                text: match content {
                    Some(Value::String(text)) => Some(text.clone()),
                    _ => None,
                },
                status: match replied {
                    None => Some(ReplyStatus::Unresolved),
                    Some(Value::Null) => Some(ReplyStatus::Unavailable),
                    Some(_) => None,
                },
            });
        }
        let attachments = attachments(raw)?;
        let unreferenced_text = json::is_zero(raw.get("type"))
            && reference_record.is_none()
            && replied.is_none()
            && raw.get("message_snapshots").is_none()
            && match raw.get("attachments") {
                None => true,
                Some(Value::Array(items)) => items.is_empty(),
                Some(_) => false,
            };
        Ok(Self {
            channel,
            message,
            reference: reference_id,
            text: text.clone(),
            reply_to,
            attachments,
            unreferenced_text,
        })
    }

    /// `formatDiscordInbound` (discord-inbound.ts:45-52).
    pub(super) fn format(&self) -> String {
        let id = format!("discord {} {}", self.channel, self.message);
        let reference = self
            .reference
            .map_or_else(|| "-".to_owned(), |id| id.to_string());
        let mut out = format!("INBOUND {id} from=owner ref={reference} ");
        json::string(&mut out, &self.text);
        if let Some(reply) = &self.reply_to {
            let _ = write!(out, "\nINBOUND_REPLY {id} ");
            reply.write(&mut out);
        }
        for attachment in &self.attachments {
            let _ = write!(out, "\nINBOUND_ATTACHMENT {id} ");
            attachment.write(&mut out, false);
        }
        out
    }

    /// URL-free records are built before any admission or cursor write.
    pub(super) fn format_refs(&self, bot: Snowflake, owner: Snowflake) -> Result<String> {
        let mut text = self.format();
        if self.attachments.is_empty() {
            return Ok(text);
        }
        text.truncate(text.find("\nINBOUND_ATTACHMENT ").unwrap_or(text.len()));
        for attachment in &self.attachments {
            let id = attachment.id.ok_or_else(|| protocol("Discord attachment has no unique file reference; use default URL records or repair its metadata"))?;
            if attachment.size < 0 {
                bail!("Discord attachment has invalid size");
            }
            let mut raw = String::new();
            attachment.write(&mut raw, false);
            let mut record: Value = serde_json::from_str(&raw)?;
            let object = record.as_object_mut().expect("attachment object");
            object.remove("url");
            object.insert("id".to_owned(), Value::String(id.to_string()));
            object.insert(
                "ref".to_owned(),
                Value::String(format!(
                    "discord-file:{bot}:{owner}:{}:{}:{id}",
                    self.channel, self.message
                )),
            );
            let _ = write!(
                text,
                "\nINBOUND_ATTACHMENT discord {} {} {}",
                self.channel,
                self.message,
                serde_json::to_string(&record)?
            );
        }
        Ok(text)
    }

    /// `{"channel":…,"message":…,"reference":…,"text":…` shared by both serializations.
    fn prefix(&self) -> String {
        let reference = self
            .reference
            .map_or_else(|| "null".to_owned(), |id| format!("\"{id}\""));
        let mut out = format!(
            "{{\"channel\":\"{}\",\"message\":\"{}\",\"reference\":{reference},\"text\":",
            self.channel, self.message
        );
        json::string(&mut out, &self.text);
        out
    }

    /// The canonical JSON hashed by `discordSourceFingerprint`.
    fn canonical(&self) -> String {
        let mut out = self.prefix();
        out.push_str(",\"attachments\":[");
        for (index, attachment) in self.attachments.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            attachment.write(&mut out, true);
        }
        out.push_str("]}");
        out
    }

    /// `discordSourceFingerprint` (discord-source-fingerprint.ts:11-29): lowercase SHA-256 hex.
    pub(super) fn fingerprint(&self) -> String {
        format!("{:x}", Sha256::digest(self.canonical().as_bytes()))
    }

    /// `[bot, owner, channel, message].join(":")` (head-admission.ts:123).
    pub(super) fn identity(&self, bot: Snowflake, owner: Snowflake) -> String {
        format!("{bot}:{owner}:{}:{}", self.channel, self.message)
    }

    /// `JSON.stringify(message)` of the TS `DiscordInbound`, stored as an admission `source`.
    pub(super) fn source_json(&self) -> String {
        let mut out = self.prefix();
        out.push_str(",\"replyTo\":");
        match &self.reply_to {
            Some(reply) => reply.write(&mut out),
            None => out.push_str("null"),
        }
        out.push_str(",\"attachments\":[");
        for (index, attachment) in self.attachments.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            attachment.write(&mut out, false);
        }
        out.push(']');
        if self.unreferenced_text {
            out.push_str(",\"unreferencedText\":true");
        }
        out.push('}');
        out
    }
}

impl InboundReply {
    fn write(&self, out: &mut String) {
        let author = self
            .author
            .map_or_else(|| "null".to_owned(), |id| format!("\"{id}\""));
        let _ = write!(
            out,
            "{{\"id\":\"{}\",\"author\":{author},\"text\":",
            self.id
        );
        match &self.text {
            Some(text) => json::string(out, text),
            None => out.push_str("null"),
        }
        match self.status {
            Some(ReplyStatus::Unresolved) => out.push_str(",\"status\":\"unresolved\""),
            Some(ReplyStatus::Unavailable) => out.push_str(",\"status\":\"unavailable\""),
            None => {}
        }
        out.push('}');
    }
}

impl InboundAttachment {
    /// The delivered object (`fingerprint == false`) or the fingerprint projection with a stable CDN URL.
    fn write(&self, out: &mut String, fingerprint: bool) {
        out.push_str("{\"filename\":");
        json::string(out, &self.filename);
        if !fingerprint && let Some(kind) = &self.content_type {
            out.push_str(",\"content_type\":");
            json::string(out, kind);
        }
        let _ = write!(out, ",\"size\":{},\"url\":", self.size);
        if fingerprint {
            json::string(out, &stable_url(&self.url));
            if let Some(kind) = &self.content_type {
                out.push_str(",\"content_type\":");
                json::string(out, kind);
            }
        } else {
            json::string(out, &self.url);
        }
        if self.voice {
            out.push_str(",\"voice\":true");
        }
        if let Some(duration) = &self.duration_secs {
            out.push_str(",\"duration_secs\":");
            json::value(out, Some(&Value::Number(duration.clone())));
        }
        out.push('}');
    }
}

fn attachments(raw: &Value) -> Result<Vec<InboundAttachment>> {
    let list = match raw.get("attachments") {
        None => return Ok(Vec::new()),
        Some(Value::Array(list)) => list,
        Some(_) => return Err(protocol("Discord inbound attachment list is invalid")),
    };
    let voice = json::has_bit(raw.get("flags"), IS_VOICE_MESSAGE);
    list.iter()
        .map(|value| {
            let Value::Object(item) = value else {
                return Err(protocol("Discord inbound attachment is invalid"));
            };
            let (Some(Value::String(filename)), Some(Value::String(url)), Some(size)) = (
                item.get("filename"),
                item.get("url"),
                json::safe_integer(item.get("size")),
            ) else {
                return Err(protocol("Discord inbound attachment is invalid"));
            };
            let id = snowflake(item.get("id")).filter(|id| {
                list.iter()
                    .filter(|entry| snowflake(entry.get("id")) == Some(*id))
                    .count()
                    == 1
            });
            Ok(InboundAttachment {
                id,
                filename: filename.clone(),
                content_type: match item.get("content_type") {
                    Some(Value::String(kind)) => Some(kind.clone()),
                    _ => None,
                },
                size,
                url: url.clone(),
                voice,
                duration_secs: match item.get("duration_secs") {
                    Some(Value::Number(duration)) => Some(duration.clone()),
                    _ => None,
                },
            })
        })
        .collect()
}

/// CDN authorization (`ex`, `is`, `hm`) is fetched context, not a revision of the owner's input. Like
/// `URLSearchParams.delete`, the remaining query is reserialized as `application/x-www-form-urlencoded`.
fn stable_url(value: &str) -> String {
    let Ok(mut url) = Url::parse(value) else {
        return value.to_owned();
    };
    if !matches!(
        url.host_str(),
        Some("cdn.discordapp.com" | "media.discordapp.net")
    ) {
        return value.to_owned();
    }
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(name, _)| !matches!(name.as_ref(), "ex" | "is" | "hm"))
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect();
    if kept.is_empty() {
        url.set_query(None);
    } else {
        url.query_pairs_mut().clear().extend_pairs(kept);
    }
    url.into()
}

/// `discordRawFingerprint` (discord-source-fingerprint.ts:32-40): a queued duplicate with another raw
/// fingerprint is a source identity conflict.
pub(super) fn raw_fingerprint(raw: &Value) -> Result<String> {
    let author = raw.get("author");
    let mut out = String::from("[");
    json::value(&mut out, author.and_then(|value| value.get("id")));
    let flag = |name: &str| author.and_then(|value| value.get(name)) == Some(&Value::Bool(true));
    out.push_str(if flag("bot") { ",true," } else { ",false," });
    out.push_str(if flag("system") { "true," } else { "false," });
    json::value(&mut out, raw.get("webhook_id"));
    out.push(',');
    json::value(&mut out, raw.get("type"));
    out.push_str(",\"");
    out.push_str(&Inbound::from_raw(raw)?.fingerprint());
    out.push_str("\"]");
    Ok(out)
}

/// `isOwnerMessage` (discord-inbound-api.ts:131-137): the owner's own text or reply, not a bot, webhook or
/// system message.
pub(super) fn is_owner(raw: &Value, owner: Snowflake, bot: Snowflake) -> bool {
    let author = raw.get("author");
    let field = |name: &str| author.and_then(|author| author.get(name));
    let owner = owner.to_string();
    field("id").and_then(Value::as_str) == Some(owner.as_str())
        && owner != bot.to_string()
        && !json::truthy(field("bot"))
        && !json::truthy(field("system"))
        && !json::truthy(raw.get("webhook_id"))
        && (json::is_zero(raw.get("type")) || json::is_number(raw.get("type"), 19))
}

/// `JSON.stringify(text)`, for callers that format lines next to an `Inbound`.
pub(super) fn quoted(text: &str) -> String {
    json::quoted(text)
}

#[cfg(test)]
mod tests;
