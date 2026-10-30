//! The microphone path, shared by voice and the mic test:
//!
//! resample to 48 kHz -> input volume -> high-pass filter + echo cancellation
//! (WebRTC AEC3) -> noise suppression (RNNoise) -> automatic gain (WebRTC AGC2)
//! -> level and speech detection.
//!
//! RNNoise always runs, even with noise suppression off, because its speech
//! probability drives automatic input sensitivity.

use std::collections::VecDeque;
use std::sync::atomic::Ordering;
use std::sync::mpsc::Receiver;

use nnnoiseless::DenoiseState;
use sonora::config::{EchoCanceller, GainController2, HighPassFilter, MaxProcessingRate, Pipeline};
use sonora::{AudioProcessing, Config, StreamConfig};
use strom_shared::{FRAME_SAMPLES, SAMPLE_RATE};

use crate::dsp::{level_db, Resampler};
use crate::settings::{load_f32, AudioSettings};

pub(crate) type AudioFrame = [f32; FRAME_SAMPLES];

/// Keep sending this long after speech stops, so word endings aren't cut (300 ms).
const HANGOVER_FRAMES: u32 = 30;
/// Automatic sensitivity: smoothed speech probability that opens the gate, and
/// the lower one that keeps it open (like Silero VAD's 0.5 / 0.35 gap).
const SPEECH_START: f32 = 0.5;
const SPEECH_KEEP: f32 = 0.4;
/// Roughly how far the playback lags the capture, for the echo canceller to
/// start from; its own delay estimator refines it.
const ECHO_DELAY_MS: i32 = 40;
/// Automatic sensitivity ignores anything quieter than this, however speech-like.
const AUTO_FLOOR_DB: f32 = -62.0;
/// Manual sensitivity: once open, the gate stays open down to this far below the threshold.
const HYSTERESIS_DB: f32 = 6.0;
/// The level meter is updated every this many frames (about 33 times a second).
const REPORT_EVERY: u32 = 3;

/// Decides, frame by frame, whether we're talking.
pub(crate) struct Gate {
    pub(crate) tuning: Tuning,
    hangover: u32,
    /// RNNoise's per-frame probability jumps around; this is it smoothed.
    speech: f32,
    confirmed: u32,
    /// The microphone's background level before noise suppression, followed slowly.
    floor_db: f32,
    /// Frames since a fast open that speech detection hasn't confirmed yet.
    unconfirmed: Option<u32>,
}

/// How automatic sensitivity decides; tuned on recorded speech (see `gate_bench`).
#[derive(Clone, Copy, Debug)]
pub(crate) struct Tuning {
    /// Weight of the newest frame in the smoothed speech probability.
    pub alpha: f32,
    pub start: f32,
    pub keep: f32,
    pub confirm: u32,
    /// Open at once when the raw level jumps this far above the background and the
    /// frame is at least `fast_prob` speech-like; close again unless speech detection
    /// agrees within `fast_window` frames. 0 turns this off.
    pub fast_jump_db: f32,
    pub fast_prob: f32,
    pub fast_window: u32,
}

impl Default for Gate {
    fn default() -> Self {
        Gate { tuning: Tuning::DEFAULT, hangover: 0, speech: 0.0, confirmed: 0, floor_db: -60.0, unconfirmed: None }
    }
}

impl Tuning {
    /// Measured on recorded speech with and without fan noise and keyboard clicks:
    /// opens 0-50 ms into a sentence (the pre-roll covers that), cuts no speech, and
    /// lets through 0.2% of the quiet in between.
    pub(crate) const DEFAULT: Tuning = Tuning {
        alpha: 0.8,
        start: SPEECH_START,
        keep: SPEECH_KEEP,
        confirm: 1,
        fast_jump_db: 12.0,
        fast_prob: 0.2,
        fast_window: 15,
    };
}

impl Gate {
    #[cfg(test)]
    pub(crate) fn update(&mut self, db: f32, speech: f32, auto: bool, threshold_db: f32) -> bool {
        self.update_with_raw(db, db, speech, auto, threshold_db)
    }

