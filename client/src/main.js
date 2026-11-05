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
/** Where Hopp Cloud runs (see cloud/). For local development, `npx wrangler dev` serves ws://127.0.0.1:8787. */
const DEFAULT_CLOUD_URL = "wss://hopp-cloud.hoppchat.workers.dev";
const TYPING_SEND_MS = 2500;
const TYPING_SHOW_MS = 6000;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"]+[^\s<>".,:;!?)\]'*]/gi;

// ---------- persisted preferences ----------

/** What belongs to one account, not to this computer: kept apart per Hopp ID. */
const ACCOUNT_DATA = ["servers", "rail", "removedServers", "notify", "drafts", "closedCategories"];
let accountScope = null;

function storageKey(key) {
  return ACCOUNT_DATA.includes(key) && accountScope ? `${key}@${accountScope}` : key;
}
function load(key, fallback) {
  // Before anyone has logged in there is no account data to show.
  if (ACCOUNT_DATA.includes(key) && !accountScope) return fallback;
  try { return localStorage.getItem(storageKey(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  if (ACCOUNT_DATA.includes(key) && !accountScope) return;
  try { localStorage.setItem(storageKey(key), value); } catch { /* storage unavailable */ }
}

/**
 * Switches to one account's data. Lists saved before accounts were kept apart
 * aren't given to anyone: each account gets its servers back from its own sync.
 */
function useAccountData(publicKey) {
  accountScope = publicKey.slice(0, 16);
  try {
    for (const k of ACCOUNT_DATA) localStorage.removeItem(k);
  } catch {
    // Storage unavailable: nothing to clear.
  }
  prefs.servers = loadJson("servers", []);
  prefs.rail = loadJson("rail", []);
  prefs.removedServers = loadJson("removedServers", {});
  prefs.notify = loadJson("notify", { servers: {}, channels: {} });
  prefs.closedCategories = loadJson("closedCategories", {});
  drafts = new Map(Object.entries(loadJson("drafts", {})));
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
  cloudUrl: load("cloudUrl", DEFAULT_CLOUD_URL).replace(/strom-cloud\.strom-chat\.workers\.dev/, "hopp-cloud.hoppchat.workers.dev"),
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
  // Added again after being removed on some device: it's wanted after all.
  if (prefs.removedServers?.[address]) {
    delete prefs.removedServers[address];
    save("removedServers", JSON.stringify(prefs.removedServers));
  }
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
  if (typeof syncState !== "undefined" && syncState.ready) scheduleSync();
}

const state = {
  atHome: false, // Home on screen while still connected to a server
  account: null, // { name, publicKey }
  activeId: null,
  connectingId: null,
  // Shown on the home view: { kind: "connecting" | "error", server, text }
  notice: null,
  roster: null,
  view: null, // the text channel being read
  /** Read marks per server channel, by `${address}|${channel}`: { server, channel, read_id, last_id, mentions }. */
  reads: new Map(),
  /** Channels whose very first message is loaded. */
  olderDone: new Set(),
  /** Messages on their way: { nonce, channel, text, replyTo, reply, at, failed, why }. */
  outbox: [],
  loadingOlder: false,
  /** The message being answered ({ id, channel, name }) or edited ({ id, channel }). */
  replyTo: null,
  editing: null,
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

function avatar(name, size, dot, picture) {
  const a = el("span", "avatar" + (size ? ` ${size}` : ""), picture ? "" : initials(name || "?").slice(0, size === "s24" ? 1 : 2));
  a.style.setProperty("--hue", hue(name || "?"));
  if (picture) {
    const img = el("img");
    img.src = picture;
    img.alt = "";
    img.draggable = false;
    a.append(img);
    a.classList.add("has-picture");
  }
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
  // Hopp Cloud runs on a free plan with a daily limit; past it, Cloudflare turns requests away.
  if (/\b(429|503|1027)\b|too many requests|exceeded|daily limit|overloaded/i.test(s)) return "Hopp Cloud is overloaded right now. It usually comes back within a few hours. Your messages and servers are safe.";
  if (/10061|refused/i.test(s)) return "The server isn't answering. Check that it's running and that the address is right.";
  if (/timed out|did not answer/i.test(s)) return "The server took too long to answer. Check the address and that port 7777 is open.";
  if (/resolve|11001|no such host/i.test(s)) return "Couldn't find a server at that address.";
  if (/unknown message type/i.test(s)) return "This server doesn't have that yet. It needs an update from its owner.";
  const versions = s.match(/protocol (\d+), the app speaks (\d+)/i);
  if (versions) {
    return Number(versions[1]) > Number(versions[2])
      ? "This server needs a newer version of Hopp. Update the app to join it."
      : "This server runs an older version of Hopp. Ask its owner to update it.";
  }
  if (/protocol/i.test(s)) return "This server runs a different version of Hopp. Update the server and the app to the same version.";
  if (/using the default devices instead/i.test(s)) return "Your chosen audio device couldn't be opened, so Hopp is using the system default for now.";
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

/** Connected to a server (voice and chat keep going even while Home is on screen). */
function connected() {
  return state.activeId !== null && state.roster !== null;
}
/** A server is on screen: connected, and not looking at Home. */
function online() {
  return connected() && !state.atHome;
}

const SHORT_INVITE = /^(?:(?:hopp|strom):\/\/)?([A-Za-z0-9]{6,16})\/?$/i;
const INVITE_LINK = /\b(?:hopp|strom):\/\/[^\s<>"]+[^\s<>".,:;!?)\]'*]/gi;

/** Our invite page links: https://<Hopp Cloud>/i/CODE. */
function invitePageCode(input) {
  const m = input.trim().match(/^https:\/\/([^/\s]+)\/i\/([A-Za-z0-9]{6,16})\/?$/i);
  if (!m) return null;
  const host = m[1].toLowerCase();
  const ours = prefs.cloudUrl.replace(/^wss?:\/\//, "").split("/")[0].toLowerCase();
  // Hopp Cloud, now or at an earlier address.
  return host === ours || /^(hopp|strom)[a-z0-9-]*\.(hoppchat|strom-chat)\.workers\.dev$/.test(host) ? m[2].toUpperCase() : null;
}

/** What an invite link points at: { code } for Hopp Cloud, { address, code } for a server someone runs. */
function inviteTarget(link) {
  const code = shortInviteCode(link);
  if (code) return { code };
  const m = link.trim().match(/^(?:hopp|strom):\/\/cloud\/[A-Za-z0-9]+\/([A-Za-z0-9]{6,16})\/?$/i);
  if (m) return { code: m[1].toUpperCase() };
  if (/^(?:hopp|strom):\/\//i.test(link)) {
    const { address, invite } = parseInvite(link);
    if (address && invite) return { address, code: invite };
  }
  return null;
}

/** The code of a short Hopp Cloud invite ("hopp://K7P2QX9M" or https://…/i/K7P2QX9M), or null. */
function shortInviteCode(input) {
  const page = invitePageCode(input);
  if (page) return page;
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
  const s = input.trim().replace(/^(?:hopp|strom):\/\//i, "");
  const parts = s.split("/").map((p) => p.trim());
  if (parts[0].toLowerCase() === "cloud" && parts[1]) {
    return { address: `cloud:${parts[1]}`, invite: parts[2]?.toUpperCase() || undefined };
  }
  return { address: parts[0], invite: parts[1]?.toUpperCase() || undefined };
}

function isCloud(server) {
  return !!server?.address?.startsWith("cloud:");
}

/** What the backend connects to: a WebSocket URL for cloud servers, host:port otherwise. */
function endpoint(server) {
  return isCloud(server) ? `${prefs.cloudUrl}/servers/${server.address.slice(6)}/ws` : server.address;
}

function displayAddress(server) {
  return isCloud(server) ? "Hopp Cloud" : server.address;
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

// Roles on cloud servers: moderators delete messages, pin and kick; admins also run
// channels, invites, bans and the server's look; the owner names admins.
const ROLE_RANK = { owner: 3, admin: 2, mod: 1 };
const ROLE_LABEL = { owner: "Owner", admin: "Admin", mod: "Moderator" };
function roleOf(u) {
  return u?.owner ? "owner" : u?.role === "admin" || u?.role === "mod" ? u.role : null;
}
function rankOf(u) {
  return ROLE_RANK[roleOf(u)] ?? 0;
}
/** "moderate", "manage" or "own": whether my role here allows it. */
function can(what) {
  return rankOf(me()) >= { moderate: 1, manage: 2, own: 3 }[what];
}
/** I may act on someone only when my role is above theirs. */
function outranks(u) {
  return !!u && u.session_id !== state.roster?.me && rankOf(me()) > rankOf(u);
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
let authReturn = "login";
let accountExists = false;

function showAuth(mode) {
  $("shell").classList.add("locked");
  $("splash").hidden = true;
  if (mode !== "recover") authReturn = mode;
  for (const [m, id] of Object.entries(AUTH_PANES)) $(id).hidden = m !== mode;
  $("topbar-title").textContent = "Hopp";
  const focus = AUTH_FOCUS[mode];
  if (focus) setTimeout(() => $(focus).focus(), 0);
  fitAuthWindow();
}

/** The login window is just as big as what's in it. */
function fitAuthWindow() {
  // Not a frame callback: those wait while the window is still hidden.
  setTimeout(() => {
    if (!$("shell").classList.contains("locked")) return;
    // Tall enough for the whole form (never a scrollbar), and never tiny.
    const pane = [...$("auth-card").children].find((c) => !c.hidden);
    const card = getComputedStyle($("auth-card"));
    const content = (pane?.scrollHeight ?? 0) + parseFloat(card.paddingTop) + parseFloat(card.paddingBottom);
    const height = Math.max(600, content + document.querySelector(".topbar").offsetHeight);
    invoke("window_compact", { height }).catch(() => {});
  }, 0);
}
// Errors and hints appearing in the form change its height.
new ResizeObserver(() => fitAuthWindow()).observe($("auth-card"));

async function boot() {
  applyVoicePrefs();
  // A moment of hopping bunny while Hopp gets ready.
  $("shell").classList.add("locked");
  $("splash").hidden = false;
  $("splash-text").textContent = "Starting…";
  for (const id of Object.values(AUTH_PANES)) $(id).hidden = true;
  fitAuthWindow();
  const shown = new Promise((r) => setTimeout(r, 900));
  // Also logs in by itself when "Keep me logged in" was chosen.
  let status;
  try {
    status = await invoke("account_status");
  } catch (err) {
    $("splash-text").textContent = `Hopp couldn't start: ${friendlyError(err)}`;
    const retry = el("button", "btn sm splash-retry", "Try again");
    retry.addEventListener("click", () => {
      retry.remove();
      boot();
    });
    $("splash").append(retry);
    return;
  }
  if (status.logged_in) $("splash-text").textContent = `Welcome back, ${status.name}`;
  await shown;
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
  // This account's servers and settings, not whoever used Hopp on this computer before.
  useAccountData(status.public_key);
  state.account = { name: status.name, publicKey: status.public_key, backedUp: status.backed_up };
  accountExists = true;
  $("shell").classList.remove("locked");
  invoke("window_full").catch(() => {});
  $("settings-name").value = status.name;
  $("remember-toggle").checked = status.remembered;
  renderBackupState();
  renderAll();
  startAccount();
  // Started from a strom:// link (or one arrived while logged out): follow it now.
  const link = await invoke("take_pending_link");
  if (link && state.onboarding) state.onboarding.link = link;
  else if (link) openLink(link);
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
  setBusy(btn, true, "Creating your Hopp ID…");
  try {
    const created = await invoke("create_account", {
      name: $("create-name").value,
      password,
      rememberMe: $("create-remember").checked,
    });
    $("create-password").value = $("create-confirm").value = "";
    state.onboarding = { step: "backup", link: null };
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
    title: "Create a new Hopp ID?",
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
    status.textContent = `This is a different Hopp ID. The account on this computer (${phraseCheck.other_account_name}) will be kept as a backup.`;
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
  if (state.call) await endCall();
  // Changes still waiting to sync go up first; nothing carries over to the next account.
  clearTimeout(syncState.timer);
  if (syncState.dirty && syncState.ready) await pushSync();
  Object.assign(syncState, { version: 0, saving: false, dirty: false, timer: null, ready: false });
  await call("logout");
  state.account = null;
  renderBackupState();
  state.activeId = null;
  state.atHome = false;
  state.roster = null;
  state.notice = null;
  // Nothing of this account stays for the next one.
  state.me = undefined;
  state.friends = new Map();
  state.conversations = new Map();
  state.dmMessages.clear();
  state.dmComplete.clear();
  state.groups = new Map();
  state.reads = new Map();
  state.openDm = null;
  state.readsLoaded = false;
  accountScope = null;
  prefs.servers = [];
  prefs.rail = [];
  boot();
}
$("logout-btn").addEventListener("click", logout);
// For helping someone with a problem: version, devices and the recent log, to paste anywhere.
$("copy-debug").addEventListener("click", async () => {
  const info = await call("debug_info");
  if (!info) return;
  await navigator.clipboard.writeText(info).catch(() => {});
  toast("Debug info copied. It includes your IP addresses, so only share it with people you trust.");
});

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
    text: "If you forget your password without it, this account is gone for good. Nobody, not even Hopp, can get it back. You'll see a reminder until you've saved it.",
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
  if (typeof syncState !== "undefined" && syncState.ready) scheduleSync();
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
  return !state.atHome && (id === state.activeId || id === state.connectingId);
}

function railServer(s, folder) {
  const b = el("button", "rail-item");
  b.dataset.tip = s.label;
  b.dataset.tipPos = "right";
  b.dataset.server = s.id;
  if (folder) b.dataset.inFolder = folder.folder;
  b.classList.toggle("active", isActiveServer(s.id));
  b.classList.toggle("connecting", s.id === state.connectingId);
  b.classList.toggle("unread", serverUnread(s));
  b.append(serverIcon("rail-icon server-tint", s.label, s.icon));
  railBadge(b, serverMentions(s));
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
  const servers = f.ids.map(serverById).filter(Boolean);
  if (!f.open) {
    head.classList.toggle("unread", servers.some(serverUnread));
    railBadge(head, servers.reduce((n, s) => n + serverMentions(s), 0));
  }
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
  $("home-btn").classList.toggle("active", state.atHome || (!state.activeId && !state.connectingId));
  normalizeRail();
  if (typeof renderHomeBadge === "function" && state.conversations) renderHomeBadge();
  $("server-list").replaceChildren(
    ...prefs.rail.map((item) => (item.folder ? railFolder(item) : railServer(serverById(item.id)))),
  );
  updateRailFade();
}

/** Fades the server list toward Home or Add when there are more servers that way. */
function updateRailFade() {
  const list = $("server-list");
  list.classList.toggle("more-up", list.scrollTop > 2);
  list.classList.toggle("more-down", list.scrollTop + list.clientHeight < list.scrollHeight - 2);
}
$("server-list").addEventListener("scroll", updateRailFade, { passive: true });
window.addEventListener("resize", updateRailFade);

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
  if (state.connectingId) return disconnect();
  if (state.activeId && !state.atHome) return goHome();
  if (state.openDm) closeDm();
});

/** Home on screen while the server stays connected: going back is instant, voice goes on. */
function goHome() {
  saveDraft();
  closePopovers();
  state.atHome = true;
  renderAll();
}

function removeServer(server) {
  if (server.id === state.activeId) disconnect();
  // Remembered, so another device doesn't bring it back.
  prefs.removedServers[server.address] = Date.now();
  save("removedServers", JSON.stringify(prefs.removedServers));
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
  // A tooltip left over from the button that opened the menu would sit on top of it.
  document.getElementById("tooltip").hidden = true;
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
  const active = server.id === state.activeId && !!state.roster;
  const folder = prefs.rail.find((item) => item.folder && item.ids.includes(server.id));
  // Running it: only known for the server we're in.
  const manage = active && can("manage");
  openMenu(
    [
      { label: "Invite people", icon: "user-plus", action: () => onServer(server, openInvite) },
      ...(serverHasUnread(server.address) ? [{ label: "Mark as read", icon: "check", action: () => markServerRead(server.address) }] : []),
      ...(manage
        ? [
            "sep",
            { label: "Server settings", icon: "settings", action: () => onServer(server, openServerSettings) },
            { label: "Create text channel", icon: "hash", action: () => onServer(server, () => openChannelDialog("text")) },
            { label: "Create voice channel", icon: "volume", action: () => onServer(server, () => openChannelDialog("voice")) },
          ]
        : []),
      "sep",
      { heading: "Notifications" },
      ...[["all", "All messages"], ["mentions", "Only @mentions"], ["none", "Nothing"]].map(([level, label]) => ({
        label, checked: serverLevel(server) === level, action: () => setServerLevel(server, level),
      })),
      "sep",
      active
        ? { label: "Disconnect", icon: "logout", action: disconnect }
        : { label: "Connect", icon: "link", action: () => connectTo(server) },
      ...(folder ? [{ label: "Remove from folder", icon: "folder", action: () => removeFromFolder(server.id, folder) }] : []),
      ...(server.owner || (active && isOwner())
        ? isCloud(server)
          ? [{ label: "Delete server", icon: "trash", danger: true, action: () => deleteServer(server) }]
          : [{ label: "Remove from list", icon: "trash", danger: true, action: () => removeServer(server) }]
        : [{ label: "Leave server", icon: "logout", danger: true, action: () => leaveServer(server) }]),
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
  if (!reconnecting && !create && server.id === state.activeId && state.roster) {
    if (state.atHome) {
      state.atHome = false;
      // Messages may have come in meanwhile: draw the channel afresh.
      renderedChannel = undefined;
      renderAll();
      restoreDraft();
    }
    return true;
  }
  // Coming back after a dropped connection doesn't pull you away from Home.
  if (!reconnecting) state.atHome = false;
  saveDraft();
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
  state.chats.clear();
  state.olderDone.clear();
  state.loadingOlder = false;
  state.outbox = [];
  state.replyTo = null;
  state.editing = null;
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
    if (/invite-only|ask the owner for an invite/i.test(String(err)) && !server.joined && !server.invite) {
      removeServer(server);
      toast(`${server.label} was removed from your list: you're not a member. Ask for an invite to join.`);
      return false;
    }
    // Deleted by its owner while we were away.
    if (/this server doesn't exist/i.test(String(err)) && server.address.startsWith("cloud:")) {
      removeServer(server);
      toast(`${server.label} no longer exists. Its owner deleted it.`);
      return false;
    }
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
  state.atHome = false;
  state.connectingId = null;
  state.roster = null;
  state.notice = null;
  renderAll();
}

async function joinVoice(id) {
  if (myVoice() === id) return;
  // One voice at a time: joining a channel ends a call.
  if (state.call) await endCall();
  state.voiceState = { ready: false };
  state.latency = null;
  await call("join_voice", { channel: id });
}

$("hangup-btn").addEventListener("click", () => call("leave_voice"));

// ---------- server & voice events ----------

/** Keeps the saved name and picture in step with the server, for the rail and Home. */
function rememberServerLook(server, roster) {
  let changed = !server.joined;
  server.joined = true;
  const owner = !!roster.users.find((u) => u.session_id === roster.me)?.owner;
  if (!!server.owner !== owner) {
    server.owner = owner;
    changed = true;
  }
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
  if ((before === null) !== (after === null)) setActivityFromVoice();
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
    state.unreachable.clear();
    state.quality.clear();
    state.speaking.clear();
    state.latency = null;
  }
  if (state.pendingView !== undefined && textChannels().some((c) => c.id === state.pendingView)) state.view = state.pendingView;
  state.pendingView = undefined;
  if (!textChannels().some((c) => c.id === state.view)) state.view = textChannels()[0]?.id ?? null;
  forgetDeletedChannels();
  const pending = state.pendingCategory;
  const made = pending && state.roster.channels.find((c) => !pending.known.has(c.id));
  if (made) {
    state.pendingCategory = null;
    call("update_channel", { channel: made.id, name: made.name, topic: made.topic ?? null, category: pending.name });
  }
  if (draftKey() !== state.draftAt) restoreDraft();
  applyUserVolumes();
  syncScreen();
  renderAll();
});

listen("voice", (e) => {
  const ev = e.payload;
  if (ev.type === "speaking") {
    ev.speaking ? state.speaking.add(ev.session_id) : state.speaking.delete(ev.session_id);
    // Who is talking shows in the voice channel (and on your own panel); not in the member list.
    document.querySelectorAll(`.voice-user[data-user="${ev.session_id}"]`).forEach((n) => n.classList.toggle("speaking", ev.speaking));
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
  } else if (ev.type === "need_relay") {
    useRelay();
  } else if (ev.type === "peer_quality") {
    const before = connectionGrade(state.quality.get(ev.session_id));
    state.quality.set(ev.session_id, { rtt: ev.rtt_ms, loss: ev.loss });
    // Only a change you'd see redraws: the bars appear, change colour, or go.
    if (connectionGrade(state.quality.get(ev.session_id)) !== before) renderSidebar();
    if (cardUser?.session_id === ev.session_id && !$("user-card").hidden) syncUserCard();
  } else if (ev.type === "peer_reach") {
    if (ev.reachable) state.unreachable.delete(ev.session_id);
    else {
      state.unreachable.add(ev.session_id);
      // The relay usually sorts this out within seconds; only say something if it can't.
      setTimeout(() => {
        if (!state.unreachable.has(ev.session_id)) return;
        const name = userName(ev.session_id) ?? "Someone";
        toast(`Can't connect to ${name}, so you can't hear each other. Their network or yours is blocking voice; a different network (or turning off a VPN) usually helps.`, true);
      }, relayState.unavailable ? 0 : 12_000);
    }
    renderSidebar();
  }
});

listen("chat", (e) => {
  const m = e.payload;
  if (m.author_key === state.account?.publicKey) {
    const i = state.outbox.findIndex((o) => o.channel === m.channel && o.text === m.text && !o.failed);
    if (i >= 0) state.outbox.splice(i, 1);
  }
  if (!state.chats.has(m.channel)) state.chats.set(m.channel, []);
  state.chats.get(m.channel).push(m);
  state.typing.get(m.channel)?.delete(m.sender);
  const server = currentServer();
  const fresh = server && noteMessage(server.address, m);
  if (m.channel === state.view) {
    renderMessages(true);
    renderTyping();
  }
  if (fresh && server) {
    if (m.author_key !== state.account?.publicKey) {
      notifyMention({ server: server.address, channel: m.channel, author_key: m.author_key, author_name: m.sender_name, channel_name: channelName(m.channel), text: previewText(m.text), mention: mentionsMeIn(m) });
    }
    renderUnread();
  }
});

listen("chat-history", (e) => {
  const { channel: ch, messages } = e.payload;
  state.chats.set(ch, messages);
  // A short history is the whole channel.
  if (messages.length < 50) state.olderDone.add(ch);
  else state.olderDone.delete(ch);
  const server = currentServer();
  if (server) noteHistory(server, ch, messages);
  if (ch === state.view) renderMessages(false);
  renderUnread();
  // Opened from a message link: go to it once its channel is here.
  if (state.pendingJump && ch === state.view) {
    const id = state.pendingJump;
    state.pendingJump = null;
    setTimeout(() => jumpToMessage(id), 50);
  }
});

listen("message-edited", (e) => {
  const { channel: ch, id, text, edited_at } = e.payload;
  const m = state.chats.get(ch)?.find((x) => x.id === id);
  if (!m) return;
  Object.assign(m, { text, edited_at });
  if (ch === state.view) renderMessages(true);
});

listen("reactions", (e) => {
  const { channel: ch, id, reactions } = e.payload;
  const m = state.chats.get(ch)?.find((x) => x.id === id);
  if (!m) return;
  m.reactions = reactions;
  if (ch === state.view) renderMessages(true);
});

listen("older-history", (e) => {
  const { channel: ch, messages, done } = e.payload;
  state.loadingOlder = false;
  if (done) state.olderDone.add(ch);
  const list = state.chats.get(ch) ?? [];
  const known = new Set(list.map((m) => m.id));
  state.chats.set(ch, [...messages.filter((m) => !known.has(m.id)), ...list]);
  if (ch !== state.view) return;
  // Keep what you were looking at in place while older messages appear above it.
  const scroller = $("scroller");
  const fromBottom = scroller.scrollHeight - scroller.scrollTop;
  renderMessages(true);
  scroller.scrollTop = scroller.scrollHeight - fromBottom;
  if (state.jumpTo) jumpToMessage(state.jumpTo);
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
listen("members", (e) => {
  state.members = e.payload ?? [];
  renderMemberList();
});

listen("disconnected", () => {
  const server = activeServer();
  // We just left this server on purpose.
  if (!server && state.justLeft) {
    state.justLeft = false;
    renderAll();
    return;
  }
  const voice = myVoice();
  playSound("disconnect");
  state.activeId = null;
  state.roster = null;
  if (server && !state.kicked && !state.replaced) {
    startReconnect(server, voice);
    return;
  }
  state.atHome = false;
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
  // A message the server refused: mark it, so it can be sent again.
  const sending = state.outbox.findLast((o) => !o.failed && Date.now() - o.at < 5000);
  if (sending && !/unknown message type/i.test(text) && /message|too fast|characters|channel/i.test(text)) failOutbox(sending, text);
  if (/from somewhere else/i.test(text)) state.replaced = true;
  toast(friendlyError(text), true);
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
  if (typeof renderCall === "function") queueMicrotask(renderCall);
  const on = online();
  const loading = !on && !!connectingServer();
  $("shell").classList.toggle("offline", !on && !loading);
  $("shell").classList.toggle("loading", loading);
  $("topbar-title").textContent = on ? activeServer()?.label ?? state.roster.server_name : loading ? connectingServer().label : "Hopp";
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
    $("sidebar-title").textContent = "Hopp";
    head.disabled = true;
    const rows = prefs.servers.map((s) => {
      const b = el("button", "server-row");
      const text = el("span", "row-text");
      text.append(el("span", "row-title ellipsis", s.label), el("span", "row-sub ellipsis", displayAddress(s)));
      b.append(serverChip(s), text);
      const mentions = serverMentions(s);
      if (mentions) b.append(el("span", "count-badge", mentions > 99 ? "99+" : String(mentions)));
      else if (serverUnread(s)) b.classList.add("unread");
      b.addEventListener("click", () => connectTo(s));
      b.addEventListener("contextmenu", (e) => openServerMenu(s, e.clientX, e.clientY));
      return b;
    });
    const friends = el("button", "server-row nav-row" + (state.openDm ? "" : " active"));
    friends.append(icon("users"), el("span", "row-title", "Friends"));
    const incoming = [...(state.friends?.values() ?? [])].filter((f) => f.state === "incoming").length;
    if (incoming) friends.append(el("span", "count-badge", String(incoming)));
    friends.addEventListener("click", () => {
      state.friendTab = incoming ? "pending" : "online";
      state.openDm = null;
      renderAll();
    });
    const cat = el("div", "category");
    cat.append(el("span", "", "Your servers"));
    const noServers = el("div", "sidebar-empty");
    const addOne = el("button", "link", "Create or join one");
    addOne.type = "button";
    addOne.addEventListener("click", () => openAddDialog("choose"));
    noServers.append("No servers yet. ", addOne);
    body.replaceChildren(friends, ...dmSidebarRows(), cat, ...(rows.length ? rows : [noServers]));
    return;
  }

  const r = state.roster;
  head.disabled = false;
  $("sidebar-title").textContent = activeServer()?.label ?? r.server_name;
  const owner = can("manage");
  const items = [];

  const address = activeServer()?.address;
  const textRow = (ch) => {
    const row = el("button", "channel-row");
    row.classList.toggle("current", ch.id === state.view);
    row.classList.toggle("unread", ch.id !== state.view && channelUnread(address, ch.id));
    row.append(icon("hash"), el("span", "ellipsis", ch.name));
    const mentions = channelMentions(address, ch.id);
    if (mentions) row.append(el("span", "count-badge", mentions > 99 ? "99+" : String(mentions)));
    row.addEventListener("click", () => openTextChannel(ch.id));
    row.addEventListener("contextmenu", (e) => openChannelMenu(ch, e));
    row.classList.toggle("muted", channelMuted(address, ch.id));
    if (owner) draggableChannel(row, ch);
    return row;
  };
  const mine = myVoice();
  const voiceRow = (ch) => {
    const wrap = el("div");
    const row = el("button", "channel-row");
    row.classList.toggle("in-voice", ch.id === mine);
    row.dataset.tip = ch.id === mine ? "You're here" : `Join ${ch.name}`;
    row.append(icon("volume"), el("span", "ellipsis", ch.name));
    row.addEventListener("click", () => joinVoice(ch.id));
    row.addEventListener("contextmenu", (e) => openChannelMenu(ch, e));
    if (owner) {
      draggableChannel(row, ch);
    }
    const users = r.users.filter((u) => u.voice_channel === ch.id).sort(byName);
    const list = el("ul", "voice-users");
    list.append(...users.map((u) => userRow(u, "voice-user", "s24")));
    wrap.append(row, list);
    return wrap;
  };

  // Channels without a category first, as text and voice lists; then each category.
  const plainText = textChannels().filter((c) => !c.category);
  const plainVoice = voiceChannels().filter((c) => !c.category);
  const categories = [...new Set(r.channels.map((c) => c.category).filter(Boolean))];
  if (plainText.length || !categories.length) {
    items.push(category("Text channels", owner ? () => openChannelDialog("text") : null));
    items.push(...plainText.map(textRow));
    if (!plainText.length) items.push(el("div", "empty-channels", "No text channels"));
  }
  if (plainVoice.length || !categories.length) {
    items.push(category("Voice channels", owner ? () => openChannelDialog("voice") : null));
    items.push(...plainVoice.map(voiceRow));
    if (!plainVoice.length) items.push(el("div", "empty-channels", "No voice channels"));
  }
  for (const name of categories) {
    const key = `${address}|${name}`;
    const closed = !!prefs.closedCategories[key];
    const head = category(name, owner ? () => openChannelDialog("text", name) : null);
    head.classList.add("collapsible");
    head.classList.toggle("closed", closed);
    head.addEventListener("click", (e) => {
      if (e.target.closest(".category-add")) return;
      if (closed) delete prefs.closedCategories[key];
      else prefs.closedCategories[key] = true;
      save("closedCategories", JSON.stringify(prefs.closedCategories));
      renderSidebar();
    });
    items.push(head);
    const inside = r.channels.filter((c) => c.category === name);
    for (const ch of inside) {
      // A closed category still shows where you are and what's waiting.
      const show = !closed || ch.id === state.view || ch.id === mine || channelUnread(address, ch.id);
      if (show) items.push(ch.kind === "text" ? textRow(ch) : voiceRow(ch));
    }
  }

  body.replaceChildren(...items);
}

function openTextChannel(id) {
  if (state.view !== id) {
    saveDraft();
    setReply(null);
    state.editing = null;
  }
  state.view = id;
  restoreDraft();
  renderSidebar();
  renderChannelView();
  $("chat-input").focus();
}

function openChannelMenu(ch, e) {
  e.preventDefault();
  e.stopPropagation();
  const address = activeServer()?.address;
  const muted = channelMuted(address, ch.id);
  const inThis = ch.kind === "voice" && myVoice() === ch.id;
  openMenu(
    [
      ...(ch.kind === "voice"
        ? [inThis ? { label: "Leave voice", icon: "phone-off", action: () => call("leave_voice") } : { label: "Join voice", icon: "volume", action: () => joinVoice(ch.id) }]
        : []),
      { label: "Invite people", icon: "user-plus", action: openInvite },
      ...(ch.kind === "text" && (channelUnread(address, ch.id) || channelMentions(address, ch.id))
        ? [{ label: "Mark as read", icon: "check", action: () => markChannelRead(address, ch.id) }]
        : []),
      ...(ch.kind === "text" ? [{ label: muted ? "Unmute channel" : "Mute channel", icon: "bell", action: () => setChannelMuted(address, ch.id, !muted) }] : []),
      ...(can("manage")
        ? [
            ...(ch.kind === "text" ? ["sep"] : []),
            { label: "Edit channel", icon: "edit", action: () => openChannelEdit(ch) },
            "sep",
            { label: "Delete channel", icon: "trash", danger: true, action: () => deleteChannel(ch) },
          ]
        : []),
    ],
    e.clientX,
    e.clientY,
  );
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
  const talking = className === "voice-user" && state.speaking.has(u.session_id);
  const row = el("li", className + (isSelf ? " self" : "") + (talking ? " speaking" : ""));
  row.dataset.user = u.session_id;
  const member = className === "member";
  // The member list is just who is here: avatar with a status dot, name, crown.
  row.append(avatar(u.name, size, member ? "online" : undefined, pictureFor(keyOf(u))));
  const nameLine = el("span", "name-line");
  nameLine.append(el("span", className === "member" ? "member-name ellipsis" : "ellipsis", u.name));
  const role = roleOf(u);
  if (role) {
    const mark = role === "owner" ? icon("crown", "crown") : icon("shield", `role-mark ${role}`);
    const wrap = el("span", "role-tip");
    wrap.dataset.tip = ROLE_LABEL[role];
    wrap.append(mark);
    nameLine.append(wrap);
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
  // Voice details (muted, deafened, your volume for them) belong in the voice channel.
  if (className === "voice-user" && u.sharing) {
    const live = el("button", "live-pill" + (watching?.from === u.session_id ? " watching" : ""), "LIVE");
    live.type = "button";
    live.dataset.tip = isSelf ? "You're sharing your screen" : watching?.from === u.session_id ? "You're watching" : "Watch their screen";
    live.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!isSelf) watchScreen(u.session_id);
    });
    row.append(live);
  }
  if (className === "voice-user" && state.unreachable.has(u.session_id)) {
    const warn = icon("signal", "xs unreachable");
    warn.dataset.tip = "Can't connect directly: you can't hear each other";
    row.append(warn);
  } else if (className === "voice-user" && !isSelf && connectionGrade(state.quality.get(u.session_id)) !== "good") {
    // Nothing shows while it's fine; weak bars only when it isn't.
    const q = state.quality.get(u.session_id);
    const bars = signalBars(connectionGrade(q));
    bars.dataset.tip = connectionText(q);
    row.append(bars);
  }
  const flags = member ? null : flagsFor(u);
  const vol = userVolume(u);
  if (flags) row.append(flags);
  else if (!member && !isSelf && vol !== undefined && vol !== 100) row.append(el("span", "vol-tag", vol === 0 ? "Muted" : `${vol}%`));
  if (!isSelf) row.addEventListener("click", () => openUserCard(u, row));
  row.addEventListener("contextmenu", (e) => openUserMenu(u, row, e));
  return row;
}

function renderVoicePanel() {
  const panel = $("voice-panel");
  const voice = connected() ? myVoice() : null;
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
  const where = screenShare.stream ? "Sharing your screen" : `${channelName(voice)} / ${activeServer()?.label ?? state.roster.server_name}`;
  $("voice-where").textContent = latency ? `${where} · ${latency}` : where;
  $("share-btn").hidden = !canShare();
  $("share-btn").classList.toggle("on", !!screenShare.stream);
  $("share-btn").setAttribute("aria-label", screenShare.stream ? "Stop sharing your screen" : "Share your screen");
}

function renderUserPanel() {
  const on = connected();
  const name = state.account?.name ?? "";
  const myStatus = state.accountConnected ? state.me?.status ?? "online" : on ? "online" : "offline";
  $("me-avatar-slot").replaceChildren(avatar(name, "", statusDot(myStatus), state.me?.avatar));
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
    ? state.connectingId ? "Connecting…" : state.accountConnected ? STATUS_LABEL[state.me?.status ?? "online"] : "Offline"
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
  const topic = view === null ? null : channel(view)?.topic;
  $("chat-topic").textContent = topic || `${r.users.length} online`;
  $("chat-topic").title = topic || "";
  $("composer").hidden = view === null;
  $("chat-input").placeholder = `Message #${channelName(view)}`;
  $("attach-btn").hidden = !picturesAllowed();
  if (typeof renderAttachment === "function") renderAttachment();
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
  // Someone connected from two computers is one person: shown once (the one in voice, if any).
  const byKey = new Map();
  for (const u of state.roster.users) {
    const id = keyOf(u) ?? `session:${u.session_id}`;
    const seen = byKey.get(id);
    if (!seen || (seen.voice_channel === null && u.voice_channel !== null)) byKey.set(id, u);
  }
  const users = [...byKey.values()].sort(byName);
  const groups = [
    ["Owner", users.filter((u) => roleOf(u) === "owner")],
    ["Admins", users.filter((u) => roleOf(u) === "admin")],
    ["Moderators", users.filter((u) => roleOf(u) === "mod")],
    ["Online", users.filter((u) => !roleOf(u))],
  ];
  const items = [];
  for (const [label, list] of groups) {
    if (list.length === 0) continue;
    items.push(el("li", "member-group", `${label} — ${list.length}`));
    items.push(...list.map((u) => userRow(u, "member", "")));
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
  if (known) connectTo(known);
  else {
    const error = await joinInvite(link);
    if (error) toast(error, true);
  }
}

/**
 * Message text, formatted like other chat apps: **bold**, *italic*, ~~strike~~,
 * `code`, ```code blocks```, > quotes and ||spoilers||; mentions show as names,
 * links are clickable. Everything is built as DOM nodes, never as HTML.
 */
function messageText(text) {
  const out = el("div", "msg-text");
  const parts = text.split(/```(?:[a-z0-9+#-]*\n)?([\s\S]*?)```/i);
  parts.forEach((part, i) => {
    if (i % 2) {
      const pre = el("pre", "code-block");
      pre.append(el("code", "", part.replace(/\n$/, "")));
      out.append(pre);
      return;
    }
    // Text next to a code block loses the line break that the block itself provides.
    if (i > 0) part = part.replace(/^\n/, "");
    if (i < parts.length - 1) part = part.replace(/\n$/, "");
    renderBlocks(part, out);
  });
  return out;
}

/** Lines starting with "> " become a quote; the rest is inline text. */
function renderBlocks(text, out) {
  const lines = text.split("\n");
  let plain = [];
  const flush = () => {
    if (plain.length) renderInline(plain.join("\n"), out);
    plain = [];
  };
  for (let i = 0; i < lines.length; ) {
    if (/^>( |$)/.test(lines[i])) {
      flush();
      const quote = [];
      while (i < lines.length && /^>( |$)/.test(lines[i])) quote.push(lines[i++].replace(/^> ?/, ""));
      const q = el("blockquote", "msg-quote");
      renderInline(quote.join("\n"), q);
      out.append(q);
    } else {
      plain.push(lines[i++]);
    }
  }
  flush();
}

var LINK_ONE = new RegExp(LINK_PATTERN.source, "i");
var INLINE_RULES = [
  ["code", /`([^`\n]+)`/],
  ["mention", /<@([0-9a-f]{64})>/],
  ["link", LINK_ONE],
  ["spoiler", /\|\|([\s\S]+?)\|\|/],
  ["bold", /\*\*([\s\S]+?)\*\*/],
  ["strike", /~~([\s\S]+?)~~/],
  ["italic", /\*([^*\s](?:[^*]*[^*\s])?)\*|(?<![\p{L}\p{N}])_([^_\s](?:[^_]*[^_\s])?)_(?![\p{L}\p{N}])/u],
];

function renderInline(text, out) {
  while (text) {
    let best = null;
    for (const [kind, re] of INLINE_RULES) {
      const m = re.exec(text);
      if (m && (!best || m.index < best.m.index)) best = { kind, m };
    }
    if (!best) {
      out.append(text);
      return;
    }
    const { kind, m } = best;
    out.append(text.slice(0, m.index));
    const inner = m[1] ?? m[2] ?? "";
    if (kind === "code") out.append(el("code", "inline-code", inner));
    else if (kind === "mention") out.append(el("span", "mention" + (inner === state.account?.publicKey ? " me" : ""), `@${nameForKey(inner)}`));
    else if (kind === "link") out.append(linkNode(m[0]));
    else {
      const node = el(kind === "bold" ? "strong" : kind === "italic" ? "em" : kind === "strike" ? "s" : "span", kind === "spoiler" ? "spoiler" : "");
      if (kind === "spoiler") {
        node.title = "Spoiler: click to show";
        node.addEventListener("click", () => node.classList.add("shown"));
      }
      renderInline(inner, node);
      out.append(node);
    }
    text = text.slice(m.index + m[0].length);
  }
}

function linkNode(href) {
  // Invites read as what they are, not as a long address.
  const invite = shortInviteCode(href) !== null || /^(?:hopp|strom):\/\//i.test(href);
  const a = el("a", invite ? "msg-link msg-invite-link" : "msg-link", invite ? "Server invite" : href);
  if (invite) a.title = href;
  a.href = href;
  a.addEventListener("click", (e) => {
    e.preventDefault();
    if (MESSAGE_LINK.test(href)) openMessageLink(href);
    else if (invitePageCode(href)) followInvite(href);
    else if (/^(?:hopp|strom):/i.test(href)) followInvite(href);
    else openExternal(href);
  });
  return a;
}

function canDelete(m) {
  if (state.account && m.author_key === state.account.publicKey) return true;
  if (!can("moderate")) return false;
  const author = state.roster?.users.find((u) => u.public_key === m.author_key);
  return isOwner() || rankOf(author) < rankOf(me());
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
  // Messages newer than the last drawing of this channel arrive with a little motion.
  const drawnBefore = renderedChannel === state.view ? drawnUpTo.get(state.view) ?? Infinity : Infinity;
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
  // Opening a channel: remember where reading stopped, for the "New" line.
  const address = activeServer()?.address;
  if (!keepScrollUnlessAtBottom) {
    // Opening a channel ends a "Mark unread" made earlier.
    state.unreadHold = null;
    const read = state.reads.get(readKey(address, state.view));
    state.newSince = read && read.last_id > read.read_id ? { channel: state.view, id: read.read_id } : null;
  }
  let newSince = state.newSince?.channel === state.view ? state.newSince.id : null;
  const unreadFrom = newSince;

  const welcome = el("li", "welcome");
  const badge = el("div", "welcome-icon");
  badge.append(icon("hash"));
  welcome.append(badge, el("h1", "", `Welcome to #${name}!`), el("p", "", channel(state.view)?.topic || `This is the start of the #${name} channel.`));
  if (msgs.length === 0 && can("manage")) {
    const actions = el("div", "welcome-actions");
    const invite = el("button", "btn primary sm", "Invite people");
    invite.addEventListener("click", openInvite);
    actions.append(invite);
    welcome.append(actions);
  }

  const items = [state.olderDone.has(state.view) ? welcome : olderLoader()];
  let prev = null;
  for (const m of msgs) {
    const day = dayLabel(m.sent_at);
    const newDay = !prev || dayLabel(prev.sent_at) !== day;
    if (newDay) items.push(el("li", "day-divider", day));
    const grouped = !newDay && !m.reply && prev.author_key === m.author_key && prev.sender_name === m.sender_name && m.sent_at - prev.sent_at < GROUP_WINDOW_MS;
    if (newSince !== null && m.id > newSince && m.author_key !== state.account?.publicKey) {
      const line = el("li", "new-divider");
      line.append(el("span", "", "New"));
      items.push(line);
      newSince = null;
    }
    const li = el("li", "msg " + (grouped ? "cont" : "first"));
    li.dataset.id = m.id;
    if (m.id > drawnBefore && m.author_key !== state.account?.publicKey) li.classList.add("arrive");
    if (isBlocked(m.author_key) && !state.shownBlocked.has(m.id)) {
      const line = el("li", "msg blocked-msg");
      const show = el("button", "link", "Show");
      show.type = "button";
      show.addEventListener("click", () => {
        state.shownBlocked.add(m.id);
        renderMessages(true);
      });
      line.append(icon("ban", "xs"), "Blocked message · ", show);
      items.push(line);
      prev = null;
      continue;
    }
    if (mentionsMeIn(m) && m.author_key !== state.account?.publicKey) li.classList.add("mentions-me");
    if (state.replyTo?.id === m.id) li.classList.add("replying");
    if (m.reply) li.append(replyLine(m.reply));
    if (grouped) {
      li.append(el("span", "msg-gutter", clock(m.sent_at)));
    } else {
      const head = el("div", "msg-head");
      const author = el("span", "msg-author", m.sender_name);
      author.style.color = `hsl(${hue(m.sender_name)} var(--name-s) var(--name-l))`;
      head.append(author, el("span", "msg-time", `${day} at ${clock(m.sent_at)}`));
      if (m.pinned) {
        const pin = icon("pin", "xs msg-pin");
        pin.dataset.tip = "Pinned";
        head.append(pin);
      }
      li.append(avatar(m.sender_name, "s40", undefined, pictureFor(m.author_key)), head);
    }
    if (state.editing?.id === m.id) li.append(messageEditor(m));
    else if (PICTURE.test(m.text)) {
      const [, id, w, h] = m.text.match(PICTURE);
      const caption = m.text.slice(m.text.match(PICTURE)[0].length).trim();
      if (caption) li.append(messageText(caption));
      li.append(pictureView(id, Number(w), Number(h)));
    } else if (GIF_URL.test(m.text.trim())) {
      const img = el("img", "msg-gif");
      img.src = m.text.trim();
      img.alt = "GIF";
      img.loading = "lazy";
      img.addEventListener("load", () => {
        const scroller = $("scroller");
        if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 400) scroller.scrollTop = scroller.scrollHeight;
      });
      li.append(img);
    } else if (isInviteOnly(m.text)) {
      // Just an invite: the card below says it all.
    } else {
      const body = messageText(m.text);
      if (m.edited_at) {
        const tag = el("span", "msg-edited", "(edited)");
        tag.dataset.tip = `Edited ${dayLabel(m.edited_at).toLowerCase()} at ${clock(m.edited_at)}`;
        body.append(tag);
      }
      li.append(body);
      if (looksLikeBait(m.text, m.author_key === state.account?.publicKey)) li.append(baitWarning());
    }
    for (const link of new Set([...m.text.matchAll(INVITE_LINK), ...m.text.matchAll(URL_PATTERN)].map((x) => x[0]).filter((l) => inviteTarget(l)).slice(0, 3))) {
      li.append(inviteEmbed(link));
    }
    li.append(...youtubeEmbeds(m.text), ...linkPreviews(m.text));
    if (m.reactions?.length) li.append(reactionRow(m));
    li.append(messageActions(m));
    li.msg = m;
    li.addEventListener("contextmenu", (e) => openMessageMenu(e.currentTarget.msg, e));
    // Kept as is when nothing it shows has changed (a playing video keeps playing).
    li.dataset.key = `${activeServer()?.address}|${m.id}`;
    li.dataset.sig = JSON.stringify([grouped, day, m.sender_name, m.text, m.edited_at, m.reactions, m.pinned, m.reply, state.replyTo?.id === m.id, state.editing?.id === m.id, pictureFor(m.author_key), rankOf(me()), state.shownBlocked.has(m.id), prefs.linkPreviews]);
    items.push(li);
    prev = m;
  }
  // Messages on their way look exactly as they will once sent (grouped under yours),
  // so nothing changes height when the server confirms them.
  const myName = me()?.name ?? state.account?.name ?? "";
  let last = prev && !prev.blocked ? { author_key: prev.author_key, sender_name: prev.sender_name, sent_at: prev.sent_at } : null;
  for (const o of state.outbox.filter((x) => x.channel === state.view)) {
    const grouped = !!last && !o.reply && !o.failed && last.author_key === state.account?.publicKey && last.sender_name === myName && o.at - last.sent_at < GROUP_WINDOW_MS && dayLabel(last.sent_at) === dayLabel(o.at);
    items.push(outboxItem(o, grouped));
    last = { author_key: state.account?.publicKey, sender_name: myName, sent_at: o.at };
  }
  reconcile($("messages"), items);
  // Opening a channel with more new than fits: start at the "New" line, not past it.
  const divider = !keepScrollUnlessAtBottom ? $("messages").querySelector(".new-divider") : null;
  const dividerAt = divider ? divider.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop : 0;
  if (divider && dividerAt < scroller.scrollHeight - scroller.clientHeight - 40) {
    scroller.scrollTop = dividerAt - 56;
    scroller.unstick?.();
    jumpSeen = { channel: state.view, id: unreadFrom };
  } else if (!keepScrollUnlessAtBottom || atBottom) scroller.scrollTop = scroller.scrollHeight;
  if (msgs.length) drawnUpTo.set(state.view, msgs.at(-1).id);
  updateJumpBar();
  markViewedRead();
}

/** An invite posted in chat, shown as a card with the server's name, picture and a Join button. */
/** An invite in chat: a card with the server, who invited you and a Join button. */
function inviteEmbed(link) {
  const target = inviteTarget(link);
  const slot = el("div", "invite-embed");
  slot.dataset.keep = `invite|${link}`;
  const loading = el("div", "invite-card loading");
  loading.append(el("span", "skeleton invite-skel-icon"), el("span", "skeleton invite-skel-text"));
  slot.append(loading);
  const show = (card) => {
    const scroller = $("scroller");
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    slot.replaceChildren(card);
    if (atBottom) scroller.scrollTop = scroller.scrollHeight;
  };
  // A server someone runs: no preview, just where it is.
  if (target.address) {
    const known = prefs.servers.find((x) => x.address === target.address);
    show(inviteCardView({ name: target.address, icon: null, sub: "A server someone runs on their own computer", kicker: "Server invite" }, known, link));
    return slot;
  }
  invitePreview(target.code).then(
    (p) => {
      const known = prefs.servers.find((x) => x.address === `cloud:${p.server_id}`);
      show(inviteCardView({ ...p, kicker: p.inviter ? `${p.inviter} invited you to join` : "You've been invited to join" }, known, link));
    },
    () => {
      const card = el("div", "invite-card invalid");
      const ic = el("span", "invite-card-icon dead");
      ic.append(icon("link"));
      const text = el("div", "invite-card-text");
      text.append(el("strong", "", "Invite expired"), el("span", "", "Ask whoever sent it for a new one."));
      card.append(ic, text);
      show(card);
    },
  );
  return slot;
}

function inviteCardView(p, known, link) {
  const card = el("div", "invite-card");
  // A server picks its own icon: only plain image data goes into the style.
  const art = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(p.icon ?? "") ? p.icon : null;
  if (art) card.style.setProperty("--invite-art", `url("${art}")`);
  card.classList.toggle("has-art", !!art);
  card.append(el("div", "invite-card-kicker", p.kicker));
  const row = el("div", "invite-card-row");
  const pic = serverIcon("invite-card-icon server-tint", p.name ?? "?", p.icon);
  const text = el("div", "invite-card-text");
  text.append(el("strong", "ellipsis", p.name ?? "Server"));
  if (p.members !== undefined) {
    const counts = el("span", "invite-counts");
    const on = el("span", "count");
    on.append(el("i", "count-dot online"), `${p.online} Online`);
    const all = el("span", "count");
    all.append(el("i", "count-dot"), `${p.members} ${p.members === 1 ? "Member" : "Members"}`);
    counts.append(on, all);
    text.append(counts);
  } else if (p.sub) {
    text.append(el("span", "invite-sub", p.sub));
  }
  const here = known && known.id === state.activeId;
  const btn = el("button", "btn invite-join" + (here ? " joined" : known ? "" : " go"), here ? "Joined" : known ? "Open" : "Join");
  btn.type = "button";
  btn.disabled = !!here;
  btn.addEventListener("click", () => followInvite(link));
  row.append(pic, text, btn);
  card.append(row);
  return card;
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
  if (state.openDm) {
    renderDmView();
    return;
  }
  $("home").classList.remove("dm-open");
  $("home").querySelector(".head-title").textContent = "Friends";
  $("home").querySelector(".head-icon").innerHTML = '<use href="#i-users"/>';
  $("home-body").classList.remove("dm-body");
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

  renderFriendTabs();
  sections.push(friendsPanel());
  // The friends page with "Active now" beside it.
  const main = el("div", "home-main");
  main.append(...sections);
  const layout = el("div", "home-layout");
  layout.append(main, activeNowPanel());
  body.replaceChildren(layout);
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

/** The picture chosen while creating a server (a small data: URL), saved once it exists. */
let createIcon = null;

function updateServerIconPreview() {
  const name = $("create-server-name").value.trim() || "?";
  const icon = $("create-server-icon");
  $("create-server-letters").textContent = createIcon ? "" : initials(name);
  icon.style.setProperty("--hue", hue(name));
  icon.style.backgroundImage = createIcon ? `url("${createIcon}")` : "";
  icon.classList.toggle("has-picture", !!createIcon);
  $("create-server-icon-remove").hidden = !createIcon;
}
$("create-server-icon").addEventListener("click", () => $("create-server-file").click());
$("create-server-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    createIcon = await shrinkPicture(file);
    $("create-server-error").hidden = true;
  } catch (err) {
    $("create-server-error").textContent = err.message;
    $("create-server-error").hidden = false;
  }
  updateServerIconPreview();
});
$("create-server-icon-remove").addEventListener("click", () => {
  createIcon = null;
  updateServerIconPreview();
});
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
    // The picture goes on as soon as the server exists.
    if (createIcon) invoke("update_server", { name, icon: createIcon, picturesOff: null }).catch((err) => toast(friendlyError(err), true));
    createIcon = null;
    $("add-dialog").close();
    $("create-server-name").value = "";
    updateServerIconPreview();
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
      box.replaceChildren(inviteCard(p, p.inviter ? `${p.inviter} invited you to join` : "You've been invited to join").card);
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
  if (can("manage")) {
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

function openChannelDialog(kind, inCategory) {
  state.newChannelCategory = inCategory ?? null;
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
  if (!name) return;
  // Made from a category's +: put it there once the server has made it.
  if (state.newChannelCategory) state.pendingCategory = { name: state.newChannelCategory, known: new Set(state.roster.channels.map((c) => c.id)) };
  call("create_channel", { name, kind: channelKind });
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
  // Cloud invites are web links anyone can click; they open Hopp, or help install it.
  $("invite-link").value = address ? `hopp://${address}/${invite.code}` : `${prefs.cloudUrl.replace(/^ws/, "http")}/i/${invite.code}`;
  $("invite-summary").textContent = inviteSummary(invite);
}

async function openInvite() {
  const server = activeServer();
  $("invite-server").textContent = server.label;
  $("invite-icon-slot").replaceChildren(serverIcon("invite-icon server-tint", server.label, server.icon));
  const owner = can("manage");
  $("invite-owner").hidden = !owner;
  $("invite-member").hidden = owner;
  $("invite-options").hidden = true;
  $("invite-edit").hidden = false;
  invitedFriends.clear();
  $("invite-friend-search").value = "";
  openModal($("invite-dialog"));
  if (!owner) return;
  renderInviteFriends();
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
  $("server-members").replaceChildren(el("li", "admin-empty", "Loading…"));
  $("member-search").value = "";
  document.querySelector('[data-stab="members"]').hidden = !isCloud(activeServer());
  openModal($("server-settings"));
  call("get_server_settings");
}
function showServerTab(tab) {
  document.querySelectorAll("[data-stab]").forEach((t) => t.classList.toggle("active", t.dataset.stab === tab));
  document.querySelectorAll("[data-spanel]").forEach((p) => (p.hidden = p.dataset.spanel !== tab));
}
document.querySelectorAll("[data-stab]").forEach((t) => t.addEventListener("click", () => showServerTab(t.dataset.stab)));

// Overview: the owner edits the server's name and picture; saved together.
const overview = { icon: null };

function resetOverview() {
  overview.icon = state.roster?.server_icon ?? null;
  $("overview-name").value = state.roster?.server_name ?? "";
  $("overview-pictures").checked = !state.roster?.pictures_off;
  $("overview-pictures-row").hidden = !isCloud(activeServer());
  $("overview-error").hidden = true;
  renderOverview();
}

function overviewChanged() {
  const r = state.roster;
  return !!r && ($("overview-name").value.trim() !== r.server_name || overview.icon !== (r.server_icon ?? null) || $("overview-pictures").checked === !!r.pictures_off);
}

function renderOverview() {
  const name = $("overview-name").value.trim() || state.roster?.server_name || "?";
  $("overview-icon-slot").replaceChildren(serverIcon("overview-preview server-tint", name, overview.icon));
  $("overview-remove").hidden = !overview.icon;
  $("overview-save-bar").hidden = !overviewChanged();
}

/** Scales a picture down to a square of at most 256 px, small enough to send to the server. */
function shrinkPicture(file, steps = [[256, 0.9], [256, 0.75], [192, 0.7], [128, 0.7]], limit = 190_000) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      for (const [size, quality] of steps) {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = Math.min(size, side);
        // Crop to the centre square.
        canvas.getContext("2d").drawImage(
          img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, canvas.width, canvas.height,
        );
        let data = canvas.toDataURL("image/webp", quality);
        if (!data.startsWith("data:image/webp")) data = canvas.toDataURL("image/jpeg", quality);
        if (data.length <= limit) return resolve(data);
      }
      reject(new Error("That picture is too large. Try a smaller one."));
    };
    const unreadable = () => reject(new Error("That file isn't a picture Hopp can read. Use PNG, JPEG or WebP."));
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
$("overview-pictures").addEventListener("change", renderOverview);
$("overview-reset").addEventListener("click", resetOverview);
$("overview-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("overview-name").value.trim();
  if (!name) return;
  const btn = $("overview-save");
  setBusy(btn, true, "Saving…");
  try {
    await invoke("update_server", { name, icon: overview.icon, picturesOff: isCloud(activeServer()) ? !$("overview-pictures").checked : null });
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
  $("confirm-cancel").textContent = cancel ?? "";
  $("confirm-cancel").hidden = cancel === null;
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
chatInput.addEventListener("keydown", async (e) => {
  if (mentionKeydown(e)) return;
  if (e.key === "Escape" && state.replyTo) {
    e.preventDefault();
    setReply(null);
    return;
  }
  if (e.key === "Escape" && !chatInput.value && !mentionPicker.open) {
    e.preventDefault();
    catchUp();
    return;
  }
  // Up in an empty box edits your last message.
  if (e.key === "ArrowUp" && !chatInput.value && state.view !== null) {
    const mine = (state.chats.get(state.view) ?? []).findLast((m) => m.author_key === state.account?.publicKey);
    if (mine) {
      e.preventDefault();
      startEdit(mine);
    }
    return;
  }
  // Enter while an input method is composing a character confirms the character, not the message.
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    if (state.attachment && state.view !== null) {
      sendPicture();
      return;
    }
    const text = withMentions(chatInput.value.trim());
    if (!text || state.view === null) return;
    if (await phraseBlocked(text)) return;
    const replyTo = state.replyTo?.channel === state.view ? state.replyTo.id : null;
    setReply(null);
    chatInput.value = "";
    lastTypingSent = 0;
    composeMentions.clear();
    state.newSince = null;
    autosize();
    clearDraft();
    sendChat(state.view, text, replyTo);
  }
});
function autosize() {
  chatInput.style.height = "auto";
  chatInput.style.height = `${chatInput.scrollHeight}px`;
}
chatInput.addEventListener("input", () => {
  autosize();
  updateMentionPicker();
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

// Unmuting while deafened undeafens too.
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
  renderSettingsMe();
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
$("me-card").addEventListener("click", () => {
  const r = $("me-card").getBoundingClientRect();
  openStatusMenu(r.left, r.top);
});
$("settings").addEventListener("close", stopMicTest);
$("settings").addEventListener("close", stopRecordingPtt);

function renderProfilePreview() {
  const name = state.account?.name ?? "?";
  const picture = state.me?.avatar ?? null;
  $("profile-banner").style.setProperty("--hue", hue(name));
  bannerFrom(picture);
  $("profile-avatar-slot").replaceChildren(avatar(name, "s80", undefined, picture));
  if (typeof renderAccountSettings === "function" && state.me !== undefined) renderAccountSettings();
  $("profile-name").textContent = name;
  $("profile-display").textContent = name;
  $("profile-handle").textContent = state.me?.username ? `@${state.me.username}` : "";
}

/** Colours the profile banner after the picture's average colour, softened into the grey. */
let bannerFor = null;
function bannerFrom(picture) {
  if (picture === bannerFor) return;
  bannerFor = picture;
  const banner = $("profile-banner");
  if (!picture) return banner.style.removeProperty("--banner");
  const img = new Image();
  img.onload = () => {
    if (bannerFor !== picture) return;
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0, 1, 1);
    const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
    banner.style.setProperty("--banner", `color-mix(in srgb, rgb(${r} ${gr} ${b}) 45%, var(--main))`);
  };
  img.src = picture;
}

function editName(open) {
  $("name-form").hidden = !open;
  $("name-form").previousElementSibling.hidden = open;
  $("rename-status").hidden = true;
  if (open) {
    $("settings-name").value = state.account?.name ?? "";
    $("settings-name").focus();
    $("settings-name").select();
  }
}
$("name-edit").addEventListener("click", () => editName(true));
$("name-cancel").addEventListener("click", () => editName(false));
$("settings-name").addEventListener("keydown", (e) => {
  // Escape cancels the edit instead of closing settings.
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    editName(false);
  }
});
$("name-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const status = $("rename-status");
  const wanted = $("settings-name").value.trim();
  if (!wanted || wanted === state.account.name) return editName(false);
  try {
    const name = await invoke("rename_account", { name: wanted });
    state.account.name = name;
    invoke("account_send", { msg: { type: "set_profile", display_name: name } }).catch(() => {});
    editName(false);
    renderProfilePreview();
    renderUserPanel();
  } catch (err) {
    status.textContent = String(err);
    status.hidden = false;
  }
});
$("avatar-edit").addEventListener("click", () => $("avatar-file").click());
$("settings").addEventListener("close", () => editName(false));

// The mic check: outside voice it opens the microphone just for the settings screen.
function inVoice() {
  return connected() && myVoice() !== null;
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

// Hear Hopp on the chosen speakers.
$("test-output").addEventListener("click", () => {
  invoke("test_output").catch((err) => toast(friendlyError(err), true));
});

/** Quick device switching from the user panel, like the settings page but one click away. */
let deviceCache = null;
/** The device list: the saved one at once, then a fresh one in the background. */
async function freshDevices() {
  const list = await call("list_devices", { fresh: true });
  if (list) deviceCache = list;
  return list;
}

async function openDeviceMenu(kind, anchor) {
  if (!$("server-menu").hidden && $("server-menu").dataset.owner === kind) return closePopovers();
  const list = deviceCache ?? (deviceCache = await call("list_devices"));
  if (!list) return;
  renderDeviceMenu(kind, anchor, list);
  // Devices may have come or gone since; update the open menu if so.
  const before = JSON.stringify(list);
  const now = await freshDevices();
  if (now && JSON.stringify(now) !== before && !$("server-menu").hidden && $("server-menu").dataset.owner === kind) {
    renderDeviceMenu(kind, anchor, now);
  }
}

function renderDeviceMenu(kind, anchor, list) {
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
  const show = (list) => {
    checkBluetooth(list);
    fillSelect($("input-device"), list.inputs, list.default_input, prefs.inputDevice);
    fillSelect($("output-device"), list.outputs, list.default_output, prefs.outputDevice);
  };
  const cached = deviceCache ?? (deviceCache = await call("list_devices"));
  if (cached) show(cached);
  const fresh = await freshDevices();
  if (fresh && JSON.stringify(fresh) !== JSON.stringify(cached)) show(fresh);
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
  toast("Push to talk can't see your key while the app in front runs as administrator. Run Hopp as administrator too, or the game without it.", true);
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
  ring: [[784, 0], [988, 0.13], [784, 0.42], [988, 0.55]],
  ringback: [[440, 0], [440, 0.3]],
};
/** Which switch each sound belongs to, in the order the Sounds tab lists them. */
const SOUND_EVENTS = [
  ["mute", "Mute and unmute", ["mute", "unmute"]],
  ["deafen", "Deafen and undeafen", ["deafen", "undeafen"]],
  ["self", "Joining and leaving voice", ["join", "leave"]],
  ["others", "Others joining and leaving", ["user_join", "user_leave"]],
  ["ptt", "Push to talk", ["ptt_on", "ptt_off"]],
  ["message", "New messages", ["message"]],
  ["calls", "Calls ringing", ["ring", "ringback"]],
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
  if (state.me?.status === "dnd" && !isPtt && !["mute", "unmute", "deafen", "undeafen"].includes(name)) return;
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


/** Every voice and audio setting back to how Hopp starts out; devices and the push-to-talk key stay. */
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
    const vol = isBlocked(keyOf(u)) ? 0 : userVolume(u);
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
  $("user-card-avatar-slot").replaceChildren(avatar(user.name, "s80", undefined, pictureFor(keyOf(user))));
  $("user-card-name").textContent = user.name;
  const sub = $("user-card-sub");
  if (user.voice_channel !== null) sub.replaceChildren(icon("volume", "sm"), el("span", "", `In ${channelName(user.voice_channel)}`));
  else sub.replaceChildren(el("span", "", roleOf(user) ? (roleOf(user) === "owner" ? "Server owner" : ROLE_LABEL[roleOf(user)]) : "Online"));
  const actOn = can("moderate") && outranks(user);
  $("user-mod").hidden = !actOn;
  $("user-ban").hidden = !can("manage");
  renderUserRole(user);
  syncUserCard();
  // Open beside the row, like a profile card.
  const r = anchor.getBoundingClientRect();
  const card = $("user-card");
  card.hidden = false;
  const x = r.left > window.innerWidth / 2 ? r.left - card.offsetWidth - 12 : r.right + 12;
  placePopover(card, x, r.top);
}

function syncUserCard() {
  // In voice with us: how the connection to them is.
  const q = cardUser.voice_channel !== null && cardUser.voice_channel === myVoice() ? state.quality.get(cardUser.session_id) : undefined;
  const line = $("user-card-connection");
  line.hidden = !q;
  if (q) {
    line.className = "user-card-connection " + connectionGrade(q);
    line.replaceChildren(signalBars(connectionGrade(q)), el("span", "", connectionText(q)));
  }
  const vol = userVolume(cardUser) ?? 100;
  $("user-volume").value = vol;
  $("user-volume-value").textContent = `${vol}%`;
  const btn = $("user-mute");
  btn.textContent = vol === 0 ? "Unmute for me" : "Mute for me";
}

function setUserVolume(vol) {
  // Kept by Hopp ID, so two people with the same name have their own volume.
  delete prefs.userVolumes[cardUser.name];
  const id = keyOf(cardUser) ?? cardUser.name;
  if (vol === 100) delete prefs.userVolumes[id];
  else prefs.userVolumes[id] = vol;
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
      ? { title: `Ban ${user.name}`, text: `${user.name} is disconnected and can never rejoin with this Hopp ID, not even with an invite. You can undo this in Server settings.`, ok: "Ban" }
      : { title: `Kick ${user.name}`, text: `${user.name} is disconnected right away. As a member they can rejoin later.`, ok: "Kick" },
  );
  if (ok) call("kick", { sessionId: user.session_id, ban });
}

$("user-volume").addEventListener("input", (e) => setUserVolume(Number(e.target.value)));
$("user-mute").addEventListener("click", () => setUserVolume((userVolume(cardUser) ?? 100) === 0 ? 100 : 0));
$("user-kick").addEventListener("click", () => removeUser(false));
$("user-role").addEventListener("change", (e) => {
  const user = cardUser;
  setRole({ public_key: user.public_key, name: user.name }, e.target.value || null);
});
$("user-transfer").addEventListener("click", () => {
  const user = cardUser;
  closePopovers();
  transferOwnership({ public_key: user.public_key, name: user.name });
});
$("user-ban").addEventListener("click", () => removeUser(true));
document.addEventListener("mousedown", (e) => {
  if ([...document.querySelectorAll(".popover")].some((p) => !p.hidden && p.contains(e.target))) return;
  if (e.target.closest("#sidebar-head, .split-more")) return;
  closePopovers();
});

// ---------- tooltips ----------

const tip = $("tooltip");
/** Icons that say what they are: no tooltip, just the icon (the words stay for screen readers). */
var PLAIN_ICONS = ".icon-btn, .composer-icon, .split-main, .split-more, .panel-btn, .call-btn, .reply-cancel, .win-btn, .msg-actions button, .rail-item.home, .rail-item.add";

document.addEventListener("mouseover", (e) => {
  const target = e.target.closest("[data-tip]");
  if (!target || !target.dataset.tip) return;
  if (target.matches(PLAIN_ICONS)) {
    if (!target.getAttribute("aria-label")) target.setAttribute("aria-label", target.dataset.tip);
    return;
  }
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

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k" && state.account) {
    e.preventDefault();
    return $("quick").hidden ? openQuick() : closeQuick();
  }
  if (e.key === "Escape") closePopovers();
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
    const input = state.openDm && !online() ? $("dm-search-input") : connected() && state.view !== null ? $("search-input") : null;
    if (input?.offsetParent) {
      e.preventDefault();
      input.focus();
      input.select();
      return;
    }
  }
  if (!connected()) return;
  if (e.ctrlKey && e.key.toLowerCase() === "m") { e.preventDefault(); $("mute-btn").click(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === "d") { e.preventDefault(); setDeafened(!state.deafened); }
});

// ---------- window controls (the native frame is off) ----------

const appWindow = window.__TAURI__.window?.getCurrentWindow();
$("win-min").addEventListener("click", () => appWindow?.minimize());
$("win-max").addEventListener("click", () => appWindow?.toggleMaximize());
// ---------- Windows settings ----------

async function renderWindowsSettings() {
  $("close-action").value = load("closeAction", "") === "quit" ? "quit" : "tray";
  $("autostart").checked = await invoke("autostart_enabled").catch(() => false);
}
document.querySelector('.settings-tab[data-tab="windows"]').addEventListener("click", renderWindowsSettings);
$("close-action").addEventListener("change", (e) => save("closeAction", e.target.value));
$("autostart").addEventListener("change", async (e) => {
  try {
    await invoke("set_autostart", { on: e.target.checked });
  } catch (err) {
    e.target.checked = !e.target.checked;
    toast(friendlyError(err), true);
  }
});

// Closing the window: keep running in the notification area, or quit.
// Asked once; the answer is kept.
$("win-close").addEventListener("click", async () => {
  // Not logged in: nothing to keep running.
  if (!state.account) return invoke("quit_app");
  let choice = load("closeAction", "");
  if (!choice) {
    const keep = await confirmDialog({
      title: "Keep Hopp running?",
      text: "Hopp can keep running in the notification area when you close the window, so you stay in voice and still get messages. Open it again from the icon by the clock.",
      ok: "Keep running",
      cancel: "Quit Hopp",
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

// strom:// links from outside (a browser, another app, or what Hopp was started with).
async function openLink(url) {
  if (!state.account || !/^(?:hopp|strom):\/\//i.test(url)) return;
  closePopovers();
  if (MESSAGE_LINK.test(url)) return openMessageLink(url);
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

// ---------- your account: profile, status, friends, synced data ----------
//
// The account lives in Hopp Cloud (one object per Hopp ID, see cloud/src/account.ts).
// This keeps state.me and state.friends in step with it and draws the Friends page.

state.me = null; // { key, username, display_name, avatar, bio, status, privacy }
state.friends = new Map(); // key -> { key, username, display_name, avatar, state, status, activity }
state.accountConnected = false;
state.friendTab = "online";
let usernameAsked = false;

function accountSend(msg) {
  return invoke("account_send", { msg }).catch((err) => {
    toast(friendlyError(err), true);
    throw err;
  });
}

function startAccount() {
  invoke("start_account", { cloud: prefs.cloudUrl }).catch(() => {});
}

listen("account-state", (e) => {
  state.accountConnected = !!e.payload.connected;
  state.accountError = e.payload.connected ? null : e.payload.error ?? null;
  renderUserPanel();
  if (!online()) renderHome();
});

listen("account", (e) => {
  const m = e.payload;
  if (onDmEvent(m)) return;
  switch (m.type) {
    case "welcome":
      state.me = m.me;
      state.friends = new Map(m.friends.map((f) => [f.key, f]));
      state.conversations = new Map((m.conversations ?? []).map((c) => [c.peer, { last_at: c.last_at, last_read: c.last_read }]));
      for (const row of m.channels ?? []) mergeRead(row);
      state.groups = new Map((m.groups ?? []).map((g) => [g.id, g]));
      for (const g of state.groups.values()) if (!state.conversations.has(g.id)) state.conversations.set(g.id, { last_at: g.created_at, last_read: g.created_at });
      state.readsLoaded = true;
      renderUnread();
      // A reconnect: fetch what arrived meanwhile for conversations already open.
      for (const peer of state.dmMessages.keys()) invoke("account_send", { msg: { type: "dm_history", with: peer } }).catch(() => {});
      syncState.version = m.sync.version;
      receiveSync(m.sync.data);
      // A Hopp ID made before usernames: ask once (it can wait).
      if (!m.me.username && !usernameAsked && !state.onboarding) {
        usernameAsked = true;
        openUsernameDialog(true);
      }
      setActivityFromVoice();
      break;
    case "channel_activity": {
      const fresh = mergeRead(m);
      if (fresh) notifyMention({ server: m.server, channel: m.channel, author_key: m.author_key, author_name: m.author_name, channel_name: m.channel_name, text: m.preview ? previewText(m.preview) : "Mentioned you", mention: m.mention });
      renderUnread();
      return;
    }
    case "call":
      handleCallSignal(m);
      return;
    case "group":
      state.groups.set(m.group.id, m.group);
      if (!state.conversations.has(m.group.id)) state.conversations.set(m.group.id, { last_at: m.group.created_at, last_read: m.group.created_at });
      renderAll();
      return;
    case "group_removed":
      state.groups.delete(m.id);
      state.conversations.delete(m.id);
      if (state.openDm === m.id) state.openDm = null;
      renderAll();
      return;
    case "group_created":
      if (m.id) openDm(m.id);
      return;
    case "call_self":
      handleCallSelf(m);
      return;
    case "channel_read":
      mergeRead(m);
      renderUnread();
      return;
    case "profile":
      state.me = { ...state.me, ...m.me };
      renderPictures();
      if ($("username-dialog").open && m.me.username) $("username-dialog").close();
      if ($("welcome-dialog").open) renderWelcomeAvatar();
      break;
    case "status":
      state.me.status = m.status;
      break;
    case "privacy":
      state.me.privacy = m.requests;
      break;
    case "sync":
      syncState.version = m.version;
      // A refused save: merge with the newer copy, then save again.
      if (m.conflict) syncState.saving = false;
      receiveSync(m.data, m.conflict);
      break;
    case "sync_saved":
      syncState.version = m.version;
      syncState.saving = false;
      if (syncState.dirty) pushSync();
      break;
    case "friend": {
      const before = state.friends.get(m.friend.key);
      state.friends.set(m.friend.key, m.friend);
      if ((before?.state === "blocked") !== (m.friend.state === "blocked")) blockChanged();
      if (before?.avatar !== m.friend.avatar) renderPictures();
      if (m.request) {
        toast(`${m.friend.display_name} (@${m.friend.username}) sent you a friend request.`);
        playSound("user_join");
        desktopNotify(m.friend, "Sent you a friend request", "friend-requests");
      } else if (m.accepted) {
        toast(`${m.friend.display_name} accepted your friend request.`);
        desktopNotify(m.friend, "Accepted your friend request", `dm:${m.friend.key}`);
      } else if (m.friend.state === "outgoing" && !before) {
        addFriendResult(`Friend request sent to @${m.friend.username}.`, false);
      }
      break;
    }
    case "friend_removed":
      if (state.friends.get(m.key)?.state === "blocked") {
        state.friends.delete(m.key);
        blockChanged();
      }
      state.friends.delete(m.key);
      break;
    case "presence": {
      const f = state.friends.get(m.key);
      if (f) Object.assign(f, { status: m.status, activity: m.activity });
      if (state.call?.peer === m.key && m.status === "offline") {
        toast(`${f?.display_name ?? "Your friend"} went offline. The call ended.`);
        endCall("remote");
      }
      break;
    }
    case "username_check":
      showUsernameCheck(m);
      return;
    case "error":
      // Read marks are best effort (an older cloud doesn't know them yet).
      if (m.for === "channel_read") return;
      if (m.for === "friend_request") addFriendResult(m.message, true);
      else if (m.for === "claim_username" || m.for === "check_username") showUsernameError(m.message);
      else toast(m.message, true);
      return;
  }
  renderUserPanel();
  renderProfilePreview();
  if (!online()) {
    renderSidebar();
    renderHome();
  }
});

// ---------- presence: what friends see you doing ----------

let lastActivity;
function setActivityFromVoice() {
  // Just "in voice": which server and channel stays private.
  const activity = inVoice() ? "In voice" : null;
  if (activity === lastActivity || !state.accountConnected) return;
  lastActivity = activity;
  invoke("account_send", { msg: { type: "set_activity", activity } }).catch(() => {});
}

const STATUS_LABEL = { online: "Online", idle: "Idle", dnd: "Do Not Disturb", invisible: "Invisible", offline: "Offline" };

function openStatusMenu(x, y) {
  const current = state.me?.status ?? "online";
  const item = (status, sub) => ({
    label: STATUS_LABEL[status],
    sub,
    checked: current === status,
    action: () => accountSend({ type: "set_status", status }).catch(() => {}),
  });
  openMenu(
    [
      { heading: "Status" },
      item("online"),
      item("idle"),
      item("dnd", "No notification sounds"),
      item("invisible", "You'll look offline"),
      "sep",
      { label: "Edit profile", icon: "user", action: () => openSettings("profile") },
    ],
    x,
    y,
    true,
  );
}

// ---------- the Friends page ----------

function friendRows(tab) {
  const all = [...state.friends.values()];
  const byName = (a, b) => a.display_name.localeCompare(b.display_name, undefined, { sensitivity: "base" });
  if (tab === "online") return all.filter((f) => f.state === "friend" && f.status !== "offline").sort(byName);
  if (tab === "all") return all.filter((f) => f.state === "friend").sort(byName);
  if (tab === "pending") return all.filter((f) => f.state === "incoming" || f.state === "outgoing").sort((a, b) => (a.state === b.state ? byName(a, b) : a.state === "incoming" ? -1 : 1));
  if (tab === "blocked") return all.filter((f) => f.state === "blocked").sort(byName);
  return [];
}

function personAvatar(p, size, withStatus) {
  const a = avatar(p.display_name || p.username || "?", size, withStatus ? statusDot(p.status) : undefined, p.avatar);
  return a;
}

function statusDot(status) {
  return status === "online" ? "online" : status === "idle" ? "idle" : status === "dnd" ? "dnd" : "offline";
}

function friendRow(f) {
  const li = el("li", "friend-row");
  const text = el("div", "friend-text");
  const top = el("div", "friend-top");
  top.append(el("strong", "ellipsis", f.display_name));
  if (f.username) top.append(el("span", "friend-username ellipsis", `@${f.username}`));
  const sub =
    f.state === "incoming" ? "Wants to be friends"
    : f.state === "outgoing" ? "Request sent"
    : f.state === "blocked" ? "Blocked"
    : f.activity && f.status !== "offline" ? f.activity
    : STATUS_LABEL[f.status] ?? "Offline";
  text.append(top, el("span", "friend-sub ellipsis", sub));
  li.append(personAvatar(f, "s40", f.state === "friend"), text);

  const actions = el("div", "friend-actions");
  const action = (iconName, tipText, onClick, cls = "") => {
    const b = el("button", `icon-btn round ${cls}`);
    b.dataset.tip = tipText;
    b.append(icon(iconName));
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick(e);
    });
    actions.append(b);
  };
  if (f.state === "incoming") {
    action("check", "Accept", () => accountSend({ type: "friend_accept", key: f.key }), "accept");
    action("x", "Ignore", () => accountSend({ type: "friend_decline", key: f.key }), "decline");
  } else if (f.state === "outgoing") {
    action("x", "Cancel request", () => accountSend({ type: "friend_remove", key: f.key }), "decline");
  } else if (f.state === "blocked") {
    const b = el("button", "btn sm", "Unblock");
    b.addEventListener("click", () => accountSend({ type: "unblock", key: f.key }));
    actions.append(b);
  } else {
    action("message", "Message", () => openDm(f.key));
    li.classList.add("clickable");
    li.addEventListener("click", () => openDm(f.key));
    action("more", "More", (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      openMenu(
        [
          { label: friendGroup(f.key) ? "Change friend group…" : "Add to a friend group…", icon: "users", action: () => pickFriendGroup(f) },
          ...(friendGroup(f.key) ? [{ label: "Remove from " + friendGroup(f.key), icon: "x", action: () => setFriendGroup(f.key, "") }] : []),
          "sep",
          { label: "Remove friend", icon: "x", action: () => removeFriend(f) },
          { label: "Block", icon: "ban", danger: true, action: () => blockPerson(f) },
        ],
        r.left - 150,
        r.bottom + 4,
      );
    });
  }
  li.append(actions);
  return li;
}

async function removeFriend(f) {
  const ok = await confirmDialog({ title: `Remove ${f.display_name}`, text: `Remove ${f.display_name} from your friends? You can add them again later.`, ok: "Remove friend" });
  if (ok) accountSend({ type: "friend_remove", key: f.key }).catch(() => {});
}

async function blockPerson(f) {
  const ok = await confirmDialog({
    title: `Block ${f.display_name}`,
    text: "They won't be able to send you friend requests. They aren't told you blocked them.",
    ok: "Block",
  });
  if (ok) accountSend({ type: "block", key: f.key }).catch(() => {});
}

function renderFriendTabs() {
  const pending = friendRows("pending").filter((f) => f.state === "incoming").length;
  for (const b of document.querySelectorAll("[data-ftab]")) {
    b.classList.toggle("active", b.dataset.ftab === state.friendTab);
    const badge = b.querySelector(".tab-badge");
    if (badge) {
      badge.textContent = pending;
      badge.hidden = b.dataset.ftab !== "pending" || pending === 0;
    }
  }
}

for (const b of document.querySelectorAll("[data-ftab]")) {
  b.addEventListener("click", () => {
    state.friendTab = b.dataset.ftab;
    renderHome();
    if (state.friendTab === "add") setTimeout(() => $("add-friend-input")?.focus(), 0);
  });
}

let addFriendMessage = null;
function addFriendResult(text, isError) {
  addFriendMessage = { text, isError };
  const box = $("add-friend-result");
  if (box) {
    box.textContent = text;
    box.className = `add-friend-result ${isError ? "error" : "ok"}`;
    box.hidden = false;
  }
  if (!isError && $("add-friend-input")) $("add-friend-input").value = "";
}

function addFriendPanel() {
  const panel = el("section", "add-friend");
  panel.append(el("h2", "", "Add friend"), el("p", "hint", "Add friends with their Hopp username."));
  if (!state.me?.username) {
    const need = el("div", "callout-info");
    const btn = el("button", "btn sm primary", "Pick a username");
    btn.addEventListener("click", () => openUsernameDialog(false));
    need.append(el("span", "", "You need a username first, so people know who's asking."), btn);
    panel.append(need);
    return panel;
  }
  const form = el("form", "add-friend-form");
  const at = el("span", "at", "@");
  const input = el("input");
  input.id = "add-friend-input";
  input.placeholder = "username";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.maxLength = 33;
  const send = el("button", "btn primary sm", "Send friend request");
  send.type = "submit";
  send.disabled = true;
  input.addEventListener("input", () => {
    input.value = input.value.toLowerCase().replace(/\s/g, "");
    send.disabled = input.value.replace(/^@/, "").length < 2;
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const username = input.value.replace(/^@/, "");
    if (username.length < 2) return;
    accountSend({ type: "friend_request", username }).catch(() => {});
  });
  form.append(at, input, send);
  const result = el("p", "add-friend-result");
  result.id = "add-friend-result";
  result.hidden = !addFriendMessage;
  if (addFriendMessage) {
    result.textContent = addFriendMessage.text;
    result.classList.add(addFriendMessage.isError ? "error" : "ok");
  }
  const mine = el("p", "hint your-name");
  const copy = el("button", "link", "Copy");
  copy.type = "button";
  copy.addEventListener("click", () => copyText(state.me.username, copy, "Copy"));
  mine.append(`Your username is @${state.me.username} · `, copy);
  panel.append(form, result, mine);
  return panel;
}

function friendsPanel() {
  const wrap = el("section", "friends");
  if (!state.accountConnected && !state.me) {
    const box = el("div", "friends-empty");
    box.append(el("span", "spinner"), el("p", "", state.accountError ? (/overloaded/.test(friendlyError(state.accountError)) ? friendlyError(state.accountError) : "Can't reach your account right now. Trying again…") : "Connecting to your account…"));
    wrap.append(box);
    return wrap;
  }
  if (state.friendTab === "add") {
    wrap.append(addFriendPanel());
    return wrap;
  }
  if (state.friendTab === "online" && state.friends.size === 0 && prefs.servers.length === 0) {
    wrap.append(gettingStarted());
    return wrap;
  }
  const rows = friendRows(state.friendTab);
  const label = { online: "Online", all: "All friends", pending: "Pending", blocked: "Blocked" }[state.friendTab];
  wrap.append(el("h3", "friends-count", `${label} — ${rows.length}`));
  if (rows.length === 0) {
    const empty = el("div", "friends-empty");
    const text = {
      online: state.friends.size ? "None of your friends are online right now." : "No friends yet. Add someone with their username.",
      all: "No friends yet. Add someone with their username.",
      pending: "No friend requests waiting.",
      blocked: "You haven't blocked anyone.",
    }[state.friendTab];
    empty.append(el("p", "", text));
    if (state.friendTab !== "blocked" && state.friendTab !== "pending") {
      const add = el("button", "btn primary sm", "Add friend");
      add.addEventListener("click", () => {
        state.friendTab = "add";
        renderHome();
      });
      empty.append(add);
    }
    wrap.append(empty);
    return wrap;
  }
  // Your own friend groups, each under its name; everyone else after them.
  const grouped = state.friendTab === "online" || state.friendTab === "all" ? groupFriends(rows) : [["", rows]];
  // With groups, their headings say it all.
  if (grouped.length > 1) wrap.querySelector(".friends-count")?.remove();
  for (const [name, members] of grouped) {
    if (!members.length) continue;
    if (grouped.length > 1) wrap.append(el("h4", "friend-group-head", (name || "Other friends") + " — " + members.length));
    const list = el("ul", "friend-list");
    list.append(...members.map(friendRow));
    wrap.append(list);
  }
  return wrap;
}

// ---------- username ----------

let usernameTimer = null;
function openUsernameDialog(firstTime) {
  $("username-input").value = state.me?.username ?? "";
  $("username-later").hidden = !firstTime;
  $("username-title").textContent = state.me?.username ? "Change your username" : "Pick a username";
  showUsernameError(null);
  openModal($("username-dialog"));
  setTimeout(() => $("username-input").focus(), 0);
}

function showUsernameError(text) {
  const box = $("username-status");
  box.textContent = text ?? "";
  box.className = `username-status ${text ? "error" : ""}`;
  $("username-save").disabled = !!text || $("username-input").value.length < 2;
}

function showUsernameCheck(m) {
  if (m.name !== $("username-input").value) return;
  const box = $("username-status");
  box.textContent = m.ok ? `@${m.name} is available.` : m.message;
  box.className = `username-status ${m.ok ? "ok" : "error"}`;
  $("username-save").disabled = !m.ok;
}

$("username-input").addEventListener("input", (e) => {
  const v = e.target.value.toLowerCase().replace(/[^a-z0-9_.]/g, "");
  e.target.value = v;
  clearTimeout(usernameTimer);
  $("username-save").disabled = true;
  $("username-status").textContent = "";
  if (v.length < 2 || v === state.me?.username) return;
  usernameTimer = setTimeout(() => accountSend({ type: "check_username", name: v }).catch(() => {}), 300);
});
$("username-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("username-input").value;
  if (name.length >= 2) accountSend({ type: "claim_username", name }).catch(() => {});
});
$("username-later").addEventListener("click", () => $("username-dialog").close());

// ---------- profile in settings ----------

function renderAccountSettings() {
  const me = state.me;
  $("profile-username").textContent = me?.username ? `@${me.username}` : "Not picked yet";
  $("profile-username-btn").textContent = me?.username ? "Edit" : "Pick one";
  $("privacy-requests").value = me?.privacy ?? "everyone";
  $("avatar-remove").hidden = !me?.avatar;
  $("account-offline").hidden = state.accountConnected;
}

$("profile-username-btn").addEventListener("click", () => openUsernameDialog(false));
$("privacy-requests").addEventListener("change", (e) => accountSend({ type: "set_privacy", requests: e.target.value }).catch(() => {}));
$("avatar-upload").addEventListener("click", () => $("avatar-file").click());
$("avatar-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const picture = await shrinkPicture(file, [[128, 0.85], [128, 0.7], [96, 0.7], [64, 0.7]], 38_000);
    await accountSend({ type: "set_profile", avatar: picture });
  } catch (err) {
    if (err instanceof Error) toast(err.message, true);
  }
});
$("avatar-remove").addEventListener("click", () => accountSend({ type: "set_profile", avatar: null }).catch(() => {}));

// ---------- your servers and folders on every device ----------
//
// The list is saved, encrypted so only this Hopp ID can read it, in the account.
// Servers are matched by address (ids differ per device); removing one is
// remembered so it doesn't come back from another device.

var syncState = { version: 0, saving: false, dirty: false, timer: null, ready: false };
/** Notification settings: per server "all", "mentions" (the default) or "none"; muted channels. */
prefs.notify = loadJson("notify", { servers: {}, channels: {} });
prefs.removedServers = loadJson("removedServers", {});

function syncDoc() {
  const addressOf = (id) => serverById(id)?.address;
  return {
    v: 1,
    servers: prefs.servers.map((s) => ({ address: s.address, label: s.label, customLabel: !!s.customLabel })),
    rail: prefs.rail
      .map((item) => (item.folder ? { folder: item.folder, name: item.name, color: item.color, open: !!item.open, addresses: item.ids.map(addressOf).filter(Boolean) } : { address: addressOf(item.id) }))
      .filter((item) => item.address || item.addresses?.length),
    removed: prefs.removedServers,
    notify: prefs.notify,
  };
}

/** Folds the other device's list into ours: theirs decides order and folders, nothing added here is lost. */
function mergeSync(remote) {
  const removed = { ...remote.removed };
  for (const [address, at] of Object.entries(prefs.removedServers)) removed[address] = Math.max(at, removed[address] ?? 0);
  const keepSince = Date.now() - 90 * 86_400_000;
  for (const [address, at] of Object.entries(removed)) if (at < keepSince) delete removed[address];

  const local = new Map(prefs.servers.map((s) => [s.address, s]));
  const servers = [];
  for (const r of remote.servers ?? []) {
    if (removed[r.address]) continue;
    const mine = local.get(r.address);
    servers.push(mine ? { ...mine, label: r.customLabel ? r.label : mine.label, customLabel: r.customLabel } : { ...newServer(r.address, r.customLabel ? r.label : ""), label: r.label });
    local.delete(r.address);
  }
  for (const s of local.values()) if (!removed[s.address]) servers.push(s);

  const idOf = new Map(servers.map((s) => [s.address, s.id]));
  const rail = (remote.rail ?? []).map((item) =>
    item.folder ? { folder: item.folder, name: item.name, color: item.color, open: item.open, ids: item.addresses.map((a) => idOf.get(a)).filter(Boolean) } : { id: idOf.get(item.address) },
  ).filter((item) => item.id || item.ids?.length);

  prefs.servers = servers;
  prefs.rail = rail;
  prefs.removedServers = removed;
  if (remote.notify) {
    prefs.notify = {
      servers: { ...remote.notify.servers },
      channels: { ...remote.notify.channels },
      dms: { ...remote.notify.dms },
      pinned: { ...remote.notify.pinned },
      friendGroups: { ...remote.notify.friendGroups },
    };
    save("notify", JSON.stringify(prefs.notify));
  }
  save("servers", JSON.stringify(prefs.servers));
  save("rail", JSON.stringify(prefs.rail));
  save("removedServers", JSON.stringify(prefs.removedServers));
  normalizeRail();
}

async function receiveSync(sealed, conflict) {
  if (sealed) {
    try {
      const remote = JSON.parse(await invoke("open_private", { sealed }));
      mergeSync(remote);
      renderAll();
      // Anything only this device knew goes back up.
      if (conflict || JSON.stringify(syncDoc()) !== JSON.stringify(remote)) scheduleSync(true);
    } catch (err) {
      console.warn("couldn't read synced data", err);
    }
  } else if (prefs.servers.length) {
    // First device with this account: upload what's here.
    scheduleSync(true);
  }
  syncState.ready = true;
}

function scheduleSync(now) {
  syncState.dirty = true;
  clearTimeout(syncState.timer);
  syncState.timer = setTimeout(pushSync, now ? 0 : 1500);
}

async function pushSync() {
  if (!state.accountConnected || syncState.saving) return;
  syncState.dirty = false;
  syncState.saving = true;
  try {
    const data = await invoke("seal_private", { text: JSON.stringify(syncDoc()) });
    await invoke("account_send", { msg: { type: "set_sync", data, base_version: syncState.version } });
  } catch {
    syncState.saving = false;
    syncState.dirty = true;
  }
}

// ---------- direct messages ----------
//
// End-to-end encrypted: sealed here with a key only we and the friend share
// (dm_seal / dm_open), stored as ciphertext in both accounts.

state.conversations = new Map(); // peer key -> { last_at, last_read }
state.dmMessages = new Map(); // peer key -> [{ id, from_key, sent_at, text, pending?, failed? }]
state.dmComplete = new Set(); // peers whose whole history is loaded
state.openDm = null;

function personFor(key) {
  if (isGroup(key)) return { key, display_name: groupName(state.groups?.get(key)), username: null, avatar: null, status: "offline", group: true };
  if (key === state.me?.key) return state.me;
  const friend = state.friends.get(key);
  if (friend) return friend;
  // Someone from a group who isn't your friend: their public profile.
  const p = profiles.get(key);
  if (!p) loadProfile(key);
  return { key, display_name: p?.display_name ?? "Someone", username: p?.username ?? null, avatar: p?.avatar ?? null, status: "offline" };
}

function unreadDms() {
  let n = 0;
  for (const [peer, c] of state.conversations) if (c.last_at > c.last_read && !dmMuted(peer)) n++;
  return n;
}

async function decrypt(peer, m) {
  try {
    // In a group, each copy is sealed between its sender and its reader.
    return await invoke("dm_open", { peer: isGroup(peer) ? m.from_key : peer, sealed: m.sealed });
  } catch {
    return null;
  }
}

async function addDmMessages(peer, raw, prepend) {
  const seen = new Set((state.dmMessages.get(peer) ?? []).map((m) => m.id));
  const opened = [];
  for (const m of raw) {
    if (seen.has(m.id)) continue;
    opened.push({ id: m.id, from_key: m.from_key, sent_at: m.sent_at, edited_at: m.edited_at ?? null, text: await decrypt(peer, m) });
  }
  // Others may have arrived while these were being opened: merge into the list as it is now.
  const list = state.dmMessages.get(peer) ?? [];
  const known = new Set(list.map((m) => m.id));
  const fresh = opened.filter((m) => !known.has(m.id));
  const merged = prepend ? [...fresh, ...list] : [...list, ...fresh];
  merged.sort((a, b) => a.sent_at - b.sent_at);
  state.dmMessages.set(peer, merged);
}

function onDmEvent(m) {
  if (m.type === "turn_login" || (m.type === "error" && m.for === "turn_login")) {
    onRelayLogin(m);
    return true;
  }
  if (m.type === "file_signal") {
    onFileSignal(m);
    return true;
  }
  if (m.type === "dm") {
    const peer = m.with;
    const conv = state.conversations.get(peer) ?? { last_at: 0, last_read: 0 };
    conv.last_at = Math.max(conv.last_at, m.message.sent_at);
    const mine = m.message.from_key === state.me?.key;
    const viewing = state.openDm === peer && document.hasFocus() && !online();
    if (mine || viewing) conv.last_read = conv.last_at;
    state.conversations.set(peer, conv);
    // Our own message coming back: it replaces the one shown while sending.
    if (m.nonce) {
      const list = state.dmMessages.get(peer) ?? [];
      state.dmMessages.set(peer, list.filter((x) => x.nonce !== m.nonce));
    }
    addDmMessages(peer, [m.message]).then(() => {
      if (!mine) {
        if (viewing) markDmRead(peer);
        else notifyDm(peer, state.dmMessages.get(peer).find((x) => x.id === m.message.id)?.text, m.message.from_key);
      }
      renderDmAreas(peer);
    });
    return true;
  }
  if (m.type === "dm_edited") {
    const msg = state.dmMessages.get(m.with)?.find((x) => x.id === m.id);
    if (!msg) return true;
    decrypt(m.with, { from_key: msg.from_key, sealed: m.sealed }).then((text) => {
      msg.text = text;
      msg.edited_at = m.edited_at;
      renderDmAreas(m.with);
    });
    return true;
  }
  if (m.type === "dm_deleted") {
    const list = state.dmMessages.get(m.with);
    if (list) state.dmMessages.set(m.with, list.filter((x) => x.id !== m.id));
    renderDmAreas(m.with);
    return true;
  }
  if (m.type === "dm_history") {
    if (m.complete) state.dmComplete.add(m.with);
    addDmMessages(m.with, m.messages, true).then(() => renderDmAreas(m.with, true));
    return true;
  }
  if (m.type === "dm_read") {
    const conv = state.conversations.get(m.with);
    if (conv) conv.last_read = Math.max(conv.last_read, m.at);
    renderDmAreas(m.with);
    return true;
  }
  if (m.type === "error" && m.for === "dm_send") {
    const list = state.dmMessages.get(m.with) ?? [];
    const pending = list.find((x) => x.nonce === m.nonce);
    if (pending) pending.failed = true;
    toast(m.message, true);
    renderDmAreas(m.with);
    return true;
  }
  return false;
}

function notifyDm(peer, text, from) {
  const who = personFor(peer);
  if (state.me?.status === "dnd" || dmMuted(peer)) return;
  playSound("message");
  if (who.group && from) {
    const sender = personFor(from);
    desktopNotify(sender, text ?? "Sent a message", `dm:${peer}`, `${sender.display_name}  ·  ${who.display_name}`);
  } else {
    desktopNotify(who, text ?? "Sent you a message", `dm:${peer}`);
  }
}

/** A desktop notification with the person's picture, when Hopp isn't in front. */
async function desktopNotify(person, body, action, title = person.display_name) {
  if (document.hasFocus() || state.me?.status === "dnd" || !prefs.desktopNotify) return;
  // What a message says stays off the screen when you'd rather it did.
  if (!prefs.notifyText && /^(dm|channel):/.test(action) && !/friend request/.test(body)) body = "Sent a message";
  const image = await notifyPicture(person).catch(() => null);
  invoke("notify", { title, body, image, action }).catch(() => {});
}

/** The person's avatar (picture or initials) as PNG bytes, for a notification. */
async function notifyPicture(person) {
  const size = 96;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d");
  const name = person.display_name || "?";
  if (person.avatar) {
    const img = new Image();
    img.src = person.avatar;
    await img.decode();
    const side = Math.min(img.width, img.height);
    g.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
  } else {
    g.fillStyle = `hsl(${hue(name)} 13% 36%)`;
    g.fillRect(0, 0, size, size);
    g.fillStyle = "#f2f2f3";
    g.font = '600 36px "Inter", "Segoe UI", sans-serif';
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(initials(name).slice(0, 2), size / 2, size / 2 + 2);
  }
  const blob = await new Promise((done) => canvas.toBlob(done, "image/png"));
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
}

listen("notification-click", (e) => {
  const action = String(e.payload);
  if (action.startsWith("dm:")) openDm(action.slice(3));
  else if (action.startsWith("call:")) openDm(action.slice(5));
  else if (action.startsWith("channel:")) {
    const [, id, ch] = action.split(":");
    const server = serverById(id);
    if (!server) return;
    if (server.id === state.activeId) {
      if (state.atHome) connectTo(server);
      openTextChannel(Number(ch));
    }
    else {
      state.pendingView = Number(ch);
      connectTo(server);
    }
  }
  else if (action === "friend-requests") {
    if (state.connectingId) disconnect();
    else if (state.activeId) state.atHome = true;
    state.openDm = null;
    state.friendTab = "pending";
    renderAll();
  }
});

function markDmRead(peer) {
  const conv = state.conversations.get(peer);
  if (!conv || conv.last_read >= conv.last_at) return;
  conv.last_read = conv.last_at;
  invoke("account_send", { msg: { type: "dm_read", with: peer, at: conv.last_at } }).catch(() => {});
}

function renderDmAreas(peer, keepScroll) {
  renderHomeBadge();
  if (online()) return;
  renderSidebar();
  if (state.openDm === peer) renderDmView(keepScroll);
}

function renderHomeBadge() {
  const n = unreadDms() + [...(state.friends?.values() ?? [])].filter((f) => f.state === "incoming").length;
  let badge = $("home-btn").querySelector(".rail-badge");
  if (!badge) {
    badge = el("span", "rail-badge");
    $("home-btn").append(badge);
  }
  badge.textContent = n > 99 ? "99+" : String(n);
  badge.hidden = n === 0;
}

function openDm(peer) {
  state.openDm = peer;
  if (state.connectingId) disconnect();
  else if (state.activeId) state.atHome = true;
  if (!state.dmMessages.has(peer)) {
    state.dmMessages.set(peer, []);
    invoke("account_send", { msg: { type: "dm_history", with: peer } }).catch(() => {});
  }
  markDmRead(peer);
  renderAll();
  setTimeout(() => $("dm-input")?.focus(), 0);
}

function closeDm() {
  state.openDm = null;
  renderAll();
}

/** The sidebar's list of conversations on Home. */
function dmSidebarRows() {
  const rows = [...state.conversations.entries()]
    .filter(([peer]) => state.friends.has(peer) || state.groups?.has(peer))
    .sort((a, b) => dmPinned(b[0]) - dmPinned(a[0]) || b[1].last_at - a[1].last_at)
    .map(([peer, conv]) => {
      const p = personFor(peer);
      const pinned = dmPinned(peer);
      const b = el("button", "server-row dm-row" + (pinned ? " pinned" : ""));
      b.classList.toggle("active", state.openDm === peer);
      const muted = dmMuted(peer);
      b.classList.toggle("unread", conv.last_at > conv.last_read && !muted);
      b.classList.toggle("muted", muted);
      const text = el("span", "row-text");
      text.append(el("span", "row-title ellipsis", p.display_name));
      if (p.group) text.append(el("span", "row-sub ellipsis", `${state.groups.get(peer).members.length} members`));
      else if (p.activity && p.status !== "offline") text.append(el("span", "row-sub ellipsis", p.activity));
      b.append(personAvatar(p, "", p.state === "friend"), text);
      if (conv.last_at > conv.last_read && !muted) b.append(el("span", "count-badge", "1"));
      else if (pinned) b.append(icon("pin", "xs pin-mark"));
      b.addEventListener("click", () => openDm(peer));
      b.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openMenu(
          [
            { label: pinned ? "Unpin conversation" : "Pin conversation", icon: "pin", action: () => setDmPinned(peer, !pinned) },
            { label: muted ? "Unmute conversation" : "Mute conversation", icon: "bell", action: () => setDmMuted(peer, !muted) },
            ...(p.group
              ? [
                  { label: "Edit group", icon: "edit", action: () => openGroupDialog(state.groups.get(peer)) },
                  "sep",
                  { label: "Leave group", icon: "logout", danger: true, action: () => leaveGroup(peer) },
                ]
              : []),
          ],
          e.clientX,
          e.clientY,
        );
      });
      return b;
    });
  const cat = el("div", "category");
  cat.append(el("span", "", "Direct messages"));
  if (state.friends && [...state.friends.values()].some((f) => f.state === "friend")) {
    const add = el("button", "category-add");
    add.type = "button";
    add.dataset.tip = "New group";
    add.append(icon("plus"));
    add.addEventListener("click", () => openGroupDialog(null));
    cat.append(add);
  }
  return rows.length || cat.childElementCount > 1 ? [cat, ...rows] : [];
}

function renderDmView(keepScroll) {
  const peer = state.openDm;
  const p = personFor(peer);
  $("home").classList.add("dm-open");
  const head = $("home").querySelector(".head-title");
  head.textContent = p.display_name;
  const headIcon = $("home").querySelector(".head-icon");
  headIcon.innerHTML = p.group ? '<use href="#i-users"/>' : '<use href="#i-at"/>';

  const body = $("home-body");
  body.classList.add("dm-body");
  let view = body.querySelector(".dm-view");
  if (!view || view.dataset.peer !== peer) {
    view = el("div", "dm-view");
    view.dataset.peer = peer;
    const scroller = el("div", "dm-scroll");
    const list = el("ol", "messages dm-messages");
    scroller.append(list);
    const form = el("form", "composer dm-composer");
    const box = el("div", "composer-box");
    const input = el("textarea");
    input.id = "dm-input";
    input.rows = 1;
    input.maxLength = 2000;
    input.placeholder = p.group ? `Message ${p.display_name}` : `Message @${p.username ?? p.display_name}`;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        if (state.dmAttachment?.peer === peer) sendDmPicture(peer, input);
        else sendDm(peer, input);
      } else if (e.key === "ArrowUp" && !input.value) {
        const mine = (state.dmMessages.get(peer) ?? []).findLast((x) => x.from_key === state.me?.key && !x.pending && dmEditable(x));
        if (mine) {
          e.preventDefault();
          startDmEdit(peer, mine);
        }
      }
    });
    input.addEventListener("paste", (e) => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (!file) return;
      e.preventDefault();
      attachDmPicture(peer, file);
    });
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight}px`;
    });
    const row = el("div", "composer-row");
    const emoji = el("button", "composer-icon");
    emoji.type = "button";
    emoji.dataset.tip = "Emoji";
    emoji.append(icon("smile"));
    emoji.addEventListener("mousedown", (e) => e.preventDefault());
    emoji.addEventListener("click", () => {
      if (!$("emoji-picker").hidden) return closePopovers();
      openEmojiPicker(
        emoji,
        (e) => {
          const at = input.selectionStart ?? input.value.length;
          input.value = input.value.slice(0, at) + e + input.value.slice(input.selectionEnd ?? at);
          input.focus();
          input.setSelectionRange(at + e.length, at + e.length);
        },
        (gif) => sendDm(peer, { value: gif.url, style: {} }),
      );
    });
    const attach = el("button", "composer-icon attach-btn");
    attach.type = "button";
    attach.dataset.tip = p.group ? "Add a picture" : "Add a picture or file";
    attach.setAttribute("aria-label", attach.dataset.tip);
    attach.append(icon("plus"));
    const file = el("input");
    file.type = "file";
    if (p.group) file.accept = "image/png,image/jpeg,image/webp,image/gif";
    file.hidden = true;
    attach.addEventListener("click", () => file.click());
    file.addEventListener("change", () => {
      const chosen = file.files?.[0];
      file.value = "";
      if (!chosen) return;
      if (/^image\/(png|jpeg|webp|gif)$/.test(chosen.type)) attachDmPicture(peer, chosen);
      else offerFile(peer, chosen);
    });
    row.append(attach, file, input, emoji);
    const tray = el("div", "attach-tray");
    tray.id = "dm-attach-tray";
    tray.hidden = true;
    box.append(tray, row);
    const lock = el("p", "dm-lock");
    lock.append(icon("lock", "xs"), p.group ? "Only the people in this group can read these messages." : "Only you and " + p.display_name + " can read these messages.");
    form.append(box);
    const jump = el("button", "jump-bar dm-jump-bar");
    jump.type = "button";
    jump.hidden = true;
    const go = el("span", "jump-go", "Jump to present ");
    go.append(icon("chevron", "xs"));
    jump.append(el("span", "jump-text", "You're viewing older messages"), go);
    jump.addEventListener("click", () => toBottom(scroller));
    scroller.addEventListener("scroll", () => {
      jump.hidden = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 400;
    });
    view.append(scroller, jump, form);
    body.replaceChildren(view);
    view.addEventListener("dragover", (e) => {
      if ([...(e.dataTransfer?.types ?? [])].includes("Files")) e.preventDefault();
    });
    view.addEventListener("drop", (e) => {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      const picture = files.find((f) => /^image\/(png|jpeg|webp|gif)$/.test(f.type));
      if (picture) attachDmPicture(peer, picture);
      else offerFile(peer, files[0]);
    });
    renderDmAttachment();
    scroller.addEventListener("scroll", () => {
      if (scroller.scrollTop < 40 && !state.dmComplete.has(peer)) loadOlderDms(peer);
    });
    stickToBottom(scroller, list);
    view.dataset.lockText = lock.textContent;
    view.lock = lock;
  }
  const scroller = view.querySelector(".dm-scroll");
  const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
  const oldHeight = scroller.scrollHeight;
  const items = [];
  const intro = el("li", "welcome dm-intro");
  intro.append(personAvatar(p, "s80", false), el("h1", "", p.display_name));
  if (p.username) intro.append(el("p", "dm-handle", `@${p.username}`));
  intro.append(el("p", "", p.group ? `This is the beginning of ${p.display_name}. ${state.groups.get(peer)?.members.length ?? 0} people are in it.` : `This is the beginning of your messages with ${p.display_name}.`), view.lock);
  items.push(intro);
  let prev = null;
  for (const m of state.dmMessages.get(peer) ?? []) {
    const day = dayLabel(m.sent_at);
    const newDay = !prev || dayLabel(prev.sent_at) !== day;
    if (newDay) items.push(el("li", "day-divider", day));
    const grouped = !newDay && prev.from_key === m.from_key && m.sent_at - prev.sent_at < GROUP_WINDOW_MS;
    const li = el("li", "msg " + (grouped ? "cont" : "first") + (m.pending ? " pending" : "") + (m.failed ? " failed" : ""));
    if (grouped) li.append(el("span", "msg-gutter", clock(m.sent_at)));
    else {
      const author = personFor(m.from_key);
      const headLine = el("div", "msg-head");
      const name = el("span", "msg-author", author.display_name);
      headLine.append(name, el("span", "msg-time", `${day} at ${clock(m.sent_at)}`));
      li.append(personAvatar(author, "s40", false), headLine);
    }
    if (state.dmEditing === m.id) {
      li.append(dmEditor(peer, m));
    } else if (m.text !== null && FILE_OFFER.test(m.text)) {
      li.append(fileCard(peer, m));
    } else if (m.text !== null && DM_PICTURE.test(m.text)) {
      const [whole, owner, id, key, w, h] = m.text.match(DM_PICTURE);
      const caption = m.text.slice(whole.length).trim();
      if (caption) li.append(messageText(caption));
      li.append(dmPictureView(owner, id, key, Number(w), Number(h)));
    } else if (m.text !== null && GIF_URL.test(m.text.trim())) {
      const img = el("img", "msg-gif");
      img.src = m.text.trim();
      img.alt = "GIF";
      img.loading = "lazy";
      li.append(img);
    } else if (m.text !== null && isInviteOnly(m.text)) {
      // Just an invite: the card says it all.
    } else {
      li.append(m.text === null ? el("div", "msg-text unreadable", "This message can't be read.") : messageText(m.text));
    }
    if (m.text) {
      if (looksLikeBait(m.text, m.from_key === state.me?.key)) li.append(baitWarning());
      for (const link of new Set([...m.text.matchAll(INVITE_LINK), ...m.text.matchAll(URL_PATTERN)].map((x) => x[0]).filter((l) => inviteTarget(l)).slice(0, 3))) li.append(inviteEmbed(link));
      li.append(...youtubeEmbeds(m.text), ...linkPreviews(m.text));
    }
    if (m.edited_at && state.dmEditing !== m.id) {
      const tag = el("span", "msg-edited", "(edited)");
      tag.dataset.tip = `Edited ${dayLabel(m.edited_at).toLowerCase()} at ${clock(m.edited_at)}`;
      (li.querySelector(".msg-text") ?? li).append(tag);
    }
    if (m.failed) li.append(el("div", "msg-failed", "Not delivered."));
    if (m.from_key === state.me?.key && !m.pending && !m.failed && m.text !== null) {
      li.append(dmActions(peer, m));
      li.msg = m;
      li.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const current = e.currentTarget.msg;
        openMenu(
          [
            ...(dmEditable(current) ? [{ label: "Edit message", icon: "edit", action: () => startDmEdit(peer, current) }] : []),
            { label: "Delete message", icon: "trash", danger: true, action: () => deleteDm(peer, current) },
          ],
          e.clientX,
          e.clientY,
        );
      });
    }
    li.dataset.key = `${peer}|${m.id}`;
    li.dataset.sig = JSON.stringify([grouped, day, m.text, m.edited_at, m.pending, m.failed, state.dmEditing === m.id, m.from_key, personFor(m.from_key).avatar ?? null, personFor(m.from_key).display_name, prefs.linkPreviews]);
    items.push(li);
    prev = m;
  }
  reconcile(view.querySelector(".dm-messages"), items);
  if (keepScroll) scroller.scrollTop = scroller.scrollHeight - oldHeight + scroller.scrollTop;
  else if (atBottom || !view.dataset.scrolled) {
    scroller.scrollTop = scroller.scrollHeight;
    view.dataset.scrolled = "1";
  }
}

let loadingOlder = false;
function loadOlderDms(peer) {
  if (loadingOlder) return;
  const first = state.dmMessages.get(peer)?.[0];
  if (!first) return;
  loadingOlder = true;
  invoke("account_send", { msg: { type: "dm_history", with: peer, before: first.sent_at } }).catch(() => {});
  setTimeout(() => (loadingOlder = false), 800);
}

async function sendDm(peer, input) {
  const text = input.value.trim();
  if (!text) return;
  if (await phraseBlocked(text)) return;
  input.value = "";
  input.style.height = "auto";
  const nonce = Math.random().toString(36).slice(2);
  const list = state.dmMessages.get(peer) ?? [];
  list.push({ id: `pending-${nonce}`, nonce, from_key: state.me.key, sent_at: Date.now(), text, pending: true });
  state.dmMessages.set(peer, list);
  renderDmView();
  try {
    if (isGroup(peer)) {
      // A copy for each person, yourself included (for your other devices).
      const sealed = {};
      for (const k of state.groups.get(peer)?.members ?? []) sealed[k] = await invoke("dm_seal", { peer: k, text });
      await invoke("account_send", { msg: { type: "group_send", group: peer, sealed, nonce } });
      return;
    }
    const sealed = await invoke("dm_seal", { peer, text });
    await invoke("account_send", { msg: { type: "dm_send", to: peer, sealed, nonce } });
  } catch (err) {
    const pending = list.find((x) => x.nonce === nonce);
    if (pending) pending.failed = true;
    toast(friendlyError(err), true);
    renderDmView();
  }
}

// Reading a conversation when the window comes back.
window.addEventListener("focus", () => {
  markViewedRead();
  if (state.openDm && !online()) {
    markDmRead(state.openDm);
    renderDmAreas(state.openDm);
  }
});

// ---------- unread, mentions and pictures in servers ----------
//
// Every member's account hears about new messages in their cloud servers (even
// while they're in another one), so the rail shows a dot for unread servers and
// a red count only for mentions. Read marks live in the account,
// so they follow you between computers. Self-hosted servers count while you're in them.

var MENTION = /<@([0-9a-f]{64})>/g;

function readKey(address, channel) {
  return `${address}|${channel}`;
}

function currentServer() {
  return activeServer() ?? connectingServer();
}

function mentionsMe(text) {
  return !!state.account && text.includes(`<@${state.account.publicKey}>`);
}

/** A message that mentions you or answers one of yours. */
function mentionsMeIn(m) {
  return mentionsMe(m.text) || (!!m.reply && m.reply.author_key === state.account?.publicKey);
}

/** Message text as a person would read it: mentions become @names. */
function plainText(text) {
  return text.replace(MENTION, (_, key) => `@${nameForKey(key)}`);
}

/** One line of plain text for previews and notifications: no formatting marks, spoilers hidden. */
function previewText(text) {
  if (FILE_OFFER.test(text)) return `📎 ${text.match(FILE_OFFER)[3]}`;
  if (DM_PICTURE.test(text)) return text.slice(text.match(DM_PICTURE)[0].length).trim() || "Image";
  if (PICTURE.test(text)) return text.slice(text.match(PICTURE)[0].length).trim() || "Image";
  if (GIF_URL.test(text.trim())) return "GIF";
  return plainText(text)
    .replace(/\|\|[\s\S]+?\|\|/g, "(spoiler)")
    .replace(/```[a-z0-9+#-]*\n?/gi, "")
    .replace(/^> ?/gm, "")
    .replace(/\*\*|~~|`|\*|\b_|_\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The name to show for a Hopp ID: someone here, a friend, someone who wrote, or a fetched profile. */
function nameForKey(key) {
  if (key === state.account?.publicKey) return state.account.name;
  const here = state.roster?.users.find((u) => keyOf(u) === key);
  if (here) return here.name;
  const friend = state.friends?.get(key);
  if (friend) return friend.display_name;
  for (const list of state.chats.values()) {
    const m = list.findLast((x) => x.author_key === key);
    if (m) return m.sender_name;
  }
  const p = profiles.get(key);
  if (p?.display_name) return p.display_name;
  loadProfile(key);
  return "someone";
}

/** Takes in what an account or server says about a channel. True when it's a message we hadn't seen. */
function mergeRead(row) {
  const k = readKey(row.server, row.channel);
  const cur = state.reads.get(k);
  if (!cur) {
    state.reads.set(k, { server: row.server, channel: row.channel, read_id: row.read_id, last_id: row.last_id, mentions: row.mentions });
    return row.last_id > row.read_id;
  }
  const fresh = row.last_id > cur.last_id;
  cur.read_id = Math.max(cur.read_id, row.read_id);
  cur.last_id = Math.max(cur.last_id, row.last_id);
  cur.mentions = row.mentions;
  if (cur.read_id >= cur.last_id) cur.mentions = 0;
  return fresh;
}

/** A message that arrived on the server we're in. True when it's new to us. */
function noteMessage(address, m) {
  const k = readKey(address, m.channel);
  const cur = state.reads.get(k) ?? { server: address, channel: m.channel, read_id: 0, last_id: 0, mentions: 0 };
  state.reads.set(k, cur);
  if (m.id <= cur.last_id) return false;
  cur.last_id = m.id;
  if (m.author_key === state.account?.publicKey) {
    cur.read_id = m.id;
    cur.mentions = 0;
  } else if (mentionsMeIn(m) && m.id > cur.read_id) {
    cur.mentions += 1;
  }
  return true;
}

/** A channel's recent messages, on joining: catch up with what the read marks know. */
function noteHistory(server, channel, messages) {
  const last = messages.at(-1)?.id;
  if (!last) return;
  const k = readKey(server.address, channel);
  const cur = state.reads.get(k);
  // Never seen this channel (just joined, or nothing new for a long time): it's all read.
  // (Unless the account hasn't told us its read marks yet.)
  if (!cur) return state.readsLoaded ? setRead(server.address, channel, last) : undefined;
  cur.last_id = Math.max(cur.last_id, last);
  // Self-hosted servers don't tell the account; count mentions here.
  if (!isCloud(server)) {
    cur.mentions = messages.filter((m) => m.id > cur.read_id && m.author_key !== state.account?.publicKey && mentionsMeIn(m)).length;
  }
  if (cur.read_id >= cur.last_id) cur.mentions = 0;
}

var readQueue = new Map();
/** Marks a channel read up to message `id`, here and (shortly) in the account. */
function setRead(address, channel, id) {
  const k = readKey(address, channel);
  const cur = state.reads.get(k) ?? { server: address, channel, read_id: 0, last_id: 0, mentions: 0 };
  state.reads.set(k, cur);
  if (cur.read_id >= id && cur.mentions === 0) return false;
  cur.read_id = Math.max(cur.read_id, id);
  cur.last_id = Math.max(cur.last_id, id);
  if (cur.read_id >= cur.last_id) cur.mentions = 0;
  clearTimeout(readQueue.get(k));
  readQueue.set(k, setTimeout(() => {
    readQueue.delete(k);
    invoke("account_send", { msg: { type: "channel_read", server: address, channel, id: cur.read_id } }).catch(() => {});
  }, 500));
  return true;
}

/** The channel on screen counts as read while the window is in front. */
function markViewedRead() {
  if (!online() || state.view === null || !document.hasFocus()) return;
  if (state.unreadHold && state.unreadHold.channel === state.view && state.unreadHold.address === activeServer()?.address) return;
  const address = activeServer()?.address;
  const last = state.chats.get(state.view)?.at(-1)?.id;
  if (address && last && setRead(address, state.view, last)) renderUnread();
}

/** Channels deleted from the server we're in shouldn't keep it unread. */
function forgetDeletedChannels() {
  const address = activeServer()?.address;
  if (!address || !state.roster) return;
  const live = new Set(textChannels().map((c) => c.id));
  for (const [k, r] of state.reads) {
    if (r.server === address && !live.has(r.channel) && r.last_id > r.read_id) {
      setRead(address, r.channel, r.last_id);
      state.reads.delete(k);
    }
  }
}

function channelUnread(address, channel) {
  if (channelMuted(address, channel)) return false;
  const r = state.reads.get(readKey(address, channel));
  return !!r && r.last_id > r.read_id;
}

function channelMentions(address, channel) {
  return state.reads.get(readKey(address, channel))?.mentions ?? 0;
}

function serverRows(s) {
  const rows = [...state.reads.values()].filter((r) => r.server === s.address);
  // The server we're in: only channels that still exist.
  if (s.id === state.activeId && state.roster) {
    const live = new Set(textChannels().map((c) => c.id));
    return rows.filter((r) => live.has(r.channel));
  }
  return rows;
}

function serverUnread(s) {
  if (serverLevel(s) === "none") return false;
  return serverRows(s).some((r) => r.last_id > r.read_id && !channelMuted(s.address, r.channel));
}

function serverMentions(s) {
  return serverRows(s).reduce((n, r) => n + r.mentions, 0);
}

function railBadge(item, n) {
  if (!n) return;
  item.append(el("span", "rail-badge", n > 99 ? "99+" : String(n)));
}

var unreadFrame = 0;
function renderUnread() {
  // A timer, not a frame callback: frames pause while Hopp is hidden in the tray.
  clearTimeout(unreadFrame);
  unreadFrame = setTimeout(() => {
    renderRail();
    renderSidebar();
  }, 16);
}

/** Someone mentioned you somewhere you aren't looking: a sound and a notification. */
function notifyMention({ server, channel, author_key, author_name, channel_name, text, mention }) {
  if (isBlocked(author_key)) return;
  const s = prefs.servers.find((x) => x.address === server);
  if (!s || state.me?.status === "dnd") return;
  const level = serverLevel(s);
  if (level === "none" || channelMuted(server, channel) || (!mention && level !== "all")) return;
  const looking = online() && s.id === state.activeId && state.view === channel && document.hasFocus();
  if (looking) return;
  playSound("message");
  const person = { display_name: author_name, avatar: pictureFor(author_key) };
  desktopNotify(person, text, `channel:${s.id}:${channel}`, `${author_name}  ·  #${channel_name}, ${s.label}`);
}

// ---------- pictures for everyone ----------

var profiles = new Map();
var PROFILE_FRESH_MS = 3 * 60_000;

/**
 * Someone's Hopp ID in the server we're in. Servers send it with each user; older
 * ones don't, so fall back to yourself, or to what their messages are signed with.
 */
function keyOf(u) {
  if (u.public_key) return u.public_key;
  if (u.session_id === state.roster?.me) return state.account?.publicKey ?? null;
  for (const list of state.chats.values()) {
    const m = list.findLast((x) => x.sender === u.session_id && x.author_key);
    if (m) return m.author_key;
  }
  return null;
}

/** Someone's profile picture by Hopp ID: yours, a friend's, or fetched once in a while. */
function pictureFor(key) {
  if (!key) return null;
  if (key === state.account?.publicKey) return state.me?.avatar ?? null;
  const friend = state.friends?.get(key);
  if (friend && friend.state !== "blocked") return friend.avatar ?? null;
  const p = profiles.get(key);
  if (!p || Date.now() - p.at > PROFILE_FRESH_MS) loadProfile(key);
  return p?.avatar ?? null;
}

function loadProfile(key) {
  const p = profiles.get(key);
  if (p?.loading || !/^[0-9a-f]{64}$/.test(key)) return;
  profiles.set(key, { ...(p ?? { avatar: null }), loading: true, at: Date.now() });
  invoke("fetch_profile", { cloud: prefs.cloudUrl.replace(/^ws/, "http"), key }).then(
    (r) => {
      const changed = (p?.avatar ?? null) !== (r.avatar ?? null) || p?.display_name !== r.display_name;
      profiles.set(key, { avatar: r.avatar ?? null, display_name: r.display_name, username: r.username, at: Date.now() });
      if (changed) renderPictures();
    },
    () => profiles.set(key, { ...(p ?? { avatar: null }), loading: false, at: Date.now() }),
  );
}

var picturesTimer = 0;
function renderPictures() {
  clearTimeout(picturesTimer);
  picturesTimer = setTimeout(() => {
    if (!online()) return;
    renderSidebar();
    renderMembers();
    renderMessages(true);
    if (mentionPicker.open) updateMentionPicker();
  }, 150);
}

// ---------- composer: @mentions ----------

/** "@Name" in the composer, to the Hopp ID it stands for; replaced by <@key> on sending. */
var composeMentions = new Map();
var mentionPicker = { open: false, items: [], index: 0, start: 0 };

function mentionCandidates(query) {
  const q = query.toLowerCase();
  const seen = new Set([state.account?.publicKey]);
  const out = [];
  const add = (key, name) => {
    if (!/^[0-9a-f]{64}$/.test(key ?? "") || seen.has(key)) return;
    seen.add(key);
    const username = profiles.get(key)?.username ?? state.friends?.get(key)?.username ?? null;
    if (!q || name.toLowerCase().includes(q) || username?.includes(q)) out.push({ key, name, username });
  };
  for (const u of [...(state.roster?.users ?? [])].sort(byName)) add(keyOf(u), u.name);
  for (const list of state.chats.values()) for (const m of [...list].reverse()) add(m.author_key, m.sender_name);
  return out.sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q))).slice(0, 8);
}

