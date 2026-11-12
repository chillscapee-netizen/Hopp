//! Push to talk that works while a game (or any other app) has focus.
//!
//! A background thread reads the bound key's state with `GetAsyncKeyState`
//! about 60 times a second. That only observes: the key still reaches the game,
//! nothing is injected, no hook can be silently dropped by Windows, and it works
//! for mouse side buttons too. Only the bound key is ever looked at, except
//! while the user is recording a new one in settings.
//!
//! Keys are stored as Windows virtual-key codes; names are looked up in the
//! current keyboard layout when shown.
//!
//! The same thread watches the keybinds picked for mute and deafen (a key, with Ctrl,
//! Shift or Alt if wanted), the same way: only those keys are looked at.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use strom_voice::AudioSettings;
use tauri::{AppHandle, Emitter};

const POLL: Duration = Duration::from_millis(16);
const IDLE: Duration = Duration::from_millis(150);
const VK_ESCAPE: u32 = 0x1B;
/// How often to check whether the app in front runs as administrator.
const ELEVATION_CHECK: Duration = Duration::from_secs(2);

/// Modifier bits of a keybind.
pub const MOD_CTRL: u8 = 1;
pub const MOD_SHIFT: u8 = 2;
pub const MOD_ALT: u8 = 4;

/// A keybind that works anywhere: `id` is what it does ("mute", "deafen").
#[derive(Clone, Debug, serde::Deserialize)]
pub struct Keybind {
    pub id: String,
    pub key: u32,
    #[serde(default)]
    pub mods: u8,
}

#[derive(Default)]
pub struct Ptt {
    /// The bound virtual-key code; 0 = none.
    key: AtomicU32,
    /// Listening only in push-to-talk mode.
    enabled: AtomicBool,
    recording: AtomicBool,
    /// Keybinds for mute and deafen, watched whatever the voice mode.
    binds: std::sync::Mutex<Vec<Keybind>>,
    /// The next key pressed (with its modifiers) becomes a keybind.
    recording_bind: AtomicBool,
}

impl Ptt {
    pub fn start(app: AppHandle, audio: Arc<AudioSettings>) -> Arc<Ptt> {
        let ptt = Arc::new(Ptt::default());
        let me = ptt.clone();
        std::thread::Builder::new()
            .name("strom-ptt".into())
            .spawn(move || me.run(&app, &audio))
            .expect("thread starts");
        ptt
    }

    pub fn set_key(&self, vk: u32) {
        self.key.store(vk, Ordering::Relaxed);
    }

    pub fn set_enabled(&self, on: bool) {
        self.enabled.store(on, Ordering::Relaxed);
    }

    /// The next key or mouse button pressed is reported as `ptt-recorded`; Esc cancels.
    pub fn record(&self) {
        self.recording.store(true, Ordering::Relaxed);
    }

    pub fn cancel_recording(&self) {
        self.recording.store(false, Ordering::Relaxed);
        self.recording_bind.store(false, Ordering::Relaxed);
    }

    pub fn set_binds(&self, binds: Vec<Keybind>) {
        *self.binds.lock().unwrap() = binds.into_iter().filter(|b| b.key != 0 && bindable(b.key)).collect();
    }

    /// The next key pressed, with Ctrl, Shift or Alt held, is reported as `keybind-recorded`; Esc cancels.
    pub fn record_bind(&self) {
        self.recording_bind.store(true, Ordering::Relaxed);
    }

