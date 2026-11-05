//! Realtime voice: microphone -> noise suppression -> Opus -> UDP, and
//! UDP -> jitter buffer -> Opus -> mixer -> speakers.
//!
//! Voice goes through the server's UDP relay on self-hosted servers, and
//! straight to each peer on cloud servers (see [`crate::mesh`]).
//!
//! Threads (restarted together when the audio devices change):
//! - audio: owns the cpal streams (they are not `Send`) until shutdown
//! - encoder: processes (see [`crate::capture`]), gates and encodes captured audio
//! - receiver: reads voice packets into per-speaker jitter buffers
//!
//! The output callback itself pulls decoded frames from the mixer, and hands
//! them to the echo canceller as the far-end reference.

use std::collections::{HashMap, VecDeque};
use std::net::{SocketAddr, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, SyncSender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::Context;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SizedSample};
use strom_shared::*;

use crate::capture::{AudioFrame, Processor};
use crate::dsp::Resampler;
use crate::jitter::{JitterBuffer, Playout};
use crate::mesh::{self, Mesh, Sealer};
use crate::settings::AudioSettings;

/// Fullband speech is transparent well below this; the headroom pays for FEC.
const BITRATE: i32 = 64_000;
/// Pings keep the NAT mapping open and measure the round trip to the server.
const PING_INTERVAL: Duration = Duration::from_secs(1);
/// Frames sent from just before the gate opens, so soft starts like "s" and "f" aren't cut (60 ms).
const PREROLL_FRAMES: usize = 6;
/// Talking this long while muted (out of the last couple of seconds) earns a reminder.
const MUTED_SPEECH_FRAMES: u32 = 60;
const MUTED_REMINDER_EVERY: Duration = Duration::from_secs(45);
/// Speakers we have not heard from in this long are forgotten.
const PEER_TIMEOUT: Duration = Duration::from_secs(10);
/// About 200 ms of mic-test audio; older audio is dropped so the echo stays close.
const MONITOR_MAX: usize = SAMPLE_RATE as usize / 5;
/// The mic test in voice starts playing once 30 ms are buffered.
const MONITOR_START: usize = FRAME_SAMPLES * 3;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineEvent {
    Speaking { session_id: SessionId, speaking: bool },
    /// Round trip to the server over the voice path, once per second.
    Latency { ms: u32 },
    /// Microphone level after processing, about 33 times per second, and
    /// whether voice activity would send it right now.
    InputLevel { db: f32, voice: bool },
    /// We seem to be talking while muted.
    SpeakingWhileMuted,
    /// A device was unplugged, failed, or the system default changed while we follow it.
    /// Reopen the devices (`set_devices` with the same choice) to carry on.
    DevicesChanged,
    /// Peer-to-peer voice: whether we can reach someone directly. Unreachable people
    /// can't hear us (nor we them) until one of the networks lets the traffic through.
    PeerReach { session_id: SessionId, reachable: bool },
}

/// Audio devices by name; `None` means the system default.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct DeviceChoice {
    pub input: Option<String>,
    pub output: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DeviceList {
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    pub default_input: Option<String>,
    pub default_output: Option<String>,
}

fn device_names(devices: Result<impl Iterator<Item = cpal::Device>, cpal::DevicesError>) -> Vec<String> {
    devices.map(|ds| ds.filter_map(|d| d.name().ok()).collect()).unwrap_or_default()
}

pub fn list_devices() -> DeviceList {
    let host = cpal::default_host();
    DeviceList {
        inputs: device_names(host.input_devices()),
        outputs: device_names(host.output_devices()),
        default_input: host.default_input_device().and_then(|d| d.name().ok()),
        default_output: host.default_output_device().and_then(|d| d.name().ok()),
    }
}

/// One set of running audio threads; dropping it stops them.
struct Running {
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
}

impl Drop for Running {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        for t in self.threads.drain(..) {
            t.thread().unpark();
            let _ = t.join();
        }
    }
}

/// Where our voice goes.
#[derive(Clone)]
enum Route {
    /// Through the server's UDP relay (self-hosted servers); the socket is connected to it.
    Relay { token: u64 },
    /// Straight to everyone in the channel (cloud servers).
    Mesh(Arc<Mesh>),
}

pub struct VoiceEngine {
    /// Kept across device changes, so peers can keep using the address they know.
    socket: UdpSocket,
    session_id: SessionId,
    route: Route,
    endpoint: Option<PeerEndpoint>,
    settings: Arc<AudioSettings>,
    events: Sender<EngineEvent>,
    running: Option<Running>,
}