function updateMentionPicker() {
  const before = chatInput.value.slice(0, chatInput.selectionStart);
  const emojiMatch = before.match(/(?:^|\s):([a-z0-9_+-]{2,20})$/i);
  const match = before.match(/(?:^|\s)@([\p{L}\p{N}_.-]{0,32})$/u) ?? emojiMatch;
  const items = !match || !online() ? [] : match === emojiMatch ? emojiCandidates(match[1]) : mentionCandidates(match[1]);
  let pop = $("mention-picker");
  if (!items.length) {
    mentionPicker.open = false;
    if (pop) pop.hidden = true;
    return;
  }
  if (!pop) {
    pop = el("div", "mention-picker");
    pop.id = "mention-picker";
    pop.addEventListener("mousedown", (e) => e.preventDefault());
    $("composer").append(pop);
  }
  const keep = mentionPicker.open ? mentionPicker.items[mentionPicker.index]?.key : null;
  mentionPicker.open = true;
  mentionPicker.items = items;
  mentionPicker.index = Math.max(0, items.findIndex((i) => i.key === keep));
  mentionPicker.start = before.length - match[1].length - 1;
  const rows = items.map((item, i) => {
    const row = el("button", "mention-option" + (i === mentionPicker.index ? " active" : ""));
    row.type = "button";
    if (item.emoji) row.append(el("span", "mention-emoji", item.emoji), el("span", "mention-name ellipsis", `:${item.name}:`));
    else row.append(avatar(item.name, "s24", undefined, pictureFor(item.key)), el("span", "mention-name ellipsis", item.name));
    if (item.username) row.append(el("span", "mention-user ellipsis", item.username));
    row.addEventListener("mouseenter", () => {
      mentionPicker.index = i;
      pop.querySelectorAll(".mention-option").forEach((n, j) => n.classList.toggle("active", j === i));
    });
    row.addEventListener("click", () => pickMention(item));
    return row;
  });
  pop.replaceChildren(el("div", "mention-head", items[0]?.emoji ? "Emoji" : "Members"), ...rows);
  pop.hidden = false;
}

