//! End-to-end tests: real sockets on localhost, fake clients speaking the protocol.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use ed25519_dalek::{Signer, SigningKey};
use strom_server::{ServerConfig, Storage};
use strom_shared::*;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::time::timeout;

const WAIT: Duration = Duration::from_secs(2);
// Channel ids from the test config.
const GENERAL: ChannelId = 0;
const LOBBY: ChannelId = 1;
const GAMING: ChannelId = 2;

fn test_config() -> ServerConfig {
    ServerConfig::new("Test", &[("general", ChannelKind::Text), ("Lobby", ChannelKind::Voice), ("Gaming", ChannelKind::Voice)])
}

/// A running server whose owner ("admin") has made an unlimited invite for everyone else.
struct TestServer {
    addr: SocketAddr,
    admin: FakeClient,
    invite: String,
}

async fn bind_server(storage: Storage) -> SocketAddr {
    let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = tcp.local_addr().unwrap();
    let udp = UdpSocket::bind(addr).await.unwrap();
    tokio::spawn(strom_server::run(tcp, udp, test_config(), storage));
    addr
}

async fn start_server_with(storage: Storage, admin_key: &SigningKey) -> TestServer {
    let addr = bind_server(storage).await;
    // Tests connect over loopback, so the first person to arrive claims ownership.
    let mut admin = FakeClient::connect_with(addr, "admin", admin_key, None).await;
    let invite = admin.create_invite(None, None).await;
    TestServer { addr, admin, invite }
}

async fn start_server() -> TestServer {
    start_server_with(Storage::memory(), &new_key()).await
}

fn new_key() -> SigningKey {
    SigningKey::from_bytes(&rand::random())
}

struct FakeClient {
    reader: BufReader<OwnedReadHalf>,
    writer: OwnedWriteHalf,
    udp: UdpSocket,
    session_id: SessionId,
    token: u64,
    server: SocketAddr,
    welcome: ServerMsg,
}

/// Logs in and returns the server's reply to the signed challenge.
async fn login(
    server: SocketAddr,
    name: &str,
    key: &SigningKey,
    sign_with: &SigningKey,
    invite: Option<&str>,
) -> (BufReader<OwnedReadHalf>, OwnedWriteHalf, ServerMsg) {
    let (rd, mut writer) = TcpStream::connect(server).await.unwrap().into_split();
    let mut reader = BufReader::new(rd);
    let hello = ClientMsg::Hello {
        name: name.into(),
        protocol_version: PROTOCOL_VERSION,
        public_key: hex::encode(key.verifying_key().as_bytes()),
        invite: invite.map(String::from),
        create: None,
    };
    writer.write_all(&encode_line(&hello)).await.unwrap();
    let nonce = match recv(&mut reader).await {
        ServerMsg::Challenge { nonce } => hex::decode(nonce).unwrap(),
        other => return (reader, writer, other),
    };
    let signature = hex::encode(sign_with.sign(&auth_message(&nonce)).to_bytes());
    writer.write_all(&encode_line(&ClientMsg::Auth { signature })).await.unwrap();
    let reply = recv(&mut reader).await;
    (reader, writer, reply)
}

/// The error a login attempt ends with; panics if it succeeds.
async fn login_error(server: SocketAddr, name: &str, key: &SigningKey, invite: Option<&str>) -> String {
    match login(server, name, key, key, invite).await.2 {
        ServerMsg::Error { message } => message,
        other => panic!("expected the login to fail, got {other:?}"),
    }
}

impl FakeClient {
    async fn connect(server: &TestServer, name: &str) -> Self {
        Self::connect_with(server.addr, name, &new_key(), Some(&server.invite)).await
    }

    async fn connect_with(server: SocketAddr, name: &str, key: &SigningKey, invite: Option<&str>) -> Self {
        let (reader, writer, welcome) = login(server, name, key, key, invite).await;
        let ServerMsg::Welcome { session_id, udp_token, udp_port, .. } = welcome.clone() else {
            panic!("expected welcome, got {welcome:?}");
        };
        let udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let server_udp = SocketAddr::new(server.ip(), udp_port);
        let mut c = FakeClient { reader, writer, udp, session_id, token: udp_token, server: server_udp, welcome };
        c.register_udp().await;
        c
    }

    fn is_owner(&self) -> bool {
        let ServerMsg::Welcome { users, .. } = &self.welcome else { unreachable!() };
        users.iter().any(|u| u.session_id == self.session_id && u.owner)
    }

    async fn register_udp(&mut self) {
        let mut buf = Vec::new();
        ClientPacket::Ping { session_id: self.session_id, token: self.token, nonce: 0 }.write(&mut buf);
        self.udp.send_to(&buf, self.server).await.unwrap();
        let mut echo = [0u8; 64];
        timeout(WAIT, self.udp.recv_from(&mut echo)).await.expect("ping echo").unwrap();
    }

