//! Wire protocol shared by the Hopp server and client.
//!
//! Control traffic is newline-delimited JSON over TCP. Voice is sent over UDP
//! as small binary packets carrying one Opus frame each; the server only
//! relays them and never decodes audio.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 5;
/// The most messages one search returns, newest first.
pub const SEARCH_RESULTS: usize = 25;
pub const DEFAULT_PORT: u16 = 7777;

/// Audio is always 48 kHz mono, sent in 10 ms frames.
pub const SAMPLE_RATE: u32 = 48_000;
pub const FRAME_SAMPLES: usize = 480;

pub type SessionId = u32;
pub type ChannelId = u32;

pub const MAX_NAME_LEN: usize = 32;
pub const MAX_CHANNELS: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelKind {
    Text,
    Voice,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Channel {
    pub id: ChannelId,
    pub name: String,
    pub kind: ChannelKind,
    /// What the channel is for, shown next to its name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    /// The heading it's listed under; `None`: the plain text and voice lists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// Cloud servers: the owner turned pictures off in this channel.
    #[serde(default, skip_serializing_if = "is_false")]
    pub no_pictures: bool,
    /// Voice channels: at most this many people (moderators can still move people in).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_limit: Option<u8>,
    /// Voice channels: this is the AFK channel; people away this many minutes are moved here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub afk_after: Option<u16>,
    /// Seconds between each person's messages here (moderators aren't held to it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slowmode: Option<u32>,
    /// A private channel: only people with one of these roles (and admins) see it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_roles: Option<Vec<u32>>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

pub const MAX_CATEGORY_LEN: usize = 24;

pub const MAX_TOPIC_LEN: usize = 200;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct User {
    pub session_id: SessionId,
    pub name: String,
    /// `None` while the user is only reading and writing text.
    pub voice_channel: Option<ChannelId>,
    pub muted: bool,
    pub deafened: bool,
    pub owner: bool,
    /// Hex Ed25519 key of their Hopp ID, so mentions (`<@key>`) can name them.
    #[serde(default)]
    pub public_key: String,
    /// "owner", "admin" or "mod" on cloud servers; `None` for everyone else.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// Sharing their screen with their voice channel.
    #[serde(default)]
    pub sharing: bool,
    /// Muted by a moderator: their voice isn't passed on, and they can't unmute.
    #[serde(default)]
    pub server_muted: bool,
    /// Deafened by a moderator: they hear nobody, and can't undo it.
    #[serde(default)]
    pub server_deafened: bool,
    /// Timed out by a moderator until then (milliseconds since 1970): no writing, reacting or voice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timed_out_until: Option<u64>,
    /// The server's roles they have (ids of `RoleInfo`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub roles: Vec<u32>,
}

/// A role a server made: a name and colour for its people, a place of its own in the member
/// list if `hoist`, and what it lets them do (`level`: "mod", "admin" or none).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoleInfo {
    pub id: u32,
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub hoist: bool,
    #[serde(default)]
    pub level: Option<String>,
    #[serde(default)]
    pub position: i32,
    /// Anyone may @mention it (moderators always may).
    #[serde(default)]
    pub mentionable: bool,
}

/// One line of a server's audit log: who did what, to whom, when.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuditEntry {
    pub at: u64,
    pub actor: String,
    pub action: String,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub detail: Option<String>,
}

/// The most a screen-sharing handshake message may hold (an offer with its codecs fits easily).
pub const MAX_SCREEN_SIGNAL: usize = 65_536;

/// What a client signs to prove it holds the private key for its identity.
pub fn auth_message(nonce: &[u8]) -> Vec<u8> {
    let mut msg = b"strom-auth-v1\0".to_vec();
    msg.extend_from_slice(nonce);
    msg
}

pub const MAX_CHAT_LEN: usize = 2000;
pub const MAX_SERVER_NAME_LEN: usize = 40;
/// Server pictures are resized by the app, so this is plenty.
pub const MAX_ICON_LEN: usize = 200_000;