function pickMention(item) {
  if (item.emoji) {
    const end = chatInput.selectionStart;
    chatInput.value = chatInput.value.slice(0, mentionPicker.start) + item.emoji + chatInput.value.slice(end);
    const caret = mentionPicker.start + item.emoji.length;
    chatInput.setSelectionRange(caret, caret);
    rememberEmoji(item.emoji);
    mentionPicker.open = false;
    $("mention-picker").hidden = true;
    chatInput.focus();
    return;
  }
  const label = `@${item.name}`;
  const end = chatInput.selectionStart;
  chatInput.value = chatInput.value.slice(0, mentionPicker.start) + label + " " + chatInput.value.slice(end);
  const caret = mentionPicker.start + label.length + 1;
  chatInput.setSelectionRange(caret, caret);
  composeMentions.set(label, item.key);
  mentionPicker.open = false;
  $("mention-picker").hidden = true;
  chatInput.focus();
  autosize();
}

/** Arrow keys, Enter, Tab and Escape while the picker is open. True when the key was used. */
function mentionKeydown(e) {
  if (!mentionPicker.open) return false;
  const n = mentionPicker.items.length;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    mentionPicker.index = (mentionPicker.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
    document.querySelectorAll("#mention-picker .mention-option").forEach((row, i) => row.classList.toggle("active", i === mentionPicker.index));
  } else if (e.key === "Enter" || e.key === "Tab") {
    pickMention(mentionPicker.items[mentionPicker.index]);
  } else if (e.key === "Escape") {
    mentionPicker.open = false;
    $("mention-picker").hidden = true;
  } else {
    return false;
  }
  e.preventDefault();
  e.stopPropagation();
  return true;
}

