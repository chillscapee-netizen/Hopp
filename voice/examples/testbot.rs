//! Hoppbot: a real Hopp account to test friends, direct messages and invites with.
//!
//!     cargo run -p strom-voice --example testbot -- [--add <username>] [--cloud wss://…]
//!
//! It keeps its Hopp ID in `strom-data/testbot.json`, picks the username
//! "hoppbot" (or a free variant), accepts every friend request, answers direct
//! messages, and joins any server you send it an invite link for, where it says
//! hello and answers messages that mention "bot".

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};
use strom_shared::{ChannelKind, ClientMsg, ServerMsg};
use strom_voice::{AccountLink, Identity, StoredIdentity};

const DEFAULT_CLOUD: &str = "wss://strom-cloud.strom-chat.workers.dev";
const PASSWORD: &str = "hoppbot-test-password";
const STORE: &str = "strom-data/testbot.json";

fn load_identity() -> anyhow::Result<Identity> {
    if let Ok(text) = std::fs::read_to_string(STORE) {
        let stored: StoredIdentity = serde_json::from_str(&text)?;
        return Identity::unlock(&stored, PASSWORD);
    }
    let (identity, stored) = Identity::create("Hoppbot", PASSWORD)?;
    std::fs::create_dir_all(Path::new(STORE).parent().unwrap())?;
    std::fs::write(STORE, serde_json::to_vec_pretty(&stored)?)?;
    Ok(identity)
}

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

/// The code in a hopp://CODE (or strom://CODE) invite link, if the text has one.
fn invite_code(text: &str) -> Option<String> {
    text.split_whitespace().find_map(|word| {
        let rest = word.strip_prefix("hopp://").or_else(|| word.strip_prefix("strom://"))?;
        let code = rest.trim_end_matches('/');
        (code.len() >= 6 && code.len() <= 16 && code.chars().all(|c| c.is_ascii_alphanumeric())).then(|| code.to_uppercase())
    })
}

fn dm(link: &AccountLink, me: &Identity, to: &str, text: &str) {
    match me.seal_for(to, text.as_bytes()) {
        Ok(sealed) => link.send(json!({ "type": "dm_send", "to": to, "sealed": sealed })),
        Err(e) => eprintln!("couldn't seal a message: {e}"),
    }
}

/// Joins a server through its invite, says hello, and answers messages that mention it.
async fn join_server(cloud: String, me: Identity, code: String, link: AccountLink, friend: String) {
    let http = cloud.replacen("wss://", "https://", 1).replacen("ws://", "http://", 1);
    let preview: Value = match reqwest::get(format!("{http}/invite/{code}")).await {
        Ok(r) => r.json().await.unwrap_or(Value::Null),
        Err(e) => {
            dm(&link, &me, &friend, &format!("I couldn't look that invite up: {e}"));
            return;
        }
    };
    let Some(server_id) = preview["server_id"].as_str() else {
        dm(&link, &me, &friend, "That invite didn't work for me. Is it still valid?");
        return;
    };
    let name = preview["name"].as_str().unwrap_or("your server").to_string();
    let url = format!("{cloud}/servers/{server_id}/ws");
    let mut session = match strom_voice::connect(&url, &me, Some(&code), None).await {
        Ok(s) => s,
        Err(e) => {
            dm(&link, &me, &friend, &format!("I couldn't join {name}: {e}"));
            return;
        }
    };
    println!("joined {name}");
    dm(&link, &me, &friend, &format!("I'm in {name}! Say \"bot\" in a channel and I'll answer."));
    let general = session.roster.channels.iter().find(|c| c.kind == ChannelKind::Text).map(|c| c.id);
    if let Some(channel) = general {
        session.control.send(ClientMsg::SendChat { channel, text: "👋 Hi! I'm Hoppbot, a test account. Mention \"bot\" and I'll answer.".into() });
    }
    let my_session = session.roster.me;
    while let Some(msg) = session.events.recv().await {
        if let ServerMsg::Chat { message } = msg {
            if message.sender != my_session && message.text.to_lowercase().contains("bot") {
                let reply = format!("🐰 Hopp hopp, {}! I heard you.", message.sender_name);
                session.control.send(ClientMsg::SendChat { channel: message.channel, text: reply });
            }
        }
    }
    println!("left {name}");
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cloud = arg("--cloud").unwrap_or_else(|| DEFAULT_CLOUD.to_string());
    let mut add = arg("--add");
    let me = load_identity()?;
    println!("Hoppbot's Hopp ID: {}", me.public_key());

    loop {
        let (link, welcome, mut events) = match strom_voice::connect_account(&cloud, &me).await {
            Ok(c) => c,
            Err(e) => {
                eprintln!("couldn't connect: {e:#}; trying again");
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };
        let mut username = welcome["me"]["username"].as_str().map(String::from);
        if username.is_none() {
            link.send(json!({ "type": "claim_username", "name": "hoppbot" }));
        } else {
            println!("logged in as @{}", username.as_deref().unwrap());
        }
        link.send(json!({ "type": "set_activity", "activity": "Testing Hopp" }));
        for f in welcome["friends"].as_array().into_iter().flatten() {
            if f["state"] == "incoming" {
                link.send(json!({ "type": "friend_accept", "key": f["key"] }));
            }
        }
        let mut tried = 0;

        while let Some(msg) = events.recv().await {
            match msg["type"].as_str().unwrap_or_default() {
                "profile" => {
                    if let Some(name) = msg["me"]["username"].as_str() {
                        if username.as_deref() != Some(name) {
                            println!("logged in as @{name}");
                            username = Some(name.to_string());
                        }
                        if let Some(who) = add.take() {
                            link.send(json!({ "type": "friend_request", "username": who }));
                        }
                    }
                }
                "error" => {
                    let text = msg["message"].as_str().unwrap_or_default();
                    eprintln!("cloud says: {text}");
                    // The name is taken: try a free variant.
                    if msg["for"] == "claim_username" && tried < 5 {
                        tried += 1;
                        link.send(json!({ "type": "claim_username", "name": format!("hoppbot{}", rand::random::<u16>() % 1000) }));
                    }
                }
                "friend" => {
                    let f = &msg["friend"];
                    let key = f["key"].as_str().unwrap_or_default().to_string();
                    match f["state"].as_str() {
                        Some("incoming") => {
                            println!("friend request from @{}", f["username"].as_str().unwrap_or("?"));
                            link.send(json!({ "type": "friend_accept", "key": key }));
                        }
                        Some("friend") => {
                            println!("now friends with @{}", f["username"].as_str().unwrap_or("?"));
                            dm(&link, &me, &key, "Hi! I'm Hoppbot 🐰 Write me anything, or send me an invite link and I'll join your server.");
                        }
                        _ => {}
                    }
                }
                "dm" => {
                    let message = &msg["message"];
                    let from = message["from_key"].as_str().unwrap_or_default().to_string();
                    if from == me.public_key() {
                        continue;
                    }
                    let text = me
                        .open_from(&from, message["sealed"].as_str().unwrap_or_default())
                        .ok()
                        .and_then(|b| String::from_utf8(b).ok())
                        .unwrap_or_default();
                    println!("message: {text}");
                    if let Some(code) = invite_code(&text) {
                        dm(&link, &me, &from, "On my way…");
                        tokio::spawn(join_server(cloud.clone(), me.clone(), code, link.clone(), from.clone()));
                    } else {
                        dm(&link, &me, &from, &format!("You said: \"{text}\". Send me an invite link (hopp://…) and I'll join your server."));
                    }
                }
                _ => {}
            }
        }
        eprintln!("disconnected; reconnecting");
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}
