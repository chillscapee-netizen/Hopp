//! The Hopp server: accounts, invites, channels, chat and a voice relay that
//! never decodes audio.

mod storage;
pub mod tls;

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
pub use storage::{Account, ServerConfig, Storage};
use strom_shared::*;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, UdpSocket};
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
    /// Encrypted connections: the key their voice is sealed with on the way (both directions).
    voice_key: Option<[u8; 32]>,
    /// Mesh voice: where this member can be reached for voice (often only a relay address).
    endpoint: Option<(Option<String>, Vec<String>)>,
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
    /// Voice goes between the members (Hopp Cloud style), not through this server's relay.
    mesh_voice: bool,
    /// Mesh voice: each voice channel's key, made new when the channel fills up again.
    voice_keys: HashMap<ChannelId, String>,
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

    /// Mesh voice: someone joined `channel`. They get its key (a new one when they're the first,
    /// so people who left can't listen in later) and how to reach those already there.
    fn introduce_voice(&mut self, session_id: SessionId, channel: ChannelId) {
        let others: Vec<PeerEndpoint> = self
            .clients
            .values()
            .filter(|c| c.user.session_id != session_id && c.user.voice_channel == Some(channel))
            .filter_map(|c| c.endpoint.clone().map(|(public, local)| PeerEndpoint { session_id: c.user.session_id, public, local }))
            .collect();
        let alone = !self.clients.values().any(|c| c.user.session_id != session_id && c.user.voice_channel == Some(channel));
        if alone || !self.voice_keys.contains_key(&channel) {
            self.voice_keys.insert(channel, hex::encode(rand::random::<[u8; 32]>()));
        }
        let key = self.voice_keys[&channel].clone();
        if let Some(c) = self.clients.get_mut(&session_id) {
            c.endpoint = None;
            let _ = c.tx.send(ServerMsg::VoiceSession { channel, key, peers: others });
        }
    }

    /// Mesh voice: where a member can be reached; passed on to the others in their channel.
    fn voice_endpoint(&mut self, session_id: SessionId, public: Option<String>, local: Vec<String>) {
        let valid = |a: &String| a.len() <= 64 && a.parse::<SocketAddr>().is_ok();
        let public = public.filter(valid);
        let local: Vec<String> = local.into_iter().filter(valid).take(8).collect();
        let Some(channel) = self.clients.get(&session_id).and_then(|c| c.user.voice_channel) else { return };
        if let Some(c) = self.clients.get_mut(&session_id) {
            c.endpoint = Some((public.clone(), local.clone()));
        }
        let peer = PeerEndpoint { session_id, public, local };
        for c in self.clients.values().filter(|c| c.user.session_id != session_id && c.user.voice_channel == Some(channel)) {
            let _ = c.tx.send(ServerMsg::VoicePeer { peer: peer.clone() });
        }
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
///
/// With `tls`, connections from other computers must be encrypted (TLS 1.3, the server known by
/// its key); plain ones are only taken from this computer itself (and in tests, without `tls`).
pub async fn run(tcp: TcpListener, udp: UdpSocket, default_config: ServerConfig, storage: Storage, tls: Option<tls::Tls>) -> anyhow::Result<()> {
    let server = Server::start(Some(udp), default_config, storage, tls, false)?;
    loop {
        let (stream, addr) = tcp.accept().await?;
        server.serve_tcp(stream, addr);
    }
}

/// A running server. Connections reach it over TCP (`serve_tcp`), or through Hopp Cloud's
/// tunnel (`serve_tunneled`) when it's hosted out of sight: then nobody connects to the
/// computer it runs on, and its address stays private.
pub struct Server {
    state: Shared,
    acceptor: Option<tokio_rustls::TlsAcceptor>,
    udp_port: u16,
}

impl Server {
    /// Loads the server from `storage` (`default_config` only when it holds none yet) and starts
    /// it. With `udp`, voice goes through the server's own relay; with `mesh_voice` (and no
    /// UDP), voice goes between the members (through Hopp's relay when their addresses are
    /// hidden), as on Hopp Cloud, and the server only introduces them.
    pub fn start(udp: Option<UdpSocket>, default_config: ServerConfig, storage: Storage, tls: Option<tls::Tls>, mesh_voice: bool) -> anyhow::Result<Arc<Server>> {
        let udp_port = match &udp {
            Some(u) if !mesh_voice => u.local_addr()?.port(),
            _ => 0,
        };
        let config = match storage.load_config() {
            Some(c) => c,
            None => {
                storage.save_config(&default_config);
                default_config
            }
        };
        let mut history = HashMap::new();
        let mut next_message_id = 1;
        // Text channels, and voice channels' own chat.
        for c in &config.channels {
            storage.compact_chat(c.id);
            let (messages, max_id) = storage.load_chat(c.id, CHAT_HISTORY);
            next_message_id = next_message_id.max(max_id + 1);
            history.insert(c.id, messages);
        }
        let setup_code = config.owner.is_none().then(new_code);
        let pin = tls.as_ref().map(|t| t.pin.clone());
        if let Some(pin) = &pin {
            info!("connections are encrypted; this server's key: {pin}");
        }
        let at = pin.as_ref().map(|p| format!("{p}@")).unwrap_or_default();
        if let Some(code) = &setup_code {
            info!("this server has no owner yet. Connect from this computer to become the owner,");
            info!("or from another computer with the invite link hopp://{at}<address>/{code}");
        }
        let acceptor = tls.map(|t| t.acceptor);
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
            mesh_voice,
            voice_keys: HashMap::new(),
        }));
        if let (Some(udp), false) = (udp, mesh_voice) {
            tokio::spawn(relay_voice(udp, state.clone()));
        }
        Ok(Arc::new(Server { state, acceptor, udp_port }))
    }

    /// A connection over TCP: encrypted, or plain only from this computer.
    pub fn serve_tcp(self: &Arc<Self>, stream: tokio::net::TcpStream, addr: SocketAddr) {
        if self.state.lock().unwrap().throttled(addr.ip()) {
            warn!(%addr, "too many connection attempts, dropping");
            return;
        }
        let server = self.clone();
        tokio::spawn(async move {
            let result = async {
                stream.set_nodelay(true)?;
                // A TLS hello starts with 0x16; anything else is the old plain protocol.
                let mut first = [0u8; 1];
                let n = tokio::time::timeout(HANDSHAKE_TIMEOUT, stream.peek(&mut first)).await??;
                anyhow::ensure!(n == 1, "client disconnected");
                match &server.acceptor {
                    Some(acceptor) if first[0] == 0x16 => {
                        let stream = tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await??;
                        let key = stream.get_ref().1.export_keying_material([0u8; 32], VOICE_KEY_LABEL, None)?;
                        handle_client(stream, addr, server.state.clone(), server.udp_port, Some(key)).await
                    }
                    // Unencrypted: only from this computer (or when the server has no key, in tests).
                    _ if server.acceptor.is_none() || addr.ip().is_loopback() => handle_client(stream, addr, server.state.clone(), server.udp_port, None).await,
                    _ => {
                        let mut stream = stream;
                        Err(reject(&mut stream, "This server only takes encrypted connections. Update Hopp to join.").await)
                    }
                }
            }
            .await;
            if let Err(e) = result {
                info!(%addr, "connection closed: {e}");
            }
        });
    }

    /// A connection that came through the tunnel (`conn` numbers it). Always encrypted, end to
    /// end: the tunnel only passes sealed bytes. Its address is a stand-in (198.18.x.x), never
    /// this computer's, so nobody becomes owner this way.
    pub fn serve_tunneled<S>(self: &Arc<Self>, stream: S, conn: u32)
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let addr = SocketAddr::from(([198, 18, (conn >> 8) as u8, conn as u8], 0));
        let server = self.clone();
        tokio::spawn(async move {
            let result = async {
                let acceptor = server.acceptor.as_ref().ok_or_else(|| anyhow::anyhow!("a tunneled server needs its key"))?;
                let stream = tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await??;
                let key = stream.get_ref().1.export_keying_material([0u8; 32], VOICE_KEY_LABEL, None)?;
                handle_client(stream, addr, server.state.clone(), server.udp_port, Some(key)).await
            }
            .await;
            if let Err(e) = result {
                info!(conn, "tunneled connection closed: {e}");
            }
        });
    }
}

