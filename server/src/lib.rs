//! The Hopp server: accounts, invites, channels, chat and a voice relay that
//! never decodes audio.

mod storage;

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
pub use storage::{Account, ServerConfig, Storage};
use strom_shared::*;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::mpsc;
use tracing::{info, warn};

/// Long enough for a server picture in an `update_server` message.
const MAX_LINE: u64 = 262_144;
/// Clients ping every few seconds; anyone silent for longer than this is gone.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Logging in must not take longer than this.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Chat messages per channel kept in memory and replayed at login.
const CHAT_HISTORY: usize = 100;
const MAX_CLIENTS: usize = 500;
/// New connections allowed per IP address per minute.
const MAX_ATTEMPTS_PER_MINUTE: u32 = 20;
/// Chat flood protection: a burst of this many, then one per second.
const CHAT_BURST: f32 = 5.0;
const CHAT_PER_SECOND: f32 = 1.0;
/// Normal speech is 100 packets per second.
const MAX_VOICE_PACKETS_PER_SECOND: u32 = 200;
const TYPING_INTERVAL: Duration = Duration::from_secs(2);
const INVITE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// A token bucket: allows short bursts but caps the sustained rate.
struct Bucket {
    tokens: f32,
    last: Instant,
}

impl Bucket {
    fn new() -> Self {
        Bucket { tokens: CHAT_BURST, last: Instant::now() }
    }

    fn take(&mut self) -> bool {
        let now = Instant::now();
        self.tokens = (self.tokens + now.duration_since(self.last).as_secs_f32() * CHAT_PER_SECOND).min(CHAT_BURST);
        self.last = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

struct Client {
    user: User,
    public_key: String,
    token: u64,
    udp_addr: Option<SocketAddr>,
    loopback: bool,
    tx: mpsc::UnboundedSender<ServerMsg>,
    chat: Bucket,
    last_typing: Option<Instant>,
    voice_window: (Instant, u32),
}

struct State {
    config: ServerConfig,
    accounts: HashMap<String, Account>,
    invites: Vec<Invite>,
    bans: Vec<Ban>,
    clients: HashMap<SessionId, Client>,
    history: HashMap<ChannelId, VecDeque<ChatMessage>>,
    next_id: SessionId,
    next_message_id: u64,
    /// Lets the first owner claim the server from another computer.
    setup_code: Option<String>,
    attempts: HashMap<IpAddr, (Instant, u32)>,
    storage: Storage,
}

impl State {
    fn broadcast(&self, msg: &ServerMsg) {
        for c in self.clients.values() {
            let _ = c.tx.send(msg.clone());
        }
    }

    fn channel(&self, id: ChannelId) -> Option<&Channel> {
        self.config.channels.iter().find(|c| c.id == id)
    }

    fn post_chat(&mut self, message: ChatMessage) {
        self.storage.append_chat(&message);
        let history = self.history.entry(message.channel).or_default();
        if history.len() == CHAT_HISTORY {
            history.pop_front();
        }
        history.push_back(message.clone());
        self.broadcast(&ServerMsg::Chat { message });
    }

    fn update_user(&mut self, session_id: SessionId, f: impl FnOnce(&mut User)) {
        let Some(client) = self.clients.get_mut(&session_id) else { return };
        f(&mut client.user);
        let msg = ServerMsg::UserUpdated { user: client.user.clone() };
        self.broadcast(&msg);
    }

    fn channels_changed(&self) {
        self.storage.save_config(&self.config);
        self.broadcast(&ServerMsg::ChannelsUpdated { channels: self.config.channels.clone() });
    }

    fn usable_invites(&mut self) -> Vec<Invite> {
        let now = now_millis();
        let before = self.invites.len();
        self.invites.retain(|i| i.is_usable(now));
        if self.invites.len() != before {
            self.storage.save_invites(&self.invites);
        }
        self.invites.clone()
    }

    /// Too many connection attempts from one address in the last minute?
    fn throttled(&mut self, ip: IpAddr) -> bool {
        let now = Instant::now();
        if self.attempts.len() > 10_000 {
            self.attempts.retain(|_, (since, _)| now.duration_since(*since) <= Duration::from_secs(60));
        }
        let entry = self.attempts.entry(ip).or_insert((now, 0));
        if now.duration_since(entry.0) > Duration::from_secs(60) {
            *entry = (now, 0);
        }
        entry.1 += 1;
        entry.1 > MAX_ATTEMPTS_PER_MINUTE
    }
}

type Shared = Arc<Mutex<State>>;

fn now_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn new_code() -> String {
    (0..8).map(|_| INVITE_ALPHABET[rand::random::<usize>() % INVITE_ALPHABET.len()] as char).collect()
}

/// Text channels follow the usual chat convention: lowercase, dashes for spaces.
fn normalize_channel_name(name: &str, kind: ChannelKind) -> String {
    let name = name.trim();
    match kind {
        ChannelKind::Voice => name.to_string(),
        ChannelKind::Text => name.to_lowercase().split_whitespace().collect::<Vec<_>>().join("-"),
    }
}

/// Runs the server on already-bound sockets until the TCP listener fails.
///
/// `default_config` is used, and saved, only when `storage` holds no server yet.
pub async fn run(tcp: TcpListener, udp: UdpSocket, default_config: ServerConfig, storage: Storage) -> anyhow::Result<()> {
    let udp_port = udp.local_addr()?.port();
    let config = match storage.load_config() {
        Some(c) => c,
        None => {
            storage.save_config(&default_config);
            default_config
        }
    };
    let mut history = HashMap::new();
    let mut next_message_id = 1;
    for c in config.channels.iter().filter(|c| c.kind == ChannelKind::Text) {
        storage.compact_chat(c.id);
        let (messages, max_id) = storage.load_chat(c.id, CHAT_HISTORY);
        next_message_id = next_message_id.max(max_id + 1);
        history.insert(c.id, messages);
    }
    let setup_code = config.owner.is_none().then(new_code);
    if let Some(code) = &setup_code {
        info!("this server has no owner yet. Connect from this computer to become the owner,");
        info!("or from another computer with the invite link strom://<address>/{code}");
    }
    let state: Shared = Arc::new(Mutex::new(State {
        accounts: storage.load_accounts(),
        invites: storage.load_invites(),
        bans: storage.load_bans(),
        config,
        clients: HashMap::new(),
        history,
        next_id: 1,
        next_message_id,
        setup_code,
        attempts: HashMap::new(),
        storage,
    }));

    tokio::spawn(relay_voice(udp, state.clone()));

    loop {
        let (stream, addr) = tcp.accept().await?;
        if state.lock().unwrap().throttled(addr.ip()) {
            warn!(%addr, "too many connection attempts, dropping");
            continue;
        }
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_client(stream, addr, state, udp_port).await {
                info!(%addr, "connection closed: {e}");
            }
        });
    }
}

