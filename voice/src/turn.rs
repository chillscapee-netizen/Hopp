//! A TURN client (RFC 8656), for peers that can't reach each other directly.
//!
//! Some networks (strict firewalls, some mobile and carrier-grade NAT) block every
//! direct path. Then we borrow an address on a relay (Cloudflare's TURN service):
//! peers send to that address and the relay hands their packets to us, and we send
//! through the relay to them. Voice stays sealed end to end; the relay sees noise.
//!
//! This only builds and reads TURN messages and keeps the allocation alive; the
//! voice socket sends and receives them (see the engine).

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};

use hmac::{Hmac, Mac};
use md5::{Digest, Md5};
use sha1::Sha1;

const MAGIC: [u8; 4] = [0x21, 0x12, 0xA4, 0x42];

// Methods and classes.
const ALLOCATE: u16 = 0x003;
const REFRESH: u16 = 0x004;
const SEND: u16 = 0x006;
const DATA: u16 = 0x007;
const CREATE_PERMISSION: u16 = 0x008;
const CHANNEL_BIND: u16 = 0x009;
const REQUEST: u16 = 0x000;
const INDICATION: u16 = 0x010;
const SUCCESS: u16 = 0x100;
const ERROR: u16 = 0x110;

// Attributes.
const USERNAME: u16 = 0x0006;
const MESSAGE_INTEGRITY: u16 = 0x0008;
const ERROR_CODE: u16 = 0x0009;
const CHANNEL_NUMBER: u16 = 0x000C;
const LIFETIME: u16 = 0x000D;
const XOR_PEER_ADDRESS: u16 = 0x0012;
const DATA_ATTR: u16 = 0x0013;
const REALM: u16 = 0x0014;
const NONCE: u16 = 0x0015;
const XOR_RELAYED_ADDRESS: u16 = 0x0016;
const REQUESTED_TRANSPORT: u16 = 0x0019;

/// Unanswered requests are sent again this often, a few times.
const RETRY: Duration = Duration::from_millis(500);
const RETRIES: u32 = 6;
/// Permissions last 5 minutes and channels 10; both are renewed well before.
const PERMISSION_RENEW: Duration = Duration::from_secs(240);
const CHANNEL_RENEW: Duration = Duration::from_secs(480);

/// What the cloud hands out: a relay and a short-lived login for it.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq)]
pub struct TurnLogin {
    /// "host:port" of the relay (UDP).
    pub server: String,
    pub username: String,
    pub credential: String,
}

/// A packet a peer sent us through the relay, and who sent it.
pub type PeerPacket = (SocketAddr, Vec<u8>);

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum State {
    Allocating,
    /// We have an address on the relay that peers can send to.
    Ready(SocketAddr),
    Failed,
}

struct Pending {
    method: u16,
    message: Vec<u8>,
    sent: Instant,
    tries: u32,
    /// For permissions and channel binds: which peer it's about.
    peer: Option<SocketAddr>,
    /// Its attributes, to sign again with a fresh nonce if the relay asks.
    attrs: Vec<Vec<u8>>,
}

pub struct Turn {
    pub server: SocketAddr,
    username: String,
    password: String,
    realm: Option<String>,
    nonce: Option<String>,
    state: State,
    lifetime: Duration,
    allocated_at: Instant,
    pending: HashMap<[u8; 12], Pending>,
    permissions: HashMap<IpAddr, Instant>,
    /// Peer address -> (channel number, bound yet, when bound).
    channels: HashMap<SocketAddr, (u16, bool, Instant)>,
    by_channel: HashMap<u16, SocketAddr>,
    next_channel: u16,
}

impl Turn {
    /// Starts an allocation; returns the first message to send to the relay.
    pub fn new(server: SocketAddr, login: &TurnLogin) -> (Self, Vec<u8>) {
        let mut turn = Turn {
            server,
            username: login.username.clone(),
            password: login.credential.clone(),
            realm: None,
            nonce: None,
            state: State::Allocating,
            lifetime: Duration::from_secs(600),
            allocated_at: Instant::now(),
            pending: HashMap::new(),
            permissions: HashMap::new(),
            channels: HashMap::new(),
            by_channel: HashMap::new(),
            next_channel: 0x4000,
        };
        let first = turn.request(ALLOCATE, vec![attr(REQUESTED_TRANSPORT, &[17, 0, 0, 0])], None);
        (turn, first)
    }

