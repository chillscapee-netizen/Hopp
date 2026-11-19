//! One Hopp server's rules: accounts, invites, bans, roles, channels, threads, chat, pictures and
//! voice, kept in SQLite. This is Hopp Cloud's server (cloud/src/server.ts) carried over line by
//! line, so a server on someone's own computer behaves exactly like one in Hopp Cloud: same
//! messages, same answers, same limits. Both are tested with the same tests.
//!
//! The core doesn't know how people are connected: a connection is opened with a way to send to
//! it, gets each message as text, and is closed. TCP (with TLS), the tunnel through Hopp Cloud
//! and the test server's WebSockets all drive it the same way.

// Rows read straight into tuples, as the cloud reads them into objects.
#![allow(clippy::type_complexity)]

use std::collections::{BTreeMap, HashMap, HashSet};
use std::net::SocketAddr;
use std::time::Instant;

use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use regex::Regex;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::sync::LazyLock;
use strom_shared::{auth_message, ChatMessage, Reaction, Reply, User};
use tokio::sync::mpsc;

pub type ConnId = u64;

/// What goes out to a connection: a message, or the end of it.
pub enum Out {
    Text(String),
    Close,
}

const MEMBER_STATUSES: [&str; 4] = ["online", "idle", "dnd", "offline"];
const PRESENCE_PUSH_LIMIT: usize = 300;
const STATUS_STALE_MS: u64 = 3 * 24 * 3600 * 1000;
const PROTOCOL_VERSION: i64 = 5;
const MAX_NAME_LEN: usize = 32;
const MAX_SERVER_NAME_LEN: usize = 40;
const MAX_ICON_LEN: usize = 200_000;
const MAX_CHAT_LEN: usize = 2000;
/// AutoMod: at most this many blocked words, each this long; the same message this many times
/// within a minute is held back.
const AUTOMOD_WORDS: usize = 200;
const AUTOMOD_WORD_LEN: usize = 40;
const AUTOMOD_REPEATS: usize = 3;
/// Events: upcoming ones a server keeps, how far ahead they may be, and how long one stays after it starts.
const MAX_EVENTS: i64 = 25;
const EVENT_AHEAD_MS: i64 = 60 * 86_400_000;
const EVENT_KEEP_MS: i64 = 12 * 3_600_000;
const MAX_CHANNELS: usize = 50;
const MAX_THREADS: usize = 300;
const MAX_MEMBERS_ONLINE: usize = 500;
const MAX_SCREEN_SIGNAL: usize = 65_536;
const SEARCH_RESULTS: i64 = 25;
const SEARCH_GAP_MS: u64 = 400;
const STALE_SESSION_MS: u64 = 30_000;
const CHAT_HISTORY: i64 = 100;
const CHAT_KEEP: i64 = 1000;
const ANY_BURST: f64 = 60.0;
const ANY_PER_SECOND: f64 = 15.0;
const ACT_BURST: f64 = 10.0;
const ACT_PER_SECOND: f64 = 2.0;
const SIGNAL_BURST: f64 = 300.0;
const SIGNAL_PER_SECOND: f64 = 60.0;
const CHAT_BURST: f64 = 5.0;
const CHAT_PER_SECOND: f64 = 1.0;
const TYPING_INTERVAL_MS: u64 = 2000;
const INVITE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_LOCAL_ENDPOINTS: usize = 4;
const MAX_REACTIONS: usize = 20;
/// Voice between the members (mesh): each sends to every other, so channels stay small.
const MAX_VOICE_PEERS: usize = 10;
/// Voice through the server's own relay: the server sends, so channels can be bigger.
const MAX_RELAY_LIMIT: i64 = 99;
const REPLY_PREVIEW_LEN: usize = 120;
const OLDER_PAGE: i64 = 50;
const EMOJI_NAME_MAX: usize = 32;
const MAX_EMOJIS: i64 = 100;
const MAX_ROLES: usize = 50;
const MAX_CATEGORY_LEN: usize = 24;
const MAX_TOPIC_LEN: usize = 200;
/// The biggest message anyone sends (a server picture in update_server); pictures in chat come
/// in their own message and may be bigger.
pub const MAX_MESSAGE: usize = 262_144;
pub const MAX_IMAGE_BYTES: usize = 320_000;
const MAX_IMAGE_STORE: i64 = 100_000_000;
const IMAGES_PER_DAY: i64 = 40;
pub const UPLOAD_CLOCK_SKEW_MS: u64 = 5 * 60_000;
/// Hopp Cloud's features; a server on someone's computer has every one of them.
const FEATURES: [&str; 19] = [
    "search", "screen", "voice-chat", "voice-mod", "voice-settings", "mod-tools", "roles", "pings", "resync", "nicknames", "members", "emojis", "search-filters", "polls", "voice-messages", "threads", "automod", "events", "watch",
];

static ENDPOINT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:\d{1,3}(\.\d{1,3}){3}|\[[0-9a-fA-F:.]{2,45}\]):\d{1,5}$").unwrap());
static CUSTOM_EMOJI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^<:[a-z0-9_]{2,32}:\d{1,9}>$").unwrap());
static EMOJI_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9_]{2,32}$").unwrap());
static ROLE_MENTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<@&(\d+)>").unwrap());
/// A person mentioned in a message: <@their Hopp ID>.
static MENTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"<@([0-9a-f]{64})>").unwrap());
static ROLE_COLOR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^#[0-9a-f]{6}$").unwrap());
static SEARCH_FILTER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)(^|\s)(from|in|has):(?:"([^"]{1,64})"|(\S{1,64}))"#).unwrap());
static POLL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^hopp-poll:([A-Za-z0-9_-]{4,2600})$").unwrap());
/// A picture message: "hopp-image:<id> <width>x<height>", then an optional caption.
static IMAGE_TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^hopp-image:([0-9a-f]{32}) (\d{1,5})x(\d{1,5})(?:\n|$)").unwrap());
/// A voice message: hopp-voice:<stored id> <length in ms>.
static VOICE_TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^hopp-voice:([0-9a-f]{32}) (\d{1,6})$").unwrap());

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ---------- reading loose JSON the way the cloud's JavaScript does ----------

/// `Number(v)`: `None` for NaN (and for a missing field).
fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                Some(0.0)
            } else {
                t.parse().ok()
            }
        }
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

/// A whole number, or one no id ever has.
fn int(v: &Value) -> i64 {
    num(v).filter(|x| x.is_finite() && x.fract() == 0.0).map(|x| x as i64).unwrap_or(i64::MIN)
}

/// `String(v ?? "")`.
fn text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// `!!v`.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

fn chars(s: &str) -> usize {
    s.chars().count()
}

fn valid_emoji(emoji: &str) -> bool {
    if CUSTOM_EMOJI.is_match(emoji) {
        return true;
    }
    !emoji.is_empty() && emoji.len() <= 32 && emoji.chars().all(|c| (c as u32) > 127 && !c.is_whitespace())
}

fn reply_preview(text: &str) -> String {
    if chars(text) > REPLY_PREVIEW_LEN {
        text.chars().take(REPLY_PREVIEW_LEN).collect::<String>() + "…"
    } else {
        text.to_string()
    }
}

struct SearchQuery {
    words: String,
    from: Vec<String>,
    in_: Vec<String>,
    has: Vec<String>,
}

/// "from:elin in:general has:link gg" → the filters (lowercase) and the words left to find.
fn parse_search(query: &str) -> SearchQuery {
    let mut out = SearchQuery { words: String::new(), from: vec![], in_: vec![], has: vec![] };
    let rest = SEARCH_FILTER.replace_all(query, |c: &regex::Captures| {
        let value = c.get(3).or_else(|| c.get(4)).map(|m| m.as_str()).unwrap_or("").to_lowercase();
        let value = value.strip_prefix(['@', '#']).map(str::to_string).unwrap_or(value);
        match c[2].to_lowercase().as_str() {
            "from" => out.from.push(value),
            "in" => out.in_.push(value),
            _ => out.has.push(value),
        }
        c[1].to_string()
    });
    out.words = rest.split_whitespace().collect::<Vec<_>>().join(" ");
    out
}

struct Poll {
    answers: usize,
    end: f64,
    multi: bool,
}

/// A poll's message: hopp-poll:<base64url {"q", "a": [answers], "end": ms, "multi"}>.
fn parse_poll(text: &str) -> Option<Poll> {
    let m = POLL.captures(text)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(m[1].trim_end_matches('=')).ok()?;
    let p: Value = serde_json::from_slice(&bytes).ok()?;
    let answers = p["a"].as_array().map(|a| a.len().min(10)).unwrap_or(0);
    let end = num(&p["end"]).filter(|e| e.is_finite())?;
    if answers < 2 {
        return None;
    }
    Some(Poll { answers, end, multi: truthy(&p["multi"]) })
}

/// Anything kept in the server's store (a picture or a voice message): its id.
fn stored_id(text: &str) -> Option<String> {
    IMAGE_TOKEN.captures(text).or_else(|| VOICE_TOKEN.captures(text)).map(|c| c[1].to_string())
}

/// What notifications and thread names show for a message: a picture reads as "Image".
fn plain_text(text: &str) -> String {
    if VOICE_TOKEN.is_match(text) {
        return "🎤 Voice message".into();
    }
    let Some(m) = IMAGE_TOKEN.find(text) else { return text.to_string() };
    let caption = text[m.end()..].trim();
    if caption.is_empty() {
        "🖼 Image".into()
    } else {
        format!("🖼 {caption}")
    }
}

fn image_type_ok(kind: &str, b: &[u8]) -> Option<bool> {
    Some(match kind {
        "image/webp" => b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP",
        "image/jpeg" => b.len() > 3 && b[0] == 0xff && b[1] == 0xd8 && b[2] == 0xff,
        "image/png" => b.len() > 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4e && b[3] == 0x47,
        // Voice messages: Opus in WebM, as the app records them.
        "audio/webm" => b.len() > 4 && b[0] == 0x1a && b[1] == 0x45 && b[2] == 0xdf && b[3] == 0xa3,
        _ => return None,
    })
}

fn valid_icon(icon: &str) -> bool {
    icon.len() <= MAX_ICON_LEN && strom_shared::valid_icon(icon)
}

fn new_code() -> String {
    (0..8).map(|_| INVITE_ALPHABET[rand::random::<u8>() as usize % INVITE_ALPHABET.len()] as char).collect()
}

fn normalize_channel_name(name: &str, kind: &str) -> String {
    let trimmed = name.trim();
    if kind == "voice" {
        trimmed.to_string()
    } else {
        trimmed.to_lowercase().split_whitespace().collect::<Vec<_>>().join("-")
    }
}

fn duration_text(minutes: i64) -> String {
    let plural = |n: i64, unit: &str| format!("{n} {unit}{}", if n == 1 { "" } else { "s" });
    if minutes % 10080 == 0 {
        plural(minutes / 10080, "week")
    } else if minutes % 1440 == 0 {
        plural(minutes / 1440, "day")
    } else if minutes % 60 == 0 {
        plural(minutes / 60, "hour")
    } else {
        plural(minutes, "minute")
    }
}

/// `@everyone` and `@here` as words of their own: (where the `@` is, which word).
fn crowd_words(text: &str) -> Vec<(usize, &'static str)> {
    let word_char = |c: char| c.is_alphanumeric() || c == '_';
    let mut out = vec![];
    for (i, _) in text.match_indices('@') {
        let before = text[..i].chars().next_back();
        if before.is_some_and(|c| word_char(c) || c == '@') {
            continue;
        }
        for word in ["everyone", "here"] {
            if text[i + 1..].starts_with(word) && !text[i + 1 + word.len()..].chars().next().is_some_and(word_char) {
                out.push((i, word));
            }
        }
    }
    out
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Rank {
    Member = 0,
    Mod = 1,
    Admin = 2,
    Owner = 3,
}

fn rank(role: Option<&str>) -> Rank {
    match role {
        Some("owner") => Rank::Owner,
        Some("admin") => Rank::Admin,
        Some("mod") => Rank::Mod,
        _ => Rank::Member,
    }
}

#[derive(Clone)]
struct Ch {
    id: i64,
    name: String,
    kind: String,
    topic: Option<String>,
    category: Option<String>,
    no_pictures: bool,
    user_limit: Option<i64>,
    afk_after: Option<i64>,
    slowmode: Option<i64>,
    private_roles: Option<Vec<i64>>,
    parent: Option<i64>,
    starter: Option<i64>,
    last_at: Option<i64>,
    creator: Option<String>,
}

impl Ch {
    fn json(&self) -> Value {
        let mut m = Map::new();
        m.insert("id".into(), json!(self.id));
        m.insert("name".into(), json!(self.name));
        m.insert("kind".into(), json!(self.kind));
        if let Some(t) = &self.topic {
            m.insert("topic".into(), json!(t));
        }
        if let Some(c) = &self.category {
            m.insert("category".into(), json!(c));
        }
        if self.no_pictures {
            m.insert("no_pictures".into(), json!(true));
        }
        if let Some(v) = self.user_limit {
            m.insert("user_limit".into(), json!(v));
        }
        if let Some(v) = self.afk_after {
            m.insert("afk_after".into(), json!(v));
        }
        if let Some(v) = self.slowmode {
            m.insert("slowmode".into(), json!(v));
        }
        if let Some(v) = &self.private_roles {
            m.insert("private_roles".into(), json!(v));
        }
        if let Some(p) = self.parent {
            m.insert("parent".into(), json!(p));
            if let Some(v) = self.starter {
                m.insert("starter".into(), json!(v));
            }
            if let Some(v) = self.last_at {
                m.insert("last_at".into(), json!(v));
            }
            if let Some(v) = &self.creator {
                m.insert("creator".into(), json!(v));
            }
        }
        Value::Object(m)
    }
}

#[derive(Clone)]
struct RoleInfo {
    id: i64,
    name: String,
    color: Option<String>,
    hoist: bool,
    level: Option<String>,
    position: i64,
    mentionable: bool,
}

impl RoleInfo {
    fn json(&self) -> Value {
        json!({ "id": self.id, "name": self.name, "color": self.color, "hoist": self.hoist, "level": self.level, "position": self.position, "mentionable": self.mentionable })
    }
}

#[derive(PartialEq, Clone, Copy)]
enum Stage {
    Hello,
    Auth,
    Joined,
    Removed,
}

/// One connection, and what we remember about it.
struct Conn {
    tx: mpsc::UnboundedSender<Out>,
    /// From this very computer: may claim a server that has no owner yet.
    local: bool,
    stage: Stage,
    joined_at: u64,
    last_ping: u64,
    searched_at: u64,
    last_sent: HashMap<i64, u64>,
    nonce: [u8; 32],
    key: String,
    name: String,
    invite: Option<String>,
    create: Option<String>,
    user: Option<User>,
    tokens: f64,
    refilled: u64,
    any: f64,
    act: f64,
    sig: f64,
    topped: u64,
    last_typing: u64,
    endpoint: Option<(Option<String>, Vec<String>)>,
    /// What they sent lately, for AutoMod's repeat rule: (text, when).
    recent: Vec<(String, u64)>,
    /// What they told us of themselves (online, idle, dnd) for the member list.
    status: Option<String>,
    // Voice through the server's own relay (servers that aren't mesh).
    pub token: u64,
    pub udp_addr: Option<SocketAddr>,
    pub loopback: bool,
    pub voice_key: Option<[u8; 32]>,
    pub voice_window: (Instant, u32),
}

/// A connection as the voice relay sees it.
pub struct RelayView<'a> {
    pub user: &'a User,
    pub token: u64,
    pub udp_addr: &'a mut Option<SocketAddr>,
    pub loopback: bool,
    pub voice_key: Option<[u8; 32]>,
    pub voice_window: &'a mut (Instant, u32),
}

