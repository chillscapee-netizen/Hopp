const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};
const SVG_NS = "http://www.w3.org/2000/svg";
/** An icon from the sprite in index.html. */
const icon = (name, extra) => {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", extra ? `i ${extra}` : "i");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
};

const METER_MIN_DB = -60;
const METER_MAX_DB = 0;
const GROUP_WINDOW_MS = 7 * 60 * 1000;
const DEFAULT_PORT = 7777;
/** Where Ström Cloud runs (see cloud/). For local development, `npx wrangler dev` serves ws://127.0.0.1:8787. */
const DEFAULT_CLOUD_URL = "wss://strom-cloud.strom-chat.workers.dev";
const TYPING_SEND_MS = 2500;
const TYPING_SHOW_MS = 6000;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,:;!?)\]'*]/gi;

// ---------- persisted preferences ----------

function load(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}
function loadJson(key, fallback) {
  try { return JSON.parse(load(key, "")) ?? fallback; } catch { return fallback; }
}

const prefs = {
  // [{ id, address, label, customLabel, invite? }]; the invite is kept only until the first successful join.
  // Cloud servers have the address "cloud:<server id>"; self-hosted ones "host:port".
  servers: loadJson("servers", []),
  // The rail's order and folders; see normalizeRail.
  rail: loadJson("rail", []),
  cloudUrl: load("cloudUrl", DEFAULT_CLOUD_URL),
  mode: load("mode", "voice_activity"),
  threshold: Number(load("vad", "-50")),
  noise: load("noise", "1") === "1",
  echo: load("echo", "1") === "1",
  autoGain: load("autoGain", "1") === "1",
  autoSensitivity: load("autoSensitivity", "1") === "1",
  // Push to talk: a Windows virtual-key code (0 = none) and its name when it was recorded.
  pttKey: Number(load("pttKey", "0")),
  pttLabel: load("pttLabel", ""),
  pttDelay: Number(load("pttDelay", "200")),
  sounds: load("sounds", "1") === "1",
  // One switch per kind of sound; missing keys mean on.
  soundEvents: loadJson("soundEvents", {}),
  quietDeafened: load("quietDeafened", "1") === "1",
  soundVolume: Number(load("soundVolume", "50")),
  mutedWarning: load("mutedWarning", "1") === "1",
  inputVolume: Number(load("inputVolume", "100")),
  outputVolume: Number(load("outputVolume", "100")),
  inputDevice: load("inputDevice", ""),
  outputDevice: load("outputDevice", ""),
  showMembers: load("showMembers", "1") === "1",
  // Keyed by user name, since session ids change on every connect.
  userVolumes: loadJson("userVolumes", {}),
};

function newServer(address, label, invite) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    address,
    label: label || address,
    customLabel: !!label,
    invite: invite || undefined,
  };
}
function saveServers() {
  save("servers", JSON.stringify(prefs.servers));
}

const state = {
  account: null, // { name, publicKey }
  activeId: null,
  connectingId: null,
  // Shown on the home view: { kind: "connecting" | "error", server, text }
  notice: null,
  roster: null,
  view: null, // the text channel being read
  unread: new Set(),
  speaking: new Set(),
  // channel id -> Map(session id -> time it expires)
  typing: new Map(),
  muted: false,
  deafened: false,
  // Whether our audio is actually running: { ready, error? }, reset whenever we join a channel.
  voiceState: { ready: false },
  latency: null,
  appliedVolumes: new Map(),
  chats: new Map(),
  kicked: null, // set when the server removed us: { banned }
  // Signed in from another device: the server dropped this one, so don't fight it.
  replaced: false,
  // While the connection is being restored: { server, voice, tries, timer }
  reconnect: null,
  micTesting: false,
  // Bumped on every connect attempt so a slow, superseded attempt is ignored.
  attempt: 0,
};

/** Invokes a command and reports failures as a toast. */
async function call(cmd, args) {
  try {
    return await invoke(cmd, args);
  } catch (err) {
    if (String(err) !== "not connected") toast(friendlyError(err), true);
  }
}

// ---------- small builders ----------

/** Opens a dialog with focus on the dialog itself, so no button starts out outlined. */
function openModal(dialog) {
  dialog.tabIndex = -1;
  dialog.showModal();
  dialog.focus();
}

function initials(text) {
  const words = text.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0]).toUpperCase();
}

function hue(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)) % 360;
  return h;
}

function avatar(name, size, dot) {
  const a = el("span", "avatar" + (size ? ` ${size}` : ""), initials(name || "?").slice(0, size === "s24" ? 1 : 2));
  a.style.setProperty("--hue", hue(name || "?"));
  if (dot) a.append(el("span", `status-dot ${dot}`));
  return a;
}

/** A friendly placeholder for an empty list, with one obvious next step. */
function emptyCta(title, text, action, onClick) {
  const box = el("div", "empty-cta");
  const btn = el("button", "btn sm primary", action);
  btn.addEventListener("click", onClick);
  box.append(el("strong", "", title), el("span", "", text), btn);
  return box;
}

/** A server's picture, or its initials on a tinted square when it has none. */
function serverIcon(className, name, picture) {
  const chip = el("span", className);
  if (picture) {
    const img = el("img");
    img.src = picture;
    img.alt = "";
    // The web view's own image dragging would cancel ours (rail reordering).
    img.draggable = false;
    chip.append(img);
    chip.classList.add("has-picture");
  } else {
    chip.textContent = initials(name || "?");
  }
  chip.style.setProperty("--hue", hue(name || "?"));
  return chip;
}

function serverChip(server) {
  return serverIcon("server-chip", server.label, server.icon);
}

let toastTimer = null;
function toast(text, isError) {
  const t = $("toast");
  t.textContent = text;
  t.classList.toggle("error", !!isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4500);
}

/** Turns OS and protocol errors into something a person can act on. */
function friendlyError(raw) {
  const s = String(raw);
  if (/10061|refused/i.test(s)) return "The server isn't answering. Check that it's running and that the address is right.";
  if (/timed out|did not answer/i.test(s)) return "The server took too long to answer. Check the address and that port 7777 is open.";
  if (/resolve|11001|no such host/i.test(s)) return "Couldn't find a server at that address.";
  if (/protocol/i.test(s)) return "This server runs a different version of Ström. Update the server and the app to the same version.";
  if (/using the default devices instead/i.test(s)) return "Your chosen audio device couldn't be opened, so Ström is using the system default for now.";
  if (/^audio:/i.test(s)) return "Couldn't start audio. Check your input and output devices in User settings.";
  return s;
}

