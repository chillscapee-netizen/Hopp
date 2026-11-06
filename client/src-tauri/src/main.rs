#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::net::{SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

mod account;
mod downloads;
mod hello;
mod preview;
mod ptt;
mod shell;

const HELLO_VALID_FOR: Duration = Duration::from_secs(180);
use strom_shared::{ChannelId, ChannelKind, ClientMsg, PeerEndpoint, ServerMsg, SessionId};
use strom_voice::{AudioSettings, Control, DeviceChoice, DeviceList, Identity, MicTest, Roster, Session, StoredIdentity, TransmitMode, VoiceEngine};
use tauri::{AppHandle, Emitter, Manager, State};

struct Connection {
    generation: u64,
    /// The server's address, as the app connects to it.
    address: String,
    /// Kept up to date by the connection's task, also while it waits in the background.
    roster: Arc<Mutex<Roster>>,
    /// The server can send its channels again when we come back (so it can wait in the background).
    resync: bool,
    control: Control,
    task: tauri::async_runtime::JoinHandle<()>,
    /// `None` on cloud servers, which have no UDP voice relay; voice goes peer to peer there.
    udp_addr: Option<SocketAddr>,
    session_id: SessionId,
    udp_token: u64,
    /// Running only while we are in a voice channel, so the microphone is closed otherwise.
    engine: Option<VoiceEngine>,
    /// Cloud servers: how to reach the others in our voice channel, kept even
    /// while the engine is still starting.
    voice_peers: HashMap<SessionId, PeerEndpoint>,
    /// Bumped whenever peer-to-peer voice starts or stops, so a slow start that
    /// was overtaken doesn't install its engine.
    voice_attempt: u64,
}

#[derive(Default)]
pub struct AppState {
    identity_path: OnceLock<PathBuf>,
    pub identity: Mutex<Option<Identity>>,
    conn: Mutex<Option<Connection>>,
    /// Servers we're not looking at, still connected, so switching to them is instant.
    parked: Mutex<HashMap<String, Connection>>,
    generation: Mutex<u64>,
    devices: Mutex<DeviceChoice>,
    /// Shared with the voice engine and the mic test; changes apply at once, in or out of voice.
    audio: Arc<AudioSettings>,
    ptt: OnceLock<Arc<ptt::Ptt>>,
    /// The audio devices, looked up ahead of time so device menus open at once.
    device_list: Mutex<Option<DeviceList>>,
    mic_test: Mutex<Option<MicTest>>,
    /// A call with a friend: its own peer-to-peer voice, apart from any server.
    call: Mutex<Option<Call>>,
    /// When Windows Hello last confirmed the user; unlocks password reset and the phrase briefly.
    hello_verified_at: Mutex<Option<Instant>>,
}

pub type CmdResult<T = ()> = Result<T, String>;

fn with_conn<T>(state: &AppState, f: impl FnOnce(&mut Connection) -> T) -> CmdResult<T> {
    state.conn.lock().unwrap().as_mut().map(f).ok_or_else(|| "not connected".to_string())
}

fn identity_path(state: &AppState) -> CmdResult<PathBuf> {
    state.identity_path.get().cloned().ok_or_else(|| "app data folder unavailable".to_string())
}

fn read_stored(state: &AppState) -> CmdResult<Option<StoredIdentity>> {
    let path = identity_path(state)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map(Some).map_err(|_| "Your account file is damaged.".to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn write_stored(state: &AppState, stored: &StoredIdentity) -> CmdResult {
    let path = identity_path(state)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(stored).map_err(|e| e.to_string())?;
    // Write a new file, then swap it in, so a crash mid-write can't damage the account.
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &path).map_err(|e| e.to_string())
}

/// "Keep me logged in" keeps the key in the OS credential store (Windows
/// Credential Manager), protected by the user's Windows login rather than a file.
const KEYRING_SERVICE: &str = "Strom";

fn keyring_entry(public_key: &str) -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, public_key).ok()
}

fn remember(identity: &Identity, on: bool) {
    let Some(entry) = keyring_entry(&identity.public_key()) else { return };
    if on {
        if let Err(e) = entry.set_password(&identity.secret_hex()) {
            tracing::warn!("could not remember the login: {e}");
        }
    } else {
        let _ = entry.delete_credential();
    }
}

fn remembered_identity(stored: &StoredIdentity) -> Option<Identity> {
    let secret = keyring_entry(&stored.public_key)?.get_password().ok()?;
    let identity = Identity::from_secret(&stored.name, &secret).ok()?;
    (identity.public_key() == stored.public_key).then_some(identity)
}

/// Runs work that is slow on purpose (password hashing) off the UI thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> anyhow::Result<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
}

fn unlock_stored(state: &AppState) -> CmdResult<StoredIdentity> {
    read_stored(state)?.ok_or_else(|| "There is no account on this computer.".to_string())
}

/// Moves the account file aside (never deletes it) and returns where it went.
fn back_up_account(state: &AppState) -> CmdResult<String> {
    let path = identity_path(state)?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let backup = path.with_file_name(format!("identity-backup-{stamp}.json"));
    std::fs::rename(&path, &backup).map_err(|e| e.to_string())?;
    Ok(backup.display().to_string())
}

#[derive(Serialize)]
struct AccountStatus {
    exists: bool,
    name: Option<String>,
    public_key: Option<String>,
    logged_in: bool,
    remembered: bool,
    backed_up: bool,
}

/// Also logs in automatically when "Keep me logged in" was chosen.
#[tauri::command]
fn account_status(state: State<'_, AppState>) -> CmdResult<AccountStatus> {
    let stored = read_stored(&state)?;
    let mut identity = state.identity.lock().unwrap();
    let remembered = stored.as_ref().and_then(remembered_identity);
    if identity.is_none() {
        identity.clone_from(&remembered);
    }
    let stored_backed_up = stored.as_ref().is_some_and(|s| s.backed_up);
    Ok(AccountStatus {
        exists: stored.is_some(),
        public_key: stored.as_ref().map(|s| s.public_key.clone()),
        name: identity.as_ref().map(|i| i.name.clone()).or(stored.map(|s| s.name)),
        logged_in: identity.is_some(),
        remembered: remembered.is_some(),
        backed_up: stored_backed_up,
    })
}

#[derive(Serialize)]
struct Created {
    name: String,
    recovery_phrase: String,
}

#[tauri::command]
async fn create_account(state: State<'_, AppState>, name: String, password: String, remember_me: bool) -> CmdResult<Created> {
    if read_stored(&state)?.is_some() {
        return Err("There is already an account on this computer.".into());
    }
    let (identity, stored) = blocking(move || Identity::create(&name, &password)).await?;
    write_stored(&state, &stored)?;
    remember(&identity, remember_me);
    let created = Created { name: identity.name.clone(), recovery_phrase: identity.recovery_phrase() };
    *state.identity.lock().unwrap() = Some(identity);
    Ok(created)
}

#[tauri::command]
async fn login(state: State<'_, AppState>, password: String, remember_me: bool) -> CmdResult<String> {
    let stored = unlock_stored(&state)?;
    let identity = blocking(move || Identity::unlock(&stored, &password)).await?;
    remember(&identity, remember_me);
    let name = identity.name.clone();
    *state.identity.lock().unwrap() = Some(identity);
    Ok(name)
}

/// Logging out also forgets a remembered login.
#[tauri::command]
fn logout(app: AppHandle, state: State<'_, AppState>) {
    disconnect(state.clone());
    for (_, c) in state.parked.lock().unwrap().drain() {
        c.task.abort();
    }
    app.state::<account::Account>().stop();
    if let Some(identity) = state.identity.lock().unwrap().take() {
        remember(&identity, false);
    }
}

/// Moves the current account file aside (never deletes it) so a new account can be created.
#[tauri::command]
fn reset_account(app: AppHandle, state: State<'_, AppState>) -> CmdResult<String> {
    logout(app, state.clone());
    back_up_account(&state)
}