pub struct Core {
    db: Connection,
    conns: BTreeMap<ConnId, Conn>,
    next_conn: ConnId,
    /// Voice goes between the members, as on Hopp Cloud; otherwise through `udp_port`.
    mesh: bool,
    pub udp_port: u16,
    /// Lets the first owner claim a server from another computer.
    pub setup_code: Option<String>,
}

type Fail = (u16, String);

impl Core {
    pub fn new(db: Connection, mesh: bool, udp_port: u16) -> anyhow::Result<Core> {
        create_tables(&db)?;
        let mut core = Core { db, conns: BTreeMap::new(), next_conn: 1, mesh, udp_port, setup_code: None };
        if core.meta("name").is_some() && core.meta("owner").is_none() {
            core.setup_code = Some(new_code());
        }
        Ok(core)
    }

    /// A new server, set up on this computer: its name and channels; no owner until someone
    /// claims it from this computer (or with the setup code).
    pub fn create_unowned(&mut self, name: &str, channels: &[(&str, &str)]) {
        if name.is_empty() || self.meta("name").is_some() {
            return;
        }
        self.set_meta("name", name);
        self.set_meta("created_at", &now_ms().to_string());
        for (n, kind) in channels {
            let _ = self.db.execute("INSERT INTO channels (name, kind) VALUES (?, ?)", params![n, kind]);
        }
        self.setup_code = Some(new_code());
    }

    /// Data moved in from an older server: it may have no owner yet.
    pub(crate) fn after_import(&mut self) {
        self.setup_code = (self.meta("owner").is_none()).then(new_code);
    }

    pub fn has_owner(&self) -> bool {
        self.meta("owner").is_some()
    }

    pub fn db(&self) -> &Connection {
        &self.db
    }

    // ---------- connections ----------

    pub fn open(&mut self, tx: mpsc::UnboundedSender<Out>, local: bool, voice_key: Option<[u8; 32]>) -> ConnId {
        let id = self.next_conn;
        self.next_conn += 1;
        let now = now_ms();
        self.conns.insert(
            id,
            Conn {
                tx,
                local,
                stage: Stage::Hello,
                joined_at: now,
                last_ping: now,
                searched_at: 0,
                last_sent: HashMap::new(),
                nonce: [0; 32],
                key: String::new(),
                name: String::new(),
                invite: None,
                create: None,
                user: None,
                tokens: CHAT_BURST,
                refilled: now,
                any: ANY_BURST,
                act: ACT_BURST,
                sig: SIGNAL_BURST,
                topped: now,
                last_typing: 0,
                recent: Vec::new(),
                endpoint: None,
                status: None,
                token: rand::random(),
                udp_addr: None,
                loopback: false,
                voice_key,
                voice_window: (Instant::now(), 0),
            },
        );
        id
    }

    pub fn is_joined(&self, conn: ConnId) -> bool {
        self.conns.get(&conn).is_some_and(|c| c.stage == Stage::Joined)
    }

    pub fn is_gone(&self, conn: ConnId) -> bool {
        self.conns.get(&conn).is_none_or(|c| c.stage == Stage::Removed)
    }

    /// The server stops: everyone is let go.
    pub fn hang_up_all(&mut self) {
        let all: Vec<ConnId> = self.conns.keys().copied().collect();
        for id in all {
            self.hang_up(id);
        }
    }

    /// The connection ended (or was ended).
    pub fn close(&mut self, conn: ConnId) {
        let Some(c) = self.conns.remove(&conn) else { return };
        if let Some(u) = &c.user {
            // Removed ones (kicked, replaced) were already said goodbye to.
            if c.stage == Stage::Joined {
                self.broadcast(&json!({ "type": "user_left", "session_id": u.session_id }), None);
            }
            self.presence(&c.key, true);
        }
    }