    async fn send(&mut self, msg: ClientMsg) {
        self.writer.write_all(&encode_line(&msg)).await.unwrap();
    }

    async fn create_invite(&mut self, max_uses: Option<u32>, expires_in_hours: Option<u32>) -> String {
        self.send(ClientMsg::CreateInvite { max_uses, expires_in_hours }).await;
        match self.wait_for(|m| matches!(m, ServerMsg::InviteCreated { .. })).await {
            ServerMsg::InviteCreated { invite } => invite.code,
            _ => unreachable!(),
        }
    }

    /// Joins a voice channel and waits until the server has broadcast it.
    async fn join_voice(&mut self, channel: ChannelId) {
        self.send(ClientMsg::JoinVoice { channel }).await;
        let id = self.session_id;
        self.wait_for(|m| matches!(m, ServerMsg::UserUpdated { user } if user.session_id == id && user.voice_channel == Some(channel)))
            .await;
    }

    async fn chat(&mut self, text: &str) -> ChatMessage {
        self.send(ClientMsg::SendChat { channel: GENERAL, text: text.into(), reply_to: None }).await;
        let text = text.to_string();
        match self.wait_for(|m| matches!(m, ServerMsg::Chat { message } if message.text == text)).await {
            ServerMsg::Chat { message } => message,
            _ => unreachable!(),
        }
    }

    async fn speak(&self, seq: u32, opus: &[u8]) {
        let mut buf = Vec::new();
        ClientPacket::Voice { session_id: self.session_id, token: self.token, seq, opus }.write(&mut buf);
        self.udp.send_to(&buf, self.server).await.unwrap();
    }

    async fn hear(&self) -> Option<(SessionId, u32, Vec<u8>)> {
        let mut buf = [0u8; 1500];
        let (n, _) = timeout(Duration::from_millis(300), self.udp.recv_from(&mut buf)).await.ok()?.ok()?;
        let v = ServerVoice::parse(&buf[..n])?;
        Some((v.sender, v.seq, v.opus.to_vec()))
    }

    /// Reads control messages until one matches.
    async fn wait_for(&mut self, pred: impl Fn(&ServerMsg) -> bool) -> ServerMsg {
        loop {
            let msg = recv(&mut self.reader).await;
            if pred(&msg) {
                return msg;
            }
        }
    }

    async fn error(&mut self) -> String {
        match self.wait_for(|m| matches!(m, ServerMsg::Error { .. })).await {
            ServerMsg::Error { message } => message,
            _ => unreachable!(),
        }
    }

    /// Round-trips a ping so everything sent before it has been processed.
    async fn sync(&mut self) {
        self.send(ClientMsg::Ping).await;
        self.wait_for(|m| matches!(m, ServerMsg::Pong)).await;
    }
}

