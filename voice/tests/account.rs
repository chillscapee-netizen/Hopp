//! The app's account code against a running cloud Worker.
//! Skipped unless `STROM_CLOUD_URL` is set, e.g. `ws://127.0.0.1:8787` with `npx wrangler dev` running.

use std::time::Duration;

use serde_json::{json, Value};
use strom_voice::Identity;
use tokio::sync::mpsc::UnboundedReceiver;

async fn wait_for(rx: &mut UnboundedReceiver<Value>, pred: impl Fn(&Value) -> bool) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let msg = rx.recv().await.expect("connection open");
            if pred(&msg) {
                return msg;
            }
        }
    })
    .await
    .expect("message arrived")
}

fn unique(prefix: &str) -> String {
    format!("{prefix}{:08x}", rand::random::<u32>())
}

#[tokio::test]
async fn usernames_friends_presence_and_private_sync() {
    let Ok(cloud) = std::env::var("STROM_CLOUD_URL") else {
        eprintln!("skipped: set STROM_CLOUD_URL to run against a cloud Worker");
        return;
    };
    let (alice, _) = Identity::create("Alice", "password1").unwrap();
    let (bob, _) = Identity::create("Bob", "password1").unwrap();

    let (a, welcome, mut a_rx) = strom_voice::connect_account(&cloud, &alice).await.unwrap();
    assert_eq!(welcome["me"]["display_name"], "Alice");
    let (b, _, mut b_rx) = strom_voice::connect_account(&cloud, &bob).await.unwrap();

    let (an, bn) = (unique("alice"), unique("bob"));
    a.send(json!({ "type": "claim_username", "name": an }));
    b.send(json!({ "type": "claim_username", "name": bn }));
    wait_for(&mut a_rx, |m| m["type"] == "profile" && m["me"]["username"] == an).await;
    wait_for(&mut b_rx, |m| m["type"] == "profile" && m["me"]["username"] == bn).await;

    a.send(json!({ "type": "friend_request", "username": bn }));
    let req = wait_for(&mut b_rx, |m| m["type"] == "friend").await;
    assert_eq!(req["friend"]["state"], "incoming");
    b.send(json!({ "type": "friend_accept", "key": alice.public_key() }));
    wait_for(&mut a_rx, |m| m["type"] == "presence" && m["key"] == bob.public_key().as_str() && m["status"] == "online").await;

    // The synced data is sealed on the device; the cloud only ever sees ciphertext.
    let sealed = alice.seal_private(br#"{"servers":["cloud:abc"]}"#);
    a.send(json!({ "type": "set_sync", "data": sealed, "base_version": 0 }));
    wait_for(&mut a_rx, |m| m["type"] == "sync_saved").await;
    let (_a2, w2, _) = strom_voice::connect_account(&cloud, &alice).await.unwrap();
    let opened = alice.open_private(w2["sync"]["data"].as_str().unwrap()).unwrap();
    assert_eq!(opened, br#"{"servers":["cloud:abc"]}"#);

    drop(b);
    wait_for(&mut a_rx, |m| m["type"] == "presence" && m["status"] == "offline").await;
}
