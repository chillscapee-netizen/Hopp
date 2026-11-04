//! Control connection (TCP to self-hosted servers, WebSocket to cloud servers):
//! login, presence, channels and chat.

use std::net::SocketAddr;
use std::time::Duration;

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use strom_shared::*;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::identity::Identity;

const PING_INTERVAL: Duration = Duration::from_secs(10);
/// Every ping is answered, so this long without hearing anything means the
/// connection is dead (wifi gone, laptop slept) even if it never closed.
const SILENCE_TIMEOUT: Duration = Duration::from_secs(35);
const ANSWER_TIMEOUT: Duration = Duration::from_secs(5);
pub const INVITE_SCHEME: &str = "hopp://";
/// Links made before the app was called Hopp.
pub const OLD_INVITE_SCHEME: &str = "strom://";

/// Everything the client needs after a successful login.
pub struct Session {
    pub control: Control,
    pub roster: Roster,
    pub udp_token: u64,
    /// Where to send voice; `None` for cloud servers, which have no UDP relay.
    pub udp_addr: Option<SocketAddr>,
    /// Server messages after the welcome. Yields `None` when the connection drops.
    pub events: mpsc::UnboundedReceiver<ServerMsg>,
}

/// Sends control messages; dropping it closes the connection.
#[derive(Clone)]
pub struct Control {
    tx: mpsc::UnboundedSender<ClientMsg>,
}

impl Control {
    pub fn send(&self, msg: ClientMsg) {
        let _ = self.tx.send(msg);
    }
}

/// Client-side view of the server: channels and who is where.
#[derive(Debug, Clone, Serialize)]
pub struct Roster {
    pub server_name: String,
    pub server_icon: Option<String>,
    pub me: SessionId,
    pub channels: Vec<Channel>,
    pub users: Vec<User>,
}

impl Roster {
    pub fn apply(&mut self, msg: &ServerMsg) {
        match msg {
            ServerMsg::UserJoined { user } | ServerMsg::UserUpdated { user } => {
                match self.users.iter_mut().find(|u| u.session_id == user.session_id) {
                    Some(existing) => *existing = user.clone(),
                    None => self.users.push(user.clone()),
                }
            }
            ServerMsg::UserLeft { session_id } => self.users.retain(|u| u.session_id != *session_id),
            ServerMsg::ChannelsUpdated { channels } => self.channels = channels.clone(),
            ServerMsg::ServerUpdated { name, icon } => {
                self.server_name = name.clone();
                self.server_icon = icon.clone();
            }
            _ => {}
        }
    }

    pub fn me(&self) -> Option<&User> {
        self.users.iter().find(|u| u.session_id == self.me)
    }
}

/// Accepts what people paste: `host`, `host:port` or an invite link
/// `strom://host:port/CODE`. Returns `host:port` and the invite code, if any.
pub fn parse_invite(input: &str) -> anyhow::Result<(String, Option<String>)> {
    let s = input.trim();
    let s = s.strip_prefix(INVITE_SCHEME).or_else(|| s.strip_prefix(OLD_INVITE_SCHEME)).unwrap_or(s);
    let (host, code) = match s.split_once('/') {
        Some((host, code)) => (host, Some(code.trim_matches('/')).filter(|c| !c.is_empty())),
        None => (s, None),
    };
    anyhow::ensure!(!host.is_empty() && !s.contains(char::is_whitespace), "That doesn't look like a server address.");
    let host = if host.contains(':') { host.to_string() } else { format!("{host}:{DEFAULT_PORT}") };
    Ok((host, code.map(str::to_uppercase)))
}

type WsStream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;

/// Reads server messages from either transport. `None` means the connection closed.
enum Reader {
    Tcp(BufReader<OwnedReadHalf>),
    Ws(SplitStream<WsStream>),
}

