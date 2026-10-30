//! The connection to your account in Hopp Cloud: profile, username, the
//! encrypted account data every device shares, friends and presence.
//!
//! Messages are plain JSON objects with a "type"; the app's page works with
//! them directly. This side only logs in, keeps the connection alive, and
//! notices when it has gone quiet.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::identity::Identity;

pub const ACCOUNT_PROTOCOL: u32 = 1;
const PING_INTERVAL: Duration = Duration::from_secs(20);
/// Pings are answered, so this long without anything means the connection is dead.
const SILENCE_TIMEOUT: Duration = Duration::from_secs(50);
const ANSWER_TIMEOUT: Duration = Duration::from_secs(8);

/// Sends messages to the account; dropping it closes the connection.
#[derive(Clone)]
pub struct AccountLink {
    tx: mpsc::UnboundedSender<Value>,
}

impl AccountLink {
    pub fn send(&self, msg: Value) {
        let _ = self.tx.send(msg);
    }
}

/// Logs in to the account of `identity` at `cloud` (a `wss://` base URL).
/// Returns the link, the welcome (profile, synced data, friends) and every later message.
pub async fn connect_account(cloud: &str, identity: &Identity) -> anyhow::Result<(AccountLink, Value, mpsc::UnboundedReceiver<Value>)> {
    let url = format!("{}/account/ws?key={}", cloud.trim_end_matches('/'), identity.public_key());
    let (stream, _) = tokio::time::timeout(ANSWER_TIMEOUT, tokio_tungstenite::connect_async(&url))
        .await
        .map_err(|_| anyhow::anyhow!("Hopp Cloud didn't answer"))??;
    let (mut sink, mut stream) = stream.split();

    async fn next_json(
        stream: &mut (impl StreamExt<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin),
    ) -> anyhow::Result<Value> {
        loop {
            let msg = tokio::time::timeout(ANSWER_TIMEOUT, stream.next())
                .await
                .map_err(|_| anyhow::anyhow!("Hopp Cloud didn't answer"))?
                .ok_or_else(|| anyhow::anyhow!("Hopp Cloud closed the connection"))??;
            if let WsMessage::Text(text) = msg {
                return Ok(serde_json::from_str(&text)?);
            }
        }
    }
    let fail = |msg: &Value| anyhow::anyhow!(msg["message"].as_str().unwrap_or("unexpected answer from Hopp Cloud").to_string());

    let hello = json!({ "type": "hello", "public_key": identity.public_key(), "protocol": ACCOUNT_PROTOCOL });
    sink.send(WsMessage::Text(hello.to_string().into())).await?;
    let challenge = next_json(&mut stream).await?;
    if challenge["type"] != "challenge" {
        return Err(fail(&challenge));
    }
    let nonce = hex::decode(challenge["nonce"].as_str().unwrap_or_default())?;
    let auth = json!({ "type": "auth", "signature": identity.sign_challenge(&nonce), "display_name": identity.name });
    sink.send(WsMessage::Text(auth.to_string().into())).await?;
    let welcome = next_json(&mut stream).await?;
    if welcome["type"] != "welcome" {
        return Err(fail(&welcome));
    }

    let (tx, mut out_rx) = mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        let mut ping = tokio::time::interval(PING_INTERVAL);
        loop {
            let msg = tokio::select! {
                msg = out_rx.recv() => match msg { Some(m) => m, None => break },
                _ = ping.tick() => json!({ "type": "ping" }),
            };
            if sink.send(WsMessage::Text(msg.to_string().into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let (ev_tx, events) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        loop {
            let Ok(next) = tokio::time::timeout(SILENCE_TIMEOUT, stream.next()).await else { break };
            match next {
                Some(Ok(WsMessage::Text(text))) => {
                    let Ok(msg) = serde_json::from_str::<Value>(&text) else { continue };
                    if msg["type"] == "pong" {
                        continue;
                    }
                    if ev_tx.send(msg).is_err() {
                        break;
                    }
                }
                Some(Ok(WsMessage::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            }
        }
    });

    Ok((AccountLink { tx }, welcome, events))
}
