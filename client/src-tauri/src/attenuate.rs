//! Lowering other apps while people talk (Settings → Voice & audio).
//!
//! Every app playing sound has its own volume in Windows' mixer. While someone else talks,
//! Hopp turns the others down (never its own sound, nor its web view's), smoothly: down in
//! about 0.15 s, back up in about 0.6 s, like a fader, never in jumps. A thread of its own
//! moves the volumes toward where they should be, so a new "lower" never waits for a
//! "restore" to finish. A volume the user changes meanwhile is theirs and left alone. What's
//! lowered is written down until it's back, so a crash can't leave apps quiet: it's put right
//! the next time Hopp starts.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const TICK: Duration = Duration::from_millis(15);
/// Share of the way covered per tick: down fast (~0.15 s), up gently (~0.6 s).
const DOWN_STEP: f32 = 0.1;
const UP_STEP: f32 = 0.025;
/// How often to look for apps that started playing while lowered.
const RESCAN: Duration = Duration::from_secs(1);

pub struct Attenuator {
    /// Where every other app should be, as a share of its own volume (1 = untouched).
    target: AtomicU32,
    /// Everything is back at its own volume.
    settled: Arc<AtomicBool>,
}

impl Attenuator {
    pub fn new(file: Option<PathBuf>) -> Arc<Attenuator> {
        let me = Arc::new(Attenuator { target: AtomicU32::new(1f32.to_bits()), settled: Arc::new(AtomicBool::new(true)) });
        let worker = me.clone();
        std::thread::Builder::new()
            .name("hopp-attenuate".into())
            .spawn(move || worker.run(file))
            .expect("thread starts");
        me
    }

    /// While someone talks: every other app toward `level` (0..1) of its own volume.
    pub fn lower(&self, level: f32) {
        self.settled.store(false, Ordering::Relaxed);
        self.target.store(level.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
    }

    /// Nobody talking: every app back to its own volume, gently.
    pub fn restore(&self) {
        self.target.store(1f32.to_bits(), Ordering::Relaxed);
    }

    /// Quitting: back to normal before Hopp goes (waits a moment for the fade to finish).
    pub fn restore_now(&self) {
        self.restore();
        let until = Instant::now() + Duration::from_millis(1500);
        while !self.settled.load(Ordering::Relaxed) && Instant::now() < until {
            std::thread::sleep(TICK);
        }
    }

    fn run(&self, file: Option<PathBuf>) {
        com_init();
        let mut apps = Apps { list: HashMap::new(), file };
        apps.recover();
        let mut factor = 1.0f32;
        let mut scanned = Instant::now() - RESCAN;
        loop {
            let target = f32::from_bits(self.target.load(Ordering::Relaxed));
            if factor >= 1.0 && target >= 1.0 {
                if !apps.list.is_empty() {
                    apps.put_back();
                }
                self.settled.store(true, Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(60));
                continue;
            }
            factor = if target < factor { (factor - DOWN_STEP).max(target) } else { (factor + UP_STEP).min(target) };
            // Apps that start playing while it's lowered are taken along too.
            if target < 1.0 && scanned.elapsed() >= RESCAN {
                scanned = Instant::now();
                apps.take_new();
            }
            apps.apply(factor);
            std::thread::sleep(TICK);
        }
    }
}

/// The apps lowered right now: their volume control, their own volume and what Hopp set last.
struct Apps {
    list: HashMap<u32, (Volume, f32, f32)>,
    file: Option<PathBuf>,
}

impl Apps {
    fn take_new(&mut self) {
        let mut changed = false;
        for (pid, volume) in sessions() {
            if self.list.contains_key(&pid) {
                continue;
            }
            if let Some(own) = volume.get() {
                self.list.insert(pid, (volume, own, own));
                changed = true;
            }
        }
        if changed {
            self.write();
        }
    }

    fn apply(&mut self, factor: f32) {
        let before = self.list.len();
        self.list.retain(|_, (volume, own, set)| {
            // Changed by hand meanwhile (or gone): theirs to keep.
            match volume.get() {
                Some(now) if (now - *set).abs() < 0.02 => {
                    let next = *own * factor;
                    if (next - *set).abs() > 0.001 && volume.set(next) {
                        *set = next;
                    }
                    true
                }
                _ => false,
            }
        });
        if self.list.len() != before {
            self.write();
        }
    }

    fn put_back(&mut self) {
        for (volume, own, set) in self.list.values() {
            if volume.get().is_some_and(|now| (now - set).abs() < 0.02) {
                volume.set(*own);
            }
        }
        self.list.clear();
        self.write();
    }