/// Accepts only small inline PNG, JPEG or WebP pictures.
pub fn valid_icon(icon: &str) -> bool {
    icon.len() <= MAX_ICON_LEN
        && ["data:image/png;base64,", "data:image/jpeg;base64,", "data:image/webp;base64,"].iter().any(|p| icon.starts_with(p))
        && icon.split_once(",").is_some_and(|(_, b64)| b64.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/' || c == b'='))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Invite {
    pub code: String,
    pub created_at: u64,
    pub expires_at: Option<u64>,
    pub max_uses: Option<u32>,
    pub uses: u32,
}

impl Invite {
    pub fn is_usable(&self, now: u64) -> bool {
        self.expires_at.is_none_or(|t| now < t) && self.max_uses.is_none_or(|m| self.uses < m)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Ban {
    pub public_key: String,
    pub name: String,
    pub banned_at: u64,
}

/// Someone who belongs to a server, online or not.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Member {
    pub public_key: String,
    pub name: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub joined_at: u64,
    #[serde(default)]
    pub roles: Vec<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    /// Unique per server, assigned by the server.
    #[serde(default)]
    pub id: u64,
    pub channel: ChannelId,
    pub sender: SessionId,
    pub sender_name: String,
    /// Public key of the author, stable across sessions (session ids are not).
    #[serde(default)]
    pub author_key: String,
    pub text: String,
    /// Unix time in milliseconds, stamped by the server.
    pub sent_at: u64,
    /// The message this one answers, as it looked when answered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply: Option<Reply>,
    /// When the author last changed the text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reactions: Vec<Reaction>,
    /// Pinned by the owner, to keep it easy to find.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pinned: bool,
}

/// What a reply shows of the message it answers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reply {
    pub id: u64,
    pub sender_name: String,
    pub author_key: String,
    /// The start of the answered message.
    pub text: String,
}

/// One emoji on a message, and the Hopp IDs of everyone who added it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reaction {
    pub emoji: String,
    pub keys: Vec<String>,
}

pub const MAX_REACTIONS: usize = 20;
pub const REPLY_PREVIEW_LEN: usize = 120;
/// Older messages are fetched this many at a time.
pub const OLDER_PAGE: usize = 50;

/// An emoji (or short emoji sequence): no spaces, no plain letters or digits.
pub fn valid_emoji(emoji: &str) -> bool {
    !emoji.is_empty() && emoji.len() <= 32 && emoji.chars().all(|c| !c.is_whitespace() && !c.is_ascii())
}

/// Adds or removes `key`'s `emoji` on a message. False if the message already has too many kinds.
pub fn toggle_reaction(reactions: &mut Vec<Reaction>, emoji: &str, key: &str, on: bool) -> bool {
    match reactions.iter_mut().position(|r| r.emoji == emoji) {
        Some(i) => {
            let r = &mut reactions[i];
            r.keys.retain(|k| k != key);
            if on {
                r.keys.push(key.to_string());
            } else if r.keys.is_empty() {
                reactions.remove(i);
            }
            true
        }
        None if !on => true,
        None if reactions.len() >= MAX_REACTIONS => false,
        None => {
            reactions.push(Reaction { emoji: emoji.to_string(), keys: vec![key.to_string()] });
            true
        }
    }
}