    pub fn state(&self) -> State {
        self.state
    }

    /// The long-term key: MD5(username:realm:password).
    fn key(&self) -> Option<[u8; 16]> {
        let realm = self.realm.as_ref()?;
        Some(Md5::digest(format!("{}:{}:{}", self.username, realm, self.password)).into())
    }

    /// Builds a request (signed once we know the realm), remembering it for retries.
    fn request(&mut self, method: u16, attrs: Vec<Vec<u8>>, peer: Option<SocketAddr>) -> Vec<u8> {
        self.request_try(method, attrs, peer, 0)
    }

    fn request_try(&mut self, method: u16, attrs: Vec<Vec<u8>>, peer: Option<SocketAddr>, tries: u32) -> Vec<u8> {
        let txid: [u8; 12] = rand::random();
        let message = self.build(method | REQUEST, &txid, attrs.clone());
        self.pending.insert(txid, Pending { method, message: message.clone(), sent: Instant::now(), tries, peer, attrs });
        message
    }

    fn build(&self, kind: u16, txid: &[u8; 12], mut attrs: Vec<Vec<u8>>) -> Vec<u8> {
        if let (Some(key), Some(realm), Some(nonce)) = (self.key(), &self.realm, &self.nonce) {
            attrs.push(attr(USERNAME, self.username.as_bytes()));
            attrs.push(attr(REALM, realm.as_bytes()));
            attrs.push(attr(NONCE, nonce.as_bytes()));
            return with_integrity(kind, txid, &attrs, &key);
        }
        message(kind, txid, &attrs)
    }

    /// Permission for a peer's IP to reach us through the relay (and us them).
    pub fn permit(&mut self, ip: IpAddr) -> Option<Vec<u8>> {
        if !matches!(self.state, State::Ready(_)) || self.permissions.get(&ip).is_some_and(|t| t.elapsed() < PERMISSION_RENEW) {
            return None;
        }
        self.permissions.insert(ip, Instant::now());
        let peer = SocketAddr::new(ip, 0);
        Some(self.request(CREATE_PERMISSION, vec![xor_address(XOR_PEER_ADDRESS, peer, &[0; 12])], Some(peer)))
    }

    /// Wraps a packet for a peer: a 4-byte channel header once bound, a Send indication before.
    /// The second value, if any, asks the relay to bind a channel for this peer.
    pub fn wrap(&mut self, peer: SocketAddr, payload: &[u8]) -> (Vec<u8>, Option<Vec<u8>>) {
        let mut bind = None;
        if !self.channels.contains_key(&peer) && self.next_channel <= 0x4FFF {
            let number = self.next_channel;
            self.next_channel += 1;
            self.channels.insert(peer, (number, false, Instant::now()));
            self.by_channel.insert(number, peer);
            bind = Some(self.bind_message(peer, number));
        }
        if let Some(&(number, true, _)) = self.channels.get(&peer) {
            let mut out = Vec::with_capacity(4 + payload.len() + 3);
            out.extend_from_slice(&number.to_be_bytes());
            out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
            out.extend_from_slice(payload);
            // ChannelData over UDP needn't be padded.
            return (out, bind);
        }
        let txid: [u8; 12] = rand::random();
        let send = message(SEND | INDICATION, &txid, &[xor_address(XOR_PEER_ADDRESS, peer, &txid), attr(DATA_ATTR, payload)]);
        (send, bind)
    }

    fn bind_message(&mut self, peer: SocketAddr, number: u16) -> Vec<u8> {
        let mut channel = number.to_be_bytes().to_vec();
        channel.extend_from_slice(&[0, 0]);
        self.request(CHANNEL_BIND, vec![attr(CHANNEL_NUMBER, &channel), xor_address(XOR_PEER_ADDRESS, peer, &[0; 12])], Some(peer))
    }

