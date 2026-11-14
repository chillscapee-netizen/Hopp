//! Hopp installed from the Microsoft Store. Microsoft signs that copy and keeps it up to date,
//! so it never runs its own updater; and starting with Windows goes through the package's
//! startup task, since a packaged app's registry "Run" entry never reaches Windows.

/// The name of the startup task in the Store package's manifest (tools/make-msix.mjs).
#[cfg(windows)]
const STARTUP_TASK: &str = "HoppStartup";

/// Whether this copy of Hopp came from the Microsoft Store (runs inside an app package).
#[cfg(windows)]
pub fn packaged() -> bool {
    use std::sync::OnceLock;
    use windows::Win32::Foundation::APPMODEL_ERROR_NO_PACKAGE;
    use windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
    static PACKAGED: OnceLock<bool> = OnceLock::new();
    *PACKAGED.get_or_init(|| {
        let mut len = 0u32;
        // SAFETY: asking only for the length (no buffer) is how the call is meant to be used first.
        unsafe { GetCurrentPackageFullName(&mut len, None) != APPMODEL_ERROR_NO_PACKAGE }
    })
}

#[cfg(not(windows))]
pub fn packaged() -> bool {
    false
}

#[cfg(windows)]
fn startup_task() -> windows::core::Result<windows::ApplicationModel::StartupTask> {
    use windows::ApplicationModel::StartupTask;
    StartupTask::GetAsync(&windows::core::HSTRING::from(STARTUP_TASK))?.join()
}

/// Whether the Store copy starts with Windows.
#[cfg(windows)]
pub fn startup_enabled() -> bool {
    use windows::ApplicationModel::StartupTaskState;
    startup_task()
        .and_then(|t| t.State())
        .map(|s| s == StartupTaskState::Enabled || s == StartupTaskState::EnabledByPolicy)
        .unwrap_or(false)
}

#[cfg(not(windows))]
pub fn startup_enabled() -> bool {
    false
}

/// Turns starting with Windows on or off for the Store copy. Once someone has turned Hopp off
/// in Windows' own Startup apps list, only they can turn it back on there.
#[cfg(windows)]
pub fn set_startup(on: bool) -> Result<(), String> {
    use windows::ApplicationModel::StartupTaskState;
    let task = startup_task().map_err(|e| format!("Couldn't change that: {e}"))?;
    if !on {
        return task.Disable().map_err(|e| format!("Couldn't change that: {e}"));
    }
    let state = task.RequestEnableAsync().and_then(|op| op.join()).map_err(|e| format!("Couldn't change that: {e}"))?;
    match state {
        StartupTaskState::Enabled | StartupTaskState::EnabledByPolicy => Ok(()),
        StartupTaskState::DisabledByUser => Err("Windows has Hopp turned off under Startup apps. Turn it on there (Settings → Apps → Startup).".into()),
        _ => Err("Windows didn't allow Hopp to start with it.".into()),
    }
}

#[cfg(not(windows))]
pub fn set_startup(_on: bool) -> Result<(), String> {
    Err("Not available here.".into())
}
