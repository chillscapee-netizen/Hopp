//! Hosting a server on this computer, from inside Hopp: no separate program, no command line,
//! and no port opened on the router. The server runs while Hopp runs, keeps its data (and its
//! key) in Hopp's folder, and friends reach it through Hopp Cloud's tunnel: nobody connects to
//! this computer, so its address stays private. Everything inside the tunnel is encrypted end
//! to end (the cloud only passes sealed bytes), and voice goes between the members through
//! Hopp's relay, as on Hopp Cloud, never through this computer's address.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::net::TcpListener;

use crate::CmdResult;

/// Ports tried in turn for your own connection to your server (on this computer only).
const PORTS: std::ops::RangeInclusive<u16> = strom_shared::DEFAULT_PORT..=strom_shared::DEFAULT_PORT + 9;

#[derive(Clone, Serialize, Default)]
pub struct HostStatus {
    pub running: bool,
    pub name: String,
    /// Where you reach it yourself, on this computer.
    pub port: u16,
    /// The server's key (goes in invite links).
    pub pin: String,
    /// The tunnel friends reach it through (goes in invite links, instead of an address).
    pub tunnel: String,
    /// Whether the tunnel is connected (friends can join right now).
    pub online: bool,
}

#[derive(Default)]
pub struct Host {
    /// Starting right now: a second start (Hopp's own at launch, and a click) waits its turn
    /// instead of opening the same database twice.
    starting: tokio::sync::Mutex<()>,
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    server: Mutex<Option<Arc<strom_server::Server>>>,
    status: Mutex<HostStatus>,
}

/// The tunnel's id and the secret that proves it's ours, made once and kept.
#[derive(Serialize, Deserialize)]
struct TunnelId {
    id: String,
    secret: String,
}

fn tunnel_id(dir: &Path) -> anyhow::Result<TunnelId> {
    let path = dir.join("tunnel.json");
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(t) = serde_json::from_str::<TunnelId>(&text) {
            if strom_voice::tunnel::valid_id(&t.id) && t.secret.len() == 64 {
                return Ok(t);
            }
        }
    }
    let hex = |n: usize| (0..n).map(|_| format!("{:02x}", rand::random::<u8>())).collect::<String>();
    let t = TunnelId { id: hex(16), secret: hex(32) };
    std::fs::create_dir_all(dir)?;
    std::fs::write(&path, serde_json::to_string(&t)?)?;
    Ok(t)
}

fn folder(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(crate::data_dir(app).ok_or("Hopp's data folder isn't available.")?.join("hosted-server"))
}

/// Starts the server on this computer (or says how it's doing, if it already runs).
#[tauri::command]
pub async fn host_start(app: AppHandle, host: State<'_, Host>, name: String) -> CmdResult<HostStatus> {
    let _one_at_a_time = host.starting.lock().await;
    if host.status.lock().unwrap().running {
        return Ok(host.status.lock().unwrap().clone());
    }
    let name = name.trim().chars().take(40).collect::<String>();
    let name = if name.is_empty() { "My server".to_string() } else { name };
    let dir = folder(&app)?;
    // A server deleted while its files were busy: gone for good before a new one starts.
    remove_deleted(&dir);
    let storage = strom_server::Storage::at(dir.join("data")).map_err(|e| format!("Couldn't make the server's folder: {e}"))?;
    let tls = strom_server::tls::load_or_create(&dir).map_err(|e| format!("Couldn't make the server's key: {e}"))?;
    let tunnel = tunnel_id(&dir).map_err(|e| format!("Couldn't set up the server's tunnel: {e}"))?;
    let pin = tls.pin.clone();
    // Your own connection: on this computer only (nothing listens on the network).
    let mut bound = None;
    for port in PORTS {
        if let Ok(tcp) = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port))).await {
            bound = Some((tcp, port));
            break;
        }
    }
    let (tcp, port) = bound.ok_or("Another program is using the ports Hopp would use (7777-7786).")?;
    let config = strom_server::ServerConfig::default_named(&name);
    // Voice between the members (through Hopp's relay), never through this computer.
    let server = strom_server::Server::start(None, config, storage, Some(tls), true).map_err(|e| format!("The server couldn't start: {e}"))?;

    let local = {
        let server = server.clone();
        tokio::spawn(async move {
            while let Ok((stream, addr)) = tcp.accept().await {
                server.serve_tcp(stream, addr);
            }
        })
    };
    let through_tunnel = {
        let server: Arc<strom_server::Server> = server.clone();
        let app = app.clone();
        tokio::spawn(strom_voice::tunnel::host(
            tunnel.id.clone(),
            tunnel.secret,
            move |stream, conn| server.serve_tunneled(stream, conn),
            move |online| report(&app, |s| s.online = online),
        ))
    };
    *host.tasks.lock().unwrap() = vec![local, through_tunnel];
    *host.server.lock().unwrap() = Some(server);
    let status = HostStatus { running: true, name, port, pin, tunnel: tunnel.id, online: false };
    *host.status.lock().unwrap() = status.clone();
    Ok(status)
}

/// Stops the server (friends' connections end; its data stays on this computer).
#[tauri::command]
pub async fn host_stop(host: State<'_, Host>) -> CmdResult {
    *host.status.lock().unwrap() = HostStatus::default();
    for t in host.tasks.lock().unwrap().drain(..) {
        t.abort();
    }
    // Everyone still connected is let go too.
    if let Some(server) = host.server.lock().unwrap().take() {
        server.shutdown();
    }
    Ok(())
}

/// The owner deleted the server: it stops, and its channels, messages, pictures and key go.
/// (A new server made later gets a new key and a new tunnel.)
#[tauri::command]
pub async fn host_delete(app: AppHandle, host: State<'_, Host>) -> CmdResult {
    host_stop(host).await?;
    let dir = folder(&app)?;
    // The database may still be closing.
    for _ in 0..20 {
        if !dir.exists() || std::fs::remove_dir_all(&dir).is_ok() {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    // Still busy: marked, and removed the next time Hopp starts.
    let _ = std::fs::write(dir.join(DELETED_MARK), "");
    Err("Couldn't remove the server's data yet. It goes the next time Hopp starts.".into())
}

const DELETED_MARK: &str = "deleted";

/// A hosted server deleted earlier whose files couldn't be removed then: removed now.
fn remove_deleted(dir: &Path) {
    if dir.join(DELETED_MARK).exists() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// At launch: finishes deleting a server whose files were busy when it was deleted.
pub fn clean_up(app: &AppHandle) {
    if let Ok(dir) = folder(app) {
        remove_deleted(&dir);
    }
}

#[tauri::command]
pub fn host_status(host: State<'_, Host>) -> HostStatus {
    host.status.lock().unwrap().clone()
}

fn report(app: &AppHandle, f: impl FnOnce(&mut HostStatus)) {
    let host = app.state::<Host>();
    let status = {
        let mut s = host.status.lock().unwrap();
        if !s.running {
            return;
        }
        f(&mut s);
        s.clone()
    };
    let _ = app.emit("host-status", status);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_server_marked_deleted_is_removed_next_time() {
        let dir = std::env::temp_dir().join(format!("hopp-host-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("data")).unwrap();
        std::fs::write(dir.join("data").join("server.db"), "messages").unwrap();
        remove_deleted(&dir);
        assert!(dir.exists(), "not marked: kept");
        std::fs::write(dir.join(DELETED_MARK), "").unwrap();
        remove_deleted(&dir);
        assert!(!dir.exists(), "marked deleted: gone, messages and all");
    }
}