    /// Reads something the relay sent. Returns a peer's packet if it carried one,
    /// and any messages to send back (a signed retry, for instance).
    pub fn handle(&mut self, buf: &[u8]) -> (Option<PeerPacket>, Vec<Vec<u8>>) {
        // ChannelData: the first two bits are 01.
        if buf.len() >= 4 && (0x40..0x80).contains(&buf[0]) {
            let number = u16::from_be_bytes([buf[0], buf[1]]);
            let len = u16::from_be_bytes([buf[2], buf[3]]) as usize;
            let data = buf.get(4..4 + len).map(<[u8]>::to_vec);
            return (data.and_then(|d| Some((*self.by_channel.get(&number)?, d))), Vec::new());
        }
        let Some(msg) = Parsed::read(buf) else { return (None, Vec::new()) };
        if msg.kind == DATA | INDICATION {
            let peer = msg.address(XOR_PEER_ADDRESS);
            let data = msg.get(DATA_ATTR).map(<[u8]>::to_vec);
            return (peer.zip(data), Vec::new());
        }
        let Some(pending) = self.pending.remove(&msg.txid) else { return (None, Vec::new()) };
        let class = msg.kind & 0x110;
        let mut out = Vec::new();
        if class == ERROR {
            let code = msg.error_code();
            // 401 Unauthorized (first contact) or 438 Stale Nonce: sign with what the relay sent and try again.
            if matches!(code, Some(401) | Some(438)) && pending.tries < RETRIES {
                if let Some(realm) = msg.get(REALM) {
                    self.realm = Some(String::from_utf8_lossy(realm).into_owned());
                }
                if let Some(nonce) = msg.get(NONCE) {
                    self.nonce = Some(String::from_utf8_lossy(nonce).into_owned());
                }
                if code == Some(401) && pending.tries > 0 && pending.method == ALLOCATE {
                    tracing::warn!("the relay refused our login");
                    self.state = State::Failed;
                    return (None, out);
                }
                out.push(self.request_try(pending.method, pending.attrs, pending.peer, pending.tries + 1));
            } else if pending.method == ALLOCATE {
                tracing::warn!("the relay refused an allocation: {code:?}");
                self.state = State::Failed;
            } else if pending.method == CHANNEL_BIND {
                // Keep using Send indications for this peer.
                if let Some(peer) = pending.peer {
                    self.channels.remove(&peer);
                }
            }
            return (None, out);
        }
        if class == SUCCESS {
            match pending.method {
                ALLOCATE => {
                    if let Some(relayed) = msg.address(XOR_RELAYED_ADDRESS) {
                        tracing::info!("relay address {relayed}");
                        self.state = State::Ready(relayed);
                        self.allocated_at = Instant::now();
                        self.lifetime = msg.lifetime().unwrap_or(self.lifetime);
                    }
                }
                REFRESH => {
                    self.allocated_at = Instant::now();
                    self.lifetime = msg.lifetime().unwrap_or(self.lifetime);
                }
                CHANNEL_BIND => {
                    if let Some(entry) = pending.peer.and_then(|p| self.channels.get_mut(&p)) {
                        entry.1 = true;
                        entry.2 = Instant::now();
                    }
                }
                _ => {}
            }
        }
        (None, out)
    }

    /// Housekeeping: resends lost requests, keeps the allocation, permissions and channels alive.
    pub fn tick(&mut self) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        let mut dead = Vec::new();
        for (txid, p) in self.pending.iter_mut() {
            if p.sent.elapsed() >= RETRY {
                if p.tries >= RETRIES {
                    dead.push(*txid);
                    continue;
                }
                p.tries += 1;
                p.sent = Instant::now();
                out.push(p.message.clone());
            }
        }
        for txid in dead {
            if let Some(p) = self.pending.remove(&txid) {
                if p.method == ALLOCATE {
                    tracing::warn!("the relay didn't answer");
                    self.state = State::Failed;
                }
            }
        }
        if let State::Ready(_) = self.state {
            if self.allocated_at.elapsed() > self.lifetime / 2 && !self.pending.values().any(|p| p.method == REFRESH) {
                out.push(self.request(REFRESH, vec![attr(LIFETIME, &600u32.to_be_bytes())], None));
            }
            let stale: Vec<IpAddr> = self.permissions.iter().filter(|(_, t)| t.elapsed() >= PERMISSION_RENEW).map(|(ip, _)| *ip).collect();
            for ip in stale {
                self.permissions.remove(&ip);
                out.extend(self.permit(ip));
            }
            let due: Vec<(SocketAddr, u16)> =
                self.channels.iter().filter(|(_, (_, bound, at))| *bound && at.elapsed() >= CHANNEL_RENEW).map(|(p, (n, _, _))| (*p, *n)).collect();
            for (peer, number) in due {
                if let Some(entry) = self.channels.get_mut(&peer) {
                    entry.2 = Instant::now();
                }
                out.push(self.bind_message(peer, number));
            }
        }
        out
    }

    /// Lets go of the allocation (a Refresh with lifetime 0).
    pub fn release(&mut self) -> Option<Vec<u8>> {
        matches!(self.state, State::Ready(_)).then(|| self.request(REFRESH, vec![attr(LIFETIME, &0u32.to_be_bytes())], None))
    }
}