    /// `raw_db` is the level before noise suppression, used to catch the start of speech fast.
    pub(crate) fn update_with_raw(&mut self, db: f32, raw_db: f32, speech: f32, auto: bool, threshold_db: f32) -> bool {
        let t = self.tuning;
        self.speech = (1.0 - t.alpha) * self.speech + t.alpha * speech;
        // The background follows quiet moments quickly and loud ones slowly.
        let rate = if raw_db < self.floor_db { 0.2 } else { 0.002 };
        self.floor_db += (raw_db - self.floor_db) * rate;
        let (start, keep) = if auto {
            let loud_enough = db > AUTO_FLOOR_DB;
            self.confirmed = if self.speech >= t.start && loud_enough { self.confirmed + 1 } else { 0 };
            let confirmed = self.confirmed >= t.confirm;
            let fast = t.fast_jump_db > 0.0
                && self.hangover == 0
                && raw_db > self.floor_db + t.fast_jump_db
                && speech >= t.fast_prob
                && loud_enough;
            if fast {
                self.unconfirmed = Some(0);
            }
            if confirmed {
                self.unconfirmed = None;
            }
            let mut keep = self.speech >= t.keep && loud_enough;
            if let Some(n) = self.unconfirmed.as_mut() {
                *n += 1;
                if *n > t.fast_window {
                    // Never turned into speech: a click or a bump. Close.
                    self.unconfirmed = None;
                    self.hangover = 0;
                    keep = false;
                }
            }
            (confirmed || fast, keep)
        } else {
            (db >= threshold_db, db >= threshold_db - HYSTERESIS_DB)
        };
        if start || (self.hangover > 0 && keep) {
            self.hangover = HANGOVER_FRAMES;
        } else {
            self.hangover = self.hangover.saturating_sub(1);
        }
        self.hangover > 0
    }
}

/// One processed frame.
pub(crate) struct Analysis {
    /// Whether this frame goes out: the voice-activity gate is open, or in
    /// push-to-talk mode, the key is held. Mute is applied by the caller.
    pub send: bool,
    /// For the level meter, every few frames: the loudest level since the last report, and `send`.
    pub report: Option<(f32, bool)>,
}

pub(crate) struct Processor {
    resampler: Resampler,
    pending: VecDeque<f32>,
    /// High-pass filter and echo cancellation, before noise suppression.
    pre: AudioProcessing,
    echo_cancelling: bool,
    /// Automatic gain, after noise suppression, so it doesn't lift the noise.
    agc: AudioProcessing,
    denoiser: Box<DenoiseState<'static>>,
    /// What we play, for the echo canceller to remove from the microphone.
    render: Option<Receiver<AudioFrame>>,
    pub(crate) gate: Gate,
    frame: AudioFrame,
    work: AudioFrame,
    clean: AudioFrame,
    frames: u32,
    peak_db: f32,
    peak_voice: bool,
}

fn stream() -> StreamConfig {
    StreamConfig::new(SAMPLE_RATE, 1)
}

fn pre_config(echo_cancellation: bool) -> Config {
    Config {
        // Full band: our audio is 48 kHz all the way through.
        pipeline: Pipeline { maximum_internal_processing_rate: MaxProcessingRate::Rate48kHz, ..Default::default() },
        high_pass_filter: Some(HighPassFilter::default()),
        echo_canceller: echo_cancellation.then(EchoCanceller::default),
        ..Default::default()
    }
}

impl Processor {
    pub(crate) fn new(input_rate: u32, render: Option<Receiver<AudioFrame>>) -> Self {
        let pre = AudioProcessing::builder()
            .config(pre_config(true))
            .capture_config(stream())
            .render_config(stream())
            .build();
        let agc = AudioProcessing::builder()
            .config(Config {
                gain_controller2: Some(GainController2 { adaptive_digital: Some(Default::default()), ..Default::default() }),
                ..Default::default()
            })
            .capture_config(stream())
            .render_config(stream())
            .build();
        Processor {
            resampler: Resampler::new(input_rate, SAMPLE_RATE),
            pending: VecDeque::new(),
            pre,
            echo_cancelling: true,
            agc,
            denoiser: DenoiseState::new(),
            render,
            gate: Gate::default(),
            frame: [0.0; FRAME_SAMPLES],
            work: [0.0; FRAME_SAMPLES],
            clean: [0.0; FRAME_SAMPLES],
            frames: 0,
            peak_db: -100.0,
            peak_voice: false,
        }
    }

    /// Feeds one captured chunk; `on_frame` gets every finished 10 ms frame.
    pub(crate) fn push(
        &mut self,
        chunk: &[f32],
        s: &AudioSettings,
        mut on_frame: impl FnMut(&AudioFrame, Analysis) -> anyhow::Result<()>,
    ) -> anyhow::Result<()> {
        self.resampler.process(chunk, &mut self.pending);
        while self.pending.len() >= FRAME_SAMPLES {
            let analysis = self.process_frame(s);
            on_frame(&self.clean, analysis)?;
        }
        Ok(())
    }

