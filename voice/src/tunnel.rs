//! Servers hosted on someone's own computer, reached through Hopp Cloud's tunnel: nobody
//! connects to that computer, so its address stays private, and no router port is opened.
//! The tunnel only passes bytes; the app and the server speak TLS end to end inside it.
//!
//! Host frames (to and from the cloud): [kind][connection, 4 bytes][bytes], kind 1 open,
//! 2 data, 3 close. A friend's side is a plain byte stream.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

const OPEN: u8 = 1;
const DATA: u8 = 2;
const CLOSE: u8 = 3;
const BUFFER: usize = 64 * 1024;

static CLOUD: RwLock<Option<String>> = RwLock::new(None);

/// Where Hopp Cloud is ("wss://…"); set when the account connects.
pub fn set_cloud(url: &str) {
    *CLOUD.write().unwrap() = Some(url.trim_end_matches('/').to_string());
}

fn cloud() -> anyhow::Result<String> {
    CLOUD.read().unwrap().clone().ok_or_else(|| anyhow::anyhow!("Not connected to Hopp Cloud yet, which reaches this server. Try again in a moment."))
}

/// A tunnel's id: 32 hex characters.
pub fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// A friend's side: a byte stream to the server through the tunnel.
pub async fn join(id: &str) -> anyhow::Result<DuplexStream> {
    anyhow::ensure!(valid_id(id), "That isn't a Hopp server link.");
    let url = format!("{}/tunnels/{id}/join", cloud()?);
    tracing::info!("tunnel: joining a server on someone's computer");
    let (ws, _) = match tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::connect_async(&url)).await {
        Ok(Ok(ok)) => ok,
        Ok(Err(tokio_tungstenite::tungstenite::Error::Http(response))) => {
            let body = response.body().as_ref().map(|b| String::from_utf8_lossy(b).to_string()).unwrap_or_default();
            tracing::warn!("tunnel: join refused ({}): {}", response.status(), body.trim());
            anyhow::bail!(if body.trim().is_empty() { "This server can't be reached right now.".to_string() } else { body.trim().to_string() });
        }
        Ok(Err(e)) => anyhow::bail!("Couldn't reach Hopp Cloud: {e}"),
        Err(_) => anyhow::bail!("Hopp Cloud didn't answer."),
    };
    let (mine, theirs) = tokio::io::duplex(BUFFER);
    let (mut sink, mut stream) = ws.split();
    let (mut rd, mut wr) = tokio::io::split(theirs);
    tokio::spawn(async move {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            match rd.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if sink.send(Message::Binary(buf[..n].to_vec().into())).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = sink.close().await;
    });
    tokio::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            if let Message::Binary(bytes) = msg {
                if wr.write_all(&bytes).await.is_err() {
                    break;
                }
            }
        }
        let _ = wr.shutdown().await;
    });
    Ok(mine)
}

/// The host's side: keeps the tunnel open (reconnecting when it drops) and hands each friend's
/// connection to `accept` as a byte stream; `online` hears whether friends can reach it now.
/// Runs until the task is stopped.
pub async fn host<A, O>(id: String, secret: String, accept: A, online: O)
where
    A: Fn(DuplexStream, u32) + Send + Sync + 'static,
    O: Fn(bool) + Send + Sync + 'static,
{
    let accept = Arc::new(accept);
    let mut pause = 1;
    loop {
        if let Ok(url) = cloud() {
            let url = format!("{url}/tunnels/{id}/host?secret={secret}");
            match tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::connect_async(&url)).await {
                Ok(Ok((ws, _))) => {
                    pause = 1;
                    tracing::info!("tunnel: open, friends can join");
                    online(true);
                    serve(ws, accept.clone()).await;
                    online(false);
                    tracing::info!("tunnel: closed, opening it again");
                }
                // Blocked by Hopp for breaking its rules: asking every half minute changes nothing
                // and costs the cloud; once an hour notices a lifted block.
                Ok(Err(tokio_tungstenite::tungstenite::Error::Http(response))) if response.status() == 403 => {
                    tracing::warn!("tunnel: refused by Hopp Cloud (403)");
                    pause = 3600;
                }
                Ok(Err(e)) => tracing::warn!("tunnel: couldn't open: {e}"),
                Err(_) => tracing::warn!("tunnel: Hopp Cloud didn't answer in 10 s"),
            }
        }
        tokio::time::sleep(Duration::from_secs(pause)).await;
        pause = if pause >= 3600 { 1 } else { (pause * 2).min(30) };
    }
}

async fn serve<S, A>(ws: tokio_tungstenite::WebSocketStream<S>, accept: Arc<A>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    A: Fn(DuplexStream, u32) + Send + Sync + 'static,
{
    let (mut sink, mut stream) = ws.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (ping_tx, mut ping_rx) = mpsc::unbounded_channel::<()>();
    let writer = tokio::spawn(async move {
        loop {
            let msg = tokio::select! {
                frame = out_rx.recv() => match frame { Some(f) => Message::Binary(f.into()), None => break },
                ping = ping_rx.recv() => match ping { Some(()) => Message::Ping(Vec::new().into()), None => break },
            };
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });
    // A tunnel that went quiet may be gone without either side hearing of it (a router forgets
    // idle connections): friends would then wait on "Connecting" for nothing. So it says hello
    // every 25 seconds (Cloudflare answers), and with no word back for a minute it's opened again.
    let mut tick = tokio::time::interval(Duration::from_secs(25));
    let mut heard = tokio::time::Instant::now();
    let mut conns: HashMap<u32, mpsc::UnboundedSender<Vec<u8>>> = HashMap::new();
    loop {
        let msg = tokio::select! {
            next = stream.next() => match next { Some(Ok(m)) => m, _ => break },
            _ = tick.tick() => {
                if heard.elapsed() > Duration::from_secs(60) {
                    tracing::warn!("tunnel: no answer for a minute, opening it again");
                    break;
                }
                let _ = ping_tx.send(());
                continue;
            }
        };
        heard = tokio::time::Instant::now();
        let Message::Binary(bytes) = msg else { continue };
        if bytes.len() < 5 {
            continue;
        }
        let conn = u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
        match bytes[0] {
            OPEN => {
                let (mine, theirs) = tokio::io::duplex(BUFFER);
                let (in_tx, mut in_rx) = mpsc::unbounded_channel::<Vec<u8>>();
                conns.insert(conn, in_tx);
                let (mut rd, mut wr) = tokio::io::split(mine);
                let out = out_tx.clone();
                // The server's bytes to this friend.
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 16 * 1024];
                    loop {
                        match rd.read(&mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                let mut frame = Vec::with_capacity(5 + n);
                                frame.push(DATA);
                                frame.extend_from_slice(&conn.to_be_bytes());
                                frame.extend_from_slice(&buf[..n]);
                                if out.send(frame).is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    let mut close = vec![CLOSE];
                    close.extend_from_slice(&conn.to_be_bytes());
                    let _ = out.send(close);
                });
                // The friend's bytes to the server.
                tokio::spawn(async move {
                    while let Some(bytes) = in_rx.recv().await {
                        if wr.write_all(&bytes).await.is_err() {
                            break;
                        }
                    }
                    let _ = wr.shutdown().await;
                });
                accept(theirs, conn);
            }
            DATA => {
                if let Some(tx) = conns.get(&conn) {
                    let _ = tx.send(bytes[5..].to_vec());
                }
            }
            CLOSE => {
                conns.remove(&conn);
            }
            _ => {}
        }
    }
    writer.abort();
}
