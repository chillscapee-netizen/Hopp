//! On-disk state: server settings, accounts and chat history.
//!
//! Everything is plain JSON in one directory so a server owner can read, back
//! up or edit it by hand. Chat is append-only JSON lines, one file per channel.

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
            .map(|(i, (name, kind))| Channel { id: i as ChannelId, name: name.to_string(), kind: *kind, topic: None, category: None, no_pictures: false })
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
        fs::create_dir_all(dir.join("chat"))?;
        Ok(Storage { dir: Some(dir) })
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