/// The start of a message, for a reply.
pub fn reply_preview(text: &str) -> String {
    let mut out: String = text.chars().take(REPLY_PREVIEW_LEN).collect();
    if text.chars().count() > REPLY_PREVIEW_LEN {
        out.push('…');
    }
    out
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    /// `public_key` is the hex-encoded Ed25519 key of the user's Hopp-ID.
    /// `invite` is required the first time someone joins a server.
    Hello {
        name: String,
        protocol_version: u32,
        public_key: String,
        #[serde(default)]
        invite: Option<String>,
        /// Cloud servers only: create the server with this name, owned by the sender.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        create: Option<String>,
    },
    /// Hex-encoded signature over [`auth_message`] of the challenge nonce.
    Auth { signature: String },
    JoinVoice { channel: ChannelId },
    LeaveVoice,
    SetState { muted: bool, deafened: bool },
    /// Ask the server to send our own voice back to us, to hear what others hear.
    SetLoopback { enabled: bool },
    SendChat {
        channel: ChannelId,
        text: String,
        /// Answers this message.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reply_to: Option<u64>,
    },
    /// The author only.
    EditMessage { channel: ChannelId, id: u64, text: String },
    /// Adds (`on`) or removes your reaction.
    React { channel: ChannelId, id: u64, emoji: String, on: bool },
    /// Owner only: pin a message to its channel, or unpin it.
    Pin { channel: ChannelId, id: u64, on: bool },
    /// Answered with `Pins`: a channel's pinned messages.
    GetPins { channel: ChannelId },
    /// Answered with `OlderHistory`: up to [`OLDER_PAGE`] messages before `before`.
    LoadOlder { channel: ChannelId, before: u64 },
    /// Answered with `SearchResults`: the newest messages in the server's text channels
    /// containing `query` (any case). Only for servers whose welcome lists "search":
    /// older ones drop a connection that sends something they don't know.
    Search { query: String },
    /// Screen sharing, for servers whose welcome lists "screen": whether we share our screen
    /// with our voice channel. Leaving voice stops it.
    SetSharing { on: bool },
    /// Screen sharing: part of a video handshake for `to`, who must be in our voice channel.
    /// The server only passes it on.
    ScreenSignal { to: SessionId, data: String },
    /// Owner only.
    CreateChannel { name: String, kind: ChannelKind },
    /// Owner only.
    DeleteChannel { channel: ChannelId },
    /// Owner only: a new name and topic (`None` or empty: no topic).
    UpdateChannel {
        channel: ChannelId,
        name: String,
        #[serde(default)]
        topic: Option<String>,
        #[serde(default)]
        category: Option<String>,
        /// Cloud servers: `Some(true)` turns pictures off in the channel; `None` leaves it.
        #[serde(default)]
        no_pictures: Option<bool>,
        /// Voice channels: `Some(0)` for no limit; `None` leaves it.
        #[serde(default)]
        user_limit: Option<u8>,
        /// Voice channels: `Some(minutes)` makes it the AFK channel, `Some(0)` stops it; `None` leaves it.
        #[serde(default)]
        afk_after: Option<u16>,
        /// Seconds between each person's messages; `Some(0)` turns it off; `None` leaves it.
        #[serde(default)]
        slowmode: Option<u32>,
        /// Roles that may see the channel (`Some(empty)`: everyone); `None` leaves it.
        #[serde(default)]
        private_roles: Option<Vec<u32>>,
    },
    /// Admins, on servers whose welcome lists "roles": a new role.
    CreateRole {
        name: String,
        color: Option<String>,
        hoist: bool,
        level: Option<String>,
        #[serde(default)]
        mentionable: bool,
    },
    UpdateRole {
        id: u32,
        name: String,
        color: Option<String>,
        hoist: bool,
        level: Option<String>,
        #[serde(default)]
        mentionable: bool,
    },
    DeleteRole { id: u32 },
    /// Every role id, highest first.
    ReorderRoles { order: Vec<u32> },
    /// Gives someone a role, or takes it away.
    AssignRole { public_key: String, role: u32, on: bool },
    /// Owner only: every channel id, in the new order.
    ReorderChannels { order: Vec<ChannelId> },
    /// Allowed for the author and the owner.
    DeleteMessage { channel: ChannelId, id: u64 },
    /// Sent at most every few seconds while the user is typing.
    Typing { channel: ChannelId },
    /// Moderators: takes someone out of their voice channel (they stay in the server).
    /// Only for servers whose welcome lists "voice-mod".
    DisconnectVoice { session_id: SessionId },
    /// Moderators: moves someone in voice to another voice channel.
    MoveVoice { session_id: SessionId, channel: ChannelId },
    /// Moderators: mutes or deafens someone for everyone (until a moderator undoes it).
    ServerMute { session_id: SessionId, muted: bool, deafened: bool },
    /// Owner only: disconnects someone.
    Kick { session_id: SessionId },
    /// Owner only: disconnects someone and refuses their Hopp-ID from now on.
    /// `delete_hours`: also delete what they wrote in the last so many hours.
    Ban {
        session_id: SessionId,
        #[serde(default)]
        delete_hours: u32,
    },
    /// Moderators, on servers whose welcome lists "mod-tools": time someone out for so many
    /// minutes (0 lifts it). They can read, but not write, react or be in voice.
    Timeout { session_id: SessionId, minutes: u32 },
    /// Admins, on servers with "mod-tools": answered with `AuditLog`.
    GetAuditLog,
    /// Owner only.
    Unban { public_key: String },
    /// Owner only. `None` means no limit.
    CreateInvite { max_uses: Option<u32>, expires_in_hours: Option<u32> },
    /// Owner only.
    RevokeInvite { code: String },
    /// Owner only: answered with `Invites` and `Bans`.
    GetServerSettings,
    /// Owner only: sets the server name and picture (`icon` is a small `data:image/...` URL, or `None` to remove it).
    UpdateServer {
        name: String,
        icon: Option<String>,
        /// Cloud servers: `Some(true)` turns pictures off everywhere; `None` leaves it.
        #[serde(default)]
        pictures_off: Option<bool>,
    },
    /// Cloud servers: where peers in our voice channel can reach us directly
    /// ("ip:port"). `public` comes from STUN; `local` are addresses on our own network.
    VoiceEndpoint { public: Option<String>, local: Vec<String> },
    /// Leave for good: you need a new invite to come back. Not for the owner.
    LeaveServer,
    /// Owner only: deletes the server, its channels, messages and invites, for everyone.
    DeleteServer,
    /// Cloud servers: "admin" or "mod", or `None` for a plain member. The owner names
    /// admins; admins name moderators.
    SetRole { public_key: String, role: Option<String> },
    /// Owner only: hands the server to another member; the old owner stays as an admin.
    TransferOwnership { public_key: String },
    /// Admins: answered with `Members`.
    GetMembers,
    Ping,
}