async fn recv(reader: &mut BufReader<OwnedReadHalf>) -> ServerMsg {
    let mut line = String::new();
    timeout(WAIT, reader.read_line(&mut line)).await.expect("server message").unwrap();
    serde_json::from_str(&line).unwrap_or_else(|e| panic!("bad server message {line:?}: {e}"))
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("strom-test-{name}-{}", rand::random::<u32>()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

// ---------- login & invites ----------

#[tokio::test]
async fn bad_signature_is_rejected() {
    let server = start_server().await;
    let (_, _, reply) = login(server.addr, "mallory", &new_key(), &new_key(), Some(&server.invite)).await;
    assert!(matches!(reply, ServerMsg::Error { .. }), "got {reply:?}");
}

#[tokio::test]
async fn rejects_empty_name() {
    let server = start_server().await;
    let message = login_error(server.addr, "  ", &new_key(), Some(&server.invite)).await;
    assert!(message.contains("Names"));
}

#[tokio::test]
async fn first_local_user_becomes_owner() {
    let server = start_server().await;
    let bob = FakeClient::connect(&server, "bob").await;
    assert!(server.admin.is_owner());
    assert!(!bob.is_owner());
}

#[tokio::test]
async fn newcomers_need_a_valid_invite() {
    let server = start_server().await;
    let key = new_key();
    assert!(login_error(server.addr, "stranger", &key, None).await.contains("invite-only"));
    assert!(login_error(server.addr, "stranger", &key, Some("NOPE1234")).await.contains("invalid"));

    drop(FakeClient::connect_with(server.addr, "stranger", &key, Some(&server.invite.to_lowercase())).await);
    tokio::time::sleep(Duration::from_millis(100)).await;
    // Members come back without an invite.
    FakeClient::connect_with(server.addr, "stranger", &key, None).await;
}

#[tokio::test]
async fn invites_run_out_and_can_be_revoked() {
    let mut server = start_server().await;
    let once = server.admin.create_invite(Some(1), Some(24)).await;
    FakeClient::connect_with(server.addr, "first", &new_key(), Some(&once)).await;
    assert!(login_error(server.addr, "second", &new_key(), Some(&once)).await.contains("invalid"));

    let revoked = server.admin.create_invite(None, None).await;
    server.admin.send(ClientMsg::RevokeInvite { code: revoked.clone() }).await;
    server.admin.wait_for(|m| matches!(m, ServerMsg::Invites { invites } if invites.iter().all(|i| i.code != revoked))).await;
    assert!(login_error(server.addr, "third", &new_key(), Some(&revoked)).await.contains("invalid"));
}

#[tokio::test]
async fn names_belong_to_their_key() {
    let server = start_server().await;
    let alice_key = new_key();
    drop(FakeClient::connect_with(server.addr, "alice", &alice_key, Some(&server.invite)).await);

    // A valid identity of their own, just trying to take alice's name.
    let message = login_error(server.addr, "ALICE", &new_key(), Some(&server.invite)).await;
    assert!(message.contains("already taken"));

    tokio::time::sleep(Duration::from_millis(100)).await;
    FakeClient::connect_with(server.addr, "alice", &alice_key, None).await;
}

#[tokio::test]
async fn reconnecting_replaces_the_old_session() {
    let mut server = start_server().await;
    let key = new_key();
    let mut stale = FakeClient::connect_with(server.addr, "alice", &key, Some(&server.invite)).await;
    let fresh = FakeClient::connect_with(server.addr, "alice", &key, None).await;
    assert!(stale.error().await.contains("somewhere else"));
    let stale_id = stale.session_id;
    server.admin.wait_for(|m| matches!(m, ServerMsg::UserLeft { session_id } if *session_id == stale_id)).await;
    assert_ne!(fresh.session_id, stale.session_id);
}

// ---------- voice ----------

#[tokio::test]
async fn voice_reaches_same_voice_channel_only() {
    let server = start_server().await;
    let mut alice = FakeClient::connect(&server, "alice").await;
    let mut bob = FakeClient::connect(&server, "bob").await;
    let mut carol = FakeClient::connect(&server, "carol").await;

    // Nobody is in voice yet: nothing is relayed.
    alice.speak(1, b"hello").await;
    assert_eq!(bob.hear().await, None, "users outside voice must not hear anything");

    alice.join_voice(LOBBY).await;
    bob.join_voice(LOBBY).await;
    carol.join_voice(GAMING).await;
    alice.speak(2, b"hello").await;
    assert_eq!(bob.hear().await, Some((alice.session_id, 2, b"hello".to_vec())));
    assert_eq!(carol.hear().await, None, "other voice channel must not hear");
    assert_eq!(alice.hear().await, None, "speaker must not hear themself");

    bob.send(ClientMsg::LeaveVoice).await;
    bob.sync().await;
    alice.speak(3, b"bye").await;
    assert_eq!(bob.hear().await, None, "left voice, must not hear");
}

#[tokio::test]
async fn muted_and_deafened_are_respected() {
    let server = start_server().await;
    let mut alice = FakeClient::connect(&server, "alice").await;
    let mut bob = FakeClient::connect(&server, "bob").await;
    alice.join_voice(LOBBY).await;
    bob.join_voice(LOBBY).await;

    bob.send(ClientMsg::SetState { muted: false, deafened: true }).await;
    bob.sync().await;
    alice.speak(1, b"x").await;
    assert_eq!(bob.hear().await, None, "deafened user must not receive voice");

    alice.send(ClientMsg::SetState { muted: true, deafened: false }).await;
    bob.send(ClientMsg::SetState { muted: false, deafened: false }).await;
    alice.sync().await;
    bob.sync().await;
    alice.speak(2, b"y").await;
    assert_eq!(bob.hear().await, None, "muted user must not transmit");
}

#[tokio::test]
async fn wrong_token_is_dropped() {
    let server = start_server().await;
    let mut alice = FakeClient::connect(&server, "alice").await;
    let mut bob = FakeClient::connect(&server, "bob").await;
    alice.join_voice(LOBBY).await;
    bob.join_voice(LOBBY).await;

    let mut buf = Vec::new();
    ClientPacket::Voice { session_id: alice.session_id, token: alice.token ^ 1, seq: 1, opus: b"spoof" }.write(&mut buf);
    bob.udp.send_to(&buf, alice.server).await.unwrap();
    assert_eq!(bob.hear().await, None);
}

#[tokio::test]
async fn loopback_echoes_own_voice() {
    let server = start_server().await;
    let mut alice = FakeClient::connect(&server, "alice").await;
    alice.join_voice(LOBBY).await;
    alice.speak(1, b"me").await;
    assert_eq!(alice.hear().await, None);

    alice.send(ClientMsg::SetLoopback { enabled: true }).await;
    alice.sync().await;
    alice.speak(2, b"me").await;
    assert_eq!(alice.hear().await, Some((alice.session_id, 2, b"me".to_vec())));
}

#[tokio::test]
async fn joining_a_text_channel_as_voice_fails() {
    let server = start_server().await;
    let mut alice = FakeClient::connect(&server, "alice").await;
    alice.send(ClientMsg::JoinVoice { channel: GENERAL }).await;
    alice.error().await;
}

// ---------- presence & chat ----------

#[tokio::test]
async fn presence_is_broadcast() {
    let server = start_server().await;
    let mut alice = FakeClient::connect(&server, "alice").await;
    let bob = FakeClient::connect(&server, "bob").await;
    let bob_id = bob.session_id;

    alice.wait_for(|m| matches!(m, ServerMsg::UserJoined { user } if user.name == "bob")).await;
    drop(bob);
    alice.wait_for(|m| matches!(m, ServerMsg::UserLeft { session_id } if *session_id == bob_id)).await;
}

#[tokio::test]
async fn chat_reaches_everyone_and_is_replayed_at_login() {
    let server = start_server().await;
    let mut alice = FakeClient::connect(&server, "alice").await;
    let mut bob = FakeClient::connect(&server, "bob").await;
    bob.join_voice(GAMING).await;

    alice.send(ClientMsg::SendChat { channel: GENERAL, text: "  hi all  ".into(), reply_to: None }).await;
    let ServerMsg::Chat { message } = bob.wait_for(|m| matches!(m, ServerMsg::Chat { .. })).await else { unreachable!() };
    assert_eq!((message.channel, message.text.as_str(), message.sender_name.as_str()), (GENERAL, "hi all", "alice"));
    assert!(message.id > 0);

    let mut carol = FakeClient::connect(&server, "carol").await;
    let ServerMsg::ChatHistory { messages, .. } =
        carol.wait_for(|m| matches!(m, ServerMsg::ChatHistory { channel: GENERAL, .. })).await
    else {
        unreachable!()
    };
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].text, "hi all");
}