async fn relay_voice(udp: UdpSocket, state: Shared) {
    let mut buf = vec![0u8; 1500];
    let mut out = Vec::with_capacity(1500);
    let mut targets = Vec::new();
    loop {
        let (len, from) = match udp.recv_from(&mut buf).await {
            Ok(r) => r,
            // Windows reports ICMP port-unreachable from earlier sends as recv errors.
            Err(_) => continue,
        };
        let Some(pkt) = ClientPacket::parse(&buf[..len]) else { continue };
        let (session_id, token) = match pkt {
            ClientPacket::Ping { session_id, token, .. } | ClientPacket::Voice { session_id, token, .. } => (session_id, token),
        };

        targets.clear();
        {
            let mut st = state.lock().unwrap();
            let Some(sender) = st.clients.get_mut(&session_id) else { continue };
            if sender.token != token {
                continue;
            }
            sender.udp_addr = Some(from);

            match pkt {
                ClientPacket::Ping { .. } => {
                    // Echo pings so the client can measure round-trip time.
                    out.clear();
                    out.extend_from_slice(&buf[..len]);
                    targets.push(from);
                }
                ClientPacket::Voice { seq, opus, .. } => {
                    let (window, count) = &mut sender.voice_window;
                    if window.elapsed() >= Duration::from_secs(1) {
                        *window = Instant::now();
                        *count = 0;
                    }
                    *count += 1;
                    if *count > MAX_VOICE_PACKETS_PER_SECOND {
                        continue;
                    }
                    let Some(channel) = sender.user.voice_channel else { continue };
                    if sender.user.muted || sender.user.deafened {
                        continue;
                    }
                    ServerVoice { sender: session_id, seq, opus }.write(&mut out);
                    targets.extend(st.clients.values().filter_map(|c| {
                        let is_sender = c.user.session_id == session_id;
                        let listening =
                            (!is_sender || c.loopback) && c.user.voice_channel == Some(channel) && !c.user.deafened;
                        if listening { c.udp_addr } else { None }
                    }));
                }
            }
        }
        for addr in &targets {
            let _ = udp.send_to(&out, addr).await;
        }
    }
}