    /// The voice relay's view of someone, by their session.
    pub fn relay_view(&mut self, session_id: u32) -> Option<RelayView<'_>> {
        let c = self.conns.values_mut().find(|c| c.stage == Stage::Joined && c.user.as_ref().is_some_and(|u| u.session_id == session_id))?;
        Some(RelayView { user: c.user.as_ref()?, token: c.token, udp_addr: &mut c.udp_addr, loopback: c.loopback, voice_key: c.voice_key, voice_window: &mut c.voice_window })
    }

    /// Everyone in the relay's voice channel who listens: (session, where, their key, loopback).
    pub fn relay_listeners(&self) -> Vec<(u32, Option<u32>, bool, Option<SocketAddr>, Option<[u8; 32]>, bool)> {
        self.conns
            .values()
            .filter(|c| c.stage == Stage::Joined)
            .filter_map(|c| {
                let u = c.user.as_ref()?;
                Some((u.session_id, u.voice_channel, u.deafened || u.server_deafened, c.udp_addr, c.voice_key, c.loopback))
            })
            .collect()
    }

    // ---------- storage helpers ----------

    fn meta(&self, key: &str) -> Option<String> {
        self.db.query_row("SELECT value FROM meta WHERE key = ?", [key], |r| r.get(0)).optional().ok().flatten()
    }

    fn set_meta(&self, key: &str, value: &str) {
        let _ = self.db.execute("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
    }

    pub fn set_server_id(&self, id: &str) {
        if self.meta("server_id").is_none() {
            self.set_meta("server_id", id);
        }
    }

    fn exec(&self, sql: &str, args: impl rusqlite::Params) {
        if let Err(e) = self.db.execute(sql, args) {
            tracing::error!("database: {e} in {sql}");
        }
    }

    fn exists(&self, sql: &str, args: impl rusqlite::Params) -> bool {
        self.db.prepare_cached(sql).and_then(|mut s| s.exists(args)).unwrap_or(false)
    }

    fn count(&self, sql: &str, args: impl rusqlite::Params) -> i64 {
        self.db.query_row(sql, args, |r| r.get(0)).unwrap_or(0)
    }

    fn strings(&self, sql: &str, args: impl rusqlite::Params) -> Vec<String> {
        let Ok(mut s) = self.db.prepare_cached(sql) else { return vec![] };
        s.query_map(args, |r| r.get::<_, String>(0)).map(|rows| rows.flatten().collect()).unwrap_or_default()
    }

    fn channels(&self) -> Vec<Ch> {
        let Ok(mut s) = self.db.prepare_cached(
            "SELECT id, name, kind, topic, category, no_pictures, user_limit, afk_after, slowmode, private_roles, parent, starter, creator,
               CASE WHEN parent IS NULL THEN NULL ELSE (SELECT max(sent_at) FROM messages m WHERE m.channel = channels.id) END AS last_at
             FROM channels ORDER BY coalesce(position, id + 100000), id",
        ) else {
            return vec![];
        };
        let all: Vec<Ch> = s
            .query_map([], |r| {
                Ok(Ch {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    kind: r.get(2)?,
                    topic: r.get::<_, Option<String>>(3)?.filter(|t| !t.is_empty()),
                    category: r.get::<_, Option<String>>(4)?.filter(|t| !t.is_empty()),
                    no_pictures: r.get::<_, Option<i64>>(5)?.unwrap_or(0) != 0,
                    user_limit: r.get::<_, Option<i64>>(6)?.filter(|v| *v != 0),
                    afk_after: r.get::<_, Option<i64>>(7)?.filter(|v| *v != 0),
                    slowmode: r.get::<_, Option<i64>>(8)?.filter(|v| *v != 0),
                    private_roles: r.get::<_, Option<String>>(9)?.and_then(|t| serde_json::from_str(&t).ok()),
                    parent: r.get(10)?,
                    starter: r.get(11)?,
                    creator: r.get(12)?,
                    last_at: r.get::<_, Option<i64>>(13)?.filter(|v| *v != 0),
                })
            })
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default();
        // A thread's people are its channel's: it takes the channel's privacy along.
        let privacy: HashMap<i64, Option<Vec<i64>>> = all.iter().map(|c| (c.id, c.private_roles.clone())).collect();
        all.into_iter()
            .map(|mut c| {
                if let Some(p) = c.parent {
                    c.private_roles = privacy.get(&p).cloned().flatten();
                }
                c
            })
            .collect()
    }

    fn channel(&self, id: i64) -> Option<Ch> {
        self.channels().into_iter().find(|c| c.id == id)
    }

    fn invites(&self) -> Vec<Value> {
        let now = now_ms() as i64;
        let Ok(mut s) = self.db.prepare_cached("SELECT code, created_at, expires_at, max_uses, uses, inviter FROM invites ORDER BY created_at") else { return vec![] };
        let all: Vec<(String, i64, Option<i64>, Option<i64>, i64, Option<String>)> =
            s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))).map(|rows| rows.flatten().collect()).unwrap_or_default();
        let mut out = vec![];
        for (code, created_at, expires_at, max_uses, uses, inviter) in all {
            let usable = expires_at.is_none_or(|t| now < t) && max_uses.is_none_or(|m| uses < m);
            if usable {
                out.push(json!({ "code": code, "created_at": created_at, "expires_at": expires_at, "max_uses": max_uses, "uses": uses, "inviter": inviter }));
            } else {
                self.exec("DELETE FROM invites WHERE code = ?", [&code]);
            }
        }
        out
    }

    /// Someone's role here; the owner is kept in meta, everyone else in accounts.
    fn role_of(&self, key: &str) -> Option<&'static str> {
        if self.meta("owner").as_deref() == Some(key) {
            return Some("owner");
        }
        let r: Option<String> = self.db.query_row("SELECT role FROM accounts WHERE key = ?", [key], |r| r.get(0)).optional().ok().flatten().flatten();
        // The server's own roles can carry moderator or admin rights too: the highest counts.
        let levels = self.strings("SELECT r.level FROM roles r JOIN member_roles m ON m.role = r.id WHERE m.key = ? AND r.level IS NOT NULL", [key]);
        if r.as_deref() == Some("admin") || levels.iter().any(|l| l == "admin") {
            return Some("admin");
        }
        if r.as_deref() == Some("mod") || levels.iter().any(|l| l == "mod") {
            return Some("mod");
        }
        None
    }

    fn member_list(&self) -> Vec<Value> {
        let owner = self.meta("owner");
        let mut roles: HashMap<String, Vec<i64>> = HashMap::new();
        if let Ok(mut s) = self.db.prepare_cached("SELECT key, role FROM member_roles") {
            for (k, r) in s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).map(|rows| rows.flatten().collect::<Vec<_>>()).unwrap_or_default() {
                roles.entry(k).or_default().push(r);
            }
        }
        let mut status: HashMap<String, String> = HashMap::new();
        if let Ok(mut s) = self.db.prepare_cached("SELECT key, status FROM member_status WHERE at > ?") {
            for (k, v) in s
                .query_map([now_ms().saturating_sub(STATUS_STALE_MS) as i64], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map(|rows| rows.flatten().collect::<Vec<_>>())
                .unwrap_or_default()
            {
                status.insert(k, v);
            }
        }
        let Ok(mut s) = self.db.prepare_cached("SELECT key, name, nick, role, created_at FROM accounts WHERE key NOT IN (SELECT key FROM bans) ORDER BY lower(coalesce(nick, name)) LIMIT 1000") else {
            return vec![];
        };
        let rows: Vec<(String, String, Option<String>, Option<String>, i64)> =
            s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).map(|rows| rows.flatten().collect()).unwrap_or_default();
        rows.into_iter()
            .map(|(key, name, nick, role, created_at)| {
                let role = if Some(&key) == owner.as_ref() {
                    Some("owner".to_string())
                } else {
                    role.filter(|r| r == "admin" || r == "mod")
                };
                let mut m = json!({
                    "public_key": key, "name": nick.clone().unwrap_or(name.clone()), "nick": nick, "account_name": name,
                    "role": role, "joined_at": created_at, "roles": roles.get(&key).cloned().unwrap_or_default(),
                });
                if let Some(st) = status.get(&key) {
                    m["status"] = json!(st);
                }
                m
            })
            .collect()
    }

    fn members(&self) -> Vec<ConnId> {
        self.conns.iter().filter(|(_, c)| c.stage == Stage::Joined && c.user.is_some()).map(|(&id, _)| id).collect()
    }

    /// Everyone connected with this Hopp ID (one person on several computers).
    fn conns_of(&self, key: &str) -> Vec<ConnId> {
        self.members().into_iter().filter(|id| self.conns[id].key == key).collect()
    }

    fn key_of(&self, conn: ConnId) -> String {
        self.conns.get(&conn).map(|c| c.key.clone()).unwrap_or_default()
    }

    fn user_of(&self, conn: ConnId) -> User {
        self.conns[&conn].user.clone().expect("joined")
    }

    /// A role changed: everyone online sees it at once, and staff get the new list.
    fn roles_changed(&mut self) {
        for id in self.members() {
            let key = self.key_of(id);
            let role = self.role_of(&key);
            if self.conns[&id].user.as_ref().and_then(|u| u.role.as_deref()) != role {
                self.update_user(id, |u| {
                    u.owner = role == Some("owner");
                    u.role = role.map(str::to_string);
                });
            }
            if rank(role) >= Rank::Admin {
                let list = self.member_list();
                self.send(id, &json!({ "type": "members", "members": list }));
            }
        }
    }

    fn bans(&self) -> Vec<Value> {
        let Ok(mut s) = self.db.prepare_cached("SELECT key, name, banned_at FROM bans ORDER BY banned_at") else { return vec![] };
        s.query_map([], |r| Ok(json!({ "public_key": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "banned_at": r.get::<_, i64>(2)? })))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default()
    }

    fn row_to_message(r: &rusqlite::Row) -> rusqlite::Result<ChatMessage> {
        let reply_id: Option<i64> = r.get("reply_id")?;
        let reply = match reply_id {
            Some(id) => Some(Reply {
                id: id as u64,
                sender_name: r.get::<_, Option<String>>("reply_name")?.unwrap_or_default(),
                author_key: r.get::<_, Option<String>>("reply_key")?.unwrap_or_default(),
                text: r.get::<_, Option<String>>("reply_text")?.unwrap_or_default(),
            }),
            None => None,
        };
        let reactions: Vec<Reaction> = r.get::<_, Option<String>>("reactions")?.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        Ok(ChatMessage {
            id: r.get::<_, i64>("id")? as u64,
            channel: r.get::<_, i64>("channel")? as u32,
            sender: r.get::<_, i64>("sender")? as u32,
            sender_name: r.get("sender_name")?,
            author_key: r.get("author_key")?,
            text: r.get("text")?,
            sent_at: r.get::<_, i64>("sent_at")? as u64,
            reply,
            edited_at: r.get::<_, Option<i64>>("edited_at")?.map(|v| v as u64),
            reactions,
            pinned: r.get::<_, Option<i64>>("pinned")?.unwrap_or(0) != 0,
        })
    }

    fn messages(&self, sql: &str, args: impl rusqlite::Params) -> Vec<ChatMessage> {
        let Ok(mut s) = self.db.prepare_cached(sql) else { return vec![] };
        s.query_map(args, Self::row_to_message).map(|rows| rows.flatten().collect()).unwrap_or_default()
    }

    fn history(&self, channel: i64, before: i64, limit: i64) -> Vec<ChatMessage> {
        let mut m = self.messages("SELECT * FROM messages WHERE channel = ? AND id < ? ORDER BY id DESC LIMIT ?", params![channel, before, limit]);
        m.reverse();
        m
    }

    fn message(&self, channel: i64, id: i64) -> Option<ChatMessage> {
        self.messages("SELECT * FROM messages WHERE channel = ? AND id = ?", params![channel, id]).pop()
    }

    // ---------- sending ----------

    fn send(&self, conn: ConnId, msg: &Value) {
        if let Some(c) = self.conns.get(&conn) {
            let _ = c.tx.send(Out::Text(msg.to_string()));
        }
    }

    fn error(&self, conn: ConnId, message: &str) {
        self.send(conn, &json!({ "type": "error", "message": message }));
    }

    /// Ends a connection after telling it why.
    fn hang_up(&mut self, conn: ConnId) {
        if let Some(c) = self.conns.get_mut(&conn) {
            c.stage = Stage::Removed;
            let _ = c.tx.send(Out::Close);
        }
    }

    /// Rejects a login: tells the client why, then hangs up.
    fn reject(&mut self, conn: ConnId, message: &str) {
        self.error(conn, message);
        self.hang_up(conn);
    }

    fn broadcast(&self, msg: &Value, except: Option<ConnId>) {
        let text = msg.to_string();
        for id in self.members() {
            if Some(id) != except {
                let _ = self.conns[&id].tx.send(Out::Text(text.clone()));
            }
        }
    }

    fn update_user(&mut self, conn: ConnId, change: impl FnOnce(&mut User)) {
        let Some(user) = self.conns.get_mut(&conn).and_then(|c| c.user.as_mut()) else { return };
        change(user);
        let msg = json!({ "type": "user_updated", "user": user });
        self.broadcast(&msg, None);
    }

    fn voice_members(&self, channel: i64) -> Vec<ConnId> {
        self.members().into_iter().filter(|id| self.conns[id].user.as_ref().and_then(|u| u.voice_channel).map(i64::from) == Some(channel)).collect()
    }

    /// Puts someone in a voice channel: with mesh voice their app gets the channel's key and who
    /// to reach. A message instead when the channel is full.
    fn enter_voice(&mut self, conn: ConnId, ch: &Ch) -> Option<String> {
        let others: Vec<ConnId> = self.voice_members(ch.id).into_iter().filter(|&o| o != conn).collect();
        if self.mesh && others.len() >= MAX_VOICE_PEERS {
            return Some(format!("{} is full ({MAX_VOICE_PEERS} people).", ch.name));
        }
        let channel = ch.id as u32;
        // Watching together starts over when a channel fills up again.
        if others.is_empty() {
            self.exec("DELETE FROM meta WHERE key = ?", [format!("watch:{}", ch.id)]);
        }
        if !self.mesh {
            self.update_user(conn, |u| {
                u.voice_channel = Some(channel);
                u.sharing = false;
            });
            self.send_watch(conn, ch.id);
            return None;
        }
        // A fresh key whenever a channel fills up again, so people who left can't listen in later.
        let meta_key = format!("voice_key:{}", ch.id);
        let key = match self.meta(&meta_key) {
            Some(k) if !others.is_empty() => k,
            _ => {
                let k = hex::encode(rand::random::<[u8; 32]>());
                self.set_meta(&meta_key, &k);
                k
            }
        };
        self.conns.get_mut(&conn).expect("joined").endpoint = None;
        self.update_user(conn, |u| {
            u.voice_channel = Some(channel);
            u.sharing = false;
        });
        let peers: Vec<Value> = others
            .iter()
            .filter_map(|o| {
                let c = &self.conns[o];
                let (public, local) = c.endpoint.clone()?;
                Some(json!({ "session_id": c.user.as_ref()?.session_id, "public": public, "local": local }))
            })
            .collect();
        self.send(conn, &json!({ "type": "voice_session", "channel": ch.id, "key": key, "peers": peers }));
        self.send_watch(conn, ch.id);
        None
    }

    /// Timed out right now? (An old timeout that ran out is cleared on the way.)
    fn timed_out(&mut self, conn: ConnId) -> bool {
        let Some(user) = self.conns.get_mut(&conn).and_then(|c| c.user.as_mut()) else { return false };
        let until = user.timed_out_until.unwrap_or(0);
        if until > now_ms() {
            return true;
        }
        user.timed_out_until = None;
        false
    }

    /// A line in the audit log; the newest 500 are kept.
    fn audit(&self, actor: &str, action: &str, target: Option<&str>, detail: Option<&str>) {
        self.exec("INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)", params![now_ms() as i64, actor, action, target, detail]);
        self.exec("DELETE FROM audit WHERE id <= (SELECT id FROM audit ORDER BY id DESC LIMIT 1 OFFSET 500)", []);
    }

    // ---------- the member list's online dots ----------

    /// Someone's presence as their open connections tell it; the member list follows.
    fn presence(&mut self, key: &str, tell: bool) {
        if key.is_empty() {
            return;
        }
        let connected: Vec<&Conn> = self.conns.values().filter(|c| c.stage == Stage::Joined && c.key == key).collect();
        let status = if connected.is_empty() {
            "offline".to_string()
        } else {
            // The liveliest of their devices.
            let order = |s: &str| match s {
                "online" => 0,
                "dnd" => 1,
                "idle" => 2,
                _ => 3,
            };
            connected.iter().map(|c| c.status.clone().unwrap_or_else(|| "online".into())).min_by_key(|s| order(s)).unwrap_or_else(|| "online".into())
        };
        self.set_status(key, &status, tell);
    }

    /// A member came online, went idle or busy, or left: the member list shows it.
    pub fn member_status(&mut self, key: &str, status: &str) {
        self.set_status(key, status, true);
    }

    /// Keeps a member's status; `tell`: everyone's member list follows (coming online needs no
    /// telling: the people here see them arrive).
    fn set_status(&mut self, key: &str, status: &str, tell: bool) {
        if !MEMBER_STATUSES.contains(&status) {
            return;
        }
        let member = self.exists("SELECT 1 FROM accounts WHERE key = ? AND key NOT IN (SELECT key FROM bans)", [key]);
        let was: String = self.db.query_row("SELECT status FROM member_status WHERE key = ?", [key], |r| r.get(0)).optional().ok().flatten().unwrap_or_else(|| "offline".into());
        if !member || was == status {
            return;
        }
        if status == "offline" {
            self.exec("DELETE FROM member_status WHERE key = ?", [key]);
        } else {
            self.exec(
                "INSERT INTO member_status (key, status, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET status = excluded.status, at = excluded.at",
                params![key, status, now_ms() as i64],
            );
        }
        if !tell {
            return;
        }
        let list = self.member_list();
        if list.len() > PRESENCE_PUSH_LIMIT {
            return;
        }
        let msg = json!({ "type": "members", "members": list });
        for id in self.members() {
            self.send(id, &msg);
        }
    }

    /// What an invite shows before joining.
    pub fn preview(&self, code: &str) -> Option<Value> {
        let name = self.meta("name")?;
        if !self.invites().iter().any(|i| i["code"] == code) {
            return None;
        }
        let members = self.count("SELECT count(*) FROM accounts", []);
        let inviter: Option<String> = self.db.query_row("SELECT inviter FROM invites WHERE code = ?", [code], |r| r.get(0)).optional().ok().flatten().flatten();
        Some(json!({ "name": name, "icon": self.meta("icon"), "members": members, "online": self.members().len(), "inviter": inviter }))
    }

    // ---------- pictures ----------

    pub fn image(&self, id: &str) -> Option<(String, Vec<u8>)> {
        self.db.query_row("SELECT type, data FROM images WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional().ok().flatten()
    }

    /// Checks an upload's signature as Hopp Cloud does (`hopp-image-v1`, the server's id, the
    /// picture's SHA-256, the time). For the test server, which takes uploads like the cloud.
    pub fn check_upload_signature(&self, key: &str, time: u64, signature: &str, data: &[u8]) -> Result<(), Fail> {
        use sha2::{Digest, Sha256};
        let sig: Option<[u8; 64]> = hex::decode(signature).ok().and_then(|b| b.try_into().ok());
        let pk: Option<[u8; 32]> = hex::decode(key).ok().and_then(|b| b.try_into().ok());
        let (Some(sig), Some(pk)) = (sig, pk) else { return Err((401, "Not signed.".into())) };
        if !key.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return Err((401, "Not signed.".into()));
        }
        if now_ms().abs_diff(time) > UPLOAD_CLOCK_SKEW_MS {
            return Err((401, "Your computer's clock is off. Check the time and try again.".into()));
        }
        let digest = hex::encode(Sha256::digest(data));
        let signed = format!("hopp-image-v1\0{}\0{digest}\0{time}", self.meta("server_id").unwrap_or_default());
        let valid = VerifyingKey::from_bytes(&pk).is_ok_and(|k| k.verify(signed.as_bytes(), &Signature::from_bytes(&sig)).is_ok());
        if valid {
            Ok(())
        } else {
            Err((401, "Not signed.".into()))
        }
    }

    /// A member stores a picture (or a voice message); answered with its id.
    pub fn upload_image(&self, key: &str, kind: &str, data: &[u8]) -> Result<String, Fail> {
        let fail = |status: u16, error: &str| Err((status, error.to_string()));
        if self.meta("name").is_none() {
            return fail(404, "This server doesn't exist.");
        }
        let Some(ok) = image_type_ok(kind, data) else { return fail(400, "Only WebP, JPEG and PNG pictures, and voice messages.") };
        if data.is_empty() || data.len() > MAX_IMAGE_BYTES {
            return fail(400, "That picture is too big.");
        }
        if !ok {
            return fail(400, "That file isn't the picture it says it is.");
        }
        let member = self.exists("SELECT 1 FROM accounts WHERE key = ?", [key]);
        let banned = self.exists("SELECT 1 FROM bans WHERE key = ?", [key]);
        if !member || banned {
            return fail(403, "You're not a member of this server.");
        }
        // Pictures off: none in chat, but admins still upload the server's own emojis (a picture
        // sent in chat is refused when it's sent, admins too).
        if self.meta("pictures_off").as_deref() == Some("1") && kind.starts_with("image/") && rank(self.role_of(key)) < Rank::Admin {
            return fail(403, "Pictures are turned off in this server.");
        }
        let now = now_ms() as i64;
        let today = self.count("SELECT count(*) FROM images WHERE uploader = ? AND created_at > ?", params![key, now - 86_400_000]);
        if today >= IMAGES_PER_DAY {
            return fail(429, "You've shared a lot of pictures today. Try again tomorrow.");
        }
        // Pictures picked but never sent are let go after a day.
        self.exec("DELETE FROM images WHERE used = 0 AND created_at < ?", [now - 86_400_000]);
        let id = hex::encode(rand::random::<[u8; 16]>());
        self.exec("INSERT INTO images (id, uploader, type, data, size, created_at) VALUES (?, ?, ?, ?, ?, ?)", params![id, key, kind, data, data.len() as i64, now]);
        // Over the server's share of storage: the oldest pictures make room.
        let mut total = self.count("SELECT coalesce(sum(size), 0) FROM images", []);
        while total > MAX_IMAGE_STORE {
            let oldest: Option<(String, i64)> =
                self.db.query_row("SELECT id, size FROM images WHERE id NOT IN (SELECT image FROM emojis) ORDER BY created_at LIMIT 1", [], |r| Ok((r.get(0)?, r.get(1)?))).optional().ok().flatten();
            let Some((old, size)) = oldest else { break };
            self.exec("DELETE FROM images WHERE id = ?", [&old]);
            total -= size;
        }
        Ok(id)
    }

    /// A message being deleted: its picture goes too.
    fn drop_picture(&self, message_id: i64) {
        let text: Option<String> = self.db.query_row("SELECT text FROM messages WHERE id = ?", [message_id], |r| r.get(0)).optional().ok().flatten();
        if let Some(stored) = text.as_deref().and_then(stored_id) {
            self.exec("DELETE FROM images WHERE id = ?", [stored]);
        }
    }

    // ---------- messages ----------

    pub fn message_in(&mut self, conn: ConnId, data: &str) {
        let Some(stage) = self.conns.get(&conn).map(|c| c.stage) else { return };
        if stage == Stage::Removed {
            return;
        }
        let msg: Value = match serde_json::from_str(data) {
            Ok(v @ Value::Object(_)) => v,
            _ => return self.reject(conn, "Malformed message."),
        };
        // Pictures come in a message of their own; anything else is small.
        if data.len() > MAX_MESSAGE && msg["type"] != "upload_image" {
            return self.reject(conn, "Message too large.");
        }
        // Keep-alive pings are answered at any stage, and show the connection is alive.
        if msg["type"] == "ping" && msg.as_object().is_some_and(|o| o.len() == 1) {
            self.conns.get_mut(&conn).expect("open").last_ping = now_ms();
            return self.send(conn, &json!({ "type": "pong" }));
        }
        match stage {
            Stage::Hello => self.on_hello(conn, &msg),
            Stage::Auth => self.on_auth(conn, &msg),
            Stage::Joined => self.on_member(conn, &msg),
            Stage::Removed => {}
        }
    }

    fn on_hello(&mut self, conn: ConnId, msg: &Value) {
        if msg["type"] != "hello" {
            return self.reject(conn, "Expected hello.");
        }
        if msg["protocol_version"].as_i64() != Some(PROTOCOL_VERSION) {
            let theirs = msg["protocol_version"].clone();
            return self.reject(conn, &format!("The server speaks protocol {PROTOCOL_VERSION}, the app speaks {}.", if theirs.is_null() { "undefined".into() } else { text(&theirs) }));
        }
        let name = text(&msg["name"]).trim().to_string();
        if name.is_empty() || chars(&name) > MAX_NAME_LEN {
            return self.reject(conn, &format!("Names must be 1–{MAX_NAME_LEN} characters."));
        }
        let key = text(&msg["public_key"]).to_lowercase();
        if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
            return self.reject(conn, "Invalid Hopp ID.");
        }
        let nonce: [u8; 32] = rand::random();
        let c = self.conns.get_mut(&conn).expect("open");
        c.stage = Stage::Auth;
        c.nonce = nonce;
        c.key = key;
        c.name = name;
        c.invite = truthy(&msg["invite"]).then(|| text(&msg["invite"]).to_uppercase());
        c.create = truthy(&msg["create"]).then(|| text(&msg["create"]).trim().to_string());
        self.send(conn, &json!({ "type": "challenge", "nonce": hex::encode(nonce) }));
    }

    fn on_auth(&mut self, conn: ConnId, msg: &Value) {
        if msg["type"] != "auth" {
            return self.reject(conn, "Expected auth.");
        }
        let (key, account_name, nonce, invite, create, local) = {
            let c = &self.conns[&conn];
            (c.key.clone(), c.name.clone(), c.nonce, c.invite.clone(), c.create.clone(), c.local)
        };
        let sig: Option<[u8; 64]> = hex::decode(text(&msg["signature"])).ok().and_then(|b| b.try_into().ok());
        let pk: Option<[u8; 32]> = hex::decode(&key).ok().and_then(|b| b.try_into().ok());
        let valid = match (sig, pk) {
            (Some(sig), Some(pk)) => VerifyingKey::from_bytes(&pk).is_ok_and(|k| k.verify(&auth_message(&nonce), &Signature::from_bytes(&sig)).is_ok()),
            _ => false,
        };
        if !valid {
            return self.reject(conn, "Login failed: invalid signature.");
        }

        let now = now_ms();
        let nick: Option<String> = self.db.query_row("SELECT nick FROM accounts WHERE key = ?", [&key], |r| r.get(0)).optional().ok().flatten().flatten();
        let name = nick.unwrap_or_else(|| account_name.clone());

        // A brand-new server is created by whoever asks for it first; they own it.
        if self.meta("name").is_none() {
            let server_name = create.clone().unwrap_or_default();
            if server_name.is_empty() {
                return self.reject(conn, "This server doesn't exist.");
            }
            if chars(&server_name) > MAX_SERVER_NAME_LEN {
                return self.reject(conn, &format!("Server names must be 1–{MAX_SERVER_NAME_LEN} characters."));
            }
            self.set_meta("name", &server_name);
            self.set_meta("owner", &key);
            self.set_meta("created_at", &now.to_string());
            for (n, kind) in [("general", "text"), ("Lobby", "voice"), ("Gaming", "voice")] {
                self.exec("INSERT INTO channels (name, kind) VALUES (?, ?)", [n, kind]);
            }
        } else if create.is_some() {
            return self.reject(conn, "That server already exists.");
        }

        if self.exists("SELECT 1 FROM bans WHERE key = ?", [&key]) {
            return self.reject(conn, "You are banned from this server.");
        }
        // The same Hopp ID on another computer stays connected too. A connection that has
        // stopped pinging (a crashed app, a dropped network) is let go, so it doesn't linger.
        let stale: Vec<ConnId> = self
            .members()
            .into_iter()
            .filter(|id| *id != conn && self.conns[id].key == key)
            .filter(|id| now.saturating_sub(self.conns[id].last_ping.max(self.conns[id].joined_at)) >= STALE_SESSION_MS)
            .collect();
        for old in stale {
            let sid = self.conns[&old].user.as_ref().map(|u| u.session_id);
            self.hang_up(old);
            if let Some(sid) = sid {
                self.broadcast(&json!({ "type": "user_left", "session_id": sid }), None);
            }
        }
        if self.members().len() >= MAX_MEMBERS_ONLINE {
            return self.reject(conn, "The server is full.");
        }

        // A server set up on a computer has no owner until it's claimed: from that very
        // computer, or with the setup code it printed.
        if self.meta("owner").is_none() && (local || (invite.is_some() && invite == self.setup_code)) {
            tracing::info!("{account_name} is now the owner of this server");
            self.set_meta("owner", &key);
            self.setup_code = None;
        }
        let is_owner = self.meta("owner").as_deref() == Some(key.as_str());
        let known = self.exists("SELECT 1 FROM accounts WHERE key = ?", [&key]);
        if !known && !is_owner {
            if self.meta("invites_paused").as_deref() == Some("1") {
                return self.reject(conn, "This server isn't letting new people in right now. Try again later.");
            }
            let Some(code) = invite else { return self.reject(conn, "This server is invite-only. Ask the owner for an invite link.") };
            if !self.invites().iter().any(|i| i["code"] == code.as_str()) {
                return self.reject(conn, "This invite is invalid or has expired.");
            }
            self.exec("UPDATE invites SET uses = uses + 1 WHERE code = ?", [&code]);
        }
        self.exec("INSERT INTO accounts (key, name, created_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET name = excluded.name", params![key, account_name, now as i64]);
        self.exec("DELETE FROM notified WHERE key = ?", [&key]);

        let role = self.role_of(&key);
        let roles = self.roles_of(&key);
        // A timeout outlasts reconnecting.
        let timed_out: Option<i64> = self.db.query_row("SELECT until FROM timeouts WHERE key = ?", [&key], |r| r.get(0)).optional().ok().flatten();
        let user = User {
            session_id: rand::random::<u32>() & 0x7fff_ffff,
            name: name.clone(),
            voice_channel: None,
            muted: false,
            deafened: false,
            owner: is_owner,
            public_key: key.clone(),
            role: role.map(str::to_string),
            sharing: false,
            server_muted: false,
            server_deafened: false,
            timed_out_until: timed_out.map(|t| t as u64).filter(|t| *t > now),
            roles: roles.iter().map(|r| *r as u32).collect(),
        };
        self.broadcast(&json!({ "type": "user_joined", "user": user }), None);
        {
            let c = self.conns.get_mut(&conn).expect("open");
            c.stage = Stage::Joined;
            c.name = name;
            c.user = Some(user.clone());
            c.tokens = CHAT_BURST;
            c.refilled = now;
            c.joined_at = now;
        }
        let channels = self.channels_for(&key);
        let users: Vec<User> = self.members().iter().filter_map(|id| self.conns[id].user.clone()).collect();
        let token = if self.mesh { 0 } else { self.conns[&conn].token };
        let udp_port = if self.mesh { 0 } else { self.udp_port };
        self.send(
            conn,
            &json!({
                "type": "welcome",
                "server_name": self.meta("name"),
                "server_icon": self.meta("icon"),
                "pictures_off": self.meta("pictures_off").as_deref() == Some("1"),
                "session_id": user.session_id,
                "udp_token": token,
                "udp_port": udp_port,
                "channels": channels.iter().map(Ch::json).collect::<Vec<_>>(),
                "users": users,
                "features": FEATURES,
                "roles": self.custom_roles().iter().map(RoleInfo::json).collect::<Vec<_>>(),
                "emojis": self.emojis(),
            }),
        );
        for ch in &channels {
            self.send(conn, &json!({ "type": "chat_history", "channel": ch.id, "messages": self.history(ch.id, i64::MAX, CHAT_HISTORY) }));
        }
        self.presence(&key, false);
    }

    // ---------- the server's own emojis ----------

    fn emojis(&self) -> Vec<Value> {
        let Ok(mut s) = self.db.prepare_cached("SELECT id, name, image FROM emojis ORDER BY name") else { return vec![] };
        s.query_map([], |r| Ok(json!({ "id": r.get::<_, i64>(0)?, "name": r.get::<_, String>(1)?, "image": r.get::<_, String>(2)? })))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default()
    }

    // ---------- roles and private channels ----------

    fn custom_roles(&self) -> Vec<RoleInfo> {
        let Ok(mut s) = self.db.prepare_cached("SELECT id, name, color, hoist, level, position, mentionable FROM roles ORDER BY position DESC, id") else { return vec![] };
        s.query_map([], |r| {
            Ok(RoleInfo {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                hoist: r.get::<_, Option<i64>>(3)?.unwrap_or(0) != 0,
                level: r.get::<_, Option<String>>(4)?.filter(|l| l == "admin" || l == "mod"),
                position: r.get(5)?,
                mentionable: r.get::<_, Option<i64>>(6)?.unwrap_or(0) != 0,
            })
        })
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    }

    /// Who may ping many at once: moderators may use @everyone, @here and any role; others only
    /// roles that allow it. Anything else stays in the text as plain words that ping nobody.
    /// What the others in a voice channel are watching together, for someone joining it.
    fn send_watch(&self, conn: ConnId, channel: i64) {
        let Some(watch) = self.meta(&format!("watch:{channel}")).and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { return };
        let mut out = watch.clone();
        out["type"] = json!("watch");
        out["channel"] = json!(channel);
        out["at_ago"] = json!(now_ms().saturating_sub(watch["at"].as_u64().unwrap_or(0)));
        self.send(conn, &out);
    }

    /// Events long past are let go.
    fn prune_events(&self) {
        let old = now_ms() as i64 - EVENT_KEEP_MS;
        self.exec("DELETE FROM event_rsvp WHERE event IN (SELECT id FROM events WHERE starts_at < ?)", [old]);
        self.exec("DELETE FROM events WHERE starts_at < ?", [old]);
    }

    /// The events someone may see (those in channels they can see), soonest first, with who's coming.
    fn events_for(&self, key: &str) -> Vec<Value> {
        self.prune_events();
        let mut answers: HashMap<i64, (Vec<String>, Vec<String>)> = HashMap::new();
        let rows: Vec<(i64, String, String)> = self
            .db
            .prepare_cached("SELECT event, key, answer FROM event_rsvp")
            .and_then(|mut s| s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map(|rows| rows.flatten().collect()))
            .unwrap_or_default();
        for (event, who, answer) in rows {
            let a = answers.entry(event).or_default();
            if answer == "yes" { a.0.push(who) } else { a.1.push(who) }
        }
        let events: Vec<(i64, String, String, i64, i64, String, String)> = self
            .db
            .prepare_cached("SELECT id, name, description, channel, starts_at, creator, creator_name FROM events ORDER BY starts_at, id")
            .and_then(|mut s| s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))).map(|rows| rows.flatten().collect()))
            .unwrap_or_default();
        events
            .into_iter()
            .filter(|e| self.can_see(key, self.channel(e.3).as_ref()))
            .map(|(id, name, description, channel, starts_at, creator, creator_name)| {
                let (going, maybe) = answers.remove(&id).unwrap_or_default();
                json!({ "id": id, "name": name, "description": description, "channel": channel, "starts_at": starts_at, "creator": creator, "creator_name": creator_name, "going": going, "maybe": maybe })
            })
            .collect()
    }

    /// An event was planned, changed or answered: everyone gets the events they may see.
    fn events_changed(&self) {
        for id in self.members() {
            let events = self.events_for(&self.conns[&id].key);
            self.send(id, &json!({ "type": "events", "events": events }));
        }
    }

    /// The server's AutoMod rules: blocked words, most mentions in a message (0: any), repeats held back.
    fn automod(&self) -> (Vec<String>, i64, bool) {
        let a: Value = self.meta("automod").and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        let words = a["words"].as_array().map(|w| w.iter().map(text).collect()).unwrap_or_default();
        (words, a["mention_limit"].as_i64().unwrap_or(0), a["block_repeats"].as_bool().unwrap_or(false))
    }

    /// Why AutoMod holds a message back, or None. Moderators and admins are free of it.
    fn automod_says(&mut self, conn: ConnId, body: &str, my_rank: Rank, sending: bool) -> Option<String> {
        if my_rank >= Rank::Mod {
            return None;
        }
        let (words, limit, repeats) = self.automod();
        let lower = body.to_lowercase();
        if !words.is_empty() {
            let tokens: HashSet<&str> = lower.split(|c: char| !(c.is_alphanumeric() || c == '_')).filter(|w| !w.is_empty()).collect();
            if words.iter().any(|w| if w.contains(char::is_whitespace) { lower.contains(w.as_str()) } else { tokens.contains(w.as_str()) }) {
                return Some("That message has a word this server doesn't allow.".into());
            }
        }
        if limit > 0 {
            let people: HashSet<String> = MENTION.captures_iter(body).map(|c| c[1].to_string()).collect();
            let roles: HashSet<String> = ROLE_MENTION.captures_iter(body).map(|c| c[1].to_string()).collect();
            if (people.len() + roles.len()) as i64 > limit {
                return Some(format!("This server allows at most {limit} mentions in one message."));
            }
        }
        if repeats && sending {
            let now = now_ms();
            let same = lower.trim().to_string();
            let c = self.conns.get_mut(&conn)?;
            c.recent.retain(|(_, at)| now.saturating_sub(*at) < 60_000);
            if c.recent.iter().filter(|(t, _)| *t == same).count() >= AUTOMOD_REPEATS {
                return Some("You've sent that a few times already. Give it a minute.".into());
            }
            c.recent.push((same.chars().take(200).collect(), now));
            if c.recent.len() > 10 {
                c.recent.remove(0);
            }
        }
        None
    }

    fn allow_pings(&self, text: &str, my_rank: Rank) -> String {
        if my_rank >= Rank::Mod {
            return text.to_string();
        }
        let mut out = text.to_string();
        for (at, _) in crowd_words(text).into_iter().rev() {
            out.insert(at + 1, '\u{200b}');
        }
        let roles: HashMap<i64, RoleInfo> = self.custom_roles().into_iter().map(|r| (r.id, r)).collect();
        ROLE_MENTION
            .replace_all(&out, |c: &regex::Captures| {
                let r = c[1].parse::<i64>().ok().and_then(|id| roles.get(&id));
                match r {
                    Some(r) if r.mentionable => c[0].to_string(),
                    Some(r) => format!("@{}", r.name),
                    None => "@deleted-role".to_string(),
                }
            })
            .into_owned()
    }

    fn roles_of(&self, key: &str) -> Vec<i64> {
        let Ok(mut s) = self.db.prepare_cached("SELECT role FROM member_roles WHERE key = ?") else { return vec![] };
        s.query_map([key], |r| r.get(0)).map(|rows| rows.flatten().collect()).unwrap_or_default()
    }

    /// Whether someone may see a channel: everyone, unless it's private to some roles (admins always).
    fn can_see(&self, key: &str, ch: Option<&Ch>) -> bool {
        let Some(roles) = ch.and_then(|c| c.private_roles.as_ref()).filter(|r| !r.is_empty()) else { return true };
        if key.is_empty() || rank(self.role_of(key)) >= Rank::Admin {
            return true;
        }
        let mine: HashSet<i64> = self.roles_of(key).into_iter().collect();
        roles.iter().any(|r| mine.contains(r))
    }

    /// Everyone who may see a channel, or `None` when that's everyone.
    fn who_can_see(&self, ch: Option<&Ch>) -> Option<HashSet<String>> {
        let wanted: HashSet<i64> = ch?.private_roles.as_ref().filter(|r| !r.is_empty())?.iter().copied().collect();
        let mut keys = HashSet::new();
        if let Some(owner) = self.meta("owner") {
            keys.insert(owner);
        }
        keys.extend(self.strings("SELECT key FROM accounts WHERE role = 'admin'", []));
        let admin_roles: HashSet<i64> = self.custom_roles().into_iter().filter(|r| r.level.as_deref() == Some("admin")).map(|r| r.id).collect();
        if let Ok(mut s) = self.db.prepare_cached("SELECT key, role FROM member_roles") {
            for (k, r) in s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).map(|rows| rows.flatten().collect::<Vec<_>>()).unwrap_or_default() {
                if wanted.contains(&r) || admin_roles.contains(&r) {
                    keys.insert(k);
                }
            }
        }
        Some(keys)
    }

    fn channels_for(&self, key: &str) -> Vec<Ch> {
        self.channels().into_iter().filter(|c| self.can_see(key, Some(c))).collect()
    }

    /// Each person gets the channels they may see (and their history, if asked).
    fn channels_changed(&self, with_history: bool) {
        for id in self.members() {
            let mine = self.channels_for(&self.conns[&id].key);
            self.send(id, &json!({ "type": "channels_updated", "channels": mine.iter().map(Ch::json).collect::<Vec<_>>() }));
            if with_history {
                for ch in &mine {
                    self.send(id, &json!({ "type": "chat_history", "channel": ch.id, "messages": self.history(ch.id, i64::MAX, CHAT_HISTORY) }));
                }
            }
        }
    }

    /// Sent only to the people who may see the channel.
    fn broadcast_channel(&self, channel: i64, msg: &Value, except: Option<ConnId>) {
        let ch = self.channel(channel);
        let allowed = self.who_can_see(ch.as_ref());
        let text = msg.to_string();
        for id in self.members() {
            let c = &self.conns[&id];
            if Some(id) == except || allowed.as_ref().is_some_and(|a| !a.contains(&c.key)) {
                continue;
            }
            let _ = c.tx.send(Out::Text(text.clone()));
        }
    }

    /// Someone's roles changed: their name card follows, everywhere.
    fn member_roles_changed(&mut self, key: &str) {
        let roles: Vec<u32> = self.roles_of(key).into_iter().map(|r| r as u32).collect();
        let role = self.role_of(key);
        for id in self.conns_of(key) {
            let roles = roles.clone();
            self.update_user(id, |u| {
                u.roles = roles;
                u.owner = role == Some("owner");
                u.role = role.map(str::to_string);
            });
        }
        self.roles_changed();
    }

    /// Role and emoji handling. True when the message was one of them.
    fn on_roles(&mut self, conn: ConnId, msg: &Value, owner: bool, my_rank: Rank) -> bool {
        let user = self.user_of(conn);
        let key = self.key_of(conn);
        let level = |v: &Value| v.as_str().filter(|l| *l == "admin" || *l == "mod").map(str::to_string);
        let color = |v: &Value| v.as_str().filter(|c| ROLE_COLOR.is_match(c)).map(str::to_lowercase);
        let name = |v: &Value| text(v).trim().chars().take(32).collect::<String>();
        let changed = |core: &Core| core.broadcast(&json!({ "type": "roles_updated", "roles": core.custom_roles().iter().map(RoleInfo::json).collect::<Vec<_>>() }), None);
        let t = msg["type"].as_str().unwrap_or("");
        let fail = |core: &Core, text: &str| {
            core.error(conn, text);
            true
        };
        match t {
            "create_role" => {
                if my_rank < Rank::Admin {
                    return fail(self, "Only admins and the owner can manage roles.");
                }
                if self.custom_roles().len() >= MAX_ROLES {
                    return fail(self, &format!("A server has at most {MAX_ROLES} roles."));
                }
                let lv = level(&msg["level"]);
                if lv.as_deref() == Some("admin") && !owner {
                    return fail(self, "Only the owner can make admin roles.");
                }
                let n = Some(name(&msg["name"])).filter(|n| !n.is_empty()).unwrap_or_else(|| "new role".into());
                let top = self.count("SELECT coalesce(max(position), 0) FROM roles", []);
                self.exec(
                    "INSERT INTO roles (name, color, hoist, level, position, mentionable) VALUES (?, ?, ?, ?, ?, ?)",
                    params![n, color(&msg["color"]), truthy(&msg["hoist"]).then_some(1), lv, top + 1, truthy(&msg["mentionable"]).then_some(1)],
                );
                self.audit(&user.name, "create_role", Some(&n), None);
                changed(self);
                true
            }
            "update_role" => {
                if my_rank < Rank::Admin {
                    return fail(self, "Only admins and the owner can manage roles.");
                }
                let Some(role) = self.custom_roles().into_iter().find(|r| r.id == int(&msg["id"])) else { return fail(self, "That role doesn't exist anymore.") };
                let lv = level(&msg["level"]);
                if (lv.as_deref() == Some("admin") || role.level.as_deref() == Some("admin")) && !owner {
                    return fail(self, "Only the owner can change admin roles.");
                }
                let n = Some(name(&msg["name"])).filter(|n| !n.is_empty()).unwrap_or(role.name.clone());
                self.exec(
                    "UPDATE roles SET name = ?, color = ?, hoist = ?, level = ?, mentionable = ? WHERE id = ?",
                    params![n, color(&msg["color"]), truthy(&msg["hoist"]).then_some(1), lv, truthy(&msg["mentionable"]).then_some(1), role.id],
                );
                self.audit(&user.name, "update_role", Some(&n), None);
                changed(self);
                self.roles_changed();
                true
            }
            "create_emoji" => {
                if my_rank < Rank::Admin {
                    return fail(self, "Only admins and the owner can add emojis.");
                }
                let n = text(&msg["name"]).trim().to_lowercase();
                let image = text(&msg["image"]);
                if !EMOJI_NAME.is_match(&n) || n.len() > EMOJI_NAME_MAX {
                    return fail(self, "Emoji names are 2–32 characters: lowercase letters, numbers and _.");
                }
                if self.exists("SELECT 1 FROM emojis WHERE name = ?", [&n]) {
                    return fail(self, &format!("There's already an emoji called :{n}:."));
                }
                if self.count("SELECT count(*) FROM emojis", []) >= MAX_EMOJIS {
                    return fail(self, &format!("A server can have up to {MAX_EMOJIS} emojis."));
                }
                if !self.exists("SELECT 1 FROM images WHERE id = ? AND uploader = ?", [&image, &key]) {
                    return fail(self, "That picture didn't upload. Try again.");
                }
                self.exec("UPDATE images SET used = 1 WHERE id = ?", [&image]);
                self.exec("INSERT INTO emojis (name, image, creator, created_at) VALUES (?, ?, ?, ?)", params![n, image, key, now_ms() as i64]);
                self.audit(&user.name, "create_emoji", Some(&format!(":{n}:")), None);
                self.broadcast(&json!({ "type": "emojis_updated", "emojis": self.emojis() }), None);
                true
            }
            "delete_emoji" => {
                if my_rank < Rank::Admin {
                    return fail(self, "Only admins and the owner can remove emojis.");
                }
                let id = int(&msg["id"]);
                let row: Option<(String, String)> = self.db.query_row("SELECT name, image FROM emojis WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional().ok().flatten();
                let Some((n, image)) = row else { return true };
                self.exec("DELETE FROM emojis WHERE id = ?", [id]);
                self.exec("DELETE FROM images WHERE id = ?", [&image]);
                self.audit(&user.name, "delete_emoji", Some(&format!(":{n}:")), None);
                self.broadcast(&json!({ "type": "emojis_updated", "emojis": self.emojis() }), None);
                true
            }
            "delete_role" => {
                if my_rank < Rank::Admin {
                    return fail(self, "Only admins and the owner can manage roles.");
                }
                let Some(role) = self.custom_roles().into_iter().find(|r| r.id == int(&msg["id"])) else { return true };
                if role.level.as_deref() == Some("admin") && !owner {
                    return fail(self, "Only the owner can delete admin roles.");
                }
                let holders = self.strings("SELECT key FROM member_roles WHERE role = ?", [role.id]);
                self.exec("DELETE FROM roles WHERE id = ?", [role.id]);
                self.exec("DELETE FROM member_roles WHERE role = ?", [role.id]);
                self.audit(&user.name, "delete_role", Some(&role.name), None);
                changed(self);
                for k in holders {
                    self.member_roles_changed(&k);
                }
                self.channels_changed(false);
                true
            }
            "reorder_roles" => {
                if my_rank < Rank::Admin {
                    return fail(self, "Only admins and the owner can manage roles.");
                }
                let order: Vec<i64> = msg["order"].as_array().map(|a| a.iter().map(int).collect()).unwrap_or_default();
                let mut ids: Vec<i64> = self.custom_roles().iter().map(|r| r.id).collect();
                let mut sorted = order.clone();
                sorted.sort_unstable();
                ids.sort_unstable();
                if sorted != ids {
                    return fail(self, "The roles changed meanwhile. Try again.");
                }
                let n = order.len() as i64;
                for (i, id) in order.iter().enumerate() {
                    self.exec("UPDATE roles SET position = ? WHERE id = ?", params![n - i as i64, id]);
                }
                changed(self);
                true
            }
            "assign_role" => {
                if my_rank < Rank::Admin {
                    return fail(self, "Only admins and the owner can give roles.");
                }
                let target_key = text(&msg["public_key"]);
                let Some(role) = self.custom_roles().into_iter().find(|r| r.id == int(&msg["role"])) else { return fail(self, "That role doesn't exist anymore.") };
                if role.level.as_deref() == Some("admin") && !owner {
                    return fail(self, "Only the owner can give admin roles.");
                }
                let Some(target) = self.member_list().into_iter().find(|m| m["public_key"] == target_key.as_str()) else {
                    return fail(self, "They're not a member of this server anymore.");
                };
                if target_key != key && rank(target["role"].as_str()) >= my_rank && !owner {
                    return fail(self, "You can't change the roles of someone at your level or above.");
                }
                let on = truthy(&msg["on"]);
                if on {
                    self.exec("INSERT INTO member_roles (key, role) VALUES (?, ?) ON CONFLICT DO NOTHING", params![target_key, role.id]);
                } else {
                    self.exec("DELETE FROM member_roles WHERE key = ? AND role = ?", params![target_key, role.id]);
                }
                self.audit(&user.name, if on { "give_role" } else { "take_role" }, target["name"].as_str(), Some(&role.name));
                self.member_roles_changed(&target_key);
                // A role can open private channels: those people get them (with their history).
                self.channels_changed(true);
                true
            }
            _ => false,
        }
    }

    /// Takes one from an allowance that fills up again over time. False when it's used up.
    fn spend(&mut self, conn: ConnId, which: u8) -> bool {
        let now = now_ms();
        let c = self.conns.get_mut(&conn).expect("open");
        let gone = now.saturating_sub(c.topped) as f64 / 1000.0;
        c.topped = now;
        c.any = (c.any + gone * ANY_PER_SECOND).min(ANY_BURST);
        c.act = (c.act + gone * ACT_PER_SECOND).min(ACT_BURST);
        c.sig = (c.sig + gone * SIGNAL_PER_SECOND).min(SIGNAL_BURST);
        let pot = match which {
            0 => &mut c.any,
            1 => &mut c.act,
            _ => &mut c.sig,
        };
        if *pot >= 1.0 {
            *pot -= 1.0;
            true
        } else {
            false
        }
    }

    fn on_member(&mut self, conn: ConnId, msg: &Value) {
        let t = msg["type"].as_str().unwrap_or("").to_string();
        // Nobody gets to flood the server (or everyone in it) with anything.
        if t == "screen_signal" {
            if !self.spend(conn, 2) {
                return;
            }
        } else if !self.spend(conn, 0) {
            return;
        } else if (t == "react" || t == "edit_message" || t == "typing") && !self.spend(conn, 1) {
            if t == "typing" {
                return;
            }
            return self.error(conn, "You're doing that too fast. Slow down a little.");
        }
        let user = self.user_of(conn);
        let key = self.key_of(conn);
        let owner = user.owner;
        let my_role = self.role_of(&key);
        let my_rank = rank(my_role);
        let allowed = |core: &Core, min: Rank| {
            if my_rank >= min {
                return true;
            }
            core.error(conn, if min == Rank::Admin { "Only admins and the owner can do that." } else { "Only moderators, admins and the owner can do that." });
            false
        };

        // A private channel someone may not see doesn't exist for them.
        if msg.get("channel").is_some() && t != "update_channel" && t != "delete_channel" {
            let ch = self.channel(int(&msg["channel"]));
            if ch.is_some() && !self.can_see(&key, ch.as_ref()) {
                return self.error(conn, "That channel doesn't exist.");
            }
        }
        if self.on_roles(conn, msg, owner, my_rank) {
            return;
        }
        let my_voice = user.voice_channel.map(i64::from);
        match t.as_str() {
            "join_voice" => {
                let Some(ch) = self.channel(int(&msg["channel"])).filter(|c| c.kind == "voice") else { return self.error(conn, "That voice channel doesn't exist.") };
                if self.timed_out(conn) {
                    return self.error(conn, "You're timed out, so you can't join voice right now.");
                }
                let limit = ch.user_limit.unwrap_or(0);
                if limit > 0 && self.voice_members(ch.id).into_iter().filter(|&o| o != conn).count() as i64 >= limit {
                    return self.error(conn, &format!("{} is full ({limit} people).", ch.name));
                }
                if let Some(full) = self.enter_voice(conn, &ch) {
                    self.error(conn, &format!("{full} Try another voice channel."));
                }
            }
            "disconnect_voice" | "move_voice" | "server_mute" => {
                if !allowed(self, Rank::Mod) {
                    return;
                }
                let target = int(&msg["session_id"]);
                let Some(tconn) = self.members().into_iter().find(|id| self.conns[id].user.as_ref().is_some_and(|u| i64::from(u.session_id) == target)) else {
                    return self.error(conn, "That person isn't connected anymore.");
                };
                let ts = self.user_of(tconn);
                if target != i64::from(user.session_id) && rank(self.role_of(&self.key_of(tconn))) >= my_rank {
                    return self.error(conn, "You can't do that to someone with the same role as you or higher.");
                }
                if t == "server_mute" {
                    let (muted, deafened) = (truthy(&msg["muted"]), truthy(&msg["deafened"]));
                    if muted != ts.server_muted {
                        self.audit(&user.name, if muted { "server_mute" } else { "server_unmute" }, Some(&ts.name), None);
                    }
                    if deafened != ts.server_deafened {
                        self.audit(&user.name, if deafened { "server_deafen" } else { "server_undeafen" }, Some(&ts.name), None);
                    }
                    return self.update_user(tconn, |u| {
                        u.server_muted = muted;
                        u.server_deafened = deafened;
                    });
                }
                if ts.voice_channel.is_none() {
                    return self.error(conn, &format!("{} isn't in a voice channel.", ts.name));
                }
                if t == "disconnect_voice" {
                    self.audit(&user.name, "voice_disconnect", Some(&ts.name), None);
                    self.conns.get_mut(&tconn).expect("joined").endpoint = None;
                    return self.update_user(tconn, |u| {
                        u.voice_channel = None;
                        u.sharing = false;
                    });
                }
                let Some(ch) = self.channel(int(&msg["channel"])).filter(|c| c.kind == "voice") else { return self.error(conn, "That voice channel doesn't exist.") };
                if Some(ch.id) == ts.voice_channel.map(i64::from) {
                    return;
                }
                if let Some(full) = self.enter_voice(tconn, &ch) {
                    return self.error(conn, &full);
                }
                self.audit(&user.name, "voice_move", Some(&ts.name), Some(&format!("to {}", ch.name)));
            }
            "leave_voice" => {
                self.conns.get_mut(&conn).expect("joined").endpoint = None;
                self.update_user(conn, |u| {
                    u.voice_channel = None;
                    u.sharing = false;
                });
            }
            "set_sharing" => {
                let on = truthy(&msg["on"]);
                if on && user.voice_channel.is_none() {
                    return self.error(conn, "Join a voice channel to share your screen.");
                }
                self.update_user(conn, |u| u.sharing = on);
            }
            "screen_signal" => {
                let data = text(&msg["data"]);
                let to = int(&msg["to"]);
                if my_voice.is_none() || data.len() > MAX_SCREEN_SIGNAL || to == i64::from(user.session_id) {
                    return;
                }
                let target = self.members().into_iter().find(|id| self.conns[id].user.as_ref().is_some_and(|u| i64::from(u.session_id) == to && u.voice_channel.map(i64::from) == my_voice));
                if let Some(target) = target {
                    self.send(target, &json!({ "type": "screen_signal", "from": user.session_id, "data": data }));
                }
            }
            "voice_endpoint" => {
                let Some(channel) = my_voice else { return };
                if !self.mesh {
                    return;
                }
                let public = msg["public"].as_str().filter(|p| ENDPOINT.is_match(p)).map(str::to_string);
                let local: Vec<String> = msg["local"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).filter(|x| ENDPOINT.is_match(x)).take(MAX_LOCAL_ENDPOINTS).map(str::to_string).collect()).unwrap_or_default();
                self.conns.get_mut(&conn).expect("joined").endpoint = Some((public.clone(), local.clone()));
                let peer = json!({ "session_id": user.session_id, "public": public, "local": local });
                for other in self.voice_members(channel) {
                    if other != conn {
                        self.send(other, &json!({ "type": "voice_peer", "peer": peer }));
                    }
                }
            }
            "set_state" => {
                let (muted, deafened) = (truthy(&msg["muted"]), truthy(&msg["deafened"]));
                self.update_user(conn, |u| {
                    u.muted = muted;
                    u.deafened = deafened;
                });
            }
            "send_chat" => self.send_chat(conn, msg, &user, &key, my_rank),
            "edit_message" => {
                let channel = int(&msg["channel"]);
                let id = int(&msg["id"]);
                let new_text = self.allow_pings(text(&msg["text"]).trim(), my_rank);
                if new_text.is_empty() || chars(&new_text) > MAX_CHAT_LEN {
                    return self.error(conn, &format!("Messages must be 1–{MAX_CHAT_LEN} characters."));
                }
                let Some(m) = self.message(channel, id) else { return self.error(conn, "That message no longer exists.") };
                if m.author_key != key {
                    return self.error(conn, "You can only edit your own messages.");
                }
                if let Some(held) = self.automod_says(conn, &new_text, my_rank, false) {
                    return self.error(conn, &held);
                }
                let at = now_ms() as i64;
                self.exec("UPDATE messages SET text = ?, edited_at = ? WHERE id = ?", params![new_text, at, id]);
                self.broadcast_channel(channel, &json!({ "type": "message_edited", "channel": channel, "id": id, "text": new_text, "edited_at": at }), None);
            }
            "react" => {
                if self.timed_out(conn) {
                    return self.error(conn, "You're timed out, so you can't react right now.");
                }
                let channel = int(&msg["channel"]);
                let id = int(&msg["id"]);
                let emoji = text(&msg["emoji"]);
                let vote = emoji.strip_prefix("poll:").filter(|d| d.len() == 1 && d.as_bytes()[0].is_ascii_digit()).map(|d| (d.as_bytes()[0] - b'0') as usize);
                if vote.is_none() && !valid_emoji(&emoji) {
                    return self.error(conn, "That isn't an emoji.");
                }
                let Some(m) = self.message(channel, id) else { return self.error(conn, "That message no longer exists.") };
                let mut reactions = m.reactions.clone();
                let on = truthy(&msg["on"]);
                if let Some(vote) = vote {
                    // A vote in a poll: an answer it has, while it's open; one answer unless it allows more.
                    let Some(poll) = parse_poll(&m.text).filter(|p| vote < p.answers) else { return self.error(conn, "That isn't an answer in this poll.") };
                    if now_ms() as f64 > poll.end {
                        return self.error(conn, "This poll has closed.");
                    }
                    if on && !poll.multi {
                        for r in reactions.iter_mut().filter(|r| r.emoji.starts_with("poll:") && r.emoji != emoji) {
                            r.keys.retain(|k| *k != key);
                        }
                        reactions.retain(|r| !r.keys.is_empty() || r.emoji == emoji);
                    }
                }
                match reactions.iter().position(|r| r.emoji == emoji) {
                    Some(i) => {
                        reactions[i].keys.retain(|k| *k != key);
                        if on {
                            reactions[i].keys.push(key.clone());
                        } else if reactions[i].keys.is_empty() {
                            reactions.remove(i);
                        }
                    }
                    None if on => {
                        if reactions.len() >= MAX_REACTIONS {
                            return self.error(conn, "That message has too many different reactions.");
                        }
                        reactions.push(Reaction { emoji: emoji.clone(), keys: vec![key.clone()] });
                    }
                    None => {}
                }
                let stored = (!reactions.is_empty()).then(|| serde_json::to_string(&reactions).unwrap_or_default());
                self.exec("UPDATE messages SET reactions = ? WHERE id = ?", params![stored, id]);
                self.broadcast_channel(channel, &json!({ "type": "reactions", "channel": channel, "id": id, "reactions": reactions }), None);
            }
            "pin" => {
                if !allowed(self, Rank::Mod) {
                    return;
                }
                let channel = int(&msg["channel"]);
                let id = int(&msg["id"]);
                if self.message(channel, id).is_none() {
                    return self.error(conn, "That message no longer exists.");
                }
                let on = truthy(&msg["on"]);
                self.exec("UPDATE messages SET pinned = ? WHERE id = ?", params![on.then_some(1), id]);
                self.broadcast_channel(channel, &json!({ "type": "pinned", "channel": channel, "id": id, "on": on }), None);
            }
            "get_pins" => {
                let channel = int(&msg["channel"]);
                let messages = self.messages("SELECT * FROM messages WHERE channel = ? AND pinned = 1 ORDER BY id DESC LIMIT 50", [channel]);
                self.send(conn, &json!({ "type": "pins", "channel": channel, "messages": messages }));
            }
            "search" => self.search(conn, msg, &key),
            "load_older" => {
                let channel = int(&msg["channel"]);
                let mut messages = self.history(channel, int(&msg["before"]), OLDER_PAGE + 1);
                let done = messages.len() as i64 <= OLDER_PAGE;
                if !done {
                    messages.remove(0);
                }
                self.send(conn, &json!({ "type": "older_history", "channel": channel, "messages": messages, "done": done }));
            }
            "leave_server" => {
                if owner {
                    return self.error(conn, "You own this server, so you can't leave it.");
                }
                // Gone for real, roles too: coming back with an invite starts fresh, as after a kick.
                for table in ["accounts", "member_roles", "notified", "member_status", "event_rsvp"] {
                    self.exec(&format!("DELETE FROM {table} WHERE key = ?"), [&key]);
                }
                for id in self.conns_of(&key) {
                    self.send(id, &json!({ "type": "left" }));
                    let sid = self.user_of(id).session_id;
                    self.hang_up(id);
                    self.broadcast(&json!({ "type": "user_left", "session_id": sid }), Some(id));
                }
                let msg = json!({ "type": "members", "members": self.member_list() });
                for id in self.members() {
                    self.send(id, &msg);
                }
            }
            "delete_message" => {
                let channel = int(&msg["channel"]);
                let id = int(&msg["id"]);
                let author: Option<String> = self.db.query_row("SELECT author_key FROM messages WHERE channel = ? AND id = ?", params![channel, id], |r| r.get(0)).optional().ok().flatten();
                let Some(author) = author else { return self.error(conn, "That message no longer exists.") };
                if author != key && (my_rank < Rank::Mod || (!owner && rank(self.role_of(&author)) >= my_rank)) {
                    return self.error(conn, "You can only delete your own messages.");
                }
                if author != key {
                    let name: Option<String> = self.db.query_row("SELECT name FROM accounts WHERE key = ?", [&author], |r| r.get(0)).optional().ok().flatten();
                    self.audit(&user.name, "delete_message", Some(name.as_deref().unwrap_or("someone")), None);
                }
                self.drop_picture(id);
                self.exec("DELETE FROM messages WHERE id = ?", [id]);
                self.broadcast_channel(channel, &json!({ "type": "message_deleted", "channel": channel, "id": id }), None);
            }
            "typing" => {
                let now = now_ms();
                let c = self.conns.get_mut(&conn).expect("joined");
                if now.saturating_sub(c.last_typing) < TYPING_INTERVAL_MS {
                    return;
                }
                c.last_typing = now;
                let channel = int(&msg["channel"]);
                self.broadcast_channel(channel, &json!({ "type": "typing", "channel": channel, "session_id": user.session_id }), Some(conn));
            }
            "create_channel" => {
                if !allowed(self, Rank::Admin) {
                    return;
                }
                let kind = if msg["kind"] == "voice" { "voice" } else { "text" };
                let name = normalize_channel_name(&text(&msg["name"]), kind);
                if name.is_empty() || chars(&name) > MAX_NAME_LEN {
                    return self.error(conn, &format!("Channel names must be 1–{MAX_NAME_LEN} characters."));
                }
                if self.channels().iter().filter(|c| c.parent.is_none()).count() >= MAX_CHANNELS {
                    return self.error(conn, &format!("A server can have at most {MAX_CHANNELS} channels."));
                }
                self.exec("INSERT INTO channels (name, kind) VALUES (?, ?)", [&name, kind]);
                self.audit(&user.name, "create_channel", Some(&name), None);
                self.channels_changed(false);
            }
            "create_thread" => {
                if self.timed_out(conn) {
                    return self.error(conn, "You're timed out, so you can't start a thread right now.");
                }
                let parent = self.channel(int(&msg["channel"]));
                let Some(parent) = parent.filter(|p| p.kind == "text" && p.parent.is_none() && self.can_see(&key, Some(p))) else {
                    return self.error(conn, "Threads start in a text channel.");
                };
                let from_id = if msg["message"].is_null() { None } else { Some(int(&msg["message"])) };
                let from = from_id.and_then(|id| self.message(parent.id, id));
                if from_id.is_some() && from.is_none() {
                    return self.error(conn, "That message no longer exists.");
                }
                // One thread per message: asking again just leads to it.
                if let Some(f) = &from {
                    if self.channels().iter().any(|c| c.parent == Some(parent.id) && c.starter == Some(f.id as i64)) {
                        return self.channels_changed(false);
                    }
                }
                let given = text(&msg["name"]).split_whitespace().collect::<Vec<_>>().join(" ").chars().take(100).collect::<String>();
                let name = if !given.is_empty() {
                    given
                } else {
                    from.as_ref().map(|f| plain_text(&f.text).split_whitespace().collect::<Vec<_>>().join(" ").chars().take(40).collect::<String>()).unwrap_or_default()
                };
                if name.is_empty() {
                    return self.error(conn, "Give the thread a name.");
                }
                let mut threads: Vec<Ch> = self.channels().into_iter().filter(|c| c.parent.is_some()).collect();
                if threads.len() >= MAX_THREADS {
                    threads.sort_by_key(|c| c.last_at.unwrap_or(0));
                    let quietest = threads[0].id;
                    self.drop_channel(quietest);
                }
                self.exec("INSERT INTO channels (name, kind, parent, starter, creator) VALUES (?, 'text', ?, ?, ?)", params![name, parent.id, from.map(|f| f.id as i64), key]);
                self.channels_changed(false);
            }
            "update_channel" => self.update_channel(conn, msg, &user, my_rank),
            "reorder_channels" => {
                if !allowed(self, Rank::Admin) {
                    return;
                }
                let order: Vec<i64> = msg["order"].as_array().map(|a| a.iter().map(int).collect()).unwrap_or_default();
                let mut ids: Vec<i64> = self.channels().iter().map(|c| c.id).collect();
                let mut sorted = order.clone();
                sorted.sort_unstable();
                ids.sort_unstable();
                if sorted != ids {
                    return self.error(conn, "The channels changed meanwhile. Try again.");
                }
                for (i, id) in order.iter().enumerate() {
                    self.exec("UPDATE channels SET position = ? WHERE id = ?", params![i as i64, id]);
                }
                self.channels_changed(false);
            }
            "delete_channel" => {
                let id = int(&msg["channel"]);
                let target = self.channel(id);
                // A thread: moderators, or whoever started it; a channel: admins.
                let thread_ok = target.as_ref().is_some_and(|t| t.parent.is_some() && (my_rank >= Rank::Mod || t.creator.as_deref() == Some(key.as_str())));
                if !thread_ok && !allowed(self, Rank::Admin) {
                    return;
                }
                let Some(target) = target else { return self.error(conn, "That channel doesn't exist.") };
                for t in self.channels().into_iter().filter(|c| c.parent == Some(id)) {
                    self.drop_channel(t.id);
                }
                self.audit(&user.name, "delete_channel", Some(&target.name), None);
                self.drop_channel(id);
                for m in self.members() {
                    if self.conns[&m].user.as_ref().and_then(|u| u.voice_channel).map(i64::from) == Some(id) {
                        self.update_user(m, |u| u.voice_channel = None);
                    }
                }
                self.channels_changed(false);
            }
            "kick" | "ban" => self.remove_member(conn, msg, &user, &key, my_rank, t == "ban"),
            "set_nickname" => {
                let target = text(&msg["public_key"]);
                let nick = if msg["nick"].is_null() { String::new() } else { text(&msg["nick"]).trim().to_string() };
                if chars(&nick) > 32 {
                    return self.error(conn, "Nicknames are up to 32 characters.");
                }
                let row: Option<(String, Option<String>)> = self.db.query_row("SELECT name, nick FROM accounts WHERE key = ?", [&target], |r| Ok((r.get(0)?, r.get(1)?))).optional().ok().flatten();
                let Some((name, old_nick)) = row else { return self.error(conn, "They're not a member of this server anymore.") };
                let own = target == key;
                if !own {
                    if !allowed(self, Rank::Mod) {
                        return;
                    }
                    if rank(self.role_of(&target)) >= my_rank {
                        return self.error(conn, "You can't change the nickname of someone with the same role as you or higher.");
                    }
                }
                self.exec("UPDATE accounts SET nick = ? WHERE key = ?", params![(!nick.is_empty()).then_some(&nick), target]);
                let shown = if nick.is_empty() { name.clone() } else { nick.clone() };
                if !own {
                    let detail = if nick.is_empty() { "reset".to_string() } else { format!("to {nick}") };
                    self.audit(&user.name, "nickname", Some(old_nick.as_deref().unwrap_or(&name)), Some(&detail));
                }
                for id in self.conns_of(&target) {
                    self.conns.get_mut(&id).expect("joined").name = shown.clone();
                    let shown = shown.clone();
                    self.update_user(id, |u| u.name = shown);
                }
            }
            "timeout" => {
                if !allowed(self, Rank::Mod) {
                    return;
                }
                let target = int(&msg["session_id"]);
                let Some(tconn) = self.members().into_iter().find(|id| self.conns[id].user.as_ref().is_some_and(|u| i64::from(u.session_id) == target)) else {
                    return self.error(conn, "That person isn't connected anymore.");
                };
                if target == i64::from(user.session_id) {
                    return self.error(conn, "You can't time yourself out.");
                }
                let tkey = self.key_of(tconn);
                let tname = self.user_of(tconn).name;
                if rank(self.role_of(&tkey)) >= my_rank {
                    return self.error(conn, "You can't time out someone with the same role as you or higher.");
                }
                let minutes = num(&msg["minutes"]).filter(|m| m.is_finite()).map(|m| m.floor() as i64).unwrap_or(0).clamp(0, 10080);
                let until = if minutes > 0 { now_ms() as i64 + minutes * 60_000 } else { 0 };
                if until > 0 {
                    self.exec("INSERT INTO timeouts (key, until) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET until = excluded.until", params![tkey, until]);
                } else {
                    self.exec("DELETE FROM timeouts WHERE key = ?", [&tkey]);
                }
                // Every device of theirs: marked, and out of voice.
                for id in self.conns_of(&tkey) {
                    if until > 0 {
                        self.conns.get_mut(&id).expect("joined").endpoint = None;
                    }
                    self.update_user(id, |u| {
                        if until > 0 {
                            u.timed_out_until = Some(until as u64);
                            u.voice_channel = None;
                            u.sharing = false;
                        } else {
                            u.timed_out_until = None;
                        }
                    });
                }
                let detail = (until > 0).then(|| duration_text(minutes));
                self.audit(&user.name, if until > 0 { "timeout" } else { "untimeout" }, Some(&tname), detail.as_deref());
            }
            "resync" => {
                for ch in self.channels_for(&key) {
                    self.send(conn, &json!({ "type": "chat_history", "channel": ch.id, "messages": self.history(ch.id, i64::MAX, CHAT_HISTORY) }));
                }
            }
            "get_audit_log" => {
                if !allowed(self, Rank::Admin) {
                    return;
                }
                let entries: Vec<Value> = self
                    .db
                    .prepare_cached("SELECT at, actor, action, target, detail FROM audit ORDER BY id DESC LIMIT 200")
                    .and_then(|mut s| {
                        s.query_map([], |r| {
                            Ok(json!({ "at": r.get::<_, i64>(0)?, "actor": r.get::<_, String>(1)?, "action": r.get::<_, String>(2)?, "target": r.get::<_, Option<String>>(3)?, "detail": r.get::<_, Option<String>>(4)? }))
                        })
                        .map(|rows| rows.flatten().collect())
                    })
                    .unwrap_or_default();
                self.send(conn, &json!({ "type": "audit_log", "entries": entries }));
            }
            "unban" => {
                if !allowed(self, Rank::Admin) {
                    return;
                }
                let target = text(&msg["public_key"]);
                let name: Option<String> = self.db.query_row("SELECT name FROM bans WHERE key = ?", [&target], |r| r.get(0)).optional().ok().flatten();
                self.audit(&user.name, "unban", Some(name.as_deref().unwrap_or("someone")), None);
                self.exec("DELETE FROM bans WHERE key = ?", [&target]);
                self.send(conn, &json!({ "type": "bans", "bans": self.bans() }));
            }
            "create_invite" => {
                if !allowed(self, Rank::Admin) {
                    return;
                }
                let now = now_ms() as i64;
                let hours = if msg["expires_in_hours"].is_null() { None } else { Some(num(&msg["expires_in_hours"]).unwrap_or(1.0).max(1.0)) };
                let max_uses = if msg["max_uses"].is_null() { None } else { Some(num(&msg["max_uses"]).unwrap_or(1.0).max(1.0) as i64) };
                let expires_at = hours.map(|h| now + (h * 3_600_000.0) as i64);
                let mut code = new_code();
                while self.exists("SELECT 1 FROM invites WHERE code = ?", [&code]) {
                    code = new_code();
                }
                self.exec("INSERT INTO invites (code, created_at, expires_at, max_uses, uses, inviter) VALUES (?, ?, ?, ?, 0, ?)", params![code, now, expires_at, max_uses, user.name]);
                self.send(conn, &json!({ "type": "invite_created", "invite": { "code": code, "created_at": now, "expires_at": expires_at, "max_uses": max_uses, "uses": 0 } }));
                self.send(conn, &json!({ "type": "invites", "invites": self.invites() }));
            }
            "delete_server" => {
                if !owner {
                    return self.error(conn, "Only the server owner can do that.");
                }
                // Everyone connected is told, then let go.
                let all: Vec<ConnId> = self.conns.keys().copied().collect();
                for id in all {
                    self.send(id, &json!({ "type": "server_deleted" }));
                    self.hang_up(id);
                }
                // Without a name the server no longer exists: nobody can join it again.
                for table in ["messages", "channels", "accounts", "invites", "bans", "notified", "images", "meta", "roles", "member_roles", "member_status", "emojis", "timeouts", "audit", "events", "event_rsvp"] {
                    self.exec(&format!("DELETE FROM {table}"), []);
                }
            }
            "revoke_invite" => {
                if !allowed(self, Rank::Admin) {
                    return;
                }
                self.exec("DELETE FROM invites WHERE code = ?", [text(&msg["code"])]);
                self.send(conn, &json!({ "type": "invites", "invites": self.invites() }));
            }
            "update_server" => {
                if !allowed(self, Rank::Admin) {
                    return;
                }
                let name = text(&msg["name"]).trim().to_string();
                let icon = if msg["icon"].is_null() { None } else { Some(text(&msg["icon"])) };
                if name.is_empty() || chars(&name) > MAX_SERVER_NAME_LEN {
                    return self.error(conn, &format!("Server names must be 1–{MAX_SERVER_NAME_LEN} characters."));
                }
                if icon.as_deref().is_some_and(|i| !valid_icon(i)) {
                    return self.error(conn, "That picture can't be used. Try a PNG or JPEG image.");
                }
                self.set_meta("name", &name);
                match &icon {
                    None => self.exec("DELETE FROM meta WHERE key = 'icon'", []),
                    Some(i) => self.set_meta("icon", i),
                }
                if !msg["pictures_off"].is_null() {
                    self.set_meta("pictures_off", if truthy(&msg["pictures_off"]) { "1" } else { "0" });
                }
                self.broadcast(&json!({ "type": "server_updated", "name": name, "icon": icon, "pictures_off": self.meta("pictures_off").as_deref() == Some("1") }), None);
            }
            "watch_set" => {
                // Watching a YouTube video together, in the voice channel you're in.
                let Some(channel) = user.voice_channel else { return self.error(conn, "Join a voice channel to watch together.") };
                if self.timed_out(conn) {
                    return self.error(conn, "You're timed out, so you can't do that right now.");
                }
                let video = if msg["video"].is_null() { None } else { Some(text(&msg["video"])) };
                if let Some(v) = &video {
                    if v.len() != 11 || !v.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
                        return self.error(conn, "That isn't a YouTube video.");
                    }
                }
                let position = num(&msg["position"]).filter(|x| x.is_finite()).unwrap_or(0.0).clamp(0.0, 864_000.0);
                let watch = json!({ "video": video, "position": position, "playing": truthy(&msg["playing"]), "at": now_ms(), "by": user.name });
                let meta_key = format!("watch:{channel}");
                if video.is_none() {
                    self.exec("DELETE FROM meta WHERE key = ?", [&meta_key]);
                } else {
                    self.set_meta(&meta_key, &watch.to_string());
                }
                let mut out = watch;
                out["type"] = json!("watch");
                out["channel"] = json!(channel);
                out["at_ago"] = json!(0);
                for id in self.voice_members(channel as i64) {
                    self.send(id, &out);
                }
            }
            "get_events" => {
                let events = self.events_for(&key);
                self.send(conn, &json!({ "type": "events", "events": events }));
            }
            "create_event" => {
                if self.timed_out(conn) {
                    return self.error(conn, "You're timed out, so you can't plan events right now.");
                }
                let name = text(&msg["name"]).split_whitespace().collect::<Vec<_>>().join(" ");
                let description = text(&msg["description"]).trim().to_string();
                let ch = self.channel(int(&msg["channel"]));
                let starts_at = num(&msg["starts_at"]).filter(|x| x.is_finite()).map(|x| x as i64).unwrap_or(-1);
                let now = now_ms() as i64;
                if name.is_empty() || chars(&name) > 80 {
                    return self.error(conn, "Give the event a name (up to 80 characters).");
                }
                if chars(&description) > 500 {
                    return self.error(conn, "Keep the description under 500 characters.");
                }
                let Some(ch) = ch.filter(|c| c.parent.is_none() && self.can_see(&key, Some(c))) else { return self.error(conn, "Pick a channel for the event.") };
                if starts_at < now - 60_000 || starts_at > now + EVENT_AHEAD_MS {
                    return self.error(conn, "Pick a time from now up to 60 days ahead.");
                }
                self.prune_events();
                let count: i64 = self.db.query_row("SELECT count(*) FROM events", [], |r| r.get(0)).unwrap_or(0);
                if count >= MAX_EVENTS {
                    return self.error(conn, &format!("A server can plan up to {MAX_EVENTS} events at once."));
                }
                self.exec("INSERT INTO events (name, description, channel, starts_at, creator, creator_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", params![name, description, ch.id, starts_at, key, user.name, now]);
                let id = self.db.last_insert_rowid();
                // Whoever plans it is going.
                self.exec("INSERT INTO event_rsvp (event, key, answer) VALUES (?, ?, 'yes')", params![id, key]);
                self.send(conn, &json!({ "type": "event_created", "id": id }));
                self.events_changed();
            }
            "delete_event" => {
                let id = int(&msg["id"]);
                let ev: Option<(String, String)> = self.db.query_row("SELECT creator, name FROM events WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional().ok().flatten();
                let Some((creator, name)) = ev else { return self.events_changed() };
                if creator != key && my_rank < Rank::Mod {
                    return self.error(conn, "Only whoever planned it, and moderators, can cancel an event.");
                }
                self.exec("DELETE FROM event_rsvp WHERE event = ?", [id]);
                self.exec("DELETE FROM events WHERE id = ?", [id]);
                if creator != key {
                    self.audit(&user.name, "cancel_event", Some(&name), None);
                }
                self.events_changed();
            }
            "rsvp" => {
                let id = int(&msg["id"]);
                let channel: Option<i64> = self.db.query_row("SELECT channel FROM events WHERE id = ?", [id], |r| r.get(0)).optional().ok().flatten();
                let visible = channel.is_some_and(|c| self.can_see(&key, self.channel(c).as_ref()));
                if !visible {
                    return self.error(conn, "That event is gone.");
                }
                let answer = text(&msg["answer"]);
                if answer == "yes" || answer == "maybe" {
                    self.exec("INSERT INTO event_rsvp (event, key, answer) VALUES (?, ?, ?) ON CONFLICT(event, key) DO UPDATE SET answer = excluded.answer", params![id, key, answer]);
                } else {
                    self.exec("DELETE FROM event_rsvp WHERE event = ? AND key = ?", params![id, key]);
                }
                self.events_changed();
            }
            "get_automod" => {
                if !allowed(self, Rank::Admin) {
                    return;
                }
                let (words, limit, repeats) = self.automod();
                let paused = self.meta("invites_paused").as_deref() == Some("1");
                self.send(conn, &json!({ "type": "automod", "words": words, "mention_limit": limit, "block_repeats": repeats, "invites_paused": paused }));
            }
            "set_automod" => {
                if !allowed(self, Rank::Admin) {
                    return;
                }
                let mut words: Vec<String> = Vec::new();
                for w in msg["words"].as_array().cloned().unwrap_or_default() {
                    let w = text(&w).trim().to_lowercase();
                    if !w.is_empty() && chars(&w) <= AUTOMOD_WORD_LEN && !words.contains(&w) && words.len() < AUTOMOD_WORDS {
                        words.push(w);
                    }
                }
                let limit = num(&msg["mention_limit"]).filter(|x| x.is_finite()).map(|x| x.floor() as i64).unwrap_or(0).clamp(0, 50);
                let repeats = truthy(&msg["block_repeats"]);
                self.set_meta("automod", &json!({ "words": words, "mention_limit": limit, "block_repeats": repeats }).to_string());
                let paused = truthy(&msg["invites_paused"]);
                if paused != (self.meta("invites_paused").as_deref() == Some("1")) {
                    self.audit(&user.name, if paused { "pause_invites" } else { "resume_invites" }, None, None);
                }
                self.set_meta("invites_paused", if paused { "1" } else { "0" });
                let detail = format!("{} words{}{}", words.len(), if limit > 0 { format!(", {limit} mentions") } else { String::new() }, if repeats { ", repeats" } else { "" });
                self.audit(&user.name, "automod", None, Some(&detail));
                self.send(conn, &json!({ "type": "automod", "words": words, "mention_limit": limit, "block_repeats": repeats, "invites_paused": paused }));
            }
            "get_server_settings" => {
                if !allowed(self, Rank::Admin) {
                    return;
                }
                self.send(conn, &json!({ "type": "invites", "invites": self.invites() }));
                self.send(conn, &json!({ "type": "members", "members": self.member_list() }));
                self.send(conn, &json!({ "type": "bans", "bans": self.bans() }));
            }
            "get_members" => self.send(conn, &json!({ "type": "members", "members": self.member_list() })),
            "set_role" => {
                if !allowed(self, Rank::Admin) {
                    return;
                }
                let target_key = text(&msg["public_key"]);
                let role = msg["role"].as_str().filter(|r| *r == "admin" || *r == "mod");
                if !msg["role"].is_null() && role.is_none() {
                    return self.error(conn, "Unknown role.");
                }
                if target_key == key {
                    return self.error(conn, "You can't change your own role.");
                }
                let Some(target) = self.member_list().into_iter().find(|m| m["public_key"] == target_key.as_str()) else {
                    return self.error(conn, "They're not a member of this server anymore.");
                };
                if target["role"] == "owner" {
                    return self.error(conn, "The owner's role can't be changed.");
                }
                // Admins handle moderators; only the owner names or removes admins.
                if !owner && (role == Some("admin") || rank(target["role"].as_str()) >= my_rank) {
                    return self.error(conn, "Only the owner can name or remove admins.");
                }
                self.exec("UPDATE accounts SET role = ? WHERE key = ?", params![role, target_key]);
                self.roles_changed();
                self.audit(&user.name, "role", target["name"].as_str(), Some(role.unwrap_or("member")));
            }
            "transfer_ownership" => {
                if !owner {
                    return self.error(conn, "Only the server owner can do that.");
                }
                let target_key = text(&msg["public_key"]);
                if target_key == key {
                    return self.error(conn, "You already own this server.");
                }
                let Some(target) = self.member_list().into_iter().find(|m| m["public_key"] == target_key.as_str()) else {
                    return self.error(conn, "They're not a member of this server anymore.");
                };
                if self.exists("SELECT 1 FROM bans WHERE key = ?", [&target_key]) {
                    return self.error(conn, "That person is banned.");
                }
                self.set_meta("owner", &target_key);
                // The old owner stays on as an admin.
                self.exec("UPDATE accounts SET role = 'admin' WHERE key = ?", [&key]);
                self.exec("UPDATE accounts SET role = NULL WHERE key = ?", [&target_key]);
                // The new owner first, then everyone else (the old owner, now an admin).
                for id in self.conns_of(&target_key) {
                    self.update_user(id, |u| {
                        u.owner = true;
                        u.role = Some("owner".into());
                    });
                }
                self.roles_changed();
                self.audit(&user.name, "transfer", target["name"].as_str(), None);
            }
            "ping" => self.send(conn, &json!({ "type": "pong" })),
            "set_loopback" => {
                // Hearing yourself back belongs to the server's own voice relay.
                if !self.mesh {
                    self.conns.get_mut(&conn).expect("joined").loopback = truthy(&msg["enabled"]);
                }
            }
            // ---------- only on servers on someone's computer (the app talks to Hopp Cloud over HTTP for these) ----------
            "upload_image" => {
                let req = msg["req"].clone();
                let data = base64::engine::general_purpose::STANDARD.decode(text(&msg["data"])).unwrap_or_default();
                match self.upload_image(&key, &text(&msg["kind"]), &data) {
                    Ok(id) => self.send(conn, &json!({ "type": "image_uploaded", "req": req, "id": id })),
                    Err((_, error)) => self.send(conn, &json!({ "type": "image_uploaded", "req": req, "error": error })),
                }
            }
            "get_image" => {
                let id = text(&msg["id"]);
                match self.image(&id) {
                    Some((kind, data)) => self.send(conn, &json!({ "type": "image", "id": id, "kind": kind, "data": base64::engine::general_purpose::STANDARD.encode(data) })),
                    None => self.send(conn, &json!({ "type": "image", "id": id })),
                }
            }
            "set_status" => {
                let status = text(&msg["status"]);
                if MEMBER_STATUSES.contains(&status.as_str()) && status != "offline" {
                    self.conns.get_mut(&conn).expect("joined").status = Some(status);
                    self.presence(&key, true);
                }
            }
            _ => self.error(conn, &format!("Unknown message type \"{t}\".")),
        }
    }

    fn send_chat(&mut self, conn: ConnId, msg: &Value, user: &User, key: &str, my_rank: Rank) {
        let ch = self.channel(int(&msg["channel"]));
        let body = self.allow_pings(text(&msg["text"]).trim(), my_rank);
        // Voice channels have a chat too, for the people in them.
        let Some(ch) = ch.filter(|c| c.kind == "text" || c.kind == "voice") else { return self.error(conn, "That channel doesn't exist.") };
        if body.is_empty() || chars(&body) > MAX_CHAT_LEN {
            return self.error(conn, &format!("Messages must be 1–{MAX_CHAT_LEN} characters."));
        }
        let now = now_ms();
        if self.timed_out(conn) {
            return self.error(conn, "You're timed out, so you can't write right now.");
        }
        if let Some(held) = self.automod_says(conn, &body, my_rank, true) {
            return self.error(conn, &held);
        }
        // Slowmode: a pause between each person's messages here (moderators are free).
        let slow = ch.slowmode.unwrap_or(0);
        if slow > 0 && my_rank < Rank::Mod {
            let last = self.conns[&conn].last_sent.get(&ch.id).copied().unwrap_or(0);
            let wait = ((last + slow as u64 * 1000) as i64 - now as i64 + 999).div_euclid(1000);
            if wait > 0 {
                return self.error(conn, &format!("Slowmode is on here. Wait {wait} s."));
            }
            self.conns.get_mut(&conn).expect("joined").last_sent.insert(ch.id, now);
        }
        {
            let c = self.conns.get_mut(&conn).expect("joined");
            c.tokens = (c.tokens + now.saturating_sub(c.refilled) as f64 / 1000.0 * CHAT_PER_SECOND).min(CHAT_BURST);
            c.refilled = now;
            if c.tokens < 1.0 {
                return self.error(conn, "You're sending messages too fast. Slow down a little.");
            }
            c.tokens -= 1.0;
        }
        let picture = IMAGE_TOKEN.captures(&body).map(|c| c[1].to_string());
        if let Some(p) = &picture {
            if self.meta("pictures_off").as_deref() == Some("1") || ch.no_pictures {
                self.exec("DELETE FROM images WHERE id = ?", [p]);
                return self.error(conn, "Pictures are turned off here.");
            }
        }
        if let Some(stored) = stored_id(&body) {
            if !self.exists("SELECT 1 FROM images WHERE id = ? AND uploader = ?", [&stored, key]) {
                return self.error(conn, if picture.is_some() { "That picture didn't upload. Try again." } else { "That voice message didn't upload. Try again." });
            }
            self.exec("UPDATE images SET used = 1 WHERE id = ?", [&stored]);
        }
        let answered = if msg["reply_to"].is_null() { None } else { self.message(ch.id, int(&msg["reply_to"])) };
        let reply = answered.map(|a| Reply { id: a.id, sender_name: a.sender_name, author_key: a.author_key, text: reply_preview(&a.text) });
        let id: i64 = self
            .db
            .query_row(
                "INSERT INTO messages (channel, sender, sender_name, author_key, text, sent_at, reply_id, reply_name, reply_key, reply_text)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
                params![
                    ch.id,
                    user.session_id,
                    user.name,
                    key,
                    body,
                    now as i64,
                    reply.as_ref().map(|r| r.id as i64),
                    reply.as_ref().map(|r| r.sender_name.clone()),
                    reply.as_ref().map(|r| r.author_key.clone()),
                    reply.as_ref().map(|r| r.text.clone())
                ],
                |r| r.get(0),
            )
            .unwrap_or(0);
        // The oldest make room; a picture among them goes too.
        let trimmed = self.strings(
            "DELETE FROM messages WHERE channel = ? AND id <= (SELECT id FROM messages WHERE channel = ? ORDER BY id DESC LIMIT 1 OFFSET ?) RETURNING text",
            params![ch.id, ch.id, CHAT_KEEP],
        );
        for old in trimmed {
            if let Some(gone) = stored_id(&old) {
                self.exec("DELETE FROM images WHERE id = ?", [gone]);
            }
        }
        let message = ChatMessage {
            id: id as u64,
            channel: ch.id as u32,
            sender: user.session_id,
            sender_name: user.name.clone(),
            author_key: key.to_string(),
            text: body,
            sent_at: now,
            reply,
            edited_at: None,
            reactions: vec![],
            pinned: false,
        };
        self.broadcast_channel(ch.id, &json!({ "type": "chat", "message": message }), None);
    }

    fn search(&mut self, conn: ConnId, msg: &Value, key: &str) {
        let query = text(&msg["query"]);
        let needle = query.trim().to_string();
        let now = now_ms();
        let c = self.conns.get_mut(&conn).expect("joined");
        if now.saturating_sub(c.searched_at) < SEARCH_GAP_MS {
            return self.error(conn, "Searching too fast. Try again in a moment.");
        }
        c.searched_at = now;
        let none = |core: &Core| core.send(conn, &json!({ "type": "search_results", "query": query, "messages": [] }));
        if needle.encode_utf16().count() > 200 {
            return none(self);
        }
        let f = parse_search(&needle);
        let filtered = !f.from.is_empty() || !f.in_.is_empty() || !f.has.is_empty();
        let words_len = f.words.encode_utf16().count();
        if (!filtered && words_len < 2) || words_len > 100 {
            return none(self);
        }
        let mut mine = self.channels_for(key);
        if !f.in_.is_empty() {
            mine.retain(|c| f.in_.contains(&c.name.to_lowercase()));
        }
        if mine.is_empty() {
            return none(self);
        }
        let mut wheres = vec![format!("channel IN ({})", vec!["?"; mine.len()].join(","))];
        let mut args: Vec<rusqlite::types::Value> = mine.iter().map(|c| c.id.into()).collect();
        if !f.words.is_empty() {
            wheres.push("text LIKE ? ESCAPE '\\'".into());
            let escaped: String = f.words.chars().flat_map(|c| if matches!(c, '\\' | '%' | '_') { vec!['\\', c] } else { vec![c] }).collect();
            args.push(format!("%{escaped}%").into());
        }
        if !f.from.is_empty() {
            let marks = vec!["?"; f.from.len()].join(",");
            wheres.push(format!("(author_key IN (SELECT key FROM accounts WHERE lower(name) IN ({marks}) OR lower(coalesce(nick, '')) IN ({marks})) OR lower(sender_name) IN ({marks}))"));
            for _ in 0..3 {
                args.extend(f.from.iter().map(|x| x.clone().into()));
            }
        }
        for has in &f.has {
            match has.as_str() {
                "link" | "links" => wheres.push("(text LIKE '%http://%' OR text LIKE '%https://%')".into()),
                "image" | "images" | "picture" | "pictures" => wheres.push("text LIKE 'hopp-image:%'".into()),
                _ => return none(self),
            }
        }
        args.push(SEARCH_RESULTS.into());
        let sql = format!("SELECT * FROM messages WHERE {} ORDER BY id DESC LIMIT ?", wheres.join(" AND "));
        let messages = self.messages(&sql, params_from_iter(args));
        self.send(conn, &json!({ "type": "search_results", "query": query, "messages": messages }));
    }

    fn update_channel(&mut self, conn: ConnId, msg: &Value, user: &User, my_rank: Rank) {
        if my_rank < Rank::Admin {
            return self.error(conn, "Only admins and the owner can do that.");
        }
        let Some(ch) = self.channel(int(&msg["channel"])) else { return self.error(conn, "That channel doesn't exist.") };
        let name = normalize_channel_name(&text(&msg["name"]), &ch.kind);
        if name.is_empty() || chars(&name) > MAX_NAME_LEN {
            return self.error(conn, &format!("Channel names must be 1–{MAX_NAME_LEN} characters."));
        }
        let topic = text(&msg["topic"]).trim().to_string();
        if chars(&topic) > MAX_TOPIC_LEN {
            return self.error(conn, &format!("Keep the topic under {MAX_TOPIC_LEN} characters."));
        }
        let category = text(&msg["category"]).trim().to_string();
        if chars(&category) > MAX_CATEGORY_LEN {
            return self.error(conn, &format!("Category names are at most {MAX_CATEGORY_LEN} characters."));
        }
        let some = |s: &String| (!s.is_empty()).then(|| s.clone());
        self.exec("UPDATE channels SET name = ?, topic = ?, category = ? WHERE id = ?", params![name, some(&topic), some(&category), ch.id]);
        self.audit(&user.name, "update_channel", Some(&name), None);
        if !msg["no_pictures"].is_null() {
            self.exec("UPDATE channels SET no_pictures = ? WHERE id = ?", params![truthy(&msg["no_pictures"]).then_some(1), ch.id]);
        }
        if ch.kind == "voice" && !msg["user_limit"].is_null() {
            let cap = if self.mesh { MAX_VOICE_PEERS as i64 } else { MAX_RELAY_LIMIT };
            let limit = num(&msg["user_limit"]).filter(|x| x.is_finite()).map(|x| x.floor() as i64).unwrap_or(0).clamp(0, cap);
            self.exec("UPDATE channels SET user_limit = ? WHERE id = ?", params![(limit > 0).then_some(limit), ch.id]);
        }
        let mut changed_people = false;
        if !msg["private_roles"].is_null() {
            let known: HashSet<i64> = self.custom_roles().iter().map(|r| r.id).collect();
            let roles: Vec<i64> = msg["private_roles"].as_array().map(|a| a.iter().map(int).filter(|r| known.contains(r)).collect()).unwrap_or_default();
            let stored = (!roles.is_empty()).then(|| serde_json::to_string(&roles).unwrap_or_default());
            self.exec("UPDATE channels SET private_roles = ? WHERE id = ?", params![stored, ch.id]);
            self.audit(&user.name, "update_channel", Some(&name), Some(if roles.is_empty() { "public" } else { "private" }));
            // Who sees it changed: everyone gets their list, and newcomers its history (once the
            // rest of this change, slowmode too, is saved).
            changed_people = true;
        }
        if !msg["slowmode"].is_null() {
            const STEPS: [i64; 14] = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600];
            let want = num(&msg["slowmode"]).unwrap_or(f64::NAN);
            let seconds = STEPS.iter().copied().fold(0, |best, x| if (x as f64 - want).abs() < (best as f64 - want).abs() { x } else { best });
            self.exec("UPDATE channels SET slowmode = ? WHERE id = ?", params![(seconds > 0).then_some(seconds), ch.id]);
        }
        if ch.kind == "voice" && !msg["afk_after"].is_null() {
            let minutes = num(&msg["afk_after"]).filter(|x| x.is_finite()).map(|x| x.floor() as i64).unwrap_or(0).clamp(0, 240);
            if minutes > 0 {
                self.exec("UPDATE channels SET afk_after = NULL", []);
            }
            self.exec("UPDATE channels SET afk_after = ? WHERE id = ?", params![(minutes > 0).then_some(minutes), ch.id]);
        }
        self.channels_changed(changed_people);
    }

    fn remove_member(&mut self, conn: ConnId, msg: &Value, user: &User, key: &str, my_rank: Rank, banned: bool) {
        let need = if banned { Rank::Admin } else { Rank::Mod };
        if my_rank < need {
            return self.error(conn, if need == Rank::Admin { "Only admins and the owner can do that." } else { "Only moderators, admins and the owner can do that." });
        }
        // Someone who's here (by their session), or a member who isn't right now (by Hopp ID).
        let by_key = msg["public_key"].as_str().filter(|k| k.len() == 64 && k.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))).map(str::to_string);
        let here = match &by_key {
            Some(k) => self.members().into_iter().find(|id| self.conns[id].key == *k),
            None => {
                let sid = int(&msg["session_id"]);
                self.members().into_iter().find(|id| self.conns[id].user.as_ref().is_some_and(|u| i64::from(u.session_id) == sid))
            }
        };
        let target = here.map(|h| self.key_of(h)).or(by_key.clone());
        let row: Option<(String, Option<String>)> =
            target.as_ref().and_then(|k| self.db.query_row("SELECT name, nick FROM accounts WHERE key = ?", [k], |r| Ok((r.get(0)?, r.get(1)?))).optional().ok().flatten());
        let Some(target) = target.filter(|_| here.is_some() || row.is_some()) else {
            return self.error(conn, if by_key.is_some() { "That person isn't a member anymore." } else { "That person isn't connected anymore." });
        };
        if target == key {
            return self.error(conn, "You can't remove yourself.");
        }
        if rank(self.role_of(&target)) >= my_rank {
            return self.error(conn, &format!("You can't {} someone with the same role as you or higher.", if banned { "ban" } else { "kick" }));
        }
        let name = match here {
            Some(h) => self.user_of(h).name,
            None => row.map(|(n, nick)| nick.unwrap_or(n)).unwrap_or_default(),
        };
        let mut removed = 0;
        if banned {
            self.exec("INSERT INTO bans (key, name, banned_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING", params![target, name, now_ms() as i64]);
            self.send(conn, &json!({ "type": "bans", "bans": self.bans() }));
            // Their messages from the last hours go too, if asked.
            let hours = int(&msg["delete_hours"]);
            if [1, 24, 168].contains(&hours) {
                let rows: Vec<(i64, i64)> = self
                    .db
                    .prepare_cached("SELECT id, channel FROM messages WHERE author_key = ? AND sent_at > ? LIMIT 1000")
                    .and_then(|mut s| s.query_map(params![target, now_ms() as i64 - hours * 3_600_000], |r| Ok((r.get(0)?, r.get(1)?))).map(|rows| rows.flatten().collect()))
                    .unwrap_or_default();
                for (id, channel) in &rows {
                    self.drop_picture(*id);
                    self.exec("DELETE FROM messages WHERE id = ?", [id]);
                    self.broadcast_channel(*channel, &json!({ "type": "message_deleted", "channel": channel, "id": id }), None);
                }
                removed = rows.len();
            }
        }
        // Out of the server for real: they're no longer a member, so coming back takes a new invite.
        for table in ["accounts", "member_roles", "notified", "timeouts", "member_status", "event_rsvp"] {
            self.exec(&format!("DELETE FROM {table} WHERE key = ?"), [&target]);
        }
        let detail = (removed > 0).then(|| format!("deleted {removed} messages"));
        self.audit(&user.name, if banned { "ban" } else { "kick" }, Some(&name), detail.as_deref());
        // Every device of theirs goes.
        for id in self.conns_of(&target) {
            self.send(id, &json!({ "type": "kicked", "banned": banned }));
            let sid = self.user_of(id).session_id;
            self.hang_up(id);
            self.broadcast(&json!({ "type": "user_left", "session_id": sid }), None);
        }
        let list = self.member_list();
        let msg = json!({ "type": "members", "members": list });
        for id in self.members() {
            self.send(id, &msg);
        }
    }
}