    fn run(&self, app: &AppHandle, audio: &AudioSettings) {
        let mut down = false;
        let mut held_before: Option<Vec<bool>> = None;
        let mut last_check = std::time::Instant::now();
        let mut warned_about: Option<u32> = None;
        // The app in front last time we looked: it's only examined when it changes.
        let mut seen_front: Option<u32> = None;
        let mut binds_down: Vec<bool> = Vec::new();
        loop {
            if self.recording_bind.load(Ordering::Relaxed) {
                let now = pressed_keys();
                let before = held_before.get_or_insert_with(|| now.clone());
                if let Some(vk) = (1..256).find(|&vk| now[vk] && !before[vk] && bindable(vk as u32)) {
                    self.recording_bind.store(false, Ordering::Relaxed);
                    held_before = None;
                    let vk = vk as u32;
                    let payload = if vk == VK_ESCAPE {
                        serde_json::json!({ "cancelled": true })
                    } else {
                        let mods = held_mods();
                        serde_json::json!({ "key": vk, "mods": mods, "label": bind_label(vk, mods) })
                    };
                    let _ = app.emit("keybind-recorded", payload);
                } else {
                    *before = now;
                }
                std::thread::sleep(POLL);
                continue;
            }
            if self.recording.load(Ordering::Relaxed) {
                // Keys already held when recording started don't count.
                let now = pressed_keys();
                let before = held_before.get_or_insert_with(|| now.clone());
                if let Some(vk) = (1..256).find(|&vk| now[vk] && !before[vk] && recordable(vk as u32)) {
                    self.recording.store(false, Ordering::Relaxed);
                    held_before = None;
                    let vk = vk as u32;
                    let payload = if vk == VK_ESCAPE {
                        serde_json::json!({ "cancelled": true })
                    } else {
                        serde_json::json!({ "key": vk, "label": key_label(vk) })
                    };
                    let _ = app.emit("ptt-recorded", payload);
                } else {
                    *before = now;
                }
                std::thread::sleep(POLL);
                continue;
            }
            held_before = None;

            let key = self.key.load(Ordering::Relaxed);
            let active = self.enabled.load(Ordering::Relaxed) && key != 0;
            let pressed = active && is_down(key);
            // Windows hides keys pressed in an administrator app (often a game) from
            // normal apps; say so instead of failing silently.
            if active && last_check.elapsed() >= ELEVATION_CHECK {
                last_check = std::time::Instant::now();
                let front = foreground_pid();
                if front != seen_front {
                    seen_front = front;
                    let blocker = front.filter(|&pid| runs_elevated(pid));
                    if blocker.is_some() && blocker != warned_about {
                        let _ = app.emit("ptt-blocked", ());
                    }
                    warned_about = blocker;
                }
            }
            if pressed != down {
                down = pressed;
                audio.set_push_to_talk(pressed);
                let _ = app.emit("ptt", pressed);
            }
            // Keybinds fire once when pressed (exactly those modifiers held), not while held.
            let binds = self.binds.lock().unwrap().clone();
            binds_down.resize(binds.len(), false);
            if !binds.is_empty() {
                let mods = held_mods();
                for (i, b) in binds.iter().enumerate() {
                    let now = is_down(b.key) && mods == b.mods;
                    if now && !binds_down[i] {
                        let _ = app.emit("keybind", b.id.clone());
                    }
                    binds_down[i] = now;
                }
            }
            std::thread::sleep(if active || !binds.is_empty() { POLL } else { IDLE });
        }
    }
}

/// Left and right click stay usable while recording; generic modifiers stand for both sides.
fn recordable(vk: u32) -> bool {
    !matches!(vk, 0x01 | 0x02 | 0xA0..=0xA5)
}

#[cfg(windows)]
fn is_down(vk: u32) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    // The high bit says the key is down right now.
    unsafe { GetAsyncKeyState(vk as i32) as u16 & 0x8000 != 0 }
}

#[cfg(not(windows))]
fn is_down(_vk: u32) -> bool {
    false
}

/// The process id of the app in front (not ourselves).
#[cfg(windows)]
fn foreground_pid() -> Option<u32> {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    unsafe {
        let window = GetForegroundWindow();
        if window.is_invalid() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(window, Some(&mut pid));
        (pid != 0 && pid != std::process::id()).then_some(pid)
    }
}

/// Does that app run as administrator while we don't? Asked once per app that comes to the front.
#[cfg(windows)]
fn runs_elevated(pid: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};

    fn elevated(process: HANDLE) -> bool {
        unsafe {
            let mut token = HANDLE::default();
            if OpenProcessToken(process, TOKEN_QUERY, &mut token).is_err() {
                return false;
            }
            let mut info = TOKEN_ELEVATION::default();
            let mut len = 0u32;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                Some(&mut info as *mut _ as *mut _),
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut len,
            )
            .is_ok();
            let _ = CloseHandle(token);
            ok && info.TokenIsElevated != 0
        }
    }

    // Whether Hopp itself runs as administrator never changes while it runs.
    static WE_ARE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    unsafe {
        if *WE_ARE.get_or_init(|| elevated(GetCurrentProcess())) {
            return false;
        }
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return false };
        let result = elevated(process);
        let _ = CloseHandle(process);
        result
    }
}

#[cfg(not(windows))]
fn foreground_pid() -> Option<u32> {
    None
}

#[cfg(not(windows))]
fn runs_elevated(_pid: u32) -> bool {
    false
}

