//! Peer-to-peer voice for cloud servers, which have no voice relay.
//!
//! Everyone in a voice channel sends their voice straight to everyone else.
//! Each client asks a public STUN server which address its router gives it,
//! and the cloud server passes those addresses (plus ones on the local
//! network) around the channel. Peers then probe each other's addresses until
//! one answers; probing from both sides opens a path through most home routers.
//!
//! The socket speaks IPv4 and IPv6 at once. IPv6 matters: the networks that make
//! direct voice hard (mobile data, carrier-grade NAT) usually have IPv6, where
//! computers reach each other without a router translating addresses.
//!
//! Packets are encrypted and authenticated with the channel's key, which only
//! members of the channel get from the server:
//! kind (1) | sender (4) | salt (4) | counter (4) | ciphertext | tag (16).
//! The header is authenticated too; the nonce is salt, counter and sender.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv6Addr, SocketAddr, ToSocketAddrs, UdpSocket};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chacha20poly1305::aead::{AeadInPlace, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Nonce, Tag};
use strom_shared::{PeerEndpoint, SessionId};

use crate::turn::{State as TurnState, Turn};

pub const KIND_VOICE: u8 = 0x10;
pub const KIND_PING: u8 = 0x11;
pub const KIND_PONG: u8 = 0x12;
/// Voice with earlier frames repeated inside, for networks that lose packets.
/// Only sent to peers whose pings show they understand it.
pub const KIND_VOICE_RED: u8 = 0x13;
/// Our pings carry this after the nonce, then loss reports; older Hopp sends the nonce alone.
const PING_FORMAT: u8 = 1;
/// A loss report older than this no longer steers how we send.
const LOSS_REPORT_FRESH: Duration = Duration::from_secs(5);
/// Frames a loss measurement spans before it counts (a quarter second of talking).
const LOSS_WINDOW: u32 = 25;
const HEADER: usize = 1 + 4 + 4 + 4;
const TAG: usize = 16;

/// Free public STUN servers; the first that answers wins.
const STUN_SERVERS: &[&str] = &["stun.cloudflare.com:3478", "stun.l.google.com:19302"];
const STUN_MAGIC: [u8; 4] = [0x21, 0x12, 0xA4, 0x42];

/// Unanswered peers are probed this often, on every address we know.
const PROBE_INTERVAL: Duration = Duration::from_millis(200);
/// Connected peers are pinged this often, to keep the routers' mappings open.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(1);
/// A path we haven't heard on for this long is dropped and probing starts over.
const PATH_TIMEOUT: Duration = Duration::from_secs(5);
/// A peer we haven't reached in this long is reported as unreachable (their network blocks direct voice).
const UNREACHABLE_AFTER: Duration = Duration::from_secs(8);
/// After either side's addresses change, every address is probed this long alongside the
/// current path, so a new way through opens at once instead of after the old path times out.
const REPROBE_FOR: Duration = Duration::from_secs(3);
/// A STUN question unanswered this long goes to the next server (three tries in all).
const STUN_RETRY: Duration = Duration::from_millis(500);
const STUN_TRIES: u8 = 3;

/// A UDP socket for both IPv4 and IPv6 (one port), or IPv4 only where IPv6 is off.
pub fn dual_stack_socket() -> std::io::Result<UdpSocket> {
    use socket2::{Domain, Protocol, Socket, Type};
    let dual = Socket::new(Domain::IPV6, Type::DGRAM, Some(Protocol::UDP)).and_then(|s| {
        s.set_only_v6(false)?;
        s.bind(&SocketAddr::from((Ipv6Addr::UNSPECIFIED, 0)).into())?;
        Ok(s)
    });
    match dual {
        Ok(s) => Ok(s.into()),
        Err(e) => {
            tracing::info!("no IPv6 on this computer ({e}); voice uses IPv4 only");
            UdpSocket::bind("0.0.0.0:0")
        }
    }
}

/// Whether a socket is the dual-stack kind (IPv4 addresses then go out IPv4-mapped).
pub fn is_dual(socket: &UdpSocket) -> bool {
    socket.local_addr().is_ok_and(|a| a.is_ipv6())
}

/// The address to hand the socket: IPv4 written as IPv4-mapped IPv6 on a dual-stack socket.
pub fn wire(addr: SocketAddr, dual: bool) -> SocketAddr {
    match addr {
        SocketAddr::V4(v4) if dual => SocketAddr::new(IpAddr::V6(v4.ip().to_ipv6_mapped()), v4.port()),
        other => other,
    }
}

/// The plain form of an address a socket reported (IPv4-mapped back to IPv4).
pub fn canonical(addr: SocketAddr) -> SocketAddr {
    SocketAddr::new(addr.ip().to_canonical(), addr.port())
}

/// This computer's own IPv6 address on the internet, if it has one.
pub fn global_ipv6() -> Option<Ipv6Addr> {
    // Connecting a UDP socket sends nothing; it only picks the outgoing address.
    let socket = UdpSocket::bind("[::]:0").ok()?;
    socket.connect("[2001:4860:4860::8888]:80").ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V6(ip) if is_global_v6(&ip) => Some(ip),
        _ => None,
    }
}

/// Reachable across the internet: not loopback, link-local, unique-local or mapped.
fn is_global_v6(ip: &Ipv6Addr) -> bool {
    let first = ip.segments()[0];
    !ip.is_loopback() && !ip.is_unspecified() && ip.to_ipv4_mapped().is_none() && (first & 0xffc0) != 0xfe80 && (first & 0xfe00) != 0xfc00
}