async fn relay_voice(udp: UdpSocket, state: Shared) {
    let mut buf = vec![0u8; 1500];
    let mut out = Vec::with_capacity(1500);
    let mut targets: Vec<(SocketAddr, Option<[u8; 32]>)> = Vec::new();
    let mut plain = Vec::new();
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
        let mut voice: Option<(SessionId, u32)> = None;
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
                    targets.push((from, None));
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
                    if sender.user.muted || sender.user.deafened || sender.user.server_muted || sender.user.server_deafened {
                        continue;
                    }
                    // Sealed on the way here: opened with the sender's key (a frame that doesn't open is dropped).
                    plain.clear();
                    match &sender.voice_key {
                        Some(key) => match open_voice(key, session_id, seq, opus) {
                            Some(frame) => plain.extend_from_slice(&frame),
                            None => continue,
                        },
                        None => plain.extend_from_slice(opus),
                    }
                    voice = Some((session_id, seq));
                    targets.extend(st.clients.values().filter_map(|c| {
                        let is_sender = c.user.session_id == session_id;
                        let listening =
                            (!is_sender || c.loopback) && c.user.voice_channel == Some(channel) && !c.user.deafened && !c.user.server_deafened;
                        if listening { c.udp_addr.map(|a| (a, c.voice_key)) } else { None }
                    }));
                }
            }
        }
        for (addr, key) in &targets {
            // Voice goes to each listener sealed with that listener's own key.
            if let Some((sender, seq)) = voice {
                match key {
                    Some(key) => ServerVoice { sender, seq, opus: &seal_voice(key, sender, seq, &plain) }.write(&mut out),
                    None => ServerVoice { sender, seq, opus: &plain }.write(&mut out),
                }
            }
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

async fn reject<W: AsyncWrite + Unpin>(wr: &mut W, message: impl Into<String>) -> anyhow::Error {
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

async fn handle_client<S>(stream: S, peer: SocketAddr, state: Shared, udp_port: u16, voice_key: Option<[u8; 32]>) -> anyhow::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (rd, mut wr) = tokio::io::split(stream);
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
            let user = User { session_id, name, voice_channel: None, muted: false, deafened: false, owner, public_key: public_key.clone(), role: None, sharing: false, server_muted: false, server_deafened: false, timed_out_until: None, roles: vec![] };
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
                voice_key,
                endpoint: None,
            };
            st.clients.insert(session_id, client);
            let _ = tx.send(ServerMsg::Welcome {
                server_name: st.config.name.clone(),
                server_icon: st.config.icon.clone(),
                pictures_off: false,
                features: vec!["search".into(), "screen".into(), "voice-chat".into(), "voice-mod".into(), "voice-settings".into(), "resync".into()],
                roles: vec![],
                emojis: vec![],
                session_id,
                udp_token: token,
                udp_port,
                channels: st.config.channels.clone(),
                users: st.clients.values().map(|c| c.user.clone()).collect(),
            });
            for ch in &st.config.channels {
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
                    Some(c) if c.kind == ChannelKind::Voice && c.user_limit.is_some_and(|l| st.clients.values().filter(|o| o.user.voice_channel == Some(channel) && o.user.session_id != session_id).count() >= l as usize) => {
                        error(&format!("{} is full.", c.name));
                    }
                    Some(c) if c.kind == ChannelKind::Voice => {
                        st.update_user(session_id, |u| {
                            u.voice_channel = Some(channel);
                            u.sharing = false;
                        });
                        if st.mesh_voice {
                            st.introduce_voice(session_id, channel);
                        }
                    }
                    _ => error("That voice channel doesn't exist."),
                },
                ClientMsg::LeaveVoice => st.update_user(session_id, |u| {
                    u.voice_channel = None;
                    u.sharing = false;
                }),
                ClientMsg::SetSharing { on } => {
                    let in_voice = st.clients.get(&session_id).is_some_and(|c| c.user.voice_channel.is_some());
                    if on && !in_voice {
                        error("Join a voice channel to share your screen.");
                    } else {
                        st.update_user(session_id, |u| u.sharing = on);
                    }
                }
                ClientMsg::ScreenSignal { to, data } => {
                    let mine = st.clients.get(&session_id).and_then(|c| c.user.voice_channel);
                    let theirs = st.clients.get(&to).and_then(|c| c.user.voice_channel);
                    // Only between people in the same voice channel, and never huge.
                    if mine.is_some() && mine == theirs && to != session_id && data.len() <= MAX_SCREEN_SIGNAL {
                        if let Some(c) = st.clients.get(&to) {
                            let _ = c.tx.send(ServerMsg::ScreenSignal { from: session_id, data });
                        }
                    }
                }
                ClientMsg::SetState { muted, deafened } => st.update_user(session_id, |u| {
                    u.muted = muted;
                    u.deafened = deafened;
                }),
                ClientMsg::SetLoopback { enabled } => {
                    st.clients.get_mut(&session_id).expect("checked above").loopback = enabled;
                }
                ClientMsg::SendChat { channel, text, reply_to } => {
                    let text = text.trim();
                    if st.channel(channel).is_none() {
                        error("That channel doesn't exist.");
                    } else if text.is_empty() || text.chars().count() > MAX_CHAT_LEN {
                        error(&format!("Messages must be 1–{MAX_CHAT_LEN} characters."));
                    } else if !st.clients.get_mut(&session_id).expect("checked above").chat.take() {
                        error("You're sending messages too fast. Slow down a little.");
                    } else {
                        let id = st.next_message_id;
                        st.next_message_id += 1;
                        let reply = reply_to.and_then(|rid| {
                            let m = st.history.get(&channel)?.iter().find(|m| m.id == rid)?;
                            Some(Reply { id: m.id, sender_name: m.sender_name.clone(), author_key: m.author_key.clone(), text: reply_preview(&m.text) })
                        });
                        let message = ChatMessage {
                            id,
                            channel,
                            sender: session_id,
                            sender_name: st.clients[&session_id].user.name.clone(),
                            author_key: my_key,
                            text: text.to_string(),
                            sent_at: now_millis(),
                            reply,
                            edited_at: None,
                            reactions: Vec::new(),
                            pinned: false,
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
                ClientMsg::EditMessage { channel, id, text } => {
                    let text = text.trim().to_string();
                    if text.is_empty() || text.chars().count() > MAX_CHAT_LEN {
                        error(&format!("Messages must be 1–{MAX_CHAT_LEN} characters."));
                    } else {
                        let edited = st.history.get_mut(&channel).and_then(|h| h.iter_mut().find(|m| m.id == id)).map(|m| {
                            if m.author_key != my_key {
                                return Err("You can only edit your own messages.");
                            }
                            m.text = text.clone();
                            m.edited_at = Some(now_millis());
                            Ok(m.clone())
                        });
                        match edited {
                            None => error("That message is too old to change."),
                            Some(Err(why)) => error(why),
                            Some(Ok(m)) => {
                                st.storage.append_chat(&m);
                                st.broadcast(&ServerMsg::MessageEdited { channel, id, text, edited_at: m.edited_at.unwrap_or_default() });
                            }
                        }
                    }
                }
                ClientMsg::React { channel, id, emoji, on } => {
                    if !valid_emoji(&emoji) {
                        error("That isn't an emoji.");
                    } else {
                        let changed = st.history.get_mut(&channel).and_then(|h| h.iter_mut().find(|m| m.id == id)).map(|m| {
                            if !toggle_reaction(&mut m.reactions, &emoji, &my_key, on) {
                                return Err("That message has too many different reactions.");
                            }
                            Ok(m.clone())
                        });
                        match changed {
                            None => error("That message is too old to react to."),
                            Some(Err(why)) => error(why),
                            Some(Ok(m)) => {
                                st.storage.append_chat(&m);
                                st.broadcast(&ServerMsg::Reactions { channel, id, reactions: m.reactions });
                            }
                        }
                    }
                }
                ClientMsg::Pin { channel, id, on } => {
                    if !is_owner {
                        error("Only the server owner can pin messages.");
                    } else {
                        let pinned = st.history.get_mut(&channel).and_then(|h| h.iter_mut().find(|m| m.id == id)).map(|m| {
                            m.pinned = on;
                            m.clone()
                        });
                        match pinned {
                            None => error("That message is too old to pin."),
                            Some(m) => {
                                st.storage.append_chat(&m);
                                st.broadcast(&ServerMsg::Pinned { channel, id, on });
                            }
                        }
                    }
                }
                ClientMsg::GetPins { channel } => {
                    let all = st.storage.load_before(channel, u64::MAX, 100_000).unwrap_or_else(|| st.history.get(&channel).map(|h| h.iter().cloned().collect()).unwrap_or_default());
                    let messages = all.into_iter().filter(|m| m.pinned).collect();
                    let _ = tx.send(ServerMsg::Pins { channel, messages });
                }
                ClientMsg::Search { query } => {
                    let needle = query.trim().to_lowercase();
                    let mut messages = Vec::new();
                    if (2..=100).contains(&needle.chars().count()) {
                        let text: Vec<ChannelId> = st.config.channels.iter().map(|c| c.id).collect();
                        for channel in text {
                            let all = st.storage.load_before(channel, u64::MAX, 100_000).unwrap_or_else(|| st.history.get(&channel).map(|h| h.iter().cloned().collect()).unwrap_or_default());
                            messages.extend(all.into_iter().filter(|m| m.text.to_lowercase().contains(&needle)));
                        }
                        messages.sort_by_key(|m| std::cmp::Reverse(m.id));
                        messages.truncate(SEARCH_RESULTS);
                    }
                    let _ = tx.send(ServerMsg::SearchResults { query, messages });
                }
                ClientMsg::LoadOlder { channel, before } => {
                    let mut messages = st.storage.load_before(channel, before, OLDER_PAGE + 1).unwrap_or_else(|| {
                        let h = st.history.get(&channel).map(|h| h.iter().filter(|m| m.id < before).cloned().collect::<Vec<_>>()).unwrap_or_default();
                        h[h.len().saturating_sub(OLDER_PAGE + 1)..].to_vec()
                    });
                    let done = messages.len() <= OLDER_PAGE;
                    if !done {
                        messages.remove(0);
                    }
                    let _ = tx.send(ServerMsg::OlderHistory { channel, messages, done });
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
                        st.config.channels.push(Channel { id, name, kind, topic: None, category: None, no_pictures: false, user_limit: None, afk_after: None, slowmode: None, private_roles: None, parent: None, starter: None, last_at: None });
                        st.channels_changed();
                    }
                }
                ClientMsg::UpdateChannel { channel, name, topic, category, user_limit, afk_after, .. } => {
                    let category = category.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
                    let kind = st.channel(channel).map(|c| c.kind);
                    let name = kind.map(|k| normalize_channel_name(&name, k)).unwrap_or_default();
                    let topic = topic.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
                    if !is_owner {
                        error("Only the server owner can change channels.");
                    } else if kind.is_none() {
                        error("That channel doesn't exist.");
                    } else if name.is_empty() || name.chars().count() > MAX_NAME_LEN {
                        error(&format!("Channel names must be 1–{MAX_NAME_LEN} characters."));
                    } else if topic.as_ref().is_some_and(|t| t.chars().count() > MAX_TOPIC_LEN) {
                        error(&format!("Keep the topic under {MAX_TOPIC_LEN} characters."));
                    } else if category.as_ref().is_some_and(|t| t.chars().count() > MAX_CATEGORY_LEN) {
                        error(&format!("Category names are at most {MAX_CATEGORY_LEN} characters."));
                    } else {
                        let c = st.config.channels.iter_mut().find(|c| c.id == channel).expect("checked above");
                        c.name = name;
                        c.topic = topic;
                        c.category = category;
                        if c.kind == ChannelKind::Voice {
                            if let Some(limit) = user_limit {
                                c.user_limit = (limit > 0).then_some(limit.min(99));
                            }
                        }
                        let is_voice = c.kind == ChannelKind::Voice;
                        // One AFK channel at most.
                        if let (true, Some(minutes)) = (is_voice, afk_after) {
                            for other in st.config.channels.iter_mut() {
                                other.afk_after = None;
                            }
                            let c = st.config.channels.iter_mut().find(|c| c.id == channel).expect("checked above");
                            c.afk_after = (minutes > 0).then_some(minutes.clamp(1, 240));
                        }
                        st.channels_changed();
                    }
                }
                ClientMsg::ReorderChannels { order } => {
                    let mut sorted = order.clone();
                    sorted.sort_unstable();
                    let mut ids: Vec<ChannelId> = st.config.channels.iter().map(|c| c.id).collect();
                    ids.sort_unstable();
                    if !is_owner {
                        error("Only the server owner can move channels.");
                    } else if sorted != ids {
                        error("The channels changed meanwhile. Try again.");
                    } else {
                        st.config.channels.sort_by_key(|c| order.iter().position(|id| *id == c.id));
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
                ClientMsg::DisconnectVoice { session_id: target } | ClientMsg::MoveVoice { session_id: target, .. } | ClientMsg::ServerMute { session_id: target, .. } => {
                    // Self-hosted servers have one moderator: the owner.
                    let in_voice = st.clients.get(&target).map(|c| c.user.voice_channel.is_some());
                    if !is_owner {
                        error("Only the server owner can do that.");
                    } else if in_voice.is_none() {
                        error("That person isn't connected anymore.");
                    } else {
                        match msg {
                            ClientMsg::ServerMute { muted, deafened, .. } => st.update_user(target, |u| {
                                u.server_muted = muted;
                                u.server_deafened = deafened;
                            }),
                            _ if in_voice != Some(true) => error("They aren't in a voice channel."),
                            ClientMsg::DisconnectVoice { .. } => st.update_user(target, |u| {
                                u.voice_channel = None;
                                u.sharing = false;
                            }),
                            ClientMsg::MoveVoice { channel, .. } => match st.channel(channel) {
                                Some(c) if c.kind == ChannelKind::Voice => st.update_user(target, |u| {
                                    u.voice_channel = Some(channel);
                                    u.sharing = false;
                                }),
                                _ => error("That voice channel doesn't exist."),
                            },
                            _ => {}
                        }
                    }
                }
                ClientMsg::Timeout { .. }
                | ClientMsg::GetAuditLog
                | ClientMsg::CreateRole { .. }
                | ClientMsg::UpdateRole { .. }
                | ClientMsg::DeleteRole { .. }
                | ClientMsg::CreateThread { .. }
                | ClientMsg::CreateEmoji { .. }
                | ClientMsg::DeleteEmoji { .. }
                | ClientMsg::ReorderRoles { .. }
                | ClientMsg::AssignRole { .. }
                | ClientMsg::SetNickname { .. } => error("This server doesn't have that yet."),
                ClientMsg::Kick { session_id: target, .. } | ClientMsg::Ban { session_id: target, .. } => {
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
                ClientMsg::SetRole { .. } | ClientMsg::TransferOwnership { .. } | ClientMsg::GetMembers => {
                    error("Roles are only on Hopp Cloud servers.");
                }
                ClientMsg::DeleteServer => {
                    if is_owner {
                        error("This server runs on a computer, not in Hopp Cloud. To delete it, stop the server program and remove its data folder.");
                    } else {
                        error("Only the server owner can do that.");
                    }
                }
                ClientMsg::LeaveServer => {
                    if is_owner {
                        error("You own this server, so you can't leave it.");
                    } else {
                        st.clients.remove(&session_id);
                        st.accounts.remove(&my_key);
                        st.storage.save_accounts(&st.accounts);
                        let _ = tx.send(ServerMsg::Left);
                        st.broadcast(&ServerMsg::UserLeft { session_id });
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
                ClientMsg::UpdateServer { name, icon, .. } if is_owner => {
                    let name = name.trim().to_string();
                    if name.is_empty() || name.chars().count() > MAX_SERVER_NAME_LEN {
                        error(&format!("Server names must be 1–{MAX_SERVER_NAME_LEN} characters."));
                    } else if icon.as_deref().is_some_and(|i| !valid_icon(i)) {
                        error("That picture can't be used. Try a PNG or JPEG image.");
                    } else {
                        st.config.name = name.clone();
                        st.config.icon = icon.clone();
                        st.storage.save_config(&st.config);
                        st.broadcast(&ServerMsg::ServerUpdated { name, icon, pictures_off: false });
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
                ClientMsg::Resync => {
                    for ch in &st.config.channels {
                        let messages = st.history.get(&ch.id).map(|h| h.iter().cloned().collect()).unwrap_or_default();
                        let _ = tx.send(ServerMsg::ChatHistory { channel: ch.id, messages });
                    }
                }
                // Voice goes through our UDP relay; direct endpoints are for cloud servers.
                ClientMsg::VoiceEndpoint { public, local } => {
                    if st.mesh_voice {
                        st.voice_endpoint(session_id, public, local);
                    }
                }
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
