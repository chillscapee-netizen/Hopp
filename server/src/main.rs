use std::net::SocketAddr;

use strom_server::{ServerConfig, Storage};
use strom_shared::DEFAULT_PORT;
use tokio::net::{TcpListener, UdpSocket};
use tracing_subscriber::EnvFilter;

const USAGE: &str = "usage: strom-server [--name \"My server\"] [--port PORT] [--data DIR]

  --name   name shown in the app when the server is created (default: Strom)
  --port   TCP and UDP port (default: 7777)
  --data   where accounts, channels and chat are saved (default: strom-data)

The server is invite-only. The first person to connect from this computer
becomes the owner and can create channels and invite links. To claim it from
another computer, use the setup link printed at startup.";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let mut port = DEFAULT_PORT;
    let mut name = "Strom".to_string();
    let mut data = "strom-data".to_string();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value = || args.next().ok_or_else(|| anyhow::anyhow!(USAGE));
        match arg.as_str() {
            "--port" => port = value()?.parse().map_err(|_| anyhow::anyhow!(USAGE))?,
            "--name" => name = value()?,
            "--data" => data = value()?,
            "-h" | "--help" => {
                println!("{USAGE}");
                return Ok(());
            }
            _ => anyhow::bail!(USAGE),
        }
    }

    let storage = Storage::at(&data)?;
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let tcp = TcpListener::bind(addr).await?;
    let udp = UdpSocket::bind(addr).await?;
    tracing::info!("Strom server listening on {addr} (TCP control + UDP voice), data in {data}");
    strom_server::run(tcp, udp, ServerConfig::default_named(&name), storage).await
}