impl VoiceEngine {
    /// Opens the chosen audio devices and starts streaming voice to the relay at `server`.
    /// Events arrive on the returned receiver for the engine's whole lifetime.
    pub fn start(
        server: SocketAddr,
        session_id: SessionId,
        token: u64,
        devices: &DeviceChoice,
        settings: Arc<AudioSettings>,
    ) -> anyhow::Result<(Self, Receiver<EngineEvent>)> {
        let socket = UdpSocket::bind(if server.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" })?;
        socket.connect(server)?;
        Self::start_with(socket, session_id, Route::Relay { token }, None, devices, settings)
    }

    /// Starts peer-to-peer voice with the channel's `key`. Looks up our public
    /// address first (up to a couple of seconds); send [`Self::endpoint`] to the
    /// server so peers can find us, and add them with [`Self::set_peer`].
    pub fn start_mesh(
        session_id: SessionId,
        key: [u8; 32],
        devices: &DeviceChoice,
        settings: Arc<AudioSettings>,
    ) -> anyhow::Result<(Self, Receiver<EngineEvent>)> {
        let socket = mesh::dual_stack_socket()?;
        let port = socket.local_addr()?.port();
        let public = mesh::public_address(&socket);
        if public.is_none() {
            tracing::warn!("no STUN server answered; only peers on this network can be reached");
        }
        // Where peers can try us: this network's address, and our IPv6 address on the internet.
        let mut local: Vec<String> = mesh::local_ip().map(|ip| SocketAddr::new(ip, port).to_string()).into_iter().collect();
        if mesh::is_dual(&socket) {
            if let Some(v6) = mesh::global_ipv6() {
                local.push(SocketAddr::new(v6.into(), port).to_string());
            }
        }
        let endpoint = PeerEndpoint { session_id, public: public.map(|a| a.to_string()), local };
        let route = Route::Mesh(Arc::new(Mesh::new(session_id, &key)));
        Self::start_with(socket, session_id, route, Some(endpoint), devices, settings)
    }

    fn start_with(
        socket: UdpSocket,
        session_id: SessionId,
        route: Route,
        endpoint: Option<PeerEndpoint>,
        devices: &DeviceChoice,
        settings: Arc<AudioSettings>,
    ) -> anyhow::Result<(Self, Receiver<EngineEvent>)> {
        socket.set_read_timeout(Some(Duration::from_millis(200)))?;
        let (events, rx) = mpsc::channel();
        let mut engine = VoiceEngine { socket, session_id, route, endpoint, settings, events, running: None };
        engine.set_devices(devices)?;
        Ok((engine, rx))
    }

    /// Switches audio devices, restarting the audio threads. Settings are kept.
    /// If the chosen devices can't be opened, falls back to the system defaults
    /// (and still reports the error), so voice never just goes silent.
    pub fn set_devices(&mut self, devices: &DeviceChoice) -> anyhow::Result<()> {
        self.running = None;
        match self.spawn(devices) {
            Ok(running) => {
                self.running = Some(running);
                Ok(())
            }
            Err(e) if *devices != DeviceChoice::default() => {
                tracing::warn!("couldn't open {devices:?}: {e:#}; trying the defaults");
                self.running = Some(self.spawn(&DeviceChoice::default())?);
                Err(e.context("using the default devices instead"))
            }
            Err(e) => Err(e),
        }
    }

    /// Peer-to-peer voice only: where peers can reach us.
    pub fn endpoint(&self) -> Option<&PeerEndpoint> {
        self.endpoint.as_ref()
    }

    /// Peer-to-peer voice only: adds someone in our channel, or updates their addresses.
    pub fn set_peer(&self, peer: &PeerEndpoint) {
        if let Route::Mesh(m) = &self.route {
            m.set_peer(peer);
        }
    }

    /// Peer-to-peer voice only: stops sending to everyone `keep` rejects.
    pub fn retain_peers(&self, keep: impl Fn(SessionId) -> bool) {
        if let Route::Mesh(m) = &self.route {
            m.retain_peers(keep);
        }
    }

    fn spawn(&self, devices: &DeviceChoice) -> anyhow::Result<Running> {
        let session_id = self.session_id;
        let stop = Arc::new(AtomicBool::new(false));
        let mut running = Running { stop: stop.clone(), threads: Vec::new() };
        let socket = self.socket.try_clone()?;

        // What we play goes to the echo canceller; a few frames of slack, then it's dropped.
        let (render_tx, render_rx) = mpsc::sync_channel::<AudioFrame>(32);
        let mixer = Arc::new(Mutex::new(Mixer::new(session_id, self.events.clone(), self.settings.clone(), Some(render_tx))));
        let (capture_tx, capture_rx) = mpsc::sync_channel::<Vec<f32>>(64);

        let make_fill = {
            let mixer = mixer.clone();
            move |output_rate| {
                mixer.lock().unwrap().set_output_rate(output_rate);
                move |buf: &mut [f32]| mixer.lock().unwrap().fill(buf)
            }
        };
        let changed = {
            let events = self.events.clone();
            move || {
                let _ = events.send(EngineEvent::DevicesChanged);
            }
        };
        let (audio, input_rate) = spawn_audio_thread(devices, capture_tx, make_fill, changed, stop.clone())?;
        running.threads.push(audio);

        let epoch = Instant::now();
        running.threads.push({
            let (stop, settings, events) = (stop.clone(), self.settings.clone(), self.events.clone());
            let net = Net::new(socket.try_clone()?, self.route.clone(), session_id, epoch);
            std::thread::Builder::new().name("strom-encoder".into()).spawn(move || {
                let mut enc = Encoder { session_id, net, settings, events, speaking: false };
                let processor = Processor::new(input_rate, Some(render_rx));
                if let Err(e) = enc.run(capture_rx, processor, &stop) {
                    tracing::error!("encoder stopped: {e:#}");
                }
            })?
        });

        running.threads.push({
            let events = self.events.clone();
            let net = Net::new(socket, self.route.clone(), session_id, epoch);
            std::thread::Builder::new()
                .name("strom-receiver".into())
                .spawn(move || run_receiver(net, mixer, &events, &stop))?
        });
        Ok(running)
    }

    pub fn settings(&self) -> &AudioSettings {
        &self.settings
    }
}

type Streams = (cpal::Stream, cpal::Stream);

fn pick_device(
    devices: Result<impl Iterator<Item = cpal::Device>, cpal::DevicesError>,
    wanted: Option<&str>,
    default: Option<cpal::Device>,
) -> Option<cpal::Device> {
    let found = wanted.and_then(|name| devices.ok()?.find(|d| d.name().is_ok_and(|n| n == name)));
    if found.is_none() && wanted.is_some() {
        tracing::warn!("audio device {wanted:?} not found, using the default");
    }
    found.or(default)
}

/// The devices that were actually opened, to notice when the system default moves on.
struct Opened {
    input: String,
    output: String,
}

/// Opens the microphone (sending mono chunks to `capture`) and the speakers.
/// `make_fill` gets the speaker sample rate and returns what fills each
/// mono output buffer. A stream error sets `failed`.
/// Returns the streams, the microphone sample rate and the device names.
fn open_streams<F>(
    devices: &DeviceChoice,
    capture: SyncSender<Vec<f32>>,
    make_fill: impl FnOnce(u32) -> F,
    failed: Arc<AtomicBool>,
) -> anyhow::Result<(Streams, u32, Opened)>
where
    F: FnMut(&mut [f32]) + Send + 'static,
{
    let host = cpal::default_host();
    let input = pick_device(host.input_devices(), devices.input.as_deref(), host.default_input_device())
        .context("no microphone found")?;
    let output = pick_device(host.output_devices(), devices.output.as_deref(), host.default_output_device())
        .context("no speakers found")?;
    let in_cfg = input.default_input_config().context("the microphone can't be opened")?;
    let out_cfg = output.default_output_config().context("the speakers can't be opened")?;
    let input_rate = in_cfg.sample_rate().0;
    let fill = make_fill(out_cfg.sample_rate().0);

    let (cfg, f) = (in_cfg.config(), failed.clone());
    let in_stream = match in_cfg.sample_format() {
        SampleFormat::F32 => build_input::<f32>(&input, &cfg, capture, f)?,
        SampleFormat::F64 => build_input::<f64>(&input, &cfg, capture, f)?,
        SampleFormat::I16 => build_input::<i16>(&input, &cfg, capture, f)?,
        SampleFormat::I32 => build_input::<i32>(&input, &cfg, capture, f)?,
        SampleFormat::I8 => build_input::<i8>(&input, &cfg, capture, f)?,
        SampleFormat::U16 => build_input::<u16>(&input, &cfg, capture, f)?,
        SampleFormat::U8 => build_input::<u8>(&input, &cfg, capture, f)?,
        f => anyhow::bail!("unsupported microphone sample format {f}"),
    };
    let (cfg, f) = (out_cfg.config(), failed);
    let out_stream = match out_cfg.sample_format() {
        SampleFormat::F32 => build_output::<f32, F>(&output, &cfg, fill, f)?,
        SampleFormat::F64 => build_output::<f64, F>(&output, &cfg, fill, f)?,
        SampleFormat::I16 => build_output::<i16, F>(&output, &cfg, fill, f)?,
        SampleFormat::I32 => build_output::<i32, F>(&output, &cfg, fill, f)?,
        SampleFormat::I8 => build_output::<i8, F>(&output, &cfg, fill, f)?,
        SampleFormat::U16 => build_output::<u16, F>(&output, &cfg, fill, f)?,
        SampleFormat::U8 => build_output::<u8, F>(&output, &cfg, fill, f)?,
        f => anyhow::bail!("unsupported speaker sample format {f}"),
    };
    in_stream.play().context("the microphone can't be started")?;
    out_stream.play().context("the speakers can't be started")?;
    let opened = Opened { input: input.name().unwrap_or_default(), output: output.name().unwrap_or_default() };
    tracing::info!("audio: microphone {:?}, speakers {:?}", opened.input, opened.output);
    Ok(((in_stream, out_stream), input_rate, opened))
}

/// Whether the devices should be reopened: we follow the system default and it
/// moved, or a chosen device that was missing has come back.
fn devices_moved(devices: &DeviceChoice, opened: &Opened) -> bool {
    let host = cpal::default_host();
    let name = |d: Option<cpal::Device>| d.and_then(|d| d.name().ok());
    let moved = |wanted: &Option<String>, default: Option<String>, all: Vec<String>, open: &str| match wanted {
        None => default.is_some_and(|d| d != open),
        Some(w) => w != open && all.iter().any(|n| n == w),
    };
    moved(&devices.input, name(host.default_input_device()), device_names(host.input_devices()), &opened.input)
        || moved(&devices.output, name(host.default_output_device()), device_names(host.output_devices()), &opened.output)
}

/// How often the audio thread checks for unplugged or changed devices.
const DEVICE_CHECK_INTERVAL: Duration = Duration::from_secs(2);

/// Runs `open_streams` on its own thread (cpal streams are not `Send`) and keeps
/// the streams alive until `stop` is set. Calls `changed` once if a device fails,
/// is unplugged, or the system default moves while we follow it.
/// Returns the thread and the microphone rate.
fn spawn_audio_thread<F>(
    devices: &DeviceChoice,
    capture: SyncSender<Vec<f32>>,
    make_fill: impl FnOnce(u32) -> F + Send + 'static,
    changed: impl Fn() + Send + 'static,
    stop: Arc<AtomicBool>,
) -> anyhow::Result<(JoinHandle<()>, u32)>
where
    F: FnMut(&mut [f32]) + Send + 'static,
{
    let devices = devices.clone();
    let (ready_tx, ready_rx) = mpsc::channel();
    let thread = std::thread::Builder::new().name("strom-audio".into()).spawn(move || {
        let failed = Arc::new(AtomicBool::new(false));
        match open_streams(&devices, capture, make_fill, failed.clone()) {
            Ok((streams, input_rate, opened)) => {
                let _ = ready_tx.send(Ok(input_rate));
                let mut last_check = Instant::now();
                let mut reported = false;
                while !stop.load(Ordering::Relaxed) {
                    std::thread::park_timeout(Duration::from_millis(100));
                    if reported {
                        continue;
                    }
                    let moved = last_check.elapsed() >= DEVICE_CHECK_INTERVAL && {
                        last_check = Instant::now();
                        devices_moved(&devices, &opened)
                    };
                    if failed.load(Ordering::Relaxed) || moved {
                        tracing::info!("audio devices changed; asking for a restart");
                        reported = true;
                        changed();
                    }
                }
                drop(streams);
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
            }
        }
    })?;
    let input_rate = ready_rx.recv().context("audio thread died")??;
    Ok((thread, input_rate))
}

fn build_input<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    capture: SyncSender<Vec<f32>>,
    failed: Arc<AtomicBool>,
) -> anyhow::Result<cpal::Stream>
where
    T: SizedSample,
    f32: cpal::FromSample<T>,
{
    let channels = config.channels as usize;
    Ok(device.build_input_stream(
        config,
        move |data: &[T], _| {
            let mono = data
                .chunks(channels)
                .map(|f| f.iter().map(|&s| <f32 as cpal::Sample>::from_sample(s)).sum::<f32>() / channels as f32)
                .collect();
            // If the encoder falls behind, dropping audio beats queueing latency.
            let _ = capture.try_send(mono);
        },
        move |e| {
            tracing::error!("microphone error: {e}");
            failed.store(true, Ordering::Relaxed);
        },
        None,
    )?)
}