#[tauri::command]
fn set_remember_me(state: State<'_, AppState>, on: bool) -> CmdResult {
    let identity = state.identity.lock().unwrap().clone().ok_or("You are not logged in.")?;
    remember(&identity, on);
    Ok(())
}

#[tauri::command]
async fn change_password(state: State<'_, AppState>, current: String, new_password: String) -> CmdResult {
    let stored = unlock_stored(&state)?;
    let backed_up = stored.backed_up;
    let mut updated = blocking(move || Identity::unlock(&stored, &current)?.encrypt(&new_password)).await?;
    updated.backed_up = backed_up;
    write_stored(&state, &updated)
}

/// Shown only after the password is confirmed: the phrase *is* the account.
#[tauri::command]
async fn show_recovery_phrase(state: State<'_, AppState>, password: String) -> CmdResult<String> {
    let stored = unlock_stored(&state)?;
    blocking(move || Ok(Identity::unlock(&stored, &password)?.recovery_phrase())).await
}

/// Checks a phrase before restoring: whose account is it, and would it replace the one on this computer?
#[derive(Serialize)]
struct PhraseCheck {
    matches_this_computer: bool,
    other_account_name: Option<String>,
}

#[tauri::command]
fn check_recovery_phrase(state: State<'_, AppState>, phrase: String) -> CmdResult<PhraseCheck> {
    let key = strom_voice::identity::public_key_of_phrase(&phrase).map_err(|e| e.to_string())?;
    let stored = read_stored(&state)?;
    let matches = stored.as_ref().is_some_and(|s| s.public_key == key);
    Ok(PhraseCheck {
        matches_this_computer: matches,
        other_account_name: stored.filter(|_| !matches).map(|s| s.name),
    })
}

/// "Forgot password" and "new computer": rebuilds the account from its recovery
/// phrase under a new password. Another account on this computer is backed up, not deleted.
#[tauri::command]
async fn recover_account(
    app: AppHandle,
    state: State<'_, AppState>,
    phrase: String,
    name: Option<String>,
    password: String,
    remember_me: bool,
) -> CmdResult<String> {
    let key = strom_voice::identity::public_key_of_phrase(&phrase).map_err(|e| e.to_string())?;
    let existing = read_stored(&state)?;
    let name = match (&existing, name) {
        (Some(s), _) if s.public_key == key => s.name.clone(),
        (_, Some(n)) => n,
        _ => return Err("Choose a display name.".into()),
    };
    let (identity, mut stored) = blocking(move || Identity::restore(&name, &phrase, &password)).await?;
    // They just typed the whole phrase, so they evidently have it.
    stored.backed_up = true;
    logout(app, state.clone());
    if existing.is_some_and(|s| s.public_key != key) {
        back_up_account(&state)?;
    }
    write_stored(&state, &stored)?;
    remember(&identity, remember_me);
    let name = identity.name.clone();
    *state.identity.lock().unwrap() = Some(identity);
    Ok(name)
}

fn logged_in_identity(state: &AppState) -> CmdResult<Identity> {
    state.identity.lock().unwrap().clone().ok_or_else(|| "You are not logged in.".to_string())
}

/// The recovery-phrase quiz. Checked here, not in the UI, so it can't be skipped.
#[tauri::command]
fn confirm_backup(state: State<'_, AppState>, answers: Vec<(usize, String)>) -> CmdResult {
    let identity = logged_in_identity(&state)?;
    if !identity.check_phrase_words(&answers) {
        return Err("Those words don't match your recovery phrase. Check what you wrote down.".into());
    }
    let mut stored = unlock_stored(&state)?;
    stored.backed_up = true;
    write_stored(&state, &stored)
}

/// Writes the phrase to a text file in Downloads and shows it in Explorer.
#[tauri::command]
fn save_recovery_file(app: AppHandle, state: State<'_, AppState>, phrase: String) -> CmdResult<String> {
    use tauri_plugin_opener::OpenerExt;
    let identity = logged_in_identity(&state)?;
    let key = strom_voice::identity::public_key_of_phrase(&phrase).map_err(|e| e.to_string())?;
    if key != identity.public_key() {
        return Err("That phrase doesn't belong to this account.".into());
    }
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let safe_name: String = identity.name.chars().filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-').collect();
    let path = dir.join(format!("Hopp recovery phrase - {}.txt", safe_name.trim()));
    let words: String = phrase
        .split(' ')
        .enumerate()
        .map(|(i, w)| format!("{:>2}. {w}\n", i + 1))
        .collect();
    let text = format!(
        "HOPP RECOVERY PHRASE\r\n\r\nAccount: {}\r\nHopp ID: {}\r\n\r\n{}\r\n\
         These 24 words ARE your account. With them anyone can log in as you.\r\n\
         Keep this file somewhere safe and private (a USB stick, a password manager,\r\n\
         or printed out). Never send it to anyone.\r\n",
        identity.name,
        &identity.public_key()[..16],
        words.replace('\n', "\r\n"),
    );
    std::fs::write(&path, text).map_err(|e| format!("Couldn't save the file: {e}"))?;
    let _ = app.opener().reveal_item_in_dir(&path);
    Ok(path.display().to_string())
}

#[tauri::command]
fn windows_hello_available() -> bool {
    hello::available()
}

/// Asks Windows Hello (PIN, fingerprint or face) to confirm it's the computer's owner.
#[tauri::command]
async fn verify_with_windows_hello(app: AppHandle, state: State<'_, AppState>) -> CmdResult {
    logged_in_identity(&state)?;
    let window = app.get_webview_window("main").ok_or("No window.")?;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
    let ok = blocking(move || hello::verify(hwnd, "Confirm it's you to reset your Hopp password")).await?;
    if !ok {
        return Err("Windows Hello didn't confirm it was you.".into());
    }
    *state.hello_verified_at.lock().unwrap() = Some(Instant::now());
    Ok(())
}

/// A Windows Hello confirmation is good for a few minutes, then must be repeated.
fn require_hello(state: &AppState) -> CmdResult {
    let fresh = state.hello_verified_at.lock().unwrap().is_some_and(|t| t.elapsed() < HELLO_VALID_FOR);
    if fresh { Ok(()) } else { Err("Confirm it's you with Windows Hello first.".into()) }
}

#[tauri::command]
async fn set_password_with_hello(state: State<'_, AppState>, new_password: String) -> CmdResult {
    require_hello(&state)?;
    let identity = logged_in_identity(&state)?;
    let backed_up = unlock_stored(&state)?.backed_up;
    let mut stored = blocking(move || identity.encrypt(&new_password)).await?;
    stored.backed_up = backed_up;
    write_stored(&state, &stored)
}

/// Changing the password when you don't remember the old one but have your recovery phrase.
#[tauri::command]
async fn set_password_with_phrase(state: State<'_, AppState>, phrase: String, new_password: String) -> CmdResult {
    let identity = logged_in_identity(&state)?;
    let key = strom_voice::identity::public_key_of_phrase(&phrase).map_err(|e| e.to_string())?;
    if key != identity.public_key() {
        return Err("That recovery phrase belongs to a different Hopp ID.".into());
    }
    let name = identity.name.clone();
    let (_, mut stored) = blocking(move || Identity::restore(&name, &phrase, &new_password)).await?;
    // Typing the whole phrase proves it's saved.
    stored.backed_up = true;
    write_stored(&state, &stored)
}

#[tauri::command]
fn recovery_phrase_with_hello(state: State<'_, AppState>) -> CmdResult<String> {
    require_hello(&state)?;
    Ok(logged_in_identity(&state)?.recovery_phrase())
}

#[tauri::command]
fn rename_account(state: State<'_, AppState>, name: String) -> CmdResult<String> {
    let name = strom_voice::identity::validate_name(&name).map_err(|e| e.to_string())?;
    let mut stored = read_stored(&state)?.ok_or("There is no account.")?;
    stored.name = name.clone();
    write_stored(&state, &stored)?;
    if let Some(identity) = state.identity.lock().unwrap().as_mut() {
        identity.name = name.clone();
    }
    Ok(name)
}