chatInput.addEventListener("blur", () => {
  mentionPicker.open = false;
  if ($("mention-picker")) $("mention-picker").hidden = true;
});
chatInput.addEventListener("click", updateMentionPicker);

/** The text to send: picked @names become mentions the server and everyone's app understand. */
function withMentions(text) {
  const labels = [...composeMentions.keys()].sort((a, b) => b.length - a.length);
  for (const label of labels) text = text.split(label).join(`<@${composeMentions.get(label)}>`);
  return text;
}

// Pictures people change while you're in a server show up within a few minutes.
setInterval(() => {
  if (online() && document.hasFocus()) renderMembers();
}, PROFILE_FRESH_MS);

// ---------- replies, edits, reactions and older messages ----------

function messageActions(m) {
  const actions = el("div", "msg-actions");
  const button = (iconName, tip, onClick, extra = "") => {
    const b = el("button", "icon-btn sm " + extra);
    b.dataset.tip = tip;
    b.append(icon(iconName, "sm"));
    b.addEventListener("click", onClick);
    actions.append(b);
    return b;
  };
  for (const emoji of quickReactions()) {
    const mine = m.reactions?.find((r) => r.emoji === emoji)?.keys.includes(state.account?.publicKey);
    const b = el("button", "icon-btn sm quick-react" + (mine ? " on" : ""), emoji);
    b.type = "button";
    b.dataset.tip = mine ? `Remove ${emoji}` : `React ${emoji}`;
    b.addEventListener("click", () => react(m, emoji, !mine));
    actions.append(b);
  }
  button("smile", "Add reaction", (e) => openEmojiPicker(e.currentTarget, (emoji) => react(m, emoji, true)));
  button("reply", "Reply", () => setReply(m));
  if (m.author_key === state.account?.publicKey && !PICTURE.test(m.text)) button("edit", "Edit", () => startEdit(m));
  if (canDelete(m)) button("trash", "Delete message", (e) => deleteMessage(m, e.shiftKey), "danger-hover");
  return actions;
}

/** "↱ Name: the start of the message", above a reply; click to see the original. */
function replyLine(r) {
  const line = el("button", "msg-reply");
  line.type = "button";
  line.append(avatar(r.sender_name, "s16", undefined, pictureFor(r.author_key)), el("span", "msg-reply-name", r.sender_name));
  const preview = el("span", "msg-reply-text ellipsis", previewText(r.text));
  line.append(preview);
  line.addEventListener("click", () => jumpToMessage(r.id));
  return line;
}

/** Scrolls to a message, loading older ones until it's there. */
function jumpToMessage(id) {
  const node = document.querySelector(`#messages .msg[data-id="${id}"]`);
  if (node) {
    state.jumpTo = null;
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    node.classList.remove("flash");
    void node.offsetWidth;
    node.classList.add("flash");
    return;
  }
  if (state.olderDone.has(state.view)) {
    state.jumpTo = null;
    toast("That message has been deleted.");
    return;
  }
  state.jumpTo = id;
  loadOlder();
}

function setReply(m) {
  state.replyTo = m ? { id: m.id, channel: m.channel, name: m.sender_name } : null;
  const bar = $("reply-bar");
  bar.hidden = !m;
  if (m) {
    const text = $("reply-text");
    text.replaceChildren("Replying to ", el("strong", "", m.sender_name));
    chatInput.focus();
  }
  document.querySelectorAll("#messages .msg.replying").forEach((n) => n.classList.remove("replying"));
  if (m) document.querySelector(`#messages .msg[data-id="${m.id}"]`)?.classList.add("replying");
}
$("reply-cancel").addEventListener("click", () => setReply(null));

function startEdit(m) {
  if (PICTURE.test(m.text)) return;
  state.editing = { id: m.id, channel: m.channel };
  renderMessages(true);
  const box = document.querySelector("#messages .msg-editor textarea");
  if (box) {
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
    box.closest(".msg").scrollIntoView({ block: "nearest" });
  }
}

function stopEdit() {
  state.editing = null;
  renderMessages(true);
  chatInput.focus();
}