impl Reader {
    async fn next(&mut self) -> anyhow::Result<Option<ServerMsg>> {
        match self {
            Reader::Tcp(reader) => {
                let mut line = String::new();
                if reader.read_line(&mut line).await? == 0 {
                    return Ok(None);
                }
                Ok(Some(serde_json::from_str(&line)?))
            }
            Reader::Ws(stream) => loop {
                match stream.next().await.transpose()? {
                    None | Some(WsMessage::Close(_)) => return Ok(None),
                    Some(WsMessage::Text(text)) => return Ok(Some(serde_json::from_str(&text)?)),
                    Some(_) => continue,
                }
            },
        }
    }

    /// The next message during login, which must arrive promptly.
    async fn answer(&mut self) -> anyhow::Result<ServerMsg> {
        tokio::time::timeout(ANSWER_TIMEOUT, self.next())
            .await
            .map_err(|_| anyhow::anyhow!("server did not answer"))??
            .ok_or_else(|| anyhow::anyhow!("server closed the connection"))
    }
}

/// Sends client messages: JSON lines over TCP, one JSON text frame per message over WebSocket.
enum Writer {
    Tcp(OwnedWriteHalf),
    Ws(SplitSink<WsStream, WsMessage>),
}

impl Writer {
    async fn send(&mut self, msg: &ClientMsg) -> anyhow::Result<()> {
        match self {
            Writer::Tcp(wr) => wr.write_all(&encode_line(msg)).await?,
            Writer::Ws(sink) => sink.send(WsMessage::Text(serde_json::to_string(msg)?.into())).await?,
        }
        Ok(())
    }

    /// Tells the server we're leaving. Without this a WebSocket stays open until
    /// the server notices, and the account looks connected in the meantime.
    async fn close(&mut self) {
        match self {
            Writer::Tcp(wr) => {
                let _ = wr.shutdown().await;
            }
            Writer::Ws(sink) => {
                let _ = sink.close().await;
            }
        }
    }
}

/// Cloud servers are reached by WebSocket URL; everything else is a self-hosted TCP server.
fn is_websocket(address: &str) -> bool {
    address.starts_with("ws://") || address.starts_with("wss://")
}

async fn open_tcp(address: &str) -> anyhow::Result<(Reader, Writer, SocketAddr)> {
    let (addr, _) = parse_invite(address)?;
    // "localhost" resolves to both ::1 and 127.0.0.1; use whichever the server listens on.
    let mut last_err = anyhow::anyhow!("could not resolve {addr}");
    for candidate in tokio::net::lookup_host(&addr).await? {
        match tokio::time::timeout(ANSWER_TIMEOUT, TcpStream::connect(candidate)).await {
            Ok(Ok(stream)) => {
                stream.set_nodelay(true)?;
                let (rd, wr) = stream.into_split();
                return Ok((Reader::Tcp(BufReader::new(rd)), Writer::Tcp(wr), candidate));
            }
            Ok(Err(e)) => last_err = e.into(),
            Err(_) => last_err = anyhow::anyhow!("timed out connecting to {addr}"),
        }
    }
    Err(last_err)
}

async fn open_websocket(url: &str) -> anyhow::Result<(Reader, Writer)> {
    let (stream, _) = tokio::time::timeout(ANSWER_TIMEOUT, tokio_tungstenite::connect_async(url))
        .await
        .map_err(|_| anyhow::anyhow!("timed out connecting to {url}"))??;
    let (sink, stream) = stream.split();
    Ok((Reader::Ws(stream), Writer::Ws(sink)))
}