impl Core {
    /** A channel or thread deleted: its messages go, with their pictures and voice messages. */
    fn drop_channel(&self, id: i64) {
        // "hopp-image:" and "hopp-voice:" are the same length: the stored id follows either.
        self.exec("DELETE FROM images WHERE id IN (SELECT substr(text, 12, 32) FROM messages WHERE channel = ? AND (text LIKE 'hopp-image:%' OR text LIKE 'hopp-voice:%'))", [id]);
        self.exec("DELETE FROM messages WHERE channel = ?", [id]);
        self.exec("DELETE FROM notified WHERE channel = ?", [id]);
        self.exec("DELETE FROM event_rsvp WHERE event IN (SELECT id FROM events WHERE channel = ?)", [id]);
        self.exec("DELETE FROM events WHERE channel = ?", [id]);
        self.exec("DELETE FROM channels WHERE id = ?", [id]);
    }
}

fn create_tables(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS channels (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL,
           position INTEGER, topic TEXT, category TEXT, no_pictures INTEGER, user_limit INTEGER, afk_after INTEGER, slowmode INTEGER,
           private_roles TEXT, parent INTEGER, starter INTEGER, creator TEXT);
         CREATE TABLE IF NOT EXISTS accounts (key TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, role TEXT, nick TEXT);
         CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER, max_uses INTEGER, uses INTEGER NOT NULL, inviter TEXT);
         CREATE TABLE IF NOT EXISTS bans (key TEXT PRIMARY KEY, name TEXT NOT NULL, banned_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS timeouts (key TEXT PRIMARY KEY, until INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL, channel INTEGER NOT NULL, starts_at INTEGER NOT NULL, creator TEXT NOT NULL, creator_name TEXT NOT NULL, created_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS event_rsvp (event INTEGER NOT NULL, key TEXT NOT NULL, answer TEXT NOT NULL, PRIMARY KEY (event, key));
         CREATE TABLE IF NOT EXISTS roles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT, hoist INTEGER, level TEXT, position INTEGER NOT NULL DEFAULT 0, mentionable INTEGER);
         CREATE TABLE IF NOT EXISTS member_roles (key TEXT NOT NULL, role INTEGER NOT NULL, PRIMARY KEY (key, role));
         CREATE TABLE IF NOT EXISTS member_status (key TEXT PRIMARY KEY, status TEXT NOT NULL, at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT);
         CREATE TABLE IF NOT EXISTS messages (
           id INTEGER PRIMARY KEY AUTOINCREMENT, channel INTEGER NOT NULL, sender INTEGER NOT NULL,
           sender_name TEXT NOT NULL, author_key TEXT NOT NULL, text TEXT NOT NULL, sent_at INTEGER NOT NULL,
           pinned INTEGER, reply_id INTEGER, reply_name TEXT, reply_key TEXT, reply_text TEXT, edited_at INTEGER, reactions TEXT);
         CREATE INDEX IF NOT EXISTS messages_by_channel ON messages (channel, id);
         CREATE TABLE IF NOT EXISTS notified (key TEXT NOT NULL, channel INTEGER NOT NULL, PRIMARY KEY (key, channel));
         CREATE TABLE IF NOT EXISTS emojis (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, image TEXT NOT NULL, creator TEXT NOT NULL, created_at INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS images (
           id TEXT PRIMARY KEY, uploader TEXT NOT NULL, type TEXT NOT NULL, data BLOB NOT NULL,
           size INTEGER NOT NULL, created_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);",
    )?;
    // Hopp still has no outbox for accounts here: a server on someone's computer can't reach
    // the cloud's accounts, so news reaches people while their app is connected.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crowd_words_stand_alone() {
        assert_eq!(crowd_words("hi @everyone").len(), 1);
        assert_eq!(crowd_words("@here now").len(), 1);
        assert!(crowd_words("mail@everyone").is_empty());
        assert!(crowd_words("@everyones").is_empty());
        assert!(crowd_words("@@here").is_empty());
    }

    #[test]
    fn search_filters_come_off_the_words() {
        let f = parse_search(r#"from:"Big Sam" in:#general has:link gg wp"#);
        assert_eq!(f.from, vec!["big sam"]);
        assert_eq!(f.in_, vec!["general"]);
        assert_eq!(f.has, vec!["link"]);
        assert_eq!(f.words, "gg wp");
    }

    #[test]
    fn durations_read_naturally() {
        assert_eq!(duration_text(10), "10 minutes");
        assert_eq!(duration_text(60), "1 hour");
        assert_eq!(duration_text(1440), "1 day");
        assert_eq!(duration_text(10080), "1 week");
    }
}