fn build_output<T, F>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    mut fill: F,
    failed: Arc<AtomicBool>,
) -> anyhow::Result<cpal::Stream>
where
    T: SizedSample + cpal::FromSample<f32>,
    F: FnMut(&mut [f32]) + Send + 'static,
{
    let channels = config.channels as usize;
    let mut mono = Vec::new();
    Ok(device.build_output_stream(
        config,
        move |data: &mut [T], _| {
            mono.resize(data.len() / channels, 0.0);
            fill(&mut mono);
            for (frame, &s) in data.chunks_mut(channels).zip(&mono) {
                frame.fill(cpal::Sample::from_sample(s.clamp(-1.0, 1.0)));
            }
        },
        move |e| {
            tracing::error!("speaker error: {e}");
            failed.store(true, Ordering::Relaxed);
        },
        None,
    )?)
}

/// A microphone check outside of voice: runs the same processing as voice,
/// reports the level and the gate, and can play the result back through the
/// speakers (`AudioSettings::set_monitor`). Nothing is sent anywhere.
pub struct MicTest {
    stop: Arc<AtomicBool>,
    threads: Vec<JoinHandle<()>>,
}

impl MicTest {
    pub fn start(devices: &DeviceChoice, settings: Arc<AudioSettings>) -> anyhow::Result<(Self, Receiver<EngineEvent>)> {
        let stop = Arc::new(AtomicBool::new(false));
        let (capture_tx, capture_rx) = mpsc::sync_channel::<Vec<f32>>(64);
        let (events, rx) = mpsc::channel();

        let make_fill = {
            let settings = settings.clone();
            move |output_rate| {
                let mut resampler = Resampler::new(SAMPLE_RATE, output_rate);
                let mut pending = VecDeque::new();
                move |buf: &mut [f32]| {
                    {
                        let mut q = settings.monitor_queue.lock().unwrap();
                        while pending.len() < buf.len() && !q.is_empty() {
                            let take = q.len().min(FRAME_SAMPLES);
                            let chunk: Vec<f32> = q.drain(..take).collect();
                            resampler.process(&chunk, &mut pending);
                        }
                    }
                    let gain = settings.playback_gain();
                    for s in buf.iter_mut() {
                        *s = pending.pop_front().unwrap_or(0.0) * gain;
                    }
                }
            }
        };
        let changed = {
            let events = events.clone();
            move || {
                let _ = events.send(EngineEvent::DevicesChanged);
            }
        };
        let (audio, input_rate) = spawn_audio_thread(devices, capture_tx, make_fill, changed, stop.clone())?;

        let processor = {
            let stop = stop.clone();
            std::thread::Builder::new().name("strom-mic-test".into()).spawn(move || {
                let mut processor = Processor::new(input_rate, None);
                let mut feed = MonitorFeed::default();
                while !stop.load(Ordering::Relaxed) {
                    let chunk = match capture_rx.recv_timeout(Duration::from_millis(200)) {
                        Ok(c) => c,
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    };
                    let _ = processor.push(&chunk, &settings, |clean, a| {
                        if let Some((db, voice)) = a.report {
                            let _ = events.send(EngineEvent::InputLevel { db, voice });
                        }
                        // The mic test plays what others would hear: only while the gate is open or the key is held.
                        feed.feed(&settings, clean, a.send);
                        Ok(())
                    });
                }
            })?
        };

        Ok((MicTest { stop, threads: vec![audio, processor] }, rx))
    }
}

