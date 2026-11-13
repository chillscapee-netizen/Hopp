//! Headless client for testing without the GUI.
//!
//!     cargo run -p strom-voice --example cli -- localhost alice [seconds] [--raw]
//!
//! `--raw` turns noise suppression off.
//!
//! Logs in with a throwaway Hopp ID, joins the first voice channel with the
//! default microphone and speakers, and prints events.

use std::time::{Duration, Instant};

use strom_shared::{ChannelKind, ClientMsg};
use strom_voice::{EngineEvent, Identity, VoiceEngine};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let addr = args.first().map(String::as_str).unwrap_or("localhost");
    let name = args.get(1).map(String::as_str).unwrap_or("cli");
    let seconds: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(u64::MAX);

    if args.iter().any(|a| a == "--mic-test") {
        let settings = std::sync::Arc::new(strom_voice::AudioSettings::default());
        settings.set_monitor(true);
        let (_test, events) = strom_voice::MicTest::start(&Default::default(), settings)?;
        let levels = events.iter().take(40).filter(|e| matches!(e, EngineEvent::InputLevel { .. })).count();
        println!("mic test ok: {levels} level updates in ~2 s");
        return Ok(());
    }

    let (identity, _) = Identity::create(name, "throwaway-password")?;
    let (_, invite) = strom_voice::parse_invite(addr)?;
    let mut session = strom_voice::connect(addr, &identity, invite.as_deref(), None).await?;
    println!("connected as #{} ({} users online)", session.roster.me, session.roster.users.len());
    let voice = session.roster.channels.iter().find(|c| c.kind == ChannelKind::Voice).map(|c| c.id);
    let voice = voice.ok_or_else(|| anyhow::anyhow!("the server has no voice channel"))?;
    session.control.send(ClientMsg::JoinVoice { channel: voice });
    let devices = strom_voice::list_devices();
    println!("inputs: {:?}\noutputs: {:?}", devices.inputs, devices.outputs);
    let relay = session.udp_addr.ok_or_else(|| anyhow::anyhow!("this server has no voice relay"))?;
    let settings = std::sync::Arc::new(strom_voice::AudioSettings::default());
    if args.iter().any(|a| a == "--raw") {
        settings.set_noise_suppression(false);
    }
    let (mut engine, events) = VoiceEngine::start(relay, session.roster.me, session.udp_token, &Default::default(), settings)?;
    if args.iter().any(|a| a == "--switch") {
        let input = devices.inputs.last().cloned();
        println!("switching microphone to {input:?}");
        engine.set_devices(&strom_voice::DeviceChoice { input, output: None })?;
    }
    println!("audio running, speak into the microphone");

    tokio::spawn(async move {
        while let Some(msg) = session.events.recv().await {
            println!("server: {msg:?}");
        }
        println!("server closed the connection");
    });

    let deadline = Instant::now().checked_add(Duration::from_secs(seconds));
    let mut levels = 0;
    loop {
        if deadline.is_some_and(|d| Instant::now() >= d) {
            break;
        }
        match events.recv_timeout(Duration::from_millis(100)) {
            Ok(EngineEvent::InputLevel { db, .. }) => {
                levels += 1;
                if levels % 10 == 0 {
                    println!("mic level {db:.1} dB");
                }
            }
            Ok(ev) => println!("{ev:?}"),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(e) => anyhow::bail!(e),
        }
    }
    println!("received {levels} level updates");
    Ok(())
}
