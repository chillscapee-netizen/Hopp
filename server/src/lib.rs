//! The Hopp server for someone's own computer. It behaves exactly like a server in Hopp Cloud
//! (the rules are in `core`, carried over from the cloud's server line by line); this file is how
//! people reach it: TCP with TLS 1.3, Hopp Cloud's tunnel (so its address stays private), and
//! voice through its own UDP relay or between the members as on Hopp Cloud.

mod core;
mod storage;
pub mod tls;

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub use crate::core::{ConnId, Core, Out};
pub use storage::{Account, ServerConfig, Storage};
use strom_shared::*;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, UdpSocket};
use tokio::sync::mpsc;
use tracing::{info, warn};

/// A picture (up to 320 KB) in base64 inside a message, with room to spare.
const MAX_LINE: u64 = 600_000;
/// Apps ping every 10 seconds; a connection silent this long is gone (one that comes back
/// sooner from the same person replaces it right away).
const READ_TIMEOUT: Duration = Duration::from_secs(90);
/// Logging in must not take longer than this.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// New connections allowed per IP address per minute.
const MAX_ATTEMPTS_PER_MINUTE: u32 = 20;
/// Normal speech is 100 packets per second.
const MAX_VOICE_PACKETS_PER_SECOND: u32 = 200;

pub type Shared = Arc<Mutex<Core>>;

/// Runs the server on already-bound sockets until the TCP listener fails.
///
/// `default_config` is used only when `storage` holds no server yet.
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

/// A running server. Connections reach it over TCP (`serve_tcp`), through Hopp Cloud's tunnel
/// (`serve_tunneled`) when it's hosted out of sight, or as lines and frames from anything else
/// (`serve_lines`, `serve_frames`).
pub struct Server {
    core: Shared,
    acceptor: Option<tokio_rustls::TlsAcceptor>,
    attempts: Mutex<HashMap<IpAddr, (Instant, u32)>>,
}

impl Server {
    /// Loads the server from `storage` (made from `default_config` when it holds none yet) and
    /// starts it. With `udp`, voice goes through the server's own relay; with `mesh_voice` (and no
    /// UDP), voice goes between the members (through Hopp's relay when their addresses are
    /// hidden), as on Hopp Cloud, and the server only introduces them.
    pub fn start(udp: Option<UdpSocket>, default_config: ServerConfig, storage: Storage, tls: Option<tls::Tls>, mesh_voice: bool) -> anyhow::Result<Arc<Server>> {
        let udp_port = match &udp {
            Some(u) if !mesh_voice => u.local_addr()?.port(),
            _ => 0,
        };
        let mut core = Core::new(storage.open_db()?, mesh_voice || udp.is_none(), udp_port)?;
        if storage.import_legacy(&mut core)? {
            info!("moved the server's data into its database");
        }
        let channels: Vec<(&str, &str)> = default_config.channels.iter().map(|c| (c.name.as_str(), if c.kind == ChannelKind::Voice { "voice" } else { "text" })).collect();
        core.create_unowned(&default_config.name, &channels);
        let pin = tls.as_ref().map(|t| t.pin.clone());
        if let Some(pin) = &pin {
            info!("connections are encrypted; this server's key: {pin}");
        }
        if let Some(code) = &core.setup_code {
            let at = pin.as_ref().map(|p| format!("{p}@")).unwrap_or_default();
            info!("this server has no owner yet. Connect from this computer to become the owner,");
            info!("or from another computer with the invite link hopp://{at}<address>/{code}");
        }
        let core = Arc::new(Mutex::new(core));
        if let (Some(udp), false) = (udp, mesh_voice) {
            tokio::spawn(relay_voice(udp, core.clone()));
        }
        Ok(Arc::new(Server { core, acceptor: tls.map(|t| t.acceptor), attempts: Mutex::new(HashMap::new()) }))
    }

    /// The server's rules and data, for the test server and anything that drives it directly.
    pub fn core(&self) -> &Shared {
        &self.core
    }

    /// Stops serving: everyone connected is let go (new connections are the caller's to stop).
    pub fn shutdown(&self) {
        self.core.lock().unwrap().hang_up_all();
    }

    /// Too many connection attempts from one address in the last minute?
    fn throttled(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let mut attempts = self.attempts.lock().unwrap();
        if attempts.len() > 10_000 {
            attempts.retain(|_, (since, _)| now.duration_since(*since) <= Duration::from_secs(60));
        }
        let entry = attempts.entry(ip).or_insert((now, 0));
        if now.duration_since(entry.0) > Duration::from_secs(60) {
            *entry = (now, 0);
        }
        entry.1 += 1;
        entry.1 > MAX_ATTEMPTS_PER_MINUTE
    }

