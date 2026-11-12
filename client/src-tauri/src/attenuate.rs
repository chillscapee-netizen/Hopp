//! Lowering other apps while people talk (Settings → Voice & audio).
//!
//! Every app playing sound has its own volume in Windows' mixer. While someone else talks,
//! Hopp lowers the others (never its own sound, nor its web view's) and afterwards puts back
//! exactly what each had. A volume the user changed meanwhile is left as they set it. What
//! was lowered is written down until it's restored, so a crash can't leave apps quiet: it's
//! put right the next time Hopp starts.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// Per app (process id): its own volume, and what Hopp turned it down to.
type Lowered = HashMap<u32, (f32, f32)>;

pub struct Attenuator {
    lowered: Mutex<Lowered>,
    file: Option<PathBuf>,
}

impl Attenuator {
    pub fn new(file: Option<PathBuf>) -> Attenuator {
        let me = Attenuator { lowered: Mutex::new(HashMap::new()), file };
        // Left lowered by a Hopp that didn't get to finish: back to how it was.
        if let Some(saved) = me.file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()) {
            if let Ok(list) = serde_json::from_str::<Vec<(u32, f32, f32)>>(&saved) {
                *me.lowered.lock().unwrap() = list.into_iter().map(|(pid, own, set)| (pid, (own, set))).collect();
                me.restore();
            }
        }
        me
    }

    /// While someone talks: every other app at `level` (0..1) of its own volume.
    pub fn lower(&self, level: f32) {
        let level = level.clamp(0.0, 1.0);
        let mut lowered = self.lowered.lock().unwrap();
        for (pid, volume) in sessions() {
            if lowered.contains_key(&pid) {
                continue;
            }
            let Some(own) = volume.get() else { continue };
            let set = own * level;
            if volume.set(set) {
                lowered.insert(pid, (own, set));
            }
        }
        self.write(&lowered);
    }

    /// Nobody talking: every app back to its own volume.
    pub fn restore(&self) {
        let mut lowered = self.lowered.lock().unwrap();
        if lowered.is_empty() {
            return;
        }
        for (pid, volume) in sessions() {
            if let Some(&(own, set)) = lowered.get(&pid) {
                // Changed by hand meanwhile: theirs to keep.
                if volume.get().is_some_and(|now| (now - set).abs() < 0.02) {
                    volume.set(own);
                }
            }
        }
        lowered.clear();
        self.write(&lowered);
    }

    fn write(&self, lowered: &Lowered) {
        let Some(file) = &self.file else { return };
        if lowered.is_empty() {
            let _ = std::fs::remove_file(file);
        } else {
            let list: Vec<(u32, f32, f32)> = lowered.iter().map(|(&pid, &(own, set))| (pid, own, set)).collect();
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

/// The apps playing sound on the default speakers, except Hopp itself (and its web view) and
/// Windows' own system sounds.
#[cfg(windows)]
fn sessions() -> Vec<(u32, Volume)> {
    use windows::core::Interface;
    use windows::Win32::Foundation::S_OK;
    use windows::Win32::Media::Audio::{eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

    let ours = our_processes();
    let mut out = Vec::new();
    unsafe {
        // Already set up on this thread is fine too.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
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
        let a = Attenuator::new(Some(file.clone()));
        assert!(a.lowered.lock().unwrap().is_empty());
        assert!(!file.exists());
    }

    /// Reads the mixer without changing anything: `cargo test -- --ignored mixer --nocapture`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn the_mixer_can_be_read() {
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