// ---------- connection ----------

#[tauri::command]
async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    address: String,
    invite: Option<String>,
    create: Option<String>,
) -> CmdResult<Roster> {
    // The server we're leaving stays connected in the background (when it can), so coming
    // back is instant. Taking a generation number after means a newer connect, or a
    // disconnect, started while this one is still logging in makes it give up.
    park_current(&state);
    let generation = *state.generation.lock().unwrap();
    if invite.is_none() && create.is_none() {
        let waiting = state.parked.lock().unwrap().remove(&address);
        if let Some(c) = waiting {
            // Back in view: no login, just this server's channels sent again.
            state.audio.clear_user_volumes();
            c.control.send(ClientMsg::Resync);
            c.control.send(ClientMsg::SetState { muted: state.audio.muted(), deafened: state.audio.deafened() });
            // In view first, then the roster: nothing that arrives in between is missed.
            let shared = c.roster.clone();
            *state.conn.lock().unwrap() = Some(c);
            let roster = shared.lock().unwrap().clone();
            return Ok(roster);
        }
    }
    let identity = state.identity.lock().unwrap().clone().ok_or("You are not logged in.")?;
    let session = strom_voice::connect(&address, &identity, invite.as_deref(), create.as_deref()).await.map_err(|e| e.to_string())?;
    if *state.generation.lock().unwrap() != generation {
        return Err("superseded".into());
    }
    state.audio.clear_user_volumes();
    // Warmed up meanwhile in the background: this one wins.
    if let Some(old) = state.parked.lock().unwrap().remove(&address) {
        old.task.abort();
    }
    session.control.send(ClientMsg::SetState { muted: state.audio.muted(), deafened: state.audio.deafened() });
    let initial = session.roster.clone();
    let c = start_connection(&app, session, address, generation);
    *state.conn.lock().unwrap() = Some(c);
    Ok(initial)
}

/// Starts a connection's task: it shows the server while it's the one in view, and keeps its
/// roster (and unread news) going while it waits in the background.
fn start_connection(app: &AppHandle, mut session: Session, address: String, generation: u64) -> Connection {
    let me = session.roster.me;
    let resync = session.roster.features.iter().any(|f| f == "resync");
    let shared = Arc::new(Mutex::new(session.roster.clone()));
    let roster = shared.clone();
    let ui = app.clone();
    let here = address.clone();
    let task = tauri::async_runtime::spawn(async move {
        while let Some(msg) = session.events.recv().await {
            let active = ui.state::<AppState>().conn.lock().unwrap().as_ref().is_some_and(|c| c.generation == generation);
            if !active {
                background(&ui, &here, &roster, &msg);
                continue;
            }
            match &msg {
                ServerMsg::Error { message } => {
                    let _ = ui.emit("server-error", message);
                }
                ServerMsg::Chat { message } => {
                    let _ = ui.emit("chat", message);
                }
                ServerMsg::ChatHistory { channel, messages } => {
                    let _ = ui.emit("chat-history", serde_json::json!({ "channel": channel, "messages": messages }));
                }
                ServerMsg::MessageEdited { channel, id, text, edited_at } => {
                    let _ = ui.emit("message-edited", serde_json::json!({ "channel": channel, "id": id, "text": text, "edited_at": edited_at }));
                }
                ServerMsg::Reactions { channel, id, reactions } => {
                    let _ = ui.emit("reactions", serde_json::json!({ "channel": channel, "id": id, "reactions": reactions }));
                }
                ServerMsg::Pinned { channel, id, on } => {
                    let _ = ui.emit("pinned", serde_json::json!({ "channel": channel, "id": id, "on": on }));
                }
                ServerMsg::Pins { channel, messages } => {
                    let _ = ui.emit("pins", serde_json::json!({ "channel": channel, "messages": messages }));
                }
                ServerMsg::ScreenSignal { from, data } => {
                    let _ = ui.emit("screen-signal", serde_json::json!({ "from": from, "data": data }));
                }
                ServerMsg::SearchResults { query, messages } => {
                    let _ = ui.emit("search-results", serde_json::json!({ "query": query, "messages": messages }));
                }
                ServerMsg::OlderHistory { channel, messages, done } => {
                    let _ = ui.emit("older-history", serde_json::json!({ "channel": channel, "messages": messages, "done": done }));
                }
                ServerMsg::MessageDeleted { channel, id } => {
                    let _ = ui.emit("message-deleted", serde_json::json!({ "channel": channel, "id": id }));
                }
                ServerMsg::Typing { channel, session_id } => {
                    let _ = ui.emit("typing", serde_json::json!({ "channel": channel, "session_id": session_id }));
                }
                ServerMsg::Left => {
                    let _ = ui.emit("left", ());
                }
                ServerMsg::ServerDeleted => {
                    let _ = ui.emit("server-deleted", ());
                }
                ServerMsg::Kicked { banned } => {
                    let _ = ui.emit("kicked", banned);
                }
                ServerMsg::InviteCreated { invite } => {
                    let _ = ui.emit("invite-created", invite);
                }
                ServerMsg::Invites { invites } => {
                    let _ = ui.emit("invites", invites);
                }
                ServerMsg::AuditLog { entries } => {
                    let _ = ui.emit("audit-log", entries);
                }
                ServerMsg::Bans { bans } => {
                    let _ = ui.emit("bans", bans);
                }
                ServerMsg::Members { members } => {
                    let _ = ui.emit("members", members);
                }
                ServerMsg::VoiceSession { channel, key, peers } => {
                    let (ui, channel, key, peers) = (ui.clone(), *channel, key.clone(), peers.clone());
                    let state = ui.state::<AppState>();
                    let attempt = {
                        let mut conn = state.conn.lock().unwrap();
                        let Some(c) = conn.as_mut().filter(|c| c.generation == generation) else { continue };
                        c.voice_attempt += 1;
                        // Stop the old engine first, so the microphone is free for the new one.
                        c.engine = None;
                        c.voice_peers = peers.into_iter().map(|p| (p.session_id, p)).collect();
                        c.voice_attempt
                    };
                    tauri::async_runtime::spawn_blocking(move || start_peer_voice(ui, generation, attempt, channel, &key));
                }
                ServerMsg::VoicePeer { peer } => {
                    let state = ui.state::<AppState>();
                    let mut conn = state.conn.lock().unwrap();
                    if let Some(c) = conn.as_mut().filter(|c| c.generation == generation) {
                        if let Some(engine) = &c.engine {
                            engine.set_peer(peer);
                        }
                        c.voice_peers.insert(peer.session_id, peer.clone());
                    }
                }
                _ => {
                    // Taken out of voice by the server (e.g. the channel was deleted): close the microphone.
                    if let ServerMsg::UserUpdated { user } = &msg {
                        if user.session_id == me && user.voice_channel.is_none() {
                            let state = ui.state::<AppState>();
                            let mut conn = state.conn.lock().unwrap();
                            if let Some(c) = conn.as_mut().filter(|c| c.generation == generation) {
                                c.engine = None;
                                c.voice_peers.clear();
                                // A peer-to-peer start still in progress must not open the microphone.
                                c.voice_attempt += 1;
                            }
                        }
                    }
                    let snapshot = {
                        let mut r = roster.lock().unwrap();
                        r.apply(&msg);
                        r.clone()
                    };
                    forget_departed_peers(&ui, generation, &snapshot);
                    let _ = ui.emit("roster", &snapshot);
                }
            }
        }
        // The server went away: tear down this connection unless it was already replaced.
        let state = ui.state::<AppState>();
        state.parked.lock().unwrap().retain(|_, c| c.generation != generation);
        let mut conn = state.conn.lock().unwrap();
        if conn.as_ref().is_some_and(|c| c.generation == generation) {
            *conn = None;
            let _ = ui.emit("disconnected", "lost connection to server");
        }
    });

    Connection {
        generation,
        address,
        roster: shared,
        resync,
        control: session.control,
        task,
        udp_addr: session.udp_addr,
        session_id: me,
        udp_token: session.udp_token,
        engine: None,
        voice_peers: HashMap::new(),
        voice_attempt: 0,
    }
}