function relativeTime(ms) {
  const minutes = Math.round((ms - Date.now()) / 60000);
  if (minutes < 60) return `${Math.max(minutes, 1)} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

function activeServer() {
  return prefs.servers.find((s) => s.id === state.activeId);
}

function online() {
  return state.activeId !== null && state.roster !== null;
}

const SHORT_INVITE = /^(?:strom:\/\/)?([A-Za-z0-9]{6,16})\/?$/i;
const INVITE_LINK = /\bstrom:\/\/[^\s<>"]+[^\s<>".,:;!?)\]'*]/gi;

/** The code of a short Ström Cloud invite ("strom://K7P2QX9M"), or null. */
function shortInviteCode(input) {
  const m = input.trim().match(SHORT_INVITE);
  // A bare word could be a host name too; only "localhost" is likely, and it has no digits.
  return m && /\d/.test(m[1]) ? m[1].toUpperCase() : null;
}

const previews = new Map();
/** Looks up a short cloud invite: { name, icon, members, online, server_id, code }. Cached per code. */
function invitePreview(code) {
  if (!previews.has(code)) {
    const lookup = invoke("invite_preview", { cloud: prefs.cloudUrl.replace(/^ws/, "http"), code });
    lookup.catch(() => setTimeout(() => previews.delete(code), 30_000));
    previews.set(code, lookup);
  }
  return previews.get(code);
}

/**
 * Splits an invite link into address and invite code. Short links ("strom://CODE") are
 * cloud invites and are resolved with invitePreview; "strom://cloud/<server id>/CODE" is
 * the older cloud form; "strom://host:port/CODE" (or a bare address) is self-hosted.
 */
function parseInvite(input) {
  const s = input.trim().replace(/^strom:\/\//i, "");
  const parts = s.split("/").map((p) => p.trim());
  if (parts[0].toLowerCase() === "cloud" && parts[1]) {
    return { address: `cloud:${parts[1]}`, invite: parts[2]?.toUpperCase() || undefined };
  }
  return { address: parts[0], invite: parts[1]?.toUpperCase() || undefined };
}

function isCloud(server) {
  return server.address.startsWith("cloud:");
}

/** What the backend connects to: a WebSocket URL for cloud servers, host:port otherwise. */
function endpoint(server) {
  return isCloud(server) ? `${prefs.cloudUrl}/servers/${server.address.slice(6)}/ws` : server.address;
}

function displayAddress(server) {
  return isCloud(server) ? "Ström Cloud" : server.address;
}

function newCloudId() {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function openUrl(url) {
  invoke("plugin:opener|open_url", { url }).catch(() => toast("Couldn't open the link.", true));
}

// ---------- roster helpers ----------

function me() {
  const r = state.roster;
  return r && r.users.find((u) => u.session_id === r.me);
}
function isOwner() {
  return !!me()?.owner;
}
function myVoice() {
  return me()?.voice_channel ?? null;
}
function channel(id) {
  return state.roster?.channels.find((c) => c.id === id);
}
function channelName(id) {
  return channel(id)?.name ?? "";
}
function textChannels() {
  return state.roster?.channels.filter((c) => c.kind === "text") ?? [];
}
function voiceChannels() {
  return state.roster?.channels.filter((c) => c.kind === "voice") ?? [];
}
function userName(sessionId) {
  return state.roster?.users.find((u) => u.session_id === sessionId)?.name;
}
function byName(a, b) {
  return a.name.localeCompare(b.name);
}

// ---------- account ----------

const AUTH_PANES = { login: "login-form", create: "create-form", recover: "recover-form" };
const AUTH_FOCUS = { login: "login-password", create: "create-name", recover: "recover-phrase" };
let authMode = null;
let authReturn = "login";
let accountExists = false;

function showAuth(mode) {
  $("shell").classList.add("locked");
  if (mode !== "recover") authReturn = mode;
  authMode = mode;
  for (const [m, id] of Object.entries(AUTH_PANES)) $(id).hidden = m !== mode;
  $("topbar-title").textContent = "Ström";
  const focus = AUTH_FOCUS[mode];
  if (focus) setTimeout(() => $(focus).focus(), 0);
}

async function boot() {
  applyVoicePrefs();
  // Also logs in by itself when "Keep me logged in" was chosen.
  const status = await invoke("account_status");
  accountExists = status.exists;
  if (status.logged_in) return enterApp();
  $("to-login-row").hidden = !status.exists;
  if (status.exists) {
    $("login-name").textContent = status.name;
    showAuth("login");
  } else {
    showAuth("create");
  }
}

async function enterApp() {
  const status = await invoke("account_status");
  state.account = { name: status.name, publicKey: status.public_key, backedUp: status.backed_up };
  accountExists = true;
  $("shell").classList.remove("locked");
  $("settings-name").value = status.name;
  $("remember-toggle").checked = status.remembered;
  renderBackupState();
  renderAll();
  // Started from a strom:// link (or one arrived while logged out): follow it now.
  const link = await invoke("take_pending_link");
  if (link) openLink(link);
}

function setBusy(btn, busy, label) {
  btn.disabled = busy;
  btn.textContent = label;
}

function showError(id, err) {
  $(id).textContent = String(err);
  $(id).hidden = !err;
}

// Show/hide buttons inside password fields.
document.querySelectorAll(".reveal").forEach((btn) =>
  btn.addEventListener("click", () => {
    const input = btn.parentElement.querySelector("input");
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    btn.replaceChildren(icon(show ? "eye-off" : "eye", "sm"));
    btn.setAttribute("aria-label", show ? "Hide password" : "Show password");
  }),
);

/** A rough guide, not a rule: length matters most, variety helps. */
function passwordScore(pw) {
  if (!pw) return null;
  let score = pw.length >= 8 ? 1 : 0;
  if (pw.length >= 12) score++;
  if (pw.length >= 16) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
  return Math.min(score, 4);
}
const STRENGTH = [
  ["Too short", "var(--red)"],
  ["Weak", "var(--red)"],
  ["Okay", "var(--yellow)"],
  ["Good", "var(--green)"],
  ["Strong", "var(--green)"],
];
document.querySelectorAll(".strength").forEach((meter) => {
  const input = $(meter.dataset.for);
  const update = () => {
    const score = passwordScore(input.value);
    const [label, color] = score === null ? ["", "var(--faint)"] : STRENGTH[score];
    meter.style.setProperty("--score", score === null ? "0%" : `${Math.max(score, 0.5) * 25}%`);
    meter.style.setProperty("--strength", color);
    meter.querySelector("b").textContent = label;
  };
  input.addEventListener("input", update);
  update();
});

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("login-btn");
  setBusy(btn, true, "Unlocking…");
  showError("login-error", "");
  try {
    await invoke("login", { password: $("login-password").value, rememberMe: $("login-remember").checked });
    $("login-password").value = "";
    await enterApp();
  } catch (err) {
    showError("login-error", err);
    $("login-password").select();
  } finally {
    setBusy(btn, false, "Log in");
  }
});

$("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("create-error", "");
  const password = $("create-password").value;
  if (password !== $("create-confirm").value) return showError("create-error", "The passwords don't match.");
  const btn = $("create-btn");
  setBusy(btn, true, "Creating your Ström ID…");
  try {
    const created = await invoke("create_account", {
      name: $("create-name").value,
      password,
      rememberMe: $("create-remember").checked,
    });
    $("create-password").value = $("create-confirm").value = "";
    await enterApp();
    // Straight to the backup: a new account isn't safe until the phrase is saved.
    openBackup({ phrase: created.recovery_phrase });
  } catch (err) {
    showError("create-error", err);
  } finally {
    setBusy(btn, false, "Create account");
  }
});

function fillPhrase(list, phrase) {
  list.replaceChildren(...phrase.split(" ").map((w) => el("li", "", w)));
}

async function copyText(text, btn, label) {
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = "Copied!";
  } catch {
    btn.textContent = "Couldn't copy";
  }
  setTimeout(() => (btn.textContent = label), 1800);
}


$("to-create").addEventListener("click", async () => {
  const ok = await confirmDialog({
    title: "Create a new Ström ID?",
    text: "Your current account isn't deleted. It's kept as a backup in the app's folder, but from now on you'll log in with the new one. Forgot your password? Use your recovery phrase instead.",
    ok: "Create new account",
  });
  if (!ok) return;
  await call("reset_account");
  accountExists = false;
  $("to-login-row").hidden = true;
  showAuth("create");
});
$("to-login").addEventListener("click", () => showAuth("login"));
document.querySelectorAll('[data-auth="recover"]').forEach((b) =>
  b.addEventListener("click", () => {
    $("recover-phrase").value = "";
    $("recover-check").hidden = true;
    $("recover-name-field").hidden = true;
    showError("recover-error", "");
    showAuth("recover");
  }),
);
document.querySelectorAll('[data-auth="back"]').forEach((b) => b.addEventListener("click", () => showAuth(accountExists ? authReturn : "create")));

// Tells the user whose account a phrase belongs to before anything is replaced.
let phraseCheck = null;
let checkTimer = null;
$("recover-phrase").addEventListener("input", () => {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(checkPhrase, 250);
});
async function checkPhrase() {
  const phrase = $("recover-phrase").value;
  const status = $("recover-check");
  const words = phrase.split(/[\s,]+/).filter((w) => /[a-z]/i.test(w));
  phraseCheck = null;
  status.classList.remove("ok");
  if (words.length < 24) {
    status.hidden = words.length === 0;
    status.textContent = `${words.length} of 24 words`;
    $("recover-name-field").hidden = true;
    return;
  }
  try {
    phraseCheck = await invoke("check_recovery_phrase", { phrase });
  } catch (err) {
    status.textContent = String(err);
    status.hidden = false;
    return;
  }
  status.hidden = false;
  if (phraseCheck.matches_this_computer) {
    status.classList.add("ok");
    status.textContent = `This is the recovery phrase for ${$("login-name").textContent || "your account"}.`;
  } else if (phraseCheck.other_account_name) {
    status.textContent = `This is a different Ström ID. The account on this computer (${phraseCheck.other_account_name}) will be kept as a backup.`;
  } else {
    status.classList.add("ok");
    status.textContent = "Valid recovery phrase. Choose the name you want to use.";
  }
  $("recover-name-field").hidden = phraseCheck.matches_this_computer;
}

$("recover-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("recover-error", "");
  await checkPhrase();
  if (!phraseCheck) return showError("recover-error", "Enter all 24 words of your recovery phrase.");
  const password = $("recover-password").value;
  if (password !== $("recover-confirm").value) return showError("recover-error", "The passwords don't match.");
  const name = $("recover-name").value.trim();
  if (!phraseCheck.matches_this_computer && !name) return showError("recover-error", "Choose a display name.");
  const btn = $("recover-btn");
  setBusy(btn, true, "Restoring…");
  try {
    await invoke("recover_account", {
      phrase: $("recover-phrase").value,
      name: name || null,
      password,
      rememberMe: $("recover-remember").checked,
    });
    $("recover-phrase").value = $("recover-password").value = $("recover-confirm").value = "";
    await enterApp();
  } catch (err) {
    showError("recover-error", err);
  } finally {
    setBusy(btn, false, "Restore account");
  }
});

async function logout() {
  $("settings").close();
  cancelReconnect();
  state.attempt++;
  state.connectingId = null;
  await call("logout");
  state.account = null;
  renderBackupState();
  state.activeId = null;
  state.roster = null;
  state.notice = null;
  boot();
}
$("logout-btn").addEventListener("click", logout);

// ---------- password & recovery in settings ----------

// How the user proves it's them before choosing a new password:
// "current" (old password), "hello" (Windows Hello confirmed) or "phrase" (recovery phrase).
let passwordProof = "current";

function setPasswordProof(proof) {
  passwordProof = proof;
  showError("cp-status", "");
  $("cp-current-field").hidden = proof !== "current";
  $("cp-phrase-field").hidden = proof !== "phrase";
  $("cp-hello-note").hidden = proof !== "hello";
  const focus = { current: "cp-current", phrase: "cp-phrase", hello: "cp-new" }[proof];
  $(focus).focus();
}

$("change-password-btn").addEventListener("click", () => {
  for (const id of ["cp-current", "cp-phrase", "cp-new", "cp-confirm"]) $(id).value = "";
  $("change-password-form").hidden = false;
  setPasswordProof("current");
});
document.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", () => ($(b.dataset.cancel).hidden = true)));

// Don't remember the current password: Windows Hello or the recovery phrase proves it's you instead.
$("cp-use-hello").addEventListener("click", async () => {
  if (!(await invoke("windows_hello_available"))) {
    return showError("cp-status", "Windows Hello isn't set up on this computer (a PIN is enough: Windows Settings → Accounts → Sign-in options). Use your recovery phrase instead.");
  }
  try {
    await invoke("verify_with_windows_hello");
    setPasswordProof("hello");
  } catch (err) {
    showError("cp-status", err);
  }
});
$("cp-use-phrase").addEventListener("click", () => setPasswordProof("phrase"));
$("cp-use-password").addEventListener("click", () => setPasswordProof("current"));

$("change-password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const newPassword = $("cp-new").value;
  if (newPassword !== $("cp-confirm").value) return showError("cp-status", "The new passwords don't match.");
  if (passwordProof === "current" && !$("cp-current").value) return showError("cp-status", "Enter your current password.");
  const btn = $("cp-save");
  setBusy(btn, true, "Saving…");
  try {
    if (passwordProof === "hello") {
      await invoke("set_password_with_hello", { newPassword });
    } else if (passwordProof === "phrase") {
      await invoke("set_password_with_phrase", { phrase: $("cp-phrase").value, newPassword });
      // Typing the whole phrase proves it's saved.
      state.account.backedUp = true;
      renderBackupState();
    } else {
      await invoke("change_password", { current: $("cp-current").value, newPassword });
    }
    $("change-password-form").hidden = true;
    $("cp-phrase").value = "";
    toast("Your password was changed.");
  } catch (err) {
    showError("cp-status", err);
  } finally {
    setBusy(btn, false, "Save password");
  }
});

$("remember-toggle").addEventListener("change", (e) => call("set_remember_me", { on: e.target.checked }));
$("settings").addEventListener("close", () => ($("change-password-form").hidden = true));

// ---------- recovery phrase backup ----------
//
// A new account isn't safe until its phrase is saved, so saving is checked, not
// just shown: the user types back three random words, verified by the backend.

const backup = { phrase: "", positions: [], viewOnly: false };

function renderBackupState() {
  const backedUp = !!state.account?.backedUp;
  $("backup-pill").hidden = !state.account || backedUp;
  const badge = $("backup-badge");
  badge.textContent = backedUp ? "Backed up" : "Not backed up";
  badge.className = `status-badge ${backedUp ? "ok" : "missing"}`;
  const btn = $("backup-btn");
  btn.textContent = backedUp ? "View phrase" : "Back up now";
  btn.classList.toggle("primary", !backedUp);
}

function backupStep(step) {
  document.querySelectorAll("#backup-dialog [data-bstep]").forEach((s) => (s.hidden = s.dataset.bstep !== step));
}

/** With `phrase` (right after creating an account) it starts at the phrase; otherwise asks who you are first. */
async function openBackup({ phrase = null, viewOnly = false } = {}) {
  backup.viewOnly = viewOnly;
  $("backup-later").hidden = viewOnly;
  $("backup-written").textContent = viewOnly ? "Done" : "I've saved it";
  $("backup-file-note").textContent = "";
  if (phrase) {
    setBackupPhrase(phrase);
  } else {
    $("backup-password").value = "";
    showError("backup-verify-error", "");
    $("backup-hello").hidden = !(await invoke("windows_hello_available").catch(() => false));
    backupStep("verify");
  }
  openModal($("backup-dialog"));
  if (!phrase) $("backup-password").focus();
}

function setBackupPhrase(phrase) {
  backup.phrase = phrase;
  fillPhrase($("backup-words"), phrase);
  backupStep("phrase");
}

$("backup-verify").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("backup-verify-btn");
  setBusy(btn, true, "Checking…");
  try {
    setBackupPhrase(await invoke("show_recovery_phrase", { password: $("backup-password").value }));
  } catch (err) {
    showError("backup-verify-error", err);
  } finally {
    setBusy(btn, false, "Continue");
  }
});
$("backup-hello").addEventListener("click", async () => {
  try {
    await invoke("verify_with_windows_hello");
    setBackupPhrase(await invoke("recovery_phrase_with_hello"));
  } catch (err) {
    showError("backup-verify-error", err);
  }
});

$("backup-copy").addEventListener("click", (e) => copyText(backup.phrase, e.currentTarget, "Copy"));
$("backup-file").addEventListener("click", async () => {
  try {
    const path = await invoke("save_recovery_file", { phrase: backup.phrase });
    $("backup-file-note").textContent = `Saved to ${path}`;
  } catch (err) {
    $("backup-file-note").textContent = String(err);
  }
});

$("backup-written").addEventListener("click", () => {
  if (backup.viewOnly) return closeBackup();
  // Three different random words, in order, so the user must really have the phrase.
  const positions = new Set();
  while (positions.size < 3) positions.add(1 + Math.floor(Math.random() * 24));
  backup.positions = [...positions].sort((a, b) => a - b);
  $("backup-quiz-fields").replaceChildren(
    ...backup.positions.map((p) => {
      const field = el("label", "field");
      const input = el("input");
      input.autocomplete = "off";
      input.spellcheck = false;
      input.dataset.position = p;
      field.append(el("span", "field-label", `Word #${p}`), input);
      return field;
    }),
  );
  showError("backup-quiz-error", "");
  // The words disappear from the page so they have to come from what was saved.
  $("backup-words").replaceChildren();
  backupStep("quiz");
  $("backup-quiz-fields").querySelector("input").focus();
});

$("backup-quiz").addEventListener("submit", async (e) => {
  e.preventDefault();
  const answers = [...$("backup-quiz-fields").querySelectorAll("input")].map((i) => [Number(i.dataset.position), i.value]);
  const btn = $("backup-quiz-btn");
  setBusy(btn, true, "Checking…");
  try {
    await invoke("confirm_backup", { answers });
    state.account.backedUp = true;
    renderBackupState();
    backup.phrase = "";
    backupStep("done");
  } catch (err) {
    showError("backup-quiz-error", err);
  } finally {
    setBusy(btn, false, "Confirm");
  }
});

document.querySelectorAll("[data-backup]").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.backup === "close") return closeBackup();
    fillPhrase($("backup-words"), backup.phrase);
    backupStep("phrase");
  }),
);

async function remindLater() {
  const ok = await confirmDialog({
    title: "Skip saving your phrase?",
    text: "If you forget your password without it, this account is gone for good. Nobody, not even Ström, can get it back. You'll see a reminder until you've saved it.",
    ok: "Remind me later",
  });
  if (ok) closeBackup();
}
$("backup-later").addEventListener("click", remindLater);

// Escape mustn't silently skip the backup of a fresh account.
$("backup-dialog").addEventListener("cancel", (e) => {
  if (backup.viewOnly || state.account?.backedUp || $("backup-dialog").querySelector('[data-bstep="verify"]').hidden === false) return;
  e.preventDefault();
  remindLater();
});

function closeBackup() {
  backup.phrase = "";
  $("backup-words").replaceChildren();
  $("backup-dialog").close();
}

$("backup-pill").addEventListener("click", () => openBackup());
$("backup-btn").addEventListener("click", () => openBackup({ viewOnly: !!state.account?.backedUp }));

// ---------- server rail ----------

// ---------- server rail: order, folders and dragging ----------
//
// prefs.rail is the rail from top to bottom: { id } for a server, or
// { folder, name, color, open, ids } for a folder of servers. Drag a server
// onto another to make a folder, between two to move it, out of a folder to
// take it out. A folder left with one server dissolves.

const FOLDER_COLORS = ["#7f8ea3", "#5b84c4", "#4a9e94", "#5c9e62", "#c4963f", "#c46457", "#b46590", "#8b72c4"];

function saveRail() {
  save("rail", JSON.stringify(prefs.rail));
}

/** Keeps the rail in step with the server list: every server once, no empty folders. */
function normalizeRail() {
  const known = new Set(prefs.servers.map((s) => s.id));
  const seen = new Set();
  const take = (id) => known.has(id) && !seen.has(id) && !!seen.add(id);
  const out = [];
  for (const item of prefs.rail) {
    if (item.folder) {
      item.ids = item.ids.filter(take);
      if (item.ids.length >= 2) out.push(item);
      else if (item.ids.length === 1) out.push({ id: item.ids[0] });
    } else if (take(item.id)) {
      out.push({ id: item.id });
    }
  }
  for (const s of prefs.servers) if (!seen.has(s.id)) out.push({ id: s.id });
  prefs.rail = out;
}

function serverById(id) {
  return prefs.servers.find((s) => s.id === id);
}

function isActiveServer(id) {
  return id === state.activeId || id === state.connectingId;
}

function railServer(s, folder) {
  const b = el("button", "rail-item");
  b.dataset.tip = s.label;
  b.dataset.tipPos = "right";
  b.dataset.server = s.id;
  if (folder) b.dataset.inFolder = folder.folder;
  b.classList.toggle("active", isActiveServer(s.id));
  b.classList.toggle("connecting", s.id === state.connectingId);
  b.append(serverIcon("rail-icon server-tint", s.label, s.icon));
  b.addEventListener("click", () => {
    if (railDrag.justDropped) return;
    if (!isActiveServer(s.id)) connectTo(s);
  });
  b.addEventListener("contextmenu", (e) => openServerMenu(s, e.clientX, e.clientY));
  return b;
}

function folderName(f) {
  return f.name || f.ids.map((id) => serverById(id)?.label).filter(Boolean).join(", ");
}

function railFolder(f) {
  const color = f.color || FOLDER_COLORS[0];
  const hasActive = f.ids.some(isActiveServer);
  const head = el("button", "rail-item folder-head");
  head.dataset.folder = f.folder;
  head.dataset.tip = folderName(f);
  head.dataset.tipPos = "right";
  head.style.setProperty("--folder", color);
  head.classList.toggle("active", hasActive && !f.open);
  head.addEventListener("click", () => {
    if (railDrag.justDropped) return;
    f.open = !f.open;
    saveRail();
    renderRail();
  });
  head.addEventListener("contextmenu", (e) => openFolderMenu(f, e.clientX, e.clientY));

  if (!f.open) {
    const box = el("span", "rail-icon folder-closed");
    for (const id of f.ids.slice(0, 4)) {
      const s = serverById(id);
      if (s) box.append(serverIcon("folder-mini server-tint", s.label, s.icon));
    }
    head.append(box);
    return head;
  }
  const wrap = el("div", "folder-open");
  wrap.style.setProperty("--folder", color);
  const glyph = el("span", "rail-icon folder-glyph");
  glyph.append(icon("folder"));
  head.append(glyph);
  wrap.append(head, ...f.ids.map(serverById).filter(Boolean).map((s) => railServer(s, f)));
  return wrap;
}

function renderRail() {
  $("home-btn").classList.toggle("active", !state.activeId && !state.connectingId);
  normalizeRail();
  $("server-list").replaceChildren(
    ...prefs.rail.map((item) => (item.folder ? railFolder(item) : railServer(serverById(item.id)))),
  );
}

// ---------- dragging ----------

const railDrag = { justDropped: false };
const DRAG_START_PX = 5;