impl Drop for MicTest {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        for t in self.threads.drain(..) {
            t.thread().unpark();
            let _ = t.join();
        }
    }
}

/// Plays a short chime on the chosen speakers (`None` = the system default),
/// so people can check they hear Hopp where they expect. Returns at once.
pub fn play_test_sound(output: Option<String>, volume: f32) -> anyhow::Result<()> {
    let (ready_tx, ready_rx) = mpsc::channel();
    std::thread::Builder::new().name("strom-test-sound".into()).spawn(move || {
        let host = cpal::default_host();
        let opened = pick_device(host.output_devices(), output.as_deref(), host.default_output_device())
            .context("no speakers found")
            .and_then(|device| {
                let cfg = device.default_output_config()?;
                let rate = cfg.sample_rate().0 as f32;
                let mut t = 0usize;
                // Two soft rising notes, 0.7 s in all.
                let fill = move |buf: &mut [f32]| {
                    for s in buf.iter_mut() {
                        let secs = t as f32 / rate;
                        t += 1;
                        let (freq, start) = if secs < 0.25 { (660.0, 0.0) } else { (880.0, 0.25) };
                        let local = secs - start;
                        let envelope = if secs > 0.7 { 0.0 } else { (local * 60.0).min(1.0) * (-local * 6.0).exp() };
                        *s = 0.25 * volume * envelope * (std::f32::consts::TAU * freq * secs).sin();
                    }
                };
                let failed = Arc::new(AtomicBool::new(false));
                let stream = match cfg.sample_format() {
                    SampleFormat::F32 => build_output::<f32, _>(&device, &cfg.config(), fill, failed)?,
                    SampleFormat::I16 => build_output::<i16, _>(&device, &cfg.config(), fill, failed)?,
                    SampleFormat::I32 => build_output::<i32, _>(&device, &cfg.config(), fill, failed)?,
                    f => anyhow::bail!("unsupported speaker sample format {f}"),
                };
                stream.play()?;
                Ok(stream)
            });
        match opened {
            Ok(stream) => {
                let _ = ready_tx.send(Ok(()));
                std::thread::sleep(Duration::from_millis(900));
                drop(stream);
            }
            Err(e) => {
                let _ = ready_tx.send(Err(e));
            }
        }
    })?;
    ready_rx.recv().context("audio thread died")?
}

/// Feeds the mic test with what others would hear, including the moment just before
/// the gate opens (the same pre-roll that goes out), so word starts aren't cut.
#[derive(Default)]
struct MonitorFeed {
    preroll: VecDeque<AudioFrame>,
    sending: bool,
}

impl MonitorFeed {
    fn feed(&mut self, settings: &AudioSettings, clean: &AudioFrame, send: bool) {
        if !settings.monitor.load(Ordering::Relaxed) {
            self.preroll.clear();
            self.sending = send;
            return;
        }
        if send {
            if !self.sending {
                for frame in self.preroll.drain(..) {
                    monitor(settings, &frame);
                }
            }
            monitor(settings, clean);
        } else {
            self.preroll.push_back(*clean);
            if self.preroll.len() > PREROLL_FRAMES {
                self.preroll.pop_front();
            }
        }
        self.sending = send;
    }
}

/// The mic test: queue our processed microphone for local playback.
fn monitor(settings: &AudioSettings, clean: &AudioFrame) {
    if settings.monitor.load(Ordering::Relaxed) {
        let mut q = settings.monitor_queue.lock().unwrap();
        q.extend(clean.iter().copied());
        let excess = q.len().saturating_sub(MONITOR_MAX);
        q.drain(..excess);
    }
}

/// Sends our packets the way the route needs: plain to the relay, sealed to each peer.
struct Net {
    socket: UdpSocket,
    /// The socket speaks IPv4 and IPv6; IPv4 addresses go out IPv4-mapped.
    dual: bool,
    route: Route,
    session_id: SessionId,
    sealer: Option<Sealer>,
    /// Ping nonces are milliseconds since this instant, shared by sender and receiver.
    epoch: Instant,
    last_relay_ping: Option<Instant>,
    packet: Vec<u8>,
    plain: Vec<u8>,
}

impl Net {
    fn new(socket: UdpSocket, route: Route, session_id: SessionId, epoch: Instant) -> Self {
        let sealer = match &route {
            Route::Mesh(m) => Some(Sealer::new(&m.key, session_id)),
            Route::Relay { .. } => None,
        };
        Net {
            dual: mesh::is_dual(&socket),
            socket,
            route,
            session_id,
            sealer,
            epoch,
            last_relay_ping: None,
            packet: Vec::with_capacity(1500),
            plain: Vec::with_capacity(1500),
        }
    }

    fn now_ms(&self) -> u32 {
        self.epoch.elapsed().as_millis() as u32
    }

    /// Pings that are due: to the relay once a second; to peers as probes or keepalives.
    fn tick(&mut self) {
        let nonce = self.now_ms();
        match &self.route {
            Route::Relay { token } => {
                if self.last_relay_ping.is_some_and(|t| t.elapsed() < PING_INTERVAL) {
                    return;
                }
                self.last_relay_ping = Some(Instant::now());
                ClientPacket::Ping { session_id: self.session_id, token: *token, nonce }.write(&mut self.packet);
                let _ = self.socket.send(&self.packet);
            }
            Route::Mesh(m) => {
                let due = m.due_pings();
                if due.is_empty() {
                    return;
                }
                let sealer = self.sealer.as_mut().expect("mesh routes have a sealer");
                sealer.seal(mesh::KIND_PING, &nonce.to_be_bytes(), &mut self.packet);
                for addr in due {
                    let _ = self.socket.send_to(&self.packet, mesh::wire(addr, self.dual));
                }
            }
        }
    }