/// A server waiting in the background: its roster stays current, and new messages still
/// mark it unread (and ping you), as if you were looking.
fn background(ui: &AppHandle, address: &str, roster: &Arc<Mutex<Roster>>, msg: &ServerMsg) {
    match msg {
        ServerMsg::Chat { message } => {
            let r = roster.lock().unwrap();
            let channel = r.channels.iter().find(|c| c.id == message.channel);
            let my_roles = r.users.iter().find(|u| u.session_id == r.me).map(|u| u.roles.clone()).unwrap_or_default();
            let _ = ui.emit(
                "background-chat",
                serde_json::json!({
                    "address": address,
                    "message": message,
                    "channel_name": channel.map(|c| c.name.clone()),
                    "voice": channel.is_some_and(|c| c.kind == ChannelKind::Voice),
                    "roles": my_roles,
                    "pings": r.features.iter().any(|f| f == "pings"),
                }),
            );
        }
        // Voice, typing, screens and answers are for the server in view.
        ServerMsg::VoiceSession { .. } | ServerMsg::VoicePeer { .. } | ServerMsg::Typing { .. } | ServerMsg::ScreenSignal { .. } => {}
        _ => roster.lock().unwrap().apply(msg),
    }
}

/// Moves the server in view to the background, connected, so coming back is instant. Voice
/// there ends, as leaving a server always did. Servers that can't resend their channels
/// (older ones) are simply disconnected.
fn park_current(state: &AppState) {
    *state.generation.lock().unwrap() += 1;
    let Some(mut c) = state.conn.lock().unwrap().take() else { return };
    if !c.resync {
        c.task.abort();
        return;
    }
    let in_voice = {
        let r = c.roster.lock().unwrap();
        r.users.iter().any(|u| u.session_id == r.me && u.voice_channel.is_some())
    };
    if in_voice || c.engine.is_some() {
        c.control.send(ClientMsg::LeaveVoice);
        c.engine = None;
        c.voice_peers.clear();
        c.voice_attempt += 1;
    }
    let old = state.parked.lock().unwrap().insert(c.address.clone(), c);
    if let Some(old) = old {
        old.task.abort();
    }
}

/// Connects to a server in the background, so the first visit is instant too.
#[tauri::command]
async fn warm(app: AppHandle, state: State<'_, AppState>, address: String) -> CmdResult {
    let known = |state: &AppState| {
        state.parked.lock().unwrap().contains_key(&address) || state.conn.lock().unwrap().as_ref().is_some_and(|c| c.address == address)
    };
    if known(&state) {
        return Ok(());
    }
    let identity = state.identity.lock().unwrap().clone().ok_or("You are not logged in.")?;
    let session = strom_voice::connect(&address, &identity, None, None).await.map_err(|e| e.to_string())?;
    // Older servers can't resend their channels; and maybe you opened it meanwhile.
    if !session.roster.features.iter().any(|f| f == "resync") || known(&state) {
        return Ok(());
    }
    session.control.send(ClientMsg::SetState { muted: state.audio.muted(), deafened: state.audio.deafened() });
    // Its own number, never one a connect in view uses.
    let generation = WARM_IDS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let c = start_connection(&app, session, address.clone(), generation);
    state.parked.lock().unwrap().insert(address, c);
    Ok(())
}

static WARM_IDS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1 << 48);

/// A server left, deleted or removed from the list: close its background connection.
#[tauri::command]
fn forget_server(state: State<'_, AppState>, address: String) {
    if let Some(c) = state.parked.lock().unwrap().remove(&address) {
        c.task.abort();
    }
}

#[tauri::command]
fn disconnect(state: State<'_, AppState>) {
    *state.generation.lock().unwrap() += 1;
    if let Some(conn) = state.conn.lock().unwrap().take() {
        conn.task.abort();
    }
}

#[tauri::command]
async fn join_voice(app: AppHandle, state: State<'_, AppState>, channel: ChannelId) -> CmdResult {
    // Voice needs the microphone; a running mic check would compete for it.
    *state.mic_test.lock().unwrap() = None;
    let devices = state.devices.lock().unwrap().clone();
    let mut conn = state.conn.lock().unwrap();
    let c = conn.as_mut().ok_or("not connected")?;
    let Some(udp_addr) = c.udp_addr else {
        // Cloud server: the answer brings the channel's key and peers, and voice starts then.
        c.control.send(ClientMsg::JoinVoice { channel });
        let (generation, attempt) = (c.generation, c.voice_attempt);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(6)).await;
            let state = app.state::<AppState>();
            let unanswered = state.conn.lock().unwrap().as_ref().is_some_and(|c| c.generation == generation && c.voice_attempt == attempt);
            if unanswered {
                let _ = app.emit("voice-state", serde_json::json!({ "ready": false, "error": "Hopp Cloud didn't answer. It may be running an older version without voice." }));
            }
        });
        return Ok(());
    };
    if c.engine.is_none() {
        let (engine, events) = VoiceEngine::start(udp_addr, c.session_id, c.udp_token, &devices, state.audio.clone())
            .map_err(|e| format!("audio: {e:#}"))?;
        // Engine events come from realtime threads; relay them until the engine stops.
        let ui = app.clone();
        std::thread::spawn(move || {
            for ev in events {
                let _ = ui.emit("voice", ev);
            }
        });
        c.engine = Some(engine);
    }
    c.control.send(ClientMsg::JoinVoice { channel });
    let _ = app.emit("voice-state", serde_json::json!({ "ready": true }));
    Ok(())
}

#[tauri::command]
fn leave_voice(state: State<'_, AppState>) -> CmdResult {
    with_conn(&state, |c| {
        c.control.send(ClientMsg::LeaveVoice);
        c.engine = None;
        c.voice_peers.clear();
        c.voice_attempt += 1;
    })
}

/// Starts peer-to-peer voice on a cloud server (blocking: it asks a STUN server for our address).
fn start_peer_voice(ui: AppHandle, generation: u64, attempt: u64, channel: ChannelId, key_hex: &str) {
    let state = ui.state::<AppState>();
    let Some(key) = decode_key(key_hex) else {
        let _ = ui.emit("server-error", "The server sent a broken voice key.");
        return;
    };
    let current = |c: &Connection| c.generation == generation && c.voice_attempt == attempt;
    let Some(session_id) = state.conn.lock().unwrap().as_ref().filter(|c| current(c)).map(|c| c.session_id) else { return };

    // Voice needs the microphone; a running mic check would compete for it.
    *state.mic_test.lock().unwrap() = None;
    let devices = state.devices.lock().unwrap().clone();
    let (engine, events) = match VoiceEngine::start_mesh(session_id, key, &devices, state.audio.clone()) {
        Ok(started) => started,
        Err(e) => {
            let _ = ui.emit("voice-state", serde_json::json!({ "ready": false, "error": format!("audio: {e:#}") }));
            if let Some(c) = state.conn.lock().unwrap().as_mut().filter(|c| current(c)) {
                c.control.send(ClientMsg::LeaveVoice);
            }
            return;
        }
    };

    let mut conn = state.conn.lock().unwrap();
    let Some(c) = conn.as_mut().filter(|c| current(c)) else { return };
    for peer in c.voice_peers.values() {
        engine.set_peer(peer);
    }
    if let Some(me) = engine.endpoint() {
        tracing::info!("voice in channel {channel} reachable at {:?} / {:?}", me.public, me.local);
        c.control.send(ClientMsg::VoiceEndpoint { public: me.public.clone(), local: me.local.clone() });
    }
    // Engine events come from realtime threads; relay them until the engine stops.
    let relay = ui.clone();
    std::thread::spawn(move || {
        for ev in events {
            // A relay address to hand out: everyone in the channel learns it from the server.
            if let strom_voice::EngineEvent::Endpoint { endpoint } = &ev {
                let state = relay.state::<AppState>();
                let conn = state.conn.lock().unwrap();
                if let Some(c) = conn.as_ref() {
                    c.control.send(ClientMsg::VoiceEndpoint { public: endpoint.public.clone(), local: endpoint.local.clone() });
                }
            }
            let _ = relay.emit("voice", ev);
        }
    });
    c.engine = Some(engine);
    let _ = ui.emit("voice-state", serde_json::json!({ "ready": true }));
}