/** Where something dropped at height y would land: next to, or onto, which item. */
function dropTarget(y, dragged) {
  const items = [...document.querySelectorAll("#server-list [data-server], #server-list [data-folder]")];
  for (const node of items) {
    const r = node.getBoundingClientRect();
    if (y < r.top - 4 || y > r.bottom + 4) continue;
    const id = node.dataset.server ?? null;
    const folder = node.dataset.folder ?? null;
    if ((id && id === dragged.id) || (folder && folder === dragged.folder)) return { kind: "self" };
    const rel = (y - r.top) / r.height;
    const zone = rel < 0.28 ? "before" : rel > 0.72 ? "after" : "onto";
    // Folders don't go into folders.
    const kind = zone === "onto" && dragged.folder ? (rel < 0.5 ? "before" : "after") : zone;
    return { kind, node, id, folder, inFolder: node.dataset.inFolder ?? null };
  }
  const list = $("server-list").getBoundingClientRect();
  return y > list.top ? { kind: "end" } : { kind: "start" };
}

/** Takes the dragged server or folder out of the rail, returning it. */
function takeFromRail(dragged) {
  if (dragged.folder) {
    const i = prefs.rail.findIndex((x) => x.folder === dragged.folder);
    return prefs.rail.splice(i, 1)[0];
  }
  for (const [i, item] of prefs.rail.entries()) {
    if (item.folder) {
      const j = item.ids.indexOf(dragged.id);
      if (j >= 0) {
        item.ids.splice(j, 1);
        return { id: dragged.id };
      }
    } else if (item.id === dragged.id) {
      return prefs.rail.splice(i, 1)[0];
    }
  }
  return { id: dragged.id };
}

function applyDrop(dragged, target) {
  if (target.kind === "self") return;
  const moving = takeFromRail(dragged);
  const topIndex = (pred) => prefs.rail.findIndex(pred);
  const folderOf = (fid) => prefs.rail.find((x) => x.folder === fid);

  if (target.kind === "start") prefs.rail.unshift(moving);
  else if (target.kind === "end") prefs.rail.push(moving);
  else if (target.kind === "onto" && target.folder) {
    // Onto a folder: in it goes, at the end.
    const f = folderOf(target.folder);
    f.ids.push(moving.id);
    f.open = true;
  } else if (target.kind === "onto" && target.inFolder) {
    // Onto a server inside a folder: into that folder, next to it.
    const f = folderOf(target.inFolder);
    f.ids.splice(f.ids.indexOf(target.id) + 1, 0, moving.id);
  } else if (target.kind === "onto") {
    // Onto a loose server: the two become a folder where it was.
    const i = topIndex((x) => x.id === target.id);
    prefs.rail.splice(i, 1, { folder: `f${Date.now().toString(36)}`, name: "", color: FOLDER_COLORS[0], open: false, ids: [target.id, moving.id] });
    toast("Folder created. Right-click it to name it.");
  } else if (target.kind === "after" && target.folder && !moving.folder && folderOf(target.folder)?.open) {
    // Just below an open folder's head: first in the folder.
    folderOf(target.folder).ids.unshift(moving.id);
  } else if (target.inFolder && !moving.folder) {
    // Between servers inside an open folder.
    const f = folderOf(target.inFolder);
    f.ids.splice(f.ids.indexOf(target.id) + (target.kind === "after" ? 1 : 0), 0, moving.id);
  } else {
    // Between items at the top level (a folder dropped inside one lands next to it).
    const key = target.inFolder ? (x) => x.folder === target.inFolder : target.folder ? (x) => x.folder === target.folder : (x) => x.id === target.id;
    const i = topIndex(key);
    prefs.rail.splice(i + (target.kind === "after" ? 1 : 0), 0, moving);
  }
  normalizeRail();
  saveRail();
  renderRail();
}

// Native drag-and-drop (images, links) would take over the pointer; the rail does its own.
$("server-list").addEventListener("dragstart", (e) => e.preventDefault());

$("server-list").addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const node = e.target.closest("[data-server], [data-folder]");
  if (!node) return;
  // Keep every move and the release coming here, even over other parts of the window.
  try {
    node.setPointerCapture(e.pointerId);
  } catch {
    // Not a live pointer (synthetic events); window listeners still follow it.
  }
  const dragged = node.dataset.server ? { id: node.dataset.server } : { folder: node.dataset.folder };
  const startY = e.clientY;
  let ghost = null;
  let line = null;
  let combine = null;
  let target = null;

  let lastY = startY;
  let scrollTimer = null;
  const rail = document.querySelector(".rail");
  // Near the top or bottom of the rail, keep scrolling so far-away servers are reachable.
  const autoScroll = () => {
    const r = rail.getBoundingClientRect();
    const speed = lastY < r.top + 48 ? -8 : lastY > r.bottom - 48 ? 8 : 0;
    if (speed) {
      rail.scrollTop += speed;
      track(lastY);
    }
  };
  const cancelOnEsc = (ev) => {
    if (ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    target = null;
    up({ type: "pointerup" });
  };
  const track = (y) => {
    target = dropTarget(y, dragged);
    combine?.classList.remove("drop-onto");
    combine = null;
    line.hidden = true;
    if (target.kind === "onto") {
      combine = target.node;
      combine.classList.add("drop-onto");
    } else if (target.node) {
      const r = target.node.getBoundingClientRect();
      const railBox = rail.getBoundingClientRect();
      line.hidden = false;
      line.style.left = `${railBox.left + 16}px`;
      line.style.width = `${railBox.width - 32}px`;
      line.style.top = `${(target.kind === "before" ? r.top - 4 : r.bottom + 4) - 1}px`;
    }
  };
  const move = (ev) => {
    lastY = ev.clientY;
    if (!ghost) {
      if (Math.abs(ev.clientY - startY) < DRAG_START_PX) return;
      ghost = (node.querySelector(".rail-icon") ?? node).cloneNode(true);
      ghost.classList.add("drag-ghost");
      document.body.append(ghost);
      line = el("div", "drop-line");
      document.body.append(line);
      node.classList.add("dragging");
      document.body.classList.add("rail-dragging");
      tip.hidden = true;
      scrollTimer = setInterval(autoScroll, 16);
      window.addEventListener("keydown", cancelOnEsc, true);
    }
    ghost.style.left = `${ev.clientX - 24}px`;
    ghost.style.top = `${ev.clientY - 24}px`;
    track(ev.clientY);
  };
  const up = (ev) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    try {
      node.releasePointerCapture(e.pointerId);
    } catch {
      // Already released.
    }
    if (!ghost) return;
    // Cancelled (the window lost the mouse, say): put everything back as it was.
    if (ev.type === "pointercancel") target = null;
    clearInterval(scrollTimer);
    window.removeEventListener("keydown", cancelOnEsc, true);
    document.body.classList.remove("rail-dragging");
    ghost.remove();
    line.remove();
    combine?.classList.remove("drop-onto");
    node.classList.remove("dragging");
    // The click that ends a drag isn't a click on the server.
    railDrag.justDropped = true;
    setTimeout(() => (railDrag.justDropped = false), 0);
    if (target) applyDrop(dragged, target);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
});

// ---------- folder settings ----------

let editingFolder = null;
function openFolderMenu(f, x, y) {
  openMenu(
    [
      { label: f.open ? "Close folder" : "Open folder", icon: "folder", action: () => { f.open = !f.open; saveRail(); renderRail(); } },
      { label: "Folder settings", icon: "settings", action: () => openFolderSettings(f) },
      "sep",
      { label: "Ungroup", icon: "x", danger: true, action: () => ungroup(f) },
    ],
    x,
    y,
  );
}

/** Takes a server out of its folder and puts it just below the folder. */
function removeFromFolder(id, f) {
  f.ids = f.ids.filter((x) => x !== id);
  const i = prefs.rail.findIndex((x) => x.folder === f.folder);
  prefs.rail.splice(i + 1, 0, { id });
  normalizeRail();
  saveRail();
  renderRail();
}

function ungroup(f) {
  const i = prefs.rail.findIndex((x) => x.folder === f.folder);
  prefs.rail.splice(i, 1, ...f.ids.map((id) => ({ id })));
  saveRail();
  renderRail();
}

function openFolderSettings(f) {
  editingFolder = f;
  $("folder-name").value = f.name || "";
  $("folder-name").placeholder = folderName({ ...f, name: "" });
  renderFolderColors(f.color || FOLDER_COLORS[0]);
  openModal($("folder-dialog"));
  setTimeout(() => $("folder-name").select(), 0);
}

function renderFolderColors(selected) {
  $("folder-colors").replaceChildren(
    ...FOLDER_COLORS.map((c) => {
      const b = el("button", "swatch");
      b.type = "button";
      b.style.setProperty("--swatch", c);
      b.classList.toggle("active", c === selected);
      b.setAttribute("aria-label", `Colour ${c}`);
      b.addEventListener("click", () => renderFolderColors(c));
      return b;
    }),
  );
  $("folder-colors").dataset.selected = selected;
}

$("folder-form").addEventListener("submit", () => {
  if (!editingFolder) return;
  editingFolder.name = $("folder-name").value.trim();
  editingFolder.color = $("folder-colors").dataset.selected;
  saveRail();
  renderRail();
});

$("home-btn").addEventListener("click", () => {
  if (state.activeId || state.connectingId) disconnect();
});

function removeServer(server) {
  if (server.id === state.activeId) disconnect();
  prefs.servers = prefs.servers.filter((s) => s.id !== server.id);
  saveServers();
  renderAll();
}

/**
 * A context menu: items are { label, sub?, icon?, danger?, checked?, action }, { heading } or "sep".
 * With `above`, the menu opens upwards from y (for buttons at the bottom of the window).
 */
function openMenu(items, x, y, above) {
  const menu = $("server-menu");
  delete menu.dataset.owner;
  menu.classList.toggle("wide", items.some((i) => i.checked !== undefined));
  menu.replaceChildren(
    ...items.map((item) => {
      if (item === "sep") return el("div", "menu-sep");
      if (item.heading) return el("div", "menu-heading", item.heading);
      const b = el("button", "menu-item" + (item.danger ? " danger" : "") + (item.checked ? " checked" : ""));
      const text = el("span", "menu-text");
      text.append(el("span", "ellipsis", item.label));
      if (item.sub) text.append(el("small", "ellipsis", item.sub));
      b.append(text);
      if (item.checked !== undefined) b.append(el("span", "menu-radio"));
      else if (item.icon) b.append(icon(item.icon));
      b.addEventListener("click", () => {
        closePopovers();
        item.action();
      });
      return b;
    }),
  );
  placePopover(menu, x, y);
  if (above) menu.style.top = `${Math.max(8, y - menu.offsetHeight - 8)}px`;
}

function openServerMenu(server, x, y) {
  const active = server.id === state.activeId;
  const folder = prefs.rail.find((item) => item.folder && item.ids.includes(server.id));
  openMenu(
    [
      active
        ? { label: "Disconnect", icon: "logout", action: disconnect }
        : { label: "Connect", icon: "link", action: () => connectTo(server) },
      ...(folder ? [{ label: "Remove from folder", icon: "folder", action: () => removeFromFolder(server.id, folder) }] : []),
      "sep",
      { label: "Remove from list", icon: "trash", danger: true, action: () => removeServer(server) },
    ],
    x,
    y,
  );
}

// ---------- connection ----------

/** Connects to a server; `create` (a name) creates a new cloud server first. Resolves to whether it worked. */
const RECONNECT_DELAYS = [1, 2, 4, 8, 15, 30];

/** The connection dropped by accident: try again with growing pauses, and go back into voice. */
function startReconnect(server, voice) {
  cancelReconnect();
  state.reconnect = { server, voice, tries: 0, timer: null };
  scheduleReconnect();
}

function scheduleReconnect() {
  const r = state.reconnect;
  if (!r) return;
  const seconds = RECONNECT_DELAYS[Math.min(r.tries, RECONNECT_DELAYS.length - 1)];
  state.notice = { kind: "error", server: r.server, text: `${r.server.label}: Lost the connection. Reconnecting in ${seconds} s…`, reconnecting: true };
  renderAll();
  r.timer = setTimeout(() => reconnectNow(), seconds * 1000);
}

async function reconnectNow() {
  const r = state.reconnect;
  if (!r) return;
  clearTimeout(r.timer);
  const ok = await connectTo(r.server, undefined, true);
  if (state.reconnect !== r) return;
  if (ok) {
    state.reconnect = null;
    if (r.voice !== null && voiceChannels().some((c) => c.id === r.voice)) joinVoice(r.voice);
    return;
  }
  r.tries++;
  scheduleReconnect();
}

function cancelReconnect() {
  if (state.reconnect) clearTimeout(state.reconnect.timer);
  state.reconnect = null;
}

// Back online after a network outage: don't wait for the next attempt.
window.addEventListener("online", () => {
  if (state.reconnect) reconnectNow();
});

async function connectTo(server, create, reconnecting) {
  if (!reconnecting) cancelReconnect();
  const attempt = ++state.attempt;
  if (state.activeId) await call("disconnect");
  state.activeId = null;
  state.roster = null;
  state.kicked = null;
  state.connectingId = server.id;
  // The server view shows a placeholder while connecting; Home only comes back on errors.
  state.notice = null;
  // Reset per-server state before connecting: the server sends chat history
  // while `connect` is still resolving, and it must not be wiped afterwards.
  state.speaking.clear();
  state.typing.clear();
  state.appliedVolumes.clear();
  state.unread.clear();
  state.chats.clear();
  state.latency = null;
  renderAll();

  try {
    const roster = await invoke("connect", { address: endpoint(server), invite: server.invite ?? null, create: create ?? null });
    if (attempt !== state.attempt) {
      // Superseded by Home: nothing else is connecting, so drop this connection.
      if (!state.activeId && !state.connectingId) invoke("disconnect").catch(() => {});
      return false;
    }
    state.roster = roster;
    state.activeId = server.id;
    state.notice = null;
    rememberServerLook(server, roster);
    // We're a member now; the invite has done its job.
    delete server.invite;
    saveServers();
    if (!textChannels().some((c) => c.id === state.view)) state.view = textChannels()[0]?.id ?? null;
    renderedChannel = undefined;
    applyUserVolumes();
    return true;
  } catch (err) {
    if (attempt !== state.attempt) return false;
    state.notice = { kind: "error", server, text: String(err) };
    return false;
  } finally {
    if (attempt === state.attempt) state.connectingId = null;
    renderAll();
  }
}

async function disconnect() {
  cancelReconnect();
  state.attempt++;
  await call("disconnect");
  state.activeId = null;
  state.connectingId = null;
  state.roster = null;
  state.notice = null;
  renderAll();
}

async function joinVoice(id) {
  if (myVoice() === id) return;
  state.voiceState = { ready: false };
  state.latency = null;
  await call("join_voice", { channel: id });
}

$("hangup-btn").addEventListener("click", () => call("leave_voice"));

// ---------- server & voice events ----------

/** Keeps the saved name and picture in step with the server, for the rail and Home. */
function rememberServerLook(server, roster) {
  let changed = false;
  if (!server.customLabel && roster.server_name && server.label !== roster.server_name) {
    server.label = roster.server_name;
    changed = true;
  }
  const icon = roster.server_icon ?? undefined;
  if (server.icon !== icon) {
    server.icon = icon;
    changed = true;
  }
  if (changed) saveServers();
}