/// Whether a packet came from a relay rather than straight from a peer: TURN
/// messages start with 00 or 01 in their first two bits, sealed voice with 0x10–0x12.
pub fn looks_like_turn(buf: &[u8]) -> bool {
    buf.len() >= 4 && (buf[0] < 0x04 || (0x40..0x80).contains(&buf[0]))
}

// ---------- messages ----------

fn attr(kind: u16, value: &[u8]) -> Vec<u8> {
    let mut a = Vec::with_capacity(4 + value.len() + 3);
    a.extend_from_slice(&kind.to_be_bytes());
    a.extend_from_slice(&(value.len() as u16).to_be_bytes());
    a.extend_from_slice(value);
    while a.len() % 4 != 0 {
        a.push(0);
    }
    a
}

fn xor_address(kind: u16, addr: SocketAddr, txid: &[u8; 12]) -> Vec<u8> {
    let port = addr.port() ^ 0x2112;
    let mut v = vec![0];
    match addr.ip().to_canonical() {
        IpAddr::V4(ip) => {
            v.push(0x01);
            v.extend_from_slice(&port.to_be_bytes());
            v.extend(ip.octets().iter().zip(MAGIC).map(|(b, m)| b ^ m));
        }
        IpAddr::V6(ip) => {
            v.push(0x02);
            v.extend_from_slice(&port.to_be_bytes());
            let mask: Vec<u8> = MAGIC.iter().chain(txid).copied().collect();
            v.extend(ip.octets().iter().zip(mask).map(|(b, m)| b ^ m));
        }
    }
    attr(kind, &v)
}

fn message(kind: u16, txid: &[u8; 12], attrs: &[Vec<u8>]) -> Vec<u8> {
    let body: Vec<u8> = attrs.concat();
    let mut m = Vec::with_capacity(20 + body.len());
    m.extend_from_slice(&kind.to_be_bytes());
    m.extend_from_slice(&(body.len() as u16).to_be_bytes());
    m.extend_from_slice(&MAGIC);
    m.extend_from_slice(txid);
    m.extend_from_slice(&body);
    m
}

/// A message ending in MESSAGE-INTEGRITY: HMAC-SHA1 over everything before it, with
/// the length already counting the integrity attribute.
fn with_integrity(kind: u16, txid: &[u8; 12], attrs: &[Vec<u8>], key: &[u8]) -> Vec<u8> {
    let mut m = message(kind, txid, attrs);
    let len = (m.len() - 20 + 24) as u16;
    m[2..4].copy_from_slice(&len.to_be_bytes());
    let mut mac = Hmac::<Sha1>::new_from_slice(key).expect("any key length");
    mac.update(&m);
    let tag = mac.finalize().into_bytes();
    m.extend_from_slice(&attr(MESSAGE_INTEGRITY, &tag));
    m
}

struct Parsed<'a> {
    kind: u16,
    txid: [u8; 12],
    attrs: Vec<(u16, &'a [u8])>,
}