    fn process_frame(&mut self, s: &AudioSettings) -> Analysis {
        let echo = s.echo_cancellation.load(Ordering::Relaxed);
        if echo != self.echo_cancelling {
            self.pre.apply_config(pre_config(echo));
            self.echo_cancelling = echo;
        }
        // Tell the echo canceller what has been played since the last frame.
        if let Some(render) = &self.render {
            for far in render.try_iter() {
                if echo {
                    let _ = self.pre.process_render_f32(&[&far], &mut [&mut self.work]);
                }
            }
        }

        let gain = load_f32(&s.input_gain);
        for (dst, src) in self.frame.iter_mut().zip(self.pending.drain(..FRAME_SAMPLES)) {
            *dst = (src * gain).clamp(-1.0, 1.0);
        }
        if echo {
            let _ = self.pre.set_stream_delay_ms(ECHO_DELAY_MS);
        }
        if self.pre.process_capture_f32(&[&self.frame], &mut [&mut self.work]).is_ok() {
            self.frame = self.work;
        }

        let raw_db = level_db(&self.frame);
        // RNNoise works on 16-bit-scaled floats, and tells us how likely this frame is speech.
        for (w, f) in self.work.iter_mut().zip(&self.frame) {
            *w = f * 32768.0;
        }
        let mut denoised = [0.0; FRAME_SAMPLES];
        let speech = self.denoiser.process_frame(&mut denoised, &self.work);
        if s.noise_suppression.load(Ordering::Relaxed) {
            for (c, d) in self.clean.iter_mut().zip(&denoised) {
                *c = d / 32768.0;
            }
        } else {
            self.clean = self.frame;
        }

        if s.auto_gain.load(Ordering::Relaxed) && self.agc.process_capture_f32(&[&self.clean], &mut [&mut self.work]).is_ok() {
            self.clean = self.work;
        }

        let db = level_db(&self.clean);
        let auto = s.auto_sensitivity.load(Ordering::Relaxed);
        let gate_open = self.gate.update_with_raw(db, raw_db, speech, auto, load_f32(&s.vad_threshold_db));
        let send = if s.push_to_talk() { s.push_to_talk_active() } else { gate_open };

        self.peak_db = self.peak_db.max(db);
        self.peak_voice |= send;
        self.frames += 1;
        let report = (self.frames % REPORT_EVERY == 0).then(|| {
            let r = (self.peak_db, self.peak_voice);
            self.peak_db = -100.0;
            self.peak_voice = false;
            r
        });
        Analysis { send, report }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manual_gate_holds_through_short_dips_and_closes_after_the_hangover() {
        let mut gate = Gate::default();
        assert!(!gate.update(-60.0, 0.0, false, -50.0));
        assert!(gate.update(-40.0, 0.0, false, -50.0));
        // A dip just under the threshold doesn't close it.
        for _ in 0..100 {
            assert!(gate.update(-54.0, 0.0, false, -50.0));
        }
        // Real silence closes it after the hangover.
        let open_frames = (0..100).take_while(|_| gate.update(-80.0, 0.0, false, -50.0)).count();
        assert_eq!(open_frames as u32, HANGOVER_FRAMES - 1);
    }

    #[test]
    fn automatic_gate_follows_speech_not_loudness() {
        let mut gate = Gate::default();
        // A steady loud fan isn't speech.
        for _ in 0..50 {
            assert!(!gate.update(-20.0, 0.05, true, -50.0));
        }
        // Quiet speech is, at once.
        let mut speech = Gate::default();
        let frames = (1..=10).find(|_| speech.update(-45.0, 0.9, true, -50.0));
        assert_eq!(frames, Some(1));
        // A click that only sounds a little like speech opens it briefly, then it
        // closes again because speech never follows.
        let mut click = Gate::default();
        for _ in 0..100 {
            click.update(-80.0, 0.0, true, -50.0);
        }
        click.update(-30.0, 0.3, true, -50.0);
        let open_for = (0..100).take_while(|_| click.update(-80.0, 0.0, true, -50.0)).count();
        assert!(open_for <= 16, "a click kept the gate open for {open_for} frames");
        // Near-silence never opens it.
        let mut quiet = Gate::default();
        assert!(!quiet.update(-75.0, 0.95, true, -50.0));
    }

    #[test]
    fn processor_turns_any_rate_into_10ms_frames_and_reports_levels() {
        let s = AudioSettings::default();
        let mut p = Processor::new(44_100, None);
        let tone: Vec<f32> = (0..44_100).map(|i| 0.3 * (i as f32 * 0.05).sin()).collect();
        let (mut frames, mut reports) = (0, 0);
        p.push(&tone, &s, |frame, a| {
            assert_eq!(frame.len(), FRAME_SAMPLES);
            frames += 1;
            reports += a.report.is_some() as u32;
            Ok(())
        })
        .unwrap();
        assert!((99..=100).contains(&frames), "one second makes 100 frames, got {frames}");
        assert_eq!(reports, frames / REPORT_EVERY);
    }

    #[test]
    fn processing_keeps_up_with_real_time() {
        let s = AudioSettings::default();
        let mut p = Processor::new(48_000, None);
        let speechy: Vec<f32> = (0..48_000 * 2).map(|i| 0.2 * (i as f32 * 0.03).sin() * (i as f32 * 0.0007).sin()).collect();
        let started = std::time::Instant::now();
        p.push(&speechy, &s, |_, _| Ok(())).unwrap();
        let took = started.elapsed();
        println!("2 s of audio processed in {took:?}");
        // Leave plenty of room: the encoder and everything else share the thread.
        assert!(took < std::time::Duration::from_millis(1000), "too slow: {took:?}");
    }

    #[test]
    fn push_to_talk_sends_only_while_the_key_is_held() {
        let s = AudioSettings::default();
        s.set_mode(crate::settings::TransmitMode::PushToTalk);
        s.set_push_to_talk_release_delay(0);
        let mut p = Processor::new(48_000, None);
        let loud: Vec<f32> = (0..4_800).map(|i| 0.5 * (i as f32 * 0.05).sin()).collect();
        let mut sent = 0;
        p.push(&loud, &s, |_, a| { sent += a.send as u32; Ok(()) }).unwrap();
        assert_eq!(sent, 0, "nothing goes out before the key is pressed");
        s.set_push_to_talk(true);
        let mut sent = 0;
        p.push(&loud, &s, |_, a| { sent += a.send as u32; Ok(()) }).unwrap();
        assert_eq!(sent, 10, "every frame goes out while it is held");
    }

    #[test]
    fn processing_keeps_the_voice_audible() {
        // Every combination of processing must let a voice-like signal through.
        for (echo, agc, ns) in [(true, true, true), (false, false, false), (true, false, true), (false, true, false)] {
            let s = AudioSettings::default();
            s.set_echo_cancellation(echo);
            s.set_auto_gain(agc);
            s.set_noise_suppression(ns);
            let mut p = Processor::new(48_000, None);
            let voice: Vec<f32> = (0..48_000 * 2)
                .map(|i| {
                    let t = i as f32 / 48_000.0;
                    0.2 * (std::f32::consts::TAU * 180.0 * t).sin() * (1.0 + (std::f32::consts::TAU * 3.0 * t).sin()) * 0.5
                        + 0.1 * (std::f32::consts::TAU * 360.0 * t).sin()
                })
                .collect();
            let mut levels = Vec::new();
            p.push(&voice, &s, |frame, _| {
                levels.push(crate::dsp::level_db(frame));
                Ok(())
            })
            .unwrap();
            let tail = &levels[levels.len() / 2..];
            let loudest = tail.iter().cloned().fold(-200.0f32, f32::max);
            println!("echo={echo} agc={agc} ns={ns}: loudest {loudest:.1} dB");
            if !ns {
                assert!(loudest > -40.0, "processing silenced the signal (echo={echo} agc={agc}): {loudest} dB");
            }
        }
    }
}

/// Measures the voice-activity gate on real speech: a 16-bit mono 48 kHz WAV at
/// `STROM_SPEECH_WAV` (Windows text-to-speech works). Reports how late the gate
/// opens at each sentence, how much speech it cuts, and how often noise opens it.
/// `cargo test -p strom-voice --lib -- --ignored gate_bench --nocapture`
#[cfg(test)]
mod gate_bench {
    use super::*;