async fn read_msg<R: AsyncBufRead + Unpin>(reader: &mut R, line: &mut String, timeout: Duration) -> anyhow::Result<ClientMsg> {
    line.clear();
    let n = tokio::time::timeout(timeout, reader.take(MAX_LINE).read_line(line)).await??;
    anyhow::ensure!(n > 0, "client disconnected");
    anyhow::ensure!(line.ends_with('\n'), "line too long");
    Ok(serde_json::from_str(line)?)
}

async fn reject(wr: &mut OwnedWriteHalf, message: impl Into<String>) -> anyhow::Error {
    let message = message.into();
    let _ = wr.write_all(&encode_line(&ServerMsg::Error { message: message.clone() })).await;
    anyhow::anyhow!(message)
}

fn parse_key(hex_key: &str) -> Option<VerifyingKey> {
    let bytes: [u8; 32] = hex::decode(hex_key).ok()?.try_into().ok()?;
    VerifyingKey::from_bytes(&bytes).ok()
}

fn parse_signature(hex_sig: &str) -> Option<Signature> {
    let bytes: [u8; 64] = hex::decode(hex_sig).ok()?.try_into().ok()?;
    Some(Signature::from_bytes(&bytes))
}

/// Decides whether a verified identity may join, registering it if so.
fn admit(st: &mut State, name: &str, public_key: &str, invite: Option<&str>, peer: SocketAddr) -> Result<(), String> {
    if st.bans.iter().any(|b| b.public_key == public_key) {
        return Err("You are banned from this server.".into());
    }
    // The newest connection wins: the old one may be a crashed app or a dropped
    // network that hasn't timed out yet.
    let previous = st.clients.iter().find(|(_, c)| c.public_key == public_key).map(|(&id, _)| id);
    if let Some(old_id) = previous {
        if let Some(old) = st.clients.remove(&old_id) {
            let _ = old.tx.send(ServerMsg::Error { message: "You connected to this server from somewhere else.".into() });
        }
        st.broadcast(&ServerMsg::UserLeft { session_id: old_id });
    }
    if st.clients.len() >= MAX_CLIENTS {
        return Err("The server is full.".into());
    }
    if st.accounts.iter().any(|(k, a)| k != public_key && a.name.to_lowercase() == name.to_lowercase()) {
        return Err(format!("The name \"{name}\" is already taken on this server."));
    }

    // Ownership of a new server goes to whoever is at the server's own keyboard,
    // or to someone holding the setup code it printed at startup.
    let claims_ownership = st.config.owner.is_none()
        && (peer.ip().is_loopback() || (invite.is_some() && invite == st.setup_code.as_deref()));
    if !st.accounts.contains_key(public_key) && !claims_ownership {
        let now = now_millis();
        let Some(code) = invite else {
            return Err("This server is invite-only. Ask the owner for an invite link.".into());
        };
        let Some(inv) = st.invites.iter_mut().find(|i| i.code.eq_ignore_ascii_case(code) && i.is_usable(now)) else {
            return Err("This invite is invalid or has expired.".into());
        };
        inv.uses += 1;
        st.storage.save_invites(&st.invites);
    }

    let created_at = st.accounts.get(public_key).map_or_else(now_millis, |a| a.created_at);
    st.accounts.insert(public_key.to_string(), Account { name: name.to_string(), created_at });
    st.storage.save_accounts(&st.accounts);
    if claims_ownership {
        info!("{name} is now the owner of this server");
        st.config.owner = Some(public_key.to_string());
        st.setup_code = None;
        st.storage.save_config(&st.config);
    }
    Ok(())
}

