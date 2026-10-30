//! Keeps the connection to your account in Ström Cloud while you're logged in:
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
        None => Err("Not connected to Ström Cloud right now. Trying again…".into()),
    }
}

/// Encrypts text so only this Ström ID can read it (for the synced account data).
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

/** A Windows notification (for a message that arrives while Ström isn't in front). */
#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}