/** The message as an editable box: Enter saves, Escape cancels. */
function messageEditor(m) {
  const wrap = el("div", "msg-editor");
  // Mentions are edited as @names and turned back into mentions on saving.
  const labels = new Map();
  for (const [, key] of m.text.matchAll(MENTION)) labels.set(`@${nameForKey(key)}`, key);
  const box = el("textarea");
  box.value = plainText(m.text);
  box.rows = 1;
  box.maxLength = 2000;
  const fit = () => {
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight}px`;
  };
  requestAnimationFrame(fit);
  box.addEventListener("input", fit);
  const save = async () => {
    let text = box.value.trim();
    for (const [label, key] of [...labels].sort((a, b) => b[0].length - a[0].length)) text = text.split(label).join(`<@${key}>`);
    if (!text) return deleteMessage(m).then(stopEdit);
    if (text !== m.text) {
      if (await phraseBlocked(text)) return;
      invoke("edit_message", { channel: m.channel, id: m.id, text }).catch((err) => toast(friendlyError(err), true));
    }
    stopEdit();
  };
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      stopEdit();
    } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      save();
    }
  });
  const hint = el("div", "msg-editor-hint");
  const cancel = el("button", "link", "cancel");
  cancel.type = "button";
  cancel.addEventListener("click", stopEdit);
  const ok = el("button", "link", "save");
  ok.type = "button";
  ok.addEventListener("click", save);
  hint.append("Escape to ", cancel, " · Enter to ", ok);
  wrap.append(box, hint);
  return wrap;
}

function reactionRow(m) {
  const row = el("div", "reactions");
  const me = state.account?.publicKey;
  for (const r of m.reactions) {
    const mine = r.keys.includes(me);
    const chip = el("button", "reaction" + (mine ? " mine" : ""));
    chip.type = "button";
    chip.append(el("span", "reaction-emoji", r.emoji), el("span", "reaction-count", String(r.keys.length)));
    const names = r.keys.slice(0, 6).map(nameForKey);
    chip.dataset.tip = names.join(", ") + (r.keys.length > 6 ? ` and ${r.keys.length - 6} more` : "") + ` reacted with ${r.emoji}`;
    chip.addEventListener("click", () => react(m, r.emoji, !mine));
    row.append(chip);
  }
  const add = el("button", "reaction add");
  add.type = "button";
  add.dataset.tip = "Add reaction";
  add.append(icon("smile", "sm"));
  add.addEventListener("click", (e) => openEmojiPicker(e.currentTarget, (emoji) => react(m, emoji, true)));
  row.append(add);
  return row;
}

function react(m, emoji, on) {
  rememberEmoji(emoji);
  invoke("react", { channel: m.channel, id: m.id, emoji, on }).catch((err) => toast(friendlyError(err), true));
}

// ---------- emoji and GIF picker ----------

/** Emoji by category, each with the words it's found by. */
var EMOJI_GROUPS = [
  ["Smileys", "😀 grin happy|😃 smile happy|😄 smile laugh|😁 grin teeth|😆 laugh|😅 sweat laugh|🤣 rofl laugh|😂 joy tears laugh|🙂 slight smile|🙃 upside down|😉 wink|😊 blush smile|😇 angel halo|🥰 love hearts|😍 heart eyes love|🤩 star struck wow|😘 kiss|😋 yum tasty|😛 tongue|😜 wink tongue crazy|🤪 zany crazy|😝 tongue|🤑 money|🤗 hug|🤭 oops giggle|🤫 shush quiet|🤔 think hmm|🤐 zip quiet|🤨 raised eyebrow sus|😐 neutral|😑 expressionless|😶 speechless|😏 smirk|😒 unamused|🙄 eye roll|😬 grimace awkward|😮‍💨 exhale relief|🤥 lie|😌 relieved|😔 pensive sad|😪 sleepy|🤤 drool|😴 sleep zzz|😷 mask sick|🤒 sick fever|🤕 hurt|🤢 nausea sick|🤮 vomit|🥵 hot|🥶 cold freezing|🥴 woozy dizzy|😵 dizzy|🤯 mind blown|🤠 cowboy|🥳 party celebrate|😎 cool sunglasses|🤓 nerd|🧐 monocle|😕 confused|😟 worried|🙁 frown|😮 wow open mouth|😯 hushed|😲 astonished shock|😳 flushed embarrassed|🥺 pleading puppy|🥹 holding tears|😦 frown|😧 anguished|😨 fearful scared|😰 anxious sweat|😥 sad relieved|😢 cry sad|😭 sob cry|😱 scream shock|😖 confounded|😣 persevere|😞 disappointed|😓 sweat|😩 weary tired|😫 tired|🥱 yawn bored|😤 triumph huff|😡 angry rage|😠 angry mad|🤬 swear cursing|😈 devil|💀 skull dead|☠️ skull crossbones|💩 poop|🤡 clown|👻 ghost|👽 alien|🤖 robot|😺 cat smile|🫡 salute|🫠 melting|🫣 peek|🥲 smile tear"],
  ["Gestures", "👍 thumbs up yes like|👎 thumbs down no|👌 ok|✌️ peace victory|🤞 fingers crossed luck|🤟 love you|🤘 rock metal|🤙 call me|👈 left|👉 right|👆 up|👇 down|☝️ point|✋ hand stop|🤚 raised back|🖐️ hand|🖖 vulcan|👋 wave hi bye|🤏 pinch small|💪 muscle strong flex|🙏 pray please thanks|👏 clap applause|🙌 raise hands hooray|🤝 handshake deal|✍️ write|🫶 heart hands|👀 eyes look|🧠 brain|👑 crown king|🫵 you point"],
  ["Hearts", "❤️ heart love red|🧡 orange heart|💛 yellow heart|💚 green heart|💙 blue heart|💜 purple heart|🖤 black heart|🤍 white heart|🤎 brown heart|💔 broken heart|❣️ heart|💕 two hearts|💞 revolving hearts|💓 beating heart|💗 growing heart|💖 sparkling heart|💘 cupid|💝 heart gift|❤️‍🔥 heart fire"],
  ["Animals & food", "🐰 bunny rabbit hopp|🐶 dog|🐱 cat|🐭 mouse|🦊 fox|🐻 bear|🐼 panda|🐨 koala|🐯 tiger|🦁 lion|🐮 cow|🐷 pig|🐸 frog|🐵 monkey|🐔 chicken|🐧 penguin|🐦 bird|🦆 duck|🦉 owl|🐺 wolf|🦄 unicorn|🐝 bee|🦋 butterfly|🐢 turtle|🐍 snake|🦖 dinosaur t-rex|🐙 octopus|🐬 dolphin|🐳 whale|🦈 shark|🌵 cactus|🌲 tree|🍀 clover luck|🌸 flower blossom|🌹 rose|🌻 sunflower|🍎 apple|🍌 banana|🍉 watermelon|🍓 strawberry|🍑 peach|🥑 avocado|🍕 pizza|🍔 burger|🍟 fries|🌭 hot dog|🌮 taco|🍣 sushi|🍜 ramen noodles|🍩 donut|🍪 cookie|🎂 cake birthday|🍫 chocolate|🍿 popcorn|☕ coffee|🍵 tea|🍺 beer|🍻 cheers beers|🥤 drink soda|🧃 juice"],
  ["Activities", "🎮 game controller gaming|🕹️ joystick|🎧 headphones|🎤 microphone sing|🎵 music note|🎶 music|🎸 guitar|🥁 drum|🎉 party tada|🎊 confetti|🎈 balloon|🎁 gift present|🏆 trophy win|🥇 gold medal first|🥈 silver second|🥉 bronze third|🏅 medal|⚽ soccer football|🏀 basketball|🏈 american football|⚾ baseball|🎾 tennis|🏐 volleyball|🎱 pool eight ball|🎯 target bullseye|🎲 dice|♟️ chess|🧩 puzzle|🎬 movie clapper|📸 camera photo|🎨 art paint"],
  ["Things & symbols", "🔥 fire lit hot|✨ sparkles|⭐ star|🌟 glowing star|⚡ lightning zap|💥 boom|💯 hundred perfect|✅ check yes done|❌ cross no|⚠️ warning|❓ question|❗ exclamation|💤 sleep zzz|💬 speech chat|💭 thought|🔔 bell|📌 pin|📎 paperclip|🔒 lock|🔑 key|💡 idea bulb|💻 laptop computer|🖥️ desktop pc|📱 phone|⌨️ keyboard|🖱️ mouse|🔊 loud|🔇 mute|⏰ alarm clock|⌛ hourglass|🚀 rocket|✈️ plane|🚗 car|🏠 home house|🌍 earth world|🌙 moon night|☀️ sun|🌈 rainbow|❄️ snow|☔ rain umbrella|💰 money bag|💎 gem diamond|🗑️ trash|📈 chart up|📉 chart down|🆗 ok|🆒 cool|🆕 new|🔝 top"],
];

function recentEmoji() {
  try {
    return JSON.parse(localStorage.getItem("recentEmoji") ?? "[]").filter((e) => typeof e === "string").slice(0, 16);
  } catch {
    return [];
  }
}

function rememberEmoji(emoji) {
  const list = [emoji, ...recentEmoji().filter((e) => e !== emoji)].slice(0, 16);
  try {
    localStorage.setItem("recentEmoji", JSON.stringify(list));
  } catch {}
}

var picker = { tab: "emoji", onEmoji: null, onGif: null, gifTimer: 0, gifQuery: null };

/**
 * Opens the picker. From the composer it sits right above the box with a GIF tab;
 * for reactions it opens beside the button and only has emoji.
 */
function openEmojiPicker(anchor, onEmoji, onGif) {
  const pop = $("emoji-picker");
  picker.onEmoji = onEmoji;
  picker.onGif = onGif ?? null;
  if (!onGif) picker.tab = "emoji";
  const search = el("input", "picker-search");
  search.placeholder = picker.tab === "gif" ? "Search GIFs" : "Find the perfect emoji";
  search.autocomplete = "off";
  search.spellcheck = false;
  const tabs = el("div", "picker-tabs");
  if (onGif) {
    for (const [tab, label] of [["gif", "GIFs"], ["emoji", "Emoji"]]) {
      const b = el("button", "picker-tab" + (picker.tab === tab ? " active" : ""), label);
      b.type = "button";
      b.addEventListener("click", () => {
        picker.tab = tab;
        tabs.querySelectorAll(".picker-tab").forEach((t) => t.classList.toggle("active", t === b));
        search.value = "";
        search.placeholder = tab === "gif" ? "Search GIFs" : "Find the perfect emoji";
        renderPickerBody(body, "");
        search.focus();
      });
      tabs.append(b);
    }
  }
  const body = el("div", "picker-body");
  search.addEventListener("input", () => renderPickerBody(body, search.value.trim().toLowerCase()));
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closePopovers();
    }
  });
  const head = el("div", "picker-head");
  head.append(...(onGif ? [tabs] : []), search);
  pop.replaceChildren(head, body);
  pop.classList.toggle("with-gifs", !!onGif);
  renderPickerBody(body, "");

  const r = anchor.getBoundingClientRect();
  // Measured while showing: a hidden picker has no size.
  pop.hidden = false;
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  if (onGif) {
    // Above the message box, its right edge lined up with the box.
    const box = (anchor.closest(".composer-box") ?? $("composer").querySelector(".composer-box")).getBoundingClientRect();
    placePopover(pop, box.right - w, box.top - h - 8);
  } else {
    placePopover(pop, r.right - w, r.top - h - 8);
    if (r.top - h - 8 < 40) placePopover(pop, r.right - w, r.bottom + 8);
  }
  setTimeout(() => search.focus(), 0);
}

function renderPickerBody(body, q) {
  if (picker.tab === "gif") return renderGifs(body, q);
  const pick = (emoji) => {
    rememberEmoji(emoji);
    closePopovers();
    picker.onEmoji(emoji);
  };
  const grid = (list) => {
    const g = el("div", "emoji-grid");
    for (const [emoji, words] of list) {
      const b = el("button", "emoji-option", emoji);
      b.type = "button";
      b.title = words ? `:${words.split(" ")[0]}:` : "";
      b.addEventListener("click", () => pick(emoji));
      g.append(b);
    }
    return g;
  };
  const all = EMOJI_GROUPS.map(([name, list]) => [name, list.split("|").map((x) => [x.split(" ")[0], x.split(" ").slice(1).join(" ")])]);
  const parts = [];
  if (q) {
    const found = all.flatMap(([, l]) => l).filter(([, words]) => words.split(" ").some((w) => w.startsWith(q)));
    parts.push(found.length ? grid(found) : el("div", "picker-empty", "No emoji found."));
  } else {
    const recent = recentEmoji();
    if (recent.length) parts.push(el("div", "emoji-head", "Recently used"), grid(recent.map((e) => [e, ""])));
    for (const [name, list] of all) parts.push(el("div", "emoji-head", name), grid(list));
  }
  body.replaceChildren(...parts);
  body.scrollTop = 0;
}

function renderGifs(body, q) {
  clearTimeout(picker.gifTimer);
  picker.gifQuery = q;
  if (!body.querySelector(".gif-grid")) body.replaceChildren(el("div", "picker-empty", "Loading GIFs…"));
  picker.gifTimer = setTimeout(async () => {
    let result;
    try {
      result = await invoke("gif_search", { cloud: prefs.cloudUrl.replace(/^ws/, "http"), q, pos: null });
    } catch (err) {
      if (picker.gifQuery === q) body.replaceChildren(el("div", "picker-empty", friendlyError(err)));
      return;
    }
    if (picker.gifQuery !== q) return;
    const cols = [el("div", "gif-col"), el("div", "gif-col")];
    const heights = [0, 0];
    for (const gif of result.gifs) {
      const i = heights[0] <= heights[1] ? 0 : 1;
      heights[i] += gif.width ? gif.height / gif.width : 1;
      const b = el("button", "gif-option");
      b.type = "button";
      b.title = gif.title;
      const img = el("img");
      img.src = gif.preview;
      img.alt = gif.title;
      img.loading = "lazy";
      if (gif.width && gif.height) img.style.aspectRatio = `${gif.width} / ${gif.height}`;
      b.append(img);
      b.addEventListener("click", () => {
        closePopovers();
        picker.onGif?.(gif);
      });
      cols[i].append(b);
    }
    const grid = el("div", "gif-grid");
    grid.append(...cols);
    body.replaceChildren(...(result.gifs.length ? [el("div", "emoji-head", q ? `GIFs for “${q}”` : "Trending"), grid] : [el("div", "picker-empty", "No GIFs found.")]));
    const credit = el("div", "gif-credit", "Powered by KLIPY");
    body.append(credit);
  }, q ? 300 : 0);
}

$("emoji-btn").addEventListener("click", (e) => {
  if (!$("emoji-picker").hidden) return closePopovers();
  openEmojiPicker(
    e.currentTarget,
    (emoji) => {
      const at = chatInput.selectionStart ?? chatInput.value.length;
      chatInput.value = chatInput.value.slice(0, at) + emoji + chatInput.value.slice(chatInput.selectionEnd ?? at);
      chatInput.focus();
      chatInput.setSelectionRange(at + emoji.length, at + emoji.length);
      autosize();
    },
    (gif) => {
      if (state.view === null) return;
      const replyTo = state.replyTo?.channel === state.view ? state.replyTo.id : null;
      setReply(null);
      sendChat(state.view, gif.url, replyTo);
    },
  );
});
$("emoji-btn").addEventListener("mousedown", (e) => e.preventDefault());

/** A message that is just a GIF from the picker shows as the GIF. */
var GIF_URL = /^https:\/\/static\d?\.klipy\.com\/[^\s]+\.(gif|webp)$/i;

// ---------- older messages ----------

function olderLoader() {
  return el("li", "older-loader", "Loading older messages…");
}

function loadOlder() {
  if (!online() || state.view === null || state.loadingOlder || state.olderDone.has(state.view)) return;
  const first = state.chats.get(state.view)?.[0];
  if (!first) return state.olderDone.add(state.view);
  state.loadingOlder = true;
  invoke("load_older", { channel: state.view, before: first.id }).catch(() => (state.loadingOlder = false));
  // A server from before older messages existed doesn't answer: treat the channel as complete.
  const ch = state.view;
  setTimeout(() => {
    if (!state.loadingOlder) return;
    state.loadingOlder = false;
    state.olderDone.add(ch);
    if (ch === state.view) renderMessages(true);
  }, 6000);
}

$("scroller").addEventListener("scroll", () => {
  if ($("scroller").scrollTop < 400) loadOlder();
  updateJumpBar();
});

// ---------- sending: pending, failed, retry ----------

function sendChat(channel, text, replyTo) {
  state.unreadHold = null;
  const answered = replyTo ? state.chats.get(channel)?.find((m) => m.id === replyTo) : null;
  const o = {
    nonce: crypto.randomUUID(), channel, text, replyTo, at: Date.now(), failed: false, why: "",
    reply: answered ? { id: answered.id, sender_name: answered.sender_name, author_key: answered.author_key, text: answered.text } : null,
  };
  state.outbox.push(o);
  if (channel === state.view) renderMessages(false);
  invoke("send_chat", { channel, text, replyTo }).catch((err) => failOutbox(o, friendlyError(err)));
  // No answer at all: the connection is gone.
  setTimeout(() => {
    if (state.outbox.includes(o) && !o.failed) failOutbox(o, "Not sent. Check your connection.");
  }, 10_000);
}

function failOutbox(o, why) {
  o.failed = true;
  o.why = why;
  if (o.channel === state.view) renderMessages(true);
}

function outboxItem(o, grouped) {
  const li = el("li", "msg " + (grouped ? "cont " : "first ") + (o.failed ? "failed" : "pending"));
  if (grouped) {
    li.append(el("span", "msg-gutter", clock(o.at)), messageText(o.text));
    return li;
  }
  if (o.reply) li.append(replyLine(o.reply));
  const head = el("div", "msg-head");
  const name = state.account?.name ?? "";
  const author = el("span", "msg-author", name);
  author.style.color = `hsl(${hue(name)} var(--name-s) var(--name-l))`;
  head.append(author, el("span", "msg-time", o.failed ? "Not sent" : "Sending…"));
  li.append(avatar(name, "s40", undefined, state.me?.avatar ?? null), head, messageText(o.text));
  if (o.failed) {
    const row = el("div", "msg-failed");
    const retry = el("button", "link", "Retry");
    retry.type = "button";
    retry.addEventListener("click", () => {
      state.outbox.splice(state.outbox.indexOf(o), 1);
      sendChat(o.channel, o.text, o.replyTo);
    });
    const drop = el("button", "link", "Delete");
    drop.type = "button";
    drop.addEventListener("click", () => {
      state.outbox.splice(state.outbox.indexOf(o), 1);
      renderMessages(true);
    });
    row.append(icon("x", "xs"), el("span", "", o.why || "Couldn't send this message."), retry, drop);
    li.append(row);
  }
  return li;
}

// ---------- drafts: what you were writing stays per channel ----------

var drafts = (() => {
  try {
    return new Map(Object.entries(loadJson("drafts", {})));
  } catch {
    return new Map();
  }
})();

function draftKey() {
  const address = currentServer()?.address;
  return address && state.view !== null ? `${address}|${state.view}` : null;
}

function persistDrafts() {
  try {
    save("drafts", JSON.stringify(Object.fromEntries([...drafts].slice(-50))));
  } catch {}
}

function saveDraft() {
  const key = draftKey();
  if (!key) return;
  const text = chatInput.value;
  if (text.trim()) drafts.set(key, { text, mentions: [...composeMentions] });
  else drafts.delete(key);
  persistDrafts();
}

function restoreDraft() {
  state.draftAt = draftKey();
  const d = drafts.get(draftKey());
  chatInput.value = d?.text ?? "";
  composeMentions.clear();
  for (const [label, key] of d?.mentions ?? []) composeMentions.set(label, key);
  autosize();
}

function clearDraft() {
  const key = draftKey();
  if (key && drafts.delete(key)) persistDrafts();
}

window.addEventListener("beforeunload", saveDraft);

// ---------- quick switcher (Ctrl+K) ----------

var quick = { items: [], index: 0 };

function openQuick() {
  closePopovers();
  $("quick").hidden = false;
  $("quick-input").value = "";
  renderQuick();
  $("quick-input").focus();
}

function closeQuick() {
  $("quick").hidden = true;
}

/** Everything you can jump to: servers, the channels of the server you're in, and friends. */
function quickTargets() {
  const out = [];
  for (const s of prefs.servers) {
    out.push({
      kind: "*", name: s.label, sub: displayAddress(s), unread: serverUnread(s), mentions: serverMentions(s),
      node: () => serverChip(s), go: () => connectTo(s),
    });
  }
  if (online()) {
    const server = activeServer()?.label ?? "";
    for (const ch of state.roster.channels) {
      const text = ch.kind === "text";
      out.push({
        kind: "#", name: ch.name, sub: server,
        unread: text && channelUnread(activeServer()?.address, ch.id), mentions: text ? channelMentions(activeServer()?.address, ch.id) : 0,
        node: () => icon(text ? "hash" : "volume"), go: () => (text ? openTextChannel(ch.id) : joinVoice(ch.id)),
      });
    }
  }
  for (const f of state.friends?.values() ?? []) {
    if (f.state !== "friend") continue;
    const conv = state.conversations?.get(f.key);
    out.push({
      kind: "@", name: f.display_name, sub: f.username ? `@${f.username}` : "", unread: !!conv && conv.last_at > conv.last_read, mentions: 0,
      last: conv?.last_at ?? 0, node: () => avatar(f.display_name, "s24", undefined, f.avatar), go: () => openDm(f.key),
    });
  }
  return out;
}

function renderQuick() {
  let q = $("quick-input").value.trim().toLowerCase();
  let kind = null;
  if (/^[#@*]/.test(q)) {
    kind = q[0];
    q = q.slice(1).trim();
  }
  let items = quickTargets().filter((t) => !kind || t.kind === kind);
  if (q) {
    items = items
      .map((t) => {
        const name = t.name.toLowerCase();
        const sub = t.sub.toLowerCase();
        const score = name.startsWith(q) ? 0 : name.split(/[\s\-_.]+/).some((w) => w.startsWith(q)) ? 1 : name.includes(q) ? 2 : sub.includes(q) ? 3 : -1;
        return { t, score };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score || a.t.name.localeCompare(b.t.name))
      .map((x) => x.t);
  } else {
    // Nothing typed: what's waiting for you first, then recent conversations and servers.
    items.sort((a, b) => b.mentions - a.mentions || Number(b.unread) - Number(a.unread) || (b.last ?? 0) - (a.last ?? 0));
  }
  quick.items = items.slice(0, 12);
  quick.index = 0;
  const rows = quick.items.map((t, i) => {
    const li = el("li", "quick-item" + (i === 0 ? " active" : "") + (t.unread ? " unread" : ""));
    const lead = el("span", "quick-icon");
    lead.append(t.node());
    li.append(lead, el("span", "quick-name ellipsis", t.name));
    if (t.sub) li.append(el("span", "quick-sub ellipsis", t.sub));
    if (t.mentions) li.append(el("span", "count-badge", String(t.mentions)));
    li.addEventListener("mousemove", () => selectQuick(i));
    li.addEventListener("click", () => goQuick(i));
    return li;
  });
  if (!rows.length) rows.push(el("li", "quick-empty", "Nothing found."));
  $("quick-list").replaceChildren(...rows);
}

function selectQuick(i) {
  quick.index = i;
  document.querySelectorAll("#quick-list .quick-item").forEach((n, j) => n.classList.toggle("active", j === i));
  document.querySelectorAll("#quick-list .quick-item")[i]?.scrollIntoView({ block: "nearest" });
}

function goQuick(i) {
  const t = quick.items[i];
  if (!t) return;
  closeQuick();
  t.go();
}

$("quick-input").addEventListener("input", renderQuick);
$("quick-input").addEventListener("keydown", (e) => {
  const n = quick.items.length;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (n) selectQuick((quick.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
  } else if (e.key === "Enter") {
    e.preventDefault();
    goQuick(quick.index);
  } else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeQuick();
  }
});
$("quick").addEventListener("mousedown", (e) => {
  if (e.target === $("quick")) closeQuick();
});

// ---------- leaving a server ----------

async function leaveServer(server) {
  // Whether it's yours is only certain once connected, so connect first.
  if (server.id !== state.activeId && !(await connectTo(server))) {
    const remove = await confirmDialog({
      title: `Can't reach ${server.label}`,
      text: "Remove it from your list instead? If it comes back, you'll need an invite to rejoin.",
      ok: "Remove from list",
    });
    if (remove) removeServer(server);
    return;
  }
  // Your own server: owners delete instead of leaving.
  if (isOwner()) {
    if (isCloud(server)) deleteServer(server);
    else toast("You host this server, so you can't leave it. You can remove it from your list.", true);
    return;
  }
  const ok = await confirmDialog({
    title: `Leave ${server.label}`,
    text: "You'll need a new invite to come back.",
    ok: "Leave server",
  });
  if (!ok) return;
  state.leaving = server.id;
  invoke("leave_server").catch(() => {
    state.leaving = null;
    removeServer(server);
  });
}

listen("left", () => {
  const server = serverById(state.leaving) ?? activeServer();
  state.leaving = null;
  if (!server) return;
  state.justLeft = true;
  setTimeout(() => (state.justLeft = false), 3000);
  removeServer(server);
  toast(`You left ${server.label}.`);
});

// ---------- editing and moving channels (owner) ----------

var editingChannel = null;

function openChannelEdit(ch) {
  editingChannel = ch;
  const text = ch.kind === "text";
  $("channel-edit-sub").textContent = `in ${activeServer()?.label ?? state.roster.server_name}`;
  $("channel-edit-icon").innerHTML = `<use href="#i-${text ? "hash" : "volume"}"/>`;
  $("channel-edit-name").value = ch.name;
  $("channel-edit-topic").value = ch.topic ?? "";
  $("channel-edit-topic-field").hidden = !text;
  $("channel-edit-pictures").checked = !ch.no_pictures;
  $("channel-edit-pictures-row").hidden = !text || !isCloud(activeServer());
  $("channel-edit-pictures-sub").textContent = state.roster?.pictures_off
    ? "Pictures are off for the whole server (Server settings → Overview)."
    : "Members can share pictures in this channel.";
  $("channel-edit-category").value = ch.category ?? "";
  $("category-options").replaceChildren(...[...new Set(state.roster.channels.map((c) => c.category).filter(Boolean))].map((c) => {
    const o = el("option");
    o.value = c;
    return o;
  }));
  openModal($("channel-edit-dialog"));
  $("channel-edit-name").focus();
  $("channel-edit-name").select();
}
$("channel-edit-name").addEventListener("input", (e) => {
  if (editingChannel?.kind === "text") e.target.value = e.target.value.toLowerCase().replace(/\s/g, "-");
});
$("channel-edit-form").addEventListener("submit", () => {
  const name = $("channel-edit-name").value.trim();
  const topic = $("channel-edit-topic").value.trim();
  const category = $("channel-edit-category").value.trim();
  if (!editingChannel || !name) return;
  const noPictures = editingChannel.kind === "text" && isCloud(activeServer()) ? !$("channel-edit-pictures").checked : null;
  const picturesSame = noPictures === null || noPictures === !!editingChannel.no_pictures;
  if (name === editingChannel.name && topic === (editingChannel.topic ?? "") && category === (editingChannel.category ?? "") && picturesSame) return;
  call("update_channel", { channel: editingChannel.id, name, topic: topic || null, category: category || null, noPictures });
});