#[tokio::test]
async fn rejects_bad_chat() {
    let server = start_server().await;
    let mut alice = FakeClient::connect(&server, "alice").await;
    alice.send(ClientMsg::SendChat { channel: GENERAL, text: "x".repeat(MAX_CHAT_LEN + 1), reply_to: None }).await;
    alice.error().await;
    alice.send(ClientMsg::SendChat { channel: 99, text: "no such channel".into(), reply_to: None }).await;
    alice.error().await;
}

#[tokio::test]
async fn chat_floods_are_throttled() {
    let server = start_server().await;
    let mut alice = FakeClient::connect(&server, "alice").await;
    for i in 0..10 {
        alice.send(ClientMsg::SendChat { channel: GENERAL, text: format!("spam {i}"), reply_to: None }).await;
    }
    assert!(alice.error().await.contains("too fast"));
}

#[tokio::test]
async fn messages_can_be_deleted_by_author_or_owner() {
    let mut server = start_server().await;
    let mut alice = FakeClient::connect(&server, "alice").await;
    let mut bob = FakeClient::connect(&server, "bob").await;
    let first = alice.chat("first").await;
    let second = alice.chat("second").await;

    bob.send(ClientMsg::DeleteMessage { channel: GENERAL, id: first.id }).await;
    assert!(bob.error().await.contains("your own"));

    alice.send(ClientMsg::DeleteMessage { channel: GENERAL, id: first.id }).await;
    bob.wait_for(|m| matches!(m, ServerMsg::MessageDeleted { id, .. } if *id == first.id)).await;

    server.admin.send(ClientMsg::DeleteMessage { channel: GENERAL, id: second.id }).await;
    bob.wait_for(|m| matches!(m, ServerMsg::MessageDeleted { id, .. } if *id == second.id)).await;
}

#[tokio::test]
async fn typing_reaches_others() {
    let server = start_server().await;
    let mut alice = FakeClient::connect(&server, "alice").await;
    let mut bob = FakeClient::connect(&server, "bob").await;
    alice.send(ClientMsg::Typing { channel: GENERAL }).await;
    let id = alice.session_id;
    bob.wait_for(|m| matches!(m, ServerMsg::Typing { session_id, .. } if *session_id == id)).await;
}

// ---------- moderation ----------

