//! Hoppbot: a real Hopp account to test friends, messages, servers, voice and calls with.
//!
//!     cargo run -p strom-voice --example testbot -- [--add <username>] [--cloud wss://…]
//!
//! It keeps its Hopp ID in `strom-data/testbot.json`, picks the username "hoppbot" (or a free
//! variant), accepts every friend request and answers direct messages. Send it an invite link
//! and it joins your server. There, mention "bot":
//!
//! - "bot voice": it joins your voice channel, plays a chime, and repeats what you say a
//!   second later, so you hear yourself through Hopp.
//! - "bot chime", "bot leave", "bot link" (a link to preview), "bot spam" (60 messages, for
//!   long channels), "bot help".
//!
//! Call it, or call a group it's in, and it answers and echoes you the same way. Write
//! "call me" in a DM and it rings you.

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use strom_shared::{ChannelKind, ClientMsg, PeerEndpoint, ServerMsg, SessionId, FRAME_SAMPLES, SAMPLE_RATE};
use strom_voice::mesh::{self, Mesh, Sealer};
use strom_voice::{AccountLink, Identity, StoredIdentity};

const DEFAULT_CLOUD: &str = "wss://hopp-cloud.hoppchat.workers.dev";
const PASSWORD: &str = "hoppbot-test-password";
const STORE: &str = "strom-data/testbot.json";
/// How long after you speak the bot says it back.
const ECHO_DELAY: Duration = Duration::from_millis(1000);
const HELP: &str = "Mention \"bot\" with: voice (I join your voice channel and repeat you), chime, leave, link, spam, help.";

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

fn key_from_hex(hex: &str) -> Option<[u8; 32]> {
    let hex = hex.trim();
    if hex.len() != 64 {
        return None;
    }
    let mut key = [0u8; 32];
    for (i, b) in key.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(key)
}

/// Someone's number in a group call, the same way the app works it out.
fn call_session(key: &str) -> SessionId {
    key.get(..8).and_then(|h| u32::from_str_radix(h, 16).ok()).filter(|&n| n != 0).unwrap_or(1)
}

fn dm(link: &AccountLink, me: &Identity, to: &str, text: &str) {
    match me.seal_for(to, text.as_bytes()) {
        Ok(sealed) => link.send(json!({ "type": "dm_send", "to": to, "sealed": sealed })),
        Err(e) => eprintln!("couldn't seal a message: {e}"),
    }
}

/// Writes in a group conversation: a sealed copy for each member.
fn group_say(link: &AccountLink, me: &Identity, group: &str, members: &[String], text: &str) {
    let mut sealed = serde_json::Map::new();
    for k in members {
        if let Ok(s) = me.seal_for(k, text.as_bytes()) {
            sealed.insert(k.clone(), Value::String(s));
        }
    }
    link.send(json!({ "type": "group_send", "group": group, "sealed": sealed, "nonce": "bot" }));
}

// ---------- voice without a microphone ----------

/// A two-note chime, as Opus frames: what the bot "says" when it arrives.
fn chime() -> Vec<Vec<u8>> {
    let Ok(mut enc) = opus::Encoder::new(SAMPLE_RATE, opus::Channels::Mono, opus::Application::Audio) else { return vec![] };
    let mut frames = Vec::new();
    let mut out = [0u8; 1275];
    let total = SAMPLE_RATE as usize * 9 / 10;
    let mut pcm = vec![0f32; FRAME_SAMPLES];
    for start in (0..total).step_by(FRAME_SAMPLES) {
        for (i, s) in pcm.iter_mut().enumerate() {
            let n = start + i;
            let t = n as f32 / SAMPLE_RATE as f32;
            // Two notes, each fading out.
            let (freq, since) = if t < 0.35 { (880.0, t) } else { (659.25, t - 0.35) };
            let fade = (-since * 6.0).exp();
            *s = (t * freq * std::f32::consts::TAU).sin() * 0.25 * fade;
        }
        if let Ok(len) = enc.encode_float(&pcm, &mut out) {
            frames.push(out[..len].to_vec());
        }
    }
    frames
}