async fn handle_client(stream: TcpStream, peer: SocketAddr, state: Shared, udp_port: u16) -> anyhow::Result<()> {
    stream.set_nodelay(true)?;
    let (rd, mut wr) = stream.into_split();
    let mut reader = BufReader::new(rd);
    let mut line = String::new();

    // 1. Hello: who the client claims to be.
    let ClientMsg::Hello { name, protocol_version, public_key, invite, .. } =
        read_msg(&mut reader, &mut line, HANDSHAKE_TIMEOUT).await?
    else {
        anyhow::bail!("expected hello");
    };
    if protocol_version != PROTOCOL_VERSION {
        let message = format!("The server speaks protocol {PROTOCOL_VERSION}, the app speaks {protocol_version}.");
        return Err(reject(&mut wr, message).await);
    }
    let name = name.trim().to_string();
    if name.is_empty() || name.chars().count() > MAX_NAME_LEN {
        return Err(reject(&mut wr, format!("Names must be 1–{MAX_NAME_LEN} characters.")).await);
    }
    let Some(key) = parse_key(&public_key) else {
        return Err(reject(&mut wr, "Invalid Hopp-ID.").await);
    };

    // 2. Challenge: prove you hold the private key. No password ever reaches the server.
    let nonce: [u8; 32] = rand::random();
    wr.write_all(&encode_line(&ServerMsg::Challenge { nonce: hex::encode(nonce) })).await?;
    let ClientMsg::Auth { signature } = read_msg(&mut reader, &mut line, HANDSHAKE_TIMEOUT).await? else {
        anyhow::bail!("expected auth");
    };
    let valid = parse_signature(&signature).is_some_and(|sig| key.verify(&auth_message(&nonce), &sig).is_ok());
    if !valid {
        return Err(reject(&mut wr, "Login failed: invalid signature.").await);
    }

    // 3. Admit, then join.
    let (tx, mut rx) = mpsc::unbounded_channel();
    let joined = {
        let mut st = state.lock().unwrap();
        admit(&mut st, &name, &public_key, invite.as_deref(), peer).map(|()| {
            let session_id = st.next_id;
            st.next_id += 1;
            let owner = st.config.owner.as_deref() == Some(public_key.as_str());
            let user = User { session_id, name, voice_channel: None, muted: false, deafened: false, owner };
            st.broadcast(&ServerMsg::UserJoined { user: user.clone() });
            let token = rand::random();
            let client = Client {
                user,
                public_key: public_key.clone(),
                token,
                udp_addr: None,
                loopback: false,
                tx: tx.clone(),
                chat: Bucket::new(),
                last_typing: None,
                voice_window: (Instant::now(), 0),
            };
            st.clients.insert(session_id, client);
            let _ = tx.send(ServerMsg::Welcome {
                server_name: st.config.name.clone(),
                server_icon: st.config.icon.clone(),
                session_id,
                udp_token: token,
                udp_port,
                channels: st.config.channels.clone(),
                users: st.clients.values().map(|c| c.user.clone()).collect(),
            });
            for ch in st.config.channels.iter().filter(|c| c.kind == ChannelKind::Text) {
                let messages = st.history.get(&ch.id).map(|h| h.iter().cloned().collect()).unwrap_or_default();
                let _ = tx.send(ServerMsg::ChatHistory { channel: ch.id, messages });
            }
            session_id
        })
    };
    let session_id = match joined {
        Ok(id) => id,
        Err(message) => return Err(reject(&mut wr, message).await),
    };
    info!(session_id, %peer, "client joined");

    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if wr.write_all(&encode_line(&msg)).await.is_err() {
                break;
            }
        }
    });

    let result: anyhow::Result<()> = async {
        loop {
            let msg = read_msg(&mut reader, &mut line, READ_TIMEOUT).await?;
            let mut st = state.lock().unwrap();
            // Kicked while this message was in flight.
            let Some(me) = st.clients.get(&session_id) else { anyhow::bail!("kicked") };
            let is_owner = me.user.owner;
            let my_key = me.public_key.clone();
            let error = |message: &str| {
                let _ = tx.send(ServerMsg::Error { message: message.into() });
            };
            match msg {
                ClientMsg::JoinVoice { channel } => match st.channel(channel) {
                    Some(c) if c.kind == ChannelKind::Voice => st.update_user(session_id, |u| u.voice_channel = Some(channel)),
                    _ => error("That voice channel doesn't exist."),
                },
                ClientMsg::LeaveVoice => st.update_user(session_id, |u| u.voice_channel = None),
                ClientMsg::SetState { muted, deafened } => st.update_user(session_id, |u| {
                    u.muted = muted;
                    u.deafened = deafened;
                }),
                ClientMsg::SetLoopback { enabled } => {
                    st.clients.get_mut(&session_id).expect("checked above").loopback = enabled;
                }
                ClientMsg::SendChat { channel, text } => {
                    let text = text.trim();
                    if !st.channel(channel).is_some_and(|c| c.kind == ChannelKind::Text) {
                        error("That text channel doesn't exist.");
                    } else if text.is_empty() || text.chars().count() > MAX_CHAT_LEN {
                        error(&format!("Messages must be 1–{MAX_CHAT_LEN} characters."));
                    } else if !st.clients.get_mut(&session_id).expect("checked above").chat.take() {
                        error("You're sending messages too fast. Slow down a little.");
                    } else {
                        let id = st.next_message_id;
                        st.next_message_id += 1;
                        let message = ChatMessage {
                            id,
                            channel,
                            sender: session_id,
                            sender_name: st.clients[&session_id].user.name.clone(),
                            author_key: my_key,
                            text: text.to_string(),
                            sent_at: now_millis(),
                        };
                        st.post_chat(message);
                    }
                }
                ClientMsg::DeleteMessage { channel, id } => {
                    let found = st.history.get(&channel).and_then(|h| h.iter().find(|m| m.id == id)).map(|m| m.author_key == my_key);
                    match found {
                        None => error("That message no longer exists."),
                        Some(mine) if !mine && !is_owner => error("You can only delete your own messages."),
                        Some(_) => {
                            st.history.get_mut(&channel).expect("found above").retain(|m| m.id != id);
                            st.storage.append_delete(channel, id);
                            st.broadcast(&ServerMsg::MessageDeleted { channel, id });
                        }
                    }
                }
                ClientMsg::Typing { channel } => {
                    let me = st.clients.get_mut(&session_id).expect("checked above");
                    if me.last_typing.is_none_or(|t| t.elapsed() >= TYPING_INTERVAL) {
                        me.last_typing = Some(Instant::now());
                        let msg = ServerMsg::Typing { channel, session_id };
                        for c in st.clients.values().filter(|c| c.user.session_id != session_id) {
                            let _ = c.tx.send(msg.clone());
                        }
                    }
                }
                ClientMsg::CreateChannel { name, kind } => {
                    let name = normalize_channel_name(&name, kind);
                    if !is_owner {
                        error("Only the server owner can create channels.");
                    } else if name.is_empty() || name.chars().count() > MAX_NAME_LEN {
                        error(&format!("Channel names must be 1–{MAX_NAME_LEN} characters."));
                    } else if st.config.channels.len() >= MAX_CHANNELS {
                        error(&format!("A server can have at most {MAX_CHANNELS} channels."));
                    } else {
                        let id = st.config.next_channel_id;
                        st.config.next_channel_id += 1;
                        st.config.channels.push(Channel { id, name, kind });
                        st.channels_changed();
                    }
                }
                ClientMsg::DeleteChannel { channel } => {
                    if !is_owner {
                        error("Only the server owner can delete channels.");
                    } else if st.channel(channel).is_none() {
                        error("That channel doesn't exist.");
                    } else {
                        st.config.channels.retain(|c| c.id != channel);
                        st.history.remove(&channel);
                        st.storage.delete_chat(channel);
                        let in_channel: Vec<SessionId> = st
                            .clients
                            .values()
                            .filter(|c| c.user.voice_channel == Some(channel))
                            .map(|c| c.user.session_id)
                            .collect();
                        for id in in_channel {
                            st.update_user(id, |u| u.voice_channel = None);
                        }
                        st.channels_changed();
                    }
                }
                ClientMsg::Kick { session_id: target } | ClientMsg::Ban { session_id: target } => {
                    let banned = matches!(msg, ClientMsg::Ban { .. });
                    if !is_owner {
                        error("Only the server owner can remove people.");
                    } else if target == session_id {
                        error("You can't remove yourself.");
                    } else if let Some(victim) = st.clients.remove(&target) {
                        info!(target, banned, "removed by the owner");
                        if banned {
                            let ban = Ban { public_key: victim.public_key.clone(), name: victim.user.name.clone(), banned_at: now_millis() };
                            st.bans.push(ban);
                            st.storage.save_bans(&st.bans);
                            let _ = tx.send(ServerMsg::Bans { bans: st.bans.clone() });
                        }
                        let _ = victim.tx.send(ServerMsg::Kicked { banned });
                        st.broadcast(&ServerMsg::UserLeft { session_id: target });
                    } else {
                        error("That person isn't connected anymore.");
                    }
                }
                ClientMsg::Unban { public_key } if is_owner => {
                    st.bans.retain(|b| b.public_key != public_key);
                    st.storage.save_bans(&st.bans);
                    let _ = tx.send(ServerMsg::Bans { bans: st.bans.clone() });
                }
                ClientMsg::CreateInvite { max_uses, expires_in_hours } if is_owner => {
                    let created_at = now_millis();
                    let invite = Invite {
                        code: new_code(),
                        created_at,
                        expires_at: expires_in_hours.map(|h| created_at + u64::from(h) * 3_600_000),
                        max_uses,
                        uses: 0,
                    };
                    st.invites.push(invite.clone());
                    st.storage.save_invites(&st.invites);
                    let _ = tx.send(ServerMsg::InviteCreated { invite });
                    let _ = tx.send(ServerMsg::Invites { invites: st.usable_invites() });
                }
                ClientMsg::RevokeInvite { code } if is_owner => {
                    st.invites.retain(|i| i.code != code);
                    st.storage.save_invites(&st.invites);
                    let _ = tx.send(ServerMsg::Invites { invites: st.usable_invites() });
                }
                ClientMsg::GetServerSettings if is_owner => {
                    let _ = tx.send(ServerMsg::Invites { invites: st.usable_invites() });
                    let _ = tx.send(ServerMsg::Bans { bans: st.bans.clone() });
                }
                ClientMsg::UpdateServer { name, icon } if is_owner => {
                    let name = name.trim().to_string();
                    if name.is_empty() || name.chars().count() > MAX_SERVER_NAME_LEN {
                        error(&format!("Server names must be 1–{MAX_SERVER_NAME_LEN} characters."));
                    } else if icon.as_deref().is_some_and(|i| !valid_icon(i)) {
                        error("That picture can't be used. Try a PNG or JPEG image.");
                    } else {
                        st.config.name = name.clone();
                        st.config.icon = icon.clone();
                        st.storage.save_config(&st.config);
                        st.broadcast(&ServerMsg::ServerUpdated { name, icon });
                    }
                }
                ClientMsg::Unban { .. }
                | ClientMsg::CreateInvite { .. }
                | ClientMsg::RevokeInvite { .. }
                | ClientMsg::GetServerSettings
                | ClientMsg::UpdateServer { .. } => {
                    error("Only the server owner can do that.");
                }
                ClientMsg::Ping => {
                    let _ = tx.send(ServerMsg::Pong);
                }
                // Voice goes through our UDP relay; direct endpoints are for cloud servers.
                ClientMsg::VoiceEndpoint { .. } => {}
                ClientMsg::Hello { .. } | ClientMsg::Auth { .. } => {}
            }
        }
    }
    .await;

    {
        let mut st = state.lock().unwrap();
        if st.clients.remove(&session_id).is_some() {
            st.broadcast(&ServerMsg::UserLeft { session_id });
        }
    }
    // Let queued messages (such as a kick notice) reach the client before closing.
    drop(tx);
    let _ = tokio::time::timeout(Duration::from_secs(1), writer).await;
    info!(session_id, "client left");
    result
}