/** Who is in my voice channel, for the join and leave sounds. */
function voiceCompany() {
  const mine = myVoice();
  if (mine === null || !state.roster) return new Set();
  return new Set(state.roster.users.filter((u) => u.voice_channel === mine && u.session_id !== state.roster.me).map((u) => u.session_id));
}

listen("roster", (e) => {
  const before = myVoice();
  const companyBefore = voiceCompany();
  state.roster = e.payload;
  const after = myVoice();
  if (before === null && after !== null) playSound("join");
  else if (before !== null && after === null) playSound("leave");
  else if (after !== null && before === after) {
    const company = voiceCompany();
    if ([...company].some((id) => !companyBefore.has(id))) playSound("user_join");
    else if ([...companyBefore].some((id) => !company.has(id))) playSound("user_leave");
  }
  // Joining or leaving voice swaps the microphone underneath a running mic test.
  if (state.micTesting && before !== myVoice()) stopMicTest();
  const server = activeServer();
  if (server) rememberServerLook(server, state.roster);
  if ($("server-settings").open) {
    $("server-settings-name").textContent = server?.label ?? state.roster.server_name;
    if (!overviewChanged() || $("overview-save").disabled) resetOverview();
    else renderOverview();
  }
  if (before !== null && myVoice() === null) {
    state.speaking.clear();
    state.latency = null;
  }
  if (!textChannels().some((c) => c.id === state.view)) state.view = textChannels()[0]?.id ?? null;
  applyUserVolumes();
  renderAll();
});

listen("voice", (e) => {
  const ev = e.payload;
  if (ev.type === "speaking") {
    ev.speaking ? state.speaking.add(ev.session_id) : state.speaking.delete(ev.session_id);
    document.querySelectorAll(`[data-user="${ev.session_id}"]`).forEach((n) => n.classList.toggle("speaking", ev.speaking));
    if (state.roster && ev.session_id === state.roster.me) renderUserPanel();
  } else if (ev.type === "latency") {
    state.latency = ev.ms;
    renderVoicePanel();
  } else if (ev.type === "input_level") {
    updateMeter(ev.db, ev.voice);
  } else if (ev.type === "devices_changed") {
    devicesChanged();
  } else if (ev.type === "speaking_while_muted" && prefs.mutedWarning) {
    playSound("muted");
    toast("You're muted. Press Ctrl+M or click the microphone to unmute.");
  }
});

listen("chat", (e) => {
  const m = e.payload;
  if (m.sender !== state.roster?.me && !document.hasFocus()) playSound("message");
  if (!state.chats.has(m.channel)) state.chats.set(m.channel, []);
  state.chats.get(m.channel).push(m);
  state.typing.get(m.channel)?.delete(m.sender);
  if (m.channel === state.view) {
    renderMessages(true);
    renderTyping();
  } else if (m.sender !== state.roster?.me) {
    state.unread.add(m.channel);
    renderSidebar();
  }
});

listen("chat-history", (e) => {
  state.chats.set(e.payload.channel, e.payload.messages);
  if (e.payload.channel === state.view) renderMessages(false);
});

listen("message-deleted", (e) => {
  const { channel: ch, id } = e.payload;
  const list = state.chats.get(ch);
  if (!list) return;
  state.chats.set(ch, list.filter((m) => m.id !== id));
  if (ch === state.view) renderMessages(true);
});

listen("typing", (e) => {
  const { channel: ch, session_id } = e.payload;
  if (!state.typing.has(ch)) state.typing.set(ch, new Map());
  state.typing.get(ch).set(session_id, Date.now() + TYPING_SHOW_MS);
  if (ch === state.view) renderTyping();
});

listen("kicked", (e) => {
  state.kicked = { banned: e.payload };
});

listen("invite-created", (e) => showInvite(e.payload));
listen("invites", (e) => renderInviteList(e.payload));
listen("bans", (e) => renderBanList(e.payload));

listen("disconnected", () => {
  const server = activeServer();
  const voice = myVoice();
  playSound("disconnect");
  state.activeId = null;
  state.roster = null;
  if (server && !state.kicked && !state.replaced) {
    startReconnect(server, voice);
    return;
  }
  const text = state.replaced
    ? "You connected to this server from another device, so this one was signed out."
    : state.kicked
    ? state.kicked.banned ? "You were banned from this server." : "You were kicked from this server. You can rejoin."
    : "Lost the connection to the server.";
  state.notice = { kind: "error", server: state.kicked?.banned ? null : server, text: server ? `${server.label}: ${text}` : text };
  state.kicked = null;
  state.replaced = false;
  renderAll();
});

listen("server-error", (e) => {
  const text = String(e.payload);
  if (/from somewhere else/i.test(text)) state.replaced = true;
  toast(text, true);
});
listen("voice-state", (e) => {
  state.voiceState = e.payload;
  if (e.payload.error) toast(friendlyError(e.payload.error), true);
  renderVoicePanel();
});

// ---------- rendering ----------

function connectingServer() {
  return state.connectingId ? prefs.servers.find((s) => s.id === state.connectingId) : null;
}

function renderAll() {
  if (!state.account) return;
  const on = online();
  const loading = !on && !!connectingServer();
  $("shell").classList.toggle("offline", !on && !loading);
  $("shell").classList.toggle("loading", loading);
  $("topbar-title").textContent = on ? activeServer()?.label ?? state.roster.server_name : loading ? connectingServer().label : "Ström";
  renderRail();
  renderSidebar();
  renderVoicePanel();
  renderUserPanel();
  if (on) renderChannelView();
  else if (loading) renderLoading();
  else renderHome();
}

/** Grey placeholder bars of varying width, standing in for content that is on its way. */
function skeleton(className, widths) {
  return widths.map((w) => {
    const row = el("div", className);
    const bar = el("span", "skeleton");
    bar.style.width = typeof w === "number" ? `${w}%` : w;
    row.append(bar);
    return row;
  });
}

/** The server view while connecting: its name right away, the rest as placeholders. */
function renderLoading() {
  const server = connectingServer();
  const view = document.querySelector(".channel-view");
  view.classList.toggle("no-members", !prefs.showMembers);
  $("chat-channel").textContent = "";
  $("chat-topic").textContent = "";
  $("composer").hidden = true;
  renderedChannel = undefined;
  const msgs = [];
  for (const [name, lines] of [[30, [62, 38]], [22, [80]], [26, [45, 70, 30]], [18, [55]]]) {
    const li = el("li", "msg first skeleton-msg");
    const head = el("div", "msg-head");
    const bar = el("span", "skeleton");
    bar.style.width = `${name}%`;
    head.append(bar);
    li.append(el("span", "avatar s40 skeleton"), head, ...skeleton("skeleton-line", lines));
    msgs.push(li);
  }
  const loadingNote = el("li", "loading-note");
  loadingNote.append(el("span", "spinner"), el("span", "", `Connecting to ${server.label}…`));
  $("messages").replaceChildren(loadingNote, ...msgs);
  const members = [el("li", "member-group skeleton-group")];
  for (const w of [58, 44, 66, 50]) {
    const li = el("li", "member skeleton-member");
    const bar = el("span", "skeleton");
    bar.style.width = `${w}%`;
    li.append(el("span", "avatar skeleton"), bar);
    members.push(li);
  }
  $("member-list").replaceChildren(...members);
}

function category(label, onAdd) {
  const cat = el("div", "category");
  cat.append(icon("chevron"), el("span", "", label));
  if (onAdd) {
    const add = el("button", "category-add");
    add.dataset.tip = "Create channel";
    add.append(icon("plus"));
    add.addEventListener("click", onAdd);
    cat.append(add);
  }
  return cat;
}

function renderSidebar() {
  const body = $("sidebar-body");
  const head = $("sidebar-head");
  const pending = !online() && connectingServer();
  if (pending) {
    $("sidebar-title").textContent = pending.label;
    head.disabled = true;
    body.replaceChildren(
      category("Text channels"),
      ...skeleton("channel-row skeleton-row", [62, 48, 70]),
      category("Voice channels"),
      ...skeleton("channel-row skeleton-row", [54, 40]),
    );
    return;
  }
  if (!online()) {
    $("sidebar-title").textContent = "Ström";
    head.disabled = true;
    const rows = prefs.servers.map((s) => {
      const b = el("button", "server-row");
      const text = el("span", "row-text");
      text.append(el("span", "row-title ellipsis", s.label), el("span", "row-sub ellipsis", displayAddress(s)));
      b.append(serverChip(s), text);
      b.addEventListener("click", () => connectTo(s));
      b.addEventListener("contextmenu", (e) => openServerMenu(s, e.clientX, e.clientY));
      return b;
    });
    const cat = el("div", "category");
    cat.append(el("span", "", "Your servers"));
    body.replaceChildren(cat, ...(rows.length ? rows : [el("div", "sidebar-empty", "No servers yet.")]));
    return;
  }

  const r = state.roster;
  head.disabled = false;
  $("sidebar-title").textContent = activeServer()?.label ?? r.server_name;
  const owner = isOwner();
  const items = [];

  items.push(category("Text channels", owner ? () => openChannelDialog("text") : null));
  for (const ch of textChannels()) {
    const row = el("button", "channel-row");
    row.classList.toggle("current", ch.id === state.view);
    row.classList.toggle("unread", state.unread.has(ch.id) && ch.id !== state.view);
    row.append(icon("hash"), el("span", "ellipsis", ch.name));
    row.addEventListener("click", () => openTextChannel(ch.id));
    if (owner) row.addEventListener("contextmenu", (e) => openChannelMenu(ch, e));
    items.push(row);
  }
  if (textChannels().length === 0) items.push(el("div", "empty-channels", "No text channels"));

  items.push(category("Voice channels", owner ? () => openChannelDialog("voice") : null));
  const mine = myVoice();
  for (const ch of voiceChannels()) {
    const wrap = el("div");
    const row = el("button", "channel-row");
    row.classList.toggle("in-voice", ch.id === mine);
    row.dataset.tip = ch.id === mine ? "You're here" : `Join ${ch.name}`;
    row.append(icon("volume"), el("span", "ellipsis", ch.name));
    row.addEventListener("click", () => joinVoice(ch.id));
    if (owner) row.addEventListener("contextmenu", (e) => openChannelMenu(ch, e));
    const users = r.users.filter((u) => u.voice_channel === ch.id).sort(byName);
    const list = el("ul", "voice-users");
    list.append(...users.map((u) => userRow(u, "voice-user", "s24")));
    wrap.append(row, list);
    items.push(wrap);
  }
  if (voiceChannels().length === 0) items.push(el("div", "empty-channels", "No voice channels"));

  body.replaceChildren(...items);
}

function openTextChannel(id) {
  state.view = id;
  state.unread.delete(id);
  renderSidebar();
  renderChannelView();
  $("chat-input").focus();
}

function openChannelMenu(ch, e) {
  e.preventDefault();
  e.stopPropagation();
  openMenu([{ label: "Delete channel", icon: "trash", danger: true, action: () => deleteChannel(ch) }], e.clientX, e.clientY);
}

async function deleteChannel(ch) {
  const what = ch.kind === "text" ? `#${ch.name} and all of its messages` : ch.name;
  const ok = await confirmDialog({ title: "Delete channel", text: `Delete ${what}? This can't be undone.`, ok: "Delete channel" });
  if (ok) call("delete_channel", { channel: ch.id });
}

function flagsFor(u) {
  if (!u.muted && !u.deafened) return null;
  const flags = el("span", "flags");
  if (u.muted) flags.append(icon("mic-off", "xs off"));
  if (u.deafened) flags.append(icon("headphones-off", "xs off"));
  return flags;
}

function userRow(u, className, size, sub) {
  const isSelf = u.session_id === state.roster.me;
  const row = el("li", className + (isSelf ? " self" : "") + (state.speaking.has(u.session_id) ? " speaking" : ""));
  row.dataset.user = u.session_id;
  row.append(avatar(u.name, size));
  const nameLine = el("span", "name-line");
  nameLine.append(el("span", className === "member" ? "member-name ellipsis" : "ellipsis", u.name));
  if (u.owner) {
    const crown = icon("crown", "crown");
    nameLine.append(crown);
  }
  if (sub) {
    const info = el("span", "member-info");
    const subLine = el("span", "member-sub");
    subLine.append(icon("volume", "xs"), el("span", "ellipsis", sub));
    info.append(nameLine, subLine);
    row.append(info);
  } else {
    row.append(nameLine);
  }
  const flags = flagsFor(u);
  const vol = prefs.userVolumes[u.name];
  if (flags) row.append(flags);
  else if (!isSelf && vol !== undefined && vol !== 100) row.append(el("span", "vol-tag", vol === 0 ? "Muted" : `${vol}%`));
  if (!isSelf) row.addEventListener("click", () => openUserCard(u, row));
  return row;
}

function renderVoicePanel() {
  const panel = $("voice-panel");
  const voice = online() ? myVoice() : null;
  panel.hidden = voice === null;
  if (panel.hidden) return;
  const status = panel.querySelector(".voice-status");
  const ms = state.latency;
  const { ready, error } = state.voiceState;
  status.classList.toggle("warn", !error && (!ready || (ms !== null && ms >= 80 && ms < 150)));
  status.classList.toggle("bad", !!error || (ms !== null && ms >= 150));
  $("voice-status-text").textContent = error ? "Voice unavailable" : ready ? "Voice connected" : "Starting voice…";
  const latency = ms === null ? null : ms < 1 ? "<1 ms" : `${ms} ms`;
  const direct = isCloud(activeServer());
  const alone = !state.roster.users.some((u) => u.session_id !== state.roster.me && u.voice_channel === voice);
  // Cloud voice is peer to peer: the number is the slowest round trip to the others.
  status.dataset.tip = error ? friendlyError(error) : !ready ? "Opening your microphone and finding the others…" : direct
    ? latency ? `Direct to the others, slowest round trip ${latency}` : alone ? "Voice goes straight to the others when they join" : "Connecting to the others…"
    : latency ? `Latency to the server: ${latency}` : "Measuring latency…";
  const where = `${channelName(voice)} / ${activeServer()?.label ?? state.roster.server_name}`;
  $("voice-where").textContent = latency ? `${where} · ${latency}` : where;
}

function renderUserPanel() {
  const on = online();
  const name = state.account?.name ?? "";
  $("me-avatar-slot").replaceChildren(avatar(name, "", on ? "online" : "offline"));
  const card = $("me-card");
  card.dataset.user = on ? state.roster.me : "";
  const live = on && state.speaking.has(state.roster.me);
  card.classList.toggle("speaking", live);
  $("me-name").textContent = name;

  const status = $("me-status");
  const sending = live && !state.muted && !state.deafened;
  const voice = on ? myVoice() : null;
  status.classList.toggle("live", sending);
  status.textContent = !on
    ? state.connectingId ? "Connecting…" : "Offline"
    : state.deafened ? "Deafened"
    : state.muted ? "Muted"
    : sending ? "Speaking"
    : voice !== null && prefs.mode === "push_to_talk" && !prefs.pttKey ? "No push-to-talk key"
    : voice !== null ? (state.micTesting ? "Hearing yourself" : `In ${channelName(voice)}`)
    : "Online";

  // Deafened also means nobody hears you, so the microphone shows as off too.
  const silent = state.muted || state.deafened;
  const mute = $("mute-btn");
  mute.classList.toggle("on", silent);
  mute.parentElement.classList.toggle("on", silent);
  $("deafen-btn").parentElement.classList.toggle("on", state.deafened);
  mute.replaceChildren(icon(silent ? "mic-off" : "mic"));
  mute.dataset.tip = silent ? "Unmute" : "Mute";
  const deafen = $("deafen-btn");
  deafen.classList.toggle("on", state.deafened);
  deafen.replaceChildren(icon(state.deafened ? "headphones-off" : "headphones"));
  deafen.dataset.tip = state.deafened ? "Undeafen" : "Deafen";
}