/// Keys a keybind can be made of: anything but plain clicks and the modifiers themselves.
fn bindable(vk: u32) -> bool {
    !matches!(vk, 0x01 | 0x02 | 0x10..=0x12 | 0x5B | 0x5C | 0xA0..=0xA5)
}

/// Ctrl, Shift and Alt held right now.
fn held_mods() -> u8 {
    (if is_down(0x11) { MOD_CTRL } else { 0 }) | (if is_down(0x10) { MOD_SHIFT } else { 0 }) | (if is_down(0x12) { MOD_ALT } else { 0 })
}

/// "Ctrl + Shift + M".
pub fn bind_label(vk: u32, mods: u8) -> String {
    let mut parts: Vec<String> = Vec::new();
    if mods & MOD_CTRL != 0 {
        parts.push("Ctrl".into());
    }
    if mods & MOD_SHIFT != 0 {
        parts.push("Shift".into());
    }
    if mods & MOD_ALT != 0 {
        parts.push("Alt".into());
    }
    parts.push(key_label(vk));
    parts.join(" + ")
}

fn pressed_keys() -> Vec<bool> {
    (0..256).map(|vk| vk > 0 && is_down(vk as u32)).collect()
}

/// A readable name in the user's keyboard layout ("V", "Ö", "Mouse 4", "Caps Lock").
pub fn key_label(vk: u32) -> String {
    match vk {
        0 => return String::new(),
        0x04 => return "Middle mouse".into(),
        0x05 => return "Mouse 4".into(),
        0x06 => return "Mouse 5".into(),
        0x13 => return "Pause".into(),
        0x90 => return "Num Lock".into(),
        _ => {}
    }
    #[cfg(windows)]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyNameTextW, MapVirtualKeyW, MAPVK_VK_TO_VSC_EX};
        let scan = unsafe { MapVirtualKeyW(vk, MAPVK_VK_TO_VSC_EX) };
        if scan != 0 {
            // Bits 16-23: scan code; bit 24: extended key (the E0 prefix).
            let extended = (scan & 0xE000 == 0xE000) as i32;
            let lparam = ((scan as i32 & 0xFF) << 16) | (extended << 24);
            let mut buf = [0u16; 64];
            let len = unsafe { GetKeyNameTextW(lparam, &mut buf) };
            if len > 0 {
                return String::from_utf16_lossy(&buf[..len as usize]);
            }
        }
    }
    format!("Key {vk}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keybinds_are_a_key_with_modifiers() {
        assert!(bindable(0x4D) && bindable(0x05), "letters and mouse buttons");
        assert!(!bindable(0x11) && !bindable(0xA2) && !bindable(0x01), "not modifiers alone or a plain click");
        assert!(bind_label(0x05, MOD_CTRL | MOD_SHIFT).starts_with("Ctrl + Shift + "));
        assert_eq!(bind_label(0x05, 0), "Mouse 4");
    }

    #[test]
    fn keys_get_readable_names() {
        assert_eq!(key_label(0x56), "V");
        assert_eq!(key_label(0x05), "Mouse 4");
        assert_eq!(key_label(0x06), "Mouse 5");
        assert!(!key_label(0x14).is_empty(), "Caps Lock has a name");
        assert_eq!(key_label(0), "");
    }

    #[test]
    fn plain_clicks_and_sided_modifiers_are_not_recorded() {
        assert!(!recordable(0x01));
        assert!(!recordable(0x02));
        assert!(!recordable(0xA0));
        assert!(recordable(0x10));
        assert!(recordable(0x05));
    }
}

#[cfg(all(test, windows))]
mod live_tests {
    use super::*;
    use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY};

    fn key(vk: u16, up: bool) {
        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) }, time: 0, dwExtraInfo: 0 },
            },
        };
        unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) };
    }

    /// Presses F24 (unused on real keyboards): `cargo test -p strom-client -- --ignored live`.
    #[test]
    #[ignore]
    fn live_key_state_is_seen() {
        let idle: Vec<u32> = (1..256u32).filter(|&vk| is_down(vk)).collect();
        println!("down while idle: {idle:?}");
        key(0x87, false);
        std::thread::sleep(Duration::from_millis(50));
        let seen = is_down(0x87);
        key(0x87, true);
        std::thread::sleep(Duration::from_millis(50));
        println!("F24 seen while held: {seen}, after release: {}", is_down(0x87));
        assert!(seen);
    }
}