struct Call {
    id: String,
    engine: VoiceEngine,
}

/// Starts a call's voice (`me` is 1 for the caller, 2 for the one called) and
/// returns where the friend can reach us; their address comes with `call_peer`.
#[tauri::command]
async fn start_call(app: AppHandle, call_id: String, key: String, me: SessionId) -> CmdResult<Option<PeerEndpoint>> {
    let key = decode_key(&key).ok_or("The call key is broken.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        // One microphone user at a time: the mic check and server voice make way.
        *state.mic_test.lock().unwrap() = None;
        *state.call.lock().unwrap() = None;
        let devices = state.devices.lock().unwrap().clone();
        let (engine, events) = VoiceEngine::start_mesh(me, key, &devices, state.audio.clone()).map_err(|e| format!("Couldn't start your audio: {e:#}"))?;
        let endpoint = engine.endpoint().cloned();
        let relay = app.clone();
        std::thread::spawn(move || {
            for ev in events {
                let _ = relay.emit("call-voice", ev);
            }
        });
        *state.call.lock().unwrap() = Some(Call { id: call_id, engine });
        Ok(endpoint)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn call_peer(state: State<'_, AppState>, call_id: String, peer: PeerEndpoint) {
    if let Some(call) = state.call.lock().unwrap().as_ref().filter(|c| c.id == call_id) {
        call.engine.set_peer(&peer);
    }
}

/// A relay login (from the account) for voice in the channel and in a call: used only
/// for people no direct path reaches.
#[tauri::command]
fn set_relay(state: State<'_, AppState>, login: strom_voice::turn::TurnLogin) -> CmdResult {
    if let Some(engine) = state.conn.lock().unwrap().as_ref().and_then(|c| c.engine.as_ref()) {
        engine.set_relay(&login).map_err(|e| format!("Couldn't use the voice relay: {e:#}"))?;
    }
    if let Some(call) = state.call.lock().unwrap().as_ref() {
        call.engine.set_relay(&login).map_err(|e| format!("Couldn't use the voice relay: {e:#}"))?;
    }
    Ok(())
}

/// A group call: stop sending to someone who left it.
#[tauri::command]
fn call_drop_peer(state: State<'_, AppState>, call_id: String, session_id: SessionId) {
    if let Some(call) = state.call.lock().unwrap().as_ref().filter(|c| c.id == call_id) {
        call.engine.retain_peers(|id| id != session_id);
    }
}

#[tauri::command]
fn end_call(state: State<'_, AppState>) {
    *state.call.lock().unwrap() = None;
}

fn decode_key(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 || !hex.is_ascii() {
        return None;
    }
    let mut key = [0u8; 32];
    for (i, b) in key.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(key)
}

/// Peer-to-peer voice: stop sending to people who left our voice channel.
fn forget_departed_peers(ui: &AppHandle, generation: u64, roster: &Roster) {
    let state = ui.state::<AppState>();
    let mut conn = state.conn.lock().unwrap();
    let Some(c) = conn.as_mut().filter(|c| c.generation == generation && c.udp_addr.is_none()) else { return };
    let mine = roster.users.iter().find(|u| u.session_id == roster.me).and_then(|u| u.voice_channel);
    let with_me = |id: SessionId| mine.is_some() && roster.users.iter().any(|u| u.session_id == id && u.voice_channel == mine);
    c.voice_peers.retain(|&id, _| with_me(id));
    if let Some(engine) = &c.engine {
        engine.retain_peers(with_me);
    }
}

#[tauri::command]
fn send_chat(state: State<'_, AppState>, channel: ChannelId, text: String, reply_to: Option<u64>) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::SendChat { channel, text, reply_to }))
}

#[tauri::command]
fn edit_message(state: State<'_, AppState>, channel: ChannelId, id: u64, text: String) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::EditMessage { channel, id, text }))
}

#[tauri::command]
fn react(state: State<'_, AppState>, channel: ChannelId, id: u64, emoji: String, on: bool) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::React { channel, id, emoji, on }))
}

#[tauri::command]
fn delete_server(state: State<'_, AppState>) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::DeleteServer))
}

#[tauri::command]
fn leave_server(state: State<'_, AppState>) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::LeaveServer))
}

#[tauri::command]
fn pin_message(state: State<'_, AppState>, channel: ChannelId, id: u64, on: bool) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::Pin { channel, id, on }))
}

#[tauri::command]
fn get_pins(state: State<'_, AppState>, channel: ChannelId) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::GetPins { channel }))
}

/// The soundboard: a short sound everyone in our voice channel or call hears.
#[tauri::command]
fn play_soundboard(state: State<'_, AppState>, name: String) -> CmdResult {
    let in_voice = state.conn.lock().unwrap().as_ref().is_some_and(|c| c.engine.is_some()) || state.call.lock().unwrap().is_some();
    if !in_voice {
        return Err("Join a voice channel or a call to use the soundboard.".into());
    }
    if !state.audio.play_sound(&name) {
        return Err("Unmute to use the soundboard.".into());
    }
    Ok(())
}

/// Moderators: takes someone out of voice.
#[tauri::command]
fn disconnect_voice(state: State<'_, AppState>, session_id: SessionId) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::DisconnectVoice { session_id }))
}

/// Moderators: moves someone to another voice channel.
#[tauri::command]
fn move_voice(state: State<'_, AppState>, session_id: SessionId, channel: ChannelId) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::MoveVoice { session_id, channel }))
}

/// Moderators: mutes or deafens someone for everyone.
#[tauri::command]
fn server_mute(state: State<'_, AppState>, session_id: SessionId, muted: bool, deafened: bool) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::ServerMute { session_id, muted, deafened }))
}

#[tauri::command]
fn set_sharing(state: State<'_, AppState>, on: bool) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::SetSharing { on }))
}

#[tauri::command]
fn screen_signal(state: State<'_, AppState>, to: SessionId, data: String) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::ScreenSignal { to, data }))
}

/// A link's preview (title, description, picture), fetched only from the public internet.
#[tauri::command]
async fn link_preview(url: String) -> CmdResult<Option<preview::Preview>> {
    preview::fetch(&url).await
}

#[tauri::command]
fn search_messages(state: State<'_, AppState>, query: String) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::Search { query }))
}

#[tauri::command]
fn load_older(state: State<'_, AppState>, channel: ChannelId, before: u64) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::LoadOlder { channel, before }))
}

#[tauri::command]
fn update_server(state: State<'_, AppState>, name: String, icon: Option<String>, pictures_off: Option<bool>) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::UpdateServer { name, icon, pictures_off }))
}

#[tauri::command]
fn create_channel(state: State<'_, AppState>, name: String, kind: ChannelKind) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::CreateChannel { name, kind }))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn update_channel(
    state: State<'_, AppState>,
    channel: ChannelId,
    name: String,
    topic: Option<String>,
    category: Option<String>,
    no_pictures: Option<bool>,
    user_limit: Option<u8>,
    afk_after: Option<u16>,
    slowmode: Option<u32>,
    private_roles: Option<Vec<u32>>,
) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::UpdateChannel { channel, name, topic, category, no_pictures, user_limit, afk_after, slowmode, private_roles }))
}

