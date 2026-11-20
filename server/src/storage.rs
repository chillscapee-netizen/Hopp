//! Where a server keeps its data: one SQLite database (server.db) in its folder, laid out like
//! Hopp Cloud's. Servers from before kept plain JSON files; those are read once, moved into the
//! database, and kept aside (renamed `.imported`).

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use strom_shared::{Ban, Channel, ChannelId, ChannelKind, ChatMessage, Invite};

const CONFIG_FILE: &str = "server.json";
const ACCOUNTS_FILE: &str = "accounts.json";
const INVITES_FILE: &str = "invites.json";
const BANS_FILE: &str = "bans.json";
/// Chat files larger than this are rewritten with only their newest messages at startup.
const CHAT_COMPACT_BYTES: u64 = 2 * 1024 * 1024;
const CHAT_COMPACT_KEEP: usize = 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub name: String,
    pub channels: Vec<Channel>,
    pub next_channel_id: ChannelId,
    /// Public key of the owner. The first person to connect claims an unowned server.
    pub owner: Option<String>,
    /// The server picture as a `data:image/...` URL.
    #[serde(default)]
    pub icon: Option<String>,
}

impl ServerConfig {
    pub fn new(name: &str, channels: &[(&str, ChannelKind)]) -> Self {
        let channels: Vec<Channel> = channels
            .iter()
            .enumerate()
            .map(|(i, (name, kind))| Channel { id: i as ChannelId, name: name.to_string(), kind: *kind, topic: None, category: None, no_pictures: false, user_limit: None, afk_after: None, slowmode: None, private_roles: None, parent: None, starter: None, last_at: None, announce: false })
            .collect();
        ServerConfig { name: name.into(), next_channel_id: channels.len() as ChannelId, channels, owner: None, icon: None }
    }

    pub fn default_named(name: &str) -> Self {
        ServerConfig::new(
            name,
            &[("general", ChannelKind::Text), ("Lobby", ChannelKind::Voice), ("Gaming", ChannelKind::Voice)],
        )
    }
}

/// One line of a channel's chat file.
// One per line of the chat log, read and written one at a time: size doesn't matter.
#[allow(clippy::large_enum_variant)]
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum ChatLine {
    Delete { delete: u64 },
    Message(ChatMessage),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub name: String,
    pub created_at: u64,
}

pub struct Storage {
    dir: Option<PathBuf>,
}

impl Storage {
    /// Keeps nothing on disk; used by tests.
    pub fn memory() -> Self {
        Storage { dir: None }
    }

    pub fn at(dir: impl Into<PathBuf>) -> std::io::Result<Self> {
        let dir = dir.into();
        fs::create_dir_all(&dir)?;
        Ok(Storage { dir: Some(dir) })
    }

    /// The server's database (in memory for tests).
    pub(crate) fn open_db(&self) -> anyhow::Result<rusqlite::Connection> {
        Ok(match &self.dir {
            Some(dir) => rusqlite::Connection::open(dir.join("server.db"))?,
            None => rusqlite::Connection::open_in_memory()?,
        })
    }