function renderChannelView() {
  const r = state.roster;
  const view = state.view;
  $("chat-channel").textContent = view === null ? "No text channels" : channelName(view);
  $("chat-topic").textContent = `${r.users.length} online`;
  $("composer").hidden = view === null;
  $("chat-input").placeholder = `Message #${channelName(view)}`;
  document.querySelector(".channel-view").classList.toggle("no-members", !prefs.showMembers);
  $("members-toggle").classList.toggle("selected", prefs.showMembers);
  $("members-toggle").dataset.tip = prefs.showMembers ? "Hide member list" : "Show member list";
  renderMembers();
  if (renderedChannel !== view) {
    renderMessages(false);
    renderTyping();
  }
}

$("members-toggle").addEventListener("click", () => {
  prefs.showMembers = !prefs.showMembers;
  save("showMembers", prefs.showMembers ? "1" : "0");
  renderChannelView();
});

function renderMembers() {
  const users = [...state.roster.users].sort(byName);
  const groups = [
    ["Owner", users.filter((u) => u.owner)],
    ["Online", users.filter((u) => !u.owner)],
  ];
  const items = [];
  for (const [label, list] of groups) {
    if (list.length === 0) continue;
    items.push(el("li", "member-group", `${label} — ${list.length}`));
    items.push(...list.map((u) => userRow(u, "member", "", u.voice_channel !== null ? channelName(u.voice_channel) : null)));
  }
  if (users.length === 1) {
    items.push(emptyCta("It's just you here", "Invite friends to chat and talk.", "Invite people", openInvite));
  }
  $("member-list").replaceChildren(...items);
}

// ---------- messages ----------

let renderedChannel;

function dayLabel(ms) {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

const LINK_PATTERN = new RegExp(`${URL_PATTERN.source}|${INVITE_LINK.source}`, "gi");

/** Opens an invite from chat: switches to the server if we're already in it. */
async function followInvite(link) {
  const code = shortInviteCode(link);
  let address = null;
  try {
    address = code ? `cloud:${(await invitePreview(code)).server_id}` : parseInvite(link).address;
  } catch (err) {
    toast(friendlyError(err), true);
    return;
  }
  const known = prefs.servers.find((s) => s.address === address);
  if (known && known.id === state.activeId) return;
  if (known) connectTo(known);
  else {
    const error = await joinInvite(link);
    if (error) toast(error, true);
  }
}

/** Message text with web and invite links made clickable; everything else stays plain text. */
function messageText(text) {
  const out = el("div", "msg-text");
  let last = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    out.append(text.slice(last, match.index));
    const a = el("a", "msg-link", match[0]);
    a.href = match[0];
    a.addEventListener("click", (e) => {
      e.preventDefault();
      if (/^strom:/i.test(match[0])) followInvite(match[0]);
      else openUrl(match[0]);
    });
    out.append(a);
    last = match.index + match[0].length;
  }
  out.append(text.slice(last));
  return out;
}

function canDelete(m) {
  return isOwner() || (state.account && m.author_key === state.account.publicKey);
}

async function deleteMessage(m, skipConfirm) {
  if (!skipConfirm) {
    const ok = await confirmDialog({
      title: "Delete message",
      text: "Delete this message for everyone? Tip: hold Shift when clicking the bin to skip this.",
      ok: "Delete",
    });
    if (!ok) return;
  }
  call("delete_message", { channel: m.channel, id: m.id });
}

function renderMessages(keepScrollUnlessAtBottom) {
  const scroller = $("scroller");
  const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
  renderedChannel = state.view;
  if (state.view === null) {
    const empty = el("li", "welcome");
    const badge = el("div", "welcome-icon");
    badge.append(icon("hash"));
    const hint = isOwner() ? "Create one with the + next to Text channels." : "The server owner hasn't created one yet.";
    empty.append(badge, el("h1", "", "No text channels"), el("p", "", hint));
    $("messages").replaceChildren(empty);
    return;
  }
  const name = channelName(state.view);
  const msgs = state.chats.get(state.view) || [];

  const welcome = el("li", "welcome");
  const badge = el("div", "welcome-icon");
  badge.append(icon("hash"));
  welcome.append(badge, el("h1", "", `Welcome to #${name}!`), el("p", "", `This is the start of the #${name} channel.`));
  if (msgs.length === 0 && isOwner()) {
    const actions = el("div", "welcome-actions");
    const invite = el("button", "btn primary sm", "Invite people");
    invite.addEventListener("click", openInvite);
    actions.append(invite);
    welcome.append(actions);
  }

  const items = [welcome];
  let prev = null;
  for (const m of msgs) {
    const day = dayLabel(m.sent_at);
    const newDay = !prev || dayLabel(prev.sent_at) !== day;
    if (newDay) items.push(el("li", "day-divider", day));
    const grouped = !newDay && prev.sender_name === m.sender_name && m.sent_at - prev.sent_at < GROUP_WINDOW_MS;
    const li = el("li", "msg " + (grouped ? "cont" : "first"));
    if (grouped) {
      li.append(el("span", "msg-gutter", clock(m.sent_at)));
    } else {
      const head = el("div", "msg-head");
      const author = el("span", "msg-author", m.sender_name);
      author.style.color = `hsl(${hue(m.sender_name)} 22% 80%)`;
      head.append(author, el("span", "msg-time", `${day} at ${clock(m.sent_at)}`));
      li.append(avatar(m.sender_name, "s40"), head);
    }
    li.append(messageText(m.text));
    for (const link of new Set([...m.text.matchAll(INVITE_LINK)].map((x) => x[0]).slice(0, 3))) {
      const code = shortInviteCode(link);
      if (code) li.append(inviteEmbed(code, link));
    }
    if (canDelete(m)) {
      const actions = el("div", "msg-actions");
      const del = el("button", "icon-btn sm danger-hover");
      del.dataset.tip = "Delete message";
      del.append(icon("trash", "sm"));
      del.addEventListener("click", (e) => deleteMessage(m, e.shiftKey));
      actions.append(del);
      li.append(actions);
    }
    items.push(li);
    prev = m;
  }
  $("messages").replaceChildren(...items);
  if (!keepScrollUnlessAtBottom || atBottom) scroller.scrollTop = scroller.scrollHeight;
}

/** An invite posted in chat, shown as a card with the server's name, picture and a Join button. */
function inviteEmbed(code, link) {
  const slot = el("div", "invite-embed");
  slot.append(...skeleton("invite-card loading", ["50%"]));
  invitePreview(code).then(
    (p) => {
      const scroller = $("scroller");
      const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
      const { card, row } = inviteCard(p, "You've been invited to join a server");
      const known = prefs.servers.find((s) => s.address === `cloud:${p.server_id}`);
      const here = known && known.id === state.activeId;
      const btn = el("button", "btn sm " + (here ? "" : "primary"), here ? "Joined" : known ? "Open" : "Join");
      btn.disabled = here;
      btn.addEventListener("click", () => followInvite(link));
      row.append(btn);
      slot.replaceChildren(card);
      if (atBottom) scroller.scrollTop = scroller.scrollHeight;
    },
    () => {
      const card = el("div", "invite-card invalid");
      card.append(el("span", "invite-card-kicker", "Invite"));
      const row = el("div", "invite-card-row");
      const ic = el("span", "invite-icon server-tint");
      ic.append(icon("x"));
      row.append(ic, el("div", "invite-card-text", "This invite is invalid or has expired."));
      card.append(row);
      slot.replaceChildren(card);
    },
  );
  return slot;
}

function renderTyping() {
  const now = Date.now();
  const typers = state.typing.get(state.view);
  const names = [];
  for (const [id, until] of typers ?? []) {
    const name = until > now ? userName(id) : null;
    if (name) names.push(name);
    else typers.delete(id);
  }
  const box = $("typing");
  if (names.length === 0) {
    box.replaceChildren();
    return;
  }
  const who = names.length === 1 ? `${names[0]} is` : names.length === 2 ? `${names[0]} and ${names[1]} are` : "Several people are";
  const dots = el("span", "typing-dots");
  dots.append(el("i"), el("i"), el("i"));
  const text = el("span");
  text.append(el("strong", "", who.replace(/ (is|are)$/, "")), who.match(/ (is|are)$/)[0], " typing…");
  box.replaceChildren(dots, text);
}
setInterval(() => {
  if (online()) renderTyping();
}, 1000);

// ---------- home ----------

function renderHome() {
  const body = $("home-body");
  const sections = [];
  const n = state.notice;

  if (n) {
    const wrap = el("section", "home-section");
    const banner = el("div", "banner" + (n.kind === "error" ? " error" : ""));
    if (n.kind === "connecting") {
      banner.append(el("span", "spinner"), el("span", "grow", `Connecting to ${n.server.label} (${displayAddress(n.server)})…`));
    } else {
      const text = el("span", "grow");
      const friendly = friendlyError(n.text);
      text.append(n.server && !n.text.startsWith(n.server.label) ? `${n.server.label}: ${friendly}` : friendly);
      if (friendly !== n.text) text.append(el("span", "banner-detail", n.text));
      banner.append(text);
      if (n.server) {
        const retry = el("button", "btn sm", n.reconnecting ? "Reconnect now" : "Try again");
        retry.addEventListener("click", () => (n.reconnecting ? reconnectNow() : connectTo(n.server)));
        banner.append(retry);
      }
    }
    wrap.append(banner);
    sections.push(wrap);
  }

  const intro = el("section", "home-section");
  intro.append(
    el("h1", "", `Hi ${state.account.name}!`),
    el("p", "lead", prefs.servers.length
      ? "Pick a server to read and write in its channels, and join a voice channel when you want to talk."
      : "You're not in any servers yet. Create one in a click, or join one with an invite link."),
  );
  sections.push(intro);

  const list = el("section", "home-section");
  list.append(el("h3", "", `Your servers — ${prefs.servers.length}`));
  const cards = el("div", "server-cards");
  for (const s of prefs.servers) {
    const card = el("div", "server-card");
    const top = el("div", "server-card-top");
    const text = el("div", "row-text");
    text.append(el("span", "server-card-name ellipsis", s.label), el("span", "server-card-addr ellipsis", displayAddress(s)));
    top.append(serverChip(s), text);
    const join = el("button", "btn primary full", s.id === state.connectingId ? "Connecting…" : "Connect");
    join.disabled = s.id === state.connectingId;
    join.addEventListener("click", () => connectTo(s));
    card.append(top, join);
    card.addEventListener("contextmenu", (e) => openServerMenu(s, e.clientX, e.clientY));
    cards.append(card);
  }
  const add = el("button", "server-card add");
  add.append(icon("plus"), el("span", "", "Add a server"));
  add.addEventListener("click", () => openAddDialog("choose"));
  cards.append(add);
  list.append(cards);
  sections.push(list);

  body.replaceChildren(...sections);
}

// ---------- add a server ----------

function showStep(step) {
  document.querySelectorAll("#add-dialog [data-step]").forEach((s) => (s.hidden = s.dataset.step !== step));
  if (step === "join") setTimeout(() => $("join-address").focus(), 0);
  if (step === "create") {
    const input = $("create-server-name");
    if (!input.value) input.value = `${state.account?.name ?? "My"}'s server`;
    $("create-server-error").hidden = true;
    updateServerIconPreview();
    setTimeout(() => input.select(), 0);
  }
}

function updateServerIconPreview() {
  const name = $("create-server-name").value.trim() || "?";
  const icon = $("create-server-icon");
  icon.textContent = initials(name);
  icon.style.setProperty("--hue", hue(name));
}
$("create-server-name").addEventListener("input", updateServerIconPreview);

$("create-server-form").addEventListener("submit", async (e) => {
  // Keep the dialog open until the server exists, so errors can be shown in place.
  e.preventDefault();
  const name = $("create-server-name").value.trim();
  if (!name) return;
  const btn = $("create-server-btn");
  setBusy(btn, true, "Creating…");
  const server = newServer(`cloud:${newCloudId()}`, "");
  server.label = name;
  prefs.servers.push(server);
  saveServers();
  const ok = await connectTo(server, name);
  setBusy(btn, false, "Create");
  if (ok) {
    $("add-dialog").close();
    $("create-server-name").value = "";
    return;
  }
  // Nothing was created; don't leave a dead entry behind.
  prefs.servers = prefs.servers.filter((s) => s.id !== server.id);
  saveServers();
  const error = $("create-server-error");
  error.textContent = friendlyError(state.notice?.text ?? "Couldn't create the server.");
  error.hidden = false;
  state.notice = null;
  renderAll();
});
function openAddDialog(step) {
  $("join-address").value = "";
  updateJoinPreview();
  showStep(step);
  openModal($("add-dialog"));
}
$("add-server").addEventListener("click", () => openAddDialog("choose"));
document.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => showStep(b.dataset.goto)));

/** Adds a server to the list (or reuses it) and connects. */
function addAndConnect(address, invite, label) {
  if (!address) return;
  let server = prefs.servers.find((s) => s.address === address);
  if (!server) {
    server = newServer(address, "", invite);
    if (label) server.label = label;
    prefs.servers.push(server);
  } else if (invite) {
    server.invite = invite;
  }
  saveServers();
  connectTo(server);
}

/** Joins from any invite link; short cloud links are looked up first. Resolves to an error text or null. */
async function joinInvite(input) {
  const code = shortInviteCode(input);
  if (code) {
    try {
      const p = await invitePreview(code);
      addAndConnect(`cloud:${p.server_id}`, p.code, p.name);
      return null;
    } catch (err) {
      return friendlyError(err);
    }
  }
  const { address, invite } = parseInvite(input);
  if (!address) return "Paste an invite link.";
  addAndConnect(address, invite);
  return null;
}

/** The server an invite leads to, with its picture and how many are around. */
function inviteCard(p, kicker) {
  const card = el("div", "invite-card");
  if (kicker) card.append(el("span", "invite-card-kicker", kicker));
  const row = el("div", "invite-card-row");
  const text = el("div", "invite-card-text");
  const counts = el("span", "invite-counts");
  const on = el("span", "count");
  on.append(el("i", "count-dot online"), `${p.online} Online`);
  const all = el("span", "count");
  all.append(el("i", "count-dot"), `${p.members} ${p.members === 1 ? "Member" : "Members"}`);
  counts.append(on, all);
  text.append(el("strong", "ellipsis", p.name), counts);
  row.append(serverIcon("invite-icon server-tint", p.name, p.icon), text);
  card.append(row);
  return { card, row };
}