#[tokio::test]
async fn owner_manages_channels() {
    let mut server = start_server().await;
    let mut guest = FakeClient::connect(&server, "guest").await;

    guest.send(ClientMsg::CreateChannel { name: "hack".into(), kind: ChannelKind::Text }).await;
    assert!(guest.error().await.contains("owner"));

    server.admin.send(ClientMsg::CreateChannel { name: "  Good Clips ".into(), kind: ChannelKind::Text }).await;
    let ServerMsg::ChannelsUpdated { channels } = guest.wait_for(|m| matches!(m, ServerMsg::ChannelsUpdated { .. })).await
    else {
        unreachable!()
    };
    let created = channels.last().unwrap();
    assert_eq!((created.name.as_str(), created.kind), ("good-clips", ChannelKind::Text));

    // Deleting a voice channel moves its occupants out of voice.
    guest.join_voice(GAMING).await;
    server.admin.send(ClientMsg::DeleteChannel { channel: GAMING }).await;
    let id = guest.session_id;
    guest.wait_for(|m| matches!(m, ServerMsg::UserUpdated { user } if user.session_id == id && user.voice_channel.is_none())).await;
}

#[tokio::test]
async fn kick_and_ban() {
    let mut server = start_server().await;
    let bob_key = new_key();
    let carol_key = new_key();
    let mut bob = FakeClient::connect_with(server.addr, "bob", &bob_key, Some(&server.invite)).await;
    let mut carol = FakeClient::connect_with(server.addr, "carol", &carol_key, Some(&server.invite)).await;

    carol.send(ClientMsg::Kick { session_id: bob.session_id, public_key: None }).await;
    assert!(carol.error().await.contains("owner"));

    server.admin.send(ClientMsg::Kick { session_id: bob.session_id, public_key: None }).await;
    bob.wait_for(|m| matches!(m, ServerMsg::Kicked { banned: false })).await;
    let bob_id = bob.session_id;
    carol.wait_for(|m| matches!(m, ServerMsg::UserLeft { session_id } if *session_id == bob_id)).await;
    // A kick is not a ban: bob may come back.
    drop(bob);
    FakeClient::connect_with(server.addr, "bob", &bob_key, None).await;

    server.admin.send(ClientMsg::Ban { session_id: carol.session_id, delete_hours: 0, public_key: None }).await;
    carol.wait_for(|m| matches!(m, ServerMsg::Kicked { banned: true })).await;
    drop(carol);
    assert!(login_error(server.addr, "carol", &carol_key, Some(&server.invite)).await.contains("banned"));

    let carol_pub = hex::encode(carol_key.verifying_key().as_bytes());
    server.admin.send(ClientMsg::Unban { public_key: carol_pub }).await;
    server.admin.wait_for(|m| matches!(m, ServerMsg::Bans { bans } if bans.is_empty())).await;
    FakeClient::connect_with(server.addr, "carol", &carol_key, None).await;
}

// ---------- persistence ----------

