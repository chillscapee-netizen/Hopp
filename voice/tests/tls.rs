//! Self-hosted servers: the connection is encrypted (TLS 1.3) and the app only accepts the
//! server's own key once it knows it (from the invite link, or remembered after the first time).

use strom_server::{ServerConfig, Storage};
use strom_shared::ChannelKind;
use strom_voice::Identity;
use tokio::net::{TcpListener, UdpSocket};

async fn server_with_key(dir: &std::path::Path) -> (String, u16) {
    let tls = strom_server::tls::load_or_create(dir).unwrap();
    let pin = tls.pin.clone();
    let tcp = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let udp = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let port = tcp.local_addr().unwrap().port();
    let config = ServerConfig::new("Encrypted", &[("general", ChannelKind::Text), ("Lobby", ChannelKind::Voice)]);
    tokio::spawn(strom_server::run(tcp, udp, config, Storage::memory(), Some(tls)));
    (pin, port)
}

#[tokio::test]
async fn self_hosted_connections_are_encrypted_and_pinned() {
    let dir = std::env::temp_dir().join(format!("hopp-tls-{}", rand::random::<u32>()));
    let (pin, port) = server_with_key(&dir).await;
    let (owner, _) = Identity::create("owner", "password1").unwrap();

    // With the right key in the address: encrypted, and the key is confirmed.
    let session = strom_voice::connect(&format!("{pin}@127.0.0.1:{port}"), &owner, None, None).await.unwrap();
    assert_eq!(session.server_pin.as_deref(), Some(pin.as_str()));
    drop(session);

    // Without a key yet: still encrypted, and the key seen is handed back to be remembered.
    let session = strom_voice::connect(&format!("127.0.0.1:{port}"), &owner, None, None).await.unwrap();
    assert_eq!(session.server_pin.as_deref(), Some(pin.as_str()));
    drop(session);

    // Someone else's key: refused, plainly.
    let wrong = "0".repeat(strom_shared::PIN_LEN);
    let err = match strom_voice::connect(&format!("{wrong}@127.0.0.1:{port}"), &owner, None, None).await {
        Ok(_) => panic!("a server with another key must be refused"),
        Err(e) => e.to_string(),
    };
    assert!(err.contains("doesn't match"), "{err}");

    // The key stays the same across restarts (it's kept in the data folder).
    let again = strom_server::tls::load_or_create(&dir).unwrap();
    assert_eq!(again.pin, pin);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn voice_through_the_server_is_sealed_both_ways() {
    use strom_shared::{ClientMsg, ClientPacket, ServerMsg, ServerVoice};
    let dir = std::env::temp_dir().join(format!("hopp-tls-voice-{}", rand::random::<u32>()));
    let (pin, port) = server_with_key(&dir).await;
    let address = format!("{pin}@127.0.0.1:{port}");
    let (owner_id, _) = Identity::create("speaker", "password1").unwrap();
    let (guest_id, _) = Identity::create("listener", "password1").unwrap();
    let mut owner = strom_voice::connect(&address, &owner_id, None, None).await.unwrap();
    owner.control.send(ClientMsg::CreateInvite { max_uses: None, expires_in_hours: None });
    let code = loop {
        if let Some(ServerMsg::InviteCreated { invite }) = owner.events.recv().await {
            break invite.code;
        }
    };
    let guest = strom_voice::connect(&address, &guest_id, Some(&code), None).await.unwrap();
    let (owner_key, guest_key) = (owner.voice_key.expect("encrypted"), guest.voice_key.expect("encrypted"));
    assert_ne!(owner_key, guest_key, "every connection has its own key");
    let lobby = owner.roster.channels.iter().find(|c| c.kind == ChannelKind::Voice).unwrap().id;
    owner.control.send(ClientMsg::JoinVoice { channel: lobby });
    guest.control.send(ClientMsg::JoinVoice { channel: lobby });
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    let relay = owner.udp_addr.unwrap();
    let speaker = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let listener = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let mut buf = Vec::new();
    // The listener tells the server where it is.
    ClientPacket::Ping { session_id: guest.roster.me, token: guest.udp_token, nonce: 1 }.write(&mut buf);
    listener.send_to(&buf, relay).await.unwrap();
    let mut answer = [0u8; 1500];
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), listener.recv_from(&mut answer)).await;

    // A frame that isn't sealed with the speaker's key goes nowhere.
    ClientPacket::Voice { session_id: owner.roster.me, token: owner.udp_token, seq: 1, opus: b"plain frame not sealed" }.write(&mut buf);
    speaker.send_to(&buf, relay).await.unwrap();
    // A sealed one arrives, sealed for the listener.
    let sealed = strom_shared::seal_voice(&owner_key, owner.roster.me, 2, b"opus frame");
    ClientPacket::Voice { session_id: owner.roster.me, token: owner.udp_token, seq: 2, opus: &sealed }.write(&mut buf);
    speaker.send_to(&buf, relay).await.unwrap();
    let (len, _) = tokio::time::timeout(std::time::Duration::from_secs(2), listener.recv_from(&mut answer)).await.expect("the frame arrives").unwrap();
    let voice = ServerVoice::parse(&answer[..len]).expect("a voice packet");
    assert_eq!((voice.sender, voice.seq), (owner.roster.me, 2), "the unsealed frame was dropped, the sealed one passed");
    assert!(!voice.opus.windows(10).any(|w| w == b"opus frame"), "not readable on the way");
    assert_eq!(strom_shared::open_voice(&guest_key, voice.sender, voice.seq, voice.opus).as_deref(), Some(&b"opus frame"[..]));
    assert!(strom_shared::open_voice(&owner_key, voice.sender, voice.seq, voice.opus).is_none(), "sealed with the listener's key, not the speaker's");
    let _ = std::fs::remove_dir_all(&dir);
}