/// Admins: the server's own roles.
#[tauri::command]
fn create_role(state: State<'_, AppState>, name: String, color: Option<String>, hoist: bool, level: Option<String>, mentionable: Option<bool>) -> CmdResult {
    let mentionable = mentionable.unwrap_or(false);
    with_conn(&state, |c| c.control.send(ClientMsg::CreateRole { name, color, hoist, level, mentionable }))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn update_role(state: State<'_, AppState>, id: u32, name: String, color: Option<String>, hoist: bool, level: Option<String>, mentionable: Option<bool>) -> CmdResult {
    let mentionable = mentionable.unwrap_or(false);
    with_conn(&state, |c| c.control.send(ClientMsg::UpdateRole { id, name, color, hoist, level, mentionable }))
}

#[tauri::command]
fn delete_role(state: State<'_, AppState>, id: u32) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::DeleteRole { id }))
}

#[tauri::command]
fn reorder_roles(state: State<'_, AppState>, order: Vec<u32>) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::ReorderRoles { order }))
}

#[tauri::command]
fn assign_role(state: State<'_, AppState>, public_key: String, role: u32, on: bool) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::AssignRole { public_key, role, on }))
}

/// Your name in this server, or (moderators) someone else's.
#[tauri::command]
fn set_nickname(state: State<'_, AppState>, public_key: String, nick: Option<String>) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::SetNickname { public_key, nick }))
}

/// Moderators: times someone out (0 minutes lifts it).
#[tauri::command]
fn timeout_member(state: State<'_, AppState>, session_id: SessionId, minutes: u32) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::Timeout { session_id, minutes }))
}

#[tauri::command]
fn get_audit_log(state: State<'_, AppState>) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::GetAuditLog))
}

/// Seconds since the last key press or mouse move anywhere in Windows (for the AFK channel).
#[tauri::command]
fn idle_seconds() -> u64 {
    #[cfg(windows)]
    {
        use windows::Win32::System::SystemInformation::GetTickCount;
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        if unsafe { GetLastInputInfo(&mut info) }.as_bool() {
            return (unsafe { GetTickCount() }.wrapping_sub(info.dwTime) / 1000) as u64;
        }
    }
    0
}

#[tauri::command]
fn reorder_channels(state: State<'_, AppState>, order: Vec<ChannelId>) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::ReorderChannels { order }))
}

#[tauri::command]
fn delete_channel(state: State<'_, AppState>, channel: ChannelId) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::DeleteChannel { channel }))
}

#[tauri::command]
fn delete_message(state: State<'_, AppState>, channel: ChannelId, id: u64) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::DeleteMessage { channel, id }))
}

#[tauri::command]
fn typing(state: State<'_, AppState>, channel: ChannelId) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::Typing { channel }))
}

#[tauri::command]
fn kick(state: State<'_, AppState>, session_id: SessionId, ban: bool, delete_hours: Option<u32>) -> CmdResult {
    let msg = if ban { ClientMsg::Ban { session_id, delete_hours: delete_hours.unwrap_or(0) } } else { ClientMsg::Kick { session_id } };
    with_conn(&state, |c| c.control.send(msg))
}

#[tauri::command]
fn set_role(state: State<'_, AppState>, public_key: String, role: Option<String>) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::SetRole { public_key, role }))
}

#[tauri::command]
fn transfer_ownership(state: State<'_, AppState>, public_key: String) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::TransferOwnership { public_key }))
}

#[tauri::command]
fn get_members(state: State<'_, AppState>) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::GetMembers))
}

#[tauri::command]
fn unban(state: State<'_, AppState>, public_key: String) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::Unban { public_key }))
}

#[tauri::command]
fn create_invite(state: State<'_, AppState>, max_uses: Option<u32>, expires_in_hours: Option<u32>) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::CreateInvite { max_uses, expires_in_hours }))
}

#[tauri::command]
fn revoke_invite(state: State<'_, AppState>, code: String) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::RevokeInvite { code }))
}

#[tauri::command]
fn get_server_settings(state: State<'_, AppState>) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::GetServerSettings))
}

/// Starts the microphone check used by the settings screen when not in voice.
#[tauri::command]
async fn start_mic_test(app: AppHandle, state: State<'_, AppState>) -> CmdResult {
    // In voice the microphone is already open: the engine plays it back instead.
    if state.conn.lock().unwrap().as_ref().is_some_and(|c| c.engine.is_some()) {
        state.audio.set_monitor(true);
        return Ok(());
    }
    let mut slot = state.mic_test.lock().unwrap();
    if slot.is_some() {
        return Ok(());
    }
    let devices = state.devices.lock().unwrap().clone();
    let (test, events) = MicTest::start(&devices, state.audio.clone()).map_err(|e| format!("audio: {e:#}"))?;
    std::thread::spawn(move || {
        for ev in events {
            let _ = app.emit("voice", ev);
        }
    });
    *slot = Some(test);
    Ok(())
}

#[tauri::command]
fn stop_mic_test(state: State<'_, AppState>) {
    *state.mic_test.lock().unwrap() = None;
    state.audio.set_monitor(false);
}

#[tauri::command]
async fn test_output(state: State<'_, AppState>) -> CmdResult {
    let output = state.devices.lock().unwrap().output.clone();
    let volume = state.audio.playback_volume();
    strom_voice::play_test_sound(output, volume).map_err(|e| format!("audio: {e:#}"))
}

/// The `strom://` link the app was opened with, once.
#[tauri::command]
fn take_pending_link(links: State<'_, shell::PendingLink>) -> Option<String> {
    links.0.lock().unwrap().take()
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    shell::quit(&app);
}

#[tauri::command]
fn set_mic_monitor(state: State<'_, AppState>, on: bool) {
    state.audio.set_monitor(on);
}

#[tauri::command]
fn set_loopback(state: State<'_, AppState>, enabled: bool) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::SetLoopback { enabled }))
}

/// What an invite code leads to (server name, picture, member counts), fetched
/// from Hopp Cloud before joining. `cloud` is the cloud's https:// base URL.
#[tauri::command]
async fn invite_preview(cloud: String, code: String) -> CmdResult<serde_json::Value> {
    if !code.chars().all(|c| c.is_ascii_alphanumeric()) || code.len() > 16 {
        return Err("That doesn't look like an invite code.".into());
    }
    let url = format!("{}/invite/{}", cloud.trim_end_matches('/'), code.to_uppercase());
    let response = reqwest::Client::new()
        .get(url)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Hopp Cloud: {e}"))?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body["error"].as_str().unwrap_or("This invite is invalid or has expired.").to_string());
    }
    Ok(body)
}

/// A newer Hopp, if there is one: its version and what's new.
#[tauri::command]
async fn check_update(app: AppHandle) -> CmdResult<Option<serde_json::Value>> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| serde_json::json!({ "version": u.version, "notes": u.body })))
}

/// Downloads the newer Hopp (checking its signature), installs it and restarts.
#[tauri::command]
async fn install_update(app: AppHandle) -> CmdResult {
    use tauri_plugin_updater::UpdaterExt;
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let Some(update) = update else { return Err("You already have the newest Hopp.".into()) };
    // How far the download has come, for the progress bar.
    let mut done = 0u64;
    let progress = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                done += chunk as u64;
                let _ = progress.emit("update-progress", serde_json::json!({ "done": done, "total": total }));
            },
            || {},
        )
        .await
        .map_err(|e| format!("Couldn't update: {e}"))?;
    shell::prepare_quit();
    app.restart();
}