let previewTimer = null;
function updateJoinPreview() {
  const input = $("join-address").value;
  const box = $("join-preview");
  const code = shortInviteCode(input);
  $("join-error").hidden = true;
  clearTimeout(previewTimer);
  if (!code) {
    box.hidden = true;
    $("join-hint").hidden = false;
    return;
  }
  previewTimer = setTimeout(async () => {
    box.hidden = false;
    $("join-hint").hidden = true;
    box.replaceChildren(...skeleton("invite-card loading", ["60%"]));
    try {
      const p = await invitePreview(code);
      if (shortInviteCode($("join-address").value) !== code) return;
      box.replaceChildren(inviteCard(p).card);
    } catch (err) {
      if (shortInviteCode($("join-address").value) !== code) return;
      box.hidden = true;
      $("join-error").textContent = friendlyError(err);
      $("join-error").hidden = false;
    }
  }, 250);
}
$("join-address").addEventListener("input", updateJoinPreview);

$("join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("join-btn");
  setBusy(btn, true, "Joining…");
  const error = await joinInvite($("join-address").value);
  setBusy(btn, false, "Join server");
  if (error) {
    $("join-error").textContent = error;
    $("join-error").hidden = false;
    return;
  }
  $("add-dialog").close();
});
$("host-connect").addEventListener("click", () => {
  $("add-dialog").close();
  addAndConnect("localhost");
});
document.querySelectorAll(".close-dialog").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

// ---------- server menu & channels ----------

$("sidebar-head").addEventListener("click", (e) => {
  if (!online()) return;
  e.stopPropagation();
  const head = $("sidebar-head");
  const r = head.getBoundingClientRect();
  const items = [{ label: "Invite people", icon: "user-plus", action: openInvite }];
  if (isOwner()) {
    items.push({ label: "Server settings", icon: "settings", action: openServerSettings });
    items.push("sep");
    items.push({ label: "Create text channel", icon: "hash", action: () => openChannelDialog("text") });
    items.push({ label: "Create voice channel", icon: "volume", action: () => openChannelDialog("voice") });
  }
  items.push("sep", { label: "Disconnect", icon: "logout", danger: true, action: disconnect });
  openMenu(items, r.left + 8, r.bottom + 4);
  $("server-menu").style.width = `${r.width - 16}px`;
  head.classList.add("open");
});

let channelKind = "text";
function setChannelKind(kind) {
  channelKind = kind;
  document.querySelectorAll(".type-option").forEach((b) => b.classList.toggle("active", b.dataset.kind === kind));
  $("channel-name-icon").replaceChildren(...icon(kind === "text" ? "hash" : "volume").childNodes);
  $("channel-name").placeholder = kind === "text" ? "new-channel" : "New voice channel";
}
document.querySelectorAll(".type-option").forEach((b) => b.addEventListener("click", () => setChannelKind(b.dataset.kind)));

function openChannelDialog(kind) {
  $("channel-dialog-sub").textContent = `in ${activeServer()?.label ?? state.roster.server_name}`;
  $("channel-name").value = "";
  setChannelKind(kind);
  openModal($("channel-dialog"));
  $("channel-name").focus();
}
$("channel-name").addEventListener("input", (e) => {
  // Show text channel names the way the server will store them.
  if (channelKind === "text") e.target.value = e.target.value.toLowerCase().replace(/\s/g, "-");
});
$("channel-form").addEventListener("submit", () => {
  const name = $("channel-name").value.trim();
  if (name) call("create_channel", { name, kind: channelKind });
});

// ---------- invites ----------

let lanAddress = null;

/** The host:port others should use: this computer's LAN address if we're connected locally. */
async function shareableAddress() {
  const server = activeServer();
  if (isCloud(server)) return { address: null, local: false, cloud: true };
  const [host, port = String(DEFAULT_PORT)] = server.address.split(":");
  if (!/^(localhost|127\.|::1)/i.test(host)) return { address: `${host}:${port}`, local: false, port };
  lanAddress ??= await call("local_address");
  return { address: `${lanAddress ?? host}:${port}`, local: true, port };
}

function requestInvite() {
  const hours = $("invite-expiry").value;
  const uses = $("invite-uses").value;
  $("invite-link").value = "";
  $("invite-summary").textContent = "";
  call("create_invite", { maxUses: uses ? Number(uses) : null, expiresInHours: hours ? Number(hours) : null });
}

function inviteSummary(invite) {
  const when = invite.expires_at ? `expires in ${relativeTime(invite.expires_at)}` : "never expires";
  const uses = invite.max_uses ? ` and can be used ${invite.max_uses === 1 ? "once" : `${invite.max_uses} times`}` : "";
  return `Your invite link ${when}${uses}.`;
}

async function showInvite(invite) {
  if (!$("invite-dialog").open) return;
  const { address } = await shareableAddress();
  // Cloud: strom://CODE. Self-hosted: strom://host:port/CODE.
  $("invite-link").value = address ? `strom://${address}/${invite.code}` : `strom://${invite.code}`;
  $("invite-summary").textContent = inviteSummary(invite);
}

async function openInvite() {
  const server = activeServer();
  $("invite-server").textContent = server.label;
  $("invite-icon-slot").replaceChildren(serverIcon("invite-icon server-tint", server.label, server.icon));
  const owner = isOwner();
  $("invite-owner").hidden = !owner;
  $("invite-member").hidden = owner;
  $("invite-options").hidden = true;
  $("invite-edit").hidden = false;
  openModal($("invite-dialog"));
  if (!owner) return;
  const { local, port } = await shareableAddress();
  const note = $("invite-note");
  note.textContent = local
    ? `This link works for people on your network. For friends elsewhere, port ${port} (TCP and UDP) must be open in your router and they need your public IP address instead.`
    : "";
  note.hidden = !local;
  requestInvite();
}
$("invite-head-btn").addEventListener("click", openInvite);
$("invite-edit").addEventListener("click", () => {
  $("invite-options").hidden = false;
  $("invite-edit").hidden = true;
});
$("invite-generate").addEventListener("click", () => {
  requestInvite();
  $("invite-options").hidden = true;
  $("invite-edit").hidden = false;
});
$("invite-copy").addEventListener("click", async () => {
  const btn = $("invite-copy");
  const link = $("invite-link").value;
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    $("invite-link").select();
    document.execCommand("copy");
  }
  btn.textContent = "Copied!";
  btn.classList.add("copied");
  setTimeout(() => {
    btn.textContent = "Copy";
    btn.classList.remove("copied");
  }, 1800);
});

// ---------- server settings (owner) ----------

function openServerSettings() {
  $("server-settings-name").textContent = activeServer()?.label ?? state.roster.server_name;
  resetOverview();
  showServerTab("overview");
  $("invite-list").replaceChildren(el("li", "admin-empty", "Loading…"));
  $("ban-list").replaceChildren(el("li", "admin-empty", "Loading…"));
  openModal($("server-settings"));
  call("get_server_settings");
}
function showServerTab(tab) {
  document.querySelectorAll("[data-stab]").forEach((t) => t.classList.toggle("active", t.dataset.stab === tab));
  document.querySelectorAll("[data-spanel]").forEach((p) => (p.hidden = p.dataset.spanel !== tab));
}
document.querySelectorAll("[data-stab]").forEach((t) => t.addEventListener("click", () => showServerTab(t.dataset.stab)));

// Overview: the owner edits the server's name and picture; saved together, like Discord.
const overview = { icon: null };

function resetOverview() {
  overview.icon = state.roster?.server_icon ?? null;
  $("overview-name").value = state.roster?.server_name ?? "";
  $("overview-error").hidden = true;
  renderOverview();
}

function overviewChanged() {
  const r = state.roster;
  return !!r && ($("overview-name").value.trim() !== r.server_name || overview.icon !== (r.server_icon ?? null));
}

function renderOverview() {
  const name = $("overview-name").value.trim() || state.roster?.server_name || "?";
  $("overview-icon-slot").replaceChildren(serverIcon("overview-preview server-tint", name, overview.icon));
  $("overview-remove").hidden = !overview.icon;
  $("overview-save-bar").hidden = !overviewChanged();
}

/** Scales a picture down to a square of at most 256 px, small enough to send to the server. */
function shrinkPicture(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      for (const [size, quality] of [[256, 0.9], [256, 0.75], [192, 0.7], [128, 0.7]]) {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = Math.min(size, side);
        // Crop to the centre square.
        canvas.getContext("2d").drawImage(
          img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, canvas.width, canvas.height,
        );
        let data = canvas.toDataURL("image/webp", quality);
        if (!data.startsWith("data:image/webp")) data = canvas.toDataURL("image/jpeg", quality);
        if (data.length <= 190_000) return resolve(data);
      }
      reject(new Error("That picture is too large. Try a smaller one."));
    };
    const unreadable = () => reject(new Error("That file isn't a picture Ström can read. Use PNG, JPEG or WebP."));
    img.onerror = unreadable;
    // Read it as a data: URL; the app's security policy doesn't allow blob: pictures.
    const reader = new FileReader();
    reader.onload = () => (img.src = reader.result);
    reader.onerror = unreadable;
    reader.readAsDataURL(file);
  });
}

$("overview-icon").addEventListener("click", () => $("overview-file").click());
$("overview-upload").addEventListener("click", () => $("overview-file").click());
$("overview-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    overview.icon = await shrinkPicture(file);
    $("overview-error").hidden = true;
  } catch (err) {
    $("overview-error").textContent = err.message;
    $("overview-error").hidden = false;
  }
  renderOverview();
});
$("overview-remove").addEventListener("click", () => {
  overview.icon = null;
  renderOverview();
});
$("overview-name").addEventListener("input", renderOverview);
$("overview-reset").addEventListener("click", resetOverview);
$("overview-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("overview-name").value.trim();
  if (!name) return;
  const btn = $("overview-save");
  setBusy(btn, true, "Saving…");
  try {
    await invoke("update_server", { name, icon: overview.icon });
    $("overview-error").hidden = true;
  } catch (err) {
    $("overview-error").textContent = friendlyError(err);
    $("overview-error").hidden = false;
  }
  setBusy(btn, false, "Save changes");
});

function adminRow(main, sub, actionLabel, action) {
  const li = el("li", "admin-row");
  const text = el("span", "admin-text");
  text.append(main, el("span", "admin-sub", sub));
  const btn = el("button", "btn sm danger-soft", actionLabel);
  btn.addEventListener("click", action);
  li.append(text, btn);
  return li;
}

function renderInviteList(invites) {
  const list = $("invite-list");
  if (invites.length === 0) {
    list.replaceChildren(el("li", "admin-empty", "No active invites. Create one with Invite people."));
    return;
  }
  list.replaceChildren(
    ...invites.map((inv) => {
      const uses = inv.max_uses ? `${inv.uses} of ${inv.max_uses} uses` : `${inv.uses} uses`;
      const expiry = inv.expires_at ? `expires in ${relativeTime(inv.expires_at)}` : "never expires";
      return adminRow(el("code", "admin-code", inv.code), `${uses} · ${expiry}`, "Revoke", () =>
        call("revoke_invite", { code: inv.code }),
      );
    }),
  );
}

function renderBanList(bans) {
  const list = $("ban-list");
  if (bans.length === 0) {
    list.replaceChildren(el("li", "admin-empty", "Nobody is banned."));
    return;
  }
  list.replaceChildren(
    ...bans.map((ban) => {
      const who = el("span", "admin-who");
      who.append(avatar(ban.name, "s24"), el("strong", "", ban.name));
      const when = new Date(ban.banned_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
      return adminRow(who, `Banned ${when}`, "Unban", () => call("unban", { publicKey: ban.public_key }));
    }),
  );
}

// ---------- confirm ----------

function confirmDialog({ title, text, ok, cancel = "Cancel", danger = true }) {
  const dialog = $("confirm-dialog");
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  $("confirm-ok").textContent = ok;
  $("confirm-cancel").textContent = cancel;
  $("confirm-ok").classList.toggle("danger", danger);
  $("confirm-ok").classList.toggle("primary", !danger);
  openModal(dialog);
  return new Promise((resolve) => {
    const done = (value) => {
      dialog.close();
      $("confirm-ok").onclick = $("confirm-cancel").onclick = dialog.oncancel = null;
      resolve(value);
    };
    $("confirm-ok").onclick = () => done(true);
    $("confirm-cancel").onclick = () => done(false);
    dialog.oncancel = () => done(false);
  });
}

// ---------- chat composer ----------

const chatInput = $("chat-input");
let lastTypingSent = 0;
chatInput.addEventListener("keydown", (e) => {
  // Enter while an input method is composing a character confirms the character, not the message.
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text || state.view === null) return;
    chatInput.value = "";
    lastTypingSent = 0;
    autosize();
    invoke("send_chat", { channel: state.view, text }).catch((err) => {
      // Give the text back rather than lose it.
      if (!chatInput.value) {
        chatInput.value = text;
        autosize();
      }
      toast(friendlyError(err), true);
    });
  }
});
function autosize() {
  chatInput.style.height = "auto";
  chatInput.style.height = `${chatInput.scrollHeight}px`;
}
chatInput.addEventListener("input", () => {
  autosize();
  if (chatInput.value.trim() && state.view !== null && Date.now() - lastTypingSent > TYPING_SEND_MS) {
    lastTypingSent = Date.now();
    invoke("typing", { channel: state.view }).catch(() => {});
  }
});

// ---------- mute / deafen ----------

async function setMuted(muted) {
  if (muted !== state.muted) playSound(muted ? "mute" : "unmute");
  state.muted = muted;
  await call("set_muted", { muted });
  renderUserPanel();
}

async function setDeafened(deafened) {
  if (deafened !== state.deafened) playSound(deafened ? "deafen" : "undeafen");
  state.deafened = deafened;
  await call("set_deafened", { deafened });
  renderUserPanel();
}

// Like Discord: unmuting while deafened undeafens too.
$("mute-btn").addEventListener("click", async () => {
  if (state.deafened) {
    await setDeafened(false);
    if (state.muted) await setMuted(false);
  } else {
    await setMuted(!state.muted);
  }
});
$("deafen-btn").addEventListener("click", () => setDeafened(!state.deafened));

// ---------- user settings ----------

function openSettings(tab) {
  showTab(tab);
  refreshDevices();
  renderProfilePreview();
  renderMicTest();
  openModal($("settings"));
}
function showTab(tab) {
  document.querySelectorAll(".settings-tab[data-tab]").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== tab));
}
document.querySelectorAll(".settings-tab[data-tab]").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
document.querySelectorAll(".open-settings").forEach((b) => b.addEventListener("click", () => openSettings("voice")));
$("me-card").addEventListener("click", () => openSettings("profile"));
$("settings").addEventListener("close", stopMicTest);
$("settings").addEventListener("close", stopRecordingPtt);

function renderProfilePreview() {
  const name = state.account?.name ?? "?";
  $("profile-banner").style.setProperty("--hue", hue(name));
  $("profile-avatar-slot").replaceChildren(avatar(name, "s80"));
  $("profile-name").textContent = name;
  const key = state.account?.publicKey ?? "";
  $("profile-key").textContent = key ? `Ström ID ${key.slice(0, 16).match(/.{4}/g).join(" ")}` : "";
}