/// How to reach someone in our voice channel directly (cloud servers have no voice relay).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PeerEndpoint {
    pub session_id: SessionId,
    pub public: Option<String>,
    pub local: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    /// Hex-encoded random bytes the client must sign.
    Challenge { nonce: String },
    Welcome {
        server_name: String,
        session_id: SessionId,
        udp_token: u64,
        udp_port: u16,
        channels: Vec<Channel>,
        users: Vec<User>,
        /// The server picture as a `data:image/...;base64,` URL, if the owner set one.
        #[serde(default)]
        server_icon: Option<String>,
        /// Cloud servers: the owner turned pictures off.
        #[serde(default)]
        pictures_off: bool,
        /// What this server can do beyond the basics (like "search"), so apps never ask an
        /// older server for something it doesn't know.
        #[serde(default)]
        features: Vec<String>,
        /// The server's own roles, highest first.
        #[serde(default)]
        roles: Vec<RoleInfo>,
    },
    /// The owner renamed the server or changed its picture.
    ServerUpdated {
        name: String,
        icon: Option<String>,
        #[serde(default)]
        pictures_off: bool,
    },
    /// Cloud servers, after JoinVoice: the channel's voice key (hex, 32 bytes) and
    /// the endpoints of everyone already in it. Voice then goes peer to peer.
    VoiceSession { channel: ChannelId, key: String, peers: Vec<PeerEndpoint> },
    /// Cloud servers: someone in our voice channel told us where to reach them.
    VoicePeer { peer: PeerEndpoint },
    UserJoined { user: User },
    UserUpdated { user: User },
    UserLeft { session_id: SessionId },
    ChannelsUpdated { channels: Vec<Channel> },
    Chat { message: ChatMessage },
    /// Recent messages of a text channel, oldest first. Sent for every text channel after login.
    ChatHistory { channel: ChannelId, messages: Vec<ChatMessage> },
    MessageDeleted { channel: ChannelId, id: u64 },
    MessageEdited { channel: ChannelId, id: u64, text: String, edited_at: u64 },
    Reactions { channel: ChannelId, id: u64, reactions: Vec<Reaction> },
    Pinned { channel: ChannelId, id: u64, on: bool },
    Pins { channel: ChannelId, messages: Vec<ChatMessage> },
    /// Older messages, oldest first. `done`: there are none before these.
    OlderHistory { channel: ChannelId, messages: Vec<ChatMessage>, done: bool },
    /// What a search found, newest first (at most [`SEARCH_RESULTS`]).
    SearchResults { query: String, messages: Vec<ChatMessage> },
    /// Part of a screen-sharing handshake from someone in our voice channel.
    ScreenSignal { from: SessionId, data: String },
    Typing { channel: ChannelId, session_id: SessionId },
    /// Sent to a user right before the server drops them.
    Kicked { banned: bool },
    /// You left the server (after `LeaveServer`).
    Left,
    /// The owner deleted the server.
    ServerDeleted,
    InviteCreated { invite: Invite },
    Invites { invites: Vec<Invite> },
    Bans { bans: Vec<Ban> },
    /// The newest audit log entries first.
    AuditLog { entries: Vec<AuditEntry> },
    /// The server's roles changed (highest first).
    RolesUpdated { roles: Vec<RoleInfo> },
    Members { members: Vec<Member> },
    Error { message: String },
    Pong,
}

pub fn encode_line<T: Serialize>(msg: &T) -> Vec<u8> {
    let mut buf = serde_json::to_vec(msg).expect("protocol types always serialize");
    buf.push(b'\n');
    buf
}

/// UDP packet kinds.
const KIND_VOICE: u8 = 0;
const KIND_PING: u8 = 1;

/// Client -> server header: kind, session id, token, sequence number.
pub const CLIENT_HEADER: usize = 1 + 4 + 8 + 4;
/// Server -> client header: kind, sender session id, sequence number.
pub const SERVER_HEADER: usize = 1 + 4 + 4;

#[derive(Debug, Clone, PartialEq)]
pub enum ClientPacket<'a> {
    /// Keeps the NAT mapping open and tells the server our UDP address. The
    /// server echoes it back unchanged, so `nonce` lets the client time the round trip.
    Ping { session_id: SessionId, token: u64, nonce: u32 },
    Voice { session_id: SessionId, token: u64, seq: u32, opus: &'a [u8] },
}