    /// A server from before the database: its settings, people, invites, bans and chat move in
    /// (same channel and message numbers), and the old files are kept aside. True if it did.
    pub(crate) fn import_legacy(&self, core: &mut crate::core::Core) -> anyhow::Result<bool> {
        let Some(dir) = &self.dir else { return Ok(false) };
        let Some(config) = self.load_config() else { return Ok(false) };
        let db = core.db();
        let fresh: i64 = db.query_row("SELECT count(*) FROM meta WHERE key = 'name'", [], |r| r.get(0))?;
        if fresh == 0 {
            let tx = db.unchecked_transaction()?;
            let meta = |k: &str, v: &str| tx.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", [k, v]);
            meta("name", &config.name)?;
            if let Some(icon) = &config.icon {
                meta("icon", icon)?;
            }
            if let Some(owner) = &config.owner {
                meta("owner", owner)?;
            }
            for (i, c) in config.channels.iter().enumerate() {
                tx.execute(
                    "INSERT INTO channels (id, name, kind, position, topic, category, user_limit, afk_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    rusqlite::params![c.id, c.name, if c.kind == ChannelKind::Voice { "voice" } else { "text" }, i as i64, c.topic, c.category, c.user_limit, c.afk_after],
                )?;
                for m in self.load_before(c.id, u64::MAX, 1000).unwrap_or_default() {
                    tx.execute(
                        "INSERT OR IGNORE INTO messages (id, channel, sender, sender_name, author_key, text, sent_at, pinned, reply_id, reply_name, reply_key, reply_text, edited_at, reactions)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        rusqlite::params![
                            m.id as i64, m.channel, m.sender, m.sender_name, m.author_key, m.text, m.sent_at as i64, m.pinned.then_some(1),
                            m.reply.as_ref().map(|r| r.id as i64), m.reply.as_ref().map(|r| r.sender_name.clone()), m.reply.as_ref().map(|r| r.author_key.clone()), m.reply.as_ref().map(|r| r.text.clone()),
                            m.edited_at.map(|t| t as i64), (!m.reactions.is_empty()).then(|| serde_json::to_string(&m.reactions).unwrap_or_default()),
                        ],
                    )?;
                }
            }
            // Numbers carry on after the highest ever used, deleted messages too.
            let highest = config.channels.iter().map(|c| self.load_chat(c.id, 1).1).max().unwrap_or(0) as i64;
            tx.execute("INSERT OR IGNORE INTO messages (id, channel, sender, sender_name, author_key, text, sent_at) VALUES (?, -1, 0, '', '', '', 0)", [highest])?;
            tx.execute("DELETE FROM messages WHERE channel = -1", [])?;
            for (key, a) in self.load_accounts() {
                tx.execute("INSERT OR IGNORE INTO accounts (key, name, created_at) VALUES (?, ?, ?)", rusqlite::params![key, a.name, a.created_at as i64])?;
            }
            for i in self.load_invites() {
                tx.execute(
                    "INSERT OR IGNORE INTO invites (code, created_at, expires_at, max_uses, uses) VALUES (?, ?, ?, ?, ?)",
                    rusqlite::params![i.code, i.created_at as i64, i.expires_at.map(|t| t as i64), i.max_uses, i.uses],
                )?;
            }
            for b in self.load_bans() {
                tx.execute("INSERT OR IGNORE INTO bans (key, name, banned_at) VALUES (?, ?, ?)", rusqlite::params![b.public_key, b.name, b.banned_at as i64])?;
            }
            tx.commit()?;
            core.after_import();
        }
        for file in [CONFIG_FILE, ACCOUNTS_FILE, INVITES_FILE, BANS_FILE] {
            let _ = fs::rename(dir.join(file), dir.join(format!("{file}.imported")));
        }
        let _ = fs::rename(dir.join("chat"), dir.join("chat.imported"));
        Ok(fresh == 0)
    }

    pub fn load_config(&self) -> Option<ServerConfig> {
        self.read_json(CONFIG_FILE)
    }

    pub fn save_config(&self, config: &ServerConfig) {
        self.write_json(CONFIG_FILE, config);
    }

    pub fn load_accounts(&self) -> HashMap<String, Account> {
        self.read_json(ACCOUNTS_FILE).unwrap_or_default()
    }

    pub fn save_accounts(&self, accounts: &HashMap<String, Account>) {
        self.write_json(ACCOUNTS_FILE, accounts);
    }

    pub fn load_invites(&self) -> Vec<Invite> {
        self.read_json(INVITES_FILE).unwrap_or_default()
    }

    pub fn save_invites(&self, invites: &[Invite]) {
        self.write_json(INVITES_FILE, &invites);
    }

    pub fn load_bans(&self) -> Vec<Ban> {
        self.read_json(BANS_FILE).unwrap_or_default()
    }

    pub fn save_bans(&self, bans: &[Ban]) {
        self.write_json(BANS_FILE, &bans);
    }

    fn chat_path(&self, channel: ChannelId) -> Option<PathBuf> {
        Some(self.dir.as_ref()?.join("chat").join(format!("{channel}.jsonl")))
    }

    fn append_line(&self, channel: ChannelId, line: &ChatLine) {
        let Some(path) = self.chat_path(channel) else { return };
        let result = OpenOptions::new().create(true).append(true).open(&path).and_then(|mut f| {
            let mut bytes = serde_json::to_vec(line).expect("chat lines always serialize");
            bytes.push(b'\n');
            f.write_all(&bytes)
        });
        if let Err(e) = result {
            tracing::error!("could not save chat to {}: {e}", path.display());
        }
    }

    pub fn append_chat(&self, message: &ChatMessage) {
        self.append_line(message.channel, &ChatLine::Message(message.clone()));
    }

    /// Deletions are appended as markers; the file stays append-only.
    pub fn append_delete(&self, channel: ChannelId, id: u64) {
        self.append_line(channel, &ChatLine::Delete { delete: id });
    }

    /// The newest `keep` messages of a channel, oldest first, and the highest message id seen.
    pub fn load_chat(&self, channel: ChannelId, keep: usize) -> (VecDeque<ChatMessage>, u64) {
        let mut out: VecDeque<ChatMessage> = VecDeque::with_capacity(keep);
        let mut max_id = 0;
        let Some(file) = self.chat_path(channel).and_then(|p| fs::File::open(p).ok()) else { return (out, max_id) };
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            match serde_json::from_str(&line) {
                Ok(ChatLine::Message(m)) => {
                    // An edit or a reaction: the message again, changed (or already dropped as too old).
                    if m.id <= max_id {
                        if let Some(old) = out.iter_mut().find(|x| x.id == m.id) {
                            *old = m;
                        }
                        continue;
                    }
                    max_id = m.id;
                    if out.len() == keep {
                        out.pop_front();
                    }
                    out.push_back(m);
                }
                Ok(ChatLine::Delete { delete }) => out.retain(|m| m.id != delete),
                Err(_) => {}
            }
        }
        (out, max_id)
    }

    /// Up to `n` messages before `before`, oldest first; `None` when nothing is kept on disk.
    pub fn load_before(&self, channel: ChannelId, before: u64, n: usize) -> Option<Vec<ChatMessage>> {
        self.dir.as_ref()?;
        let mut all = BTreeMap::new();
        if let Some(file) = self.chat_path(channel).and_then(|p| fs::File::open(p).ok()) {
            for line in BufReader::new(file).lines().map_while(Result::ok) {
                match serde_json::from_str(&line) {
                    Ok(ChatLine::Message(m)) => {
                        all.insert(m.id, m);
                    }
                    Ok(ChatLine::Delete { delete }) => {
                        all.remove(&delete);
                    }
                    Err(_) => {}
                }
            }
        }
        let mut out: Vec<ChatMessage> = all.range(..before).rev().take(n).map(|(_, m)| m.clone()).collect();
        out.reverse();
        Some(out)
    }

    /// Keeps chat files from growing forever: a large file is rewritten with only its newest messages.
    pub fn compact_chat(&self, channel: ChannelId) {
        let Some(path) = self.chat_path(channel) else { return };
        if fs::metadata(&path).map_or(true, |m| m.len() <= CHAT_COMPACT_BYTES) {
            return;
        }
        let (kept, _) = self.load_chat(channel, CHAT_COMPACT_KEEP);
        let tmp = path.with_extension("jsonl.tmp");
        let mut text = Vec::new();
        for m in kept {
            text.extend(serde_json::to_vec(&ChatLine::Message(m)).expect("chat lines always serialize"));
            text.push(b'\n');
        }
        if let Err(e) = fs::write(&tmp, text).and_then(|_| fs::rename(&tmp, &path)) {
            tracing::error!("could not compact {}: {e}", path.display());
        }
    }

    pub fn delete_chat(&self, channel: ChannelId) {
        if let Some(path) = self.chat_path(channel) {
            let _ = fs::remove_file(path);
        }
    }

    fn read_json<T: DeserializeOwned>(&self, file: &str) -> Option<T> {
        let path = self.dir.as_ref()?.join(file);
        let text = fs::read_to_string(&path).ok()?;
        match serde_json::from_str(&text) {
            Ok(v) => Some(v),
            Err(e) => {
                tracing::error!("ignoring unreadable {}: {e}", path.display());
                None
            }
        }
    }

    /// Writes via a temporary file so a crash never leaves half a file behind.
    fn write_json<T: Serialize>(&self, file: &str, value: &T) {
        let Some(dir) = &self.dir else { return };
        let path = dir.join(file);
        let tmp = dir.join(format!("{file}.tmp"));
        let json = serde_json::to_vec_pretty(value).expect("server state always serializes");
        if let Err(e) = fs::write(&tmp, json).and_then(|_| fs::rename(&tmp, &path)) {
            tracing::error!("could not save {}: {e}", path.display());
        }
    }
}