#[tokio::test]
async fn state_survives_restart() {
    let dir = temp_dir("restart");
    let admin_key = new_key();
    let invite;
    {
        let mut server = start_server_with(Storage::at(&dir).unwrap(), &admin_key).await;
        invite = server.invite.clone();
        server.admin.send(ClientMsg::CreateChannel { name: "Squad".into(), kind: ChannelKind::Voice }).await;
        let gone = server.admin.chat("delete me").await;
        server.admin.chat("is this saved?").await;
        server.admin.send(ClientMsg::DeleteMessage { channel: GENERAL, id: gone.id }).await;
        server.admin.wait_for(|m| matches!(m, ServerMsg::MessageDeleted { .. })).await;
    }

    // A fresh server on the same directory, as after a restart.
    let addr = bind_server(Storage::at(&dir).unwrap()).await;
    assert!(login_error(addr, "admin", &new_key(), Some(&invite)).await.contains("already taken"), "names must persist");
    FakeClient::connect_with(addr, "newcomer", &new_key(), Some(&invite)).await;

    let mut admin = FakeClient::connect_with(addr, "admin", &admin_key, None).await;
    assert!(admin.is_owner(), "ownership must persist");
    let ServerMsg::Welcome { channels, .. } = &admin.welcome else { unreachable!() };
    assert!(channels.iter().any(|c| c.name == "Squad"), "channels must persist");
    let ServerMsg::ChatHistory { messages, .. } =
        admin.wait_for(|m| matches!(m, ServerMsg::ChatHistory { channel: GENERAL, .. })).await
    else {
        unreachable!()
    };
    let texts: Vec<&str> = messages.iter().map(|m| m.text.as_str()).collect();
    assert_eq!(texts, ["is this saved?"], "chat and deletions must persist");
    let next = admin.chat("after restart").await;
    assert!(next.id > messages[0].id, "message ids must keep increasing");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn owner_renames_the_server_and_sets_a_picture() {
    let mut server = start_server().await;
    let mut guest = FakeClient::connect(&server, "guest").await;
    let icon = "data:image/png;base64,iVBORw0KGgo=".to_string();

    guest.send(ClientMsg::UpdateServer { name: "Hack".into(), icon: None, pictures_off: None }).await;
    assert!(guest.error().await.contains("owner"));

    server.admin.send(ClientMsg::UpdateServer { name: "  The Crew ".into(), icon: Some("https://evil.example/x.png".into()), pictures_off: None }).await;
    assert!(server.admin.error().await.contains("picture"));

    server.admin.send(ClientMsg::UpdateServer { name: "  The Crew ".into(), icon: Some(icon.clone()), pictures_off: None }).await;
    let ServerMsg::ServerUpdated { name, icon: got, .. } = guest.wait_for(|m| matches!(m, ServerMsg::ServerUpdated { .. })).await
    else {
        unreachable!()
    };
    assert_eq!((name.as_str(), got.as_deref()), ("The Crew", Some(icon.as_str())));

    // Newcomers see it in their welcome.
    let late = FakeClient::connect(&server, "late").await;
    let ServerMsg::Welcome { server_name, server_icon, .. } = &late.welcome else { unreachable!() };
    assert_eq!((server_name.as_str(), server_icon.as_deref()), ("The Crew", Some(icon.as_str())));
}

#[tokio::test]
async fn replies_edits_and_reactions() {
    let server = start_server().await;
    let mut alice = FakeClient::connect(&server, "alice").await;
    let mut bob = FakeClient::connect(&server, "bob").await;
    let question = alice.chat("who is in?").await;

    bob.send(ClientMsg::SendChat { channel: GENERAL, text: "me".into(), reply_to: Some(question.id) }).await;
    let ServerMsg::Chat { message: answer } = alice.wait_for(|m| matches!(m, ServerMsg::Chat { message } if message.text == "me")).await else { unreachable!() };
    let reply = answer.reply.expect("a reply");
    assert_eq!((reply.id, reply.sender_name.as_str(), reply.text.as_str()), (question.id, "alice", "who is in?"));

    bob.send(ClientMsg::EditMessage { channel: GENERAL, id: question.id, text: "hacked".into() }).await;
    assert!(bob.error().await.contains("your own"));
    alice.send(ClientMsg::EditMessage { channel: GENERAL, id: question.id, text: "who is in tonight?".into() }).await;
    let ServerMsg::MessageEdited { text, edited_at, .. } = bob.wait_for(|m| matches!(m, ServerMsg::MessageEdited { .. })).await else { unreachable!() };
    assert_eq!(text, "who is in tonight?");
    assert!(edited_at > 0);

    bob.send(ClientMsg::React { channel: GENERAL, id: question.id, emoji: "👍".into(), on: true }).await;
    let ServerMsg::Reactions { reactions, .. } = alice.wait_for(|m| matches!(m, ServerMsg::Reactions { .. })).await else { unreachable!() };
    assert_eq!(reactions.len(), 1);
    assert_eq!(reactions[0].keys.len(), 1);
    bob.send(ClientMsg::React { channel: GENERAL, id: question.id, emoji: "abc".into(), on: true }).await;
    assert!(bob.error().await.contains("emoji"));
    bob.send(ClientMsg::React { channel: GENERAL, id: question.id, emoji: "👍".into(), on: false }).await;
    let ServerMsg::Reactions { reactions, .. } = alice.wait_for(|m| matches!(m, ServerMsg::Reactions { .. })).await else { unreachable!() };
    assert!(reactions.is_empty());

    // Someone arriving later sees the edit.
    let mut carol = FakeClient::connect(&server, "carol").await;
    let ServerMsg::ChatHistory { messages, .. } = carol.wait_for(|m| matches!(m, ServerMsg::ChatHistory { channel: GENERAL, .. })).await else { unreachable!() };
    assert_eq!(messages[0].text, "who is in tonight?");
    assert!(messages[0].edited_at.is_some());
}

#[tokio::test]
async fn older_messages_come_in_pages() {
    let server = start_server().await;
    let mut alice = FakeClient::connect(&server, "alice").await;
    let mut ids = Vec::new();
    for i in 0..3 {
        ids.push(alice.chat(&format!("m{i}")).await.id);
    }
    alice.send(ClientMsg::LoadOlder { channel: GENERAL, before: ids[2] }).await;
    let ServerMsg::OlderHistory { messages, done, .. } = alice.wait_for(|m| matches!(m, ServerMsg::OlderHistory { .. })).await else { unreachable!() };
    assert_eq!(messages.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), ["m0", "m1"]);
    assert!(done);
}

#[test]
fn edits_and_reactions_survive_a_restart() {
    let dir = temp_dir("edits");
    let storage = Storage::at(&dir).unwrap();
    let mut m = ChatMessage { id: 1, channel: GENERAL, sender: 1, sender_name: "a".into(), author_key: "k".into(), text: "one".into(), sent_at: 1, reply: None, edited_at: None, reactions: vec![], pinned: false };
    storage.append_chat(&m);
    storage.append_chat(&ChatMessage { id: 2, text: "two".into(), ..m.clone() });
    m.text = "one, edited".into();
    m.edited_at = Some(5);
    storage.append_chat(&m);
    let (loaded, max) = storage.load_chat(GENERAL, 100);
    assert_eq!(max, 2);
    assert_eq!(loaded.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), ["one, edited", "two"]);
    let older = storage.load_before(GENERAL, 2, 10).unwrap();
    assert_eq!(older[0].text, "one, edited");
}