impl<'a> Parsed<'a> {
    fn read(buf: &'a [u8]) -> Option<Self> {
        if buf.len() < 20 || buf[0] & 0xC0 != 0 || buf[4..8] != MAGIC {
            return None;
        }
        let kind = u16::from_be_bytes([buf[0], buf[1]]);
        let end = (20 + u16::from_be_bytes([buf[2], buf[3]]) as usize).min(buf.len());
        let txid: [u8; 12] = buf[8..20].try_into().ok()?;
        let mut attrs = Vec::new();
        let mut i = 20;
        while i + 4 <= end {
            let t = u16::from_be_bytes([buf[i], buf[i + 1]]);
            let len = u16::from_be_bytes([buf[i + 2], buf[i + 3]]) as usize;
            let value = buf.get(i + 4..i + 4 + len)?;
            attrs.push((t, value));
            i += 4 + len.div_ceil(4) * 4;
        }
        Some(Parsed { kind, txid, attrs })
    }

    fn get(&self, kind: u16) -> Option<&'a [u8]> {
        self.attrs.iter().find(|(t, _)| *t == kind).map(|(_, v)| *v)
    }

    fn address(&self, kind: u16) -> Option<SocketAddr> {
        let v = self.get(kind)?;
        let port = u16::from_be_bytes([*v.get(2)?, *v.get(3)?]) ^ 0x2112;
        match v.get(1)? {
            0x01 if v.len() >= 8 => {
                let ip: [u8; 4] = std::array::from_fn(|i| v[4 + i] ^ MAGIC[i]);
                Some(SocketAddr::from((ip, port)))
            }
            0x02 if v.len() >= 20 => {
                let mask: Vec<u8> = MAGIC.iter().chain(&self.txid).copied().collect();
                let ip: [u8; 16] = std::array::from_fn(|i| v[4 + i] ^ mask[i]);
                Some(SocketAddr::from((ip, port)))
            }
            _ => None,
        }
    }

    fn error_code(&self) -> Option<u16> {
        let v = self.get(ERROR_CODE)?;
        Some(*v.get(2)? as u16 * 100 + *v.get(3)? as u16)
    }

    fn lifetime(&self) -> Option<Duration> {
        let v = self.get(LIFETIME)?;
        Some(Duration::from_secs(u32::from_be_bytes(v.get(0..4)?.try_into().ok()?) as u64))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tiny relay for tests: asks for a login, then grants everything.
    struct FakeRelay {
        key: [u8; 16],
        relayed: SocketAddr,
    }

    impl FakeRelay {
        fn new() -> Self {
            FakeRelay { key: Md5::digest(b"alice:hopp.test:secret").into(), relayed: "198.51.100.7:50000".parse().unwrap() }
        }

        fn answer(&self, req: &[u8]) -> Vec<u8> {
            let msg = Parsed::read(req).expect("a STUN message");
            let method = msg.kind & !0x110;
            // Unsigned: ask for a login.
            let Some(mi) = msg.get(MESSAGE_INTEGRITY) else {
                let mut code = vec![0, 0, 4, 1];
                code.extend_from_slice(b"Unauthorized");
                return message(method | ERROR, &msg.txid, &[attr(ERROR_CODE, &code), attr(REALM, b"hopp.test"), attr(NONCE, b"n0nce")]);
            };
            // Check the signature the way a real relay does.
            let at = req.len() - 24;
            let mut signed = req[..at].to_vec();
            let len = (at - 20 + 24) as u16;
            signed[2..4].copy_from_slice(&len.to_be_bytes());
            let mut mac = Hmac::<Sha1>::new_from_slice(&self.key).unwrap();
            mac.update(&signed);
            assert_eq!(mac.finalize().into_bytes().as_slice(), mi, "message integrity");
            let attrs = if method == ALLOCATE {
                vec![xor_address(XOR_RELAYED_ADDRESS, self.relayed, &msg.txid), attr(LIFETIME, &600u32.to_be_bytes())]
            } else {
                vec![]
            };
            message(method | SUCCESS, &msg.txid, &attrs)
        }
    }

    fn login() -> TurnLogin {
        TurnLogin { server: "203.0.113.1:3478".into(), username: "alice".into(), credential: "secret".into() }
    }

    #[test]
    fn allocates_with_a_signed_login() {
        let relay = FakeRelay::new();
        let (mut turn, first) = Turn::new("203.0.113.1:3478".parse().unwrap(), &login());
        let (_, retry) = turn.handle(&relay.answer(&first));
        assert_eq!(retry.len(), 1, "signs and asks again after 401");
        turn.handle(&relay.answer(&retry[0]));
        assert_eq!(turn.state(), State::Ready(relay.relayed));
    }

    #[test]
    fn sends_through_channels_once_bound_and_reads_what_comes_back() {
        let relay = FakeRelay::new();
        let (mut turn, first) = Turn::new("203.0.113.1:3478".parse().unwrap(), &login());
        let (_, retry) = turn.handle(&relay.answer(&first));
        turn.handle(&relay.answer(&retry[0]));
        let peer: SocketAddr = "192.0.2.9:4000".parse().unwrap();
        let permit = turn.permit(peer.ip()).expect("a permission request");
        turn.handle(&relay.answer(&permit));

        // Before the channel is bound: a Send indication carrying the packet.
        let (first_send, bind) = turn.wrap(peer, b"voice");
        let sent = Parsed::read(&first_send).unwrap();
        assert_eq!(sent.kind, SEND | INDICATION);
        assert_eq!(sent.address(XOR_PEER_ADDRESS), Some(peer));
        assert_eq!(sent.get(DATA_ATTR), Some(&b"voice"[..]));
        turn.handle(&relay.answer(&bind.expect("asks for a channel")));

        // Bound: four bytes of header, then the packet.
        let (data, none) = turn.wrap(peer, b"voice");
        assert!(none.is_none());
        assert_eq!(&data[..2], &0x4000u16.to_be_bytes());
        assert_eq!(&data[4..], b"voice");

        // From the peer: ChannelData and Data indications both come out as (peer, packet).
        assert_eq!(turn.handle(&data).0, Some((peer, b"voice".to_vec())));
        let txid = [7u8; 12];
        let indication = message(DATA | INDICATION, &txid, &[xor_address(XOR_PEER_ADDRESS, peer, &txid), attr(DATA_ATTR, b"hi")]);
        assert_eq!(turn.handle(&indication).0, Some((peer, b"hi".to_vec())));
    }

    #[test]
    fn ipv6_peers_are_encoded_and_read_back() {
        let peer: SocketAddr = "[2a00:801:210::5]:4000".parse().unwrap();
        let txid = [3u8; 12];
        let m = message(DATA | INDICATION, &txid, &[xor_address(XOR_PEER_ADDRESS, peer, &txid)]);
        assert_eq!(Parsed::read(&m).unwrap().address(XOR_PEER_ADDRESS), Some(peer));
    }

    #[test]
    fn a_wrong_password_fails_instead_of_looping() {
        let relay = FakeRelay::new();
        let bad = TurnLogin { credential: "wrong".into(), ..login() };
        let (mut turn, first) = Turn::new("203.0.113.1:3478".parse().unwrap(), &bad);
        let (_, retry) = turn.handle(&relay.answer(&first));
        // The fake relay asserts on bad signatures; a real one answers 401 again.
        let txid = Parsed::read(&retry[0]).unwrap().txid;
        let mut code = vec![0, 0, 4, 1];
        code.extend_from_slice(b"Unauthorized");
        let refused = message(ALLOCATE | ERROR, &txid, &[attr(ERROR_CODE, &code), attr(REALM, b"hopp.test"), attr(NONCE, b"n0nce")]);
        turn.handle(&refused);
        assert_eq!(turn.state(), State::Failed);
    }

    #[test]
    fn tells_relay_packets_from_sealed_voice() {
        assert!(looks_like_turn(&[0x01, 0x01, 0, 0]));
        assert!(looks_like_turn(&[0x40, 0x00, 0, 5]));
        assert!(!looks_like_turn(&[0x10, 0, 0, 0]));
        assert!(!looks_like_turn(&[0x12, 0, 0, 0]));
    }
}

