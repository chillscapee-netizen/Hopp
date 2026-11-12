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
//!
//! Pretend it's far away: "net italy" in a DM (or "bot net italy" in a server) makes its voice
//! travel as if it were in Italy: the delay, the unevenness and the occasional lost packet of
//! a real connection there. Also "net us", "net asia", "net wifi", "net mobile", "net nordic",
//! your own "net <round trip ms> <jitter ms> <loss %>", and "net off". `--net italy` starts
//! it that way.

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
const HELP: &str = "Mention \"bot\" with: voice (I join your voice channel and repeat you), net italy / us / asia / wifi / mobile / off (I pretend to be far away), chime, leave, link, spam, help.";

// ---------- pretending to be far away ----------

/// How the road between you and the bot behaves: the round trip it adds, how unevenly
/// packets arrive, and how many never do. Applied both ways, half the delay each way.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Road {
    rtt_ms: u32,
    jitter_ms: u32,
    loss_pct: f32,
}

static ROAD: std::sync::Mutex<Road> = std::sync::Mutex::new(Road { rtt_ms: 0, jitter_ms: 0, loss_pct: 0.0 });

fn road() -> Road {
    *ROAD.lock().unwrap()
}

/// Typical connections from Sweden, home to home (fibre or cable, both ends), plus the bad
/// days: what people really have, so voice can be tried as they'd hear it.
fn road_preset(name: &str) -> Option<(Road, &'static str)> {
    let r = |rtt_ms, jitter_ms, loss_pct| Road { rtt_ms, jitter_ms, loss_pct };
    Some(match name {
        "off" | "none" | "home" => (r(0, 0, 0.0), "Right next to you: no added delay."),
        "nordic" | "norway" | "finland" | "denmark" => (r(25, 4, 0.2), "The Nordics: about 25 ms round trip."),
        "germany" | "europe" | "uk" | "france" => (r(45, 8, 0.5), "Central Europe: about 45 ms round trip."),
        "italy" | "spain" => (r(90, 15, 1.0), "Italy: about 90 ms round trip, a little uneven, 1% lost."),
        "us" | "usa" | "america" => (r(130, 15, 1.0), "The US east coast: about 130 ms round trip."),
        "west" | "california" => (r(180, 20, 1.0), "The US west coast: about 180 ms round trip."),
        "asia" | "japan" | "australia" => (r(260, 25, 2.0), "Asia or Australia: about 260 ms round trip."),
        "wifi" => (r(15, 40, 3.0), "Weak wifi: little delay, but very uneven and 3% lost."),
        "mobile" | "4g" => (r(70, 40, 5.0), "Mobile data: 70 ms, uneven, 5% lost."),
        _ => return None,
    })
}

/// "net italy", "net 120 20 3", "net off": sets the road and says how it is now.
fn set_road(command: &str) -> String {
    let words: Vec<&str> = command.split_whitespace().skip_while(|w| *w != "net").skip(1).collect();
    let numbers: Vec<f32> = words.iter().filter_map(|w| w.trim_end_matches(['%', 'm', 's']).parse().ok()).collect();
    let (road, said) = if let Some(found) = words.first().and_then(|w| road_preset(w)) {
        (found.0, found.1.to_string())
    } else if !numbers.is_empty() {
        let road = Road {
            rtt_ms: numbers[0].clamp(0.0, 1000.0) as u32,
            jitter_ms: numbers.get(1).copied().unwrap_or(0.0).clamp(0.0, 300.0) as u32,
            loss_pct: numbers.get(2).copied().unwrap_or(0.0).clamp(0.0, 50.0),
        };
        (road, format!("{} ms round trip, {} ms uneven, {}% lost.", road.rtt_ms, road.jitter_ms, road.loss_pct))
    } else {
        return "Say where I should be: net italy, net us, net asia, net wifi, net mobile, net nordic, net off, or your own \"net <round trip ms> <jitter ms> <loss %>\".".into();
    };
    *ROAD.lock().unwrap() = road;
    println!("road: {road:?}");
    format!("🌍 {said} Look at the number in your voice panel, and listen.")
}

/// When a packet sent now arrives at the other end, or never (lost). Half the round trip,
/// plus up to the jitter more at random (so packets also arrive out of order, as they do).
fn arrival(road: Road, now: Instant) -> Option<Instant> {
    if road.loss_pct > 0.0 && rand::random::<f32>() * 100.0 < road.loss_pct {
        return None;
    }
    let jitter = if road.jitter_ms > 0 { rand::random::<u32>() % (road.jitter_ms + 1) } else { 0 };
    Some(now + Duration::from_millis((road.rtt_ms / 2 + jitter) as u64))
}

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