/// Connects and logs in with a Hopp ID.
///
/// `address` is a self-hosted server (`host:port`) or a cloud server's WebSocket
/// URL. `invite` is needed the first time; `create` creates a new cloud server
/// with that name, owned by this identity.
pub async fn connect(address: &str, identity: &Identity, invite: Option<&str>, create: Option<&str>) -> anyhow::Result<Session> {
    let (mut reader, mut writer, server) = if is_websocket(address) {
        let (r, w) = open_websocket(address).await?;
        (r, w, None)
    } else {
        let (r, w, addr) = open_tcp(address).await?;
        (r, w, Some(addr))
    };

    let hello = ClientMsg::Hello {
        name: identity.name.clone(),
        protocol_version: PROTOCOL_VERSION,
        public_key: identity.public_key(),
        invite: invite.map(String::from),
        create: create.map(String::from),
    };
    writer.send(&hello).await?;
    let nonce = match reader.answer().await? {
        ServerMsg::Challenge { nonce } => hex::decode(nonce)?,
        ServerMsg::Error { message } => anyhow::bail!(message),
        other => anyhow::bail!("unexpected message during login: {other:?}"),
    };
    writer.send(&ClientMsg::Auth { signature: identity.sign_challenge(&nonce) }).await?;
    let (roster, udp_token, udp_port) = match reader.answer().await? {
        ServerMsg::Welcome { server_name, session_id, udp_token, udp_port, channels, users, server_icon } => {
            (Roster { server_name, server_icon, me: session_id, channels, users }, udp_token, udp_port)
        }
        ServerMsg::Error { message } => anyhow::bail!(message),
        other => anyhow::bail!("unexpected message during login: {other:?}"),
    };

    let (tx, mut out_rx) = mpsc::unbounded_channel::<ClientMsg>();
    tokio::spawn(async move {
        let mut ping = tokio::time::interval(PING_INTERVAL);
        loop {
            let msg = tokio::select! {
                msg = out_rx.recv() => match msg { Some(m) => m, None => break },
                _ = ping.tick() => ClientMsg::Ping,
            };
            if writer.send(&msg).await.is_err() {
                break;
            }
        }
        // The `Control` was dropped (disconnect or log out): close properly.
        writer.close().await;
    });

    let (ev_tx, events) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        loop {
            let Ok(next) = tokio::time::timeout(SILENCE_TIMEOUT, reader.next()).await else {
                tracing::warn!("the server went quiet; treating the connection as lost");
                break;
            };
            match next {
                Ok(Some(ServerMsg::Pong)) => {}
                Ok(Some(msg)) => {
                    if ev_tx.send(msg).is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                // A message we don't understand is skipped; a broken connection ends the session.
                Err(e) if e.is::<serde_json::Error>() => tracing::warn!("bad server message: {e}"),
                Err(_) => break,
            }
        }
    });

    Ok(Session {
        control: Control { tx },
        roster,
        udp_token,
        // Cloud servers have no UDP relay; they report port 0.
        udp_addr: server.filter(|_| udp_port != 0).map(|s| SocketAddr::new(s.ip(), udp_port)),
        events,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(id: SessionId, voice: Option<ChannelId>) -> User {
        User { session_id: id, name: format!("u{id}"), voice_channel: voice, muted: false, deafened: false, owner: false, public_key: String::new(), role: None }
    }

    #[test]
    fn roster_tracks_presence_and_channels() {
        let mut r = Roster { server_name: String::new(), server_icon: None, me: 1, channels: vec![], users: vec![user(1, None)] };
        r.apply(&ServerMsg::UserJoined { user: user(2, None) });
        r.apply(&ServerMsg::UserUpdated { user: user(2, Some(1)) });
        assert_eq!(r.users, vec![user(1, None), user(2, Some(1))]);
        r.apply(&ServerMsg::UserLeft { session_id: 2 });
        assert_eq!(r.users, vec![user(1, None)]);
        assert_eq!(r.me().unwrap().session_id, 1);

        let channels = vec![Channel { id: 4, name: "klipp".into(), kind: ChannelKind::Text, topic: None, category: None }];
        r.apply(&ServerMsg::ChannelsUpdated { channels: channels.clone() });
        assert_eq!(r.channels, channels);
    }

    #[test]
    fn parses_addresses_and_invite_links() {
        let ok = |s: &str| parse_invite(s).unwrap();
        assert_eq!(ok("localhost"), ("localhost:7777".into(), None));
        assert_eq!(ok(" 192.168.1.20:9000 "), ("192.168.1.20:9000".into(), None));
        assert_eq!(ok("strom://my.server.com/"), ("my.server.com:7777".into(), None));
        assert_eq!(ok("strom://10.0.0.5:7000/ab12cd34"), ("10.0.0.5:7000".into(), Some("AB12CD34".into())));
        assert!(parse_invite("strom://").is_err());
        assert!(parse_invite("two words").is_err());
    }
}
