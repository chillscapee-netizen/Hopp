//! Audio settings, shared by the app, the voice engine and the mic test. They
//! are plain atomics, so the realtime threads read them without locking, and
//! a change applies everywhere at once, also to voice that hasn't started yet.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use strom_shared::SessionId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransmitMode {
    VoiceActivity,
    PushToTalk,
}

pub struct AudioSettings {
    pub(crate) muted: AtomicBool,
    pub(crate) deafened: AtomicBool,
    pub(crate) ptt_down: AtomicBool,
    /// Keep sending this long after the push-to-talk key is let go, so the last word isn't cut.
    pub(crate) ptt_release_delay_ms: AtomicU32,
    /// When the key was let go, in milliseconds on [`clock_ms`].
    pub(crate) ptt_released_at: AtomicU64,
    pub(crate) mode: AtomicU8,
    /// Let speech detection decide when we talk, instead of a fixed level.
    pub(crate) auto_sensitivity: AtomicBool,
    pub(crate) vad_threshold_db: AtomicU32,
    pub(crate) noise_suppression: AtomicBool,
    pub(crate) echo_cancellation: AtomicBool,
    pub(crate) auto_gain: AtomicBool,
    /// Microphone volume before any processing, 1.0 = unchanged.
    pub(crate) input_gain: AtomicU32,
    pub(crate) output_volume: AtomicU32,
    pub(crate) user_volumes: Mutex<HashMap<SessionId, f32>>,
    /// The mic test: play our own processed microphone back locally.
    pub(crate) monitor: AtomicBool,
    pub(crate) monitor_queue: Mutex<VecDeque<f32>>,
    /// A soundboard sound on its way to the others (mixed into what we send).
    pub(crate) clip_out: Mutex<VecDeque<f32>>,
    /// The same sound for our own ears.
    pub(crate) clip_local: Mutex<VecDeque<f32>>,
}

impl Default for AudioSettings {
    fn default() -> Self {
        AudioSettings {
            muted: AtomicBool::new(false),
            deafened: AtomicBool::new(false),
            ptt_down: AtomicBool::new(false),
            ptt_release_delay_ms: AtomicU32::new(200),
            ptt_released_at: AtomicU64::new(0),
            mode: AtomicU8::new(TransmitMode::VoiceActivity as u8),
            auto_sensitivity: AtomicBool::new(true),
            vad_threshold_db: AtomicU32::new((-50.0f32).to_bits()),
            noise_suppression: AtomicBool::new(true),
            echo_cancellation: AtomicBool::new(true),
            auto_gain: AtomicBool::new(true),
            input_gain: AtomicU32::new(1.0f32.to_bits()),
            output_volume: AtomicU32::new(1.0f32.to_bits()),
            user_volumes: Mutex::new(HashMap::new()),
            monitor: AtomicBool::new(false),
            monitor_queue: Mutex::new(VecDeque::new()),
            clip_out: Mutex::new(VecDeque::new()),
            clip_local: Mutex::new(VecDeque::new()),
        }
    }
}

impl AudioSettings {
    /// Plays a soundboard sound for everyone in our voice channel or call, and for us.
    /// False when it can't: muted, or it's not a sound we know. One at a time.
    pub fn play_sound(&self, name: &str) -> bool {
        if self.muted() || self.deafened() {
            return false;
        }
        let Some(clip) = crate::soundboard::clip(name) else { return false };
        *self.clip_out.lock().unwrap() = clip.iter().copied().collect();
        *self.clip_local.lock().unwrap() = clip.into_iter().collect();
        true
    }
}

/// Milliseconds since the first call; a steady clock that fits in an atomic.
fn clock_ms() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64 + 1
}

pub(crate) fn load_f32(a: &AtomicU32) -> f32 {
    f32::from_bits(a.load(Ordering::Relaxed))
}

