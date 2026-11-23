use crate::discord::Snowflake;
use serde_json::json;

use super::{Inbound, ReplyStatus, raw_fingerprint, stable_url};

// Each expected digest is SHA-256 over the JSON text that `JSON.stringify` produces for the
// `discordSourceFingerprint` object literal (discord-source-fingerprint.ts:14-27): keys in literal order, undefined
// attachment fields omitted, CDN `ex`/`is`/`hm` removed. The JSON text written beside each vector was produced
// with Python `json.dumps(value, separators=(",", ":"), ensure_ascii=False)`, which matches `JSON.stringify` for these
// inputs, then hashed with `hashlib.sha256(text.encode()).hexdigest()`.

#[test]
fn plain_text_vector() {
    let raw = json!({
        "id": "1002", "channel_id": "2001", "type": 0,
        "author": {"id": "3"}, "content": "hi \"there\"\n\u{2603}"
    });
    let inbound = Inbound::from_raw(&raw).unwrap();
    assert!(inbound.unreferenced_text);
    assert_eq!(inbound.reference, None);
    // {"channel":"2001","message":"1002","reference":null,"text":"hi \"there\"\n☃","attachments":[]}
    assert_eq!(
        inbound.canonical(),
        "{\"channel\":\"2001\",\"message\":\"1002\",\"reference\":null,\"text\":\"hi \\\"there\\\"\\n\u{2603}\",\"attachments\":[]}"
    );
    assert_eq!(
        inbound.fingerprint(),
        "d1207ea0fc3564a746b9ad490dff88771d19f07c9fd583821b5fe8061e3553d4"
    );
    assert_eq!(
        inbound.format(),
        "INBOUND discord 2001 1002 from=owner ref=- \"hi \\\"there\\\"\\n\u{2603}\""
    );
    // JSON.stringify([author.id, bot === true, system === true, webhook_id, type, fingerprint]) with
    // undefined webhook_id serialized as null inside an array.
    assert_eq!(
        raw_fingerprint(&raw).unwrap(),
        "[\"3\",false,false,null,0,\"d1207ea0fc3564a746b9ad490dff88771d19f07c9fd583821b5fe8061e3553d4\"]"
    );
}

#[test]
fn voice_reply_vector_strips_cdn_authorization() {
    let raw = json!({
        "id": "1003", "channel_id": "2001", "type": 19, "flags": 8192,
        "author": {"id": "3"}, "content": "",
        "message_reference": {"message_id": "1001", "channel_id": "2001"},
        "attachments": [{
            "filename": "voice-message.ogg", "content_type": "audio/ogg", "size": 4096,
            "url": "https://cdn.discordapp.com/attachments/2001/7/voice-message.ogg?ex=65f&is=65e&hm=abc&keep=a+b",
            "duration_secs": 3.5
        }]
    });
    let inbound = Inbound::from_raw(&raw).unwrap();
    assert!(!inbound.unreferenced_text);
    let reply = inbound.reply_to.as_ref().unwrap();
    assert_eq!(reply.status, Some(ReplyStatus::Unresolved));
    // {"channel":"2001","message":"1003","reference":"1001","text":"","attachments":[{"filename":"voice-message.ogg",
    //  "size":4096,"url":"https://cdn.discordapp.com/attachments/2001/7/voice-message.ogg?keep=a+b",
    //  "content_type":"audio/ogg","voice":true,"duration_secs":3.5}]}
    assert_eq!(
        inbound.fingerprint(),
        "1ee574795c004b97dd850c1e81c1b6600becd716f0ff5a2473f47695f38b8b74"
    );
    assert_eq!(
        inbound.format(),
        concat!(
            "INBOUND discord 2001 1003 from=owner ref=1001 \"\"\n",
            "INBOUND_REPLY discord 2001 1003 {\"id\":\"1001\",\"author\":null,\"text\":null,\"status\":\"unresolved\"}\n",
            "INBOUND_ATTACHMENT discord 2001 1003 {\"filename\":\"voice-message.ogg\",\"content_type\":\"audio/ogg\",",
            "\"size\":4096,\"url\":\"https://cdn.discordapp.com/attachments/2001/7/voice-message.ogg?ex=65f&is=65e&hm=abc&keep=a+b\",",
            "\"voice\":true,\"duration_secs\":3.5}"
        )
    );
}

#[test]
fn media_host_vector_with_snapshot_and_integer_duration() {
    let raw = json!({
        "id": "1004", "channel_id": "2001", "type": 19,
        "author": {"id": "3"}, "content": "see",
        "message_reference": {"message_id": "1000", "channel_id": "2001", "type": 0},
        "referenced_message": {"id": "1000", "channel_id": "2001", "author": {"id": "9"}, "content": "orig"},
        "attachments": [{"filename": "a.png", "size": 12, "url": "https://media.discordapp.net/attachments/1/2/a.png", "duration_secs": 2}]
    });
    let inbound = Inbound::from_raw(&raw).unwrap();
    // {"channel":"2001","message":"1004","reference":"1000","text":"see","attachments":[{"filename":"a.png",
    //  "size":12,"url":"https://media.discordapp.net/attachments/1/2/a.png","duration_secs":2}]}
    assert_eq!(
        inbound.fingerprint(),
        "4210657657a9b9ad1239e59c1ea544244f740660f57aabb6ff6d2e7f40589634"
    );
    assert!(inbound.format().contains(
        "\nINBOUND_REPLY discord 2001 1004 {\"id\":\"1000\",\"author\":\"9\",\"text\":\"orig\"}\n"
    ));
}

