//! A server hosted on someone's computer, reached through Hopp Cloud's tunnel: friends never
//! connect to that computer. Skipped unless `STROM_CLOUD_URL` is set (`npx wrangler dev`).

use std::sync::Arc;
use std::time::Duration;

use strom_server::{Server, ServerConfig, Storage};
use strom_shared::{ChannelKind, ClientMsg, ServerMsg};
use strom_voice::Identity;
use tokio::net::TcpListener;

#[tokio::test]
async fn friends_reach_a_hosted_server_through_the_tunnel() {
    let Ok(cloud) = std::env::var("STROM_CLOUD_URL") else {
        eprintln!("skipped: set STROM_CLOUD_URL to run against a cloud Worker");
        return;
    };
    strom_voice::tunnel::set_cloud(&cloud);
    let dir = std::env::temp_dir().join(format!("hopp-tunnel-{}", rand::random::<u32>()));
    let tls = strom_server::tls::load_or_create(&dir).unwrap();
    let pin = tls.pin.clone();
    let config = ServerConfig::new("Hidden", &[("general", ChannelKind::Text), ("Lobby", ChannelKind::Voice)]);
    let server: Arc<Server> = Server::start(None, config, Storage::memory(), Some(tls), true).unwrap();

    // The owner, on this computer.
    let local = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = local.local_addr().unwrap().port();
    let s2 = server.clone();
    tokio::spawn(async move {
        while let Ok((stream, addr)) = local.accept().await {
            s2.serve_tcp(stream, addr);
        }
    });
    // The tunnel.
    let id: String = (0..16).map(|_| format!("{:02x}", rand::random::<u8>())).collect();
    let secret: String = (0..32).map(|_| format!("{:02x}", rand::random::<u8>())).collect();
    let (online_tx, mut online_rx) = tokio::sync::mpsc::unbounded_channel();
    let s3 = server.clone();
    tokio::spawn(strom_voice::tunnel::host(id.clone(), secret, move |stream, conn| s3.serve_tunneled(stream, conn), move |on| {
        let _ = online_tx.send(on);
    }));
    assert_eq!(tokio::time::timeout(Duration::from_secs(10), online_rx.recv()).await.unwrap(), Some(true), "the tunnel opens");

    let (owner_id, _) = Identity::create("owner", "password1").unwrap();
    let (guest_id, _) = Identity::create("guest", "password1").unwrap();
    let mut owner = strom_voice::connect(&format!("{pin}@localhost:{port}"), &owner_id, None, None).await.unwrap();
    owner.control.send(ClientMsg::CreateInvite { max_uses: None, expires_in_hours: None });
    let code = loop {
        if let Some(ServerMsg::InviteCreated { invite }) = owner.events.recv().await {
            break invite.code;
        }
    };

    // A friend, through the tunnel: encrypted end to end, only this server's key accepted.
    let mut guest = strom_voice::connect(&format!("{pin}@tunnel:{id}"), &guest_id, Some(&code), None).await.unwrap();
    assert_eq!(guest.server_pin.as_deref(), Some(pin.as_str()));
    assert!(guest.udp_addr.is_none(), "no address to send voice to: voice goes between members");
    let general = guest.roster.channels.iter().find(|c| c.kind == ChannelKind::Text).unwrap().id;
    guest.control.send(ClientMsg::SendChat { channel: general, text: "hi through the tunnel".into(), reply_to: None });
    let got = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(ServerMsg::Chat { message }) = owner.events.recv().await {
                break message.text;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(got, "hi through the tunnel");

    // Voice: members are introduced to each other (Hopp Cloud style), with the channel's key.
    let lobby = guest.roster.channels.iter().find(|c| c.kind == ChannelKind::Voice).unwrap().id;
    guest.control.send(ClientMsg::JoinVoice { channel: lobby });
    let session = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(ServerMsg::VoiceSession { channel, key, .. }) = guest.events.recv().await {
                break (channel, key);
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(session.0, lobby);
    assert_eq!(session.1.len(), 64);

    // A key that isn't this server's is refused, through the tunnel too.
    let wrong = "0".repeat(strom_shared::PIN_LEN);
    assert!(strom_voice::connect(&format!("{wrong}@tunnel:{id}"), &guest_id, None, None).await.is_err());
    let _ = std::fs::remove_dir_all(&dir);
}
