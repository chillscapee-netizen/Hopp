//! Hosting a server on this computer, from inside Hopp: no separate program, no command line.
//! The server runs while Hopp runs, keeps its data (and its key) in Hopp's folder, and asks the
//! router to open its port (UPnP), so friends outside the home can reach it without anyone
//! touching router settings. Nothing about it goes to Hopp Cloud: the public address comes from
//! the router itself.

use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::net::{TcpListener, UdpSocket};

use crate::CmdResult;

/// How long the router keeps the port open before we renew it (it's renewed well before).
const LEASE: Duration = Duration::from_secs(60 * 60);
const RENEW: Duration = Duration::from_secs(50 * 60);
/// Ports tried in turn when the usual one is taken.
const PORTS: std::ops::RangeInclusive<u16> = strom_shared::DEFAULT_PORT..=strom_shared::DEFAULT_PORT + 9;

#[derive(Clone, Serialize, Default)]
pub struct HostStatus {
    pub running: bool,
    pub name: String,
    pub port: u16,
    /// The server's key (goes in invite links).
    pub pin: String,
    /// This computer on the home network.
    pub lan: Option<String>,
    /// The home's public address, as the router tells it; only set when the router opened the port.
    pub public: Option<String>,
    /// "checking", "open" (friends anywhere can join), or "home" (only the home network).
    pub reach: String,
}

#[derive(Default)]
pub struct Host {
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    upnp: Mutex<Option<tokio::task::JoinHandle<()>>>,
    status: Mutex<HostStatus>,
}

fn folder(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(crate::data_dir(app).ok_or("Hopp's data folder isn't available.")?.join("hosted-server"))
}

/// Starts the server on this computer (or says how it's doing, if it already runs).
#[tauri::command]
pub async fn host_start(app: AppHandle, host: State<'_, Host>, name: String) -> CmdResult<HostStatus> {
    if host.status.lock().unwrap().running {
        return Ok(host.status.lock().unwrap().clone());
    }
    let name = name.trim().chars().take(40).collect::<String>();
    let name = if name.is_empty() { "My server".to_string() } else { name };
    let dir = folder(&app)?;
    let storage = strom_server::Storage::at(dir.join("data")).map_err(|e| format!("Couldn't make the server's folder: {e}"))?;
    let tls = strom_server::tls::load_or_create(&dir).map_err(|e| format!("Couldn't make the server's key: {e}"))?;
    let pin = tls.pin.clone();
    let mut bound = None;
    for port in PORTS {
        let addr = SocketAddr::from(([0, 0, 0, 0], port));
        if let (Ok(tcp), Ok(udp)) = (TcpListener::bind(addr).await, UdpSocket::bind(addr).await) {
            bound = Some((tcp, udp, port));
            break;
        }
    }
    let (tcp, udp, port) = bound.ok_or("Another program is using the ports Hopp would use (7777-7786).")?;
    let config = strom_server::ServerConfig::default_named(&name);
    let task = tokio::spawn(async move {
        if let Err(e) = strom_server::run(tcp, udp, config, storage, Some(tls)).await {
            tracing::warn!("the hosted server stopped: {e:#}");
        }
    });
    *host.task.lock().unwrap() = Some(task);
    let lan = crate::lan_ip();
    let status = HostStatus { running: true, name, port, pin, lan: lan.clone(), public: None, reach: "checking".into() };
    *host.status.lock().unwrap() = status.clone();
    // The router, in the background: the server is usable on this computer right away.
    let app2 = app.clone();
    let upnp = tokio::spawn(async move { keep_port_open(app2, port, lan).await });
    *host.upnp.lock().unwrap() = Some(upnp);
    Ok(status)
}

/// Stops the server and asks the router to close the port again.
#[tauri::command]
pub async fn host_stop(host: State<'_, Host>) -> CmdResult {
    let port = {
        let mut s = host.status.lock().unwrap();
        let port = s.port;
        *s = HostStatus::default();
        port
    };
    if let Some(t) = host.task.lock().unwrap().take() {
        t.abort();
    }
    if let Some(t) = host.upnp.lock().unwrap().take() {
        t.abort();
    }
    if port != 0 {
        close_port(port).await;
    }
    Ok(())
}

#[tauri::command]
pub fn host_status(host: State<'_, Host>) -> HostStatus {
    host.status.lock().unwrap().clone()
}

/// When Hopp quits: the router's port is closed again (best effort, briefly).
pub fn stop_on_exit(app: &AppHandle) {
    let port = app.state::<Host>().status.lock().unwrap().port;
    if port != 0 {
        tauri::async_runtime::block_on(async { tokio::time::timeout(Duration::from_secs(2), close_port(port)).await.ok() });
    }
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

/// Asks the router to forward the port (TCP for chat, UDP for voice) to this computer, and
/// renews it while the server runs. Routers without UPnP (or with it turned off) say no: then
/// the server works on the home network only, and the app says so.
async fn keep_port_open(app: AppHandle, port: u16, lan: Option<String>) {
    let Some(IpAddr::V4(local)) = lan.and_then(|l| l.parse().ok()) else {
        report(&app, |s| s.reach = "home".into());
        return;
    };
    loop {
        match open_port(local, port).await {
            Ok(public) => report(&app, |s| {
                s.public = Some(public.to_string());
                s.reach = "open".into();
            }),
            Err(e) => {
                tracing::info!("the router didn't open port {port}: {e:#}");
                report(&app, |s| {
                    s.public = None;
                    s.reach = "home".into();
                });
            }
        }
        tokio::time::sleep(RENEW).await;
    }
}

async fn open_port(local: Ipv4Addr, port: u16) -> anyhow::Result<IpAddr> {
    use igd_next::aio::tokio::search_gateway;
    use igd_next::PortMappingProtocol;
    let gateway = search_gateway(search(3)).await?;
    let to = SocketAddr::V4(SocketAddrV4::new(local, port));
    for protocol in [PortMappingProtocol::TCP, PortMappingProtocol::UDP] {
        gateway.add_port(protocol, port, to, LEASE.as_secs() as u32, "Hopp server").await?;
    }
    let public = gateway.get_external_ip().await?;
    // A router behind another one (or the operator's shared address) gives a private address:
    // the port is open on this router, but not to the internet.
    anyhow::ensure!(is_public(&public), "the router's own address ({public}) isn't on the internet");
    Ok(public)
}

async fn close_port(port: u16) {
    use igd_next::aio::tokio::search_gateway;
    use igd_next::PortMappingProtocol;
    if let Ok(gateway) = search_gateway(search(2)).await {
        for protocol in [PortMappingProtocol::TCP, PortMappingProtocol::UDP] {
            let _ = gateway.remove_port(protocol, port).await;
        }
    }
}

fn search(seconds: u64) -> igd_next::SearchOptions {
    let mut options = igd_next::SearchOptions::default();
    options.timeout = Some(Duration::from_secs(seconds));
    options
}

/// Reachable from the internet: not a home, shared (CGNAT 100.64/10) or special address.
fn is_public(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            !(v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_unspecified() || v4.is_broadcast() || (o[0] == 100 && (o[1] & 0xC0) == 64))
        }
        IpAddr::V6(v6) => !(v6.is_loopback() || v6.is_unspecified()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_and_home_addresses_are_not_public() {
        assert!(!is_public(&"192.168.1.10".parse().unwrap()));
        assert!(!is_public(&"10.0.0.1".parse().unwrap()));
        assert!(!is_public(&"100.72.3.4".parse().unwrap()), "an operator's shared address (CGNAT)");
        assert!(is_public(&"81.229.10.20".parse().unwrap()));
    }
}