    /// Left lowered by a Hopp that didn't get to finish: back to how it was.
    fn recover(&mut self) {
        let Some(saved) = self.file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()) else { return };
        let Ok(list) = serde_json::from_str::<Vec<(u32, f32, f32)>>(&saved) else { return };
        let left: HashMap<u32, (f32, f32)> = list.into_iter().map(|(pid, own, set)| (pid, (own, set))).collect();
        for (pid, volume) in sessions() {
            if let Some(&(own, set)) = left.get(&pid) {
                if volume.get().is_some_and(|now| (now - set).abs() < 0.05) {
                    volume.set(own);
                }
            }
        }
        self.write();
    }

    fn write(&self) {
        let Some(file) = &self.file else { return };
        if self.list.is_empty() {
            let _ = std::fs::remove_file(file);
        } else {
            let list: Vec<(u32, f32, f32)> = self.list.iter().map(|(&pid, (_, own, set))| (pid, *own, *set)).collect();
            let _ = std::fs::write(file, serde_json::to_string(&list).unwrap_or_default());
        }
    }
}

/// One app's volume in Windows' mixer.
struct Volume(#[cfg(windows)] windows::Win32::Media::Audio::ISimpleAudioVolume);

impl Volume {
    #[cfg(windows)]
    fn get(&self) -> Option<f32> {
        unsafe { self.0.GetMasterVolume().ok() }
    }
    #[cfg(windows)]
    fn set(&self, level: f32) -> bool {
        unsafe { self.0.SetMasterVolume(level.clamp(0.0, 1.0), std::ptr::null()).is_ok() }
    }
    #[cfg(not(windows))]
    fn get(&self) -> Option<f32> {
        None
    }
    #[cfg(not(windows))]
    fn set(&self, _level: f32) -> bool {
        false
    }
}

#[cfg(windows)]
fn com_init() {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

#[cfg(not(windows))]
fn com_init() {}

/// The apps playing sound on the default speakers, except Hopp itself (and its web view) and
/// Windows' own system sounds.
#[cfg(windows)]
fn sessions() -> Vec<(u32, Volume)> {
    use windows::core::Interface;
    use windows::Win32::Foundation::S_OK;
    use windows::Win32::Media::Audio::{eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};

    let ours = our_processes();
    let mut out = Vec::new();
    unsafe {
        let Ok(devices) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else { return out };
        let Ok(speakers) = devices.GetDefaultAudioEndpoint(eRender, eConsole) else { return out };
        let Ok(manager) = speakers.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { return out };
        let Ok(list) = manager.GetSessionEnumerator() else { return out };
        let count = list.GetCount().unwrap_or(0);
        for i in 0..count {
            let Ok(session) = list.GetSession(i) else { continue };
            let Ok(control) = session.cast::<IAudioSessionControl2>() else { continue };
            if control.IsSystemSoundsSession() == S_OK {
                continue;
            }
            let Ok(pid) = control.GetProcessId() else { continue };
            if pid == 0 || ours.contains(&pid) {
                continue;
            }
            if let Ok(volume) = session.cast::<ISimpleAudioVolume>() {
                out.push((pid, Volume(volume)));
            }
        }
    }
    out
}

#[cfg(not(windows))]
fn sessions() -> Vec<(u32, Volume)> {
    Vec::new()
}

/// Hopp and every process it started (the web view plays sounds and voice messages).
#[cfg(windows)]
fn our_processes() -> std::collections::HashSet<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};

    let mut ours = std::collections::HashSet::from([std::process::id()]);
    let mut parents: Vec<(u32, u32)> = Vec::new();
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return ours };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                parents.push((entry.th32ProcessID, entry.th32ParentProcessID));
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    // Children, their children, and so on.
    loop {
        let before = ours.len();
        for &(pid, parent) in &parents {
            if ours.contains(&parent) {
                ours.insert(pid);
            }
        }
        if ours.len() == before {
            break;
        }
    }
    ours
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_list_from_a_crash_is_read_and_cleared() {
        let file = std::env::temp_dir().join(format!("hopp-attenuate-test-{}.json", std::process::id()));
        // A process id nobody has: nothing to put back, and the note is gone afterwards.
        std::fs::write(&file, "[[4294967290, 1.0, 0.3]]").unwrap();
        let _a = Attenuator::new(Some(file.clone()));
        for _ in 0..100 {
            if !file.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!file.exists());
    }

    #[test]
    fn it_settles_back_when_nothing_is_lowered() {
        let a = Attenuator::new(None);
        a.restore_now();
        assert!(a.settled.load(Ordering::Relaxed));
    }

    /// Reads the mixer without changing anything: `cargo test -- --ignored mixer --nocapture`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn the_mixer_can_be_read() {
        com_init();
        for (pid, volume) in sessions() {
            println!("app {pid}: volume {:?}", volume.get());
        }
    }

    #[cfg(windows)]
    #[test]
    fn hopp_counts_itself_among_its_processes() {
        assert!(our_processes().contains(&std::process::id()));
    }
}
