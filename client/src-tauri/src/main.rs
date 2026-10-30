#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::net::{SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

mod hello;
mod ptt;
mod shell;

const HELLO_VALID_FOR: Duration = Duration::from_secs(180);
use strom_shared::{ChannelId, ChannelKind, ClientMsg, PeerEndpoint, ServerMsg, SessionId};
use strom_voice::{AudioSettings, Control, DeviceChoice, DeviceList, Identity, MicTest, Roster, StoredIdentity, TransmitMode, VoiceEngine};
use tauri::{AppHandle, Emitter, Manager, State};

struct Connection {
    generation: u64,
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
struct AppState {
    identity_path: OnceLock<PathBuf>,
    identity: Mutex<Option<Identity>>,
    conn: Mutex<Option<Connection>>,
    generation: Mutex<u64>,
    devices: Mutex<DeviceChoice>,
    /// Shared with the voice engine and the mic test; changes apply at once, in or out of voice.
    audio: Arc<AudioSettings>,
    ptt: OnceLock<Arc<ptt::Ptt>>,
    mic_test: Mutex<Option<MicTest>>,
    /// When Windows Hello last confirmed the user; unlocks password reset and the phrase briefly.
    hello_verified_at: Mutex<Option<Instant>>,
}

type CmdResult<T = ()> = Result<T, String>;

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
fn logout(state: State<'_, AppState>) {
    disconnect(state.clone());
    if let Some(identity) = state.identity.lock().unwrap().take() {
        remember(&identity, false);
    }
}

/// Moves the current account file aside (never deletes it) so a new account can be created.
#[tauri::command]
fn reset_account(state: State<'_, AppState>) -> CmdResult<String> {
    logout(state.clone());
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
    logout(state.clone());
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
    let path = dir.join(format!("Strom recovery phrase - {}.txt", safe_name.trim()));
    let words: String = phrase
        .split(' ')
        .enumerate()
        .map(|(i, w)| format!("{:>2}. {w}\n", i + 1))
        .collect();
    let text = format!(
        "STRÖM RECOVERY PHRASE\r\n\r\nAccount: {}\r\nStröm ID: {}\r\n\r\n{}\r\n\
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
    let ok = blocking(move || hello::verify(hwnd, "Confirm it's you to reset your Ström password")).await?;
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
        return Err("That recovery phrase belongs to a different Ström ID.".into());
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
    // Taking a generation number first means a newer connect, or a disconnect,
    // started while this one is still logging in makes it give up.
    disconnect(state.clone());
    let generation = *state.generation.lock().unwrap();
    let identity = state.identity.lock().unwrap().clone().ok_or("You are not logged in.")?;
    let mut session = strom_voice::connect(&address, &identity, invite.as_deref(), create.as_deref()).await.map_err(|e| e.to_string())?;
    if *state.generation.lock().unwrap() != generation {
        return Err("superseded".into());
    }
    state.audio.clear_user_volumes();

    let initial = session.roster.clone();
    let me = session.roster.me;
    let ui = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        let mut roster = session.roster;
        while let Some(msg) = session.events.recv().await {
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
                ServerMsg::MessageDeleted { channel, id } => {
                    let _ = ui.emit("message-deleted", serde_json::json!({ "channel": channel, "id": id }));
                }
                ServerMsg::Typing { channel, session_id } => {
                    let _ = ui.emit("typing", serde_json::json!({ "channel": channel, "session_id": session_id }));
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
                ServerMsg::Bans { bans } => {
                    let _ = ui.emit("bans", bans);
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
                    roster.apply(&msg);
                    forget_departed_peers(&ui, generation, &roster);
                    let _ = ui.emit("roster", &roster);
                }
            }
        }
        // The server went away: tear down this connection unless it was already replaced.
        let state = ui.state::<AppState>();
        let mut conn = state.conn.lock().unwrap();
        if conn.as_ref().is_some_and(|c| c.generation == generation) {
            *conn = None;
            let _ = ui.emit("disconnected", "lost connection to server");
        }
    });

    session.control.send(ClientMsg::SetState { muted: state.audio.muted(), deafened: state.audio.deafened() });
    *state.conn.lock().unwrap() = Some(Connection {
        generation,
        control: session.control,
        task,
        udp_addr: session.udp_addr,
        session_id: me,
        udp_token: session.udp_token,
        engine: None,
        voice_peers: HashMap::new(),
        voice_attempt: 0,
    });
    Ok(initial)
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
                let _ = app.emit("voice-state", serde_json::json!({ "ready": false, "error": "Ström Cloud didn't answer. It may be running an older version without voice." }));
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
            let _ = relay.emit("voice", ev);
        }
    });
    c.engine = Some(engine);
    let _ = ui.emit("voice-state", serde_json::json!({ "ready": true }));
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
fn send_chat(state: State<'_, AppState>, channel: ChannelId, text: String) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::SendChat { channel, text }))
}

#[tauri::command]
fn update_server(state: State<'_, AppState>, name: String, icon: Option<String>) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::UpdateServer { name, icon }))
}

#[tauri::command]
fn create_channel(state: State<'_, AppState>, name: String, kind: ChannelKind) -> CmdResult {
    with_conn(&state, |c| c.control.send(ClientMsg::CreateChannel { name, kind }))
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
fn kick(state: State<'_, AppState>, session_id: SessionId, ban: bool) -> CmdResult {
    let msg = if ban { ClientMsg::Ban { session_id } } else { ClientMsg::Kick { session_id } };
    with_conn(&state, |c| c.control.send(msg))
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
/// from Ström Cloud before joining. `cloud` is the cloud's https:// base URL.
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
        .map_err(|e| format!("Couldn't reach Ström Cloud: {e}"))?;
    let status = response.status();
    let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(body["error"].as_str().unwrap_or("This invite is invalid or has expired.").to_string());
    }
    Ok(body)
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
fn list_devices() -> DeviceList {
    strom_voice::list_devices()
}

/// Remembers the device choice and, while in voice, switches to it right away.
#[tauri::command]
async fn set_devices(state: State<'_, AppState>, input: Option<String>, output: Option<String>) -> CmdResult {
    let choice = DeviceChoice { input, output };
    *state.devices.lock().unwrap() = choice.clone();
    match state.conn.lock().unwrap().as_mut().and_then(|c| c.engine.as_mut()) {
        Some(engine) => engine.set_devices(&choice).map_err(|e| format!("audio: {e:#}")),
        None => Ok(()),
    }
}

fn main() {
    tracing_subscriber::fmt().with_env_filter("info").init();
    tauri::Builder::default()
        // Must come first: a second copy hands its link to this one and quits.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| shell::show_main(app)))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .manage(shell::PendingLink::default())
        .on_window_event(shell::on_window_event)
        .setup(|app| {
            shell::setup(app)?;
            let path = app.path().app_data_dir()?.join("identity.json");
            let state = app.state::<AppState>();
            let _ = state.identity_path.set(path);
            let _ = state.ptt.set(ptt::Ptt::start(app.handle().clone(), state.audio.clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            create_channel,
            delete_channel,
            set_loopback,
            local_address,
            invite_preview,
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
        .expect("error while running Ström");
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