#[tokio::test]
async fn leaving_needs_a_new_invite_to_come_back() {
    let mut server = start_server().await;
    server.admin.send(ClientMsg::LeaveServer).await;
    assert!(server.admin.error().await.contains("own this server"));

    let mut alice = FakeClient::connect(&server, "alice").await;
    let alice_id = alice.session_id;
    alice.send(ClientMsg::LeaveServer).await;
    alice.wait_for(|m| matches!(m, ServerMsg::Left)).await;
    server.admin.wait_for(|m| matches!(m, ServerMsg::UserLeft { session_id } if *session_id == alice_id)).await;
}

#[tokio::test]
async fn owner_renames_and_reorders_channels() {
    let mut server = start_server().await;
    let mut alice = FakeClient::connect(&server, "alice").await;
    alice.send(ClientMsg::UpdateChannel { channel: GENERAL, name: "Chat".into(), topic: Some("x".into()), category: None, no_pictures: None, user_limit: None, afk_after: None, slowmode: None, private_roles: None }).await;
    assert!(alice.error().await.contains("owner"));

    server.admin.send(ClientMsg::UpdateChannel { channel: GENERAL, name: "Main Chat".into(), topic: Some(" Say hi ".into()), category: Some(" Info ".into()), no_pictures: None, user_limit: None, afk_after: None, slowmode: None, private_roles: None }).await;
    let ServerMsg::ChannelsUpdated { channels } = alice.wait_for(|m| matches!(m, ServerMsg::ChannelsUpdated { .. })).await else { unreachable!() };
    let general = channels.iter().find(|c| c.id == GENERAL).unwrap();
    assert_eq!((general.name.as_str(), general.topic.as_deref(), general.category.as_deref()), ("main-chat", Some("Say hi"), Some("Info")));

    let mut order: Vec<ChannelId> = channels.iter().map(|c| c.id).collect();
    order.reverse();
    server.admin.send(ClientMsg::ReorderChannels { order: order.clone() }).await;
    let ServerMsg::ChannelsUpdated { channels } = alice.wait_for(|m| matches!(m, ServerMsg::ChannelsUpdated { .. })).await else { unreachable!() };
    assert_eq!(channels.iter().map(|c| c.id).collect::<Vec<_>>(), order);
    server.admin.send(ClientMsg::ReorderChannels { order: vec![GENERAL] }).await;
    assert!(server.admin.error().await.contains("changed"));
}

#[tokio::test]
async fn owner_pins_messages() {
    let mut server = start_server().await;
    let mut alice = FakeClient::connect(&server, "alice").await;
    let m = alice.chat("remember this").await;
    alice.send(ClientMsg::Pin { channel: GENERAL, id: m.id, on: true }).await;
    assert!(alice.error().await.contains("owner"));
    server.admin.send(ClientMsg::Pin { channel: GENERAL, id: m.id, on: true }).await;
    alice.wait_for(|x| matches!(x, ServerMsg::Pinned { on: true, .. })).await;
    alice.send(ClientMsg::GetPins { channel: GENERAL }).await;
    let ServerMsg::Pins { messages, .. } = alice.wait_for(|x| matches!(x, ServerMsg::Pins { .. })).await else { unreachable!() };
    assert_eq!(messages.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), ["remember this"]);
}

#[tokio::test]
async fn search_finds_words_in_any_case_newest_first() {
    let server = start_server().await;
    let mut alice = FakeClient::connect(&server, "alice").await;
    let ServerMsg::Welcome { features, .. } = &alice.welcome else { unreachable!() };
    assert!(features.iter().any(|f| f == "search"), "the server says it can search");
    alice.chat("Raid tonight at eight").await;
    alice.chat("nothing to see here").await;
    alice.chat("who's up for the RAID?").await;
    alice.send(ClientMsg::Search { query: "raid".into() }).await;
    let ServerMsg::SearchResults { query, messages } = alice.wait_for(|m| matches!(m, ServerMsg::SearchResults { .. })).await else { unreachable!() };
    assert_eq!(query, "raid");
    assert_eq!(messages.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), ["who's up for the RAID?", "Raid tonight at eight"]);
    // A single letter finds nothing rather than everything.
    alice.send(ClientMsg::Search { query: "a".into() }).await;
    let ServerMsg::SearchResults { messages, .. } = alice.wait_for(|m| matches!(m, ServerMsg::SearchResults { .. })).await else { unreachable!() };
    assert!(messages.is_empty());
}