fn store_f32(a: &AtomicU32, v: f32) {
    a.store(v.to_bits(), Ordering::Relaxed);
}

impl AudioSettings {
    pub fn set_muted(&self, on: bool) {
        self.muted.store(on, Ordering::Relaxed);
    }
    pub fn muted(&self) -> bool {
        self.muted.load(Ordering::Relaxed)
    }
    pub fn set_deafened(&self, on: bool) {
        self.deafened.store(on, Ordering::Relaxed);
    }
    pub fn deafened(&self) -> bool {
        self.deafened.load(Ordering::Relaxed)
    }
    pub fn set_push_to_talk(&self, down: bool) {
        if !down && self.ptt_down.load(Ordering::Relaxed) {
            self.ptt_released_at.store(clock_ms(), Ordering::Relaxed);
        }
        self.ptt_down.store(down, Ordering::Relaxed);
    }
    pub fn set_push_to_talk_release_delay(&self, ms: u32) {
        self.ptt_release_delay_ms.store(ms.min(2000), Ordering::Relaxed);
    }
    /// Held down, or let go less than the release delay ago.
    pub(crate) fn push_to_talk_active(&self) -> bool {
        if self.ptt_down.load(Ordering::Relaxed) {
            return true;
        }
        let released = self.ptt_released_at.load(Ordering::Relaxed);
        released != 0 && clock_ms() - released < u64::from(self.ptt_release_delay_ms.load(Ordering::Relaxed))
    }
    pub fn set_mode(&self, mode: TransmitMode) {
        self.mode.store(mode as u8, Ordering::Relaxed);
    }
    pub(crate) fn push_to_talk(&self) -> bool {
        self.mode.load(Ordering::Relaxed) == TransmitMode::PushToTalk as u8
    }
    pub fn set_auto_sensitivity(&self, on: bool) {
        self.auto_sensitivity.store(on, Ordering::Relaxed);
    }
    pub fn set_vad_threshold(&self, db: f32) {
        store_f32(&self.vad_threshold_db, db);
    }
    pub fn set_noise_suppression(&self, on: bool) {
        self.noise_suppression.store(on, Ordering::Relaxed);
    }
    pub fn set_echo_cancellation(&self, on: bool) {
        self.echo_cancellation.store(on, Ordering::Relaxed);
    }
    pub fn set_auto_gain(&self, on: bool) {
        self.auto_gain.store(on, Ordering::Relaxed);
    }
    /// Microphone volume, 1.0 = unchanged.
    pub fn set_input_volume(&self, volume: f32) {
        store_f32(&self.input_gain, volume.clamp(0.0, 4.0));
    }
    /// Master playback volume, 1.0 = unchanged.
    pub fn set_output_volume(&self, volume: f32) {
        store_f32(&self.output_volume, volume.clamp(0.0, 4.0));
    }
    /// Playback volume for one speaker, 1.0 = unchanged, 0.0 = locally muted.
    pub fn set_user_volume(&self, session_id: SessionId, volume: f32) {
        self.user_volumes.lock().unwrap().insert(session_id, volume.max(0.0));
    }
    /// Session ids are only meaningful within one connection; forget them when it ends.
    pub fn clear_user_volumes(&self) {
        self.user_volumes.lock().unwrap().clear();
    }

    /// Plays our own processed microphone back locally. Nothing extra is sent.
    pub fn set_monitor(&self, on: bool) {
        self.monitor.store(on, Ordering::Relaxed);
        if !on {
            self.monitor_queue.lock().unwrap().clear();
        }
    }

    /// The master playback volume, deafened or not.
    pub fn playback_volume(&self) -> f32 {
        load_f32(&self.output_volume)
    }

    /// What we play: the master volume, or silence when deafened.
    pub(crate) fn playback_gain(&self) -> f32 {
        if self.deafened.load(Ordering::Relaxed) {
            0.0
        } else {
            load_f32(&self.output_volume)
        }
    }
}