/** Drag a channel above or below another of the same kind. */
var channelDrag = null;
function draggableChannel(row, ch) {
  row.draggable = true;
  row.addEventListener("dragstart", (e) => {
    channelDrag = ch;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(ch.id));
    requestAnimationFrame(() => row.classList.add("dragging"));
  });
  row.addEventListener("dragend", () => {
    channelDrag = null;
    document.querySelectorAll(".channel-row.dragging, .channel-row.drop-before, .channel-row.drop-after").forEach((n) => n.classList.remove("dragging", "drop-before", "drop-after"));
  });
  row.addEventListener("dragover", (e) => {
    if (!channelDrag || channelDrag.kind !== ch.kind || channelDrag.id === ch.id) return;
    e.preventDefault();
    const r = row.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    row.classList.toggle("drop-after", after);
    row.classList.toggle("drop-before", !after);
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after"));
  row.addEventListener("drop", (e) => {
    if (!channelDrag || channelDrag.kind !== ch.kind || channelDrag.id === ch.id) return;
    e.preventDefault();
    const after = row.classList.contains("drop-after");
    const order = state.roster.channels.map((c) => c.id).filter((id) => id !== channelDrag.id);
    order.splice(order.indexOf(ch.id) + (after ? 1 : 0), 0, channelDrag.id);
    // Show it right away; the server confirms with the new list.
    const byId = new Map(state.roster.channels.map((c) => [c.id, c]));
    state.roster.channels = order.map((id) => byId.get(id));
    renderSidebar();
    call("reorder_channels", { order });
  });
}

// ---------- notification settings ----------

function serverLevel(s) {
  return prefs.notify.servers[s.address] ?? "mentions";
}

function channelMuted(address, channel) {
  return !!prefs.notify.channels[`${address}|${channel}`];
}

function saveNotify() {
  save("notify", JSON.stringify(prefs.notify));
  if (syncState.ready) scheduleSync();
  renderUnread();
}

function setServerLevel(s, level) {
  if (level === "mentions") delete prefs.notify.servers[s.address];
  else prefs.notify.servers[s.address] = level;
  saveNotify();
  toast(level === "all" ? `You'll be notified of every message in ${s.label}.` : level === "none" ? `${s.label} is muted.` : `You'll only be notified when someone mentions you in ${s.label}.`);
}

function setChannelMuted(address, channel, muted) {
  const key = `${address}|${channel}`;
  if (muted) prefs.notify.channels[key] = true;
  else delete prefs.notify.channels[key];
  saveNotify();
}

// ---------- links to other websites ----------

/** Sites scammers like to imitate, and their real addresses. */
var KNOWN_SITES = {
  steam: ["steamcommunity.com", "steampowered.com", "steamgames.com"],
  discord: ["discord.com", "discord.gg", "discordapp.com", "discord.gift"],
  paypal: ["paypal.com"],
  epicgames: ["epicgames.com"],
  roblox: ["roblox.com"],
  google: ["google.com"],
  microsoft: ["microsoft.com", "live.com"],
  twitch: ["twitch.tv"],
  youtube: ["youtube.com", "youtu.be"],
};

/** Real sites with a famous name in theirs. */
var REAL_SITES = new Set(["steamdb.info", "steamcharts.com", "steamspy.com", "discordstatus.com", "youtube-nocookie.com", "googleusercontent.com", "googleapis.com", "microsoftonline.com", "twitchtracker.com", "robloxdev.com"]);

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

/** Why an address looks like a trick, or null. */
function linkWarning(host) {
  if (/^xn--|\.xn--/.test(host)) return "This address uses unusual letters that can imitate another site.";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return "This link goes to a bare internet address, not a named website.";
  const site = host.split(".").slice(-2).join(".");
  if (REAL_SITES.has(site)) return null;
  for (const [brand, domains] of Object.entries(KNOWN_SITES)) {
    if (domains.some((d) => host === d || host.endsWith("." + d))) return null;
    const name = site.split(".")[0];
    const close = domains.some((d) => editDistance(site, d) <= 2) || (name !== brand && editDistance(name, brand) <= 1) || (name.includes(brand) && name !== brand);
    if (close) return `This looks like ${brand[0].toUpperCase() + brand.slice(1)}, but it isn't their website. Scammers use addresses like this to steal accounts.`;
  }
  return null;
}

function trustedDomains() {
  try {
    return new Set(JSON.parse(localStorage.getItem("trustedDomains") ?? "[]"));
  } catch {
    return new Set();
  }
}

async function openExternal(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const warning = linkWarning(host);
  if (!warning && trustedDomains().has(host)) return openUrl(href);
  const box = $("link-url");
  const rest = href.slice(href.indexOf(url.host) + url.host.length);
  box.replaceChildren(url.protocol + "//", el("b", "", url.host), rest);
  $("link-warn").hidden = !warning;
  $("link-warn").textContent = warning ?? "";
  $("link-trust-row").hidden = !!warning;
  $("link-trust").checked = false;
  $("link-domain").textContent = host;
  $("link-ok").classList.toggle("danger", !!warning);
  $("link-ok").classList.toggle("primary", !warning);
  $("link-ok").textContent = warning ? "Visit anyway" : "Visit site";
  const dialog = $("link-dialog");
  openModal(dialog);
  const go = await new Promise((resolve) => {
    const done = (v) => {
      dialog.close();
      $("link-ok").onclick = $("link-cancel").onclick = dialog.oncancel = null;
      resolve(v);
    };
    $("link-ok").onclick = () => done(true);
    $("link-cancel").onclick = () => done(false);
    dialog.oncancel = () => done(false);
  });
  if (!go) return;
  if ($("link-trust").checked) {
    const trusted = trustedDomains();
    trusted.add(host);
    try {
      localStorage.setItem("trustedDomains", JSON.stringify([...trusted]));
    } catch {}
  }
  openUrl(href);
}

function dmMuted(peer) {
  return !!prefs.notify.dms?.[peer];
}

function setDmMuted(peer, muted) {
  prefs.notify.dms ??= {};
  if (muted) prefs.notify.dms[peer] = true;
  else delete prefs.notify.dms[peer];
  saveNotify();
  renderAll();
}

// ---------- first steps for a new account ----------
//
// Recovery phrase, then a username, a picture and a quick mic check; then on to
// the invite or friend link that brought them here, if any.

$("backup-dialog").addEventListener("close", () => {
  if (state.onboarding?.step !== "backup") return;
  state.onboarding.step = "username";
  // Wait for the account, so the username can be checked as it's typed.
  const ask = () => (state.accountConnected ? openUsernameDialog(true) : setTimeout(ask, 300));
  ask();
});

$("username-dialog").addEventListener("close", () => {
  if (state.onboarding?.step !== "username") return;
  showWelcomeStep("picture");
});

function showWelcomeStep(step) {
  state.onboarding.step = step;
  const dialog = $("welcome-dialog");
  dialog.querySelectorAll("[data-wstep]").forEach((n) => (n.hidden = n.dataset.wstep !== step));
  dialog.querySelectorAll("[data-dot]").forEach((n) => n.classList.toggle("done", n.dataset.dot === step || (step === "mic" && n.dataset.dot === "picture")));
  $("welcome-next").textContent = step === "mic" ? "Done" : "Next";
  $("welcome-skip").hidden = step === "mic";
  if (step === "picture") renderWelcomeAvatar();
  if (step === "mic") {
    refreshDevices().finally(() => ($("welcome-mic-name").textContent = $("input-device").selectedOptions[0]?.textContent ?? ""));
    invoke("start_mic_test").catch(() => {});
  }
  if (!dialog.open) openModal(dialog);
}

function renderWelcomeAvatar() {
  const name = state.account?.name ?? "?";
  $("welcome-avatar").replaceChildren(avatar(name, "s80", undefined, state.me?.avatar));
  $("welcome-upload").textContent = state.me?.avatar ? "Change picture" : "Upload picture";
}

function finishOnboarding() {
  if (!state.onboarding) return;
  const link = state.onboarding.link;
  state.onboarding = null;
  invoke("stop_mic_test").catch(() => {});
  if ($("welcome-dialog").open) $("welcome-dialog").close();
  if (link) openLink(link);
  else toast("You're all set. Add a friend or join a server to get going.");
}

$("welcome-upload").addEventListener("click", () => $("avatar-file").click());
$("welcome-avatar").addEventListener("click", () => $("avatar-file").click());
$("welcome-next").addEventListener("click", () => (state.onboarding?.step === "picture" ? showWelcomeStep("mic") : finishOnboarding()));
$("welcome-skip").addEventListener("click", () => showWelcomeStep("mic"));
$("welcome-dialog").addEventListener("close", finishOnboarding);

// ---------- message menu and links to messages ----------

var MESSAGE_LINK = /^(?:hopp|strom):\/\/message\/([A-Za-z0-9_-]+)\/(\d+)\/(\d+)\/?$/i;

function base64url(text) {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text) {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function messageLink(m) {
  return `hopp://message/${base64url(activeServer()?.address ?? "")}/${m.channel}/${m.id}`;
}

async function openMessageLink(url) {
  const [, server64, ch, id] = url.match(MESSAGE_LINK);
  let address;
  try {
    address = fromBase64url(server64);
  } catch {
    return toast("That link is broken.", true);
  }
  const server = prefs.servers.find((s) => s.address === address);
  if (!server) return toast("That message is in a server you haven't joined.", true);
  if (server.id === state.activeId) {
    openTextChannel(Number(ch));
    jumpToMessage(Number(id));
    return;
  }
  state.pendingView = Number(ch);
  state.pendingJump = Number(id);
  await connectTo(server);
}

function openMessageMenu(m, e) {
  if (window.getSelection()?.toString()) return; // Let the normal menu copy a selection.
  e.preventDefault();
  const mine = m.author_key === state.account?.publicKey;
  const copy = (text, what) => navigator.clipboard.writeText(text).then(() => toast(`${what} copied.`), () => toast("Couldn't copy.", true));
  openMenu(
    [
      { label: "Reply", icon: "reply", action: () => setReply(m) },
      ...(mine && !PICTURE.test(m.text) ? [{ label: "Edit message", icon: "edit", action: () => startEdit(m) }] : []),
      ...(can("moderate") ? [{ label: m.pinned ? "Unpin message" : "Pin message", icon: "pin", action: () => call("pin_message", { channel: m.channel, id: m.id, on: !m.pinned }) }] : []),
      { label: "Add reaction", icon: "smile", action: () => openEmojiPicker(e.target.closest(".msg"), (emoji) => react(m, emoji, true)) },
      "sep",
      { label: "Mark unread", icon: "bell", action: () => markUnreadFrom(m) },
      { label: "Copy text", icon: "message", action: () => copy(plainText(m.text), "Text") },
      { label: "Copy message link", icon: "link", action: () => copy(messageLink(m), "Link") },
      ...(canDelete(m) ? ["sep", { label: "Delete message", icon: "trash", danger: true, action: () => deleteMessage(m) }] : []),
    ],
    e.clientX,
    e.clientY,
  );
}

// ---------- calls with friends ----------
//
// Peer to peer, with the same audio chain as voice channels. The friends'
// accounts pass the ringing, answers and addresses along; the call's key goes
// sealed for the friend, like a direct message, so nobody else can listen in.

var CALL_RING_MS = 35_000;

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A call signal. A call with a friend goes to them; a group call goes to `to` (a list of
 * Hopp IDs), or else to everyone in the call for an address, everyone in the group otherwise.
 */
function callSend(c, kind, extra = {}, to) {
  if (!c.group) return invoke("account_send", { msg: { type: "call", to: c.peer, call_id: c.id, kind, ...extra } }).catch(() => {});
  const targets = to ?? (kind === "endpoint" ? [...c.inCall] : groupOthers(c.group));
  return Promise.all(targets.map((t) => invoke("account_send", { msg: { type: "call", to: t, group: c.group, call_id: c.id, kind, ...extra } }).catch(() => {})));
}

/** Everyone in a group but us. */
function groupOthers(groupId) {
  return (state.groups.get(groupId)?.members ?? []).filter((k) => k !== state.me?.key);
}

/** Someone's number in a group call: from their Hopp ID, so every computer agrees on it. */
function callSession(key) {
  return parseInt(key.slice(0, 8), 16) >>> 0 || 1;
}

/** Group calls going on that we know of (rung, joined or seen), by group: { id, key, from, inCall }. */
state.groupCalls = new Map();

/** Calls everyone in a group. We're in the call at once; they join as they answer. */
async function startGroupCall(groupId) {
  if (state.call) return toast("You're already in a call.", true);
  if (!state.accountConnected) return toast("You're offline. Calls need a connection.", true);
  const running = state.groupCalls.get(groupId);
  if (running?.inCall.size) return joinGroupCall(groupId);
  const others = groupOthers(groupId);
  if (!others.length) return toast("There's nobody else in this group to call.", true);
  const key = hex(crypto.getRandomValues(new Uint8Array(32)));
  const c = { id: crypto.randomUUID(), group: groupId, peer: groupId, role: "caller", status: "ringing", key, me: callSession(state.me.key), inCall: new Set(), endpoints: new Map(), startedAt: null, engineReady: false };
  state.call = c;
  renderCall();
  // The key goes sealed for each member, like a message only they can read.
  await Promise.all(
    others.map(async (k) => {
      try {
        const sealed = await invoke("dm_seal", { peer: k, text: key });
        await invoke("account_send", { msg: { type: "call", to: k, group: groupId, call_id: c.id, kind: "ring", sealed } });
      } catch {}
    }),
  );
  if (state.call !== c) return;
  startRinging("ringback");
  c.timeout = setTimeout(() => {
    if (state.call === c && !c.inCall.size) {
      toast("Nobody joined the call.");
      endCall("missed");
    }
  }, CALL_RING_MS);
  await beginCallVoice(c);
}

/** Joins a group call that's already going (one we missed or declined). */
async function joinGroupCall(groupId) {
  const g = state.groupCalls.get(groupId);
  if (!g) return;
  if (state.call) return toast("You're already in a call.", true);
  if (g.inCall.size >= GROUP_CALL_MAX - 1) return toast(`The call is full (${GROUP_CALL_MAX} people).`, true);
  const c = { id: g.id, group: groupId, peer: groupId, role: "callee", status: "connecting", key: g.key, me: callSession(state.me.key), inCall: new Set(g.inCall), endpoints: new Map(), startedAt: null, engineReady: false };
  state.call = c;
  callSend(c, "join");
  renderCall();
  await beginCallVoice(c);
}

/** A group call's signal: ringing, people joining, their addresses, people leaving. */
async function handleGroupCallSignal(m) {
  const c = state.call?.id === m.call_id ? state.call : null;
  const known = state.groupCalls.get(m.group);
  if (m.kind === "ring") {
    if (c) return;
    let key;
    try {
      key = await invoke("dm_open", { peer: m.from, sealed: m.sealed });
    } catch {
      return;
    }
    state.groupCalls.set(m.group, { id: m.call_id, key, from: m.from, inCall: new Set([m.from]) });
    // Already in another call: the group shows it's going on, without ringing over it.
    if (state.call) return renderCall();
    const call = { id: m.call_id, group: m.group, peer: m.group, from: m.from, role: "callee", status: "ringing", key, me: callSession(state.me.key), inCall: new Set([m.from]), endpoints: new Map(), startedAt: null, engineReady: false };
    state.call = call;
    startRinging("ring");
    call.timeout = setTimeout(() => state.call === call && call.status === "ringing" && endCall("unanswered"), CALL_RING_MS + 5000);
    desktopNotify(personFor(m.from), "Incoming group call", `call:${m.group}`, groupName(state.groups.get(m.group)));
    renderCall();
    return;
  }
  if (known?.id === m.call_id) {
    if (m.kind === "join" || m.kind === "endpoint") known.inCall.add(m.from);
    if (m.kind === "leave") known.inCall.delete(m.from);
    if (!known.inCall.size && !c) state.groupCalls.delete(m.group);
  }
  if (!c) return renderCall();
  if (m.kind === "join") {
    c.inCall.add(m.from);
    if (c.status !== "ringing" || c.role === "caller") {
      stopRinging();
      clearTimeout(c.timeout);
    }
    // Tell the newcomer where we are; they tell us the same.
    if (c.engineReady && c.myEndpoint) callSend(c, "endpoint", c.myEndpoint, [m.from]);
  } else if (m.kind === "endpoint") {
    c.inCall.add(m.from);
    const peer = { session_id: callSession(m.from), public: m.public ?? null, local: m.local ?? [] };
    c.endpoints.set(m.from, peer);
    if (c.engineReady) invoke("call_peer", { callId: c.id, peer });
    if (c.status !== "ringing") {
      c.status = "live";
      c.startedAt ??= Date.now();
    }
    if (c.role === "caller") {
      stopRinging();
      clearTimeout(c.timeout);
      c.status = "live";
      c.startedAt ??= Date.now();
    }
  } else if (m.kind === "leave") {
    c.inCall.delete(m.from);
    c.endpoints.delete(m.from);
    if (c.engineReady) invoke("call_drop_peer", { callId: c.id, sessionId: callSession(m.from) });
    // Everyone else gone: the call is over here too (or never answered, if it was ringing).
    if (!c.inCall.size && (c.status !== "ringing" || c.role === "callee")) return endCall("empty");
  }
  renderCall();
}

async function startCall(peer) {
  if (state.call) return toast(state.call.peer === peer ? "You're already calling them." : "You're already in a call.", true);
  if (!state.accountConnected) return toast("You're offline. Calls need a connection.", true);
  const key = hex(crypto.getRandomValues(new Uint8Array(32)));
  const c = { id: crypto.randomUUID(), peer, role: "caller", status: "ringing", key, me: 1, other: 2, startedAt: null, peerEndpoint: null, engineReady: false };
  state.call = c;
  try {
    const sealed = await invoke("dm_seal", { peer, text: key });
    await invoke("account_send", { msg: { type: "call", to: peer, call_id: c.id, kind: "ring", sealed } });
  } catch (err) {
    state.call = null;
    renderCall();
    return toast(friendlyError(err), true);
  }
  startRinging("ringback");
  c.timeout = setTimeout(() => state.call === c && endCall("missed"), CALL_RING_MS);
  renderCall();
}

async function handleCallSignal(m) {
  if (m.group) return handleGroupCallSignal(m);
  const c = state.call;
  const name = personFor(m.from).display_name;
  if (m.kind === "ring") {
    if (c) return callSend({ peer: m.from, id: m.call_id }, "busy");
    let key;
    try {
      key = await invoke("dm_open", { peer: m.from, sealed: m.sealed });
    } catch {
      return;
    }
    const call = { id: m.call_id, peer: m.from, role: "callee", status: "ringing", key, me: 2, other: 1, startedAt: null, peerEndpoint: null, engineReady: false };
    state.call = call;
    startRinging("ring");
    call.timeout = setTimeout(() => state.call === call && call.status === "ringing" && endCall("unanswered"), CALL_RING_MS + 5000);
    desktopNotify(personFor(m.from), "Incoming call", `call:${m.from}`, name);
    renderCall();
    return;
  }
  if (!c || c.id !== m.call_id || c.peer !== m.from) return;
  if (m.kind === "answer" && c.role === "caller") {
    stopRinging();
    clearTimeout(c.timeout);
    c.status = "connecting";
    renderCall();
    await beginCallVoice(c);
  } else if (m.kind === "endpoint") {
    c.peerEndpoint = { session_id: c.other, public: m.public ?? null, local: m.local ?? [] };
    if (c.engineReady) invoke("call_peer", { callId: c.id, peer: c.peerEndpoint });
    c.status = "live";
    c.startedAt ??= Date.now();
    renderCall();
  } else if (m.kind === "decline") {
    toast(`${name} declined the call.`);
    endCall("remote");
  } else if (m.kind === "busy") {
    toast(`${name} is in another call.`);
    endCall("remote");
  } else if (m.kind === "offline") {
    toast(`${name} is offline. They'll see that you called.`);
    endCall("missed");
  } else if (m.kind === "end") {
    endCall("remote");
  }
}

/** Another of your devices answered or declined: stop ringing here. */
function handleCallSelf(m) {
  const c = state.call;
  if (!c || c.id !== m.call_id || c.role !== "callee" || c.status !== "ringing") return;
  if (m.kind === "answer" || m.kind === "decline" || m.kind === "join") {
    clearTimeout(c.timeout);
    stopRinging();
    state.call = null;
    renderCall();
  }
}

async function beginCallVoice(c) {
  if (myVoice() !== null) await call("leave_voice");
  stopMicTest();
  let me;
  try {
    me = await invoke("start_call", { callId: c.id, key: c.key, me: c.me });
  } catch (err) {
    toast(friendlyError(err), true);
    return endCall();
  }
  if (state.call !== c) return invoke("end_call");
  c.engineReady = true;
  c.myEndpoint = { public: me?.public ?? null, local: me?.local ?? [] };
  if (c.group) {
    for (const peer of c.endpoints.values()) invoke("call_peer", { callId: c.id, peer });
  } else if (c.peerEndpoint) invoke("call_peer", { callId: c.id, peer: c.peerEndpoint });
  callSend(c, "endpoint", c.myEndpoint);
  playSound("join");
}

async function answerCall() {
  const c = state.call;
  if (!c || c.role !== "callee" || c.status !== "ringing") return;
  if (c.group && c.inCall.size >= GROUP_CALL_MAX - 1) {
    toast(`The call is full (${GROUP_CALL_MAX} people).`, true);
    return endCall("declined");
  }
  clearTimeout(c.timeout);
  stopRinging();
  c.status = "connecting";
  callSend(c, c.group ? "join" : "answer");
  renderCall();
  openDm(c.peer);
  await beginCallVoice(c);
}

function declineCall() {
  const c = state.call;
  if (!c) return;
  callSend(c, "decline");
  endCall("declined");
}

/** Ends the call here; tells the friend unless they ended it. */
async function endCall(reason) {
  const c = state.call;
  if (!c) return;
  state.call = null;
  clearTimeout(c.timeout);
  stopRinging();
  if (c.group) {
    // Leaving a group call: the others carry on, and the group still shows it's going on.
    // Someone who never answered was never in it: nothing to leave.
    const wasIn = c.role === "caller" || c.status !== "ringing";
    if (wasIn && reason !== "declined" && reason !== "unanswered") callSend(c, "leave");
    if (c.inCall.size) state.groupCalls.set(c.group, { id: c.id, key: c.key, from: c.from, inCall: new Set(c.inCall) });
    else state.groupCalls.delete(c.group);
  } else if (reason !== "remote" && reason !== "declined" && reason !== "unanswered") callSend(c, "end");
  // Nobody picked up: leave a note in the conversation.
  if (c.role === "caller" && reason === "missed" && !c.group) sendDmText(c.peer, "📞 Missed call");
  if (c.engineReady) {
    await invoke("end_call").catch(() => {});
    playSound("leave");
  }
  renderCall();
}

async function sendDmText(peer, text) {
  try {
    const sealed = await invoke("dm_seal", { peer, text });
    await invoke("account_send", { msg: { type: "dm_send", to: peer, sealed, nonce: Math.random().toString(36).slice(2) } });
  } catch {}
}

function startRinging(sound) {
  stopRinging();
  playSound(sound);
  state.ringTimer = setInterval(() => playSound(sound), sound === "ring" ? 2200 : 3000);
}

function stopRinging() {
  clearInterval(state.ringTimer);
  state.ringTimer = null;
}

function callClock(c) {
  const secs = Math.max(0, Math.floor((Date.now() - (c.startedAt ?? Date.now())) / 1000));
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

function callStatusText(c) {
  if (c.status === "ringing") return c.role === "caller" ? "Calling…" : "Incoming call…";
  if (c.status === "connecting") return "Connecting…";
  if (c.unreachable) return "Can't connect directly…";
  return `In call · ${callClock(c)}`;
}

function renderCall() {
  const c = state.call;
  const ringingHere = c && c.role === "callee" && c.status === "ringing";
  // Incoming call card.
  $("incoming-call").hidden = !ringingHere;
  if (ringingHere) {
    const p = personFor(c.group ? c.from : c.peer);
    $("incoming-avatar").replaceChildren(avatar(p.display_name, "s40", undefined, p.avatar));
    $("incoming-name").textContent = c.group ? groupName(state.groups.get(c.group)) : p.display_name;
    $("incoming-what").textContent = c.group ? `${p.display_name} is calling the group…` : "Incoming call…";
  }
  // The panel above your name.
  $("call-panel").hidden = !c || ringingHere;
  if (c && !ringingHere) {
    $("call-status-text").textContent = callStatusText(c);
    $("call-where").textContent = c.group ? groupName(state.groups.get(c.group)) : personFor(c.peer).display_name;
    $("call-panel").classList.toggle("live", c.status === "live");
  }
  // The call button and the stage in the conversation.
  const dmOpen = !!state.openDm && !online();
  // A group call going on that we're not in: the group offers to join it.
  const elsewhere = dmOpen && isGroup(state.openDm) && !(c && c.peer === state.openDm) ? state.groupCalls.get(state.openDm) : null;
  const joinable = elsewhere?.inCall.size ? elsewhere : null;
  $("dm-call-btn").hidden = !dmOpen || !!c || !!joinable;
  $("dm-search-input-box").hidden = !dmOpen;
  const here = c && dmOpen && c.peer === state.openDm && !ringingHere;
  const stage = $("call-stage");
  stage.hidden = !here && !joinable;
  const who = (person, id) => {
    const wrap = el("div", "call-person");
    wrap.dataset.session = id;
    wrap.dataset.tip = person.display_name ?? "";
    wrap.append(avatar(person.display_name ?? "?", "s80", undefined, person.avatar));
    return wrap;
  };
  if (joinable) {
    const people = el("div", "call-people");
    for (const k of joinable.inCall) people.append(who(personFor(k), callSession(k)));
    const join = el("button", "call-btn accept");
    join.type = "button";
    join.dataset.tip = "Join the call";
    join.append(icon("phone"));
    join.addEventListener("click", () => joinGroupCall(state.openDm));
    const actions = el("div", "call-stage-actions");
    actions.append(join);
    stage.replaceChildren(people, el("div", "call-stage-status", "Call in progress"), actions);
  }
  if (here) {
    const me = state.me ?? {};
    const people = el("div", "call-people");
    people.classList.toggle("many", !!c.group && c.inCall.size > 2);
    people.append(who({ display_name: state.account?.name, avatar: me.avatar }, c.me));
    if (c.group) for (const k of c.inCall) people.append(who(personFor(k), callSession(k)));
    else people.append(who(personFor(c.peer), c.other));
    const status = el("div", "call-stage-status", callStatusText(c));
    const actions = el("div", "call-stage-actions");
    const hang = el("button", "call-btn decline");
    hang.type = "button";
    hang.dataset.tip = "Hang up";
    hang.append(icon("phone-off"));
    hang.addEventListener("click", () => endCall());
    actions.append(hang);
    stage.replaceChildren(people, status, actions);
  }
}

$("dm-call-btn").addEventListener("click", () => state.openDm && (isGroup(state.openDm) ? startGroupCall(state.openDm) : startCall(state.openDm)));
$("call-accept").addEventListener("click", answerCall);
$("call-decline").addEventListener("click", declineCall);
$("call-hangup").addEventListener("click", () => endCall());
$("call-where").addEventListener("click", () => state.call && openDm(state.call.peer));
setInterval(() => {
  if (state.call?.status === "live") {
    $("call-status-text").textContent = callStatusText(state.call);
    const status = document.querySelector(".call-stage-status");
    if (status) status.textContent = callStatusText(state.call);
  }
}, 1000);

listen("call-voice", (e) => {
  const ev = e.payload;
  if (ev.type === "speaking") {
    document.querySelectorAll(`.call-person[data-session="${ev.session_id}"]`).forEach((n) => n.classList.toggle("speaking", ev.speaking));
  } else if (ev.type === "speaking_while_muted" && prefs.mutedWarning) {
    playSound("muted");
    toast("You're muted. Press Ctrl+M or click the microphone to unmute.");
  } else if (ev.type === "devices_changed") {
    // A headset unplugged mid-call: carry on with what's there.
    devicesChanged();
  } else if (ev.type === "need_relay") {
    useRelay();
  } else if (ev.type === "endpoint" && state.call) {
    state.call.myEndpoint = { public: ev.endpoint.public ?? null, local: ev.endpoint.local ?? [] };
    callSend(state.call, "endpoint", state.call.myEndpoint);
  } else if (ev.type === "peer_reach" && state.call) {
    const c = state.call;
    const key = c.group ? [...c.inCall].find((k) => callSession(k) === ev.session_id) : c.peer;
    // In a group call one person out of reach doesn't make the whole call "can't connect".
    if (!c.group) c.unreachable = !ev.reachable;
    if (!ev.reachable && relayState.unavailable && key) toast(`Can't connect to ${personFor(key).display_name} directly. Their network or yours is blocking calls; a different network (or turning off a VPN) usually helps.`, true);
    renderCall();
  }
});

// Hanging up when the app goes away, so the friend isn't left talking to nobody.
window.addEventListener("beforeunload", () => state.call && callSend(state.call, state.call.group ? "leave" : "end"));

// ---------- group conversations ----------

state.groups = new Map();

function isGroup(id) {
  return typeof id === "string" && id.startsWith("g:");
}

function groupName(g) {
  if (!g) return "Group";
  if (g.name) return g.name;
  const others = g.members.filter((k) => k !== state.me?.key).map((k) => personFor(k).display_name);
  return others.length ? others.join(", ") : "Just you";
}

var editingGroup = null;

function openGroupDialog(group) {
  editingGroup = group;
  $("group-title").textContent = group ? "Edit group" : "New group";
  $("group-save").textContent = group ? "Save" : "Create group";
  $("group-name").value = group?.name ?? "";
  const inGroup = new Set(group?.members ?? []);
  const friends = [...state.friends.values()].filter((f) => f.state === "friend").sort((a, b) => a.display_name.localeCompare(b.display_name));
  $("group-friends").replaceChildren(
    ...friends.map((f) => {
      const li = el("li");
      const label = el("label", "group-friend");
      const box = el("input");
      box.type = "checkbox";
      box.value = f.key;
      box.checked = inGroup.has(f.key);
      box.disabled = inGroup.has(f.key);
      box.addEventListener("change", updateGroupSave);
      label.append(box, personAvatar(f, "s24", false), el("span", "ellipsis", f.display_name));
      if (f.username) label.append(el("span", "group-user", `@${f.username}`));
      li.append(label);
      return li;
    }),
  );
  updateGroupSave();
  openModal($("group-dialog"));
}

/** People in a group conversation, you included. */
var GROUP_MAX = 25;
/** People in a group call at once: everyone sends their voice to everyone. */
var GROUP_CALL_MAX = 10;

function pickedGroupFriends() {
  return [...document.querySelectorAll("#group-friends input:checked:not(:disabled)")].map((b) => b.value);
}

function updateGroupSave() {
  const picked = pickedGroupFriends().length;
  const total = (editingGroup?.members.length ?? 1) + picked;
  const full = total >= GROUP_MAX;
  document.querySelectorAll("#group-friends input:not(:checked)").forEach((b) => (b.disabled = full));
  $("group-sub").textContent = full ? `A group has at most ${GROUP_MAX} people.` : `Pick up to ${GROUP_MAX - 1} friends. Messages are end-to-end encrypted.`;
  $("group-save").disabled = editingGroup ? false : picked < 1;
}
$("group-name").addEventListener("input", updateGroupSave);

$("group-form").addEventListener("submit", () => {
  const name = $("group-name").value.trim();
  const picked = pickedGroupFriends();
  if (editingGroup) {
    accountSend({ type: "group_update", group: editingGroup.id, name, add: picked }).catch((err) => toast(friendlyError(err), true));
  } else {
    accountSend({ type: "group_create", members: picked, name }).catch((err) => toast(friendlyError(err), true));
  }
});

async function leaveGroup(id) {
  const ok = await confirmDialog({ title: `Leave ${groupName(state.groups.get(id))}`, text: "You won't get its messages anymore, and someone has to add you to come back.", ok: "Leave group" });
  if (ok) accountSend({ type: "group_leave", group: id }).catch(() => {});
}

prefs.closedCategories = loadJson("closedCategories", {});

// ---------- pinned messages ----------

listen("pinned", (e) => {
  const { channel: ch, id, on } = e.payload;
  const m = state.chats.get(ch)?.find((x) => x.id === id);
  if (m) m.pinned = on;
  if (ch === state.view) renderMessages(true);
  if (!$("pins-pop").hidden && ch === state.view) call("get_pins", { channel: ch });
  if (on && ch === state.view) toast("Message pinned.");
});

listen("pins", (e) => {
  const { channel: ch, messages } = e.payload;
  if (ch !== state.view) return;
  const pop = $("pins-pop");
  const list = el("div", "pins-list");
  for (const m of messages) {
    const item = el("button", "pin-item");
    item.type = "button";
    const head = el("div", "pin-head");
    head.append(avatar(m.sender_name, "s24", undefined, pictureFor(m.author_key)), el("strong", "ellipsis", m.sender_name), el("span", "pin-date", dayLabel(m.sent_at)));
    item.append(head, el("div", "pin-text", previewText(m.text)));
    item.addEventListener("click", () => {
      pop.hidden = true;
      jumpToMessage(m.id);
    });
    list.append(item);
  }
  if (!messages.length) list.append(el("div", "pins-empty", can("moderate") ? "Nothing pinned yet. Right-click a message to pin it." : "Nothing pinned in this channel yet."));
  pop.replaceChildren(el("div", "pins-title", `Pinned in #${channelName(ch)}`), list);
});

$("pins-btn").addEventListener("click", (e) => {
  const pop = $("pins-pop");
  if (!pop.hidden) return closePopovers();
  if (state.view === null) return;
  pop.replaceChildren(el("div", "pins-title", "Pinned messages"), el("div", "pins-empty", "Loading…"));
  const r = e.currentTarget.getBoundingClientRect();
  placePopover(pop, r.right - 380, r.bottom + 8);
  call("get_pins", { channel: state.view });
});

// ---------- deleting a server (owner) ----------

var deletingServer = null;

/** Asks the owner to type the server's name, then deletes it for everyone. */
function deleteServer(server) {
  deletingServer = server;
  $("delete-server-title").textContent = `Delete ${server.label}`;
  $("delete-server-label").textContent = `Type "${server.label}" to confirm`;
  $("delete-server-name").value = "";
  $("delete-server-ok").disabled = true;
  openModal($("delete-server-dialog"));
  $("delete-server-name").focus();
}

$("delete-server-name").addEventListener("input", (e) => {
  $("delete-server-ok").disabled = e.target.value.trim().toLowerCase() !== (deletingServer?.label ?? "").trim().toLowerCase();
});

$("delete-server-form").addEventListener("submit", async () => {
  const server = deletingServer;
  if (!server || $("delete-server-ok").disabled) return;
  // Deleting is done by the server itself, so connect first if we aren't there.
  if (server.id !== state.activeId && !(await connectTo(server))) {
    toast(`Couldn't reach ${server.label} to delete it. Try again in a moment.`, true);
    return;
  }
  if (!isOwner()) return toast("Only the server owner can delete it.", true);
  state.deleting = server.id;
  invoke("delete_server").catch((err) => {
    state.deleting = null;
    toast(friendlyError(err), true);
  });
});

listen("server-deleted", () => {
  const server = serverById(state.deleting) ?? activeServer();
  const mine = state.deleting === server?.id;
  state.deleting = null;
  if (!server) return;
  state.justLeft = true;
  setTimeout(() => (state.justLeft = false), 3000);
  removeServer(server);
  if (mine) toast(`${server.label} was deleted.`);
  else toast(`${server.label} was deleted by its owner.`);
  renderAll();
});

/** People in our voice channel we can't reach peer to peer. */
state.unreachable = new Set();
/** How the voice connection to each person in our channel is: { rtt, loss }. */
state.quality = new Map();

/** "good", "fair" or "poor": what a person's voice connection is like, from its numbers. */
function connectionGrade(q) {
  if (!q) return "good";
  const rtt = q.rtt ?? 0;
  if (q.loss >= 10 || rtt >= 300) return "poor";
  if (q.loss >= 3 || rtt >= 150) return "fair";
  return "good";
}

/** The connection in words, for a tooltip or the profile card. */
function connectionText(q) {
  const grade = connectionGrade(q);
  const parts = [q.rtt != null ? q.rtt + " ms" : null, q.loss > 0 ? q.loss + "% lost" : null].filter(Boolean);
  const word = grade === "good" ? "Good connection" : grade === "fair" ? "Okay connection" : "Weak connection";
  return parts.length ? word + ": " + parts.join(", ") : word;
}

// ---------- updates ----------
//
// Hopp looks for a newer version at start and every few hours. Updates are
// signed; anything not signed with Hopp's key is refused. When one is found,
// a green arrow shows in the top bar; it opens what's new and installs it.

var updates = {
  version: "", // the running version
  found: null, // { version, notes } when a newer one is out
  status: "idle", // idle | checking | newest | failed | installing
  progress: null, // 0–1 while downloading, when the size is known
  error: "",
};

async function checkForUpdate(manual) {
  if (updates.status === "installing" || updates.status === "checking") return;
  if (manual) {
    updates.status = "checking";
    renderUpdates();
  }
  try {
    updates.found = await invoke("check_update");
    updates.status = updates.found ? "idle" : manual ? "newest" : updates.status === "checking" ? "idle" : updates.status;
  } catch (err) {
    // A quiet check that fails (offline) says nothing; one you asked for does.
    updates.status = manual ? "failed" : "idle";
    updates.error = friendlyError(err);
  }
  renderUpdates();
}

function installUpdate() {
  if (updates.status === "installing") return;
  updates.status = "installing";
  updates.progress = null;
  renderUpdates();
  invoke("install_update").catch((err) => {
    updates.status = "failed";
    updates.error = friendlyError(err);
    renderUpdates();
  });
}

listen("update-progress", (e) => {
  const { done, total } = e.payload ?? {};
  updates.progress = total ? Math.min(done / total, 1) : null;
  renderUpdates();
});

function updateProgressText() {
  if (updates.progress === null) return "Downloading…";
  return updates.progress >= 1 ? "Installing… Hopp restarts in a moment." : `Downloading… ${Math.round(updates.progress * 100)}%`;
}

function setBar(bar, show) {
  bar.hidden = !show;
  bar.classList.toggle("unknown", updates.progress === null);
  bar.firstElementChild.style.width = `${Math.round((updates.progress ?? 0) * 100)}%`;
}

/** The top bar arrow, its popup and the App settings card. */
function renderUpdates() {
  const installing = updates.status === "installing";
  const btn = $("update-btn");
  // Always there: grey when Hopp is up to date, green when a newer one is ready.
  btn.classList.toggle("ready", !!updates.found);
  btn.setAttribute("aria-label", updates.found ? "Update available" : "Updates");
  btn.dataset.tip = updates.found ? `Hopp ${updates.found.version} is ready` : `Hopp ${updates.version} · up to date`;

  $("version-title").textContent = updates.version ? `Hopp ${updates.version}` : "Hopp";
  $("settings-version").textContent = updates.version ? `Hopp ${updates.version}` : "Hopp";
  $("version-sub").textContent = installing
    ? updateProgressText()
    : updates.status === "checking"
    ? "Looking for updates…"
    : updates.status === "failed"
    ? updates.error || "Couldn't check for updates."
    : updates.found
    ? `Hopp ${updates.found.version} is ready to install.`
    : updates.status === "newest"
    ? "You have the newest version."
    : "Updates are checked automatically.";
  const vbtn = $("version-btn");
  vbtn.textContent = installing ? "Updating…" : updates.found ? "Update now" : "Check for updates";
  vbtn.classList.toggle("primary", !!updates.found);
  vbtn.disabled = installing || updates.status === "checking";
  setBar($("version-bar"), installing);

  const pop = document.querySelector(".update-pop");
  if (pop) fillUpdatePop(pop);
}

function fillUpdatePop(pop) {
  if (!updates.found) return fillUpToDatePop(pop);
  const installing = updates.status === "installing";
  const head = el("div", "update-pop-head");
  const mark = el("span", "update-pop-mark");
  mark.append(icon("logo"));
  const title = el("div", "update-pop-title");
  title.append(el("strong", "", "Update available"), el("span", "", `Hopp ${updates.version || "?"} → ${updates.found?.version ?? "?"}`));
  head.append(mark, title);
  const parts = [head];
  const notes = updates.found?.notes?.trim();
  if (notes) {
    parts.push(el("div", "update-pop-label", "What's new"), el("p", "update-notes", notes));
  }
  if (installing) {
    const bar = el("div", "update-bar");
    bar.append(el("span"));
    setBar(bar, true);
    parts.push(bar, el("p", "update-pop-status", updateProgressText()));
  } else {
    if (updates.status === "failed") parts.push(el("p", "update-pop-error", updates.error));
    if (state.call || myVoice() !== null) parts.push(el("p", "update-pop-warn", "You'll leave voice for a moment while Hopp restarts."));
    const actions = el("div", "update-pop-actions");
    const later = el("button", "btn sm", "Later");
    later.type = "button";
    later.addEventListener("click", closeUpdatePop);
    const go = el("button", "btn sm primary", "Restart and update");
    go.type = "button";
    go.addEventListener("click", installUpdate);
    actions.append(later, go);
    parts.push(actions);
  }
  pop.replaceChildren(...parts);
}

function closeUpdatePop() {
  document.querySelector(".update-pop")?.remove();
}

$("update-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  if (document.querySelector(".update-pop")) return closeUpdatePop();
  const pop = el("div", "update-pop");
  pop.addEventListener("click", (ev) => ev.stopPropagation());
  fillUpdatePop(pop);
  document.body.append(pop);
  const r = $("update-btn").getBoundingClientRect();
  pop.style.top = `${r.bottom + 8}px`;
  pop.style.right = `${Math.max(8, innerWidth - r.right - 8)}px`;
});
document.addEventListener("click", () => {
  if (updates.status !== "installing") closeUpdatePop();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && updates.status !== "installing") closeUpdatePop();
});

$("version-btn").addEventListener("click", () => (updates.found ? installUpdate() : checkForUpdate(true)));

invoke("app_version").then((v) => {
  updates.version = v ?? "";
  renderUpdates();
}).catch(() => {});
setTimeout(checkForUpdate, 8000);
setInterval(checkForUpdate, 4 * 3600 * 1000);

/** A message that is nothing but one invite link. */
function isInviteOnly(text) {
  const t = text.trim();
  return !/\s/.test(t) && inviteTarget(t) !== null;
}

// ---------- getting started (a brand-new account) ----------

function gettingStarted() {
  const box = el("div", "getting-started");
  const name = state.me?.display_name || state.account?.name || "";
  box.append(el("h2", "", `Welcome to Hopp${name ? `, ${name}` : ""}!`), el("p", "gs-sub", "Hopp is better with friends. Here's how to get going."));
  const card = (iconName, title, text, action, onClick, extra) => {
    const c = el("div", "gs-card");
    const ic = el("span", "gs-icon");
    ic.append(icon(iconName));
    c.append(ic, el("strong", "", title), el("p", "", text));
    if (extra) c.append(extra);
    const b = el("button", "btn sm primary", action);
    b.type = "button";
    b.addEventListener("click", onClick);
    c.append(b);
    return c;
  };
  // Your username, to send to friends.
  let handle = null;
  if (state.me?.username) {
    handle = el("button", "gs-handle");
    handle.type = "button";
    handle.dataset.tip = "Copy";
    handle.append(el("span", "", `@${state.me.username}`), icon("link", "xs"));
    handle.addEventListener("click", () => navigator.clipboard.writeText(state.me.username).then(() => toast("Username copied. Send it to a friend so they can add you.")));
  }
  const grid = el("div", "gs-grid");
  grid.append(
    card("user-plus", "Add a friend", "Friends add each other by username. Share yours:", "Add friend", () => {
      state.friendTab = "add";
      renderHome();
    }, handle),
    card("plus", "Create a server", "A place for your group, with text and voice channels.", "Create server", () => openAddDialog("create")),
    card("link", "Join a server", "Got an invite link from someone? Paste it here.", "Join with invite", () => openAddDialog("join")),
  );
  box.append(grid);
  // Friends who don't have Hopp yet get it from Hopp's page.
  const share = el("p", "gs-share");
  const copy = el("button", "link", "Copy the download link");
  copy.type = "button";
  copy.addEventListener("click", () => navigator.clipboard.writeText(prefs.cloudUrl.replace(/^ws/, "http") + "/").then(() => toast("Link copied. Friends can download Hopp from it.")));
  share.append("Friends don't have Hopp yet? ", copy);
  box.append(share);
  return box;
}

// ---------- active now ----------

/** Who is around: friends in voice first, then everyone online. */
function activeNowPanel() {
  const aside = el("aside", "active-now");
  aside.append(el("h3", "", "Active now"));
  const online = [...(state.friends?.values() ?? [])].filter((f) => f.state === "friend" && f.status !== "offline");
  const busy = online.filter((f) => f.activity);
  const rest = online.filter((f) => !f.activity);
  if (!online.length) {
    const empty = el("div", "active-empty");
    empty.append(el("strong", "", "It's quiet for now…"), el("p", "", "When friends are online or hop into voice, you'll see them here."));
    aside.append(empty);
    return aside;
  }
  for (const f of busy) {
    const card = el("div", "active-card");
    const top = el("div", "active-top");
    const text = el("div", "active-text");
    text.append(el("strong", "ellipsis", f.display_name));
    const what = el("span", "active-what ellipsis");
    what.append(icon("headphones", "xs"), f.activity);
    text.append(what);
    top.append(personAvatar(f, "s40", true), text);
    const actions = el("div", "active-actions");
    const message = el("button", "btn sm", "Message");
    message.type = "button";
    message.addEventListener("click", () => openDm(f.key));
    const callBtn = el("button", "btn sm", "Call");
    callBtn.type = "button";
    callBtn.addEventListener("click", () => {
      openDm(f.key);
      startCall(f.key);
    });
    actions.append(message, callBtn);
    card.append(top, actions);
    aside.append(card);
  }
  if (rest.length) {
    aside.append(el("div", "active-label", `Online — ${rest.length}`));
    for (const f of rest.sort((a, b) => a.display_name.localeCompare(b.display_name))) {
      const row = el("button", "active-row");
      row.type = "button";
      row.append(personAvatar(f, "s24", true), el("span", "ellipsis", f.display_name));
      if (f.status === "idle" || f.status === "dnd") row.append(el("span", "active-status", STATUS_LABEL[f.status]));
      row.addEventListener("click", () => openDm(f.key));
      aside.append(row);
    }
  }
  return aside;
}

// ---------- blocking ----------

state.shownBlocked = new Set();

function isBlocked(key) {
  return !!key && state.friends?.get(key)?.state === "blocked";
}

/** Someone was blocked or unblocked: their voice and messages change right away. */
function blockChanged() {
  state.appliedVolumes.clear();
  // Unblocked people get their own volume back (or full volume).
  for (const u of state.roster?.users ?? []) {
    if (u.session_id !== state.roster.me && !isBlocked(keyOf(u)) && userVolume(u) === undefined) call("set_user_volume", { sessionId: u.session_id, volume: 1 });
  }
  applyUserVolumes();
  if (online()) renderMessages(true);
}

// ---------- roles ----------

state.members = [];

/** Which roles I may give someone: the owner names admins, admins name moderators. */
function rolesICanGive(target) {
  if (!isCloud(activeServer()) || !target || roleOf(target) === "owner") return [];
  if (target.public_key === state.account?.publicKey) return [];
  if (isOwner()) return [null, "mod", "admin"];
  if (can("manage") && rankOf(target) < ROLE_RANK.admin) return [null, "mod"];
  return [];
}

function roleSelect(target, onChange) {
  const select = el("select", "row-select role-select");
  for (const role of rolesICanGive(target)) {
    const opt = el("option", "", role ? ROLE_LABEL[role] : "Member");
    opt.value = role ?? "";
    select.append(opt);
  }
  select.value = roleOf(target) ?? "";
  select.addEventListener("change", () => onChange(select.value || null));
  return select;
}

function renderUserRole(user) {
  const roles = rolesICanGive(user);
  const wrap = $("user-role-wrap");
  wrap.hidden = roles.length === 0;
  const select = $("user-role");
  select.replaceChildren(...roles.map((r) => {
    const opt = el("option", "", r ? ROLE_LABEL[r] : "Member");
    opt.value = r ?? "";
    return opt;
  }));
  select.value = roleOf(user) ?? "";
  $("user-transfer").hidden = !isOwner() || !isCloud(activeServer()) || user.session_id === state.roster?.me;
  // Kick/ban sit beside the role when there's both.
  $("user-mod").classList.toggle("single", $("user-ban").hidden);
}

async function setRole(member, role) {
  try {
    await invoke("set_role", { publicKey: member.public_key, role });
    toast(role ? `${member.name} is now ${role === "admin" ? "an admin" : "a moderator"}.` : `${member.name} is a member again.`);
  } catch (err) {
    toast(friendlyError(err), true);
  }
}

async function transferOwnership(member) {
  const server = activeServer();
  const ok = await confirmDialog({
    title: `Give ${server?.label ?? "this server"} to ${member.name}?`,
    text: `${member.name} becomes the owner and can do everything, including deleting the server. You stay on as an admin. Only they can give it back.`,
    ok: "Transfer ownership",
  });
  if (!ok) return;
  try {
    await invoke("transfer_ownership", { publicKey: member.public_key });
    toast(`${member.name} owns ${server?.label ?? "the server"} now.`);
  } catch (err) {
    toast(friendlyError(err), true);
  }
}

/** Server settings → Members: everyone who belongs here, online or not. */
function renderMemberList() {
  const list = $("server-members");
  const q = $("member-search").value.trim().toLowerCase();
  const online = new Set((state.roster?.users ?? []).map((u) => u.public_key));
  const members = state.members
    .filter((m) => !q || m.name.toLowerCase().includes(q))
    .sort((a, b) => (ROLE_RANK[b.role] ?? 0) - (ROLE_RANK[a.role] ?? 0) || a.name.localeCompare(b.name));
  $("member-count").textContent = `${state.members.length} ${state.members.length === 1 ? "member" : "members"}`;
  if (!members.length) {
    list.replaceChildren(el("li", "admin-empty", q ? "Nobody by that name." : "No members yet."));
    return;
  }
  list.replaceChildren(
    ...members.map((m) => {
      const li = el("li", "admin-row member-admin-row");
      const who = el("span", "admin-who");
      const target = { ...m, owner: m.role === "owner" };
      who.append(avatar(m.name, "s40", online.has(m.public_key) ? "online" : undefined, pictureFor(m.public_key)));
      const text = el("span", "admin-text");
      const name = el("strong", "ellipsis", m.name);
      const joined = new Date(m.joined_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
      text.append(name, el("span", "admin-sub", `${online.has(m.public_key) ? "Online · " : ""}Joined ${joined}`));
      who.append(text);
      li.append(who);
      const actions = el("span", "member-admin-actions");
      if (rolesICanGive(target).length) {
        actions.append(roleSelect(target, (role) => setRole(m, role)));
      } else {
        actions.append(el("span", `role-label ${m.role ?? "member"}`, m.role ? ROLE_LABEL[m.role] : "Member"));
      }
      if (isOwner() && m.role !== "owner") {
        const give = el("button", "icon-btn", "");
        give.type = "button";
        give.dataset.tip = "Transfer ownership";
        give.setAttribute("aria-label", `Transfer ownership to ${m.name}`);
        give.append(icon("crown"));
        give.addEventListener("click", () => transferOwnership(m));
        actions.append(give);
      }
      li.append(actions);
      return li;
    }),
  );
}
$("member-search").addEventListener("input", renderMemberList);

// ---------- mark as read ----------

function serverHasUnread(address) {
  for (const r of state.reads.values()) if (r.server === address && (r.last_id > r.read_id || r.mentions)) return true;
  return false;
}

function markChannelRead(address, channel) {
  const r = state.reads.get(readKey(address, channel));
  if (r) setRead(address, channel, r.last_id);
  renderUnread();
}

function markServerRead(address) {
  for (const r of [...state.reads.values()]) if (r.server === address) setRead(address, r.channel, r.last_id);
  renderUnread();
}

// ---------- jump to present ----------
//
// Scrolled up to read older messages: a bar offers the way back down and counts
// what arrived meanwhile.

var jumpSeen = { channel: null, id: 0 };

function updateJumpBar() {
  const scroller = $("scroller");
  const bar = $("jump-bar");
  const away = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 400;
  const msgs = state.chats.get(state.view) ?? [];
  if (!away || !online()) {
    bar.hidden = true;
    jumpSeen = { channel: state.view, id: msgs.at(-1)?.id ?? 0 };
    return;
  }
  if (jumpSeen.channel !== state.view) jumpSeen = { channel: state.view, id: msgs.at(-1)?.id ?? 0 };
  const fresh = msgs.filter((m) => m.id > jumpSeen.id && m.author_key !== state.account?.publicKey).length;
  $("jump-text").textContent = fresh ? `${fresh} new ${fresh === 1 ? "message" : "messages"}` : "You're viewing older messages";
  bar.classList.toggle("fresh", fresh > 0);
  bar.hidden = false;
}

$("jump-bar").addEventListener("click", () => toBottom($("scroller")));

/** The grey arrow's popup: which Hopp you have, and a way to look for a newer one. */
function fillUpToDatePop(pop) {
  const head = el("div", "update-pop-head");
  const mark = el("span", "update-pop-mark");
  mark.append(icon("logo"));
  const title = el("div", "update-pop-title");
  const status = updates.status === "checking" ? "Looking for updates…" : updates.status === "failed" ? updates.error || "Couldn't check for updates." : "You have the newest version.";
  title.append(el("strong", "", `Hopp ${updates.version || ""}`.trim()), el("span", "", status));
  head.append(mark, title);
  const actions = el("div", "update-pop-actions");
  const checkBtn = el("button", "btn sm", "Check for updates");
  checkBtn.type = "button";
  checkBtn.disabled = updates.status === "checking";
  checkBtn.addEventListener("click", () => checkForUpdate(true));
  actions.append(checkBtn);
  pop.replaceChildren(head, actions);
}

// ---------- pictures in chat ----------
//
// Cloud servers keep pictures in their own database. The app shrinks each one to
// a light WebP first, uploads it signed with our Hopp ID, and sends a message that
// points to it: "hopp-image:<id> <width>x<height>", then the caption.

var PICTURE = /^hopp-image:([0-9a-f]{32}) (\d{1,5})x(\d{1,5})(?:\n|$)/;
const PICTURE_MAX_BYTES = 300_000;
const PICTURE_MAX_SIDE = 1600;
state.attachment = null; // { channel, blob, type, width, height, url, sending }

/** Pictures need a cloud server whose owner hasn't turned them off, here or everywhere. */
function picturesAllowed() {
  return isCloud(activeServer()) && !state.roster?.pictures_off && !channel(state.view)?.no_pictures;
}

function cloudHttp() {
  return prefs.cloudUrl.replace(/^ws/, "http").replace(/\/+$/, "");
}

function pictureUrl(id) {
  const server = activeServer()?.address.slice("cloud:".length);
  return `${cloudHttp()}/servers/${server}/images/${id}`;
}

/** Shrinks a picture until it's light enough to send. */
async function shrinkChatPicture(file) {
  const source = URL.createObjectURL(file);
  const bitmap = await new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => fail(new Error("That file isn't a picture Hopp can read."));
    img.src = source;
  }).finally(() => setTimeout(() => URL.revokeObjectURL(source), 0));
  const natural = { width: bitmap.naturalWidth, height: bitmap.naturalHeight };
  let scale = Math.min(1, PICTURE_MAX_SIDE / Math.max(natural.width, natural.height));
  for (let attempt = 0; attempt < 8; attempt++) {
    const width = Math.max(1, Math.round(natural.width * scale));
    const height = Math.max(1, Math.round(natural.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
    for (const quality of [0.86, 0.76, 0.64]) {
      let url = canvas.toDataURL("image/webp", quality);
      if (!url.startsWith("data:image/webp")) url = canvas.toDataURL("image/jpeg", quality);
      const type = url.slice(5, url.indexOf(";"));
      const bytes = Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0));
      if (bytes.length <= PICTURE_MAX_BYTES) return { blob: new Blob([bytes], { type }), type, width, height };
    }
    scale *= 0.75;
  }
  throw new Error("That picture is too big to send.");
}

