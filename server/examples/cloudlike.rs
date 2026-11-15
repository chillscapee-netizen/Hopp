//! A test server that looks like Hopp Cloud from outside (WebSockets at /servers/<id>/ws,
//! pictures at /servers/<id>/images, invite previews at /invite/<code>) but runs the server
//! people run on their own computers. Hopp Cloud's own tests run against it, so both servers
//! are held to the very same behaviour:
//!
//!   cargo run -p strom-server --example cloudlike -- 8790
//!   STROM_CLOUD_URL=ws://127.0.0.1:8790 node --test cloud/test/cloud.test.mjs

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use strom_server::{Out, Server, ServerConfig, Storage};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

type Servers = Arc<Mutex<HashMap<String, Arc<Server>>>>;

fn server(servers: &Servers, id: &str) -> Arc<Server> {
    let mut all = servers.lock().unwrap();
    all.entry(id.to_string())
        .or_insert_with(|| {
            // Empty, like a new cloud server: it exists once someone creates it.
            let s = Server::start(None, ServerConfig::new("", &[]), Storage::memory(), None, true).expect("server starts");
            s.core().lock().unwrap().set_server_id(id);
            s
        })
        .clone()
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let port: u16 = std::env::args().nth(1).and_then(|p| p.parse().ok()).unwrap_or(8790);
    let listener = TcpListener::bind(("127.0.0.1", port)).await?;
    println!("cloud-like test server on ws://127.0.0.1:{port}");
    let servers: Servers = Arc::default();
    loop {
        let (stream, _) = listener.accept().await?;
        let servers = servers.clone();
        tokio::spawn(async move {
            let _ = handle(stream, servers).await;
        });
    }
}

async fn handle(mut stream: TcpStream, servers: Servers) -> anyhow::Result<()> {
    // Look at the request without taking it: a WebSocket handshake is read by tungstenite.
    let mut head = vec![0u8; 16 * 1024];
    let head_len = loop {
        let n = stream.peek(&mut head).await?;
        if n == 0 {
            return Ok(());
        }
        if let Some(i) = head[..n].windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    };
    let text = String::from_utf8_lossy(&head[..head_len]).to_string();
    let mut lines = text.lines();
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, path) = (first.next().unwrap_or("").to_string(), first.next().unwrap_or("").to_string());
    let headers: HashMap<String, String> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string())).collect();
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();

    if parts.len() == 3 && parts[0] == "servers" && parts[2] == "ws" {
        let core = server(&servers, parts[1]).core().clone();
        let ws = tokio_tungstenite::accept_async(stream).await?;
        let (mut sink, mut source) = ws.split();
        let (in_tx, in_rx) = mpsc::unbounded_channel();
        let (out_tx, mut out_rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Some(out) = out_rx.recv().await {
                match out {
                    Out::Text(t) => {
                        if sink.send(Message::Text(t.into())).await.is_err() {
                            break;
                        }
                    }
                    Out::Close => break,
                }
            }
            let _ = sink.close().await;
        });
        tokio::spawn(async move {
            while let Some(Ok(msg)) = source.next().await {
                match msg {
                    Message::Text(t) => {
                        if in_tx.send(t.to_string()).is_err() {
                            break;
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        });
        strom_server::serve_frames(core, in_rx, out_tx).await;
        return Ok(());
    }

    // Plain HTTP: take the head and the body.
    let mut taken = vec![0u8; head_len];
    stream.read_exact(&mut taken).await?;
    let length: usize = headers.get("content-length").and_then(|l| l.parse().ok()).unwrap_or(0);
    let mut body = vec![0u8; length];
    stream.read_exact(&mut body).await?;

    let (status, kind, out): (u16, String, Vec<u8>) = if parts.len() == 3 && parts[0] == "servers" && parts[2] == "images" && method == "POST" {
        let s = server(&servers, parts[1]);
        let core = s.core().lock().unwrap();
        let key = headers.get("x-hopp-key").cloned().unwrap_or_default().to_lowercase();
        let time: u64 = headers.get("x-hopp-time").and_then(|t| t.parse().ok()).unwrap_or(0);
        let signature = headers.get("x-hopp-signature").cloned().unwrap_or_default();
        let kind = headers.get("content-type").map(|t| t.split(';').next().unwrap_or("").trim().to_string()).unwrap_or_default();
        let result = core.check_upload_signature(&key, time, &signature, &body).and_then(|()| core.upload_image(&key, &kind, &body));
        match result {
            Ok(id) => (200, "application/json".into(), serde_json::json!({ "id": id }).to_string().into_bytes()),
            Err((status, error)) => (status, "application/json".into(), serde_json::json!({ "error": error }).to_string().into_bytes()),
        }
    } else if parts.len() == 4 && parts[0] == "servers" && parts[2] == "images" && method == "GET" {
        let s = server(&servers, parts[1]);
        let found = s.core().lock().unwrap().image(parts[3]);
        match found {
            Some((kind, data)) => (200, kind, data),
            None => (404, "text/plain".into(), b"Gone".to_vec()),
        }
    } else if parts.len() == 2 && parts[0] == "invite" && method == "GET" {
        let code = parts[1].to_uppercase();
        let all: Vec<(String, Arc<Server>)> = servers.lock().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let found = all.into_iter().find_map(|(id, s)| s.core().lock().unwrap().preview(&code).map(|mut p| {
            p["server_id"] = id.into();
            p["code"] = code.clone().into();
            p
        }));
        match found {
            Some(p) => (200, "application/json".into(), p.to_string().into_bytes()),
            None => (404, "application/json".into(), br#"{"error":"This invite is invalid or has expired."}"#.to_vec()),
        }
    } else {
        (404, "text/plain".into(), b"Not found".to_vec())
    };
    let reply = format!("HTTP/1.1 {status} X\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", out.len());
    stream.write_all(reply.as_bytes()).await?;
    stream.write_all(&out).await?;
    stream.shutdown().await?;
    Ok(())
}