/// Asks a STUN server which public address `socket` appears from.
/// Must run before anything else reads from the socket.
pub fn public_address(socket: &UdpSocket) -> Option<SocketAddr> {
    let dual = is_dual(socket);
    let old_timeout = socket.read_timeout().ok().flatten();
    socket.set_read_timeout(Some(Duration::from_millis(400))).ok()?;
    let found = STUN_SERVERS.iter().find_map(|server| {
        let addr = server.to_socket_addrs().ok()?.find(SocketAddr::is_ipv4)?;
        let txid: [u8; 12] = rand::random();
        let request = stun_binding(&txid);
        let mut buf = [0u8; 512];
        for _ in 0..3 {
            socket.send_to(&request, wire(addr, dual)).ok()?;
            let deadline = Instant::now() + Duration::from_millis(400);
            while Instant::now() < deadline {
                match socket.recv_from(&mut buf) {
                    Ok((len, from)) if canonical(from) == addr => {
                        if let Some(public) = parse_stun(&buf[..len], &txid) {
                            return Some(public);
                        }
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        }
        None
    });
    let _ = socket.set_read_timeout(old_timeout);
    found
}

/// A STUN binding request: "which address do you see me from?"
fn stun_binding(txid: &[u8; 12]) -> Vec<u8> {
    let mut request = vec![0x00, 0x01, 0x00, 0x00];
    request.extend_from_slice(&STUN_MAGIC);
    request.extend_from_slice(txid);
    request
}

/// The STUN servers' addresses, looked up once (voice mustn't wait on DNS mid-call).
pub fn stun_servers() -> Vec<SocketAddr> {
    STUN_SERVERS.iter().filter_map(|s| s.to_socket_addrs().ok()?.find(SocketAddr::is_ipv4)).collect()
}

/// Reads the (XOR-)MAPPED-ADDRESS out of a STUN binding response.
fn parse_stun(buf: &[u8], txid: &[u8; 12]) -> Option<SocketAddr> {
    if buf.len() < 20 || buf[0..2] != [0x01, 0x01] || buf[4..8] != STUN_MAGIC || &buf[8..20] != txid {
        return None;
    }
    let end = (20 + u16::from_be_bytes([buf[2], buf[3]]) as usize).min(buf.len());
    let mut i = 20;
    while i + 4 <= end {
        let kind = u16::from_be_bytes([buf[i], buf[i + 1]]);
        let len = u16::from_be_bytes([buf[i + 2], buf[i + 3]]) as usize;
        let value = buf.get(i + 4..i + 4 + len)?;
        // Family 0x01 is IPv4.
        if (kind == 0x0020 || kind == 0x0001) && len >= 8 && value[1] == 0x01 {
            let mut port = u16::from_be_bytes([value[2], value[3]]);
            let mut ip = [value[4], value[5], value[6], value[7]];
            if kind == 0x0020 {
                port ^= 0x2112;
                ip.iter_mut().zip(STUN_MAGIC).for_each(|(b, m)| *b ^= m);
            }
            return Some(SocketAddr::from((ip, port)));
        }
        i += 4 + len.div_ceil(4) * 4;
    }
    None
}

/// This computer's address on the local network.
pub fn local_ip() -> Option<IpAddr> {
    // Connecting a UDP socket sends nothing; it only picks the outgoing interface.
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    Some(socket.local_addr().ok()?.ip())
}

/// Encrypts our packets. Each sealer picks a random salt, so restarting voice
/// never reuses a nonce under the same channel key.
pub struct Sealer {
    cipher: ChaCha20Poly1305,
    sender: SessionId,
    salt: u32,
    counter: u32,
}

fn nonce(salt: &[u8], counter: &[u8], sender: &[u8]) -> Nonce {
    let mut n = [0u8; 12];
    n[0..4].copy_from_slice(salt);
    n[4..8].copy_from_slice(counter);
    n[8..12].copy_from_slice(sender);
    n.into()
}

impl Sealer {
    pub fn new(key: &[u8; 32], sender: SessionId) -> Self {
        Sealer { cipher: ChaCha20Poly1305::new(key.into()), sender, salt: rand::random(), counter: 0 }
    }

    pub fn seal(&mut self, kind: u8, payload: &[u8], out: &mut Vec<u8>) {
        if self.counter == u32::MAX {
            // Four billion packets in; start a fresh nonce space.
            self.salt = rand::random();
            self.counter = 0;
        }
        self.counter += 1;
        out.clear();
        out.push(kind);
        out.extend_from_slice(&self.sender.to_be_bytes());
        out.extend_from_slice(&self.salt.to_be_bytes());
        out.extend_from_slice(&self.counter.to_be_bytes());
        out.extend_from_slice(payload);
        let (header, body) = out.split_at_mut(HEADER);
        let n = nonce(&header[5..9], &header[9..13], &header[1..5]);
        let tag = self.cipher.encrypt_in_place_detached(&n, header, body).expect("payload fits");
        out.extend_from_slice(&tag);
    }
}

/// Checks and decrypts a packet: (kind, sender, payload).
pub fn open(cipher: &ChaCha20Poly1305, buf: &[u8]) -> Option<(u8, SessionId, Vec<u8>)> {
    if buf.len() < HEADER + TAG || !matches!(buf[0], KIND_VOICE | KIND_PING | KIND_PONG | KIND_VOICE_RED) {
        return None;
    }
    let (header, rest) = buf.split_at(HEADER);
    let (body, tag) = rest.split_at(rest.len() - TAG);
    let mut payload = body.to_vec();
    let n = nonce(&header[5..9], &header[9..13], &header[1..5]);
    cipher.decrypt_in_place_detached(&n, header, &mut payload, Tag::from_slice(tag)).ok()?;
    Some((buf[0], u32::from_be_bytes(header[1..5].try_into().ok()?), payload))
}

/// How much of someone's voice reaches us: sequence numbers seen against the span they cover.
#[derive(Default)]
struct LossMeter {
    /// Older frames than this belong to a window already counted.
    floor: u32,
    first: Option<u32>,
    highest: u32,
    count: u32,
    /// Smoothed loss in percent: rises fast, settles slowly.
    percent: f32,
    measured: bool,
}

impl LossMeter {
    fn heard(&mut self, seq: u32) {
        if seq < self.floor {
            // Far behind: they restarted their voice, so counting starts over.
            if self.floor - seq > 1000 {
                *self = LossMeter::default();
            } else {
                return;
            }
        }
        match self.first {
            None => {
                self.first = Some(seq);
                self.highest = seq;
                self.count = 1;
            }
            Some(_) => {
                self.highest = self.highest.max(seq);
                self.count += 1;
            }
        }
    }

    /// The smoothed loss so far, without closing the window.
    fn current(&self) -> Option<u8> {
        self.measured.then(|| self.percent.round().min(100.0) as u8)
    }

    /// Closes the window once it spans enough; the smoothed loss, once there's any measurement.
    fn report(&mut self) -> Option<u8> {
        if let Some(first) = self.first {
            let span = self.highest - first + 1;
            if span >= LOSS_WINDOW {
                let lost = span.saturating_sub(self.count) as f32 * 100.0 / span as f32;
                self.percent = if lost > self.percent { (self.percent + lost) / 2.0 } else { self.percent * 0.8 + lost * 0.2 };
                self.measured = true;
                self.floor = self.highest + 1;
                self.first = None;
                self.count = 0;
            }
        }
        self.measured.then(|| self.percent.round().min(100.0) as u8)
    }
}

struct Link {
    candidates: Vec<SocketAddr>,
    /// The address that last answered; voice goes only there.
    path: Option<SocketAddr>,
    /// Whether that path goes through our relay (only when nothing direct works).
    relayed: bool,
    /// When a direct packet last came: a direct path beats the relay while it lives.
    last_direct: Option<Instant>,
    last_heard: Option<Instant>,
    last_ping: Option<Instant>,
    /// While voice goes through the relay: when the direct addresses were last tried again.
    last_direct_try: Option<Instant>,
    rtt_ms: Option<u32>,
    /// Since when we've been without a path.
    searching_since: Instant,
    /// What we last told the app: reachable or not.
    reported: Option<bool>,
    /// Until when every address is probed alongside the path (someone's network changed).
    reprobe_until: Option<Instant>,
    /// How much of their voice reaches us.
    loss_in: LossMeter,
    /// How much of our voice reaches them, as they last reported it.
    loss_out: Option<(u8, Instant)>,
    /// They understand voice with repeated frames (their pings say so).
    red: bool,
}

/// Asking STUN for our public address while voice runs: the receiving thread gets the answer.
#[derive(Default)]
struct StunAsk {
    servers: Vec<SocketAddr>,
    /// The question in flight: transaction, server, when, and how many tries so far.
    pending: Option<([u8; 12], SocketAddr, Instant, u8)>,
    answer: Option<SocketAddr>,
}

/// Everyone in our voice channel and how to reach them.
pub struct Mesh {
    pub me: SessionId,
    pub key: [u8; 32],
    pub cipher: ChaCha20Poly1305,
    links: Mutex<HashMap<SessionId, Link>>,
    /// Our relay, once the app hands us a login (only needed when someone is unreachable).
    pub turn: Mutex<Option<Turn>>,
    /// Where peers can reach us; grows a relay address when we get one.
    pub endpoint: Mutex<Option<PeerEndpoint>>,
    stun: Mutex<StunAsk>,
    /// Set to have voice look at our network again right away, as if it had changed.
    pub recheck: std::sync::atomic::AtomicBool,
}

/// After this long without a direct path, probes go through our relay too.
const RELAY_PROBE_AFTER: Duration = Duration::from_secs(2);
/// On the relay, the direct addresses are tried again this often: the relay is a detour, and
/// a direct path often opens a little later (both sides' routers need a moment).
const DIRECT_RETRY: Duration = Duration::from_secs(3);
/// A direct path heard from this recently wins over the relay.
const DIRECT_PREFERRED_FOR: Duration = Duration::from_millis(1500);

fn parse_addrs(peer: &PeerEndpoint) -> Vec<SocketAddr> {
    // Local addresses first: on the same network they work even when the router can't loop back.
    // IPv6 ones are tried alongside; whichever answers first carries the voice.
    peer.local.iter().chain(&peer.public).filter_map(|a| a.parse::<SocketAddr>().ok()).map(canonical).take(6).collect()
}

impl Mesh {
    pub fn new(me: SessionId, key: &[u8; 32]) -> Self {
        Mesh {
            me,
            key: *key,
            cipher: ChaCha20Poly1305::new(key.into()),
            links: Mutex::new(HashMap::new()),
            turn: Mutex::new(None),
            endpoint: Mutex::new(None),
            stun: Mutex::new(StunAsk::default()),
            recheck: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Where to ask for our public address mid-call.
    pub fn set_stun_servers(&self, servers: Vec<SocketAddr>) {
        self.stun.lock().unwrap().servers = servers;
    }

    /// Starts asking STUN for our public address; the packet to send and where.
    pub fn stun_request(&self) -> Option<(SocketAddr, Vec<u8>)> {
        let mut stun = self.stun.lock().unwrap();
        let server = *stun.servers.first()?;
        let txid: [u8; 12] = rand::random();
        stun.pending = Some((txid, server, Instant::now(), 1));
        Some((server, stun_binding(&txid)))
    }

    /// The question again, to the next server, when the last one went unanswered.
    pub fn stun_retry(&self) -> Option<(SocketAddr, Vec<u8>)> {
        let mut stun = self.stun.lock().unwrap();
        let (_, _, sent, tries) = stun.pending?;
        if sent.elapsed() < STUN_RETRY {
            return None;
        }
        if tries >= STUN_TRIES || stun.servers.is_empty() {
            stun.pending = None;
            return None;
        }
        let server = stun.servers[tries as usize % stun.servers.len()];
        let txid: [u8; 12] = rand::random();
        stun.pending = Some((txid, server, Instant::now(), tries + 1));
        Some((server, stun_binding(&txid)))
    }

    /// A packet that may be STUN's answer to us. True if it was (and is used up).
    pub fn stun_heard(&self, from: SocketAddr, packet: &[u8]) -> bool {
        let mut stun = self.stun.lock().unwrap();
        let Some((txid, server, _, _)) = stun.pending else { return false };
        if canonical(from) != server {
            return false;
        }
        let Some(public) = parse_stun(packet, &txid) else { return false };
        stun.pending = None;
        stun.answer = Some(public);
        true
    }

    /// Our public address, once STUN has answered.
    pub fn take_stun_answer(&self) -> Option<SocketAddr> {
        self.stun.lock().unwrap().answer.take()
    }

    /// Our own network changed (wifi to cable, a new address): every peer is tried again on
    /// all their addresses at once, and the relay, tied to the old address, is let go.
    pub fn network_changed(&self) {
        let now = Instant::now();
        for link in self.links.lock().unwrap().values_mut() {
            link.reprobe_until = Some(now + REPROBE_FOR);
            link.last_ping = None;
            if link.relayed {
                link.path = None;
                link.relayed = false;
                link.searching_since = now;
            }
        }
        *self.turn.lock().unwrap() = None;
    }

    /// Adds a peer or updates its addresses.
    pub fn set_peer(&self, peer: &PeerEndpoint) {
        if peer.session_id == self.me {
            return;
        }
        let candidates = parse_addrs(peer);
        let mut links = self.links.lock().unwrap();
        let link = links.entry(peer.session_id).or_insert(Link {
            candidates: Vec::new(),
            path: None,
            relayed: false,
            last_direct: None,
            last_heard: None,
            last_ping: None,
            last_direct_try: None,
            rtt_ms: None,
            searching_since: Instant::now(),
            reported: None,
            reprobe_until: None,
            loss_in: LossMeter::default(),
            loss_out: None,
            red: false,
        });
        // Their addresses changed (their network did): try the new ones right away.
        if !link.candidates.is_empty() && link.candidates != candidates {
            link.reprobe_until = Some(Instant::now() + REPROBE_FOR);
        }
        link.candidates = candidates;
        // Probe the new addresses right away.
        link.last_ping = None;
    }

    pub fn remove_peer(&self, id: SessionId) {
        self.links.lock().unwrap().remove(&id);
    }

    pub fn retain_peers(&self, keep: impl Fn(SessionId) -> bool) {
        self.links.lock().unwrap().retain(|&id, _| keep(id));
    }

    /// Where our voice should go: every peer with a working path, whether it's relayed,
    /// and whether they understand repeated frames.
    pub fn paths(&self) -> Vec<(SocketAddr, bool, bool)> {
        self.links.lock().unwrap().values().filter_map(|l| l.path.map(|p| (p, l.relayed, l.red))).collect()
    }

    /// A voice frame from them arrived: counted toward how much of their voice reaches us.
    pub fn heard_voice(&self, id: SessionId, seq: u32) {
        if let Some(link) = self.links.lock().unwrap().get_mut(&id) {
            link.loss_in.heard(seq);
        }
    }

    /// What our pings say: the nonce, our format, and how much of each peer's voice reaches us.
    pub fn ping_payload(&self, nonce: u32) -> Vec<u8> {
        let mut out = nonce.to_be_bytes().to_vec();
        out.push(PING_FORMAT);
        for (&id, link) in self.links.lock().unwrap().iter_mut().take(40) {
            if let Some(loss) = link.loss_in.report() {
                out.extend_from_slice(&id.to_be_bytes());
                out.push(loss);
            }
        }
        out
    }

    /// A peer's ping: learns what they understand and how much of our voice reaches them.
    pub fn ping_heard(&self, id: SessionId, payload: &[u8]) {
        let mut links = self.links.lock().unwrap();
        let Some(link) = links.get_mut(&id) else { return };
        if payload.len() < 5 || payload[4] != PING_FORMAT {
            return;
        }
        link.red = true;
        for entry in payload[5..].as_chunks::<5>().0 {
            if u32::from_be_bytes([entry[0], entry[1], entry[2], entry[3]]) == self.me {
                link.loss_out = Some((entry[4].min(100), Instant::now()));
            }
        }
    }

    /// How the connection to each reachable peer is: round trip, and the worse of how much of
    /// their voice reaches us and how much of ours reaches them (percent lost).
    pub fn quality(&self) -> Vec<(SessionId, Option<u32>, u8, bool)> {
        let links = self.links.lock().unwrap();
        links
            .iter()
            .filter(|(_, l)| l.path.is_some())
            .map(|(&id, l)| {
                let out = l.loss_out.filter(|(_, at)| at.elapsed() < LOSS_REPORT_FRESH).map(|(loss, _)| loss);
                (id, l.rtt_ms, l.loss_in.current().unwrap_or(0).max(out.unwrap_or(0)), l.relayed)
            })
            .collect()
    }

    /// The worst loss anyone reports for our voice lately, in percent.
    pub fn worst_loss(&self) -> u8 {
        let links = self.links.lock().unwrap();
        links.values().filter(|l| l.path.is_some()).filter_map(|l| l.loss_out).filter(|(_, at)| at.elapsed() < LOSS_REPORT_FRESH).map(|(loss, _)| loss).max().unwrap_or(0)
    }

    /// Every IP a peer might reach us from: the relay must be told to let them through.
    pub fn peer_ips(&self) -> Vec<IpAddr> {
        let links = self.links.lock().unwrap();
        let mut ips: Vec<IpAddr> = links.values().flat_map(|l| l.candidates.iter().chain(l.path.iter()).map(|a| a.ip())).collect();
        ips.sort();
        ips.dedup();
        ips
    }

    /// Whether anyone's voice goes through our relay right now.
    pub fn uses_relay(&self) -> bool {
        self.links.lock().unwrap().values().any(|l| l.path.is_some() && l.relayed)
    }

    /// Whether anyone has been out of reach long enough that a relay would help.
    pub fn wants_relay(&self) -> bool {
        self.links.lock().unwrap().values().any(|l| l.path.is_none() && l.searching_since.elapsed() > RELAY_PROBE_AFTER)
    }

    fn relay_ready(&self) -> bool {
        self.turn.lock().unwrap().as_ref().is_some_and(|t| matches!(t.state(), TurnState::Ready(_)))
    }

    /// Addresses to ping now, and whether through the relay: keepalives on working paths,
    /// probes on every candidate otherwise (and through the relay once direct has failed a while).
    pub fn due_pings(&self) -> Vec<(SocketAddr, bool)> {
        let relay = self.relay_ready();
        let now = Instant::now();
        let mut out = Vec::new();
        for link in self.links.lock().unwrap().values_mut() {
            if link.path.is_some() && link.last_heard.is_some_and(|t| now - t > PATH_TIMEOUT) {
                tracing::info!("lost the direct path to a peer; probing again");
                link.path = None;
                link.searching_since = now;
            }
            let reprobing = link.reprobe_until.is_some_and(|t| now < t);
            if !reprobing {
                link.reprobe_until = None;
            }
            let interval = if link.path.is_some() && !reprobing { KEEPALIVE_INTERVAL } else { PROBE_INTERVAL };
            if link.last_ping.is_some_and(|t| now - t < interval) {
                continue;
            }
            link.last_ping = Some(now);
            match link.path {
                Some(path) => {
                    out.push((path, link.relayed));
                    if reprobing {
                        out.extend(link.candidates.iter().filter(|&&c| c != path || link.relayed).map(|&c| (c, false)));
                    } else if link.relayed && !link.last_direct_try.is_some_and(|t| now - t < DIRECT_RETRY) {
                        // Still on the detour: knock on the direct doors again.
                        link.last_direct_try = Some(now);
                        out.extend(link.candidates.iter().map(|&c| (c, false)));
                    }
                }
                None => {
                    out.extend(link.candidates.iter().map(|&c| (c, false)));
                    if relay && now - link.searching_since > RELAY_PROBE_AFTER {
                        out.extend(link.candidates.iter().map(|&c| (c, true)));
                    }
                }
            }
        }
        out
    }

    /// Records a genuine packet from `id` arriving from `from`. False if `id` isn't in our channel.
    pub fn heard(&self, id: SessionId, from: SocketAddr, relayed: bool) -> bool {
        self.heard_as(id, from, relayed, true)
    }

    /// Like `heard`. A bare question (`proof` false: a ping, which only shows they can reach
    /// us) doesn't move voice off a working relay: that takes an answer to our own ping, or
    /// their voice, which show the direct way works in both directions.
    pub fn heard_as(&self, id: SessionId, from: SocketAddr, relayed: bool, proof: bool) -> bool {
        let from = canonical(from);
        let now = Instant::now();
        let mut links = self.links.lock().unwrap();
        let Some(link) = links.get_mut(&id) else { return false };
        if !proof && !relayed && link.relayed && link.path.is_some() {
            return true;
        }
        // A live direct path stays, even when the relay delivers too.
        if relayed && !link.relayed && link.path.is_some() && link.last_direct.is_some_and(|t| now - t < DIRECT_PREFERRED_FOR) {
            link.last_heard = Some(now);
            return true;
        }
        if link.path != Some(from) || link.relayed != relayed {
            tracing::info!("voice path to peer {id} via {from}{}", if relayed { " (through the relay)" } else { "" });
        }
        link.path = Some(from);
        link.relayed = relayed;
        link.last_heard = Some(now);
        if !relayed {
            link.last_direct = Some(now);
        }
        true
    }

    /// Peers whose reachability changed since last asked: a path means reachable,
    /// none after a while means their network or ours blocks direct voice.
    pub fn reach_changes(&self) -> Vec<(SessionId, bool)> {
        let now = Instant::now();
        let mut out = Vec::new();
        for (&id, link) in self.links.lock().unwrap().iter_mut() {
            let state = if link.path.is_some() {
                Some(true)
            } else if now - link.searching_since > UNREACHABLE_AFTER {
                Some(false)
            } else {
                None
            };
            if state.is_some() && state != link.reported {
                link.reported = state;
                out.push((id, state == Some(true)));
            }
        }
        out
    }

    /// Records a ping round trip; returns the slowest round trip among peers, for the UI.
    pub fn record_rtt(&self, id: SessionId, ms: u32) -> Option<u32> {
        let mut links = self.links.lock().unwrap();
        if let Some(link) = links.get_mut(&id) {
            link.rtt_ms = Some(ms);
        }
        links.values().filter(|l| l.path.is_some()).filter_map(|l| l.rtt_ms).max()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::net::SocketAddrV4;

    #[test]
    fn sealed_packets_open_only_with_the_right_key() {
        let key = [7u8; 32];
        let mut sealer = Sealer::new(&key, 42);
        let mut packet = Vec::new();
        sealer.seal(KIND_VOICE, b"hello", &mut packet);
        let cipher = ChaCha20Poly1305::new((&key).into());
        assert_eq!(open(&cipher, &packet), Some((KIND_VOICE, 42, b"hello".to_vec())));

        let other = ChaCha20Poly1305::new((&[8u8; 32]).into());
        assert_eq!(open(&other, &packet), None);
        // Claiming to be someone else breaks the tag.
        packet[4] ^= 1;
        assert_eq!(open(&cipher, &packet), None);
    }

    fn endpoint(id: SessionId, addrs: &[&str]) -> PeerEndpoint {
        PeerEndpoint { session_id: id, public: None, local: addrs.iter().map(|a| a.to_string()).collect() }
    }

    #[test]
    fn loss_is_measured_and_settles_slowly() {
        let mut m = LossMeter::default();
        assert_eq!(m.report(), None, "nothing measured yet");
        // 50 frames, every fifth lost: 20 %, but the first window only moves halfway there.
        for seq in (0..50).filter(|s| s % 5 != 1) {
            m.heard(seq);
        }
        assert_eq!(m.report(), Some(10));
        assert_eq!(m.report(), Some(10), "an open window doesn't change it");
        // A clean stretch brings it down gently, not at once.
        for seq in 50..100 {
            m.heard(seq);
        }
        assert_eq!(m.report(), Some(8));
        // Late frames from a counted window don't count twice.
        m.heard(60);
        assert_eq!(m.first, None);
        // A sender that restarted (numbers far behind) is counted afresh.
        for seq in 5000..5030 {
            m.heard(seq);
        }
        m.report();
        m.heard(3);
        assert_eq!(m.first, Some(3), "far behind means a restart");
    }

    #[test]
    fn pings_carry_loss_reports_both_ways() {
        let a = Mesh::new(1, &[1; 32]);
        let b = Mesh::new(2, &[1; 32]);
        a.set_peer(&endpoint(2, &["10.0.0.2:5000"]));
        b.set_peer(&endpoint(1, &["10.0.0.1:5000"]));
        assert!(a.heard(2, "10.0.0.2:5000".parse().unwrap(), false));
        assert!(b.heard(1, "10.0.0.1:5000".parse().unwrap(), false));
        // B hears only half of A's voice.
        for seq in (0..40).step_by(2) {
            b.heard_voice(1, seq);
        }
        let ping = b.ping_payload(77);
        assert_eq!(&ping[..4], &77u32.to_be_bytes());
        assert_eq!(a.paths(), vec![("10.0.0.2:5000".parse().unwrap(), false, false)], "not yet known to understand repeats");
        a.ping_heard(2, &ping);
        assert_eq!(a.worst_loss(), 24, "half lost, and the first window moves halfway");
        assert_eq!(a.quality(), vec![(2, None, 24, false)], "the connection shows the loss either way");
        assert_eq!(b.quality(), vec![(1, None, 24, false)]);
        assert_eq!(a.paths(), vec![("10.0.0.2:5000".parse().unwrap(), false, true)]);
        // An old-style ping (the nonce alone) is understood as before and teaches nothing.
        let c = Mesh::new(3, &[1; 32]);
        c.set_peer(&endpoint(2, &["10.0.0.2:5000"]));
        assert!(c.heard(2, "10.0.0.2:5000".parse().unwrap(), false));
        c.ping_heard(2, &77u32.to_be_bytes());
        assert_eq!(c.paths(), vec![("10.0.0.2:5000".parse().unwrap(), false, false)]);
        assert_eq!(c.worst_loss(), 0);
    }

    #[test]
    fn new_addresses_are_tried_at_once_alongside_the_path() {
        let mesh = Mesh::new(1, &[1; 32]);
        mesh.set_peer(&endpoint(2, &["10.0.0.2:5000"]));
        assert!(mesh.heard(2, "10.0.0.2:5000".parse().unwrap(), false));
        mesh.due_pings();
        // Their network changed: the new address is probed now, with the old path still kept.
        mesh.set_peer(&endpoint(2, &["192.168.1.9:5000"]));
        let due = mesh.due_pings();
        assert!(due.contains(&("10.0.0.2:5000".parse().unwrap(), false)), "{due:?}");
        assert!(due.contains(&("192.168.1.9:5000".parse().unwrap(), false)), "{due:?}");
        // And again soon, not after a whole keepalive second.
        std::thread::sleep(PROBE_INTERVAL + Duration::from_millis(20));
        assert!(!mesh.due_pings().is_empty());
        // The new address answers: voice goes there.
        assert!(mesh.heard(2, "192.168.1.9:5000".parse().unwrap(), false));
        assert_eq!(mesh.paths(), vec![("192.168.1.9:5000".parse().unwrap(), false, false)]);
    }

    #[test]
    fn the_same_addresses_again_change_nothing() {
        let mesh = Mesh::new(1, &[1; 32]);
        mesh.set_peer(&endpoint(2, &["10.0.0.2:5000"]));
        assert!(mesh.heard(2, "10.0.0.2:5000".parse().unwrap(), false));
        mesh.due_pings();
        mesh.set_peer(&endpoint(2, &["10.0.0.2:5000"]));
        // Pinged at once (set_peer always does), but only on the path: nothing to reprobe.
        assert_eq!(mesh.due_pings(), vec![("10.0.0.2:5000".parse().unwrap(), false)]);
        assert!(mesh.due_pings().is_empty(), "then the usual keepalive pace");
    }

    #[test]
    fn our_network_changing_reprobes_everyone_and_drops_relayed_paths() {
        let mesh = Mesh::new(1, &[1; 32]);
        mesh.set_peer(&endpoint(2, &["10.0.0.2:5000"]));
        mesh.set_peer(&endpoint(3, &["10.0.0.3:5000"]));
        assert!(mesh.heard(2, "10.0.0.2:5000".parse().unwrap(), false));
        assert!(mesh.heard(3, "203.0.113.3:7000".parse().unwrap(), true));
        mesh.due_pings();
        mesh.network_changed();
        let due = mesh.due_pings();
        // The direct path is kept and pinged at once; the relayed one is gone (the relay was ours).
        assert!(due.contains(&("10.0.0.2:5000".parse().unwrap(), false)), "{due:?}");
        assert!(due.contains(&("10.0.0.3:5000".parse().unwrap(), false)), "{due:?}");
        assert_eq!(mesh.paths(), vec![("10.0.0.2:5000".parse().unwrap(), false, false)]);
        assert!(mesh.turn.lock().unwrap().is_none());
    }

    #[test]
    fn stun_answers_mid_call_are_matched_to_our_question() {
        let mesh = Mesh::new(1, &[1; 32]);
        let server: SocketAddr = "198.51.100.1:3478".parse().unwrap();
        mesh.set_stun_servers(vec![server]);
        let (to, request) = mesh.stun_request().unwrap();
        assert_eq!(to, server);
        let txid: [u8; 12] = request[8..20].try_into().unwrap();
        let answer = stun_answer(&txid, "203.0.113.9:41000".parse().unwrap());
        // Not from the server we asked, or not our transaction: ignored.
        assert!(!mesh.stun_heard("198.51.100.2:3478".parse().unwrap(), &answer));
        assert!(!mesh.stun_heard(server, &stun_answer(&[0; 12], "203.0.113.9:41000".parse().unwrap())));
        assert!(mesh.stun_heard(server, &answer));
        assert_eq!(mesh.take_stun_answer(), Some("203.0.113.9:41000".parse().unwrap()));
        assert!(!mesh.stun_heard(server, &answer), "answered once");
    }

    /// A STUN binding response with an XOR-MAPPED-ADDRESS, as a server would send.
    pub(crate) fn stun_answer(txid: &[u8; 12], public: SocketAddrV4) -> Vec<u8> {
        let mut resp = vec![0x01, 0x01, 0x00, 0x0c];
        resp.extend_from_slice(&STUN_MAGIC);
        resp.extend_from_slice(txid);
        resp.extend_from_slice(&[0x00, 0x20, 0x00, 0x08, 0x00, 0x01]);
        resp.extend_from_slice(&(public.port() ^ 0x2112).to_be_bytes());
        let ip = public.ip().octets();
        resp.extend(ip.iter().zip(STUN_MAGIC).map(|(b, m)| b ^ m));
        resp
    }

    #[test]
    fn stun_responses_are_decoded() {
        let txid = [3u8; 12];
        let mut resp = vec![0x01, 0x01, 0x00, 0x0c];
        resp.extend_from_slice(&STUN_MAGIC);
        resp.extend_from_slice(&txid);
        // XOR-MAPPED-ADDRESS for 203.0.113.5:40000.
        let port = 40000u16 ^ 0x2112;
        let ip = [203 ^ 0x21, 0x12 /* 0 ^ 0x12 */, 113 ^ 0xA4, 5 ^ 0x42];
        resp.extend_from_slice(&[0x00, 0x20, 0x00, 0x08, 0x00, 0x01]);
        resp.extend_from_slice(&port.to_be_bytes());
        resp.extend_from_slice(&ip);
        assert_eq!(parse_stun(&resp, &txid), Some("203.0.113.5:40000".parse().unwrap()));
        assert_eq!(parse_stun(&resp, &[0u8; 12]), None);
    }

    #[test]
    fn two_meshes_find_each_other_on_one_computer() {
        let key = [1u8; 32];
        let (a, b) = (Mesh::new(1, &key), Mesh::new(2, &key));
        b.set_peer(&PeerEndpoint { session_id: 1, public: None, local: vec!["127.0.0.1:5000".into()] });
        assert_eq!(b.due_pings(), vec![("127.0.0.1:5000".parse().unwrap(), false)]);
        // Nothing more until the probe interval has passed.
        assert!(b.due_pings().is_empty());
        assert!(b.paths().is_empty());
        assert!(b.heard(1, "127.0.0.1:5000".parse().unwrap(), false));
        assert_eq!(b.paths().len(), 1);
        // Strangers are ignored.
        assert!(!a.heard(2, "127.0.0.1:6000".parse().unwrap(), false));
    }

    #[test]
    fn reachability_is_reported_once_per_change() {
        let mesh = Mesh::new(2, &[1u8; 32]);
        mesh.set_peer(&PeerEndpoint { session_id: 1, public: None, local: vec!["127.0.0.1:5000".into()] });
        // Still searching: nothing to say yet.
        assert!(mesh.reach_changes().is_empty());
        assert!(mesh.heard(1, "127.0.0.1:5000".parse().unwrap(), false));
        assert_eq!(mesh.reach_changes(), vec![(1, true)]);
        assert!(mesh.reach_changes().is_empty());
    }
}

#[cfg(test)]
mod network_tests {
    use super::*;

    /// Needs internet access: `cargo test -p strom-voice -- --ignored stun`.
    #[test]
    #[ignore]
    fn stun_finds_our_public_address() {
        let socket = UdpSocket::bind("0.0.0.0:0").unwrap();
        let public = public_address(&socket).expect("a STUN server answered");
        assert!(public.port() != 0);
        println!("public address: {}", public.ip().is_ipv4());
    }

    #[test]
    fn dual_stack_sockets_talk_over_ipv4_and_ipv6() {
        let a = dual_stack_socket().unwrap();
        let b = dual_stack_socket().unwrap();
        if !is_dual(&a) {
            return; // No IPv6 on this machine: IPv4 is covered by the other tests.
        }
        b.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let mut buf = [0u8; 16];
        let b_port = b.local_addr().unwrap().port();
        let a_port = a.local_addr().unwrap().port();

        // IPv4 through a dual-stack socket: written IPv4-mapped, read back as plain IPv4.
        let to_b4: SocketAddr = format!("127.0.0.1:{b_port}").parse().unwrap();
        a.send_to(b"four", wire(to_b4, true)).unwrap();
        let (n, from) = b.recv_from(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"four");
        assert_eq!(canonical(from), format!("127.0.0.1:{a_port}").parse::<SocketAddr>().unwrap());

        // IPv6, same port.
        let to_b6: SocketAddr = format!("[::1]:{b_port}").parse().unwrap();
        a.send_to(b"six", wire(to_b6, true)).unwrap();
        let (n, from) = b.recv_from(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"six");
        assert_eq!(canonical(from), format!("[::1]:{a_port}").parse::<SocketAddr>().unwrap());
    }

    #[test]
    fn only_internet_ipv6_addresses_are_offered() {
        for (ip, global) in [("2a02:aa1:1000::1", true), ("fe80::1", false), ("fd12:3456::1", false), ("::1", false), ("::ffff:10.0.0.1", false)] {
            assert_eq!(is_global_v6(&ip.parse().unwrap()), global, "{ip}");
        }
    }

    #[test]
    fn peers_offer_ipv6_and_ipv4_candidates() {
        let peer = PeerEndpoint { session_id: 2, public: Some("203.0.113.5:4000".into()), local: vec!["192.168.1.5:4000".into(), "[2a02:aa1::5]:4000".into()] };
        let got = parse_addrs(&peer);
        assert!(got.contains(&"[2a02:aa1::5]:4000".parse().unwrap()));
        assert!(got.contains(&"203.0.113.5:4000".parse().unwrap()));
        assert_eq!(got[0], "192.168.1.5:4000".parse().unwrap(), "same network first");
    }

    #[test]
    fn a_direct_path_wins_over_the_relay() {
        let mesh = Mesh::new(2, &[0; 32]);
        mesh.set_peer(&PeerEndpoint { session_id: 1, public: Some("203.0.113.5:4000".into()), local: vec![] });
        let direct: SocketAddr = "203.0.113.5:4000".parse().unwrap();
        let via_relay: SocketAddr = "203.0.113.5:4001".parse().unwrap();
        // Only the relay works at first.
        assert!(mesh.heard(1, via_relay, true));
        assert_eq!(mesh.paths(), vec![(via_relay, true, false)]);
        // A direct packet arrives: voice switches to it, and the relay can't take it back while it lives.
        assert!(mesh.heard(1, direct, false));
        assert_eq!(mesh.paths(), vec![(direct, false, false)]);
        assert!(mesh.heard(1, via_relay, true));
        assert_eq!(mesh.paths(), vec![(direct, false, false)]);
    }

    #[test]
    fn the_relay_is_a_detour_that_keeps_looking_for_the_direct_way() {
        let mesh = Mesh::new(2, &[7; 32]);
        mesh.set_peer(&PeerEndpoint { session_id: 1, public: Some("203.0.113.5:4000".into()), local: vec![] });
        let direct: SocketAddr = "203.0.113.5:4000".parse().unwrap();
        let via_relay: SocketAddr = "203.0.113.5:4001".parse().unwrap();
        assert!(mesh.heard(1, via_relay, true));
        // On the relay, the direct address is tried again alongside the keepalive.
        mesh.links.lock().unwrap().get_mut(&1).unwrap().last_ping = None;
        let due = mesh.due_pings();
        assert!(due.contains(&(via_relay, true)) && due.contains(&(direct, false)), "{due:?}");
        // Their ping arriving directly isn't proof it works both ways: voice stays on the relay.
        assert!(mesh.heard_as(1, direct, false, false));
        assert_eq!(mesh.paths(), vec![(via_relay, true, false)]);
        // Their answer to our direct ping is: voice moves to the direct path.
        assert!(mesh.heard_as(1, direct, false, true));
        assert_eq!(mesh.paths(), vec![(direct, false, false)]);
        assert_eq!(mesh.quality(), vec![(1, None, 0, false)]);
    }
}