async function attachPicture(file) {
  if (!file || !/^image\//.test(file.type)) return;
  if (!online() || state.view === null) return;
  if (!isCloud(activeServer())) return toast("Pictures work on Hopp Cloud servers.", true);
  if (!picturesAllowed()) return toast("Pictures are turned off in this channel.", true);
  try {
    const shrunk = await shrinkChatPicture(file);
    clearAttachment();
    state.attachment = { channel: state.view, ...shrunk, url: URL.createObjectURL(shrunk.blob), sending: false };
    renderAttachment();
    chatInput.focus();
  } catch (err) {
    toast(friendlyError(err?.message ?? err), true);
  }
}

function clearAttachment() {
  if (state.attachment?.url) URL.revokeObjectURL(state.attachment.url);
  state.attachment = null;
  renderAttachment();
}

function renderAttachment() {
  const tray = $("attach-tray");
  const a = state.attachment;
  const show = !!a && a.channel === state.view;
  tray.hidden = !show;
  $("composer").classList.toggle("has-attachment", show);
  if (!show) return tray.replaceChildren();
  fillTray(tray, a, clearAttachment);
}

/** A picture waiting to be sent: its thumbnail, a remove button and a hint. */
function fillTray(tray, a, clear) {
  const card = el("div", "attach-card" + (a.sending ? " sending" : ""));
  const img = el("img");
  img.src = a.url;
  img.alt = "";
  card.append(img);
  if (a.sending) card.append(el("span", "attach-status", "Sending…"));
  else {
    const remove = el("button", "attach-remove");
    remove.type = "button";
    remove.dataset.tip = "Remove";
    remove.setAttribute("aria-label", "Remove picture");
    remove.append(icon("x", "xs"));
    remove.addEventListener("click", clear);
    card.append(remove);
  }
  tray.replaceChildren(card, el("span", "attach-hint", a.sending ? "" : "Add a caption, or press Enter to send"));
}

async function sendPicture() {
  const a = state.attachment;
  if (!a || a.sending) return;
  const channel = a.channel;
  const caption = withMentions(chatInput.value.trim());
  const replyTo = state.replyTo?.channel === channel ? state.replyTo.id : null;
  a.sending = true;
  renderAttachment();
  try {
    const bytes = new Uint8Array(await a.blob.arrayBuffer());
    const id = await invoke("upload_image", { cloud: cloudHttp(), serverId: activeServer().address.slice("cloud:".length), data: Array.from(bytes), kind: a.type });
    chatInput.value = "";
    autosize();
    clearDraft();
    setReply(null);
    clearAttachment();
    sendChat(channel, `hopp-image:${id} ${a.width}x${a.height}${caption ? "\n" + caption : ""}`, replyTo);
  } catch (err) {
    a.sending = false;
    renderAttachment();
    toast(friendlyError(err), true);
  }
}

/** A picture in a message, sized before it loads so the chat doesn't jump. */
function pictureView(id, width, height) {
  const fit = Math.min(1, 400 / width, 320 / height);
  const box = el("button", "msg-picture");
  box.dataset.keep = `pic|${id}`;
  box.type = "button";
  box.style.width = `${Math.max(48, Math.round(width * fit))}px`;
  box.style.aspectRatio = `${width} / ${height}`;
  const img = el("img");
  img.alt = "Image";
  img.loading = "lazy";
  img.src = pictureUrl(id);
  img.addEventListener("error", () => {
    box.classList.add("gone");
    box.replaceChildren(icon("x", "xs"), el("span", "", "Picture no longer available"));
  });
  box.append(img);
  box.addEventListener("click", () => {
    if (box.classList.contains("gone")) return;
    $("lightbox-img").src = img.src;
    $("lightbox").showModal();
  });
  return box;
}

$("lightbox").addEventListener("click", () => $("lightbox").close());
$("attach-btn").addEventListener("click", () => $("attach-file").click());
$("attach-file").addEventListener("change", (e) => {
  attachPicture(e.target.files?.[0]);
  e.target.value = "";
});
chatInput.addEventListener("paste", (e) => {
  const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
  if (!file) return;
  e.preventDefault();
  attachPicture(file);
});
const chatSection = document.querySelector(".chat");
chatSection.addEventListener("dragover", (e) => {
  if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
  e.preventDefault();
  chatSection.classList.add("dropping");
});
chatSection.addEventListener("dragleave", (e) => {
  if (!chatSection.contains(e.relatedTarget)) chatSection.classList.remove("dropping");
});
chatSection.addEventListener("drop", (e) => {
  chatSection.classList.remove("dropping");
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  const file = files.find((f) => f.type.startsWith("image/"));
  if (file) attachPicture(file);
  else toast("Servers take pictures only. Send other files to a friend in a DM.", true);
});

// A file dropped anywhere else mustn't replace the app with the file itself.
for (const type of ["dragover", "drop"]) {
  document.addEventListener(type, (e) => {
    if ([...(e.dataTransfer?.types ?? [])].includes("Files")) e.preventDefault();
  });
}

// ---------- pictures in DMs ----------
//
// Encrypted here with a fresh key (AES-GCM), stored as noise in the sender's account,
// and the key travels only inside the sealed message:
// "hopp-dm-image:<owner key>:<id>:<key> <width>x<height>", then the caption.

var DM_PICTURE = /^hopp-dm-image:([0-9a-f]{64}):([0-9a-f]{32}):([A-Za-z0-9_-]{43}) (\d{1,5})x(\d{1,5})(?:\n|$)/;
state.dmAttachment = null; // { peer, blob, type, width, height, url, sending }
const dmPictures = new Map(); // picture id -> Promise of a blob URL

function bytesToB64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function attachDmPicture(peer, file) {
  if (!file || !/^image\//.test(file.type)) return;
  try {
    const shrunk = await shrinkChatPicture(file);
    clearDmAttachment();
    state.dmAttachment = { peer, ...shrunk, url: URL.createObjectURL(shrunk.blob), sending: false };
    renderDmAttachment();
    $("dm-input")?.focus();
  } catch (err) {
    toast(friendlyError(err?.message ?? err), true);
  }
}

function clearDmAttachment() {
  if (state.dmAttachment?.url) URL.revokeObjectURL(state.dmAttachment.url);
  state.dmAttachment = null;
  renderDmAttachment();
}

function renderDmAttachment() {
  const view = document.querySelector(".dm-view");
  const tray = view?.querySelector("#dm-attach-tray");
  if (!tray) return;
  const a = state.dmAttachment;
  const show = !!a && a.peer === view.dataset.peer;
  tray.hidden = !show;
  if (!show) return tray.replaceChildren();
  fillTray(tray, a, clearDmAttachment);
}

async function sendDmPicture(peer, input) {
  const a = state.dmAttachment;
  if (!a || a.sending) return;
  a.sending = true;
  renderDmAttachment();
  try {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aes = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, await a.blob.arrayBuffer()));
    const payload = new Uint8Array(iv.length + sealed.length);
    payload.set(iv);
    payload.set(sealed, iv.length);
    const id = await invoke("upload_dm_image", { cloud: cloudHttp(), data: Array.from(payload) });
    const caption = input.value.trim();
    input.value = "";
    input.style.height = "auto";
    clearDmAttachment();
    sendDm(peer, { value: `hopp-dm-image:${state.me.key}:${id}:${bytesToB64url(key)} ${a.width}x${a.height}${caption ? "\n" + caption : ""}`, style: {} });
  } catch (err) {
    a.sending = false;
    renderDmAttachment();
    toast(friendlyError(err?.message ?? err), true);
  }
}

/** Fetches and decrypts a DM picture once; later views reuse it. */
function dmPictureUrl(owner, id, key) {
  if (!dmPictures.has(id)) {
    dmPictures.set(id, (async () => {
      const res = await fetch(`${cloudHttp()}/accounts/${owner}/images/${id}`);
      if (!res.ok) throw new Error("gone");
      const data = new Uint8Array(await res.arrayBuffer());
      const aes = await crypto.subtle.importKey("raw", b64urlToBytes(key), "AES-GCM", false, ["decrypt"]);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: data.slice(0, 12) }, aes, data.slice(12));
      return URL.createObjectURL(new Blob([plain]));
    })().catch((err) => {
      dmPictures.delete(id);
      throw err;
    }));
  }
  return dmPictures.get(id);
}

function dmPictureView(owner, id, key, width, height) {
  const fit = Math.min(1, 400 / width, 320 / height);
  const box = el("button", "msg-picture loading");
  box.dataset.keep = `dmpic|${id}`;
  box.type = "button";
  box.style.width = `${Math.max(48, Math.round(width * fit))}px`;
  box.style.aspectRatio = `${width} / ${height}`;
  const img = el("img");
  img.alt = "Image";
  box.append(img);
  dmPictureUrl(owner, id, key).then(
    (url) => {
      img.src = url;
      box.classList.remove("loading");
    },
    () => {
      box.classList.remove("loading");
      box.classList.add("gone");
      box.replaceChildren(icon("x", "xs"), el("span", "", "Picture no longer available"));
    },
  );
  box.addEventListener("click", () => {
    if (!img.src) return;
    $("lightbox-img").src = img.src;
    $("lightbox").showModal();
  });
  return box;
}

// ---------- inviting friends straight from the server ----------
//
// The invite dialog lists your friends: Invite sends them the server's invite link in
// your DM, where it shows as a card they join with one click.

const invitedFriends = new Set();

function renderInviteFriends() {
  const list = $("invite-friend-list");
  const q = $("invite-friend-search").value.trim().toLowerCase();
  const here = new Set((state.roster?.users ?? []).map((u) => u.public_key));
  const friends = [...(state.friends?.values() ?? [])]
    .filter((f) => f.state === "friend")
    .filter((f) => !q || f.display_name.toLowerCase().includes(q) || (f.username ?? "").toLowerCase().includes(q))
    .sort((a, b) => (a.status === "offline") - (b.status === "offline") || a.display_name.localeCompare(b.display_name));
  const hasFriends = [...(state.friends?.values() ?? [])].some((f) => f.state === "friend");
  $("invite-friend-search").hidden = !hasFriends;
  $("invite-link-label").textContent = hasFriends ? "Or send a server invite link" : "Send a server invite link";
  if (!hasFriends) {
    // No friends yet: one click to add some, then they're one click from joining.
    const empty = el("li", "invite-friend-empty");
    const add = el("button", "btn sm", "Add friend");
    add.type = "button";
    add.addEventListener("click", () => {
      $("invite-dialog").close();
      state.friendTab = "add";
      if (state.activeId) goHome();
      else renderAll();
    });
    empty.append(el("span", "", "Friends you add show up here, ready to invite with one click."), add);
    list.replaceChildren(empty);
    return;
  }
  if (!friends.length) {
    list.replaceChildren(el("li", "invite-friend-empty", "No friends by that name."));
    return;
  }
  list.replaceChildren(
    ...friends.map((f) => {
      const li = el("li", "invite-friend");
      const who = el("span", "invite-friend-who");
      const names = el("span", "invite-friend-names");
      names.append(el("strong", "ellipsis", f.display_name));
      if (f.username) names.append(el("span", "ellipsis", f.username));
      who.append(personAvatar(f, "s40", true), names);
      const btn = el("button", "btn sm");
      btn.type = "button";
      if (here.has(f.key)) {
        btn.textContent = "Joined";
        btn.disabled = true;
      } else if (invitedFriends.has(f.key)) {
        btn.textContent = "Sent";
        btn.disabled = true;
      } else {
        btn.textContent = "Invite";
        btn.classList.add("invite-friend-btn");
        btn.addEventListener("click", () => inviteFriend(f, btn));
      }
      li.append(who, btn);
      return li;
    }),
  );
}

async function inviteFriend(friend, btn) {
  const link = $("invite-link").value;
  if (!link) return toast("The invite link isn't ready yet. Try again in a moment.", true);
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    const sealed = await invoke("dm_seal", { peer: friend.key, text: link });
    await invoke("account_send", { msg: { type: "dm_send", to: friend.key, sealed, nonce: Math.random().toString(36).slice(2) } });
    invitedFriends.add(friend.key);
  } catch (err) {
    toast(friendlyError(err), true);
  }
  renderInviteFriends();
}
$("invite-friend-search").addEventListener("input", renderInviteFriends);

// ---------- YouTube links ----------
//
// A YouTube link gets a card: thumbnail, title and channel. Clicking plays it right
// there (youtube-nocookie.com, which doesn't set tracking cookies until you play).

const youtubeInfo = new Map(); // video id -> Promise of { title, author }
const playingVideos = new Set(); // "message key|video id" playing inline, kept across re-renders

/** The video id in a YouTube link (watch, youtu.be, shorts, embed, live), or null. */
function youtubeId(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, "");
  let id = null;
  if (host === "youtu.be") id = url.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else id = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?#]+)/)?.[1] ?? null;
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/** Where to start: "t=90", "t=1m30s" or "start=90". */
function youtubeStart(link) {
  try {
    const url = new URL(link);
    const t = url.searchParams.get("t") ?? url.searchParams.get("start");
    if (!t) return 0;
    if (/^\d+$/.test(t)) return Number(t);
    const m = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
  } catch {
    return 0;
  }
}

function youtubeEmbeds(text) {
  if (!text) return [];
  const seen = new Set();
  const cards = [];
  for (const [link] of text.matchAll(URL_PATTERN)) {
    const id = youtubeId(link);
    if (!id || seen.has(id) || cards.length >= 2) continue;
    seen.add(id);
    cards.push(youtubeCard(id, youtubeStart(link), link));
  }
  return cards;
}

function youtubeCard(id, start, link) {
  const card = el("div", "yt-card");
  card.dataset.keep = `yt|${id}|${start}`;
  const head = el("div", "yt-head");
  const site = el("span", "yt-site", "YouTube");
  const title = el("a", "yt-title", "YouTube video");
  title.href = link;
  title.addEventListener("click", (e) => {
    e.preventDefault();
    openExternal(link);
  });
  const author = el("span", "yt-author");
  head.append(site, title, author);
  const frame = el("div", "yt-frame");
  const key = id + "|" + start;
  const play = () => {
    playingVideos.add(key);
    const player = el("iframe");
    player.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0${start ? "&start=" + start : ""}`;
    player.title = title.textContent;
    player.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    player.allowFullscreen = true;
    player.referrerPolicy = "strict-origin-when-cross-origin";
    frame.replaceChildren(player);
  };
  if (playingVideos.has(key)) play();
  else {
    const thumb = el("img");
    thumb.src = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    thumb.alt = "";
    thumb.loading = "lazy";
    const button = el("button", "yt-play");
    button.type = "button";
    button.setAttribute("aria-label", "Play video");
    button.append(el("span", "yt-play-icon"));
    button.addEventListener("click", play);
    frame.append(thumb, button);
  }
  card.append(head, frame);
  if (!youtubeInfo.has(id)) youtubeInfo.set(id, invoke("youtube_info", { id }).catch(() => null));
  youtubeInfo.get(id).then((info) => {
    if (!info) return;
    title.textContent = info.title ?? "YouTube video";
    author.textContent = info.author ?? "";
  });
  return card;
}

// ---------- editing and deleting DMs ----------
//
// An edit is sealed again, once for a friend or once per person in a group, and
// replaces the text on everyone's devices. Pictures and GIFs aren't edited.

state.dmEditing = null;

function dmEditable(m) {
  return m.text !== null && !DM_PICTURE.test(m.text) && !FILE_OFFER.test(m.text) && !GIF_URL.test(m.text.trim());
}

function dmActions(peer, m) {
  const actions = el("div", "msg-actions");
  const button = (iconName, tip, onClick, extra = "") => {
    const b = el("button", "icon-btn sm " + extra);
    b.type = "button";
    b.dataset.tip = tip;
    b.append(icon(iconName, "sm"));
    b.addEventListener("click", onClick);
    actions.append(b);
  };
  if (dmEditable(m)) button("edit", "Edit", () => startDmEdit(peer, m));
  button("trash", "Delete message", (e) => deleteDm(peer, m, e.shiftKey), "danger-hover");
  return actions;
}

function startDmEdit(peer, m) {
  state.dmEditing = m.id;
  renderDmView(true);
  requestAnimationFrame(() => {
    const box = document.querySelector(".dm-messages .msg-editor textarea");
    if (!box) return;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  });
}

function stopDmEdit() {
  state.dmEditing = null;
  renderDmView(true);
  $("dm-input")?.focus();
}

function dmEditor(peer, m) {
  const wrap = el("div", "msg-editor");
  const box = el("textarea");
  box.value = m.text;
  box.rows = 1;
  box.maxLength = 2000;
  const fit = () => {
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight}px`;
  };
  setTimeout(fit, 0);
  box.addEventListener("input", fit);
  const save = () => {
    const text = box.value.trim();
    stopDmEdit();
    if (!text) return deleteDm(peer, m);
    if (text !== m.text) saveDmEdit(peer, m, text);
  };
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      stopDmEdit();
    } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      save();
    }
  });
  const hint = el("div", "msg-editor-hint");
  const cancel = el("button", "link", "cancel");
  cancel.type = "button";
  cancel.addEventListener("click", stopDmEdit);
  const ok = el("button", "link", "save");
  ok.type = "button";
  ok.addEventListener("click", save);
  hint.append("Escape to ", cancel, " · Enter to ", ok);
  wrap.append(box, hint);
  return wrap;
}

async function saveDmEdit(peer, m, text) {
  if (await phraseBlocked(text)) return;
  const before = { text: m.text, edited_at: m.edited_at };
  m.text = text;
  m.edited_at = Date.now();
  renderDmView(true);
  try {
    let sealed;
    if (isGroup(peer)) {
      sealed = {};
      for (const k of state.groups.get(peer)?.members ?? []) sealed[k] = await invoke("dm_seal", { peer: k, text });
    } else {
      sealed = await invoke("dm_seal", { peer, text });
    }
    await invoke("account_send", { msg: { type: "dm_edit", with: peer, id: m.id, sealed } });
  } catch (err) {
    Object.assign(m, before);
    renderDmView(true);
    toast(friendlyError(err), true);
  }
}

async function deleteDm(peer, m, skipConfirm) {
  if (!skipConfirm) {
    const ok = await confirmDialog({
      title: "Delete message",
      text: "It's deleted for everyone in this conversation. Tip: hold Shift when clicking delete to skip this.",
      ok: "Delete",
    });
    if (!ok) return;
  }
  invoke("account_send", { msg: { type: "dm_delete", with: peer, id: m.id } }).catch((err) => toast(friendlyError(err), true));
}

// ---------- staying at the bottom ----------
//
// Cards, GIFs and pictures finish loading after a message list is drawn. When you're
// at the bottom, the list stays there as they grow instead of jumping up and back.

function stickToBottom(scroller, list) {
  let atBottom = true;
  scroller.addEventListener("scroll", () => {
    atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  });
  const keep = () => {
    if (atBottom) scroller.scrollTop = scroller.scrollHeight;
  };
  // Placed somewhere on purpose (like the "New" line): stay there.
  scroller.unstick = () => (atBottom = false);
  new ResizeObserver(keep).observe(list);
  // Cards filled in, pictures and GIFs finishing: the same, without waiting for a frame.
  new MutationObserver(keep).observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "src"] });
  list.addEventListener("load", keep, true);
}
stickToBottom($("scroller"), $("messages"));

/** The newest message drawn per channel, so only really new ones animate in. */
var drawnUpTo = new Map();

// ---------- files between friends ----------
//
// A file goes straight from one computer to the other (WebRTC data channel, encrypted
// on the way), never through the cloud. The DM carries only an offer:
// "hopp-file:<transfer id> <size> <name>". When the friend presses Download, the two
// apps shake hands through their accounts (sealed like DMs) and the file streams over.
// The sender's app must still be open with the file; otherwise it says so.

var FILE_OFFER = /^hopp-file:([0-9a-f]{32}) (\d{1,13}) ([^\n]{1,200})$/;
const RISKY_FILE = /\.(exe|msi|msix|appx|appxbundle|bat|cmd|com|scr|pif|cpl|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|jar|lnk|url|reg|dll|sys|inf|iso|img|vhd|vhdx|msc|application|gadget|apk|sh)$/i;
const FILE_MAX = 4 * 1024 ** 3;
const FILE_CHUNK = 64 * 1024;
const FILE_CONNECT_MS = 25_000;
const FILE_ICE = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun.cloudflare.com:3478" }];
state.outgoingFiles = new Map(); // transfer -> { file, peer, status, sent, error, pc }
state.incomingFiles = new Map(); // transfer -> { peer, name, size, status, received, path, error, pc, download }

function transferId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

function offerFile(peer, file) {
  if (!file) return;
  if (isGroup(peer)) return toast("Files go to one friend at a time. Open a DM with them to send it.", true);
  if (!file.size) return toast("That file is empty.", true);
  if (file.size > FILE_MAX) return toast("Files can be up to 4 GB.", true);
  const transfer = transferId();
  state.outgoingFiles.set(transfer, { file, peer, status: "waiting", sent: 0 });
  const name = (file.name || "file").replace(/[\r\n]+/g, " ").slice(0, 200);
  sendDm(peer, { value: `hopp-file:${transfer} ${file.size} ${name}`, style: {} });
}

async function fileSignal(peer, transfer, payload) {
  const sealed = await invoke("dm_seal", { peer, text: JSON.stringify(payload) });
  await invoke("account_send", { msg: { type: "file_signal", to: peer, transfer, sealed } });
}

/** Waits for the connection's addresses to be gathered (or a moment, at most). */
function addressesReady(pc) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((done) => {
    const timer = setTimeout(done, 3000);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timer);
        done();
      }
    });
  });
}

let fileCardTimer = null;
/** Redraws a transfer's cards in place (not the whole conversation), at most ~8 times a second. */
function refreshFileCards(transfer, now) {
  const draw = () => {
    fileCardTimer = null;
    for (const card of document.querySelectorAll(`.file-card[data-transfer="${transfer}"]`)) {
      const fresh = fileCard(card.peer, card.message);
      card.replaceWith(fresh);
    }
  };
  if (now) return draw();
  if (!fileCardTimer) fileCardTimer = setTimeout(draw, 120);
}

function failIncoming(transfer, error) {
  const inc = state.incomingFiles.get(transfer);
  if (!inc || inc.status === "done") return;
  inc.status = "failed";
  inc.error = error;
  inc.pc?.close();
  if (inc.download) invoke("download_cancel", { id: inc.download }).catch(() => {});
  refreshFileCards(transfer, true);
}

function failOutgoing(transfer, error) {
  const out = state.outgoingFiles.get(transfer);
  if (!out || out.status === "sent") return;
  out.status = "failed";
  out.error = error;
  out.pc?.close();
  refreshFileCards(transfer, true);
}

async function onFileSignal(m) {
  const transfer = m.transfer;
  if (m.offline) {
    return failIncoming(transfer, `${personFor(m.from).display_name} isn't online. They need Hopp open to send the file.`);
  }
  let signal;
  try {
    signal = JSON.parse(await invoke("dm_open", { peer: m.from, sealed: m.sealed }));
  } catch {
    return;
  }
  const out = state.outgoingFiles.get(transfer);
  const inc = state.incomingFiles.get(transfer);
  if (signal.kind === "request") {
    if (!out || out.peer !== m.from || out.status === "cancelled") return fileSignal(m.from, transfer, { kind: "gone" }).catch(() => {});
    return startSending(transfer, out);
  }
  if (signal.kind === "answer" && out?.pc && out.peer === m.from) {
    return out.pc.setRemoteDescription({ type: "answer", sdp: String(signal.sdp) }).catch(() => failOutgoing(transfer, "Couldn't connect."));
  }
  if (signal.kind === "offer" && inc && inc.peer === m.from && inc.status === "connecting") return startReceiving(transfer, inc, String(signal.sdp));
  if (signal.kind === "gone" && inc?.peer === m.from) {
    return failIncoming(transfer, `This file isn't available anymore. Ask ${personFor(m.from).display_name} to send it again.`);
  }
  if (signal.kind === "cancel") {
    if (inc?.peer === m.from) failIncoming(transfer, "The transfer was stopped.");
    if (out?.peer === m.from) failOutgoing(transfer, "The transfer was stopped.");
  }
}

// ----- sending -----

async function startSending(transfer, out) {
  out.pc?.close();
  const pc = new RTCPeerConnection({ iceServers: await fileIce() });
  out.pc = pc;
  out.status = "connecting";
  out.sent = 0;
  out.error = null;
  refreshFileCards(transfer, true);
  const channel = pc.createDataChannel("file", { ordered: true });
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = 1024 * 1024;
  const timer = setTimeout(() => {
    if (out.status === "connecting") failOutgoing(transfer, "Couldn't connect directly to your friend.");
  }, FILE_CONNECT_MS);
  channel.addEventListener("open", () => {
    clearTimeout(timer);
    pump(transfer, out, channel);
  });
  channel.addEventListener("message", (e) => {
    if (e.data === "ok") {
      out.status = "sent";
      refreshFileCards(transfer, true);
      setTimeout(() => pc.close(), 500);
    }
  });
  channel.addEventListener("close", () => {
    if (out.status === "sending") failOutgoing(transfer, "The connection was lost.");
  });
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await addressesReady(pc);
    await fileSignal(out.peer, transfer, { kind: "offer", sdp: pc.localDescription.sdp });
  } catch (err) {
    failOutgoing(transfer, friendlyError(err?.message ?? err));
  }
}

async function pump(transfer, out, channel) {
  out.status = "sending";
  const size = out.file.size;
  try {
    while (out.sent < size) {
      if (out.status !== "sending") return;
      if (channel.bufferedAmount > 4 * 1024 * 1024) {
        await new Promise((done) => channel.addEventListener("bufferedamountlow", done, { once: true }));
      }
      const piece = await out.file.slice(out.sent, out.sent + FILE_CHUNK).arrayBuffer();
      channel.send(piece);
      out.sent += piece.byteLength;
      refreshFileCards(transfer);
    }
    channel.send("done");
  } catch (err) {
    failOutgoing(transfer, "The connection was lost.");
  }
}

// ----- receiving -----

async function downloadFile(transfer, peer, name, size) {
  if (RISKY_FILE.test(name)) {
    const who = personFor(peer).display_name;
    const ok = await confirmDialog({
      title: "This is a program",
      text: `${name} can run code on your computer. Only download it if you trust ${who} and were expecting it. Windows will ask again before it runs.`,
      ok: "Download anyway",
    });
    if (!ok) return;
  }
  const inc = { peer, name, size, status: "connecting", received: 0 };
  state.incomingFiles.set(transfer, inc);
  refreshFileCards(transfer, true);
  setTimeout(() => {
    if (inc.status === "connecting") failIncoming(transfer, `Couldn't reach ${personFor(peer).display_name}. They need to be online with Hopp open.`);
  }, FILE_CONNECT_MS);
  fileSignal(peer, transfer, { kind: "request" }).catch((err) => failIncoming(transfer, friendlyError(err)));
}

async function startReceiving(transfer, inc, sdp) {
  const pc = new RTCPeerConnection({ iceServers: await fileIce() });
  inc.pc = pc;
  pc.addEventListener("datachannel", (e) => receive(transfer, inc, e.channel));
  try {
    await pc.setRemoteDescription({ type: "offer", sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await addressesReady(pc);
    await fileSignal(inc.peer, transfer, { kind: "answer", sdp: pc.localDescription.sdp });
  } catch (err) {
    failIncoming(transfer, "Couldn't connect directly to your friend.");
  }
}

function receive(transfer, inc, channel) {
  channel.binaryType = "arraybuffer";
  let writing = Promise.resolve();
  let started = null;
  // The channel may already be open when it arrives.
  const begin = () => {
    if (started) return;
    inc.status = "receiving";
    started = invoke("download_start", { name: inc.name }).then((d) => {
      inc.download = d.id;
      inc.path = d.path;
      return d.id;
    });
    writing = started;
    refreshFileCards(transfer, true);
  };
  if (channel.readyState === "open") begin();
  channel.addEventListener("open", begin);
  channel.addEventListener("message", (e) => {
    begin();
    if (typeof e.data === "string") {
      if (e.data !== "done") return;
      writing
        .then(async () => {
          if (inc.received !== inc.size) throw new Error("incomplete");
          inc.path = await invoke("download_finish", { id: inc.download });
          inc.download = null;
          inc.status = "done";
          channel.send("ok");
          refreshFileCards(transfer, true);
        })
        .catch(() => failIncoming(transfer, "The file didn't arrive whole. Try again."));
      return;
    }
    const piece = new Uint8Array(e.data);
    inc.received += piece.byteLength;
    if (inc.received > inc.size) return failIncoming(transfer, "The file was bigger than announced, so it was stopped.");
    writing = writing.then((id) => invoke("download_chunk", piece, { headers: { "x-download": inc.download ?? id } }).then(() => id));
    writing.catch((err) => failIncoming(transfer, friendlyError(err)));
    refreshFileCards(transfer);
  });
  channel.addEventListener("close", () => {
    if (inc.status === "receiving") failIncoming(transfer, "The connection was lost.");
  });
}

// ----- the card -----

function fileCard(peer, m) {
  const [, transfer, sizeText, name] = m.text.match(FILE_OFFER);
  const size = Number(sizeText);
  const mine = m.from_key === state.me?.key;
  const card = el("div", "file-card");
  card.dataset.transfer = transfer;
  card.peer = peer;
  card.message = m;
  const risky = RISKY_FILE.test(name);
  const badge = el("span", "file-icon" + (risky ? " risky" : ""));
  badge.append(icon(risky ? "shield" : "download"));
  const info = el("div", "file-info");
  const title = el("strong", "ellipsis", name);
  title.title = name;
  const sub = el("span", "file-sub");
  info.append(title, sub);
  const action = el("div", "file-action");
  card.append(badge, info, action);
  const bar = (done) => {
    const b = el("div", "file-bar");
    const fill = el("span");
    fill.style.width = `${Math.min(100, Math.round((done / size) * 100))}%`;
    b.append(fill);
    info.append(b);
  };
  const button = (label, onClick, extra = "") => {
    const b = el("button", "btn sm " + extra, label);
    b.type = "button";
    b.addEventListener("click", onClick);
    action.append(b);
  };
  const who = personFor(peer).display_name;
  if (mine) {
    const out = state.outgoingFiles.get(transfer);
    if (!out) sub.textContent = `${formatSize(size)} · No longer available from this computer`;
    else if (out.status === "waiting") {
      sub.textContent = `${formatSize(size)} · Waiting for ${who} to download. Keep Hopp open.`;
      button("Cancel", () => {
        out.status = "cancelled";
        refreshFileCards(transfer, true);
      });
    } else if (out.status === "connecting") sub.textContent = `Connecting to ${who}…`;
    else if (out.status === "sending") {
      sub.textContent = `Sending · ${formatSize(out.sent)} of ${formatSize(size)}`;
      bar(out.sent);
      button("Stop", () => {
        fileSignal(peer, transfer, { kind: "cancel" }).catch(() => {});
        failOutgoing(transfer, "You stopped the transfer.");
      });
    } else if (out.status === "sent") sub.textContent = `${formatSize(size)} · Sent`;
    else if (out.status === "cancelled") sub.textContent = `${formatSize(size)} · Cancelled`;
    else sub.textContent = out.error || "Couldn't send.";
    return card;
  }
  const inc = state.incomingFiles.get(transfer);
  if (!inc) {
    sub.textContent = risky ? `${formatSize(size)} · A program: only open it if you trust ${who}` : formatSize(size);
    button("Download", () => downloadFile(transfer, peer, name, size), "primary");
  } else if (inc.status === "connecting") {
    sub.textContent = `Connecting to ${who}…`;
  } else if (inc.status === "receiving") {
    sub.textContent = `Downloading · ${formatSize(inc.received)} of ${formatSize(size)}`;
    bar(inc.received);
    button("Stop", () => {
      fileSignal(peer, transfer, { kind: "cancel" }).catch(() => {});
      failIncoming(transfer, "You stopped the download.");
    });
  } else if (inc.status === "done") {
    sub.textContent = `${formatSize(size)} · Saved to Downloads`;
    button("Show in folder", () => invoke("show_download", { path: inc.path }).catch((err) => toast(friendlyError(err), true)));
  } else {
    sub.textContent = inc.error || "Couldn't download.";
    button("Try again", () => {
      state.incomingFiles.delete(transfer);
      downloadFile(transfer, peer, name, size);
    });
  }
  return card;
}

// ---------- the voice relay ----------
//
// When someone can't be reached directly, the voice engine asks for a relay. The
// account fetches a day-long login for Cloudflare's TURN relay and the engines use it
// only for the people no direct path reaches. Voice stays end-to-end encrypted.

var relayState = { login: null, waiting: false, unavailable: false };

function useRelay() {
  if (relayState.login) return invoke("set_relay", { login: relayState.login }).catch(() => {});
  if (relayState.waiting || !state.accountConnected) return;
  relayState.waiting = true;
  invoke("account_send", { msg: { type: "turn_login" } }).catch(() => (relayState.waiting = false));
}

function onRelayLogin(m) {
  relayState.waiting = false;
  const waiters = relayState.waiters ?? [];
  relayState.waiters = [];
  if (m.type === "error") {
    relayState.unavailable = true;
    for (const done of waiters) done(null);
    return;
  }
  for (const done of waiters) done(m.login);
  relayState.login = m.login;
  relayState.unavailable = false;
  invoke("set_relay", { login: m.login }).catch(() => {});
  // A day-long login: forget it well before, so a fresh one is fetched next time.
  setTimeout(() => (relayState.login = null), 2 * 3600 * 1000);
}

/** Opens a server (instantly if already connected) and then does something there. */
async function onServer(server, then) {
  if (await connectTo(server)) then();
}

// ---------- right-click on a person ----------

function openUserMenu(u, row, e) {
  e.preventDefault();
  e.stopPropagation();
  const key = keyOf(u);
  const isSelf = u.session_id === state.roster?.me;
  const friend = key ? state.friends?.get(key) : null;
  const vol = userVolume(u) ?? 100;
  const items = [{ label: "Profile", icon: "user", action: () => openUserCard(u, row) }];
  if (!isSelf) {
    items.push({ label: "Mention", icon: "at", action: () => mentionUser(u) });
    if (friend?.state === "friend") {
      items.push({ label: "Message", icon: "message", action: () => openDm(key) });
      items.push({ label: "Call", icon: "phone", action: () => {
        openDm(key);
        startCall(key);
      } });
    } else if (key && friend?.state !== "blocked" && friend?.state !== "outgoing") {
      items.push({ label: friend?.state === "incoming" ? "Accept friend request" : "Add friend", icon: "user-plus", action: () => {
        if (friend?.state === "incoming") accountSend({ type: "friend_accept", key }).catch(() => {});
        else accountSend({ type: "friend_request", key }).then(() => toast(`Friend request sent to ${u.name}.`), () => {});
      } });
    }
    items.push("sep", { label: vol === 0 ? "Unmute for me" : "Mute for me", icon: vol === 0 ? "volume" : "mic-off", action: () => {
      cardUser = u;
      setUserVolume(vol === 0 ? 100 : 0);
    } });
    if (can("moderate") && outranks(u)) {
      items.push("sep");
      items.push({ label: `Kick ${u.name}`, icon: "logout", danger: true, action: () => {
        cardUser = u;
        removeUser(false);
      } });
      if (can("manage")) items.push({ label: `Ban ${u.name}`, icon: "ban", danger: true, action: () => {
        cardUser = u;
        removeUser(true);
      } });
    }
  }
  openMenu(items, e.clientX, e.clientY);
}

/** Puts "@name " in the message box, as picking them from the @ list would. */
function mentionUser(u) {
  const key = keyOf(u);
  const label = `@${u.name}`;
  const v = chatInput.value;
  chatInput.value = v + (v && !v.endsWith(" ") ? " " : "") + label + " ";
  if (key) composeMentions.set(label, key);
  autosize();
  chatInput.focus();
  chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
}

// ---------- redrawing lists without disturbing them ----------

/**
 * Puts `items` into `list`, keeping existing rows whose key and signature match
 * (data-key, data-sig) exactly where they are. Untouched rows aren't moved or
 * rebuilt, so a playing video, a half-loaded picture or a hover stays as it is.
 */
function reconcile(list, items) {
  const old = new Map();
  for (const node of list.children) if (node.dataset.key) old.set(node.dataset.key, node);
  const wanted = items.map((node) => {
    const kept = node.dataset.key ? old.get(node.dataset.key) : null;
    if (!kept) return node;
    // Changed (a reaction, an edit): updated in place, keeping what's loaded inside it.
    if (kept.dataset.sig !== node.dataset.sig) morph(kept, node);
    return kept;
  });
  place(list, wanted);
}

/** Puts `nodes` into `parent` in order, moving as little as possible (moving reloads videos). */
function place(parent, nodes) {
  const keep = new Set(nodes);
  for (const node of [...parent.childNodes]) if (!keep.has(node)) node.remove();
  let cursor = parent.firstChild;
  for (const node of nodes) {
    if (node === cursor) {
      cursor = cursor.nextSibling;
      continue;
    }
    parent.insertBefore(node, cursor);
  }
}

/**
 * Turns `old` into `fresh` in place: its attributes and content become fresh's, except
 * children marked data-keep (a video, a picture, an invite card) that exist in both,
 * which stay exactly where they are.
 */
function morph(old, fresh) {
  for (const a of [...old.attributes]) if (!fresh.hasAttribute(a.name)) old.removeAttribute(a.name);
  for (const a of fresh.attributes) if (old.getAttribute(a.name) !== a.value) old.setAttribute(a.name, a.value);
  old.msg = fresh.msg;
  const kept = new Map();
  for (const child of old.children) if (child.dataset.keep) kept.set(child.dataset.keep, child);
  place(old, [...fresh.childNodes].map((child) => (child.dataset?.keep && kept.get(child.dataset.keep)) || child));
}

// ---------- a chat that flows ----------

/** Start typing anywhere: the letters go into the message box. */
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || e.isComposing) return;
  const t = e.target;
  if (t.closest?.("input, textarea, select, [contenteditable]") || document.querySelector("dialog[open]")) return;
  // A space on a focused button presses the button.
  if (e.key === " " && t.closest?.("button, a, [role=button], summary")) return;
  const box = online() ? (state.view !== null && !$("composer").hidden ? chatInput : null) : $("dm-input");
  if (box && box.offsetParent !== null) box.focus();
});