/// The version of Hopp that's running.
#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
fn autostart_enabled(app: AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Starts Hopp with Windows (minimized to the notification area), or stops doing so.
#[tauri::command]
fn set_autostart(app: AppHandle, on: bool) -> CmdResult {
    use tauri_plugin_autostart::ManagerExt;
    let launcher = app.autolaunch();
    if on { launcher.enable() } else { launcher.disable() }.map_err(|e| format!("Couldn't change that: {e}"))
}

/// GIFs for the picker, through Hopp Cloud (which holds the GIF service's key).
#[tauri::command]
async fn gif_search(cloud: String, q: String, pos: Option<String>) -> CmdResult<serde_json::Value> {
    let mut url = reqwest::Url::parse(&format!("{}/gifs", cloud.trim_end_matches('/'))).map_err(|e| e.to_string())?;
    url.query_pairs_mut().append_pair("q", &q).append_pair("pos", pos.as_deref().unwrap_or(""));
    let response = reqwest::Client::new()
        .get(url)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Hopp Cloud: {e}"))?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body["error"].as_str().unwrap_or("Couldn't load GIFs right now.").to_string());
    }
    Ok(body)
}

/// Uploads a picture to a cloud server's chat, signed with our Hopp ID. Returns its id.
#[tauri::command]
async fn upload_image(state: State<'_, AppState>, cloud: String, server_id: String, data: Vec<u8>, kind: String) -> CmdResult<String> {
    if !server_id.chars().all(|c| c.is_ascii_alphanumeric()) || !matches!(kind.as_str(), "image/webp" | "image/jpeg" | "image/png") {
        return Err("That picture can't be sent.".into());
    }
    let identity = state.identity.lock().unwrap().clone().ok_or("You are not logged in.")?;
    let time = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let signature = identity.sign_image(&server_id, &data, time);
    let url = format!("{}/servers/{}/images", cloud.trim_end_matches('/'), server_id);
    let response = reqwest::Client::new()
        .post(url)
        .header("content-type", kind)
        .header("X-Hopp-Key", identity.public_key())
        .header("X-Hopp-Time", time.to_string())
        .header("X-Hopp-Signature", signature)
        .body(data)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Hopp Cloud: {e}"))?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.unwrap_or_default();
    if !status.is_success() {
        return Err(body["error"].as_str().map(str::to_string).unwrap_or_else(|| format!("Couldn't send the picture ({status}).")));
    }
    body["id"].as_str().map(str::to_string).ok_or_else(|| "Couldn't send the picture.".into())
}

/// Stores an already encrypted picture for a DM in our own account, signed with our
/// Hopp ID. Returns its id; the key to read it only travels inside the sealed message.
#[tauri::command]
async fn upload_dm_image(state: State<'_, AppState>, cloud: String, data: Vec<u8>) -> CmdResult<String> {
    let identity = state.identity.lock().unwrap().clone().ok_or("You are not logged in.")?;
    let key = identity.public_key();
    let time = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let signature = identity.sign_image(&format!("account:{key}"), &data, time);
    let response = reqwest::Client::new()
        .post(format!("{}/accounts/{}/images", cloud.trim_end_matches('/'), key))
        .header("content-type", "application/octet-stream")
        .header("X-Hopp-Key", &key)
        .header("X-Hopp-Time", time.to_string())
        .header("X-Hopp-Signature", signature)
        .body(data)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Hopp Cloud: {e}"))?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.unwrap_or_default();
    if !status.is_success() {
        return Err(body["error"].as_str().map(str::to_string).unwrap_or_else(|| format!("Couldn't send the picture ({status}).")));
    }
    body["id"].as_str().map(str::to_string).ok_or_else(|| "Couldn't send the picture.".into())
}

/// A YouTube video's title and channel, for the card under a link (YouTube's public oEmbed, no key).
#[tauri::command]
async fn youtube_info(id: String) -> CmdResult<serde_json::Value> {
    if id.len() != 11 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Not a YouTube video.".into());
    }
    let mut url = reqwest::Url::parse("https://www.youtube.com/oembed").map_err(|e| e.to_string())?;
    url.query_pairs_mut().append_pair("url", &format!("https://www.youtube.com/watch?v={id}")).append_pair("format", "json");
    let response = reqwest::Client::new().get(url).timeout(Duration::from_secs(8)).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err("That video isn't available.".into());
    }
    let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "title": body["title"], "author": body["author_name"] }))
}

/// Someone's public profile (name and picture) by Hopp ID, for people in servers and chat.
#[tauri::command]
async fn fetch_profile(cloud: String, key: String) -> CmdResult<serde_json::Value> {
    if key.len() != 64 || !key.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Not a Hopp ID.".into());
    }
    let url = format!("{}/profiles/{}", cloud.trim_end_matches('/'), key.to_lowercase());
    let response = reqwest::Client::new()
        .get(url)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Hopp Cloud: {e}"))?;
    if !response.status().is_success() {
        return Err("No such account.".into());
    }
    response.json().await.map_err(|e| e.to_string())
}

/// This computer's address on the local network, for invite links.
#[tauri::command]
fn local_address() -> Option<String> {
    // Connecting a UDP socket sends nothing; it only picks the outgoing interface.
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    Some(socket.local_addr().ok()?.ip().to_string())
}

// ---------- voice settings ----------

fn send_state(state: &AppState) {
    let (muted, deafened) = (state.audio.muted(), state.audio.deafened());
    let _ = with_conn(state, |c| c.control.send(ClientMsg::SetState { muted, deafened }));
}

#[tauri::command]
fn set_muted(state: State<'_, AppState>, muted: bool) {
    state.audio.set_muted(muted);
    send_state(&state);
}

#[tauri::command]
fn set_deafened(state: State<'_, AppState>, deafened: bool) {
    state.audio.set_deafened(deafened);
    send_state(&state);
}

#[tauri::command]
fn set_transmit_mode(state: State<'_, AppState>, mode: TransmitMode) {
    state.audio.set_mode(mode);
    // The key is only watched in push-to-talk mode.
    if let Some(p) = state.ptt.get() {
        p.set_enabled(mode == TransmitMode::PushToTalk);
    }
    if mode != TransmitMode::PushToTalk {
        state.audio.set_push_to_talk(false);
    }
}

/// Binds push to talk to a virtual-key code (0 = none); returns its name.
#[tauri::command]
fn set_ptt_key(state: State<'_, AppState>, key: u32) -> String {
    if let Some(p) = state.ptt.get() {
        p.set_key(key);
    }
    ptt::key_label(key)
}

/// The next key or mouse button pressed anywhere arrives as a `ptt-recorded` event.
#[tauri::command]
fn record_ptt_key(state: State<'_, AppState>) {
    if let Some(p) = state.ptt.get() {
        p.record();
    }
}

#[tauri::command]
fn cancel_ptt_recording(state: State<'_, AppState>) {
    if let Some(p) = state.ptt.get() {
        p.cancel_recording();
    }
}

#[tauri::command]
fn set_ptt_release_delay(state: State<'_, AppState>, ms: u32) {
    state.audio.set_push_to_talk_release_delay(ms);
}

#[tauri::command]
fn set_push_to_talk(state: State<'_, AppState>, down: bool) {
    state.audio.set_push_to_talk(down);
}

#[tauri::command]
fn set_auto_sensitivity(state: State<'_, AppState>, on: bool) {
    state.audio.set_auto_sensitivity(on);
}

#[tauri::command]
fn set_vad_threshold(state: State<'_, AppState>, db: f32) {
    state.audio.set_vad_threshold(db);
}

#[tauri::command]
fn set_noise_suppression(state: State<'_, AppState>, on: bool) {
    state.audio.set_noise_suppression(on);
}

#[tauri::command]
fn set_echo_cancellation(state: State<'_, AppState>, on: bool) {
    state.audio.set_echo_cancellation(on);
}

#[tauri::command]
fn set_auto_gain(state: State<'_, AppState>, on: bool) {
    state.audio.set_auto_gain(on);
}

#[tauri::command]
fn set_input_volume(state: State<'_, AppState>, volume: f32) {
    state.audio.set_input_volume(volume);
}

#[tauri::command]
fn set_output_volume(state: State<'_, AppState>, volume: f32) {
    state.audio.set_output_volume(volume);
}

#[tauri::command]
fn set_user_volume(state: State<'_, AppState>, session_id: SessionId, volume: f32) {
    state.audio.set_user_volume(session_id, volume);
}

