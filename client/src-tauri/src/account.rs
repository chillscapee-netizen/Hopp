//! Keeps the connection to your account in Hopp Cloud while you're logged in:
//! profile, username, synced data, friends and presence. It reconnects by itself
//! with growing pauses, and the page gets every message as an `account` event.

use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use strom_voice::{AccountLink, Identity};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{AppState, CmdResult};

/// Message types the page may send to the account.
const ALLOWED: &[&str] = &[
    "set_profile",
    "check_username",
    "claim_username",
    "set_status",
    "set_activity",
    "set_privacy",
    "set_sync",
    "friend_request",
    "friend_accept",
    "friend_decline",
    "friend_remove",
    "block",
    "unblock",
    "dm_send",
    "dm_history",
    "dm_read",
    "channel_read",
    "call",
    "group_create",
    "group_update",
    "group_leave",
    "group_send",
];

#[derive(Default)]
pub struct Account {
    link: Mutex<Option<AccountLink>>,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl Account {
    pub fn stop(&self) {
        if let Some(task) = self.task.lock().unwrap().take() {
            task.abort();
        }
        *self.link.lock().unwrap() = None;
    }
}

/// Connects (or reconnects) the logged-in account to `cloud` (its `wss://` URL).
#[tauri::command]
pub fn start_account(app: AppHandle, state: State<'_, AppState>, account: State<'_, Account>, cloud: String) -> CmdResult {
    let identity = state.identity.lock().unwrap().clone().ok_or("You are not logged in.")?;
    // For development: point the account at a local Worker (`npx wrangler dev`).
    let cloud = std::env::var("STROM_ACCOUNT_URL").unwrap_or(cloud);
    account.stop();
    let handle = app.clone();
    let task = tauri::async_runtime::spawn(async move { run(handle, identity, cloud).await });
    *account.task.lock().unwrap() = Some(task);
    Ok(())
}

async fn run(app: AppHandle, identity: Identity, cloud: String) {
    let mut pause = 1;
    loop {
        match strom_voice::connect_account(&cloud, &identity).await {
            Ok((link, welcome, mut events)) => {
                pause = 1;
                *app.state::<Account>().link.lock().unwrap() = Some(link);
                let _ = app.emit("account-state", json!({ "connected": true }));
                let _ = app.emit("account", welcome);
                while let Some(msg) = events.recv().await {
                    let _ = app.emit("account", msg);
                }
                *app.state::<Account>().link.lock().unwrap() = None;
                let _ = app.emit("account-state", json!({ "connected": false }));
            }
            Err(e) => {
                tracing::info!("account connection failed: {e:#}");
                let _ = app.emit("account-state", json!({ "connected": false, "error": e.to_string() }));
            }
        }
        tokio::time::sleep(Duration::from_secs(pause)).await;
        pause = (pause * 2).min(30);
    }
}

#[tauri::command]
pub fn account_send(account: State<'_, Account>, msg: Value) -> CmdResult {
    let kind = msg["type"].as_str().unwrap_or_default();
    if !ALLOWED.contains(&kind) {
        return Err(format!("unknown account message {kind:?}"));
    }
    match account.link.lock().unwrap().as_ref() {
        Some(link) => {
            link.send(msg);
            Ok(())
        }
        None => Err("Not connected to Hopp Cloud right now. Trying again…".into()),
    }
}

/// Encrypts text so only this Hopp ID can read it (for the synced account data).
#[tauri::command]
pub fn seal_private(state: State<'_, AppState>, text: String) -> CmdResult<String> {
    let identity = state.identity.lock().unwrap().clone().ok_or("You are not logged in.")?;
    Ok(identity.seal_private(text.as_bytes()))
}

#[tauri::command]
pub fn open_private(state: State<'_, AppState>, sealed: String) -> CmdResult<String> {
    let identity = state.identity.lock().unwrap().clone().ok_or("You are not logged in.")?;
    let bytes = identity.open_private(&sealed).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

/** Encrypts a direct message so only we and `peer` can read it. */
#[tauri::command]
pub fn dm_seal(state: State<'_, AppState>, peer: String, text: String) -> CmdResult<String> {
    let identity = state.identity.lock().unwrap().clone().ok_or("You are not logged in.")?;
    identity.seal_for(&peer, text.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn dm_open(state: State<'_, AppState>, peer: String, sealed: String) -> CmdResult<String> {
    let identity = state.identity.lock().unwrap().clone().ok_or("You are not logged in.")?;
    let bytes = identity.open_from(&peer, &sealed).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

/// A desktop notification for something that happens while Hopp isn't in front:
/// the person's picture (`image`, PNG bytes) and name, the text, and Hopp with its
/// bunny on top. Clicking it brings Hopp up and tells the page `action`.
#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String, image: Option<Vec<u8>>, action: Option<String>) {
    #[cfg(windows)]
    {
        if let Err(e) = toast::show(&app, &title, &body, image.as_deref(), action) {
            tracing::warn!("couldn't show a notification: {e}");
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (image, action);
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

#[cfg(windows)]
mod toast {
    use std::path::Path;
    use std::sync::OnceLock;

    use tauri::{AppHandle, Emitter, Manager};
    use tauri_winrt_notification::{IconCrop, Toast};
    use windows::core::HSTRING;
    use windows::Win32::System::Registry::{RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};

    pub fn show(app: &AppHandle, title: &str, body: &str, image: Option<&[u8]>, action: Option<String>) -> Result<(), String> {
        let id = app.config().identifier.clone();
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("notify");
        let handle = app.clone();
        show_in(&id, &dir, title, body, image, move || {
            crate::shell::show_main(&handle);
            if let Some(action) = &action {
                let _ = handle.emit("notification-click", action.clone());
            }
        })
    }

    /// Registers Hopp's name and bunny for its notifications (once per run), so
    /// Windows shows them as Hopp rather than as an unknown app.
    fn register(id: &str, dir: &Path) -> Result<(), String> {
        static REGISTERED: OnceLock<Result<(), String>> = OnceLock::new();
        REGISTERED
            .get_or_init(|| {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
                let icon = dir.join("hopp.png");
                std::fs::write(&icon, include_bytes!("../icons/128x128@2x.png")).map_err(|e| e.to_string())?;
                let key = HSTRING::from(format!(r"Software\Classes\AppUserModelId\{id}"));
                for (name, value) in [("DisplayName", "Hopp".to_string()), ("IconUri", icon.display().to_string())] {
                    let value: Vec<u16> = value.encode_utf16().chain([0]).collect();
                    let status = unsafe {
                        RegSetKeyValueW(
                            HKEY_CURRENT_USER,
                            &key,
                            &HSTRING::from(name),
                            REG_SZ.0,
                            Some(value.as_ptr().cast()),
                            (value.len() * 2) as u32,
                        )
                    };
                    status.ok().map_err(|e| e.to_string())?;
                }
                Ok(())
            })
            .clone()
    }

    pub fn show_in(
        id: &str,
        dir: &Path,
        title: &str,
        body: &str,
        image: Option<&[u8]>,
        on_click: impl Fn() + Send + 'static,
    ) -> Result<(), String> {
        register(id, dir)?;
        let mut toast = Toast::new(id).title(title).text1(body).sound(None);
        if let Some(png) = image.filter(|b| b.starts_with(b"\x89PNG") && b.len() < 1_000_000) {
            // One file per picture; Windows reads it when the notification appears.
            let hash = png.iter().fold(0xcbf29ce484222325u64, |h, &b| (h ^ b as u64).wrapping_mul(0x100000001b3));
            let path = dir.join(format!("{hash:016x}.png"));
            if !path.exists() {
                std::fs::write(&path, png).map_err(|e| e.to_string())?;
            }
            toast = toast.icon(&path, IconCrop::Circular, "");
        }
        toast = toast.on_activated(move |_| {
            on_click();
            Ok(())
        });
        toast.show().map_err(|e| e.to_string())
    }

    #[cfg(test)]
    mod tests {
        /// Shows a real notification; look at the screen. `cargo test -- --ignored toast`
        #[test]
        #[ignore]
        fn toast_looks_right() {
            let dir = std::env::temp_dir().join("hopp-toast-test");
            let png = include_bytes!("../icons/64x64.png");
            super::show_in("se.strom.client", &dir, "Bingu", "Hey, are you joining tonight?", Some(png), || {}).unwrap();
            std::thread::sleep(std::time::Duration::from_secs(6));
        }
    }
}