/** Alt+↑/↓: previous or next channel. Alt+Shift+↑/↓: the previous or next one with something new. */
document.addEventListener("keydown", (e) => {
  if (!e.altKey || e.ctrlKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown") || !online()) return;
  const list = textChannels();
  const at = list.findIndex((c) => c.id === state.view);
  if (at < 0) return;
  e.preventDefault();
  const step = e.key === "ArrowDown" ? 1 : -1;
  const address = activeServer()?.address;
  for (let i = 1; i <= list.length; i++) {
    const ch = list[(at + step * i + list.length * i) % list.length];
    if (!e.shiftKey || channelUnread(address, ch.id) || channelMentions(address, ch.id)) return openTextChannel(ch.id);
    if (!e.shiftKey) return;
  }
});

/** The three reactions you use most, offered on hover. */
function quickReactions() {
  const recent = recentEmoji();
  return [...recent, "👍", "😂", "❤️"].filter((e, i, all) => all.indexOf(e) === i).slice(0, 3);
}

/** Back to the newest message, everything read. */
function catchUp() {
  state.unreadHold = null;
  const scroller = $("scroller");
  scroller.scrollTop = scroller.scrollHeight;
  markViewedRead();
  updateJumpBar();
}

/** "Mark unread": this message and everything after it are new again. */
function markUnreadFrom(m) {
  const address = activeServer()?.address;
  if (!address) return;
  const k = readKey(address, m.channel);
  const cur = state.reads.get(k) ?? { server: address, channel: m.channel, read_id: 0, last_id: 0, mentions: 0 };
  cur.read_id = m.id - 1;
  cur.last_id = Math.max(cur.last_id, m.id);
  state.reads.set(k, cur);
  state.unreadHold = { address, channel: m.channel };
  state.newSince = { channel: m.channel, id: m.id - 1 };
  invoke("account_send", { msg: { type: "channel_read", server: address, channel: m.channel, id: m.id - 1, unread: true } }).catch(() => {});
  renderUnread();
  renderMessages(true);
  toast("Marked unread. It stays that way until you come back to the channel.");
}

let emojiIndex = null;
/** Emoji whose name starts with what you typed after ":". */
function emojiCandidates(q) {
  if (!emojiIndex) {
    emojiIndex = [];
    for (const [, list] of EMOJI_GROUPS) {
      for (const entry of list.split("|")) {
        const [emoji, ...words] = entry.split(" ");
        emojiIndex.push({ emoji, words, name: words[0] ?? "" });
      }
    }
  }
  const query = q.toLowerCase();
  // Names that start with it first (:fir is 🔥 "fire"), then other words that do.
  const rank = (e) => (e.name.startsWith(query) ? 0 : 1);
  return emojiIndex
    .filter((e) => e.words.some((w) => w.startsWith(query)))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 8)
    .map((e) => ({ ...e, key: `emoji:${e.emoji}` }));
}

// ---------- moving through a conversation quickly ----------

/** The message list on screen: the channel's, or the open DM's. */
function activeScroller() {
  if (online()) return $("scroller");
  return document.querySelector(".dm-view .dm-scroll");
}

/** Down to the newest message, smoothly, landing exactly at the bottom. */
function toBottom(scroller) {
  if (!scroller) return;
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  setTimeout(() => {
    scroller.scrollTop = scroller.scrollHeight;
    scroller.dispatchEvent(new Event("scroll"));
    if (online()) {
      updateJumpBar();
      markViewedRead();
    }
  }, 450);
}

/**
 * Page Up / Page Down page through the conversation (even while writing),
 * Ctrl+End goes to the newest message and Ctrl+Home to the oldest loaded one,
 * Escape in an empty DM box catches up.
 */
document.addEventListener("keydown", (e) => {
  const scroller = activeScroller();
  if (!scroller || document.querySelector("dialog[open]")) return;
  const inOtherField = e.target.closest?.("input, select") || (e.target.tagName === "TEXTAREA" && e.target !== chatInput && e.target.id !== "dm-input");
  if (inOtherField) return;
  if ((e.key === "PageUp" || e.key === "PageDown") && !e.altKey) {
    e.preventDefault();
    scroller.scrollBy({ top: (e.key === "PageUp" ? -1 : 1) * scroller.clientHeight * 0.85, behavior: "auto" });
  } else if (e.ctrlKey && e.key === "End") {
    e.preventDefault();
    toBottom(scroller);
  } else if (e.ctrlKey && e.key === "Home") {
    e.preventDefault();
    scroller.scrollTop = 0;
  } else if (e.key === "Escape" && e.target.id === "dm-input" && !e.target.value) {
    toBottom(scroller);
  }
});

/** Someone's own volume (0–200), by Hopp ID; older settings were kept by name. */
function userVolume(u) {
  const id = keyOf(u);
  return (id && prefs.userVolumes[id]) ?? prefs.userVolumes[u.name];
}

/** The relay login, fetching one if needed; null if there's none within a few seconds. */
function relayLogin() {
  if (relayState.login) return Promise.resolve(relayState.login);
  if (relayState.unavailable || !state.accountConnected) return Promise.resolve(null);
  return new Promise((resolve) => {
    relayState.waiters = [...(relayState.waiters ?? []), resolve];
    if (!relayState.waiting) {
      relayState.waiting = true;
      invoke("account_send", { msg: { type: "turn_login" } }).catch(() => (relayState.waiting = false));
    }
    setTimeout(() => resolve(relayState.login), 4000);
  });
}

/** Where a file connection may go: straight across, or through the relay when that's blocked. */
async function fileIce() {
  const login = await relayLogin();
  if (!login) return FILE_ICE;
  return [...FILE_ICE, { urls: [`turn:${login.server}?transport=udp`, `turn:${login.server}?transport=tcp`], username: login.username, credential: login.credential }];
}

/** Three small signal bars: all lit when good, two when okay, one when weak. */
function signalBars(grade) {
  const lit = grade === "good" ? 3 : grade === "fair" ? 2 : 1;
  const wrap = el("span", `signal-bars ${grade}`);
  for (let i = 1; i <= 3; i++) wrap.append(el("i", i <= lit ? "on" : ""));
  return wrap;
}

// ---------- protecting accounts ----------
//
// Accounts are taken over by talking people into giving away their recovery phrase, and
// by "free gift" links sent from friends whose accounts were already taken.

/** Stops a message that would give away a recovery phrase. True when it mustn't be sent. */
async function phraseBlocked(text) {
  // A phrase is twelve words or more; shorter messages can't be one (and skip the check).
  if ((text.match(/[a-z]+/gi) ?? []).length < 6) return false;
  const leak = await invoke("phrase_leak", { text }).catch(() => null);
  if (leak === "mine") {
    await confirmDialog({
      title: "That's your recovery phrase",
      text: "Anyone who has these words owns your Hopp ID: your friends, servers and messages. Nobody ever needs them, not a friend, not a server owner, not Hopp. The message wasn't sent.",
      ok: "Got it",
      cancel: null,
      danger: false,
    });
    return true;
  }
  if (leak === "phrase") {
    const go = await confirmDialog({
      title: "This looks like a recovery phrase",
      text: "Whoever gets a recovery phrase can take over that account. If someone asked you for one, it's a scam. Send it anyway?",
      ok: "Send anyway",
      cancel: "Don't send",
    });
    return !go;
  }
  return false;
}

/** "Free gift" bait with a link: the usual way accounts get stolen, often from a friend's taken account. */
var BAIT = /\b(free|gift(ed)?|giveaway|nitro|airdrop|claim|robux|v-?bucks|crypto|nft|prize)\b/i;

function looksLikeBait(text, fromMe) {
  return !fromMe && /https?:\/\//i.test(text) && BAIT.test(text);
}

/** The quiet warning under such a message. */
function baitWarning() {
  const note = el("div", "bait-warning");
  note.append(icon("shield", "xs"), el("span", "", "Careful: links promising free stuff are how accounts get stolen, even when they come from a friend."));
  return note;
}

// ---------- search ----------
//
// The field sits in the header, always there; results open in a panel on the right.
// Servers search their own history (they keep it anyway). Direct messages are encrypted,
// so a conversation is searched here, on this computer, after loading the rest of it.

/** The search under way: what was asked and where (a conversation, or this server). */
var searching = null;

function searchWhere(input) {
  return input.id === "dm-search-input" ? { dm: state.openDm } : { server: state.activeId };
}

/** Opens the results panel beside the chat or the conversation. */
function showSearchPanel(where) {
  const panel = $("search-panel");
  const host = where.dm ? $("home-body") : document.querySelector(".channel-body");
  if (panel.parentElement !== host) host.append(panel);
  panel.hidden = false;
  document.querySelector(".channel-body").classList.toggle("searching", !where.dm);
}

function closeSearch(clear = true) {
  searching = null;
  $("search-panel").hidden = true;
  document.querySelector(".channel-body").classList.remove("searching");
  if (clear) $("search-input").value = $("dm-search-input").value = "";
}

for (const input of [$("search-input"), $("dm-search-input")]) {
  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    if (!input.value.trim()) return closeSearch(false);
    timer = setTimeout(() => runSearch(input.value, searchWhere(input)), 350);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(timer);
      if (input.value.trim()) runSearch(input.value, searchWhere(input));
    } else if (e.key === "Escape") {
      e.stopPropagation();
      closeSearch();
      input.blur();
    }
  });
}
$("search-close").addEventListener("click", () => closeSearch());

function searchStatus(text, items = []) {
  $("search-count").textContent = text;
  $("search-results").replaceChildren(...items);
}

async function runSearch(query, where) {
  const needle = query.trim().toLowerCase();
  showSearchPanel(where);
  if (needle.length < 2) {
    searching = null;
    return searchStatus("Type at least two letters");
  }
  const mine = { query, where };
  searching = mine;
  searchStatus("Searching…");
  if (where.dm) {
    const found = await searchConversation(where.dm, needle);
    if (searching === mine) showResults(mine, found);
    return;
  }
  if (!state.roster?.features?.includes("search")) return searchStatus("This server needs an update before it can be searched");
  invoke("search_messages", { query }).catch((err) => searching === mine && searchStatus(friendlyError(err)));
  setTimeout(() => {
    if (searching === mine && !mine.done) searchStatus("The server didn't answer. Try again in a moment.");
  }, 6000);
}

listen("search-results", (e) => {
  const s = searching;
  if (!s || s.where.dm || s.where.server !== state.activeId || e.payload.query !== s.query) return;
  showResults(s, e.payload.messages);
});

/** A conversation's messages containing the words, newest first, after loading what's older. */
async function searchConversation(peer, needle) {
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let page = 0; page < 20 && !state.dmComplete.has(peer); page++) {
    const list = state.dmMessages.get(peer) ?? [];
    const first = list.find((m) => !m.pending);
    if (!first) break;
    const had = list.length;
    invoke("account_send", { msg: { type: "dm_history", with: peer, before: first.sent_at } }).catch(() => {});
    for (let t = 0; t < 30 && (state.dmMessages.get(peer)?.length ?? 0) === had && !state.dmComplete.has(peer); t++) await pause(100);
    if ((state.dmMessages.get(peer)?.length ?? 0) === had) break;
  }
  return (state.dmMessages.get(peer) ?? [])
    .filter((m) => m.text && !m.pending && previewText(m.text).toLowerCase().includes(needle))
    .reverse()
    .slice(0, 25);
}

function showResults(s, messages) {
  s.done = true;
  const needle = s.query.trim().toLowerCase();
  if (!messages.length) return searchStatus("Nothing found");
  const items = messages.map((m) => {
    const dm = s.where.dm;
    const name = dm ? personFor(m.from_key).display_name : m.sender_name;
    const picture = dm ? personFor(m.from_key).avatar : pictureFor(m.author_key);
    const item = el("button", "search-item");
    item.type = "button";
    const head = el("div", "pin-head");
    head.append(avatar(name, "s24", undefined, picture), el("strong", "ellipsis", name));
    if (!dm) head.append(el("span", "search-where", "#" + channelName(m.channel)));
    head.append(el("span", "pin-date", dayLabel(m.sent_at)));
    item.append(head, highlighted(previewText(m.text), needle));
    item.addEventListener("click", () => {
      // The results stay, so the next one is a click away.
      document.querySelectorAll(".search-item.active").forEach((n) => n.classList.remove("active"));
      item.classList.add("active");
      if (dm) return jumpToDm(dm, m.id);
      openTextChannel(m.channel);
      jumpToMessage(m.id);
    });
    return item;
  });
  searchStatus(messages.length === 1 ? "1 result" : messages.length + " results", items);
}

/** Text with every match of the words marked. */
function highlighted(text, needle) {
  const out = el("div", "pin-text");
  const lower = text.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(needle); needle && i >= 0; i = lower.indexOf(needle, at)) {
    out.append(text.slice(at, i), el("mark", "", text.slice(i, i + needle.length)));
    at = i + needle.length;
  }
  out.append(text.slice(at));
  return out;
}

/** Scrolls a conversation to one of its messages and lights it up briefly. */
function jumpToDm(peer, id) {
  if (state.openDm !== peer) openDm(peer);
  requestAnimationFrame(() => {
    const node = document.querySelector('li[data-key="' + peer + "|" + id + '"]');
    if (!node) return toast("That message has been deleted.");
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    node.classList.remove("flash");
    void node.offsetWidth;
    node.classList.add("flash");
  });
}

// ---------- themes ----------
//
// Every colour in Hopp comes from a handful of surface, border and text shades. A theme is
// one colour: Hopp builds those shades around it, as a dark theme or, for a light colour,
// a light one. "Mid grey" is the stylesheet itself.

var THEMES = [
  { id: "mid", name: "Mid grey", base: "#3c3c42" },
  { id: "dark", name: "Dark", base: "#2a2a2e" },
  { id: "midnight", name: "Midnight", base: "#2b3140" },
  { id: "light", name: "Light grey", base: "#f2f2f4" },
];

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}

/** The whole set of shades for a theme built around one colour. */
function themeTokens(base) {
  const [h, sRaw, picked] = hexToHsl(base);
  // Light picks make a light theme, others a dark one, each kept in a range where text reads well.
  const l = picked > 60 ? Math.min(97, Math.max(88, picked)) : Math.min(30, Math.max(14, picked));
  // Surfaces stay calm: even a bright pick becomes a gentle tint.
  const s = Math.min(sRaw, 22);
  const at = (dl, sat = s) => "hsl(" + h.toFixed(1) + " " + sat.toFixed(1) + "% " + Math.max(0, Math.min(100, l + dl)).toFixed(1) + "%)";
  const tint = (lightness, sat = Math.min(s, 10)) => "hsl(" + h.toFixed(1) + " " + sat.toFixed(1) + "% " + lightness + "%)";
  if (picked > 60) {
    // Light: what's further back is a little darker; text is near-black.
    return {
      frame: at(-9), "side-2": at(-6), side: at(-4), main: at(0), elev: at(-7), "elev-2": at(-11), "elev-3": at(-15), deep: at(-5),
      border: at(-11), "border-strong": at(-17), "border-active": at(-25), "border-focus": at(-32), "focus-ring": at(-35),
      hover: "rgb(0 0 0 / 0.05)", active: "rgb(0 0 0 / 0.08)", "msg-hover": "rgb(0 0 0 / 0.03)",
      text: tint(12), "text-2": tint(22), muted: tint(38), faint: tint(53),
      link: "#1a63d6", "primary-hover": tint(25), "name-s": "38%", "name-l": "34%", green: "#1f9d63", yellow: "#b7791f", red: "#d93a40", scheme: "light",
    };
  }
  return {
    frame: at(-6.7), "side-2": at(-3.9), side: at(-2.1), main: at(0), elev: at(4.3), "elev-2": at(8.2), "elev-3": at(12.4), deep: at(-7.8),
    border: at(4.3), "border-strong": at(10.4), "border-active": at(16.3), "border-focus": at(20.4), "focus-ring": at(21.5),
    hover: "rgb(255 255 255 / 0.05)", active: "rgb(255 255 255 / 0.09)", "msg-hover": "rgb(0 0 0 / 0.06)",
    text: tint(95), "text-2": tint(86), muted: tint(71), faint: tint(57),
    link: "#8ab4f8", "primary-hover": "#ffffff", "name-s": "22%", "name-l": "80%", green: "#3ccf8e", yellow: "#f0b232", red: "#f2555a", scheme: "dark",
  };
}

var THEME_KEYS = Object.keys(themeTokens("#3c3c42"));

/** The chosen theme's colour: a preset's, or your own. */
function themeColor() {
  if (prefs.theme === "custom") return prefs.themeColor;
  return THEMES.find((t) => t.id === prefs.theme)?.base ?? THEMES[0].base;
}

function applyTheme() {
  const root = document.documentElement.style;
  for (const k of THEME_KEYS) root.removeProperty(k === "scheme" ? "color-scheme" : "--" + k);
  // Mid grey is the stylesheet's own colours.
  if (prefs.theme === "mid" || !prefs.theme) return;
  const t = themeTokens(themeColor());
  for (const [k, v] of Object.entries(t)) root.setProperty(k === "scheme" ? "color-scheme" : "--" + k, v);
}

function setTheme(id, color) {
  prefs.theme = id;
  save("theme", id);
  if (color) {
    prefs.themeColor = color;
    save("themeColor", color);
  }
  applyTheme();
  renderThemes();
}

/** The theme cards in Settings: a small picture of each, and your own colour last. */
function renderThemes() {
  const list = $("theme-list");
  if (!list) return;
  const card = (id, name, base, extra) => {
    const t = themeTokens(base);
    const b = el("button", "theme-card" + (prefs.theme === id ? " active" : ""));
    b.type = "button";
    b.dataset.theme = id;
    const pic = el("span", "theme-pic");
    pic.style.background = t.frame;
    const side = el("span", "theme-pic-side");
    side.style.background = t["side-2"];
    const main = el("span", "theme-pic-main");
    main.style.background = t.main;
    for (const w of [70, 45]) {
      const line = el("i");
      line.style.width = w + "%";
      line.style.background = t.faint;
      main.append(line);
    }
    pic.append(side, main);
    b.append(pic, el("span", "theme-name", name));
    if (extra) b.append(extra);
    b.addEventListener("click", (e) => {
      if (e.target.closest("input")) return;
      setTheme(id);
    });
    return b;
  };
  const picker = el("input", "theme-color");
  picker.type = "color";
  picker.value = prefs.themeColor;
  picker.dataset.tip = "Pick your colour";
  picker.addEventListener("input", () => setTheme("custom", picker.value));
  list.replaceChildren(...THEMES.map((t) => card(t.id, t.name, t.base)), card("custom", "Your own", prefs.themeColor, picker));
}

prefs.theme = load("theme", "mid");
prefs.themeColor = load("themeColor", "#3b4a46");
applyTheme();
renderThemes();

// ---------- settings: you at the top, and the smaller pages ----------

function renderSettingsMe() {
  const name = state.account?.name ?? state.me?.display_name ?? "You";
  $("settings-me-avatar").replaceChildren(avatar(name, "s40", undefined, state.me?.avatar ?? null));
  $("settings-me-name").textContent = name;
  const label = prefs.pttLabel;
  $("keys-ptt").replaceChildren(...(label ? label.split("+").map((k) => el("kbd", "", k.trim())) : [el("span", "muted", "Not set")]));
}
$("settings-me").addEventListener("click", () => showTab("profile"));
$("keys-ptt-change").addEventListener("click", () => showTab("voice"));
$("privacy-blocked").addEventListener("click", () => {
  $("settings").close();
  goHomeTab("blocked");
});

/** Home, on one of the friends tabs. */
function goHomeTab(tab) {
  document.getElementById("home-btn")?.click();
  requestAnimationFrame(() => document.querySelector('.friend-tab[data-ftab="' + tab + '"]')?.click());
}

prefs.desktopNotify = load("desktopNotify", "1") === "1";
prefs.notifyText = load("notifyText", "1") === "1";
$("desktop-notify").checked = prefs.desktopNotify;
$("notify-text").checked = prefs.notifyText;
$("notify-text").disabled = !prefs.desktopNotify;
$("desktop-notify").addEventListener("change", (e) => {
  prefs.desktopNotify = e.target.checked;
  save("desktopNotify", e.target.checked ? "1" : "0");
  $("notify-text").disabled = !e.target.checked;
});
$("notify-text").addEventListener("change", (e) => {
  prefs.notifyText = e.target.checked;
  save("notifyText", e.target.checked ? "1" : "0");
});

// ---------- screen sharing ----------
//
// Video goes straight between the one sharing and each viewer (WebRTC, encrypted on the way),
// through the relay when a network blocks that; the server only passes the handshake along,
// and only within a voice channel. One screen to watch at a time.

/** Our own share: the screen, and a connection per viewer. */
var screenShare = { stream: null, peers: new Map() };
/** The screen we watch: whose, its connection, and handshake bits that came early. */
var watching = null;

function screenSend(to, msg) {
  return invoke("screen_signal", { to, data: JSON.stringify(msg) }).catch(() => {});
}

function canShare() {
  return connected() && myVoice() !== null && !!state.roster?.features?.includes("screen");
}

async function startShare() {
  if (!canShare() || screenShare.stream) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 60 }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
  } catch (err) {
    // Closing the picker isn't an error.
    if (err?.name !== "NotAllowedError" && err?.name !== "AbortError") toast("Couldn't share your screen. " + (err?.message ?? ""), true);
    return;
  }
  const track = stream.getVideoTracks()[0];
  if (!track || !canShare()) return stream.getTracks().forEach((t) => t.stop());
  // Text and windows stay sharp; motion gives way first.
  track.contentHint = "detail";
  // Windows' own "Stop sharing" ends it too.
  track.addEventListener("ended", () => stopShare());
  screenShare.stream = stream;
  call("set_sharing", { on: true });
  renderVoicePanel();
}

function stopShare(quiet = false) {
  if (!screenShare.stream) return;
  for (const [viewer, pc] of screenShare.peers) {
    if (!quiet) screenSend(viewer, { k: "stop", s: "viewer" });
    pc.close();
  }
  screenShare.peers.clear();
  screenShare.stream.getTracks().forEach((t) => t.stop());
  screenShare.stream = null;
  if (!quiet && connected()) call("set_sharing", { on: false });
  renderVoicePanel();
}

/** Someone asked to watch: a connection carrying our screen to them. */
async function serveViewer(viewer) {
  screenShare.peers.get(viewer)?.close();
  const pc = new RTCPeerConnection({ iceServers: await fileIce() });
  if (!screenShare.stream) return pc.close();
  pc.pendingIce = [];
  screenShare.peers.set(viewer, pc);
  pc.onicecandidate = (e) => e.candidate && screenSend(viewer, { k: "ice", s: "viewer", c: e.candidate.toJSON() });
  pc.onconnectionstatechange = () => {
    if ((pc.connectionState === "failed" || pc.connectionState === "closed") && screenShare.peers.get(viewer) === pc) screenShare.peers.delete(viewer);
  };
  const track = screenShare.stream.getVideoTracks()[0];
  pc.addTrack(track, screenShare.stream);
  await pc.setLocalDescription(await pc.createOffer());
  screenSend(viewer, { k: "offer", s: "viewer", sdp: pc.localDescription.sdp });
}

/** High quality: up to 6 Mbit/s, and sharp text before smooth motion. */
function tuneScreenSender(pc) {
  for (const sender of pc.getSenders()) {
    const p = sender.getParameters();
    if (!p.encodings?.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = 6_000_000;
    p.degradationPreference = "maintain-resolution";
    sender.setParameters(p).catch(() => {});
  }
}

function watchScreen(session) {
  if (watching?.from === session) return;
  stopWatching();
  const w = { from: session, pc: null, pending: [] };
  watching = w;
  renderScreenStage();
  renderSidebar();
  screenSend(session, { k: "watch", s: "sharer" });
  setTimeout(() => {
    if (watching === w && !w.pc) {
      toast("Couldn't reach their screen. Try again in a moment.", true);
      stopWatching();
    }
  }, 10_000);
}

function stopWatching(tell = true) {
  if (!watching) return;
  if (tell) screenSend(watching.from, { k: "stop", s: "sharer" });
  watching.pc?.close();
  watching = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  renderScreenStage();
  renderSidebar();
}

listen("screen-signal", async (e) => {
  const from = e.payload.from;
  let m;
  try {
    m = JSON.parse(e.payload.data);
  } catch {
    return;
  }
  if (m.s === "sharer") {
    // To us, as the one sharing.
    if (!screenShare.stream) return;
    if (m.k === "watch") return serveViewer(from);
    const pc = screenShare.peers.get(from);
    if (!pc) return;
    if (m.k === "answer") {
      await pc.setRemoteDescription({ type: "answer", sdp: m.sdp }).catch(() => {});
      for (const c of pc.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      tuneScreenSender(pc);
    } else if (m.k === "ice") {
      if (pc.remoteDescription) await pc.addIceCandidate(m.c).catch(() => {});
      else pc.pendingIce.push(m.c);
    } else if (m.k === "stop") {
      pc.close();
      screenShare.peers.delete(from);
    }
    return;
  }
  // To us, as a viewer.
  const w = watching;
  if (!w || w.from !== from) return;
  if (m.k === "offer") {
    w.pc?.close();
    const pc = new RTCPeerConnection({ iceServers: await fileIce() });
    if (watching !== w) return pc.close();
    w.pc = pc;
    pc.ontrack = (ev) => ($("screen-video").srcObject = ev.streams[0] ?? new MediaStream([ev.track]));
    pc.onicecandidate = (ev) => ev.candidate && screenSend(from, { k: "ice", s: "sharer", c: ev.candidate.toJSON() });
    await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
    for (const c of w.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    await pc.setLocalDescription(await pc.createAnswer());
    screenSend(from, { k: "answer", s: "sharer", sdp: pc.localDescription.sdp });
  } else if (m.k === "ice") {
    if (w.pc?.remoteDescription) await w.pc.addIceCandidate(m.c).catch(() => {});
    else w.pending.push(m.c);
  } else if (m.k === "stop") {
    stopWatching(false);
  }
});

/** After every roster change: sharing and watching only while it still makes sense. */
function syncScreen() {
  if (!canShare()) {
    stopShare(true);
    stopWatching(false);
    return;
  }
  if (watching) {
    const u = state.roster.users.find((x) => x.session_id === watching.from);
    if (!u || !u.sharing || u.voice_channel !== myVoice()) {
      if (u && !u.sharing) toast((u.name ?? "They") + " stopped sharing.");
      stopWatching(false);
    }
  }
  for (const [viewer, pc] of screenShare.peers) {
    if (!state.roster.users.some((u) => u.session_id === viewer && u.voice_channel === myVoice())) {
      pc.close();
      screenShare.peers.delete(viewer);
    }
  }
}

function renderScreenStage() {
  const stage = $("screen-stage");
  stage.hidden = !watching;
  const video = $("screen-video");
  if (!watching) {
    video.srcObject = null;
    return;
  }
  $("screen-who").textContent = (userName(watching.from) ?? "Someone") + "'s screen";
  $("screen-wait").hidden = !!video.srcObject && !video.paused;
}

$("screen-video").addEventListener("playing", () => ($("screen-wait").hidden = true));
$("screen-video").addEventListener("dblclick", () => toggleScreenFull());
$("screen-full").addEventListener("click", () => toggleScreenFull());
$("screen-close").addEventListener("click", () => stopWatching());
$("share-btn").addEventListener("click", () => (screenShare.stream ? stopShare() : startShare()));

function toggleScreenFull() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else $("screen-video").parentElement.requestFullscreen().catch(() => {});
}

window.addEventListener("beforeunload", () => {
  stopWatching();
  stopShare();
});

// ---------- pinned conversations, friend groups, a resizable sidebar ----------
//
// Pins and friend groups travel with the rest of your synced settings.

function dmPinned(peer) {
  return prefs.notify.pinned?.[peer] ? 1 : 0;
}

function setDmPinned(peer, on) {
  prefs.notify.pinned ??= {};
  if (on) prefs.notify.pinned[peer] = true;
  else delete prefs.notify.pinned[peer];
  saveNotify();
  renderAll();
}

function friendGroup(key) {
  return prefs.notify.friendGroups?.[key] ?? "";
}

function setFriendGroup(key, name) {
  prefs.notify.friendGroups ??= {};
  const clean = name.trim().slice(0, 32);
  if (clean) prefs.notify.friendGroups[key] = clean;
  else delete prefs.notify.friendGroups[key];
  saveNotify();
  renderAll();
}

/** The names of your friend groups, in order. */
function friendGroupNames() {
  return [...new Set(Object.values(prefs.notify.friendGroups ?? {}))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** Friends sorted into your groups (alphabetically), the rest last. */
function groupFriends(rows) {
  const names = friendGroupNames().filter((n) => rows.some((f) => friendGroup(f.key) === n));
  if (!names.length) return [["", rows]];
  return [...names.map((n) => [n, rows.filter((f) => friendGroup(f.key) === n)]), ["", rows.filter((f) => !friendGroup(f.key))]];
}

async function pickFriendGroup(f) {
  const name = await askText({
    title: "Friend group",
    label: "Group for " + f.display_name,
    value: friendGroup(f.key),
    options: friendGroupNames(),
    hint: "Pick one you have, or name a new one. Only you see your groups.",
    ok: "Save",
  });
  if (name !== null) setFriendGroup(f.key, name);
}

/** A small dialog asking for a short text; null when cancelled. */
function askText({ title, label, value = "", options = [], hint = "", ok = "Save" }) {
  const dialog = $("text-dialog");
  $("text-title").textContent = title;
  $("text-label").textContent = label;
  $("text-hint").textContent = hint;
  $("text-ok").textContent = ok;
  $("text-options").replaceChildren(...options.map((o) => Object.assign(document.createElement("option"), { value: o })));
  const input = $("text-input");
  input.value = value;
  openModal(dialog);
  input.focus();
  input.select();
  return new Promise((resolve) => {
    const done = (v) => {
      $("text-form").onsubmit = $("text-cancel").onclick = dialog.oncancel = null;
      if (dialog.open) dialog.close();
      resolve(v);
    };
    $("text-form").onsubmit = (e) => {
      e.preventDefault();
      done(input.value);
    };
    $("text-cancel").onclick = () => done(null);
    dialog.oncancel = () => done(null);
  });
}

// The sidebar's width: drag its edge; a double-click puts it back.
var SIDEBAR_MIN = 200;
var SIDEBAR_MAX = 420;
var SIDEBAR_DEFAULT = 248;

function setSidebarWidth(w, keep = true) {
  const width = Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)));
  document.querySelector(".frame").style.setProperty("--sidebar-w", width + "px");
  if (keep) save("sidebarWidth", String(width));
  return width;
}

(() => {
  const sidebar = document.querySelector(".sidebar");
  const grip = el("div", "sidebar-grip");
  grip.setAttribute("role", "separator");
  grip.setAttribute("aria-label", "Drag to change the width");
  sidebar.append(grip);
  const saved = Number(load("sidebarWidth", String(SIDEBAR_DEFAULT)));
  setSidebarWidth(saved || SIDEBAR_DEFAULT, false);
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const left = sidebar.getBoundingClientRect().left;
    document.body.classList.add("resizing");
    const move = (ev) => setSidebarWidth(ev.clientX - left, false);
    const up = (ev) => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
      setSidebarWidth(ev.clientX - left);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });
  grip.addEventListener("dblclick", () => setSidebarWidth(SIDEBAR_DEFAULT));
})();

// ---------- link previews ----------
//
// A card with the page's title, description and picture under an ordinary link. Hopp fetches
// it (only from the public internet; see preview.rs), once per link, and the card stays put
// while the message around it is redrawn.

/** Each link's preview, once asked: a promise of the preview or null. */
var previewCache = new Map();

prefs.linkPreviews = load("linkPreviews", "1") === "1";
$("link-previews").checked = prefs.linkPreviews;
$("link-previews").addEventListener("change", (e) => {
  prefs.linkPreviews = e.target.checked;
  save("linkPreviews", e.target.checked ? "1" : "0");
  if (online()) renderMessages(true);
  else if (state.openDm) renderDmView(true);
});

/** Links that get a card of their own elsewhere, or none: videos, invites, GIFs, pictures. */
function previewable(link) {
  return !youtubeId(link) && !inviteTarget(link) && !GIF_URL.test(link) && !/\.(png|jpe?g|gif|webp|mp4|mov|zip|exe)(\?|$)/i.test(link);
}

function linkPreviews(text) {
  if (!text || !prefs.linkPreviews) return [];
  const link = [...text.matchAll(URL_PATTERN)].map((x) => x[0]).find(previewable);
  if (!link) return [];
  // An empty slot now; filled when the preview comes (and kept across redraws).
  const slot = el("div", "link-preview-slot");
  slot.dataset.keep = "lp|" + link;
  if (!previewCache.has(link)) previewCache.set(link, invoke("link_preview", { url: link }).catch(() => null));
  previewCache.get(link).then((p) => {
    if (p && !slot.childElementCount) slot.append(linkCard(p, link));
  });
  return [slot];
}

function linkCard(p, link) {
  const card = el("div", "link-card");
  const text = el("div", "link-card-text");
  if (p.site) text.append(el("span", "link-card-site", p.site));
  if (p.title) {
    const title = el("a", "link-card-title", p.title);
    title.href = link;
    title.addEventListener("click", (e) => {
      e.preventDefault();
      openExternal(link);
    });
    text.append(title);
  }
  if (p.description) text.append(el("p", "link-card-desc", p.description));
  card.append(text);
  if (p.image) {
    const img = el("img", "link-card-img");
    img.src = p.image;
    img.alt = "";
    img.loading = "lazy";
    card.append(img);
  }
  return card;
}