    /// A connection over TCP: encrypted, or plain only from this computer.
    pub fn serve_tcp(self: &Arc<Self>, stream: tokio::net::TcpStream, addr: SocketAddr) {
        if self.throttled(addr.ip()) {
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
                let local = addr.ip().is_loopback();
                match &server.acceptor {
                    Some(acceptor) if first[0] == 0x16 => {
                        let stream = tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await??;
                        let key = stream.get_ref().1.export_keying_material([0u8; 32], VOICE_KEY_LABEL, None)?;
                        serve_lines(stream, server.core.clone(), local, Some(key)).await;
                        Ok(())
                    }
                    // Unencrypted: only from this computer (or when the server has no key, in tests).
                    _ if server.acceptor.is_none() || local => {
                        serve_lines(stream, server.core.clone(), local, None).await;
                        Ok(())
                    }
                    _ => {
                        let mut stream = stream;
                        let refusal = encode_line(&ServerMsg::Error { message: "This server only takes encrypted connections. Update Hopp to join.".into() });
                        let _ = stream.write_all(&refusal).await;
                        anyhow::bail!("unencrypted connection refused")
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
    /// end: the tunnel only passes sealed bytes. Nobody becomes owner this way.
    pub fn serve_tunneled<S>(self: &Arc<Self>, stream: S, conn: u32)
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let server = self.clone();
        tokio::spawn(async move {
            let result = async {
                let acceptor = server.acceptor.as_ref().ok_or_else(|| anyhow::anyhow!("a tunneled server needs its key"))?;
                let stream = tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(stream)).await??;
                let key = stream.get_ref().1.export_keying_material([0u8; 32], VOICE_KEY_LABEL, None)?;
                serve_lines(stream, server.core.clone(), false, Some(key)).await;
                anyhow::Ok(())
            }
            .await;
            if let Err(e) = result {
                info!(conn, "tunneled connection closed: {e}");
            }
        });
    }
}

/// Serves one connection of JSON lines until it ends.
pub async fn serve_lines<S>(stream: S, core: Shared, local: bool, voice_key: Option<[u8; 32]>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (rd, mut wr) = tokio::io::split(stream);
    let (tx, mut rx) = mpsc::unbounded_channel();
    let conn = core.lock().unwrap().open(tx, local, voice_key);
    let writer = tokio::spawn(async move {
        while let Some(out) = rx.recv().await {
            match out {
                Out::Text(mut text) => {
                    text.push('\n');
                    if wr.write_all(text.as_bytes()).await.is_err() {
                        break;
                    }
                }
                Out::Close => break,
            }
        }
        let _ = wr.shutdown().await;
    });
    let mut reader = BufReader::new(rd);
    let mut line = String::new();
    loop {
        let wait = if core.lock().unwrap().is_joined(conn) { READ_TIMEOUT } else { HANDSHAKE_TIMEOUT };
        line.clear();
        let read = tokio::time::timeout(wait, (&mut reader).take(MAX_LINE).read_line(&mut line)).await;
        let ok = matches!(read, Ok(Ok(n)) if n > 0) && line.ends_with('\n');
        let mut c = core.lock().unwrap();
        if !ok || c.is_gone(conn) {
            break;
        }
        c.message_in(conn, line.trim_end());
        if c.is_gone(conn) {
            break;
        }
    }
    core.lock().unwrap().close(conn);
    // Let what's queued (such as a kick notice) reach them before closing.
    let _ = tokio::time::timeout(Duration::from_secs(1), writer).await;
}

/// Serves one connection of whole messages (a WebSocket, in the test server) until it ends:
/// `incoming` gives each message, `outgoing` takes the answers.
pub async fn serve_frames(core: Shared, mut incoming: mpsc::UnboundedReceiver<String>, outgoing: mpsc::UnboundedSender<Out>) {
    let conn = core.lock().unwrap().open(outgoing, false, None);
    loop {
        let wait = if core.lock().unwrap().is_joined(conn) { READ_TIMEOUT } else { HANDSHAKE_TIMEOUT };
        let Ok(Some(text)) = tokio::time::timeout(wait, incoming.recv()).await else { break };
        let mut c = core.lock().unwrap();
        if c.is_gone(conn) {
            break;
        }
        c.message_in(conn, &text);
        if c.is_gone(conn) {
            break;
        }
    }
    core.lock().unwrap().close(conn);
}

/// Voice through the server itself (servers on a computer with a UDP port): each frame is
/// opened with its sender's key and sealed again with each listener's.
async fn relay_voice(udp: UdpSocket, core: Shared) {
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
            let mut c = core.lock().unwrap();
            let channel = {
                let Some(sender) = c.relay_view(session_id) else { continue };
                if sender.token != token {
                    continue;
                }
                *sender.udp_addr = Some(from);
                match pkt {
                    ClientPacket::Ping { .. } => {
                        // Echo pings so the client can measure round-trip time.
                        out.clear();
                        out.extend_from_slice(&buf[..len]);
                        targets.push((from, None));
                        None
                    }
                    ClientPacket::Voice { seq, opus, .. } => {
                        let (window, count) = sender.voice_window;
                        if window.elapsed() >= Duration::from_secs(1) {
                            *window = Instant::now();
                            *count = 0;
                        }
                        *count += 1;
                        let u = sender.user;
                        if *count > MAX_VOICE_PACKETS_PER_SECOND || u.muted || u.deafened || u.server_muted || u.server_deafened || u.timed_out_until.is_some() {
                            continue;
                        }
                        let Some(channel) = u.voice_channel else { continue };
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
                        Some(channel)
                    }
                }
            };
            if let Some(channel) = channel {
                for (sid, at, deaf, addr, key, loopback) in c.relay_listeners() {
                    let is_sender = sid == session_id;
                    if (!is_sender || loopback) && at == Some(channel) && !deaf {
                        if let Some(addr) = addr {
                            targets.push((addr, key));
                        }
                    }
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