/// A voice participant without a microphone: it plays a chime and repeats what it hears a
/// second later, sealed and sent straight to the others like any Hopp app would.
struct Echo {
    mesh: Arc<Mesh>,
    endpoint: PeerEndpoint,
    play: mpsc::Sender<Vec<Vec<u8>>>,
    stop: Arc<AtomicBool>,
}

impl Echo {
    fn start(me: SessionId, key: [u8; 32]) -> anyhow::Result<Echo> {
        let socket = mesh::dual_stack_socket()?;
        let port = socket.local_addr()?.port();
        let dual = mesh::is_dual(&socket);
        let public = mesh::public_address(&socket);
        let mut local: Vec<String> = mesh::local_ip().map(|ip| SocketAddr::new(ip, port).to_string()).into_iter().collect();
        if dual {
            if let Some(v6) = mesh::global_ipv6() {
                local.push(SocketAddr::new(v6.into(), port).to_string());
            }
        }
        let endpoint = PeerEndpoint { session_id: me, public: public.map(|a| a.to_string()), local };
        let mesh = Arc::new(Mesh::new(me, &key));
        socket.set_read_timeout(Some(Duration::from_millis(5)))?;
        let stop = Arc::new(AtomicBool::new(false));
        let (play, plays) = mpsc::channel::<Vec<Vec<u8>>>();
        let (m, s) = (mesh.clone(), stop.clone());
        std::thread::spawn(move || run_echo(socket, dual, m, me, key, plays, s));
        let echo = Echo { mesh, endpoint, play, stop };
        echo.chime();
        Ok(echo)
    }

    fn chime(&self) {
        let _ = self.play.send(chime());
    }

    fn set_peer(&self, peer: &PeerEndpoint) {
        self.mesh.set_peer(peer);
    }

    fn drop_peer(&self, id: SessionId) {
        self.mesh.retain_peers(|p| p != id);
    }
}