$("settings-name").addEventListener("change", async (e) => {
  const status = $("rename-status");
  try {
    const name = await invoke("rename_account", { name: e.target.value });
    state.account.name = name;
    e.target.value = name;
    status.textContent = online() ? "Saved. Your new name shows up the next time you connect to a server." : "Saved.";
    renderProfilePreview();
    renderUserPanel();
  } catch (err) {
    status.textContent = String(err);
    e.target.value = state.account.name;
  }
});

// The mic check: outside voice it opens the microphone just for the settings screen.
function inVoice() {
  return online() && myVoice() !== null;
}
function renderMicTest() {
  const btn = $("mic-check");
  const voice = inVoice();
  btn.textContent = state.micTesting ? "Stop" : "Test mic";
  btn.classList.toggle("primary", state.micTesting);
  renderMeterState(false, false);
  const ptt = prefs.mode === "push_to_talk";
  $("mic-test-hint").textContent = ptt && !prefs.pttKey
    ? "You're on push to talk without a key. Choose one below; until then, nobody hears you, and neither does the test."
    : ptt
      ? state.micTesting
        ? `Hold ${prefs.pttLabel} and talk: you hear exactly what others would hear.`
        : `Hold ${prefs.pttLabel} and say something to hear yourself the way others hear you. Use headphones to avoid echo.`
      : state.micTesting
        ? "Listening. You hear yourself whenever the bar is green, just like others would."
        : "Say something and hear yourself the way others hear you. Use headphones to avoid echo.";
  document.querySelectorAll(".level").forEach((l) => {
    if (!voice && !state.micTesting) l.style.width = "0";
  });
}
async function startMicTest() {
  try {
    await invoke("start_mic_test");
    await invoke("set_mic_monitor", { on: true });
    state.micTesting = true;
  } catch (err) {
    toast(friendlyError(err), true);
  }
  renderMicTest();
}
function stopMicTest() {
  if (!state.micTesting) return;
  state.micTesting = false;
  invoke("stop_mic_test");
  renderMicTest();
}
$("mic-check").addEventListener("click", () => (state.micTesting ? stopMicTest() : startMicTest()));

// Hear Ström on the chosen speakers.
$("test-output").addEventListener("click", () => {
  invoke("test_output").catch((err) => toast(friendlyError(err), true));
});

/** Quick device switching from the user panel, like the settings page but one click away. */
async function openDeviceMenu(kind, anchor) {
  if (!$("server-menu").hidden && $("server-menu").dataset.owner === kind) return closePopovers();
  const list = await call("list_devices");
  if (!list) return;
  const input = kind === "input";
  const names = input ? list.inputs : list.outputs;
  const current = input ? prefs.inputDevice : prefs.outputDevice;
  const fallback = input ? list.default_input : list.default_output;
  const choose = (name) => () => {
    if (input) {
      prefs.inputDevice = name;
      save("inputDevice", name);
      $("input-device").value = name;
    } else {
      prefs.outputDevice = name;
      save("outputDevice", name);
      $("output-device").value = name;
    }
    applyDevices();
    toast(`${input ? "Input" : "Output"} device: ${name || `Default${fallback ? ` (${fallback})` : ""}`}`);
  };
  const items = [
    { heading: input ? "Input device" : "Output device" },
    { label: "Default", sub: fallback ?? undefined, checked: !current, action: choose("") },
    ...names.map((n) => ({ label: n, checked: current === n, action: choose(n) })),
    "sep",
    input
      ? { label: state.muted ? "Unmute" : "Mute", icon: state.muted ? "mic" : "mic-off", action: () => setMuted(!state.muted) }
      : { label: state.deafened ? "Undeafen" : "Deafen", icon: state.deafened ? "headphones" : "headphones-off", action: () => setDeafened(!state.deafened) },
    { label: "Voice settings", icon: "settings", action: () => openSettings("voice") },
  ];
  const r = anchor.closest(".split").getBoundingClientRect();
  openMenu(items, r.left - 8, r.top, true);
  $("server-menu").dataset.owner = kind;
}
$("input-menu-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  openDeviceMenu("input", e.currentTarget);
});
$("output-menu-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  openDeviceMenu("output", e.currentTarget);
});

function fillSelect(select, names, defaultName, selected) {
  const def = el("option", "", defaultName ? `Default – ${defaultName}` : "Default");
  def.value = "";
  const options = names.map((n) => {
    const o = el("option", "", n);
    o.value = n;
    return o;
  });
  // Keep a remembered device visible even while it is unplugged.
  if (selected && !names.includes(selected)) {
    const o = el("option", "", `${selected} (disconnected)`);
    o.value = selected;
    options.push(o);
  }
  select.replaceChildren(def, ...options);
  select.value = selected;
}

/** Windows names a Bluetooth headset's call-mode endpoints "Hands-Free". */
function checkBluetooth(list) {
  const input = prefs.inputDevice || list.default_input || "";
  const output = prefs.outputDevice || list.default_output || "";
  $("bt-warning").hidden = !/hands-?free/i.test(input + " " + output);
}

async function refreshDevices() {
  const list = await call("list_devices");
  if (!list) return;
  checkBluetooth(list);
  fillSelect($("input-device"), list.inputs, list.default_input, prefs.inputDevice);
  fillSelect($("output-device"), list.outputs, list.default_output, prefs.outputDevice);
}

/** A device was plugged in or out, or Windows picked a new default: reopen and refresh the lists. */
let lastDeviceRestart = 0;
let deviceRestartTimer = null;
function devicesChanged() {
  // A device that keeps failing shouldn't make us spin; reopen at most every few seconds.
  const wait = Math.max(0, lastDeviceRestart + 3000 - Date.now());
  clearTimeout(deviceRestartTimer);
  deviceRestartTimer = setTimeout(async () => {
    lastDeviceRestart = Date.now();
    await applyDevices();
    refreshDevices();
  }, wait);
}

async function applyDevices() {
  $("device-error").hidden = true;
  try {
    await invoke("set_devices", { input: prefs.inputDevice || null, output: prefs.outputDevice || null });
    if (state.micTesting) {
      // Restart the check on the newly chosen devices.
      await invoke("stop_mic_test");
      state.micTesting = false;
      await startMicTest();
    }
  } catch (err) {
    $("device-error").textContent = friendlyError(err);
    $("device-error").hidden = false;
    if (!$("settings").open) toast(friendlyError(err), true);
  }
}

$("input-device").addEventListener("change", (e) => {
  prefs.inputDevice = e.target.value;
  save("inputDevice", prefs.inputDevice);
  applyDevices();
});
$("output-device").addEventListener("change", (e) => {
  prefs.outputDevice = e.target.value;
  save("outputDevice", prefs.outputDevice);
  applyDevices();
});

const inputVolume = $("input-volume");
inputVolume.value = prefs.inputVolume;
$("input-volume-value").textContent = `${prefs.inputVolume}%`;
inputVolume.addEventListener("input", () => {
  prefs.inputVolume = Number(inputVolume.value);
  save("inputVolume", inputVolume.value);
  $("input-volume-value").textContent = `${prefs.inputVolume}%`;
  call("set_input_volume", { volume: prefs.inputVolume / 100 });
});

const outputVolume = $("output-volume");
outputVolume.value = prefs.outputVolume;
$("volume-value").textContent = `${prefs.outputVolume}%`;
outputVolume.addEventListener("input", () => {
  prefs.outputVolume = Number(outputVolume.value);
  save("outputVolume", outputVolume.value);
  $("volume-value").textContent = `${prefs.outputVolume}%`;
  call("set_output_volume", { volume: prefs.outputVolume / 100 });
});

function showMode() {
  document.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === prefs.mode));
  $("ptt-field").hidden = prefs.mode !== "push_to_talk";
  $("mode-hint").textContent = prefs.mode === "push_to_talk"
    ? "Others hear you only while you hold your key."
    : "Your mic turns on by itself when you talk.";
  $("vad-field").hidden = prefs.mode === "push_to_talk";
  showSensitivity();
  renderPttKey();
}

// ---------- push to talk ----------

let recordingPtt = false;
function renderPttKey() {
  const btn = $("ptt-key");
  btn.classList.toggle("recording", recordingPtt);
  btn.classList.toggle("empty", !prefs.pttKey && !recordingPtt);
  btn.textContent = recordingPtt ? "Press a key or mouse button…" : prefs.pttLabel || "Click to choose a key";
  $("ptt-clear").hidden = !prefs.pttKey || recordingPtt;
  renderMicTest();
  $("ptt-key-hint").textContent = recordingPtt
    ? "Press the key you want to hold while talking. Esc cancels."
    : prefs.pttKey ? "Works everywhere, also while you're in a game." : "Click the box, then press any key or mouse side button.";
  renderUserPanel();
}
function startRecordingPtt() {
  recordingPtt = true;
  invoke("record_ptt_key");
  renderPttKey();
}
function stopRecordingPtt() {
  if (!recordingPtt) return;
  recordingPtt = false;
  invoke("cancel_ptt_recording");
  renderPttKey();
}
async function setPttKey(key, label) {
  prefs.pttKey = key;
  prefs.pttLabel = key ? (await invoke("set_ptt_key", { key })) || label : "";
  if (!key) invoke("set_ptt_key", { key: 0 });
  save("pttKey", String(prefs.pttKey));
  save("pttLabel", prefs.pttLabel);
  renderPttKey();
}
$("ptt-key").addEventListener("click", (e) => {
  // Keyboard activation (Space/Enter) must not toggle: while recording, keys belong to the recorder.
  if (e.detail === 0) return;
  recordingPtt ? stopRecordingPtt() : startRecordingPtt();
});
// While recording, the backend reads the key; the page must not act on it too
// (Space would press the button again, Esc would close settings).
window.addEventListener("keydown", (e) => {
  if (!recordingPtt) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);
// Mouse side buttons mean "back" and "forward" to the web view; here they are push-to-talk buttons.
for (const type of ["mousedown", "mouseup", "auxclick"]) {
  window.addEventListener(type, (e) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  }, true);
}
$("ptt-clear").addEventListener("click", () => setPttKey(0, ""));
listen("ptt-recorded", (e) => {
  recordingPtt = false;
  if (e.payload.cancelled) renderPttKey();
  else setPttKey(e.payload.key, e.payload.label);
});
listen("ptt-blocked", () => {
  toast("Push to talk can't see your key while the app in front runs as administrator. Run Ström as administrator too, or the game without it.", true);
});
listen("ptt", (e) => {
  if (soundOn("ptt") && (inVoice() || state.micTesting) && !state.muted && !state.deafened) playSound(e.payload ? "ptt_on" : "ptt_off");
});
const pttDelay = $("ptt-delay");
pttDelay.value = prefs.pttDelay;
$("ptt-delay-value").textContent = `${prefs.pttDelay} ms`;
pttDelay.addEventListener("input", () => {
  prefs.pttDelay = Number(pttDelay.value);
  save("pttDelay", pttDelay.value);
  $("ptt-delay-value").textContent = `${prefs.pttDelay} ms`;
  call("set_ptt_release_delay", { ms: prefs.pttDelay });
});

// ---------- sound effects ----------
// Short synthesized tones: nothing to download, and they match the quiet look of the app.

let soundCtx = null;
const SOUNDS = {
  mute: [[523, 0], [392, 0.07]],
  unmute: [[392, 0], [523, 0.07]],
  deafen: [[440, 0], [330, 0.08], [262, 0.16]],
  undeafen: [[262, 0], [330, 0.08], [440, 0.16]],
  join: [[440, 0], [554, 0.08], [659, 0.16]],
  leave: [[659, 0], [554, 0.08], [440, 0.16]],
  user_join: [[587, 0], [784, 0.09]],
  user_leave: [[784, 0], [587, 0.09]],
  disconnect: [[330, 0], [247, 0.12]],
  ptt_on: [[880, 0]],
  ptt_off: [[660, 0]],
  muted: [[349, 0], [349, 0.14]],
  message: [[988, 0], [1319, 0.06]],
};
/** Which switch each sound belongs to, in the order the Sounds tab lists them. */
const SOUND_EVENTS = [
  ["mute", "Mute and unmute", ["mute", "unmute"]],
  ["deafen", "Deafen and undeafen", ["deafen", "undeafen"]],
  ["self", "Joining and leaving voice", ["join", "leave"]],
  ["others", "Others joining and leaving", ["user_join", "user_leave"]],
  ["ptt", "Push to talk", ["ptt_on", "ptt_off"]],
  ["message", "New messages", ["message"]],
  ["disconnect", "Lost connection", ["disconnect"]],
];
const SOUND_EVENT_OF = Object.fromEntries(SOUND_EVENTS.flatMap(([key, , names]) => names.map((n) => [n, key])));
function soundOn(event) {
  return prefs.soundEvents[event] !== false;
}