    fn read_wav(path: &str) -> Vec<f32> {
        let bytes = std::fs::read(path).expect("wav file");
        // Find the "data" chunk.
        let mut i = 12;
        while i + 8 <= bytes.len() {
            let id = &bytes[i..i + 4];
            let len = u32::from_le_bytes(bytes[i + 4..i + 8].try_into().unwrap()) as usize;
            if id == b"data" {
                return bytes[i + 8..(i + 8 + len).min(bytes.len())]
                    .chunks_exact(2)
                    .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0)
                    .collect();
            }
            i += 8 + len + (len & 1);
        }
        panic!("no data chunk");
    }

    /// Fan hum plus a keyboard click now and then, mixed into the silences and the speech.
    fn add_noise(clean: &[f32]) -> Vec<f32> {
        let mut seed = 0x1234_5678u32;
        let mut rnd = || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed as f32 / u32::MAX as f32 * 2.0 - 1.0
        };
        let mut lowpassed = 0.0;
        clean
            .iter()
            .enumerate()
            .map(|(n, &s)| {
                lowpassed = 0.97 * lowpassed + 0.03 * rnd();
                let fan = lowpassed * 0.02;
                // A click every 0.35 s: a 4 ms decaying burst.
                let in_click = n % 16_800;
                let click = if in_click < 192 { rnd() * 0.25 * (-(in_click as f32) / 40.0).exp() } else { 0.0 };
                s + fan + click
            })
            .collect()
    }

    struct Result {
        onset_delays_ms: Vec<i32>,
        speech_frames: usize,
        cut_frames: usize,
        noise_frames: usize,
        false_frames: usize,
    }

    fn run_tuned(clean: &[f32], input: &[f32], s: &AudioSettings, tuning: Tuning) -> Result {
        let mut p = Processor::new(48_000, None);
        p.gate.tuning = tuning;
        let mut sends = Vec::new();
        p.push(input, s, |_, a| {
            sends.push(a.send);
            Ok(())
        })
        .unwrap();
        // Ground truth from the clean speech: which frames have speech in them.
        let speech: Vec<bool> = clean.chunks(FRAME_SAMPLES).map(|f| crate::dsp::level_db(f) > -45.0).collect();
        let n = sends.len().min(speech.len());
        let mut r = Result { onset_delays_ms: vec![], speech_frames: 0, cut_frames: 0, noise_frames: 0, false_frames: 0 };
        let mut quiet_run = 100;
        for i in 0..n {
            if speech[i] {
                r.speech_frames += 1;
                // Pre-roll sends PREROLL frames before the gate, so a frame is heard if
                // the gate is open within that many frames after it.
                let heard = (i..(i + 7).min(n)).any(|j| sends[j]);
                if !heard {
                    r.cut_frames += 1;
                }
                if quiet_run >= 30 {
                    let opened = (i..n).position(|j| sends[j]).unwrap_or(n - i) as i32;
                    r.onset_delays_ms.push(opened * 10);
                }
                quiet_run = 0;
            } else {
                quiet_run += 1;
                // Silence well away from speech: anything sent there is noise getting through.
                if quiet_run > 40 {
                    r.noise_frames += 1;
                    r.false_frames += sends[i] as usize;
                }
            }
        }
        r
    }

    fn report(label: &str, r: &Result) {
        println!(
            "{label}: gate opens {:?} ms after each sentence starts; {} of {} speech frames cut ({:.1}%); open in {} of {} quiet frames ({:.1}%)",
            r.onset_delays_ms,
            r.cut_frames,
            r.speech_frames,
            100.0 * r.cut_frames as f32 / r.speech_frames.max(1) as f32,
            r.false_frames,
            r.noise_frames,
            100.0 * r.false_frames as f32 / r.noise_frames.max(1) as f32
        );
    }

    #[test]
    #[ignore]
    fn gate_bench() {
        let Ok(path) = std::env::var("STROM_SPEECH_WAV") else {
            eprintln!("set STROM_SPEECH_WAV");
            return;
        };
        let clean = read_wav(&path);
        let noisy = add_noise(&clean);
        let s = AudioSettings::default();
        let base = Tuning::DEFAULT;
        let candidates = [
            ("default", base),
            ("old", Tuning { alpha: 0.5, start: 0.6, confirm: 2, fast_jump_db: 0.0, ..base }),
            ("alpha .8 start .5 confirm 1", Tuning { alpha: 0.8, start: 0.5, confirm: 1, ..base }),
            ("alpha .8 start .6 confirm 1", Tuning { alpha: 0.8, start: 0.6, confirm: 1, ..base }),
            ("fast 12 dB / .2", Tuning { fast_jump_db: 12.0, fast_prob: 0.2, ..base }),
            ("fast 15 dB / .3", Tuning { fast_jump_db: 15.0, fast_prob: 0.3, ..base }),
            ("fast 10 dB / .1", Tuning { fast_jump_db: 10.0, fast_prob: 0.1, ..base }),
            ("fast 15 dB / .3 + alpha .8 confirm 1", Tuning { fast_jump_db: 15.0, fast_prob: 0.3, alpha: 0.8, confirm: 1, ..base }),
        ];
        for (label, tuning) in candidates {
            for (room, input) in [("quiet", &clean), ("fan+keys", &noisy)] {
                report(&format!("{label} [{room}]"), &run_tuned(&clean, input, &s, tuning));
            }
        }
    }
}
