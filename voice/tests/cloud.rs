//! The app's connection code against a running cloud Worker.
//! Skipped unless `STROM_CLOUD_URL` is set, e.g. `ws://127.0.0.1:8787` with `npx wrangler dev` running.

use strom_shared::{ChannelKind, ClientMsg, ServerMsg};
use strom_voice::Identity;

fn cloud_url() -> Option<String> {
    std::env::var("STROM_CLOUD_URL").ok()
}

fn server_url(base: &str) -> String {
    let id: String = (0..24).map(|_| format!("{:x}", rand::random::<u8>() % 16)).collect();
    format!("{base}/servers/{id}/ws")
}

#[tokio::test]
async fn create_invite_join_and_chat_over_websocket() {
    let Some(base) = cloud_url() else {
        eprintln!("skipped: set STROM_CLOUD_URL to run against a cloud Worker");
        return;
    };
    let url = server_url(&base);
    let (owner_id, _) = Identity::create("owner", "password1").unwrap();
    let (guest_id, _) = Identity::create("guest", "password1").unwrap();

    let mut owner = strom_voice::connect(&url, &owner_id, None, Some("Rust test")).await.unwrap();
    assert_eq!(owner.roster.server_name, "Rust test");
    assert!(owner.roster.me().unwrap().owner);
    assert!(owner.udp_addr.is_none(), "cloud servers have no UDP relay");

    let err = strom_voice::connect(&url, &guest_id, None, None).await.err().unwrap();
    assert!(err.to_string().contains("invite-only"), "{err}");

    owner.control.send(ClientMsg::CreateInvite { max_uses: Some(1), expires_in_hours: Some(1) });
    let code = loop {
        if let Some(ServerMsg::InviteCreated { invite }) = owner.events.recv().await {
            break invite.code;
        }
    };
    let guest = strom_voice::connect(&url, &guest_id, Some(&code), None).await.unwrap();

    let general = owner.roster.channels.iter().find(|c| c.kind == ChannelKind::Text).unwrap().id;
    guest.control.send(ClientMsg::SendChat { channel: general, text: "hello from Rust".into() });
    loop {
        if let Some(ServerMsg::Chat { message }) = owner.events.recv().await {
            assert_eq!((message.text.as_str(), message.sender_name.as_str()), ("hello from Rust", "guest"));
            break;
        }
    }

    // Dropping the session (what logging out does) must close the socket, so
    // the server sees the guest leave right away.
    let guest_session = guest.roster.me;
    drop(guest);
    let left = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            if let Some(ServerMsg::UserLeft { session_id }) = owner.events.recv().await {
                if session_id == guest_session {
                    break;
                }
            }
        }
    })
    .await;
    assert!(left.is_ok(), "the server never saw the guest leave");
}