    fn send_voice(&mut self, seq: u32, opus: &[u8]) {
        match &self.route {
            Route::Relay { token } => {
                ClientPacket::Voice { session_id: self.session_id, token: *token, seq, opus }.write(&mut self.packet);
                let _ = self.socket.send(&self.packet);
            }
            Route::Mesh(m) => {
                let paths = m.paths();
                if paths.is_empty() {
                    return;
                }
                self.plain.clear();
                self.plain.extend_from_slice(&seq.to_be_bytes());
                self.plain.extend_from_slice(opus);
                let sealer = self.sealer.as_mut().expect("mesh routes have a sealer");
                sealer.seal(mesh::KIND_VOICE, &self.plain, &mut self.packet);
                for addr in paths {
                    let _ = self.socket.send_to(&self.packet, mesh::wire(addr, self.dual));
                }
            }
        }
    }

    /// Answers a peer's ping with the same payload, so they can time the round trip.
    fn pong(&mut self, payload: &[u8], to: SocketAddr) {
        if let Some(sealer) = self.sealer.as_mut() {
            sealer.seal(mesh::KIND_PONG, payload, &mut self.packet);
            let _ = self.socket.send_to(&self.packet, mesh::wire(to, self.dual));
        }
    }
}

struct Encoder {
    session_id: SessionId,
    net: Net,
    settings: Arc<AudioSettings>,
    events: Sender<EngineEvent>,
    speaking: bool,
}

impl Encoder {
    fn set_speaking(&mut self, speaking: bool) {
        if speaking != self.speaking {
            self.speaking = speaking;
            let _ = self.events.send(EngineEvent::Speaking { session_id: self.session_id, speaking });
        }
    }

    fn run(&mut self, capture: Receiver<Vec<f32>>, processor: Processor, stop: &AtomicBool) -> anyhow::Result<()> {
        let result = self.encode_loop(capture, processor, stop);
        self.set_speaking(false);
        result
    }

    fn encode_loop(&mut self, capture: Receiver<Vec<f32>>, mut processor: Processor, stop: &AtomicBool) -> anyhow::Result<()> {
        let mut encoder = opus::Encoder::new(SAMPLE_RATE, opus::Channels::Mono, opus::Application::Voip)?;
        encoder.set_bitrate(opus::Bitrate::Bits(BITRATE))?;
        encoder.set_signal(opus::Signal::Voice)?;
        encoder.set_complexity(10)?;
        encoder.set_inband_fec(true)?;
        encoder.set_packet_loss_perc(10)?;

        let mut opus_buf = [0u8; 1275];
        let mut seq = 0u32;
        let mut preroll: VecDeque<Vec<u8>> = VecDeque::with_capacity(PREROLL_FRAMES + 1);
        let mut muted_speech = 0u32;
        let mut feed = MonitorFeed::default();
        let mut last_reminder: Option<Instant> = None;
        let settings = self.settings.clone();

        while !stop.load(Ordering::Relaxed) {
            self.net.tick();
            if let Route::Mesh(m) = &self.net.route {
                for (session_id, reachable) in m.reach_changes() {
                    let _ = self.events.send(EngineEvent::PeerReach { session_id, reachable });
                }
            }
            let chunk = match capture.recv_timeout(Duration::from_millis(200)) {
                Ok(c) => c,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            processor.push(&chunk, &settings, |clean, a| {
                if let Some((db, voice)) = a.report {
                    let _ = self.events.send(EngineEvent::InputLevel { db, voice });
                }
                feed.feed(&settings, clean, a.send);
                let wants_to_talk = a.send;
                let silenced = settings.muted() || settings.deafened();
                // Talking into a muted mic: count it up while it lasts, let it fade otherwise.
                if settings.muted() && !settings.deafened() && a.send {
                    muted_speech += 1;
                } else {
                    muted_speech = muted_speech.saturating_sub(1);
                }
                if muted_speech >= MUTED_SPEECH_FRAMES && last_reminder.is_none_or(|t| t.elapsed() >= MUTED_REMINDER_EVERY) {
                    last_reminder = Some(Instant::now());
                    muted_speech = 0;
                    let _ = self.events.send(EngineEvent::SpeakingWhileMuted);
                }
                let transmit = wants_to_talk && !silenced;
                let started = transmit && !self.speaking;
                self.set_speaking(transmit);

                // Encode every frame, sent or not: the encoder stays warm and the pre-roll stays fresh.
                let len = encoder.encode_float(clean, &mut opus_buf)?;
                if transmit {
                    if started {
                        for p in preroll.drain(..) {
                            self.net.send_voice(seq, &p);
                            seq = seq.wrapping_add(1);
                        }
                    }
                    self.net.send_voice(seq, &opus_buf[..len]);
                    seq = seq.wrapping_add(1);
                } else if silenced {
                    // Never send what was said while muted.
                    preroll.clear();
                } else {
                    preroll.push_back(opus_buf[..len].to_vec());
                    if preroll.len() > PREROLL_FRAMES {
                        preroll.pop_front();
                    }
                }
                Ok(())
            })?;
        }
        Ok(())
    }
}

fn run_receiver(mut net: Net, mixer: Arc<Mutex<Mixer>>, events: &Sender<EngineEvent>, stop: &AtomicBool) {
    let mut buf = [0u8; 1500];
    let socket = net.socket.try_clone().expect("socket clones");
    while !stop.load(Ordering::Relaxed) {
        let Ok((len, from)) = socket.recv_from(&mut buf) else { continue };
        let packet = &buf[..len];
        let mesh = match &net.route {
            Route::Mesh(m) => m.clone(),
            Route::Relay { .. } => {
                if let Some(v) = ServerVoice::parse(packet) {
                    mixer.lock().unwrap().push(v.sender, v.seq, v.opus.to_vec());
                } else if let Some(ClientPacket::Ping { nonce, .. }) = ClientPacket::parse(packet) {
                    let _ = events.send(EngineEvent::Latency { ms: net.now_ms().wrapping_sub(nonce) });
                }
                continue;
            }
        };
        // Peer to peer: only sealed packets from people in our channel count.
        let Some((kind, sender, payload)) = mesh::open(&mesh.cipher, packet) else { continue };
        if !mesh.heard(sender, from) {
            continue;
        }
        match kind {
            mesh::KIND_VOICE if payload.len() > 4 => {
                let seq = u32::from_be_bytes(payload[..4].try_into().unwrap());
                mixer.lock().unwrap().push(sender, seq, payload[4..].to_vec());
            }
            mesh::KIND_PING => net.pong(&payload, from),
            mesh::KIND_PONG if payload.len() == 4 => {
                let rtt = net.now_ms().wrapping_sub(u32::from_be_bytes(payload[..4].try_into().unwrap()));
                if let Some(slowest) = mesh.record_rtt(sender, rtt) {
                    let _ = events.send(EngineEvent::Latency { ms: slowest });
                }
            }
            _ => {}
        }
    }
}

struct Peer {
    decoder: opus::Decoder,
    jitter: JitterBuffer,
    speaking: bool,
    last_heard: Instant,
}

/// The first 5 ms of every talk spurt fade in, so a sentence never starts with a click.
const FADE_IN: usize = SAMPLE_RATE as usize / 200;

/// Decodes and sums every active speaker, one 10 ms frame at a time.
struct Mixer {
    /// Our own voice comes back only in loopback; the encoder already reports when we speak.
    own_id: SessionId,
    peers: HashMap<SessionId, Peer>,
    resampler: Resampler,
    pending: VecDeque<f32>,
    events: Sender<EngineEvent>,
    settings: Arc<AudioSettings>,
    /// Everything we play from others, for the echo canceller.
    render: Option<SyncSender<AudioFrame>>,
    /// The mic test in voice plays once a little is buffered, so the microphone and
    /// speaker clocks drifting apart don't chop it up.
    monitor_playing: bool,
}

impl Mixer {
    fn new(own_id: SessionId, events: Sender<EngineEvent>, settings: Arc<AudioSettings>, render: Option<SyncSender<AudioFrame>>) -> Self {
        Mixer {
            own_id,
            peers: HashMap::new(),
            resampler: Resampler::new(SAMPLE_RATE, SAMPLE_RATE),
            pending: VecDeque::new(),
            events,
            settings,
            render,
            monitor_playing: false,
        }
    }