function playSound(name) {
  const notes = SOUNDS[name];
  const isPtt = name.startsWith("ptt");
  const event = SOUND_EVENT_OF[name];
  if (!notes || !prefs.sounds || prefs.soundVolume === 0) return;
  if (event && !soundOn(event)) return;
  if (state.deafened && prefs.quietDeafened && ["others", "message"].includes(event)) return;
  try {
    soundCtx ??= new AudioContext();
    const t0 = soundCtx.currentTime + 0.01;
    const peak = (prefs.soundVolume / 100) * (isPtt ? 0.08 : 0.16);
    for (const [freq, at] of notes) {
      const osc = soundCtx.createOscillator();
      const gain = soundCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const len = isPtt ? 0.05 : 0.11;
      gain.gain.setValueAtTime(0, t0 + at);
      gain.gain.linearRampToValueAtTime(peak, t0 + at + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
      osc.connect(gain).connect(soundCtx.destination);
      osc.start(t0 + at);
      osc.stop(t0 + at + len + 0.02);
    }
  } catch {
    // No audio output: sounds are a nicety.
  }
}
function renderSoundEvents() {
  $("sound-events").replaceChildren(
    ...SOUND_EVENTS.map(([key, label, names]) => {
      const li = el("li", "sound-event");
      const toggle = el("input", "switch");
      toggle.type = "checkbox";
      toggle.checked = soundOn(key);
      toggle.setAttribute("aria-label", label);
      toggle.addEventListener("change", () => {
        prefs.soundEvents[key] = toggle.checked;
        save("soundEvents", JSON.stringify(prefs.soundEvents));
      });
      const play = el("button", "icon-btn sm");
      play.type = "button";
      play.dataset.tip = "Play";
      play.append(icon("volume", "sm"));
      play.addEventListener("click", () => {
        const was = prefs.soundEvents[key];
        prefs.soundEvents[key] = true;
        playSound(names[0]);
        prefs.soundEvents[key] = was;
      });
      li.append(el("span", "grow", label), play, toggle);
      li.classList.toggle("off", !prefs.sounds);
      return li;
    }),
  );
}
renderSoundEvents();
for (const [id, key] of [["sounds", "sounds"], ["muted-warning", "mutedWarning"]]) {
  $(id).checked = prefs[key];
  $(id).addEventListener("change", (e) => {
    prefs[key] = e.target.checked;
    save(key, prefs[key] ? "1" : "0");
    if (key === "sounds") {
      renderSoundEvents();
      if (prefs.sounds) playSound("join");
    }
  });
}
const soundVolume = $("sound-volume");
soundVolume.value = prefs.soundVolume;
$("sound-volume-value").textContent = `${prefs.soundVolume}%`;
soundVolume.addEventListener("input", () => {
  prefs.soundVolume = Number(soundVolume.value);
  save("soundVolume", soundVolume.value);
  $("sound-volume-value").textContent = `${prefs.soundVolume}%`;
});
soundVolume.addEventListener("change", () => playSound("user_join"));

function showSensitivity() {
  const auto = prefs.autoSensitivity;
  $("auto-sensitivity").checked = auto;
  $("vad").disabled = auto;
  $("vad-meter").classList.toggle("auto", auto);
  $("vad-value").hidden = auto;
  $("vad-manual").hidden = auto;
  $("vad-hint").textContent = "Drag the line just above the bar when you're quiet. Above the line, others hear you.";
}
$("auto-sensitivity").addEventListener("change", (e) => {
  prefs.autoSensitivity = e.target.checked;
  save("autoSensitivity", prefs.autoSensitivity ? "1" : "0");
  showSensitivity();
  call("set_auto_sensitivity", { on: prefs.autoSensitivity });
});
for (const btn of document.querySelectorAll("[data-mode]")) {
  btn.addEventListener("click", () => {
    prefs.mode = btn.dataset.mode;
    save("mode", prefs.mode);
    showMode();
    call("set_transmit_mode", { mode: prefs.mode });
    // Push to talk needs a key; ask for one right away.
    if (prefs.mode === "push_to_talk" && !prefs.pttKey) startRecordingPtt();
    if (prefs.mode !== "push_to_talk") stopRecordingPtt();
  });
}
showMode();

const vad = $("vad");
vad.value = prefs.threshold;
function showThreshold() {
  $("vad-value").textContent = `${prefs.threshold} dB`;
}
vad.addEventListener("input", () => {
  prefs.threshold = Number(vad.value);
  save("vad", vad.value);
  showThreshold();
  call("set_vad_threshold", { db: prefs.threshold });
});
showThreshold();

for (const [id, key, cmd] of [["echo", "echo", "set_echo_cancellation"], ["auto-gain", "autoGain", "set_auto_gain"]]) {
  $(id).checked = prefs[key];
  $(id).addEventListener("change", (e) => {
    prefs[key] = e.target.checked;
    save(key, prefs[key] ? "1" : "0");
    call(cmd, { on: prefs[key] });
  });
}

$("noise").checked = prefs.noise;
$("noise").addEventListener("change", (e) => {
  prefs.noise = e.target.checked;
  save("noise", prefs.noise ? "1" : "0");
  call("set_noise_suppression", { on: prefs.noise });
});


/** Every voice and audio setting back to how Ström starts out; devices and the push-to-talk key stay. */
const AUDIO_DEFAULTS = {
  inputVolume: 100, outputVolume: 100, mode: "voice_activity", autoSensitivity: true, threshold: -50,
  noise: true, echo: true, autoGain: true, pttDelay: 200,
};
const STORAGE_KEY = { threshold: "vad" };
$("reset-audio").addEventListener("click", async () => {
  const ok = await confirmDialog({
    title: "Reset voice settings",
    text: "Put volumes, input mode, sensitivity and processing back to their defaults?",
    ok: "Reset",
  });
  if (!ok) return;
  for (const [key, value] of Object.entries(AUDIO_DEFAULTS)) {
    prefs[key] = value;
    const stored = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
    save(STORAGE_KEY[key] ?? key, stored);
  }
  syncAudioControls();
  applyVoicePrefs();
  toast("Voice settings are back to their defaults.");
});

/** Puts the saved preferences into every control on the Voice & audio tab. */
function syncAudioControls() {
  inputVolume.value = prefs.inputVolume;
  $("input-volume-value").textContent = `${prefs.inputVolume}%`;
  outputVolume.value = prefs.outputVolume;
  $("volume-value").textContent = `${prefs.outputVolume}%`;
  vad.value = prefs.threshold;
  showThreshold();
  $("noise").checked = prefs.noise;
  $("echo").checked = prefs.echo;
  $("auto-gain").checked = prefs.autoGain;
  pttDelay.value = prefs.pttDelay;
  $("ptt-delay-value").textContent = `${prefs.pttDelay} ms`;
  showMode();
  call("set_transmit_mode", { mode: prefs.mode });
}

/** Pushes saved voice preferences to the backend, which applies them whenever voice starts. */
function applyVoicePrefs() {
  if (prefs.pttKey) invoke("set_ptt_key", { key: prefs.pttKey }).then((label) => {
    if (label && label !== prefs.pttLabel) {
      prefs.pttLabel = label;
      save("pttLabel", label);
      renderPttKey();
    }
  });
  call("set_ptt_release_delay", { ms: prefs.pttDelay });
  call("set_input_volume", { volume: prefs.inputVolume / 100 });
  call("set_transmit_mode", { mode: prefs.mode });
  call("set_vad_threshold", { db: prefs.threshold });
  call("set_noise_suppression", { on: prefs.noise });
  call("set_echo_cancellation", { on: prefs.echo });
  call("set_auto_gain", { on: prefs.autoGain });
  call("set_auto_sensitivity", { on: prefs.autoSensitivity });
  call("set_output_volume", { volume: prefs.outputVolume / 100 });
  if (prefs.inputDevice || prefs.outputDevice) applyDevices();
}

function pct(db) {
  const clamped = Math.min(METER_MAX_DB, Math.max(METER_MIN_DB, db));
  return ((clamped - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)) * 100;
}

/** Green means the gate is open: what you say right now is being sent (or would be, in the mic test). */
const meterPeak = { db: -100, at: 0 };
let clippedAt = 0;
function updateMeter(db, voice) {
  const now = Date.now();
  if (db >= meterPeak.db || now - meterPeak.at > 1200) {
    meterPeak.db = db;
    meterPeak.at = now;
  }
  if (db > -1) clippedAt = now;
  for (const level of document.querySelectorAll(".level")) {
    level.style.width = `${pct(db)}%`;
    level.classList.toggle("over", !!voice);
  }
  for (const peak of document.querySelectorAll(".meter .peak")) {
    peak.style.left = `${pct(meterPeak.db)}%`;
    peak.hidden = meterPeak.db <= METER_MIN_DB;
  }
  for (const m of document.querySelectorAll(".meter[role=meter]")) m.setAttribute("aria-valuenow", Math.round(db));
  renderMeterState(voice, now - clippedAt < 1500);
}

/** The meter's colour in words, for everyone who can't rely on colour. */
function renderMeterState(voice, clipping) {
  const box = document.querySelector(".meter-state");
  if (!box) return;
  const active = state.micTesting || inVoice();
  const ptt = prefs.mode === "push_to_talk";
  const text = !active ? (state.micTesting === false && ptt && !prefs.pttKey ? "Pick a push-to-talk key below" : "")
    : clipping ? "Too loud, turn the volume down"
    : voice ? "Others hear you"
    : ptt ? (prefs.pttKey ? `Hold ${prefs.pttLabel} to talk` : "Pick a push-to-talk key below")
    : "Say something";
  box.querySelector(".state-text").textContent = text;
  box.classList.toggle("on", active && voice && !clipping);
  box.classList.toggle("warn", active && clipping);
}

// ---------- popovers, user card & moderation ----------

function closePopovers() {
  document.querySelectorAll(".popover").forEach((p) => (p.hidden = true));
  $("sidebar-head").classList.remove("open");
}

function placePopover(pop, x, y) {
  closePopovers();
  pop.style.width = "";
  pop.hidden = false;
  pop.style.left = `${Math.max(8, Math.min(x, window.innerWidth - pop.offsetWidth - 8))}px`;
  pop.style.top = `${Math.max(8, Math.min(y, window.innerHeight - pop.offsetHeight - 8))}px`;
}

function applyUserVolumes() {
  if (!state.roster) return;
  for (const u of state.roster.users) {
    const vol = prefs.userVolumes[u.name];
    if (u.session_id === state.roster.me || vol === undefined) continue;
    if (state.appliedVolumes.get(u.session_id) !== vol) {
      state.appliedVolumes.set(u.session_id, vol);
      call("set_user_volume", { sessionId: u.session_id, volume: vol / 100 });
    }
  }
}

let cardUser = null;

function openUserCard(user, anchor) {
  cardUser = user;
  $("user-card-banner").style.setProperty("--hue", hue(user.name));
  $("user-card-avatar-slot").replaceChildren(avatar(user.name, "s80"));
  $("user-card-name").textContent = user.name;
  const sub = $("user-card-sub");
  if (user.voice_channel !== null) sub.replaceChildren(icon("volume", "sm"), el("span", "", `In ${channelName(user.voice_channel)}`));
  else sub.replaceChildren(el("span", "", user.owner ? "Server owner" : "Online"));
  $("user-mod").hidden = !isOwner();
  syncUserCard();
  // Open beside the row, like a profile card.
  const r = anchor.getBoundingClientRect();
  const card = $("user-card");
  card.hidden = false;
  const x = r.left > window.innerWidth / 2 ? r.left - card.offsetWidth - 12 : r.right + 12;
  placePopover(card, x, r.top);
}

function syncUserCard() {
  const vol = prefs.userVolumes[cardUser.name] ?? 100;
  $("user-volume").value = vol;
  $("user-volume-value").textContent = `${vol}%`;
  const btn = $("user-mute");
  btn.textContent = vol === 0 ? "Unmute for me" : "Mute for me";
}

function setUserVolume(vol) {
  if (vol === 100) delete prefs.userVolumes[cardUser.name];
  else prefs.userVolumes[cardUser.name] = vol;
  save("userVolumes", JSON.stringify(prefs.userVolumes));
  state.appliedVolumes.set(cardUser.session_id, vol);
  call("set_user_volume", { sessionId: cardUser.session_id, volume: vol / 100 });
  syncUserCard();
  renderSidebar();
  renderMembers();
}

async function removeUser(ban) {
  const user = cardUser;
  closePopovers();
  const ok = await confirmDialog(
    ban
      ? { title: `Ban ${user.name}`, text: `${user.name} is disconnected and can never rejoin with this Ström ID, not even with an invite. You can undo this in Server settings.`, ok: "Ban" }
      : { title: `Kick ${user.name}`, text: `${user.name} is disconnected right away. As a member they can rejoin later.`, ok: "Kick" },
  );
  if (ok) call("kick", { sessionId: user.session_id, ban });
}

$("user-volume").addEventListener("input", (e) => setUserVolume(Number(e.target.value)));
$("user-mute").addEventListener("click", () => setUserVolume((prefs.userVolumes[cardUser.name] ?? 100) === 0 ? 100 : 0));
$("user-kick").addEventListener("click", () => removeUser(false));
$("user-ban").addEventListener("click", () => removeUser(true));
document.addEventListener("mousedown", (e) => {
  if ([...document.querySelectorAll(".popover")].some((p) => !p.hidden && p.contains(e.target))) return;
  if (e.target.closest("#sidebar-head, .split-more")) return;
  closePopovers();
});

// ---------- tooltips ----------

const tip = $("tooltip");
document.addEventListener("mouseover", (e) => {
  const target = e.target.closest("[data-tip]");
  if (!target || !target.dataset.tip) return;
  tip.textContent = target.dataset.tip;
  tip.hidden = false;
  const anchor = target.querySelector(".rail-icon") ?? target;
  const r = anchor.getBoundingClientRect();
  if (target.dataset.tipPos === "right") {
    tip.style.left = `${r.right + 12}px`;
    tip.style.top = `${r.top + r.height / 2 - tip.offsetHeight / 2}px`;
  } else {
    const x = r.left + r.width / 2 - tip.offsetWidth / 2;
    tip.style.left = `${Math.max(8, Math.min(x, window.innerWidth - tip.offsetWidth - 8))}px`;
    tip.style.top = `${r.top - tip.offsetHeight - 8}px`;
  }
});
document.addEventListener("mouseout", (e) => {
  const target = e.target.closest("[data-tip]");
  if (target && !target.contains(e.relatedTarget)) tip.hidden = true;
});
document.addEventListener("mousedown", () => (tip.hidden = true));

// ---------- keyboard ----------

function typing(e) {
  return ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName);
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePopovers();
  if (!online()) return;
  if (e.ctrlKey && e.key.toLowerCase() === "m") { e.preventDefault(); $("mute-btn").click(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === "d") { e.preventDefault(); setDeafened(!state.deafened); }
});

// ---------- window controls (the native frame is off) ----------

const appWindow = window.__TAURI__.window?.getCurrentWindow();
$("win-min").addEventListener("click", () => appWindow?.minimize());
$("win-max").addEventListener("click", () => appWindow?.toggleMaximize());
// Closing the window: keep running in the notification area (like Discord), or quit.
// Asked once; the answer is kept.
$("win-close").addEventListener("click", async () => {
  let choice = load("closeAction", "");
  if (!choice) {
    const keep = await confirmDialog({
      title: "Keep Ström running?",
      text: "Ström can keep running in the notification area when you close the window, so you stay in voice and still get messages. Open it again from the icon by the clock.",
      ok: "Keep running",
      cancel: "Quit Ström",
      danger: false,
    });
    choice = keep ? "tray" : "quit";
    save("closeAction", choice);
  }
  if (choice === "quit") invoke("quit_app");
  else appWindow?.close();
});

// The notification-area icon's menu.
listen("tray-action", (e) => {
  if (e.payload === "mute") $("mute-btn").click();
  else if (e.payload === "deafen") setDeafened(!state.deafened);
});

// strom:// links from outside (a browser, another app, or what Ström was started with).
async function openLink(url) {
  if (!state.account || !/^strom:\/\//i.test(url)) return;
  closePopovers();
  await followInvite(url);
}
listen("open-url", async (e) => {
  // Handled here; don't handle it again from the pending slot.
  await invoke("take_pending_link");
  openLink(String(e.payload));
});
$("topbar-title").parentElement.addEventListener("dblclick", (e) => {
  if (!e.target.closest(".window-controls")) appWindow?.toggleMaximize();
});

// ---------- dialogs: click outside to close ----------
//
// Clicking the dimmed area around a dialog does what Esc does: a "cancel" that
// a dialog can refuse (the phrase backup asks first; confirmations answer "no").
// Both press and release must be outside, so dragging a text selection out of
// a dialog doesn't close it.
for (const dialog of document.querySelectorAll("dialog")) {
  const outside = (e) => {
    const r = dialog.getBoundingClientRect();
    return e.target === dialog && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom);
  };
  let pressedOutside = false;
  dialog.addEventListener("mousedown", (e) => (pressedOutside = outside(e)));
  dialog.addEventListener("click", (e) => {
    if (!pressedOutside || !outside(e)) return;
    if (dialog.dispatchEvent(new Event("cancel", { cancelable: true })) && dialog.open) dialog.close();
  });
}

// ---------- startup ----------

window.addEventListener("contextmenu", (e) => e.preventDefault());
boot();