impl<'a> ClientPacket<'a> {
    pub fn write(&self, out: &mut Vec<u8>) {
        out.clear();
        match *self {
            ClientPacket::Ping { session_id, token, nonce } => {
                out.push(KIND_PING);
                out.extend_from_slice(&session_id.to_be_bytes());
                out.extend_from_slice(&token.to_be_bytes());
                out.extend_from_slice(&nonce.to_be_bytes());
            }
            ClientPacket::Voice { session_id, token, seq, opus } => {
                out.push(KIND_VOICE);
                out.extend_from_slice(&session_id.to_be_bytes());
                out.extend_from_slice(&token.to_be_bytes());
                out.extend_from_slice(&seq.to_be_bytes());
                out.extend_from_slice(opus);
            }
        }
    }

    pub fn parse(buf: &'a [u8]) -> Option<Self> {
        if buf.len() < CLIENT_HEADER {
            return None;
        }
        let session_id = u32::from_be_bytes(buf[1..5].try_into().ok()?);
        let token = u64::from_be_bytes(buf[5..13].try_into().ok()?);
        let seq = u32::from_be_bytes(buf[13..17].try_into().ok()?);
        match buf[0] {
            KIND_PING => Some(ClientPacket::Ping { session_id, token, nonce: seq }),
            KIND_VOICE if buf.len() > CLIENT_HEADER => Some(ClientPacket::Voice {
                session_id,
                token,
                seq,
                opus: &buf[CLIENT_HEADER..],
            }),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ServerVoice<'a> {
    pub sender: SessionId,
    pub seq: u32,
    pub opus: &'a [u8],
}

impl<'a> ServerVoice<'a> {
    pub fn write(&self, out: &mut Vec<u8>) {
        out.clear();
        out.push(KIND_VOICE);
        out.extend_from_slice(&self.sender.to_be_bytes());
        out.extend_from_slice(&self.seq.to_be_bytes());
        out.extend_from_slice(self.opus);
    }

    pub fn parse(buf: &'a [u8]) -> Option<Self> {
        if buf.len() <= SERVER_HEADER || buf[0] != KIND_VOICE {
            return None;
        }
        Some(ServerVoice {
            sender: u32::from_be_bytes(buf[1..5].try_into().ok()?),
            seq: u32::from_be_bytes(buf[5..9].try_into().ok()?),
            opus: &buf[SERVER_HEADER..],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_voice_roundtrip() {
        let pkt = ClientPacket::Voice { session_id: 7, token: 0xdead_beef, seq: 42, opus: &[1, 2, 3] };
        let mut buf = Vec::new();
        pkt.write(&mut buf);
        assert_eq!(ClientPacket::parse(&buf), Some(pkt));
    }

    #[test]
    fn client_ping_roundtrip() {
        let pkt = ClientPacket::Ping { session_id: 1, token: 99, nonce: 1234 };
        let mut buf = Vec::new();
        pkt.write(&mut buf);
        assert_eq!(ClientPacket::parse(&buf), Some(pkt));
    }

    #[test]
    fn server_voice_roundtrip() {
        let pkt = ServerVoice { sender: 3, seq: 9, opus: &[9, 8, 7] };
        let mut buf = Vec::new();
        pkt.write(&mut buf);
        assert_eq!(ServerVoice::parse(&buf), Some(pkt));
    }

    #[test]
    fn rejects_truncated_packets() {
        assert_eq!(ClientPacket::parse(&[0, 1, 2]), None);
        assert_eq!(ServerVoice::parse(&[0, 0, 0, 0, 1, 0, 0, 0, 1]), None);
    }

    #[test]
    fn only_small_inline_pictures_are_valid_icons() {
        assert!(valid_icon("data:image/png;base64,iVBORw0KGgo="));
        assert!(valid_icon("data:image/webp;base64,UklGR+/="));
        assert!(!valid_icon("https://example.com/icon.png"), "no remote pictures");
        assert!(!valid_icon("data:image/svg+xml;base64,PHN2Zz4="), "no SVG: it can carry scripts");
        assert!(!valid_icon("data:image/png;base64,<script>"));
        assert!(!valid_icon(&format!("data:image/png;base64,{}", "A".repeat(MAX_ICON_LEN))));
    }

    #[test]
    fn control_messages_are_tagged_json() {
        let line = encode_line(&ClientMsg::JoinVoice { channel: 2 });
        assert_eq!(line, b"{\"type\":\"join_voice\",\"channel\":2}\n");
    }
}