/// A small but real TURN relay on this computer, for tests: it hands out relay
/// addresses and passes packets both ways (channels and indications).
#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use std::net::UdpSocket;
    use std::sync::{Arc, Mutex};

    pub(crate) struct Relay {
        pub(crate) login: TurnLogin,
    }

    struct Allocation {
        relay: Arc<UdpSocket>,
        channels: Arc<Mutex<HashMap<u16, SocketAddr>>>,
    }

    impl Relay {
        pub(crate) fn spawn() -> Relay {
            let server = Arc::new(UdpSocket::bind("127.0.0.1:0").unwrap());
            let addr = server.local_addr().unwrap();
            let allocations: Arc<Mutex<HashMap<SocketAddr, Allocation>>> = Arc::default();
            std::thread::spawn(move || {
                let mut buf = [0u8; 2048];
                loop {
                    let Ok((len, client)) = server.recv_from(&mut buf) else { return };
                    let req = buf[..len].to_vec();
                    // ChannelData from a client: out through its relay address.
                    if (0x40..0x80).contains(&req[0]) {
                        let number = u16::from_be_bytes([req[0], req[1]]);
                        let n = u16::from_be_bytes([req[2], req[3]]) as usize;
                        if let Some(a) = allocations.lock().unwrap().get(&client) {
                            if let Some(peer) = a.channels.lock().unwrap().get(&number) {
                                let _ = a.relay.send_to(&req[4..4 + n], peer);
                            }
                        }
                        continue;
                    }
                    let Some(msg) = Parsed::read(&req) else { continue };
                    let method = msg.kind & !0x110;
                    if msg.kind == SEND | INDICATION {
                        if let (Some(peer), Some(data)) = (msg.address(XOR_PEER_ADDRESS), msg.get(DATA_ATTR)) {
                            if let Some(a) = allocations.lock().unwrap().get(&client) {
                                let _ = a.relay.send_to(data, peer);
                            }
                        }
                        continue;
                    }
                    if msg.get(MESSAGE_INTEGRITY).is_none() {
                        let mut code = vec![0, 0, 4, 1];
                        code.extend_from_slice(b"Unauthorized");
                        let answer = message(method | ERROR, &msg.txid, &[attr(ERROR_CODE, &code), attr(REALM, b"hopp.test"), attr(NONCE, b"abc")]);
                        let _ = server.send_to(&answer, client);
                        continue;
                    }
                    let attrs = match method {
                        ALLOCATE => {
                            let relay = Arc::new(UdpSocket::bind("127.0.0.1:0").unwrap());
                            let relayed = relay.local_addr().unwrap();
                            let channels: Arc<Mutex<HashMap<u16, SocketAddr>>> = Arc::default();
                            // Packets from peers to the relay address go on to the client.
                            let (r, ch, s) = (relay.clone(), channels.clone(), server.clone());
                            std::thread::spawn(move || {
                                let mut buf = [0u8; 2048];
                                while let Ok((n, peer)) = r.recv_from(&mut buf) {
                                    let bound = ch.lock().unwrap().iter().find(|(_, p)| **p == peer).map(|(k, _)| *k);
                                    let out = match bound {
                                        Some(number) => {
                                            let mut d = number.to_be_bytes().to_vec();
                                            d.extend_from_slice(&(n as u16).to_be_bytes());
                                            d.extend_from_slice(&buf[..n]);
                                            d
                                        }
                                        None => {
                                            let txid: [u8; 12] = rand::random();
                                            message(DATA | INDICATION, &txid, &[xor_address(XOR_PEER_ADDRESS, peer, &txid), attr(DATA_ATTR, &buf[..n])])
                                        }
                                    };
                                    let _ = s.send_to(&out, client);
                                }
                            });
                            allocations.lock().unwrap().insert(client, Allocation { relay, channels });
                            vec![xor_address(XOR_RELAYED_ADDRESS, relayed, &msg.txid), attr(LIFETIME, &600u32.to_be_bytes())]
                        }
                        CHANNEL_BIND => {
                            let number = msg.get(CHANNEL_NUMBER).map(|v| u16::from_be_bytes([v[0], v[1]]));
                            if let (Some(number), Some(peer)) = (number, msg.address(XOR_PEER_ADDRESS)) {
                                if let Some(a) = allocations.lock().unwrap().get(&client) {
                                    a.channels.lock().unwrap().insert(number, peer);
                                }
                            }
                            vec![]
                        }
                        _ => vec![],
                    };
                    let _ = server.send_to(&message(method | SUCCESS, &msg.txid, &attrs), client);
                }
            });
            Relay { login: TurnLogin { server: addr.to_string(), username: "tester".into(), credential: "pass".into() } }
        }
    }
}