/// The code in an invite link (hopp://CODE, strom://CODE or https://…/i/CODE), if the text has one.
fn invite_code(text: &str) -> Option<String> {
    text.split_whitespace().find_map(|word| {
        // hopp://CODE, or the web link https://…/i/CODE.
        let rest = word.strip_prefix("hopp://").or_else(|| word.strip_prefix("strom://")).or_else(|| word.split_once("/i/").map(|(_, code)| code))?;
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
    // Packets on the road (when "net" pretends we're far away): out to you, and in from you.
    let mut outbound: VecDeque<(Instant, SocketAddr, Vec<u8>)> = VecDeque::new();
    let mut inbound: VecDeque<(Instant, SocketAddr, Vec<u8>)> = VecDeque::new();
    let on_road = |queue: &mut VecDeque<(Instant, SocketAddr, Vec<u8>)>, at: Instant, addr: SocketAddr, bytes: Vec<u8>| {
        let pos = queue.partition_point(|(t, _, _)| *t <= at);
        queue.insert(pos, (at, addr, bytes));
    };
    let send = |outbound: &mut VecDeque<(Instant, SocketAddr, Vec<u8>)>, addr: SocketAddr, bytes: &[u8]| {
        let road = road();
        if road == (Road { rtt_ms: 0, jitter_ms: 0, loss_pct: 0.0 }) {
            let _ = socket.send_to(bytes, mesh::wire(addr, dual));
        } else if let Some(at) = arrival(road, Instant::now()) {
            on_road(outbound, at, addr, bytes.to_vec());
        }
    };
    while !stop.load(Ordering::Relaxed) {
        // What arrived over the road: in by the time it's due (now, when nothing is pretended).
        while let Ok((len, from)) = socket.recv_from(&mut buf) {
            let road = road();
            match arrival(road, Instant::now()) {
                Some(at) => on_road(&mut inbound, at, from, buf[..len].to_vec()),
                None => continue,
            }
        }
        let now = Instant::now();
        let mut arrived = Vec::new();
        while inbound.front().is_some_and(|(at, _, _)| *at <= now) {
            let (_, from, bytes) = inbound.pop_front().unwrap();
            arrived.push((from, bytes));
        }
        // What came in: pings to answer, voice to say back later.
        for (from, bytes) in arrived {
            let Some((kind, sender, payload)) = mesh::open(&mesh.cipher, &bytes) else { continue };
            if !mesh.heard(sender, from, false) {
                continue;
            }
            match kind {
                mesh::KIND_PING if payload.len() >= 4 => {
                    mesh.ping_heard(sender, &payload);
                    sealer.seal(mesh::KIND_PONG, &payload[..4], &mut packet);
                    send(&mut outbound, mesh::canonical(from), &packet);
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
                    send(&mut outbound, addr, &packet);
                }
            }
        }
        let now = Instant::now();
        while queue.front().is_some_and(|(at, _)| *at <= now) {
            let (_, opus) = queue.pop_front().unwrap();
            let mut plain = seq.to_be_bytes().to_vec();
            plain.extend_from_slice(&opus);
            sealer.seal(mesh::KIND_VOICE, &plain, &mut packet);
            for (addr, relayed, _) in mesh.paths() {
                if !relayed {
                    send(&mut outbound, addr, &packet);
                }
            }
            seq = seq.wrapping_add(1);
        }
        // What's done travelling goes out.
        while outbound.front().is_some_and(|(at, _, _)| *at <= now) {
            let (_, addr, bytes) = outbound.pop_front().unwrap();
            let _ = socket.send_to(&bytes, mesh::wire(addr, dual));
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
                } else if text.split_whitespace().any(|w| w == "net") {
                    say(&session.control, ch, &set_road(&text));
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
    if let Some(place) = arg("--net") {
        println!("{}", set_road(&format!("net {place}")));
    }
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
        let mut greeted: std::collections::HashSet<String> = std::collections::HashSet::new();
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
                        // Only a new friendship gets a hello: a friend changing their name or
                        // picture sends the same message, and must not.
                        Some("friend") if greeted.insert(key.clone()) && msg["request"].is_null() && f["since"].as_u64().is_some_and(|t| t + 60_000 > now_ms()) => {
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
                    // The same person ringing again lost the old call (their app closed without
                    // saying so): that one is over.
                    if kind == "ring" && call.as_ref().is_some_and(|c| c.group.is_none() && c.in_call.contains(&from)) {
                        println!("{} rang again: the old call is over", &from[..8]);
                        call = None;
                    }
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
                    if lower.split_whitespace().any(|w| w == "net") {
                        dm(&link, &me, &from, &set_road(&lower));
                    } else if let Some(code) = invite_code(&text) {
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
                        dm(&link, &me, &from, &format!("You said: \"{text}\". Call me to hear yourself, write \"call me\" and I'll ring you, send an invite link (hopp://…) and I'll join your server, or write \"net italy\" (or us, asia, wifi, mobile, off) and I'll sound as if I were there."));
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
    fn invite_links_are_understood_in_every_form() {
        for text in ["hopp://CGAQPK9Q", "join us: https://hopp-cloud.hoppchat.workers.dev/i/CGAQPK9Q", "strom://cgaqpk9q/"] {
            assert_eq!(invite_code(text).as_deref(), Some("CGAQPK9Q"), "{text}");
        }
        assert_eq!(invite_code("https://example.com/page"), None);
    }

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

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}