#[tokio::test]
async fn screen_sharing_is_passed_on_within_a_voice_channel_only() {
    let server = start_server().await;
    let mut alice = FakeClient::connect(&server, "alice").await;
    let mut bob = FakeClient::connect(&server, "bob").await;
    let mut carol = FakeClient::connect(&server, "carol").await;
    // Not in voice: no sharing.
    alice.send(ClientMsg::SetSharing { on: true }).await;
    assert!(alice.error().await.contains("voice channel"));
    alice.join_voice(LOBBY).await;
    bob.join_voice(LOBBY).await;
    carol.join_voice(GAMING).await;
    alice.send(ClientMsg::SetSharing { on: true }).await;
    let a = alice.session_id;
    bob.wait_for(|m| matches!(m, ServerMsg::UserUpdated { user } if user.session_id == a && user.sharing)).await;
    // A handshake reaches someone in the same channel...
    let b = bob.session_id;
    alice.send(ClientMsg::ScreenSignal { to: b, data: "offer".into() }).await;
    let ServerMsg::ScreenSignal { from, data } = bob.wait_for(|m| matches!(m, ServerMsg::ScreenSignal { .. })).await else { unreachable!() };
    assert_eq!((from, data.as_str()), (a, "offer"));
    // ...but not someone in another channel.
    let c = carol.session_id;
    alice.send(ClientMsg::ScreenSignal { to: c, data: "offer".into() }).await;
    alice.send(ClientMsg::ScreenSignal { to: b, data: "after".into() }).await;
    bob.wait_for(|m| matches!(m, ServerMsg::ScreenSignal { data, .. } if data == "after")).await;
    carol.send(ClientMsg::Ping).await;
    loop {
        match recv(&mut carol.reader).await {
            ServerMsg::Pong => break,
            ServerMsg::ScreenSignal { .. } => panic!("a handshake crossed into another voice channel"),
            _ => {}
        }
    }
    // Leaving voice stops the sharing.
    alice.send(ClientMsg::LeaveVoice).await;
    bob.wait_for(|m| matches!(m, ServerMsg::UserUpdated { user } if user.session_id == a && !user.sharing && user.voice_channel.is_none())).await;
}

#[tokio::test]
async fn voice_channels_have_their_own_chat() {
    let server = start_server().await;
    let mut alice = FakeClient::connect(&server, "alice").await;
    alice.send(ClientMsg::SendChat { channel: LOBBY, text: "anyone hear me?".into(), reply_to: None }).await;
    let ServerMsg::Chat { message } = alice.wait_for(|m| matches!(m, ServerMsg::Chat { .. })).await else { unreachable!() };
    assert_eq!((message.channel, message.text.as_str()), (LOBBY, "anyone hear me?"));
    // Someone arriving later gets it with the rest of the history.
    let mut bob = FakeClient::connect(&server, "bob").await;
    let ServerMsg::ChatHistory { messages, .. } = bob.wait_for(|m| matches!(m, ServerMsg::ChatHistory { channel, .. } if *channel == LOBBY)).await else { unreachable!() };
    assert_eq!(messages.iter().map(|m| m.text.as_str()).collect::<Vec<_>>(), ["anyone hear me?"]);
}

#[tokio::test]
async fn voice_channels_can_have_a_user_limit_and_one_afk_channel() {
    let mut server = start_server().await;
    let mut alice = FakeClient::connect(&server, "alice").await;
    server.admin.send(ClientMsg::UpdateChannel { channel: LOBBY, name: "Lobby".into(), topic: None, category: None, no_pictures: None, user_limit: Some(1), afk_after: None, slowmode: None, private_roles: None }).await;
    server.admin.wait_for(|m| matches!(m, ServerMsg::ChannelsUpdated { channels } if channels.iter().any(|c| c.user_limit == Some(1)))).await;
    server.admin.join_voice(LOBBY).await;
    alice.send(ClientMsg::JoinVoice { channel: LOBBY }).await;
    assert!(alice.error().await.contains("full"));
    // One AFK channel: setting another moves the mark.
    server.admin.send(ClientMsg::UpdateChannel { channel: LOBBY, name: "Lobby".into(), topic: None, category: None, no_pictures: None, user_limit: None, afk_after: Some(15), slowmode: None, private_roles: None }).await;
    server.admin.send(ClientMsg::UpdateChannel { channel: GAMING, name: "Gaming".into(), topic: None, category: None, no_pictures: None, user_limit: None, afk_after: Some(5), slowmode: None, private_roles: None }).await;
    let ServerMsg::ChannelsUpdated { channels } = server.admin.wait_for(|m| matches!(m, ServerMsg::ChannelsUpdated { channels } if channels.iter().any(|c| c.afk_after == Some(5)))).await else { unreachable!() };
    assert_eq!(channels.iter().filter(|c| c.afk_after.is_some()).count(), 1);
}