#[test]
fn reply_validation_matches_to_inbound() {
    let base = |reference: serde_json::Value, snapshot: Option<serde_json::Value>| {
        let mut raw = json!({"id": "5", "channel_id": "2", "type": 19, "author": {"id": "3"}, "content": "x",
            "message_reference": reference});
        if let Some(snapshot) = snapshot {
            raw["referenced_message"] = snapshot;
        }
        Inbound::from_raw(&raw)
    };
    assert!(base(json!({"message_id": "4", "channel_id": "7"}), None).is_err());
    assert!(base(json!({"message_id": "4"}), Some(json!({"id": "6"}))).is_err());
    assert!(
        base(
            json!({"message_id": "4"}),
            Some(json!({"id": "4", "channel_id": "8"}))
        )
        .is_err()
    );
    assert!(base(json!({"message_id": "04"}), None).is_err());
    let gone = base(json!({"message_id": "4"}), Some(serde_json::Value::Null)).unwrap();
    assert_eq!(
        gone.reply_to.unwrap().status,
        Some(ReplyStatus::Unavailable)
    );
    // A forward (type 1) names a message but answers nothing.
    let forward = base(
        json!({"type": 1, "message_id": "4", "channel_id": "9"}),
        None,
    )
    .unwrap();
    assert_eq!(forward.reference, None);
    assert!(forward.reply_to.is_none());
    assert!(!forward.unreferenced_text);
}

#[test]
fn attachment_and_content_validation() {
    let with = |attachments: serde_json::Value| {
        Inbound::from_raw(
            &json!({"id": "5", "channel_id": "2", "type": 0, "content": "x", "attachments": attachments}),
        )
    };
    assert!(with(json!({})).is_err());
    assert!(with(json!([null])).is_err());
    assert!(with(json!([{"filename": "a", "url": "u", "size": 1.5}])).is_err());
    assert!(
        with(json!([{"filename": "a", "url": "u", "size": 9_007_199_254_740_992_u64}])).is_err()
    );
    let empty = with(json!([])).unwrap();
    assert!(empty.unreferenced_text);
    assert!(Inbound::from_raw(&json!({"id": "5", "channel_id": "2", "type": 0})).is_err());
}

#[test]
fn stable_url_only_touches_discord_cdn_hosts() {
    assert_eq!(
        stable_url("https://example.com/a?ex=1"),
        "https://example.com/a?ex=1"
    );
    assert_eq!(stable_url("not a url"), "not a url");
    assert_eq!(
        stable_url("https://cdn.discordapp.com/a/b.png?ex=1&is=2&hm=3"),
        "https://cdn.discordapp.com/a/b.png"
    );
    assert_eq!(
        stable_url("https://cdn.discordapp.com/a/b.png?size=%41&x=a%20b"),
        "https://cdn.discordapp.com/a/b.png?size=A&x=a+b"
    );
}

#[test]
fn source_json_matches_discord_inbound_shape() {
    let raw = json!({"id": "1002", "channel_id": "2001", "type": 0, "content": "hi"});
    assert_eq!(
        Inbound::from_raw(&raw).unwrap().source_json(),
        "{\"channel\":\"2001\",\"message\":\"1002\",\"reference\":null,\"text\":\"hi\",\"replyTo\":null,\"attachments\":[],\"unreferencedText\":true}"
    );
}

#[test]
fn attachment_refs_hide_urls_and_hold_missing_or_duplicate_ids() {
    let mut raw = json!({"id":"1002", "channel_id":"2001", "content":"file", "type":0,
        "author":{"id":"3"}, "attachments":[{"id":"7", "filename":"file.pdf", "size":1,
        "url":"https://cdn.discordapp.com/attachments/2001/7/file.pdf?hm=secret"}]});
    let bot = Snowflake::try_from("99".to_owned()).unwrap();
    let owner = Snowflake::try_from("3".to_owned()).unwrap();
    let inbound = Inbound::from_raw(&raw).unwrap();
    let text = inbound.format_refs(bot, owner).unwrap();
    assert!(text.contains("discord-file:99:3:2001:1002:7"));
    assert!(!text.contains("secret"));
    assert!(!text.contains("\"url\""));
    assert!(inbound.format().contains("secret"));
    raw["attachments"][0].as_object_mut().unwrap().remove("id");
    assert!(
        Inbound::from_raw(&raw)
            .unwrap()
            .format_refs(bot, owner)
            .is_err()
    );
    raw["attachments"][0]["id"] = json!("7");
    let duplicate = raw["attachments"][0].clone();
    raw["attachments"].as_array_mut().unwrap().push(duplicate);
    assert!(
        Inbound::from_raw(&raw)
            .unwrap()
            .format_refs(bot, owner)
            .is_err()
    );
}