    fn set_output_rate(&mut self, rate: u32) {
        self.resampler = Resampler::new(SAMPLE_RATE, rate);
    }

    fn push(&mut self, sender: SessionId, seq: u32, opus: Vec<u8>) {
        let peer = match self.peers.entry(sender) {
            std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
            std::collections::hash_map::Entry::Vacant(e) => {
                let Ok(decoder) = opus::Decoder::new(SAMPLE_RATE, opus::Channels::Mono) else { return };
                e.insert(Peer { decoder, jitter: JitterBuffer::default(), speaking: false, last_heard: Instant::now() })
            }
        };
        peer.last_heard = Instant::now();
        peer.jitter.push(seq, opus);
    }

    fn fill(&mut self, out: &mut [f32]) {
        while self.pending.len() < out.len() {
            let frame = self.mix_frame();
            self.resampler.process(&frame, &mut self.pending);
        }
        let n = out.len();
        for (o, s) in out.iter_mut().zip(self.pending.drain(..n)) {
            *o = s;
        }
    }

    fn report(&self, session_id: SessionId, speaking: bool) {
        if session_id != self.own_id {
            let _ = self.events.send(EngineEvent::Speaking { session_id, speaking });
        }
    }

    fn mix_frame(&mut self) -> [f32; FRAME_SAMPLES] {
        let mut mix = [0f32; FRAME_SAMPLES];
        let mut voice = [0f32; FRAME_SAMPLES];
        let volumes = self.settings.user_volumes.lock().unwrap().clone();
        let mut changed = Vec::new();
        self.peers.retain(|&id, peer| {
            let decoded = match peer.jitter.pop() {
                Playout::Packet(p) => peer.decoder.decode_float(&p, &mut voice, false),
                Playout::Fec(p) => peer.decoder.decode_float(&p, &mut voice, true),
                Playout::Conceal => peer.decoder.decode_float(&[], &mut voice, false),
                Playout::Idle => Ok(0),
            };
            let active = matches!(decoded, Ok(n) if n > 0);
            if active {
                let gain = volumes.get(&id).copied().unwrap_or(1.0);
                let starting = !peer.speaking;
                mix.iter_mut().zip(&voice).enumerate().for_each(|(i, (m, v))| {
                    let fade = if starting && i < FADE_IN { i as f32 / FADE_IN as f32 } else { 1.0 };
                    *m += v * gain * fade;
                });
            }
            if active != peer.speaking {
                peer.speaking = active;
                changed.push((id, active));
            }
            peer.last_heard.elapsed() < PEER_TIMEOUT
        });
        let gain = self.settings.playback_gain();
        mix.iter_mut().for_each(|m| *m = soft_limit(*m * gain));
        if let Some(render) = &self.render {
            // The mic test's own voice stays out of this, or it would cancel itself.
            let _ = render.try_send(mix);
        }
        if self.settings.monitor.load(Ordering::Relaxed) {
            let mut q = self.settings.monitor_queue.lock().unwrap();
            if q.len() >= MONITOR_START {
                self.monitor_playing = true;
            }
            if self.monitor_playing {
                let n = q.len().min(FRAME_SAMPLES);
                mix.iter_mut().zip(q.drain(..n)).for_each(|(m, s)| *m += s * gain);
                if q.is_empty() {
                    self.monitor_playing = false;
                }
            }
        } else {
            self.monitor_playing = false;
        }
        for (id, speaking) in changed {
            self.report(id, speaking);
        }
        mix
    }
}

/// Leaves normal levels alone and bends peaks smoothly under full scale, so
/// several people talking at once, or a boosted volume, never crackle.
fn soft_limit(x: f32) -> f32 {
    const KNEE: f32 = 0.8;
    let a = x.abs();
    if a <= KNEE {
        x
    } else {
        let over = (a - KNEE) / (1.0 - KNEE);
        x.signum() * (KNEE + (1.0 - KNEE) * over.tanh())
    }
}

impl Drop for Mixer {
    fn drop(&mut self) {
        // Don't leave speakers lit in the UI when the audio restarts.
        for (&id, peer) in &self.peers {
            if peer.speaking {
                self.report(id, false);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::level_db;

    fn test_mixer(own_id: SessionId) -> (Mixer, Receiver<EngineEvent>, Arc<AudioSettings>) {
        let settings = Arc::new(AudioSettings::default());
        let (tx, rx) = mpsc::channel();
        (Mixer::new(own_id, tx, settings.clone(), None), rx, settings)
    }

    fn sine_packets(count: u32) -> Vec<Vec<u8>> {
        let mut enc = opus::Encoder::new(SAMPLE_RATE, opus::Channels::Mono, opus::Application::Voip).unwrap();
        enc.set_inband_fec(true).unwrap();
        enc.set_packet_loss_perc(10).unwrap();
        let mut buf = [0u8; 1275];
        (0..count)
            .map(|f| {
                let pcm: Vec<f32> = (0..FRAME_SAMPLES)
                    .map(|i| {
                        let t = (f as usize * FRAME_SAMPLES + i) as f32 / SAMPLE_RATE as f32;
                        0.5 * (2.0 * std::f32::consts::PI * 440.0 * t).sin()
                    })
                    .collect();
                let n = enc.encode_float(&pcm, &mut buf).unwrap();
                buf[..n].to_vec()
            })
            .collect()
    }

    /// Feeds packets in real time, one per output frame, skipping `lost`.
    fn play(mixer: &mut Mixer, sender: SessionId, frames: u32, lost: &[u32]) -> Vec<f32> {
        let mut out = vec![0f32; FRAME_SAMPLES * frames as usize];
        for (seq, (p, frame)) in sine_packets(frames).into_iter().zip(out.chunks_mut(FRAME_SAMPLES)).enumerate() {
            if !lost.contains(&(seq as u32)) {
                mixer.push(sender, seq as u32, p);
            }
            mixer.fill(frame);
        }
        out
    }

    #[test]
    fn mixer_plays_remote_voice_through_packet_loss() {
        let (mut mixer, rx, _) = test_mixer(1);
        let out = play(&mut mixer, 42, 20, &[7]);
        // Skip the codec's startup frames, then expect sustained signal, including frame 7 recovered by FEC.
        let level = level_db(&out[FRAME_SAMPLES * 3..]);
        assert!(level > -15.0, "remote voice too quiet: {level} dB");

        let events: Vec<_> = rx.try_iter().collect();
        assert!(matches!(events.first(), Some(EngineEvent::Speaking { session_id: 42, speaking: true })));

        // Once packets stop, the speaker goes quiet and is reported as such.
        let mut tail = vec![0f32; FRAME_SAMPLES * 10];
        mixer.fill(&mut tail);
        assert!(rx.try_iter().any(|e| matches!(e, EngineEvent::Speaking { session_id: 42, speaking: false })));
    }

    #[test]
    fn user_volume_scales_and_mutes() {
        let level_at = |volume: Option<f32>| {
            let (mut mixer, _rx, settings) = test_mixer(1);
            if let Some(v) = volume {
                settings.set_user_volume(42, v);
            }
            level_db(&play(&mut mixer, 42, 20, &[])[FRAME_SAMPLES * 3..])
        };
        let (full, half) = (level_at(None), level_at(Some(0.5)));
        assert!((full - half - 6.0).abs() < 1.0, "half volume should be ~6 dB quieter: {full} vs {half}");
        assert_eq!(level_at(Some(0.0)), -100.0);
    }

    #[test]
    fn loopback_audio_plays_without_speaking_events() {
        let (mut mixer, rx, _) = test_mixer(7);
        let out = play(&mut mixer, 7, 20, &[]);
        assert!(level_db(&out[FRAME_SAMPLES * 3..]) > -15.0);
        drop(mixer);
        assert_eq!(rx.try_iter().count(), 0);
    }

    /// Opens the real audio devices: `cargo test -p strom-voice -- --ignored mesh_engines`.
    #[test]
    #[ignore]
    fn two_mesh_engines_connect_on_this_computer() {
        let key = [9u8; 32];
        let devices = DeviceChoice::default();
        let (a, a_events) = VoiceEngine::start_mesh(1, key, &devices, Default::default()).unwrap();
        let (b, b_events) = VoiceEngine::start_mesh(2, key, &devices, Default::default()).unwrap();
        a.settings().set_muted(true);
        b.settings().set_muted(true);
        a.set_peer(b.endpoint().unwrap());
        b.set_peer(a.endpoint().unwrap());
        let connected = |rx: &Receiver<EngineEvent>| {
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if let Ok(EngineEvent::Latency { .. }) = rx.recv_timeout(Duration::from_millis(100)) {
                    return true;
                }
            }
            false
        };
        assert!(connected(&a_events), "engine 1 never heard engine 2");
        assert!(connected(&b_events), "engine 2 never heard engine 1");

        // Someone with the wrong key is ignored.
        let (c, c_events) = VoiceEngine::start_mesh(3, [1u8; 32], &devices, Default::default()).unwrap();
        c.settings().set_muted(true);
        c.set_peer(a.endpoint().unwrap());
        a.set_peer(c.endpoint().unwrap());
        assert!(!connected(&c_events));
    }

    #[test]
    fn mic_test_in_voice_plays_smoothly_despite_uneven_timing() {
        let (mut mixer, _rx, settings) = test_mixer(1);
        settings.set_monitor(true);
        let tone: Vec<f32> = (0..FRAME_SAMPLES).map(|i| 0.3 * (i as f32 * 0.1).sin()).collect();
        let mut out = [0f32; FRAME_SAMPLES];
        let mut silent_after_start = 0;
        let mut started = false;
        // The microphone delivers in uneven bursts: 0, 2, 1, 0, 2, 1… frames per output frame.
        for i in 0..60 {
            for _ in 0..[0, 2, 1][i % 3] {
                settings.monitor_queue.lock().unwrap().extend(&tone);
            }
            mixer.fill(&mut out);
            let loud = level_db(&out) > -30.0;
            started |= loud;
            if started && !loud {
                silent_after_start += 1;
            }
        }
        assert!(started, "the mic test never played");
        assert_eq!(silent_after_start, 0, "the mic test dropped out");
    }

    #[test]
    fn restart_clears_speaking_indicators() {
        let (mut mixer, rx, _) = test_mixer(1);
        play(&mut mixer, 42, 5, &[]);
        rx.try_iter().for_each(drop);
        drop(mixer);
        assert!(matches!(rx.try_recv(), Ok(EngineEvent::Speaking { session_id: 42, speaking: false })));
    }
}

#[cfg(test)]
mod live_mic {
    use super::*;

    /// Opens the real microphone for two seconds: `cargo test -p strom-voice -- --ignored live_mic --nocapture`.
    #[test]
    #[ignore]
    fn live_mic_delivers_levels() {
        let settings = Arc::new(AudioSettings::default());
        let (test, events) = MicTest::start(&DeviceChoice::default(), settings).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut levels = Vec::new();
        while Instant::now() < deadline {
            match events.recv_timeout(Duration::from_millis(100)) {
                Ok(EngineEvent::InputLevel { db, voice }) => levels.push((db, voice)),
                Ok(other) => println!("event: {other:?}"),
                Err(_) => {}
            }
        }
        drop(test);
        let loudest = levels.iter().map(|l| l.0).fold(-200.0f32, f32::max);
        println!("{} level reports, loudest {loudest:.1} dB, gate opened {} times", levels.len(), levels.iter().filter(|l| l.1).count());
        assert!(levels.len() > 40, "the microphone delivered almost nothing");
    }
}

/// End-to-end checks with the real audio devices, two engines on this computer.
/// `cargo test -p strom-voice --lib -- --ignored live_audio --test-threads=1 --nocapture`
#[cfg(test)]
mod live_audio {
    use super::*;
    use crate::settings::TransmitMode;

    /// Settings that always send: manual sensitivity below silence.
    fn always_talking() -> Arc<AudioSettings> {
        let s = Arc::new(AudioSettings::default());
        s.set_auto_sensitivity(false);
        s.set_vad_threshold(-120.0);
        s
    }

    fn listener() -> Arc<AudioSettings> {
        let s = Arc::new(AudioSettings::default());
        s.set_muted(true);
        s
    }

    /// Waits for `id` to be reported as speaking (or not) on `rx`.
    fn hears(rx: &Receiver<EngineEvent>, id: SessionId, speaking: bool, within: Duration) -> bool {
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            if let Ok(EngineEvent::Speaking { session_id, speaking: s }) = rx.recv_timeout(Duration::from_millis(50)) {
                if session_id == id && s == speaking {
                    return true;
                }
            }
        }
        false
    }

    fn drain(rx: &Receiver<EngineEvent>) {
        while rx.try_recv().is_ok() {}
    }

    /// Everything a speaker can do, heard by a listener: mute, deafen, push to talk with
    /// release delay, device restarts and the mic test in voice.
    fn exercise(a: &mut VoiceEngine, a_set: &AudioSettings, speaker: SessionId, b_events: &Receiver<EngineEvent>, label: &str) {
        let s = Duration::from_secs(4);
        assert!(hears(b_events, speaker, true, s), "{label}: the listener never heard the speaker");
        println!("{label}: listener hears the speaker");

        a_set.set_muted(true);
        assert!(hears(b_events, speaker, false, s), "{label}: still heard while muted");
        a_set.set_muted(false);
        assert!(hears(b_events, speaker, true, s), "{label}: not heard after unmuting");
        println!("{label}: mute and unmute work");

        a_set.set_deafened(true);
        assert!(hears(b_events, speaker, false, s), "{label}: still heard while deafened");
        a_set.set_deafened(false);
        assert!(hears(b_events, speaker, true, s), "{label}: not heard after undeafening");
        println!("{label}: deafen and undeafen work");

        a_set.set_mode(TransmitMode::PushToTalk);
        a_set.set_push_to_talk_release_delay(0);
        assert!(hears(b_events, speaker, false, s), "{label}: push to talk sends without the key");
        a_set.set_push_to_talk(true);
        assert!(hears(b_events, speaker, true, s), "{label}: push to talk silent with the key held");
        a_set.set_push_to_talk_release_delay(600);
        drain(b_events);
        a_set.set_push_to_talk(false);
        assert!(!hears(b_events, speaker, false, Duration::from_millis(350)), "{label}: release delay cut the voice early");
        assert!(hears(b_events, speaker, false, s), "{label}: still heard long after letting go");
        a_set.set_mode(TransmitMode::VoiceActivity);
        assert!(hears(b_events, speaker, true, s), "{label}: not heard back in voice activity");
        println!("{label}: push to talk and its release delay work");

        a.set_devices(&DeviceChoice::default()).expect("devices reopen");
        drain(b_events);
        assert!(hears(b_events, speaker, true, s), "{label}: silent after reopening the devices");
        println!("{label}: reopening the audio devices keeps voice going");

        a_set.set_monitor(true);
        std::thread::sleep(Duration::from_millis(300));
        let queued = a_set.monitor_queue.lock().unwrap().len();
        a_set.set_monitor(false);
        // The output keeps draining the queue, so it may be short, but it was fed.
        println!("{label}: mic test in voice queued {queued} samples");
    }

    #[test]
    #[ignore]
    fn live_audio_peer_to_peer() {
        let key = [5u8; 32];
        let devices = DeviceChoice::default();
        let a_set = always_talking();
        let (mut a, _a_events) = VoiceEngine::start_mesh(1, key, &devices, a_set.clone()).unwrap();
        let (b, b_events) = VoiceEngine::start_mesh(2, key, &devices, listener()).unwrap();
        a.set_peer(b.endpoint().unwrap());
        b.set_peer(a.endpoint().unwrap());
        exercise(&mut a, &a_set, 1, &b_events, "peer to peer");
    }

    #[test]
    #[ignore]
    fn live_audio_through_the_relay() {
        use strom_server::{ServerConfig, Storage};
        let rt = tokio::runtime::Runtime::new().unwrap();
        let port = rt.block_on(async {
            let tcp = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let udp = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
            let port = tcp.local_addr().unwrap().port();
            tokio::spawn(strom_server::run(tcp, udp, ServerConfig::default_named("Test"), Storage::memory()));
            port
        });
        let address = format!("127.0.0.1:{port}");
        let (owner_id, _) = crate::Identity::create("speaker", "password1").unwrap();
        let (guest_id, _) = crate::Identity::create("listener", "password1").unwrap();
        let (owner, guest) = rt.block_on(async {
            let mut owner = crate::connect(&address, &owner_id, None, None).await.unwrap();
            owner.control.send(ClientMsg::CreateInvite { max_uses: None, expires_in_hours: None });
            let code = loop {
                if let Some(ServerMsg::InviteCreated { invite }) = owner.events.recv().await {
                    break invite.code;
                }
            };
            let guest = crate::connect(&address, &guest_id, Some(&code), None).await.unwrap();
            (owner, guest)
        });
        let lobby = owner.roster.channels.iter().find(|c| c.kind == ChannelKind::Voice).unwrap().id;
        owner.control.send(ClientMsg::JoinVoice { channel: lobby });
        guest.control.send(ClientMsg::JoinVoice { channel: lobby });

        let devices = DeviceChoice::default();
        let a_set = always_talking();
        let (mut a, _ae) = VoiceEngine::start(owner.udp_addr.unwrap(), owner.roster.me, owner.udp_token, &devices, a_set.clone()).unwrap();
        let (_b, b_events) = VoiceEngine::start(guest.udp_addr.unwrap(), guest.roster.me, guest.udp_token, &devices, listener()).unwrap();
        exercise(&mut a, &a_set, owner.roster.me, &b_events, "relay");
        drop((owner, guest));
    }

    #[test]
    #[ignore]
    fn live_audio_output_test_sound_and_mic_test() {
        play_test_sound(None, 0.05).expect("the test sound plays on the default speakers");
        let s = Arc::new(AudioSettings::default());
        s.set_monitor(true);
        let (test, events) = MicTest::start(&DeviceChoice::default(), s.clone()).unwrap();
        let levels = (0..60)
            .filter_map(|_| events.recv_timeout(Duration::from_millis(100)).ok())
            .filter(|e| matches!(e, EngineEvent::InputLevel { .. }))
            .count();
        assert!(levels > 30, "mic test levels: {levels}");
        drop(test);
        println!("test sound and mic test levels ({levels}) work");
    }
}