#[tauri::command]
async fn list_devices(state: State<'_, AppState>, fresh: Option<bool>) -> CmdResult<DeviceList> {
    // Asking Windows for every device is slow, so the last answer is kept; `fresh` asks again.
    if !fresh.unwrap_or(false) {
        if let Some(list) = state.device_list.lock().unwrap().clone() {
            return Ok(list);
        }
    }
    let list = blocking(|| Ok(strom_voice::list_devices())).await?;
    *state.device_list.lock().unwrap() = Some(list.clone());
    Ok(list)
}

/// Remembers the device choice and, while in voice, switches to it right away.
#[tauri::command]
async fn set_devices(state: State<'_, AppState>, input: Option<String>, output: Option<String>) -> CmdResult {
    let choice = DeviceChoice { input, output };
    *state.devices.lock().unwrap() = choice.clone();
    // A call has its own engine: it follows the new devices too.
    if let Some(call) = state.call.lock().unwrap().as_mut() {
        call.engine.set_devices(&choice).map_err(|e| format!("audio: {e:#}"))?;
    }
    match state.conn.lock().unwrap().as_mut().and_then(|c| c.engine.as_mut()) {
        Some(engine) => engine.set_devices(&choice).map_err(|e| format!("audio: {e:#}")),
        None => Ok(()),
    }
}

/// Logs go to the terminal and to a file per day in the app's log folder (the last 7 are kept),
/// for "Copy debug info". Nothing is sent anywhere.
fn init_logging(app: &tauri::App) {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    static GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();
    let filter = || tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into());
    let file = app.path().app_log_dir().ok().and_then(|dir| {
        tracing_appender::rolling::Builder::new()
            .rotation(tracing_appender::rolling::Rotation::DAILY)
            .filename_prefix("strom")
            .filename_suffix("log")
            .max_log_files(7)
            .build(dir)
            .ok()
    });
    let registry = tracing_subscriber::registry().with(filter()).with(tracing_subscriber::fmt::layer());
    match file {
        Some(file) => {
            let (writer, guard) = tracing_appender::non_blocking(file);
            let _ = GUARD.set(guard);
            let _ = registry.with(tracing_subscriber::fmt::layer().with_ansi(false).with_writer(writer)).try_init();
        }
        None => {
            let _ = registry.try_init();
        }
    }
    tracing::info!("Hopp {} starting", app.package_info().version);
}

/// What helps someone fix a problem: version, system, audio devices and the recent log.
#[tauri::command]
fn debug_info(app: AppHandle, state: State<'_, AppState>) -> String {
    let devices = strom_voice::list_devices();
    let chosen = state.devices.lock().unwrap().clone();
    let connected = state.conn.lock().unwrap().as_ref().map(|c| (c.udp_addr.is_none(), c.engine.is_some()));
    let mut out = format!(
        "Hopp {}
System: {} {}
Microphone: {:?} (default {:?})
Speakers: {:?} (default {:?})
Inputs: {:?}
Outputs: {:?}
Connected: {}
",
        app.package_info().version,
        std::env::consts::OS,
        std::env::consts::ARCH,
        chosen.input,
        devices.default_input,
        chosen.output,
        devices.default_output,
        devices.inputs,
        devices.outputs,
        match connected {
            None => "no".to_string(),
            Some((cloud, voice)) => format!("yes ({}, voice {})", if cloud { "cloud" } else { "self-hosted" }, if voice { "on" } else { "off" }),
        },
    );
    // The newest log file, last 300 lines.
    if let Ok(dir) = app.path().app_log_dir() {
        let newest = std::fs::read_dir(&dir)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().starts_with("strom"))
            .max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
        if let Some(text) = newest.and_then(|e| std::fs::read_to_string(e.path()).ok()) {
            let lines: Vec<&str> = text.lines().collect();
            out.push_str("
--- recent log ---
");
            out.push_str(&lines[lines.len().saturating_sub(300)..].join("
"));
        }
    }
    out
}

fn main() {
    tauri::Builder::default()
        // Must come first: a second copy hands its link to this one and quits.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| shell::show_main(app)))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::default())
        .manage(shell::PendingLink::default())
        .manage(account::Account::default())
        .manage(downloads::Downloads::default())
        .on_window_event(shell::on_window_event)
        .setup(|app| {
            init_logging(app);
            // Look the audio devices up now, off the main thread, so menus open instantly.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let list = strom_voice::list_devices();
                *handle.state::<AppState>().device_list.lock().unwrap() = Some(list);
            });
            shell::setup(app)?;
            let path = app.path().app_data_dir()?.join("identity.json");
            let state = app.state::<AppState>();
            let _ = state.identity_path.set(path);
            let _ = state.ptt.set(ptt::Ptt::start(app.handle().clone(), state.audio.clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            warm,
            forget_server,
            account_status,
            create_account,
            login,
            logout,
            reset_account,
            set_remember_me,
            change_password,
            show_recovery_phrase,
            check_recovery_phrase,
            recover_account,
            confirm_backup,
            save_recovery_file,
            windows_hello_available,
            verify_with_windows_hello,
            set_password_with_hello,
            set_password_with_phrase,
            recovery_phrase_with_hello,
            rename_account,
            connect,
            disconnect,
            join_voice,
            leave_voice,
            send_chat,
            edit_message,
            react,
            load_older,
            search_messages,
            link_preview,
            set_sharing,
            disconnect_voice,
            play_soundboard,
            move_voice,
            server_mute,
            screen_signal,
            pin_message,
            get_pins,
            start_call,
            call_peer,
            call_drop_peer,
            end_call,
            leave_server,
            delete_server,
            create_channel,
            delete_channel,
            update_channel,
            reorder_channels,
            idle_seconds,
            timeout_member,
            create_role,
            update_role,
            delete_role,
            reorder_roles,
            assign_role,
            set_nickname,
            get_audit_log,
            set_loopback,
            local_address,
            invite_preview,
            fetch_profile,
            gif_search,
            autostart_enabled,
            check_update,
            install_update,
            set_role,
            transfer_ownership,
            get_members,
            upload_image,
            set_relay,
            downloads::download_start,
            downloads::download_chunk,
            downloads::download_finish,
            downloads::download_cancel,
            downloads::show_download,
            youtube_info,
            upload_dm_image,
            app_version,
            set_autostart,
            shell::window_compact,
            shell::window_full,
            shell::window_splash,
            shell::window_color,
            update_server,
            set_muted,
            set_deafened,
            set_transmit_mode,
            set_push_to_talk,
            set_ptt_key,
            record_ptt_key,
            cancel_ptt_recording,
            set_ptt_release_delay,
            take_pending_link,
            account::start_account,
            account::account_send,
            account::seal_private,
            account::open_private,
            account::dm_seal,
            account::phrase_leak,
            account::dm_open,
            account::notify,
            debug_info,
            quit_app,
            test_output,
            set_vad_threshold,
            set_auto_sensitivity,
            set_echo_cancellation,
            set_auto_gain,
            set_noise_suppression,
            set_input_volume,
            set_output_volume,
            set_user_volume,
            list_devices,
            set_devices,
            delete_message,
            typing,
            kick,
            unban,
            create_invite,
            revoke_invite,
            get_server_settings,
            start_mic_test,
            stop_mic_test,
            set_mic_monitor,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hopp");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remembered_login_round_trips_through_the_os_credential_store() {
        let (identity, stored) = Identity::create("keyring-test", "password1").unwrap();
        remember(&identity, true);
        let restored = remembered_identity(&stored).expect("the OS credential store should return the login");
        assert_eq!(restored.public_key(), identity.public_key());
        remember(&identity, false);
        assert!(remembered_identity(&stored).is_none(), "forgetting must remove it");
    }

    #[test]
    fn windows_hello_availability_can_be_queried() {
        // Must not crash; whether Hello is set up depends on the computer.
        eprintln!("Windows Hello available: {}", hello::available());
    }
}
