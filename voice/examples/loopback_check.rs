//! Checks that the computer's sound can be captured: plays a Windows sound in another program
//! started outside this one's process tree (which is left out on purpose), and
//! reports how loud what was captured is.
//!
//!     cargo run -p strom-voice --example loopback_check
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn main() -> anyhow::Result<()> {
    let (tx, rx) = std::sync::mpsc::sync_channel(500);
    let stop = Arc::new(AtomicBool::new(false));
    let thread = strom_voice::loopback::capture(tx, stop.clone())?;
    println!("capturing");
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", r#"Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='powershell -NoProfile -Command (New-Object Media.SoundPlayer ''C:\Windows\Media\Alarm01.wav'').PlaySync()'} | Out-Null"#])
        .spawn()?;
    let start = Instant::now();
    let (mut frames, mut loudest) = (0, 0f32);
    while start.elapsed() < Duration::from_secs(4) {
        if let Ok(f) = rx.recv_timeout(Duration::from_millis(200)) {
            frames += 1;
            let rms = (f.iter().map(|s| s * s).sum::<f32>() / f.len() as f32).sqrt();
            loudest = loudest.max(rms);
        }
    }
    stop.store(true, Ordering::Relaxed);
    let _ = thread.join();
    println!("{frames} frames of 10 ms, loudest {loudest:.4}");
    Ok(())
}