impl Drop for Echo {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Puts a frame in line by when it's due.
fn schedule(queue: &mut VecDeque<(Instant, Vec<u8>)>, at: Instant, frame: Vec<u8>) {
    let pos = queue.partition_point(|(t, _)| *t <= at);
    queue.insert(pos, (at, frame));
}

fn run_echo(socket: std::net::UdpSocket, dual: bool, mesh: Arc<Mesh>, me: SessionId, key: [u8; 32], plays: mpsc::Receiver<Vec<Vec<u8>>>, stop: Arc<AtomicBool>) {
    let mut sealer = Sealer::new(&key, me);
    let epoch = Instant::now();
    let mut seq = 0u32;
    let mut packet = Vec::with_capacity(1500);
    let mut buf = [0u8; 1500];
    // Frames to say, and when.
    let mut queue: VecDeque<(Instant, Vec<u8>)> = VecDeque::new();
    let mut chimes: Vec<Vec<Vec<u8>>> = Vec::new();
    let send_voice = |sealer: &mut Sealer, packet: &mut Vec<u8>, seq: &mut u32, opus: &[u8]| {
        let mut plain = seq.to_be_bytes().to_vec();
        plain.extend_from_slice(opus);
        sealer.seal(mesh::KIND_VOICE, &plain, packet);
        for (addr, relayed, _) in mesh.paths() {
            if !relayed {
                let _ = socket.send_to(packet, mesh::wire(addr, dual));
            }
        }
        *seq = seq.wrapping_add(1);
    };
    while !stop.load(Ordering::Relaxed) {
        // What came in: pings to answer, voice to say back later.
        while let Ok((len, from)) = socket.recv_from(&mut buf) {
            let Some((kind, sender, payload)) = mesh::open(&mesh.cipher, &buf[..len]) else { continue };
            if !mesh.heard(sender, from, false) {
                continue;
            }
            match kind {
                mesh::KIND_PING if payload.len() >= 4 => {
                    mesh.ping_heard(sender, &payload);
                    sealer.seal(mesh::KIND_PONG, &payload[..4], &mut packet);
                    let _ = socket.send_to(&packet, mesh::wire(mesh::canonical(from), dual));
                }
                mesh::KIND_VOICE if payload.len() > 4 => {
                    mesh.heard_voice(sender, u32::from_be_bytes(payload[..4].try_into().unwrap()));
                    schedule(&mut queue, Instant::now() + ECHO_DELAY, payload[4..].to_vec());
                }
                mesh::KIND_VOICE_RED if payload.len() > 5 => {
                    // Earlier frames repeated in front; the frame itself is last.
                    let mut at = 5;
                    for _ in 0..payload[4] {
                        let Some(len) = payload.get(at + 1..at + 3) else { break };
                        at += 3 + u16::from_be_bytes([len[0], len[1]]) as usize;
                    }
                    if let Some(opus) = payload.get(at..).filter(|o| !o.is_empty()) {
                        mesh.heard_voice(sender, u32::from_be_bytes(payload[..4].try_into().unwrap()));
                        schedule(&mut queue, Instant::now() + ECHO_DELAY, opus.to_vec());
                    }
                }
                _ => {}
            }
        }
        // A chime asked for: played once someone can hear it, 10 ms a frame.
        while let Ok(frames) = plays.try_recv() {
            chimes.push(frames);
        }
        if !chimes.is_empty() && !mesh.paths().is_empty() {
            let now = Instant::now();
            for (i, f) in chimes.drain(..).flatten().enumerate() {
                schedule(&mut queue, now + Duration::from_millis(10 * i as u64), f);
            }
        }
        // Keep the paths open, and say what's due.
        let due = mesh.due_pings();
        if !due.is_empty() {
            let nonce = epoch.elapsed().as_millis() as u32;
            sealer.seal(mesh::KIND_PING, &mesh.ping_payload(nonce), &mut packet);
            for (addr, relayed) in due {
                if !relayed {
                    let _ = socket.send_to(&packet, mesh::wire(addr, dual));
                }
            }
        }
        let now = Instant::now();
        while queue.front().is_some_and(|(at, _)| *at <= now) {
            let (_, opus) = queue.pop_front().unwrap();
            send_voice(&mut sealer, &mut packet, &mut seq, &opus);
        }
    }
}

// ---------- servers ----------

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
    dm(&link, &me, &friend, &format!("I'm in {name}! {HELP}"));
    let general = session.roster.channels.iter().find(|c| c.kind == ChannelKind::Text).map(|c| c.id);
    if let Some(channel) = general {
        session.control.send(ClientMsg::SendChat { channel, text: format!("👋 Hi! I'm Hoppbot, a test account. {HELP}"), reply_to: None });
    }
    let my_session = session.roster.me;
    let mut echo: Option<Echo> = None;
    let say = |control: &strom_voice::Control, channel, text: &str| control.send(ClientMsg::SendChat { channel, text: text.into(), reply_to: None });
    while let Some(msg) = session.events.recv().await {
        session.roster.apply(&msg);
        match msg {
            ServerMsg::VoiceSession { key, peers, .. } => {
                echo = None;
                let Some(key) = key_from_hex(&key) else { continue };
                match Echo::start(my_session, key) {
                    Ok(e) => {
                        session.control.send(ClientMsg::VoiceEndpoint { public: e.endpoint.public.clone(), local: e.endpoint.local.clone() });
                        for p in &peers {
                            e.set_peer(p);
                        }
                        println!("in voice in {name}");
                        echo = Some(e);
                    }
                    Err(e) => eprintln!("couldn't start voice: {e:#}"),
                }
            }
            ServerMsg::VoicePeer { peer } => {
                if let Some(e) = &echo {
                    e.set_peer(&peer);
                }
            }
            ServerMsg::Chat { message } if message.sender != my_session && message.text.to_lowercase().contains("bot") => {
                let text = message.text.to_lowercase();
                let ch = message.channel;
                if text.contains("voice") || text.contains("join") {
                    // The voice channel you're in, or the first one.
                    let yours = session.roster.users.iter().find(|u| u.session_id == message.sender).and_then(|u| u.voice_channel);
                    let target = yours.or_else(|| session.roster.channels.iter().find(|c| c.kind == ChannelKind::Voice).map(|c| c.id));
                    match target {
                        Some(v) => {
                            session.control.send(ClientMsg::JoinVoice { channel: v });
                            say(&session.control, ch, "🎧 Coming! Talk and I'll say it back a second later, so you hear how you sound.");
                        }
                        None => say(&session.control, ch, "There's no voice channel here."),
                    }
                } else if text.contains("leave") {
                    echo = None;
                    session.control.send(ClientMsg::LeaveVoice);
                    say(&session.control, ch, "👋 Left voice.");
                } else if text.contains("chime") || text.contains("play") {
                    match &echo {
                        Some(e) => e.chime(),
                        None => say(&session.control, ch, "I'm not in voice. Say \"bot voice\" first."),
                    }
                } else if text.contains("link") {
                    say(&session.control, ch, "Here's a link to preview: https://github.com/");
                } else if text.contains("spam") {
                    say(&session.control, ch, "📜 Sending 60 numbered messages, one a second (the server's speed limit).");
                    let control = session.control.clone();
                    tokio::spawn(async move {
                        for i in 1..=60 {
                            tokio::time::sleep(Duration::from_millis(1100)).await;
                            control.send(ClientMsg::SendChat { channel: ch, text: format!("Test message {i} of 60"), reply_to: None });
                        }
                    });
                } else {
                    say(&session.control, ch, &format!("🐰 Hopp hopp, {}! {HELP}", message.sender_name));
                }
            }
            _ => {}
        }
    }
    println!("left {name}");
}

// ---------- calls ----------

/// The call we're in: who with, and our voice in it.
struct BotCall {
    id: String,
    group: Option<String>,
    echo: Echo,
    /// Group calls: who's in it.
    in_call: Vec<String>,
}

fn call_send(link: &AccountLink, to: &str, call: &str, group: Option<&str>, kind: &str, extra: Value) {
    let mut msg = json!({ "type": "call", "to": to, "call_id": call, "kind": kind });
    if let Some(g) = group {
        msg["group"] = json!(g);
    }
    if let Value::Object(more) = extra {
        for (k, v) in more {
            msg[k] = v;
        }
    }
    link.send(msg);
}

fn endpoint_json(e: &Echo) -> Value {
    json!({ "public": e.endpoint.public, "local": e.endpoint.local })
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cloud = arg("--cloud").unwrap_or_else(|| DEFAULT_CLOUD.to_string());
    let mut add = arg("--add");
    let me = load_identity()?;
    let my_key = me.public_key();
    println!("Hoppbot's Hopp ID: {my_key}");

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
        // Group conversations we're in, by id: their members.
        let mut groups: HashMap<String, Vec<String>> = welcome["groups"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|g| Some((g["id"].as_str()?.to_string(), g["members"].as_array()?.iter().filter_map(|k| k.as_str().map(String::from)).collect())))
            .collect();
        let mut call: Option<BotCall> = None;
        // A call we rang out: its id, key and who.
        let mut ringing: Option<(String, [u8; 32], String)> = None;

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
                            dm(&link, &me, &key, "Hi! I'm Hoppbot 🐰 Call me and I'll repeat what you say, write \"call me\" and I'll ring you, or send me an invite link and I'll join your server.");
                        }
                        _ => {}
                    }
                }
                "group" => {
                    let g = &msg["group"];
                    if let (Some(id), Some(members)) = (g["id"].as_str(), g["members"].as_array()) {
                        let members: Vec<String> = members.iter().filter_map(|k| k.as_str().map(String::from)).collect();
                        if !groups.contains_key(id) {
                            println!("added to group {id}");
                            group_say(&link, &me, id, &members, "Hi everyone! 🐰 I'm Hoppbot. Call the group and I'll join.");
                        }
                        groups.insert(id.to_string(), members);
                    }
                }
                "call" => {
                    let from = msg["from"].as_str().unwrap_or_default().to_string();
                    let id = msg["call_id"].as_str().unwrap_or_default().to_string();
                    let group = msg["group"].as_str().map(String::from);
                    let kind = msg["kind"].as_str().unwrap_or_default();
                    let peer_endpoint = |session_id| PeerEndpoint {
                        session_id,
                        public: msg["public"].as_str().map(String::from),
                        local: msg["local"].as_array().into_iter().flatten().filter_map(|a| a.as_str().map(String::from)).collect(),
                    };
                    match kind {
                        "ring" if call.is_none() => {
                            let Some(key) = me.open_from(&from, msg["sealed"].as_str().unwrap_or_default()).ok().and_then(|b| String::from_utf8(b).ok()).and_then(|h| key_from_hex(&h)) else { continue };
                            let mine = if group.is_some() { call_session(&my_key) } else { 2 };
                            let Ok(echo) = Echo::start(mine, key) else { continue };
                            println!("answering a call from {}", &from[..8]);
                            match &group {
                                Some(g) => {
                                    // A group call: say we joined, and where we are to whoever's in it.
                                    for k in groups.get(g).into_iter().flatten().filter(|k| **k != my_key) {
                                        call_send(&link, k, &id, Some(g), "join", json!({}));
                                    }
                                    call_send(&link, &from, &id, Some(g), "endpoint", endpoint_json(&echo));
                                }
                                None => {
                                    call_send(&link, &from, &id, None, "answer", json!({}));
                                    call_send(&link, &from, &id, None, "endpoint", endpoint_json(&echo));
                                }
                            }
                            call = Some(BotCall { id, group, echo, in_call: vec![from] });
                        }
                        "ring" => call_send(&link, &from, &id, group.as_deref(), "busy", json!({})),
                        "answer" if ringing.as_ref().is_some_and(|r| r.0 == id) => {
                            // Our ring was answered: we're the first in the call.
                            let (id, key, with) = ringing.take().unwrap();
                            let Ok(echo) = Echo::start(1, key) else { continue };
                            call_send(&link, &with, &id, None, "endpoint", endpoint_json(&echo));
                            call = Some(BotCall { id, group: None, echo, in_call: vec![with] });
                        }
                        "decline" | "busy" | "offline" if ringing.as_ref().is_some_and(|r| r.0 == id) => {
                            ringing = None;
                        }
                        _ => {
                            let Some(c) = call.as_mut().filter(|c| c.id == id) else { continue };
                            match kind {
                                "endpoint" => {
                                    let session = if c.group.is_some() { call_session(&from) } else if c.echo.endpoint.session_id == 1 { 2 } else { 1 };
                                    c.echo.set_peer(&peer_endpoint(session));
                                    if !c.in_call.contains(&from) {
                                        c.in_call.push(from);
                                    }
                                }
                                "join" => {
                                    // Someone joined the group call: tell them where we are.
                                    if !c.in_call.contains(&from) {
                                        c.in_call.push(from.clone());
                                    }
                                    let ep = endpoint_json(&c.echo);
                                    call_send(&link, &from, &id, c.group.as_deref(), "endpoint", ep);
                                }
                                "leave" | "end" => {
                                    c.in_call.retain(|k| *k != from);
                                    c.echo.drop_peer(call_session(&from));
                                    if c.group.is_none() || c.in_call.is_empty() {
                                        println!("call over");
                                        if let Some(g) = c.group.clone() {
                                            for k in groups.get(&g).into_iter().flatten().filter(|k| **k != my_key) {
                                                call_send(&link, k, &id, Some(&g), "leave", json!({}));
                                            }
                                        }
                                        call = None;
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
                "dm" if msg["with"].as_str().is_some_and(|w| w.starts_with("g:")) => {
                    let id = msg["with"].as_str().unwrap_or_default().to_string();
                    let message = &msg["message"];
                    let from = message["from_key"].as_str().unwrap_or_default().to_string();
                    if from == my_key {
                        continue;
                    }
                    let text = me.open_from(&from, message["sealed"].as_str().unwrap_or_default()).ok().and_then(|b| String::from_utf8(b).ok()).unwrap_or_default();
                    println!("group message: {text}");
                    if text.to_lowercase().contains("bot") {
                        if let Some(members) = groups.get(&id) {
                            group_say(&link, &me, &id, members, "🐰 Hopp hopp! Call the group and I'll join.");
                        }
                    }
                }
                "dm" => {
                    let message = &msg["message"];
                    let from = message["from_key"].as_str().unwrap_or_default().to_string();
                    if from == my_key {
                        continue;
                    }
                    let text = me.open_from(&from, message["sealed"].as_str().unwrap_or_default()).ok().and_then(|b| String::from_utf8(b).ok()).unwrap_or_default();
                    println!("message: {text}");
                    let lower = text.to_lowercase();
                    if let Some(code) = invite_code(&text) {
                        dm(&link, &me, &from, "On my way…");
                        tokio::spawn(join_server(cloud.clone(), me.clone(), code, link.clone(), from.clone()));
                    } else if lower.contains("call me") || lower.contains("ring me") {
                        if call.is_some() || ringing.is_some() {
                            dm(&link, &me, &from, "I'm already in a call.");
                            continue;
                        }
                        let key: [u8; 32] = rand::random();
                        let hex: String = key.iter().map(|b| format!("{b:02x}")).collect();
                        let Ok(sealed) = me.seal_for(&from, hex.as_bytes()) else { continue };
                        let id = format!("{:08x}-{:04x}", rand::random::<u32>(), rand::random::<u16>());
                        call_send(&link, &from, &id, None, "ring", json!({ "sealed": sealed }));
                        ringing = Some((id, key, from.clone()));
                    } else {
                        dm(&link, &me, &from, &format!("You said: \"{text}\". Call me to hear yourself, write \"call me\" and I'll ring you, or send an invite link (hopp://…) and I'll join your server."));
                    }
                }
                _ => {}
            }
        }
        eprintln!("disconnected; reconnecting");
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_echo_says_back_what_it_hears_a_second_later() {
        let key = [7u8; 32];
        let echo = Echo::start(10, key).unwrap();
        // Someone in the call, on this computer.
        let them = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
        them.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
        echo.set_peer(&PeerEndpoint { session_id: 20, public: None, local: vec![them.local_addr().unwrap().to_string()] });
        let bot: SocketAddr = format!("127.0.0.1:{}", echo.endpoint.local[0].rsplit(':').next().unwrap()).parse().unwrap();
        let ours = Mesh::new(20, &key);
        let mut sealer = Sealer::new(&key, 20);
        let mut packet = Vec::new();
        let mut plain = 0u32.to_be_bytes().to_vec();
        plain.extend_from_slice(b"hello frame");
        sealer.seal(mesh::KIND_VOICE, &plain, &mut packet);
        let sent = Instant::now();
        them.send_to(&packet, bot).unwrap();
        let mut buf = [0u8; 1500];
        let mut chime = 0;
        while sent.elapsed() < Duration::from_secs(4) {
            let Ok((len, _)) = them.recv_from(&mut buf) else { continue };
            let Some((kind, sender, payload)) = mesh::open(&ours.cipher, &buf[..len]) else { continue };
            assert_eq!(sender, 10);
            if kind != mesh::KIND_VOICE {
                continue;
            }
            if &payload[4..] == b"hello frame" {
                assert!(sent.elapsed() >= Duration::from_millis(900), "too early: {:?}", sent.elapsed());
                assert!(chime > 0, "the chime came first");
                return;
            }
            chime += 1;
        }
        panic!("the echo never came back ({chime} chime frames)");
    }
}
