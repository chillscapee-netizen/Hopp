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
const ACCOUNT_DATA = ["servers", "rail", "removedServers", "notify", "drafts", "closedCategories", "settingsAt"];
/** Your own settings, which follow your Hopp ID to every device (and back after restoring
 *  with the phrase). What belongs to this computer stays here: microphone and speakers, voice
 *  processing, push to talk, the window. */
const SYNCED_SETTINGS = ["theme", "themeCustom", "themeColor", "chatSize", "chatSpace", "chatCompact", "appFont", "linkPreviews", "desktopNotify", "notifyText", "sounds", "soundStyle", "soundVolume", "soundEvents", "hideIp", "shareSound", "userVolumes", "streamerAuto", "attenuate", "attenuateLevel"];
let applyingSettings = false;
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
  // A setting you changed here goes to your other devices.
  if (SYNCED_SETTINGS.includes(key) && !applyingSettings && accountScope && typeof syncState !== "undefined" && syncState.ready) {
    save("settingsAt", String(Date.now()));
    scheduleSync();
  }
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
  if (typeof tellAccountServers === "function") tellAccountServers();
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
/**
 * Voice in a server you left for another one keeps going: this is that server and how it
 * looks (`state.voiceAway = { id, roster }`), until you come back, hang up or join elsewhere.
 */
function awayVoice() {
  const a = state.voiceAway;
  if (!a) return null;
  const channel = a.roster.users.find((u) => u.session_id === a.roster.me)?.voice_channel ?? null;
  if (channel === null) return null;
  const server = prefs.servers.find((x) => x.id === a.id);
  return { server, channel, roster: a.roster, name: a.roster.channels.find((c) => c.id === channel)?.name ?? "", label: server?.label ?? a.roster.server_name };
}
/** Voice ended in the server you aren't looking at. */
function endAwayVoice(sound = true) {
  if (!state.voiceAway) return;
  state.voiceAway = null;
  state.awaySpeaking = false;
  state.latency = null;
  if (sound) playSound("leave");
  setActivityFromVoice();
  renderVoicePanel();
  renderUserPanel();
  renderRail();
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
/** Channels with a chat to open: text channels, and voice channels where the server has voice chat. */
function chatChannels() {
  return state.roster?.channels.filter((c) => c.kind === "text" || (c.kind === "voice" && voiceChat())) ?? [];
}
function voiceChat() {
  return !!state.roster?.features?.includes("voice-chat");
}
function isVoiceChannel(id) {
  return channel(id)?.kind === "voice";
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
  $("shell").classList.add("locked", "starting");
  $("splash").hidden = false;
  splashStep("Starting…", 0.15);
  for (const id of Object.values(AUTH_PANES)) $(id).hidden = true;
  invoke("window_splash").catch(() => {});
  const shown = new Promise((r) => setTimeout(r, 1400));
  // Also logs in by itself when "Keep me logged in" was chosen.
  let status;
  try {
    status = await invoke("account_status");
  } catch (err) {
    $("shell").classList.remove("starting");
    fitAuthWindow();
    $("splash-text").textContent = `Hopp couldn't start: ${friendlyError(err)}`;
    const retry = el("button", "btn sm splash-retry", "Try again");
    retry.addEventListener("click", () => {
      retry.remove();
      boot();
    });
    $("splash").append(retry);
    return;
  }
  accountExists = status.exists;
  if (status.logged_in) {
    // Warm up while the logo hops: your account connects, your servers get ready.
    splashStep("Connecting…", 0.4);
    prepareAccount(status);
    startAccount();
    const ready = new Promise((r) => {
      const t0 = Date.now();
      const tick = setInterval(() => {
        if (state.me || Date.now() - t0 > 4000) {
          clearInterval(tick);
          r();
        }
      }, 100);
    });
    await ready;
    splashStep("Getting your servers ready…", 0.75);
    await Promise.all([shown, new Promise((r) => setTimeout(r, 500))]);
    splashStep(`Welcome back, ${status.name}`, 1);
    await new Promise((r) => setTimeout(r, 450));
    $("shell").classList.remove("starting");
    return enterApp(true);
  }
  await shown;
  $("shell").classList.remove("starting");
  $("to-login-row").hidden = !status.exists;
  if (status.exists) {
    $("login-name").textContent = status.name;
    showAuth("login");
  } else {
    showAuth("create");
  }
}

/** This account's servers and settings, not whoever used Hopp on this computer before. */
function prepareAccount(status) {
  useAccountData(status.public_key);
  state.account = { name: status.name, publicKey: status.public_key, backedUp: status.backed_up };
  accountExists = true;
}

/** The splash's words and how far along it is (0 to 1). */
function splashStep(text, progress) {
  $("splash-text").textContent = text;
  $("splash-progress").style.width = Math.round(progress * 100) + "%";
}

async function enterApp(warmed) {
  const status = await invoke("account_status");
  if (!warmed) prepareAccount(status);
  $("shell").classList.remove("locked");
  invoke("window_full").catch(() => {});
  $("settings-name").value = status.name;
  $("remember-toggle").checked = status.remembered;
  renderBackupState();
  renderAll();
  if (!warmed) startAccount();
  // Asked for a username while starting: now there's room for it.
  if (state.me && !state.me.username && !usernameAsked && !state.onboarding) {
    usernameAsked = true;
    openUsernameDialog(true);
  }
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
  state.voiceAway = null;
  state.awaySpeaking = false;
  // The next account connects its own servers in the background.
  warmStarted = false;
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
  state.inbox = [];
  state.inboxSeen = 0;
  renderInboxBadge();
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
  // Never on a stream.
  if (streamer.on) return toast("Turn off streamer mode to see your recovery phrase.");
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
  return !state.atHome && !state.atNews && (id === state.activeId || id === state.connectingId);
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
  // Where your voice is, also while you look at another server.
  if (s.id === (state.voiceAway ? state.voiceAway.id : connected() && myVoice() !== null ? state.activeId : null)) {
    const v = el("span", "rail-voice");
    v.append(icon("volume", "xs"));
    b.append(v);
  }
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
    // Only the opening itself unfolds with motion; later redraws (switching servers) stay still.
    railOpening = f.open ? f : null;
    saveRail();
    renderRail();
    railOpening = null;
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
  const wrap = el("div", "folder-open" + (railOpening === f ? " opening" : ""));
  wrap.style.setProperty("--folder", color);
  const glyph = el("span", "rail-icon folder-glyph");
  glyph.append(icon("folder"));
  head.append(glyph);
  wrap.append(head, ...f.ids.map(serverById).filter(Boolean).map((s) => railServer(s, f)));
  return wrap;
}

var railOpening = null;

function renderRail() {
  $("home-btn").classList.toggle("active", !state.atNews && (state.atHome || (!state.activeId && !state.connectingId)));
  $("news-btn").classList.toggle("active", !!state.atNews);
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
  invoke("forget_server", { address: endpoint(server) }).catch(() => {});
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

  delete menu.dataset.owner;
  menu.classList.toggle("wide", items.some((i) => i.checked !== undefined));
  menu.replaceChildren(...menuItems(items));
  placePopover(menu, x, y);
  if (above) menu.style.top = `${Math.max(8, y - menu.offsetHeight - 8)}px`;
}

/** A menu's rows: buttons, ticks, sliders that stay open while you drag, and submenus. */
var submenuTimer = 0;
function menuItems(items, inSub = false) {
  return items.map((item) => {
    if (item === "sep") return el("div", "menu-sep");
    if (item.heading) return el("div", "menu-heading", item.heading);
    if (item.slider) {
      const row = el("div", "menu-slider");
      const head = el("div", "menu-slider-head");
      const value = el("span", "menu-slider-value", item.slider.format(item.slider.value));
      head.append(el("span", "", item.label), value);
      const input = el("input");
      input.type = "range";
      input.min = item.slider.min;
      input.max = item.slider.max;
      input.step = item.slider.step ?? 1;
      input.value = item.slider.value;
      input.addEventListener("input", () => {
        value.textContent = item.slider.format(Number(input.value));
        item.slider.onInput(Number(input.value));
      });
      row.append(head, input);
      return row;
    }
    const b = el("button", "menu-item" + (item.danger ? " danger" : "") + (item.checked ? " checked" : "") + (item.submenu ? " has-sub" : ""));
    if (item.swatch) {
      const dot = el("span", "status-swatch");
      dot.style.background = item.swatch;
      b.append(dot);
    }
    const text = el("span", "menu-text");
    text.append(el("span", "", item.label));
    if (item.sub) text.append(el("small", "ellipsis", item.sub));
    b.append(text);
    if (item.check !== undefined) {
      const box = el("span", "menu-check" + (item.check ? " on" : ""));
      if (item.check) box.append(icon("check"));
      b.append(box);
    } else if (item.checked !== undefined) b.append(el("span", "menu-radio"));
    else if (item.submenu) b.append(icon("chevron", "menu-chevron"));
    else if (item.icon) b.append(icon(item.icon));
    if (item.submenu) {
      const open = () => {
        const r = b.getBoundingClientRect();
        clearTimeout(submenuTimer);
        const sub = $("server-submenu");
        popoverHost(sub);
        sub.replaceChildren(...menuItems(item.submenu, true));
        sub.hidden = false;
        const left = r.right + 4 + 220 > window.innerWidth ? r.left - 224 : r.right + 4;
        sub.style.left = left + "px";
        sub.style.top = Math.max(8, Math.min(r.top - 6, window.innerHeight - sub.offsetHeight - 8)) + "px";
      };
      b.addEventListener("mouseenter", open);
      b.addEventListener("click", open);
      return b;
    }
    // Another row of the main menu closes an open submenu, after a moment, so passing over
    // a row on the way into the submenu doesn't.
    if (!inSub) {
      b.addEventListener("mouseenter", () => {
        clearTimeout(submenuTimer);
        submenuTimer = setTimeout(() => ($("server-submenu").hidden = true), 300);
      });
    }
    b.addEventListener("click", () => {
      // A tick changes in place and the menu stays, for the next one.
      if (item.check !== undefined) {
        item.check = !item.check;
        const box = b.querySelector(".menu-check");
        box.classList.toggle("on", item.check);
        box.replaceChildren(...(item.check ? [icon("check")] : []));
        item.action(item.check);
        return;
      }
      closePopovers();
      item.action();
    });
    return b;
  });
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
            { label: "Create channel", icon: "plus", action: () => onServer(server, () => openChannelDialog("text")) },
          ]
        : []),
      ...(active && nicknamesOn() ? [{ label: "Change nickname", icon: "edit", action: () => changeNickname(meUser()) }] : []),
      "sep",
      // Notifications fold out to the side: one row here, the choices there.
      { label: "Notifications", submenu: [
        ...[["all", "All messages"], ["mentions", "Only @mentions"], ["none", "Nothing"]].map(([level, label]) => ({
          label, checked: serverLevel(server) === level, action: () => setServerLevel(server, level),
        })),
        "sep",
        { label: "Suppress @everyone and @here", check: crowdQuiet(server.address), action: (on) => setCrowdQuiet(server, on) },
      ] },
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
  r.at = Date.now() + seconds * 1000;
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
  rememberServerView();
  // In voice here: you stay in the channel while you look at the other server (video ends,
  // it belongs to the view). Older servers can't wait in the background, so voice ends there.
  if (connected() && myVoice() !== null && state.activeId !== server.id) {
    stopShare();
    stopWatching();
    stopAllMedia();
    if (state.roster.features?.includes("resync")) state.voiceAway = { id: state.activeId, roster: state.roster };
  }
  // The server we leave stays connected in the background (connect parks it), so no disconnect here.
  state.activeId = null;
  state.roster = null;
  state.kicked = null;
  state.connectingId = server.id;
  // The server view shows a placeholder while connecting; Home only comes back on errors.
  state.notice = null;
  // Reset per-server state before connecting: the server sends chat history
  // while `connect` is still resolving, and it must not be wiped afterwards.
  state.speaking.clear();
  syncAttenuation();
  state.typing.clear();
  state.appliedVolumes.clear();
  state.chats.clear();
  state.olderDone.clear();
  state.loadingOlder = false;
  state.outbox = [];
  state.replyTo = null;
  state.editing = null;
  state.latency = null;
  // Coming back to a server we saw this session: its remembered messages stay on screen
  // until the server has sent this channel's history, so the chat never blinks empty.
  state.keepStale = serverViews.has(server.id);
  clearTimeout(state.keepStaleTimer);
  state.keepStaleTimer = setTimeout(() => {
    if (!state.keepStale) return;
    state.keepStale = false;
    if (online()) renderMessages(false);
  }, 4000);
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
    // Back where your voice is.
    if (state.voiceAway?.id === server.id) {
      state.voiceAway = null;
      state.awaySpeaking = false;
    }
    freshView();
    rememberServerLook(server, roster);
    // We're a member now; the invite has done its job.
    delete server.invite;
    saveServers();
    if (!chatChannels().some((c) => c.id === state.view)) state.view = textChannels().find((c) => c.parent == null)?.id ?? null;
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
  state.voiceByMe = true;
  // One voice at a time: joining a channel ends a call.
  if (state.call) await endCall();
  state.voiceState = { ready: false };
  state.latency = null;
  // ...and voice in a server you aren't looking at.
  const wasAway = !!state.voiceAway;
  if (wasAway) endAwayVoice(false);
  await call("join_voice", { channel: id });
  if (wasAway) {
    state.appliedVolumes.clear();
    applyUserVolumes();
  }
}

$("hangup-btn").addEventListener("click", () => {
  if (state.voiceAway) {
    invoke("leave_voice").catch(() => {});
    return endAwayVoice();
  }
  state.voiceByMe = true;
  call("leave_voice");
});

/** The voice panel's line takes you to the channel you're in, wherever it is. */
$("voice-where").addEventListener("click", async () => {
  const away = awayVoice();
  if (away) {
    if (away.server && (await connectTo(away.server))) openTextChannel(away.channel);
    return;
  }
  if (!connected() || myVoice() === null) return;
  if (state.atHome) await connectTo(activeServer());
  if (voiceChat()) openTextChannel(myVoice());
});

// Voice in a server that isn't in view: who's there with you, and when it ends.
listen("voice-away", (e) => {
  const a = state.voiceAway;
  const server = a && prefs.servers.find((x) => x.id === a.id);
  if (!a) return;
  // The server was taken off your list meanwhile: its voice went with it.
  if (!server) return endAwayVoice();
  if (endpoint(server) !== e.payload.address) return;
  const roster = e.payload.roster;
  const mine = (r) => r.users.find((u) => u.session_id === r.me)?.voice_channel ?? null;
  if (!roster || mine(roster) === null) {
    endAwayVoice();
    if (e.payload.lost) toast("Voice ended: the connection to " + server.label + " was lost.", true);
    else if (roster) toast("You were disconnected from voice in " + server.label + ".");
    return;
  }
  const company = (r) => new Set(r.users.filter((u) => u.voice_channel === mine(r) && u.session_id !== r.me).map((u) => u.session_id));
  const before = company(a.roster);
  const after = company(roster);
  const moved = mine(a.roster) !== mine(roster);
  a.roster = roster;
  if (!moved) {
    if ([...after].some((id) => !before.has(id))) playSound("user_join");
    else if ([...before].some((id) => !after.has(id))) playSound("user_leave");
  }
  setActivityFromVoice();
  renderVoicePanel();
  renderUserPanel();
});

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
  const beforeNames = new Map((state.roster?.users ?? []).map((u) => [u.session_id, u.name]));
  const before = myVoice();
  const mineBefore = state.roster?.users.find((u) => u.session_id === state.roster.me);
  const companyBefore = voiceCompany();
  const knownChannels = new Set((state.roster?.channels ?? []).map((c) => c.id));
  state.roster = e.payload;
  if (state.pendingThread) {
    const p = state.pendingThread;
    const made = state.roster.channels.find((c) => c.parent === p.channel && (p.starter == null ? c.name === p.name : c.starter === p.starter));
    if (made) {
      state.pendingThread = null;
      setTimeout(() => openTextChannel(made.id), 0);
    }
  }
  // A channel made just now has no history coming: it starts empty, with its welcome.
  if (knownChannels.size) {
    for (const c of state.roster.channels) {
      if (knownChannels.has(c.id) || state.chats.has(c.id)) continue;
      state.chats.set(c.id, []);
      state.olderDone.add(c.id);
    }
  }
  const after = myVoice();
  if ((before === null) !== (after === null)) setActivityFromVoice();
  if (before === null && after !== null) playSound("join");
  else if (before !== null && after === null) playSound("leave");
  // Moved to another channel (by you, or by a moderator): you've joined somewhere new.
  else if (before !== null && after !== null && before !== after) playSound("join", "You moved to " + channelName(after));
  else if (after !== null && before === after) {
    const company = voiceCompany();
    const came = [...company].find((id) => !companyBefore.has(id));
    const went = [...companyBefore].find((id) => !company.has(id));
    if (came !== undefined) playSound("user_join", (userName(came) ?? "Someone") + " joined your voice channel");
    else if (went !== undefined) playSound("user_leave", (beforeNames.get(went) ?? "Someone") + " left your voice channel");
  }
  // Joining or leaving voice swaps the microphone underneath a running mic test.
  if (state.micTesting && before !== myVoice()) stopMicTest();
  followModerators(before, after, mineBefore);
  const server = activeServer();
  if (server) rememberServerLook(server, state.roster);
  if ($("server-settings").open) {
    $("server-settings-name").textContent = server?.label ?? state.roster.server_name;
    if (!overviewChanged() || $("overview-save").disabled) resetOverview();
    else renderOverview();
  }
  if (before !== myVoice()) resetVoiceGuard();
  if (before !== null && myVoice() === null) {
    state.unreachable.clear();
    state.quality.clear();
    state.speaking.clear();
    syncAttenuation();
    state.latency = null;
  }
  if (state.pendingView !== undefined && chatChannels().some((c) => c.id === state.pendingView)) state.view = state.pendingView;
  state.pendingView = undefined;
  if (!chatChannels().some((c) => c.id === state.view)) state.view = textChannels().find((c) => c.parent == null)?.id ?? null;
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
  syncMedia();
  syncStreamAudio();
  renderAll();
  roleLookChanged();
  // Joined to watch someone: start once we're in (within a while of asking).
  const pw = state.pendingWatch;
  if (pw && myVoice() === pw.channel) {
    state.pendingWatch = null;
    if (Date.now() - pw.at < 30_000) setTimeout(() => watchScreen(pw.session), 300);
  }
  if ($("server-settings").open && !document.querySelector('[data-spanel="emojis"]').hidden) renderEmojiTab();
  // The Roles tab follows changes as they come.
  if ($("server-settings").open && !document.querySelector('[data-spanel="roles"]').hidden) renderRolesTab();
});

listen("voice", (e) => {
  const ev = e.payload;
  // Voice in a server that isn't in view: its people's numbers mean nothing in this one.
  if (state.voiceAway && (ev.type === "speaking" || ev.type === "peer_quality" || ev.type === "peer_reach")) {
    if (ev.type === "speaking" && ev.session_id === state.voiceAway.roster.me) {
      state.awaySpeaking = ev.speaking;
      renderUserPanel();
    }
    return;
  }
  if (ev.type === "speaking") {
    ev.speaking ? state.speaking.add(ev.session_id) : state.speaking.delete(ev.session_id);
    syncAttenuation();
    // Who is talking shows in the voice channel (and on your own panel); not in the member list.
    document.querySelectorAll(`.voice-user[data-user="${ev.session_id}"], .voice-tile[data-user="${ev.session_id}"]`).forEach((n) => n.classList.toggle("speaking", ev.speaking));
    if (state.roster && ev.session_id === state.roster.me) renderUserPanel();
  } else if (ev.type === "latency") {
    state.latency = ev.ms;
    renderVoicePanel();
  } else if (ev.type === "queue_delay") {
    queueSeen(ev.ms);
  } else if (ev.type === "input_level") {
    updateMeter(ev.db, ev.voice);
  } else if (ev.type === "devices_changed") {
    devicesChanged();
  } else if (ev.type === "speaking_while_muted") {
    mutedReminder();
  } else if (ev.type === "need_relay") {
    useRelay();
  } else if (ev.type === "peer_quality") {
    const before = connectionGrade(state.quality.get(ev.session_id));
    const wasRelayed = [...state.quality.values()].some((q) => q.relayed);
    state.quality.set(ev.session_id, { rtt: ev.rtt_ms, loss: ev.loss, relayed: !!ev.relayed });
    guardVoice(ev.session_id, ev.rtt_ms, ev.loss);
    if (wasRelayed !== [...state.quality.values()].some((q) => q.relayed)) renderVoicePanel();
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
    if (isVoiceChannel(m.channel) && !voiceChatOpen() && m.author_key !== state.account?.publicKey) $("voice-chat-dot").hidden = false;
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
  // While connecting, the channel is drawn once the server is ready (with its address in the keys).
  if (ch === state.view) state.keepStale = false;
  if (ch === state.view && online()) renderMessages(false);
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
  if (messages.length) state.drawFrom.set(ch, Math.min(state.drawFrom.get(ch) ?? Infinity, messages[0].id));
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
  memberStatusMap.from = null;
  renderMemberList();
  if (online()) renderMembers();
});

/**
 * Everyone in the server, also those who aren't here right now, for "Offline" in the member
 * list: asked once per visit, and again when someone new turns up.
 */
var membersAsked = { server: null, at: 0 };

/**
 * Tells your account which Hopp Cloud servers you're in, so their member lists show you online
 * (or idle, or busy) while you have Hopp open, wherever you are in it. Only when it changed.
 */
var accountServersSent = null;
function tellAccountServers(force) {
  if (!state.accountFeatures?.includes("server-presence")) return;
  const ids = prefs.servers.filter(isCloud).map((x) => x.address.slice(6)).sort();
  if (!force && ids.join(",") === accountServersSent) return;
  accountServersSent = ids.join(",");
  invoke("account_send", { msg: { type: "set_servers", ids } }).catch(() => (accountServersSent = null));
}

/**
 * Someone's status for a member list: "online", "idle" or "dnd" while they have Hopp open, else
 * null. What this app knows first hand wins (your own status, your friends'); for everyone
 * else, what the server heard from their account.
 */
function memberStatus(key) {
  if (!key) return null;
  if (key === state.account?.publicKey && state.me) {
    const mine = state.me.status ?? "online";
    return mine === "invisible" ? null : mine;
  }
  const friend = state.friends?.get(key);
  if (friend?.state === "friend" && friend.status) return friend.status === "offline" ? null : friend.status;
  if (membersAsked.server !== state.activeId) return null;
  if (memberStatusMap.from !== state.members) {
    memberStatusMap = new Map(state.members.filter((m) => m.status).map((m) => [m.public_key, m.status]));
    memberStatusMap.from = state.members;
  }
  return memberStatusMap.get(key) ?? null;
}
var memberStatusMap = new Map();


function wantMembers() {
  if (!connected() || !state.roster.features?.includes("members")) return;
  const fresh = membersAsked.server !== state.activeId;
  if (fresh) state.members = [];
  const known = new Set(state.members.map((m) => m.public_key));
  const stranger = state.members.length > 0 && state.roster.users.some((u) => u.public_key && !known.has(u.public_key));
  if (!fresh && !(stranger && Date.now() - membersAsked.at > 5000)) return;
  membersAsked = { server: state.activeId, at: Date.now() };
  invoke("get_members").catch(() => {});
}

/** How many offline people the list draws at most (the rest are counted). */
var OFFLINE_SHOWN = 150;
function offlineRows(onlineKeys) {
  if (membersAsked.server !== state.activeId) return [];
  const away = state.members.filter((m) => !onlineKeys.has(m.public_key));
  if (!away.length) return [];
  const rows = [el("li", "member-group", "Offline — " + away.length)];
  away.slice(0, OFFLINE_SHOWN).forEach((m, i) => rows.push(() => personRow(m, i, null)));
  if (away.length > OFFLINE_SHOWN) rows.push(el("li", "member-more", "and " + (away.length - OFFLINE_SHOWN) + " more"));
  return rows;
}

/** A member who isn't connected to this server: in Hopp elsewhere (`status`), or offline. */
function personRow(m, i, status) {
  const row = el("li", "member" + (status ? "" : " offline"));
  row.dataset.key = m.public_key;
  row.append(avatar(m.name, "", status ?? "offline", pictureFor(m.public_key)));
  const line = el("span", "name-line");
  line.append(styleName(el("span", "member-name ellipsis", m.name), m.public_key, m.name, false));
  // Online elsewhere: the same crown or shield, and custom status, as someone who's here.
  const role = m.role === "owner" ? "owner" : m.role === "admin" || m.role === "mod" ? m.role : null;
  if (status && role) {
    const wrap = el("span", "role-tip");
    wrap.dataset.tip = ROLE_LABEL[role];
    wrap.append(role === "owner" ? icon("crown", "crown") : icon("shield", `role-mark ${role}`));
    line.append(wrap);
  }
  const custom = status ? customStatusOf(m.public_key) : null;
  if (custom) {
    const info = el("span", "member-info");
    const sub = el("span", "member-sub");
    sub.append(...statusParts(custom));
    info.append(line, sub);
    row.append(info);
  } else {
    row.append(line);
  }
  // Their profile opens like anyone's; they just aren't here to be moved or muted.
  const person = { session_id: -1 - i, name: m.name, public_key: m.public_key, voice_channel: null, roles: m.roles ?? [], role: m.role ?? undefined, owner: m.role === "owner", offline: !status };
  row.addEventListener("click", () => openUserCard(person, row));
  // Right-click: their profile, and for moderators taking them out of the server.
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const items = [{ label: "Profile", icon: "user", action: () => openUserCard(person, row) }];
    if (can("moderate") && rankOf(me()) > rankOf(person)) {
      items.push("sep", { label: "Kick " + m.name, icon: "logout", danger: true, action: () => removeUser(false, person) });
      if (can("manage")) items.push({ label: "Ban " + m.name, icon: "ban", danger: true, action: () => removeUser(true, person) });
    }
    openMenu(items, e.clientX, e.clientY);
  });
  return row;
}

listen("disconnected", () => {
  const server = activeServer();
  // We just left this server on purpose.
  if (!server && state.justLeft) {
    state.justLeft = false;
    renderAll();
    return;
  }
  const voice = myVoice();
  // The sound is for losing voice. A connection that blinks while you only read reconnects
  // by itself within moments, and a sound out of nowhere would just be puzzling.
  if (voice !== null) playSound("disconnect");
  // What was on screen stays while Hopp reconnects.
  rememberServerView();
  state.activeId = null;
  state.roster = null;
  if (server && !state.kicked && !state.replaced) {
    startReconnect(server, voice);
    return;
  }
  if (server && state.kicked) removeServer(server);
  state.atHome = false;
  const text = state.replaced
    ? "You connected to this server from another device, so this one was signed out."
    : state.kicked
    ? state.kicked.banned ? "You were banned from this server." : "You were kicked from this server. You need a new invite to come back."
    : "Lost the connection to the server.";
  state.notice = { kind: "error", server: state.kicked ? null : server, text: server ? `${server.label}: ${text}` : text };
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
  // Reconnecting keeps you in the server (its last view, quiet) unless you went elsewhere.
  const id = state.connectingId ?? (state.reconnect && !state.atHome ? state.reconnect.server.id : null);
  return id ? prefs.servers.find((s) => s.id === id) : null;
}

function renderAll() {
  if (!state.account) return;
  if (online() || !connectingServer()) freshView();
  if (typeof renderCall === "function") queueMicrotask(renderCall);
  const on = online();
  const loading = !on && !!connectingServer();
  $("shell").classList.toggle("offline", !on && !loading);
  $("shell").classList.toggle("loading", loading);
  $("shell").classList.toggle("news", !!state.atNews);
  if (state.atNews) renderNews();
  $("topbar-title").textContent = on ? activeServer()?.label ?? state.roster.server_name : loading ? connectingServer().label : "Hopp";
  renderRail();
  renderSidebar();
  renderVoicePanel();
  renderUserPanel();
  if (on) renderChannelView();
  else if (loading) renderLoading();
  else renderHome();
  renderReconnectBar();
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
function renderReconnectBar() {
  const r = state.reconnect;
  const show = !!r && !online() && connectingServer()?.id === r.server.id;
  $("reconnect-bar").hidden = !show;
  if (!show) return;
  const left = Math.max(0, Math.ceil((r.at - Date.now()) / 1000));
  $("reconnect-text").textContent = state.connectingId ? "Reconnecting to " + r.server.label + "…" : "Lost the connection. Trying again in " + left + " s…";
}
setInterval(() => state.reconnect && renderReconnectBar(), 1000);
$("reconnect-now").addEventListener("click", () => reconnectNow());

function renderLoading() {
  const server = connectingServer();
  const view = document.querySelector(".channel-view");
  view.classList.toggle("no-members", !prefs.showMembers);
  const seen = serverViews.get(server.id);
  if (seen) {
    // What it looked like when you left: there at once, quietly, until the server answers.
    $("chat-channel").textContent = seen.channel;
    $("chat-topic").textContent = seen.topic;
    $("composer").hidden = true;
    renderedChannel = undefined;
    $("messages").replaceChildren(...seen.messages);
    $("member-list").replaceChildren(...seen.members);
    for (const n of [$("messages"), $("member-list")]) n.classList.add("stale");
    const scroller = $("scroller");
    scroller.scrollTop = scroller.scrollHeight;
    return;
  }
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
  if (state.atNews) return renderNewsNav(body, head);
  const pending = !online() && connectingServer();
  if (pending) {
    $("sidebar-title").textContent = pending.label;
    head.disabled = true;
    const seen = serverViews.get(pending.id);
    if (seen) {
      body.replaceChildren(...seen.sidebar);
      body.classList.add("stale");
      return;
    }
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
    row.append(icon(ch.private_roles?.length ? "lock" : "hash"), el("span", "ellipsis", ch.name));
    const mentions = channelMentions(address, ch.id);
    if (mentions) row.append(el("span", "count-badge", mentions > 99 ? "99+" : String(mentions)));
    row.addEventListener("click", () => openTextChannel(ch.id));
    row.addEventListener("contextmenu", (e) => openChannelMenu(ch, e));
    row.classList.toggle("muted", channelMuted(address, ch.id));
    if (owner) draggableChannel(row, ch);
    return row;
  };
  const withThreads = (ch) => [textRow(ch), ...threadsOf(ch.id, true).map(threadRow)];
  const threadRow = (t) => {
    const row = el("button", "channel-row thread-row");
    row.classList.toggle("current", t.id === state.view);
    row.classList.toggle("unread", t.id !== state.view && channelUnread(address, t.id));
    row.append(icon("message", "sm"), el("span", "ellipsis", t.name));
    const mentions = channelMentions(address, t.id);
    if (mentions) row.append(el("span", "count-badge", mentions > 99 ? "99+" : String(mentions)));
    row.addEventListener("click", () => openTextChannel(t.id));
    row.addEventListener("contextmenu", (e) => openChannelMenu(t, e));
    return row;
  };
  const mine = myVoice();
  const voiceRow = (ch) => {
    const wrap = el("div");
    const row = el("button", "channel-row");
    row.classList.toggle("in-voice", ch.id === mine);
    row.classList.toggle("current", ch.id === state.view && voiceChat());
    row.append(icon(ch.afk_after ? "moon" : "volume"), el("span", "ellipsis", ch.name));
    const count = r.users.filter((u) => u.voice_channel === ch.id).length;
    if (ch.user_limit) row.append(el("span", "voice-limit" + (count >= ch.user_limit ? " full" : ""), count + "/" + ch.user_limit));
    row.addEventListener("click", () => {
      joinVoice(ch.id);
      // Its own chat and who's there open alongside.
      if (voiceChat()) openTextChannel(ch.id);
    });
    row.addEventListener("contextmenu", (e) => openChannelMenu(ch, e));
    if (owner) {
      draggableChannel(row, ch);
    }
    acceptVoiceDrop(row, ch);
    const users = r.users.filter((u) => u.voice_channel === ch.id).sort(byName);
    const list = el("ul", "voice-users");
    list.append(...users.map((u) => draggableVoiceUser(userRow(u, "voice-user", "s24"), u)));
    wrap.append(row, list);
    return wrap;
  };

  // Channels without a category first, as text and voice lists; then each category.
  const plainText = textChannels().filter((c) => !c.category && c.parent == null);
  const plainVoice = voiceChannels().filter((c) => !c.category);
  const categories = [...new Set(r.channels.map((c) => c.category).filter(Boolean))];
  if (plainText.length || !categories.length) {
    items.push(category("Text channels", owner ? () => openChannelDialog("text") : null));
    items.push(...plainText.flatMap(withThreads));
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
    const inside = r.channels.filter((c) => c.category === name && c.parent == null);
    for (const ch of inside) {
      // A closed category still shows where you are and what's waiting.
      const show = !closed || ch.id === state.view || ch.id === mine || channelUnread(address, ch.id);
      if (show) items.push(...(ch.kind === "text" ? (closed ? [textRow(ch)] : withThreads(ch)) : [voiceRow(ch)]));
    }
  }

  body.replaceChildren(...items);
}

function openTextChannel(id) {
  // Picking another channel: the remembered view belongs to the old one.
  state.keepStale = false;
  if (state.view !== id) {
    saveDraft();
    setReply(null);
    state.editing = null;
  }
  const changed = state.view !== id;
  state.view = id;
  restoreDraft();
  renderSidebar();
  renderChannelView();
  // Another channel eases in, so the change reads as a change and not a flicker.
  if (changed) {
    const list = $("messages");
    list.classList.remove("ease-in");
    void list.offsetWidth;
    list.classList.add("ease-in");
  }
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
        ? [
            inThis ? { label: "Leave voice", icon: "phone-off", action: () => { state.voiceByMe = true; call("leave_voice"); } } : { label: "Join voice", icon: "volume", action: () => joinVoice(ch.id) },
            ...(voiceChat() ? [{ label: "Open chat", icon: "message", action: () => openTextChannel(ch.id) }] : []),
          ]
        : []),
      { label: "Invite people", icon: "user-plus", action: openInvite },
      ...(ch.kind === "text" && (channelUnread(address, ch.id) || channelMentions(address, ch.id))
        ? [{ label: "Mark as read", icon: "check", action: () => markChannelRead(address, ch.id) }]
        : []),
      ...(ch.kind === "text" ? [{ label: muted ? "Unmute channel" : "Mute channel", icon: "bell", action: () => setChannelMuted(address, ch.id, !muted) }] : []),
      ...(ch.parent != null && (can("moderate") || ch.creator === state.account?.publicKey)
        ? ["sep", { label: "Delete thread", icon: "trash", danger: true, action: () => deleteChannel(ch) }]
        : []),
      ...(can("manage") && ch.parent == null
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
  const thread = ch.parent != null;
  const what = thread ? `the thread "${ch.name}" and all of its messages` : ch.kind === "text" ? `#${ch.name} and all of its messages, threads too` : ch.name;
  const ok = await confirmDialog({ title: thread ? "Delete thread" : "Delete channel", text: `Delete ${what}? This can't be undone.`, ok: thread ? "Delete thread" : "Delete channel" });
  if (ok) call("delete_channel", { channel: ch.id });
}

function flagsFor(u) {
  if (!u.muted && !u.deafened && !u.server_muted && !u.server_deafened && !timedOutUntil(u)) return null;
  const flags = el("span", "flags");
  const mark = (name, server, tip) => {
    const i = icon(name, "xs off" + (server ? " server" : ""));
    const wrap = el("span", "flag");
    wrap.dataset.tip = tip;
    wrap.append(i);
    flags.append(wrap);
  };
  if (timedOutUntil(u)) mark("clock", true, "Timed out until " + clock(timedOutUntil(u)));
  if (u.server_muted) mark("mic-off", true, "Muted by a moderator");
  else if (u.muted) mark("mic-off", false, "Muted");
  if (u.server_deafened) mark("headphones-off", true, "Deafened by a moderator");
  else if (u.deafened) mark("headphones-off", false, "Deafened");
  return flags;
}

function userRow(u, className, size, sub) {
  const isSelf = u.session_id === state.roster.me;
  if (className === "member" && !sub) {
    const s = customStatusOf(keyOf(u));
    if (s) sub = { status: s };
  }
  const talking = className === "voice-user" && state.speaking.has(u.session_id);
  const row = el("li", className + (isSelf ? " self" : "") + (talking ? " speaking" : ""));
  row.dataset.user = u.session_id;
  const member = className === "member";
  // The member list is just who is here: avatar with a status dot, name, crown.
  row.append(avatar(u.name, size, member ? memberStatus(keyOf(u)) ?? (isSelf && state.me?.status === "invisible" ? "offline" : "online") : undefined, pictureFor(keyOf(u))));
  const nameLine = el("span", "name-line");
  const nameEl = styleName(el("span", className === "member" ? "member-name ellipsis" : "ellipsis", u.name), keyOf(u), u.name, false);
  nameLine.append(nameEl);
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
    if (sub.status) subLine.append(...statusParts(sub.status));
    else subLine.append(icon("volume", "xs"), el("span", "ellipsis", sub));
    info.append(nameLine, subLine);
    row.append(info);
  } else {
    row.append(nameLine);
  }
  // Voice details (muted, deafened, your volume for them) belong in the voice channel.
  if (className === "voice-user" && u.sharing) {
    const live = el("button", "live-pill" + (watching?.from === u.session_id ? " watching" : ""), "LIVE");
    live.type = "button";
    live.dataset.tip = watching?.from === u.session_id ? "You're watching" : isSelf ? "See your own stream" : "Watch their screen";
    live.addEventListener("click", (e) => {
      e.stopPropagation();
      watchScreen(u.session_id, true);
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
  const away = awayVoice();
  const voice = away ? null : connected() ? myVoice() : null;
  panel.hidden = voice === null && !away;
  if (panel.hidden) return;
  const status = panel.querySelector(".voice-status");
  // Peer to peer, what's measured is the round trip to the others and back. What you hear is
  // one way: how long your voice takes to reach them (half of it). That's the number shown,
  // the one comparable to an app's "ping" to its server, and coloured by what people notice
  // (ITU-T G.114: under about 150 ms one way is hardly noticed).
  const oneWay = !away && !isCloud(activeServer()) ? null : state.latency === null ? null : Math.round(state.latency / 2);
  const ms = oneWay ?? state.latency;
  const { ready, error } = state.voiceState;
  if (away) {
    // In voice in another server: where, how it's going, and the way out. Video belongs to the view.
    status.classList.toggle("warn", !error && (!ready || (ms !== null && ms >= 100 && ms < 200)));
    status.classList.toggle("bad", !!error || (ms !== null && ms >= 200));
    $("voice-status-text").textContent = error ? "Voice unavailable" : ready ? "Voice connected" : "Starting voice…";
    const where = away.name + " / " + away.label;
    $("voice-where").textContent = ms === null ? where : where + " · " + (ms < 1 ? "<1 ms" : ms + " ms");
    $("voice-actions").hidden = false;
    $("cam-btn").hidden = true;
    $("share-btn").hidden = true;
    $("voice-actions").classList.add("sound-only");
    return;
  }
  // One way (peer to peer) or to the server (your own server): either way, under 100 ms is good.
  const limits = oneWay !== null ? [100, 200] : [80, 150];
  status.classList.toggle("warn", !error && (!ready || (ms !== null && ms >= limits[0] && ms < limits[1])));
  status.classList.toggle("bad", !!error || (ms !== null && ms >= limits[1]));
  $("voice-status-text").textContent = error ? "Voice unavailable" : ready ? "Voice connected" : "Starting voice…";
  const latency = ms === null ? null : ms < 1 ? "<1 ms" : `${ms} ms`;
  const direct = isCloud(activeServer());
  const alone = !state.roster.users.some((u) => u.session_id !== state.roster.me && u.voice_channel === voice);
  // Cloud voice is peer to peer: the number is the slowest round trip to the others.
  status.dataset.tip = error ? friendlyError(error) : !ready ? "Opening your microphone and finding the others…" : direct
    ? latency ? `Direct to the others: your voice reaches the farthest in ${latency}` : alone ? "Voice goes straight to the others when they join" : "Connecting to the others…"
    : latency ? `Latency to the server: ${latency}` : "Measuring latency…";
  const where = screenShare.stream ? "Sharing your screen" : `${channelName(voice)} / ${activeServer()?.label ?? state.roster.server_name}`;
  // Through the relay is a detour (a little slower); Hopp keeps trying the direct way meanwhile.
  const detour = [...state.quality.values()].some((q) => q.relayed) ? " · relay" : "";
  $("voice-where").textContent = latency ? `${where} · ${latency}${detour}` : where;
  // The soundboard works anywhere; camera and screen need a server that passes video handshakes.
  $("voice-actions").hidden = false;
  $("cam-btn").hidden = !canShare();
  $("share-btn").hidden = !canShare();
  $("voice-actions").classList.toggle("sound-only", !canShare());
  $("cam-btn").classList.toggle("on", !!media.out.cam);
  $("cam-btn").setAttribute("aria-label", media.out.cam ? "Turn off camera" : "Turn on camera");
  $("cam-btn").querySelector("use").setAttribute("href", media.out.cam ? "#i-video" : "#i-video-off");
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
  const away = awayVoice();
  const live = away ? !!state.awaySpeaking : on && state.speaking.has(state.roster.me);
  card.classList.toggle("speaking", live);
  $("me-name").textContent = name;
  styleName($("me-name"), state.me?.key ?? state.account?.publicKey, name, false, "personal");

  const status = $("me-status");
  const sending = live && !state.muted && !state.deafened;
  const voice = away ? away.channel : on ? myVoice() : null;
  status.classList.toggle("live", sending);
  status.textContent = !on && !away
    ? state.connectingId ? "Connecting…" : state.accountConnected ? statusLine(state.me?.custom_status) ?? STATUS_LABEL[state.me?.status ?? "online"] : "Offline"
    : state.deafened ? "Deafened"
    : state.muted ? "Muted"
    : sending ? "Speaking"
    : voice !== null && prefs.mode === "push_to_talk" && !prefs.pttKey ? "No push-to-talk key"
    : voice !== null ? (state.micTesting ? "Hearing yourself" : `In ${away ? away.name : channelName(voice)}`)
    : statusLine(state.me?.custom_status) ?? STATUS_LABEL[state.me?.status ?? "online"] ?? "Online";

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
  // A voice channel says who is in it; the server count belongs to text channels.
  const inVoice = view !== null && isVoiceChannel(view) ? r.users.filter((u) => u.voice_channel === view).length : null;
  $("chat-topic").textContent = topic || (inVoice === null ? `${r.users.length} online` : inVoice ? `${inVoice} in voice` : "Nobody in voice yet");
  // A thread says which channel it belongs to, a click away.
  const parentId = view === null ? null : channel(view)?.parent ?? null;
  if (parentId != null) {
    const back = el("button", "link thread-parent", "in #" + channelName(parentId));
    back.type = "button";
    back.addEventListener("click", () => openTextChannel(parentId));
    $("chat-topic").replaceChildren(back);
  }
  $("composer").hidden = view === null;
  $("chat-input").placeholder = composerHint(view);
  $("chat-input").disabled = !!timedOutUntil(meUser());
  $("chat-head-icon").innerHTML = isVoiceChannel(view) ? '<use href="#i-volume"/>' : channel(view)?.parent != null ? '<use href="#i-message"/>' : '<use href="#i-hash"/>';
  renderVoiceStage();
  $("attach-btn").hidden = !picturesAllowed() && !pollsHere();
  $("voice-msg-btn").hidden = !voiceMessagesHere();
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
  // A narrow window has no room beside the chat: the list opens over it instead.
  if (window.matchMedia("(max-width: 1100px)").matches) {
    document.querySelector(".channel-view").classList.toggle("members-over");
    return;
  }
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
  const here = [...byKey.values()];
  const hereKeys = new Set(here.map((u) => keyOf(u)).filter(Boolean));
  // In Hopp but not in this server right now (another server, DMs): online all the same.
  const elsewhere = membersAsked.server === state.activeId
    ? state.members.filter((m) => memberStatus(m.public_key) && !hereKeys.has(m.public_key)).map((m) => ({ name: m.name, public_key: m.public_key, roles: m.roles ?? [], role: m.role ?? undefined, owner: m.role === "owner", voice_channel: null, member: { ...m, status: memberStatus(m.public_key) } }))
    : [];
  const users = [...here, ...elsewhere].sort(byName);
  // Each person under their highest role that's shown separately; the rest as before.
  const hoisted = (state.roster.roles ?? []).filter((r) => r.hoist);
  const placed = new Set();
  const groups = [["Owner", users.filter((u) => roleOf(u) === "owner")]];
  for (const u of groups[0][1]) placed.add(u);
  for (const r of hoisted) {
    const list = users.filter((u) => !placed.has(u) && u.roles?.includes(r.id));
    list.forEach((u) => placed.add(u));
    groups.push([r.name, list]);
  }
  const rest = users.filter((u) => !placed.has(u));
  groups.push(["Admins", rest.filter((u) => roleOf(u) === "admin")], ["Moderators", rest.filter((u) => roleOf(u) === "mod")], ["Online", rest.filter((u) => !roleOf(u))]);
  const items = [];
  for (const [label, list] of groups) {
    if (list.length === 0) continue;
    items.push(el("li", "member-group", `${label} — ${list.length}`));
    items.push(...list.map((u, i) => () => (u.member ? personRow(u.member, i, u.member.status) : userRow(u, "member", ""))));
  }
  wantMembers();
  const offline = offlineRows(new Set(users.map((u) => u.public_key ?? keyOf(u)).filter(Boolean)));
  items.push(...offline);
  mountMembers(items);
}

/**
 * Puts the member list on the page. A big server's list isn't built all at once: the first
 * rows now, the rest as empty blocks of the right height that fill in as you scroll to them
 * (with 300 members, every status change used to rebuild all 300 rows).
 */
var MEMBERS_AT_ONCE = 50;
function mountMembers(items) {
  const out = [];
  let made = 0;
  let batch = null;
  for (const item of items) {
    if (typeof item !== "function") {
      batch = null;
      out.push(item);
    } else if (made < MEMBERS_AT_ONCE) {
      out.push(item());
      made++;
    } else {
      if (!batch || batch.rows.length >= 40) {
        batch = el("li", "member-later");
        batch.rows = [];
        out.push(batch);
      }
      batch.rows.push(item);
      batch.style.height = batch.rows.length * 44 + "px";
    }
  }
  $("member-list").replaceChildren(...out);
  fillMembers();
}

function fillMembers() {
  const box = $("members");
  const bottom = box.getBoundingClientRect().bottom + 400;
  for (const spot of $("member-list").querySelectorAll(".member-later")) {
    if (spot.getBoundingClientRect().top > bottom) break;
    spot.replaceWith(...spot.rows.map((make) => make()));
  }
}
$("members").addEventListener("scroll", fillMembers, { passive: true });

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
/** True while drawing a message of only emojis: its emojis are big, so they get the big pictures. */
var emojiBig = false;

function messageText(text) {
  const jumbo = ONLY_EMOJI.test(text);
  const out = el("div", "msg-text" + (jumbo ? " jumbo" : ""));
  emojiBig = jumbo;
  try {
    return messageTextInto(out, text);
  } finally {
    emojiBig = false;
  }
}

function messageTextInto(out, text) {
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

/**
 * Whole lines with a meaning of their own: "# ", "## ", "### " headings, "-# " small print,
 * "- " or "* " bullet lists, "1. " numbered lists and "> " quotes. The rest is inline text.
 */
var HEADING = /^(#{1,3}) (\S.*)$/;
var SUBTEXT = /^-# (\S.*)$/;
var BULLET = /^ {0,3}[-*] (\S.*)$/;
var NUMBERED = /^ {0,3}(\d{1,3})\. (\S.*)$/;
function renderBlocks(text, out) {
  const lines = text.split("\n");
  let plain = [];
  const flush = () => {
    if (plain.length) renderInline(plain.join("\n"), out);
    plain = [];
  };
  const list = (re, tag, i) => {
    const node = el(tag, "msg-list");
    const first = lines[i].match(re);
    if (tag === "ol" && first[1] !== "1") node.start = Number(first[1]);
    while (i < lines.length && re.test(lines[i])) {
      const li = el("li");
      renderInline(lines[i].match(re).at(-1), li);
      node.append(li);
      i++;
    }
    out.append(node);
    return i;
  };
  for (let i = 0; i < lines.length; ) {
    const heading = lines[i].match(HEADING);
    const sub = lines[i].match(SUBTEXT);
    if (heading) {
      flush();
      const h = el("div", "msg-h msg-h" + heading[1].length);
      renderInline(heading[2], h);
      out.append(h);
      i++;
    } else if (sub) {
      flush();
      const small = el("div", "msg-subtext");
      renderInline(sub[1], small);
      out.append(small);
      i++;
    } else if (BULLET.test(lines[i])) {
      flush();
      i = list(BULLET, "ul", i);
    } else if (NUMBERED.test(lines[i])) {
      flush();
      i = list(NUMBERED, "ol", i);
    } else if (/^>( |$)/.test(lines[i])) {
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
  ["emoji", /<:([a-z0-9_]{2,32}):(\d{1,9})>/],
  ["mention", /<@([0-9a-f]{64})>/],
  ["role", /<@&(\d+)>/],
  ["crowd", /(?<![\p{L}\p{N}_@])@(everyone|here)(?![\p{L}\p{N}_])/u],
  // [text](https://…): the text, with where it really goes always shown beside it.
  ["masked", /\[([^\]\n]{1,100})\]\((https?:\/\/[^\s)]{1,500})\)/],
  ["link", LINK_ONE],
  ["spoiler", /\|\|([\s\S]+?)\|\|/],
  ["bold", /\*\*([\s\S]+?)\*\*/],
  ["strike", /~~([\s\S]+?)~~/],
  ["underline", /__([\s\S]+?)__/],
  ["italic", /\*([^*\s](?:[^*]*[^*\s])?)\*|(?<![\p{L}\p{N}])_([^_\s](?:[^_]*[^_\s])?)_(?![\p{L}\p{N}])/u],
];

/** One emoji: a pictograph with its skin tone, variation and joined parts, or a flag. */
var EMOJI_RUN = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F\u20E3)(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic}\uFE0F?)*/gu;

/** Twemoji's file for an emoji: its code points in hex, without FE0F unless it's a joined one. */
function emojiFile(text) {
  const cps = [...text].map((c) => c.codePointAt(0).toString(16));
  return (text.includes("\u200d") ? cps : cps.filter((c) => c !== "fe0f")).join("-");
}

/**
 * An ordinary emoji drawn as a picture (Twemoji, shipped with the app), so it looks the same on
 * every computer and flags work on Windows. Its own character stays as the alt text (copying,
 * screen readers); one the set doesn't have falls back to the system's.
 */
function emojiImg(text) {
  const img = el("img", "emoji");
  // Small (40 px) wherever emojis are small; the 72 px picture only for big ones.
  img.src = (emojiBig ? "emoji/" : "emoji/s/") + emojiFile(text) + ".png";
  img.alt = text;
  img.draggable = false;
  img.decoding = "async";
  img.addEventListener("error", () => img.replaceWith(el("span", "emoji-text", text)), { once: true });
  return img;
}

/** Text, with each emoji in it drawn as a picture. */
function appendText(out, text) {
  let at = 0;
  for (const m of text.matchAll(EMOJI_RUN)) {
    if (m.index > at) out.append(text.slice(at, m.index));
    out.append(emojiImg(m[0]));
    at = m.index + m[0].length;
  }
  if (at < text.length) out.append(text.slice(at));
}

/** A node for text that may hold emojis: plain text when there are none. */
function emojiText(text, cls = "") {
  const span = el("span", cls);
  appendText(span, String(text ?? ""));
  return span;
}

document.addEventListener("copy", (e) => {
  const sel = getSelection();
  if (!sel?.rangeCount || sel.isCollapsed) return;
  const frag = sel.getRangeAt(0).cloneContents();
  const pics = frag.querySelectorAll?.("img.emoji, img.custom-emoji");
  if (!pics?.length) return;
  pics.forEach((i) => i.replaceWith(i.alt));
  const box = document.createElement("div");
  box.append(frag);
  e.clipboardData.setData("text/plain", box.innerText || box.textContent);
  e.preventDefault();
});

function renderInline(text, out) {
  while (text) {
    let best = null;
    for (const [kind, re] of INLINE_RULES) {
      const m = re.exec(text);
      if (m && (!best || m.index < best.m.index)) best = { kind, m };
    }
    if (!best) {
      appendText(out, text);
      return;
    }
    const { kind, m } = best;
    appendText(out, text.slice(0, m.index));
    const inner = m[1] ?? m[2] ?? "";
    if (kind === "code") out.append(el("code", "inline-code", inner));
    else if (kind === "emoji") out.append(emojiNode(m[0]));
    else if (kind === "mention") out.append(el("span", "mention" + (inner === state.account?.publicKey ? " me" : ""), `@${nameForKey(inner)}`));
    else if (kind === "role") out.append(roleMentionNode(Number(inner)));
    else if (kind === "crowd") out.append(pingsOn() && !state.atHome ? el("span", "mention" + (crowdQuiet(currentServer()?.address) ? "" : " me"), m[0]) : m[0]);
    else if (kind === "link") out.append(linkNode(m[0]));
    else if (kind === "masked") out.append(maskedLink(m[1], m[2]));
    else {
      const node = el(kind === "bold" ? "strong" : kind === "italic" ? "em" : kind === "strike" ? "s" : kind === "underline" ? "u" : "span", kind === "spoiler" ? "spoiler" : "");
      if (kind === "spoiler") {
        node.setAttribute("aria-label", "Spoiler: click to show");
        node.addEventListener("click", () => node.classList.add("shown"));
      }
      renderInline(inner, node);
      out.append(node);
    }
    text = text.slice(m.index + m[0].length);
  }
}

/** A link with its own words, and the site it really opens beside them (so it can't pretend). */
function maskedLink(words, href) {
  let host = "";
  try {
    host = new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return document.createTextNode(`[${words}](${href})`);
  }
  const wrap = el("span", "msg-masked");
  const a = el("a", "msg-link");
  renderInline(words, a);
  a.href = href;
  a.addEventListener("click", (e) => {
    e.preventDefault();
    openExternal(href);
  });
  wrap.append(a, el("span", "msg-link-host", host));
  return wrap;
}

function linkNode(href) {
  // Invites read as what they are, not as a long address.
  const invite = shortInviteCode(href) !== null || /^(?:hopp|strom):\/\//i.test(href);
  const a = el("a", invite ? "msg-link msg-invite-link" : "msg-link", invite ? "Server invite" : href);
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
  videosIn("channel|" + state.activeId + "|" + state.view);
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
  // Just back on this server: what was here stays until the history arrives (see connectTo).
  if (state.keepStale && !state.chats.has(state.view)) {
    renderedChannel = undefined;
    return;
  }
  const name = channelName(state.view);
  const allMsgs = state.chats.get(state.view) || [];
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
  const msgs = drawWindow(allMsgs, !keepScrollUnlessAtBottom, unreadFrom, atBottom);
  const hiddenAbove = msgs.length < allMsgs.length;

  const welcome = el("li", "welcome");
  const badge = el("div", "welcome-icon");
  const inVoiceChannel = isVoiceChannel(state.view);
  const here = channel(state.view);
  if (here?.parent != null) {
    // A thread: where it was started, and from what.
    badge.append(icon("message"));
    const from = here.starter != null ? (state.chats.get(here.parent) ?? []).find((x) => x.id === here.starter) : null;
    const sub = el("p", "");
    const back = el("button", "link", "#" + channelName(here.parent));
    back.type = "button";
    back.addEventListener("click", () => openTextChannel(here.parent));
    sub.append("A thread in ", back, from ? ", started from " + (nameHere(from.author_key) ?? from.sender_name) + "'s message:" : ".");
    welcome.append(badge, el("h1", "", name), sub);
    if (from) {
      const quote = el("button", "thread-origin");
      quote.type = "button";
      quote.append(el("div", "pin-text", previewText(from.text) || "A message"));
      quote.addEventListener("click", () => {
        openTextChannel(here.parent);
        jumpToMessage(from.id);
      });
      welcome.append(quote);
    }
  } else {
    badge.append(icon(inVoiceChannel ? "volume" : "hash"));
    welcome.append(
      badge,
      el("h1", "", inVoiceChannel ? `${name}` : `Welcome to #${name}!`),
      el("p", "", here?.topic || (inVoiceChannel ? "The chat for this voice channel: links, clips and anything you'd rather type." : `This is the start of the #${name} channel.`)),
    );
  }
  if (msgs.length === 0 && can("manage")) {
    const actions = el("div", "welcome-actions");
    const invite = el("button", "btn primary sm", "Invite people");
    invite.addEventListener("click", openInvite);
    actions.append(invite);
    welcome.append(actions);
  }

  const items = [state.olderDone.has(state.view) && !hiddenAbove ? welcome : olderLoader()];
  // What's on screen now, by message: a message that hasn't changed keeps its row as it is,
  // without building a new one (a new message or reaction used to rebuild all ~150).
  const shown = new Map();
  for (const node of $("messages").children) if (node.dataset.key) shown.set(node.dataset.key, node);
  let prev = null;
  for (const m of msgs) {
    const day = dayLabel(m.sent_at);
    const newDay = !prev || dayLabel(prev.sent_at) !== day;
    if (newDay) items.push(el("li", "day-divider", day));
    const grouped = !prefs.compact && !newDay && !m.reply && prev.author_key === m.author_key && prev.sender_name === m.sender_name && m.sent_at - prev.sent_at < GROUP_WINDOW_MS;
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
    const key = `${activeServer()?.address}|${m.id}`;
    const sig = JSON.stringify([grouped, day, nameHere(m.author_key) ?? m.sender_name, m.text, m.edited_at, m.reactions, m.pinned, m.reply, state.replyTo?.id === m.id, state.editing?.id === m.id, pictureFor(m.author_key), rankOf(me()), state.shownBlocked.has(m.id), prefs.linkPreviews, roleColorByKey(m.author_key), rawNameStyle(m.author_key), threadFrom(m)?.name ?? null, threadFrom(m)?.last_at ?? null, mentionsMeIn(m)]);
    const same = shown.get(key);
    if (same && same.dataset.sig === sig) {
      same.msg = m;
      items.push(same);
      prev = m;
      continue;
    }
    if (mentionsMeIn(m) && m.author_key !== state.account?.publicKey) li.classList.add("mentions-me");
    if (state.replyTo?.id === m.id) li.classList.add("replying");
    if (m.reply) li.append(replyLine(m.reply));
    if (grouped) {
      li.append(el("span", "msg-gutter", clock(m.sent_at)));
    } else {
      const head = el("div", "msg-head");
      const author = el("span", "msg-author", nameHere(m.author_key) ?? m.sender_name);
      styleName(author, m.author_key, m.sender_name);
      head.append(el("span", "msg-clock", clock(m.sent_at)), author, el("span", "msg-time", `${day} at ${clock(m.sent_at)}`));
      if (m.pinned) {
        const pin = icon("pin", "xs msg-pin");
        pin.dataset.tip = "Pinned";
        head.append(pin);
      }
      li.append(avatar(m.sender_name, "s40", undefined, pictureFor(m.author_key)), head);
    }
    if (state.editing?.id === m.id) li.append(messageEditor(m));
    else if (VOICE_MESSAGE.test(m.text)) li.append(voiceView(m.text.match(VOICE_MESSAGE)[1], Number(m.text.match(VOICE_MESSAGE)[2])));
    else if (pollOf(m.text)) li.append(pollView(m, pollOf(m.text)));
    else if (forwardParts(m.text)) li.append(forwardView(forwardParts(m.text)));
    else if (PICTURE.test(m.text)) {
      const [, id, w, h] = m.text.match(PICTURE);
      const caption = m.text.slice(m.text.match(PICTURE)[0].length).trim();
      if (caption) li.append(messageText(caption));
      li.append(pictureView(id, Number(w), Number(h)));
    } else if (GIF_URL.test(m.text.trim())) {
      li.append(gifNode(m.text.trim(), () => {
        const scroller = $("scroller");
        if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 400) scroller.scrollTop = scroller.scrollHeight;
      }));
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
    if (m.reactions?.some((r) => !r.emoji.startsWith("poll:"))) li.append(reactionRow(m));
    const thread = threadFrom(m);
    if (thread) li.append(threadChip(thread));
    li.append(messageActions(m));
    li.msg = m;
    li.addEventListener("contextmenu", (e) => openMessageMenu(e.currentTarget.msg, e));
    // Kept as is when nothing it shows has changed (a playing video keeps playing).
    li.dataset.key = key;
    li.dataset.sig = sig;
    items.push(li);
    prev = m;
  }
  // Messages on their way look exactly as they will once sent (grouped under yours),
  // so nothing changes height when the server confirms them.
  const myName = me()?.name ?? state.account?.name ?? "";
  let last = prev && !prev.blocked ? { author_key: prev.author_key, sender_name: prev.sender_name, sent_at: prev.sent_at } : null;
  for (const o of state.outbox.filter((x) => x.channel === state.view)) {
    const grouped = !prefs.compact && !!last && !o.reply && !o.failed && last.author_key === state.account?.publicKey && last.sender_name === myName && o.at - last.sent_at < GROUP_WINDOW_MS && dayLabel(last.sent_at) === dayLabel(o.at);
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
  // Blurred once, as a tiny picture the card stretches (a live blur filter is redrawn
  // whenever the window changes size, which made resizing lag).
  if (art) blurredArt(art).then((url) => url && card.style.setProperty("--invite-art", `url("${url}")`));
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
  const said = names.join("\n");
  if (box.dataset.said === said) return;
  box.dataset.said = said;
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
  openServerMenu(activeServer(), r.left + 8, r.bottom + 4);
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
  $("server-settings-icon").replaceChildren(serverIcon("settings-server-icon server-tint", activeServer()?.label ?? state.roster.server_name, state.roster.server_icon));
  resetOverview();
  showServerTab("overview");
  $("invite-list").replaceChildren(el("li", "admin-empty", "Loading…"));
  $("ban-list").replaceChildren(el("li", "admin-empty", "Loading…"));
  $("server-members").replaceChildren(el("li", "admin-empty", "Loading…"));
  $("member-search").value = "";
  document.querySelector('[data-stab="members"]').hidden = !isCloud(activeServer());
  document.querySelector('[data-stab="audit"]').hidden = !modTools() || !can("manage");
  document.querySelector('[data-stab="roles"]').hidden = !rolesOn() || !can("manage");
  document.querySelector('[data-stab="emojis"]').hidden = !state.roster?.features?.includes("emojis") || !can("manage");
  $("server-mod-label").hidden = document.querySelector('[data-stab="audit"]').hidden;
  openModal($("server-settings"));
  call("get_server_settings");
}
function showServerTab(tab) {
  if (tab === "roles") renderRolesTab();
  if (tab === "emojis") renderEmojiTab();
  if (tab === "audit") {
    $("audit-list").replaceChildren(el("li", "admin-empty", "Loading…"));
    call("get_audit_log");
  }
  document.querySelectorAll("[data-stab]").forEach((t) => t.classList.toggle("active", t.dataset.stab === tab));
  document.querySelectorAll("[data-spanel]").forEach((p) => (p.hidden = p.dataset.spanel !== tab));
  if (tab === "members") renderMemberList();
}
document.querySelectorAll("[data-stab]").forEach((t) => t.addEventListener("click", () => showServerTab(t.dataset.stab)));

// Emoji: admins add pictures with a name; everyone in the server can use them.
var emojiDraft = null; // { bytes, url }

function renderEmojiTab() {
  const list = $("emoji-list");
  const emojis = serverEmojis();
  if (!emojis.length) {
    list.replaceChildren(el("li", "admin-empty", "No emojis yet. Upload one: a picture, a name, done."));
  } else {
    list.replaceChildren(...emojis.map((e) => {
      const li = el("li", "emoji-admin");
      const img = el("img");
      img.src = pictureUrl(e.image);
      img.alt = "";
      const remove = el("button", "icon-btn sm danger-hover");
      remove.type = "button";
      remove.setAttribute("aria-label", "Remove :" + e.name + ":");
      remove.append(icon("trash", "sm"));
      remove.addEventListener("click", async () => {
        const ok = await confirmDialog({ title: "Remove :" + e.name + ":", text: "It disappears from every message and reaction that uses it.", ok: "Remove" });
        if (ok) call("delete_emoji", { id: e.id });
      });
      li.append(img, el("span", "ellipsis", ":" + e.name + ":"), remove);
      return li;
    }));
  }
  $("emoji-upload").disabled = emojis.length >= 100;
}

/** A picture made into a 128 × 128 emoji (kept whole, centred, transparent around it). */
async function emojiPicture(file) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const scale = Math.min(128 / bitmap.width, 128 / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  canvas.getContext("2d").drawImage(bitmap, (128 - w) / 2, (128 - h) / 2, w, h);
  const blob = await new Promise((done) => canvas.toBlob(done, "image/webp", 0.92));
  return new Uint8Array(await blob.arrayBuffer());
}

$("emoji-upload").addEventListener("click", () => $("emoji-file").click());
$("emoji-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    const bytes = await emojiPicture(file);
    if (emojiDraft?.url) URL.revokeObjectURL(emojiDraft.url);
    emojiDraft = { bytes, url: URL.createObjectURL(new Blob([bytes], { type: "image/webp" })) };
    $("emoji-new-img").src = emojiDraft.url;
    // A name from the file's, as emoji names go: lowercase, numbers and _.
    $("emoji-new-name").value = file.name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32) || "emoji";
    $("emoji-new").hidden = false;
    $("emoji-new-name").focus();
    $("emoji-new-name").select();
  } catch {
    toast("That picture couldn't be read. Try a PNG, JPEG, WebP or GIF.", true);
  }
});
$("emoji-new-name").addEventListener("input", (e) => (e.target.value = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "")));
$("emoji-new-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("emoji-new-save").click();
  }
});
$("emoji-new-cancel").addEventListener("click", () => {
  $("emoji-new").hidden = true;
  emojiDraft = null;
});
$("emoji-new-save").addEventListener("click", async () => {
  const name = $("emoji-new-name").value;
  if (!emojiDraft) return;
  if (!/^[a-z0-9_]{2,32}$/.test(name)) return toast("Emoji names are 2–32 characters: lowercase letters, numbers and _.", true);
  if (serverEmojis().some((x) => x.name === name)) return toast("There's already an emoji called :" + name + ":.", true);
  $("emoji-new-save").disabled = true;
  try {
    const id = await invoke("upload_image", { cloud: cloudHttp(), serverId: activeServer().address.slice("cloud:".length), data: Array.from(emojiDraft.bytes), kind: "image/webp" });
    await invoke("create_emoji", { name, image: id });
    $("emoji-new").hidden = true;
    emojiDraft = null;
  } catch (err) {
    toast(friendlyError(err), true);
  } finally {
    $("emoji-new-save").disabled = false;
  }
});

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
    list.replaceChildren(el("li", "admin-empty", "No active invites yet."));
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

function confirmDialog({ title, text, ok, cancel = "Cancel", danger = true, choice = null }) {
  const dialog = $("confirm-dialog");
  // An optional choice to make along the way (its answer is in confirmDialog.choice).
  $("confirm-choice-row").hidden = !choice;
  if (choice) {
    $("confirm-choice-label").textContent = choice.label;
    $("confirm-choice").replaceChildren(...choice.options.map(([v, t]) => Object.assign(document.createElement("option"), { value: v, textContent: t })));
    $("confirm-choice").value = choice.value ?? choice.options[0][0];
  }
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
    $("confirm-ok").onclick = () => {
      confirmDialog.choice = $("confirm-choice").value;
      done(true);
    };
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
    const wait = slowmodeWait(state.view);
    if (wait > 0) return toast("Slowmode is on here. Wait " + wait + " s.");
    if (await phraseBlocked(text)) return;
    noteSent(state.view);
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

/** Talking into a muted mic: say so once per mute, not again until you unmute and mute again. */
function mutedReminder() {
  if (!prefs.mutedWarning || state.mutedWarned) return;
  state.mutedWarned = true;
  playSound("muted");
  toast("You're muted. Press Ctrl+M or click the microphone to unmute.");
}

async function setMuted(muted) {
  if (muted !== state.muted) playSound(muted ? "mute" : "unmute");
  if (!muted) state.mutedWarned = false;
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
  const me = connected() ? state.roster.users.find((u) => u.session_id === state.roster.me) : null;
  if (me?.server_muted || me?.server_deafened) return toast("A moderator muted you here. They can unmute you.", true);
  if (state.deafened) {
    await setDeafened(false);
    if (state.muted) await setMuted(false);
  } else {
    await setMuted(!state.muted);
  }
});
$("deafen-btn").addEventListener("click", () => {
  const me = connected() ? state.roster.users.find((u) => u.session_id === state.roster.me) : null;
  if (me?.server_deafened) return toast("A moderator deafened you here. They can undo it.", true);
  setDeafened(!state.deafened);
});

// ---------- user settings ----------

function openSettings(tab) {
  syncThemePage();
  showTab(tab);
  renderSettingsMe();
  refreshDevices();
  renderProfilePreview();
  renderMicTest();
  renderSoundLog();
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
  if (state.me?.banner) paintBanner($("profile-banner"), state.me.banner, name);
  else {
    $("profile-banner").style.removeProperty("background-image");
    bannerFor = undefined;
    bannerFrom(picture);
  }
  renderBannerColors();
  if (typeof NAME_COLORS !== "undefined" && NAME_COLORS) renderNameColors();
  $("profile-avatar-slot").replaceChildren(avatar(name, "s80", undefined, picture));
  if (typeof renderAccountSettings === "function" && state.me !== undefined) renderAccountSettings();
  $("profile-name").textContent = name;
  // Your name as others see it in chat.
  styleName($("profile-name"), state.me?.key ?? state.account?.publicKey, name, false, "personal");
  $("profile-display").textContent = name;
  $("profile-handle").textContent = state.me?.username ? `@${state.me.username}` : "";
  const bio = state.me?.bio ?? "";
  $("profile-bio").textContent = bio || "Nothing yet. Say a little about yourself.";
  $("profile-bio").classList.toggle("muted", !bio);
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
  return (connected() && myVoice() !== null) || !!state.voiceAway;
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

/**
 * The microphone level only travels from Rust to this window while a meter can be seen (voice
 * settings, the mic check); the rest of the time it isn't sent at all.
 */
var meterWanted = null;
function syncMeter() {
  const want = [...document.querySelectorAll(".meter")].some((n) => n.checkVisibility?.() ?? n.offsetParent !== null);
  if (want === meterWanted) return;
  meterWanted = want;
  invoke("set_level_meter", { on: want }).catch(() => (meterWanted = null));
}
// At once when a meter comes into view, and a cheap look each second for when one goes away.
var meterWatch = new IntersectionObserver(syncMeter);
document.querySelectorAll(".meter").forEach((n) => meterWatch.observe(n));
setInterval(() => {
  // Asking whether a meter shows makes the browser work out styles: skip it when no window
  // that has one is open (and say no once, if it had been yes).
  if (!document.querySelector("dialog[open]") && !meterWanted) return;
  syncMeter();
}, 1000);

/**
 * Headphones can't echo: echo removal (the heaviest part of the microphone's processing) is
 * off while the sound goes to headphones or a headset, and on for speakers, if you have it on.
 */
var HEADPHONES = /headphone|headset|h[öo]rlur|earphone|earbud|airpods|buds|kopfh[öo]rer|casque|auricular|cuffie/i;
function applyEcho(list = state.deviceList) {
  const output = prefs.outputDevice || list?.default_output || "";
  const headphones = HEADPHONES.test(output) && !/speaker|h[öo]gtalare/i.test(output);
  state.echoForHeadphones = headphones;
  call("set_echo_cancellation", { on: prefs.echo && !headphones });
  const hint = $("echo-hint");
  if (hint) hint.hidden = !(prefs.echo && headphones);
}

/** Windows names a Bluetooth headset's call-mode endpoints "Hands-Free". */
function checkBluetooth(list) {
  const input = prefs.inputDevice || list.default_input || "";
  const output = prefs.outputDevice || list.default_output || "";
  $("bt-warning").hidden = !/hands-?free/i.test(input + " " + output);
}

async function refreshDevices() {
  const show = (list) => {
    state.deviceList = list;
    checkBluetooth(list);
    applyEcho(list);
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
// ---------- lowering other apps while people talk ----------
// While someone else talks (in voice or a call), the backend fades every other app down to
// the chosen share of its volume, and back up once they've been quiet for 1.5 s (short
// pauses between words don't make the music jump back up).

prefs.attenuate = load("attenuate", "0") === "1";
prefs.attenuateLevel = Number(load("attenuateLevel", "40"));
var attenuation = { on: false, timer: 0 };
/** Who is talking in a call right now (calls report it on their own). */
var callSpeaking = new Set();

function renderAttenuate() {
  $("attenuate").checked = prefs.attenuate;
  $("attenuate-level").value = prefs.attenuateLevel;
  $("attenuate-level-value").textContent = prefs.attenuateLevel + "%";
  $("attenuate-level-row").hidden = !prefs.attenuate;
}

/** After every change in who's talking: lower now, or put back after a short calm. */
function syncAttenuation() {
  const me = state.roster?.me;
  const inCall = state.call ? [...callSpeaking].some((id) => id !== state.call.me) : false;
  const others = prefs.attenuate && !state.deafened && (inCall || [...state.speaking].some((id) => id !== me));
  if (others) {
    clearTimeout(attenuation.timer);
    attenuation.timer = 0;
    if (!attenuation.on) {
      attenuation.on = true;
      invoke("set_attenuation", { on: true, level: prefs.attenuateLevel / 100 }).catch(() => {});
    }
  } else if (attenuation.on && !attenuation.timer) {
    attenuation.timer = setTimeout(() => {
      attenuation.timer = 0;
      attenuation.on = false;
      invoke("set_attenuation", { on: false, level: 1 }).catch(() => {});
    }, 1500);
  }
}

$("attenuate").addEventListener("change", (e) => {
  prefs.attenuate = e.target.checked;
  save("attenuate", prefs.attenuate ? "1" : "0");
  renderAttenuate();
  syncAttenuation();
});
$("attenuate-level").addEventListener("input", (e) => {
  prefs.attenuateLevel = Number(e.target.value);
  save("attenuateLevel", String(prefs.attenuateLevel));
  renderAttenuate();
  // Already lowered: it glides to the new level.
  if (attenuation.on) invoke("set_attenuation", { on: true, level: prefs.attenuateLevel / 100 }).catch(() => {});
});
renderAttenuate();

// ---------- keybinds for mute and deafen, anywhere ----------
// A key (with Ctrl, Shift or Alt if wanted) picked here works even while a game is in front;
// Hopp only ever looks at the keys picked. Kept on this computer (keyboards differ).

prefs.keybinds = loadJson("keybinds", {});
var recordingBind = null;

function renderKeybinds() {
  for (const id of ["mute", "deafen"]) {
    const box = $("bind-" + id);
    const bind = prefs.keybinds[id];
    box.classList.toggle("recording", recordingBind === id);
    box.textContent = recordingBind === id ? "Press a key… (Esc cancels)" : bind?.label || "Pick a key";
    box.classList.toggle("empty", !bind && recordingBind !== id);
    $("bind-" + id + "-clear").hidden = !bind || recordingBind === id;
  }
}

function applyKeybinds() {
  const binds = Object.entries(prefs.keybinds).filter(([, b]) => b?.key).map(([id, b]) => ({ id, key: b.key, mods: b.mods ?? 0 }));
  invoke("set_keybinds", { binds }).catch(() => {});
}

function saveKeybind(id, bind) {
  if (bind) {
    // One key does one thing: taken from the other action if it had it.
    for (const [other, b] of Object.entries(prefs.keybinds)) if (other !== id && b?.key === bind.key && (b.mods ?? 0) === (bind.mods ?? 0)) delete prefs.keybinds[other];
    prefs.keybinds[id] = bind;
  } else delete prefs.keybinds[id];
  save("keybinds", JSON.stringify(prefs.keybinds));
  applyKeybinds();
  renderKeybinds();
}

for (const id of ["mute", "deafen"]) {
  $("bind-" + id).addEventListener("click", (e) => {
    if (e.detail === 0) return;
    if (recordingBind === id) {
      recordingBind = null;
      invoke("cancel_ptt_recording");
    } else {
      if (recordingPtt) stopRecordingPtt();
      recordingBind = id;
      invoke("record_keybind");
    }
    renderKeybinds();
  });
  $("bind-" + id + "-clear").addEventListener("click", () => saveKeybind(id, null));
}
// While recording, the key belongs to the recorder, not to the page.
window.addEventListener("keydown", (e) => {
  if (!recordingBind) return;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);
listen("keybind-recorded", (e) => {
  const id = recordingBind;
  recordingBind = null;
  if (!id || e.payload.cancelled) return renderKeybinds();
  saveKeybind(id, { key: e.payload.key, mods: e.payload.mods ?? 0, label: e.payload.label });
});
listen("keybind", (e) => {
  if (e.payload === "mute") $("mute-btn").click();
  else if (e.payload === "deafen") setDeafened(!state.deafened);
});
renderKeybinds();
applyKeybinds();

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

/** The last sounds Hopp played and why, for "Recent sounds" in Notifications: no sound is a mystery. */
var soundLog = [];
var SOUND_WHY = {
  join: "You joined voice", leave: "You left voice", user_join: "Someone joined your voice channel", user_leave: "Someone left your voice channel",
  disconnect: "The connection to your voice channel was lost", message: "A new message", muted: "You talked while muted",
  mute: "You muted yourself", unmute: "You unmuted yourself", deafen: "You deafened yourself", undeafen: "You undeafened yourself",
  ring: "Someone is calling you", ringback: "You're calling someone",
};
function noteSound(name, why) {
  const text = why ?? SOUND_WHY[name];
  if (!text) return;
  const last = soundLog[0];
  // A ringing phone is one line, not one per ring.
  if (last && last.why === text && Date.now() - last.at < 5000) return void (last.at = Date.now());
  soundLog.unshift({ why: text, at: Date.now() });
  soundLog.length = Math.min(soundLog.length, 15);
  if ($("settings").open) renderSoundLog();
}
function renderSoundLog() {
  const list = $("sound-log");
  if (!list) return;
  if (!soundLog.length) {
    const li = el("li");
    li.append(el("span", "empty", "Nothing has played since Hopp started. Wondering about a sound? It will be listed here, with why."));
    return list.replaceChildren(li);
  }
  list.replaceChildren(...soundLog.map((x) => {
    const li = el("li");
    li.append(el("time", "", clock(x.at)), el("span", "why", x.why));
    return li;
  }));
}

function playSound(name, why) {
  const notes = SOUNDS[name];
  const isPtt = name.startsWith("ptt");
  const event = SOUND_EVENT_OF[name];
  if (!notes || !prefs.sounds || prefs.soundVolume === 0) return;
  if (state.me?.status === "dnd" && !isPtt && !["mute", "unmute", "deafen", "undeafen"].includes(name)) return;
  if (event && !soundOn(event)) return;
  if (state.deafened && prefs.quietDeafened && ["others", "message"].includes(event)) return;
  if (!isPtt) noteSound(name, why);
  try {
    soundCtx ??= new AudioContext();
    // Started before any click (Hopp opened by itself with Windows, a call coming in while it
    // sits in the tray), the page's sound may still be paused: wake it, or the ring is silent.
    if (soundCtx.state === "suspended") soundCtx.resume().catch(() => {});
    if (prefs.soundStyle !== "classic" && HOPP_SOUNDS[name]) return playHoppSound(name, prefs.soundVolume / 100);
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
        names.forEach((n, i) => setTimeout(() => {
          const was = prefs.soundEvents[key];
          prefs.soundEvents[key] = true;
          playSound(n);
          prefs.soundEvents[key] = was;
        }, i * (n.startsWith("ring") ? 1300 : 650)));
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
      if (prefs.sounds) playSound("join", "You turned sounds on");
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
soundVolume.addEventListener("change", () => playSound("user_join", "You changed the sound volume"));

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
    if (key === "echo") applyEcho();
    else call(cmd, { on: prefs[key] });
  });
}

// Out of sight (minimized, closed to the notification area): give memory back until you look again.
document.addEventListener("visibilitychange", () => invoke("set_memory_low", { low: document.hidden }).catch(() => {}));

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
  applyEcho();
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
  // A closed emoji picker lets go of its buttons, once it is still closed a moment later
  // (opening a popover closes the others first, the picker included).
  setTimeout(() => {
    const pop = document.getElementById("emoji-picker");
    if (pop?.hidden && pop.childElementCount) pop.replaceChildren();
  }, 0);
  const sub = document.getElementById("server-submenu");
  if (sub) sub.hidden = true;
  $("sidebar-head").classList.remove("open");
}

/**
 * An open modal (settings, say) sits in the browser's top layer, above everything in the page;
 * a menu opened from inside it has to live in it too, or it opens unseen behind it.
 */
function popoverHost(pop) {
  const modal = [...document.querySelectorAll("dialog[open]")].filter((d) => d.matches(":modal")).pop();
  const host = modal ?? document.body;
  if (pop.parentElement !== host) host.append(pop);
}

function placePopover(pop, x, y) {
  closePopovers();
  popoverHost(pop);
  if (pop.id === "server-menu") popoverHost($("server-submenu"));
  pop.style.width = "";
  pop.hidden = false;
  pop.style.left = `${Math.max(8, Math.min(x, window.innerWidth - pop.offsetWidth - 8))}px`;
  pop.style.top = `${Math.max(8, Math.min(y, window.innerHeight - pop.offsetHeight - 8))}px`;
}

function applyUserVolumes() {
  // Volumes are for the people you're in voice with; while that's in another server, theirs stay.
  if (!state.roster || state.voiceAway) return;
  for (const u of state.roster.users) {
    // Someone a moderator muted is silent for everyone; back to your setting when it's lifted.
    let vol = isBlocked(keyOf(u)) || u.server_muted ? 0 : userVolume(u);
    if (vol === undefined && state.appliedVolumes.has(u.session_id)) vol = 100;
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
  paintBanner($("user-card-banner"), bannerOf(keyOf(user)), user.name);
  const k = keyOf(user);
  if (k && k !== state.account?.publicKey && (!profiles.get(k) || Date.now() - profiles.get(k).at > 30_000)) {
    Promise.resolve(loadProfile(k)).then(() => cardUser === user && !$("user-card").hidden && openUserCard(user, anchor));
  }
  $("user-card-avatar-slot").replaceChildren(avatar(user.name, "s80", undefined, pictureFor(keyOf(user))));
  $("user-card-name").textContent = user.name;
  styleName($("user-card-name"), keyOf(user), user.name, false);
  const sub = $("user-card-sub");
  if (user.voice_channel !== null) sub.replaceChildren(icon("volume", "sm"), el("span", "", `In ${channelName(user.voice_channel)}`));
  else sub.replaceChildren(el("span", "", roleOf(user) ? (roleOf(user) === "owner" ? "Server owner" : ROLE_LABEL[roleOf(user)]) : "Online"));
  renderUserRole(user);
  renderCardActions(user);
  const real = accountNameOf(user);
  $("user-card-realname").textContent = real ?? "";
  $("user-card-realname").hidden = !real;
  // What they wrote about themselves, when known.
  const bio = (keyOf(user) === state.account?.publicKey ? state.me?.bio : profiles.get(keyOf(user))?.bio) ?? "";
  $("user-card-bio").textContent = bio;
  $("user-card-bio").hidden = !bio;
  const cs = keyOf(user) === state.account?.publicKey ? liveStatus(state.me?.custom_status) : customStatusOf(keyOf(user));
  $("user-card-status").replaceChildren(...(cs ? statusParts(cs) : []));
  $("user-card-status").hidden = !cs;
  syncUserCard();
  // Open beside the row, like a profile card.
  const r = anchor.getBoundingClientRect();
  const card = $("user-card");
  card.hidden = false;
  const x = r.left > window.innerWidth / 2 ? r.left - card.offsetWidth - 12 : r.right + 12;
  placePopover(card, x, r.top);
}

function syncUserCard() {
  const roles = (state.roster?.roles ?? []).filter((r) => cardUser?.roles?.includes(r.id));
  $("user-card-roles").hidden = !roles.length;
  $("user-card-roles").replaceChildren(...roles.map((r) => {
    const chip = el("span", "role-chip");
    const dot = el("i", "role-dot");
    dot.style.background = r.color ?? "var(--faint)";
    chip.append(dot, r.name);
    return chip;
  }));
  // In voice with us: how the connection to them is.
  const q = cardUser.voice_channel !== null && cardUser.voice_channel === myVoice() ? state.quality.get(cardUser.session_id) : undefined;
  const line = $("user-card-connection");
  line.hidden = !q;
  if (q) {
    line.className = "user-card-connection " + connectionGrade(q);
    line.replaceChildren(signalBars(connectionGrade(q)), el("span", "", connectionText(q)));
  }
}

/** The card's one way onward: write to them, or become friends first. */
function renderCardActions(user) {
  const box = $("user-card-actions");
  const key = keyOf(user);
  const friend = key ? state.friends?.get(key) : null;
  const button = (label, primary, onClick) => {
    const b = el("button", "btn full" + (primary ? " primary" : ""), label);
    b.type = "button";
    b.addEventListener("click", () => {
      closePopovers();
      onClick();
    });
    return b;
  };
  const items = [];
  if (user.session_id !== state.roster?.me && key) {
    if (friend?.state === "friend") items.push(button("Message", true, () => openDm(key)));
    else if (friend?.state === "incoming") items.push(button("Accept friend request", true, () => accountSend({ type: "friend_accept", key }).catch(() => {})));
    else if (friend?.state === "outgoing") items.push(el("span", "user-card-note", "Friend request sent"));
    else if (friend?.state !== "blocked") items.push(button("Add friend", false, () => accountSend({ type: "friend_request", key }).then(() => toast(`Friend request sent to ${user.name}.`), () => {})));
  }
  box.replaceChildren(...items);
  box.hidden = !items.length;
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

async function removeUser(ban, user = cardUser) {
  closePopovers();
  const history = ban && modTools();
  const ok = await confirmDialog(
    ban
      ? {
          title: `Ban ${user.name}`,
          text: `${user.name} is disconnected and can never rejoin with this Hopp ID, not even with an invite. You can undo this in Server settings.`,
          ok: "Ban",
          choice: history ? { label: "Delete their messages", options: [["0", "Don't delete any"], ["1", "From the last hour"], ["24", "From the last 24 hours"], ["168", "From the last 7 days"]] } : null,
        }
      : { title: `Kick ${user.name}`, text: `${user.name} is taken out of the server right away. They need a new invite to come back.`, ok: "Kick" },
  );
  // Someone who isn't here right now is removed by their Hopp ID.
  const away = user.offline || !(user.session_id > 0);
  if (ok) call("kick", { sessionId: away ? 0 : user.session_id, publicKey: away ? user.public_key : null, ban, deleteHours: history ? Number(confirmDialog.choice) : null });
}

$("user-role").addEventListener("change", (e) => {
  const user = cardUser;
  setRole({ public_key: user.public_key, name: user.name }, e.target.value || null);
});
$("user-transfer").addEventListener("click", () => {
  const user = cardUser;
  closePopovers();
  transferOwnership({ public_key: user.public_key, name: user.name });
});
document.addEventListener("mousedown", (e) => {
  if ([...document.querySelectorAll(".popover")].some((p) => !p.hidden && p.contains(e.target))) return;
  if (e.target.closest("#sidebar-head, .split-more")) return;
  closePopovers();
});

// ---------- no tooltips ----------
//
// Hopp shows no tooltips: nothing pops up on hover. What a button does stays in its words for
// screen readers (its data-tip becomes its aria-label).

document.addEventListener("mouseover", (e) => {
  const target = e.target.closest("[data-tip]");
  if (target?.dataset.tip && !target.getAttribute("aria-label")) target.setAttribute("aria-label", target.dataset.tip);
});

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
      warmServersSoon();
      state.me = m.me;
      state.friends = new Map(m.friends.map((f) => [f.key, f]));
      state.conversations = new Map((m.conversations ?? []).map((c) => [c.peer, { last_at: c.last_at, last_read: c.last_read }]));
      for (const row of m.channels ?? []) mergeRead(row);
      state.groups = new Map((m.groups ?? []).map((g) => [g.id, g]));
      for (const g of state.groups.values()) if (!state.conversations.has(g.id)) state.conversations.set(g.id, { last_at: g.created_at, last_read: g.created_at });
      state.readsLoaded = true;
      state.inbox = m.inbox ?? [];
      state.inboxSeen = m.inbox_seen ?? 0;
      state.accountFeatures = m.features ?? [];
      tellAccountServers(true);
      renderInboxBadge();
      renderUnread();
      // A reconnect: fetch what arrived meanwhile for conversations already open.
      for (const peer of state.dmMessages.keys()) invoke("account_send", { msg: { type: "dm_history", with: peer } }).catch(() => {});
      syncState.version = m.sync.version;
      receiveSync(m.sync.data);
      // A Hopp ID made before usernames: ask once (it can wait).
      if (!m.me.username && !usernameAsked && !state.onboarding && !$("shell").classList.contains("locked")) {
        usernameAsked = true;
        openUsernameDialog(true);
      }
      setActivityFromVoice();
      break;
    case "inbox":
      state.inbox = m.items ?? [];
      renderInboxBadge();
      if (!$("inbox-pop").hidden) renderInbox();
      return;
    case "inbox_seen":
      state.inboxSeen = Math.max(state.inboxSeen, m.at);
      renderInboxBadge();
      return;
    case "channel_activity": {
      const fresh = mergeRead(m);
      if (fresh) notifyMention({ server: m.server, channel: m.channel, author_key: m.author_key, author_name: m.author_name, channel_name: m.channel_name, text: m.preview ? previewText(m.preview) : "Mentioned you", mention: m.mention && !(m.crowd && crowdQuiet(m.server)) });
      if (m.mention) addToInbox(m);
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
      if ($("settings").open) renderProfilePreview();
      if ($("username-dialog").open && m.me.username) $("username-dialog").close();
      if ($("welcome-dialog").open) renderWelcomeAvatar();
      break;
    case "status":
      state.me.status = m.status;
      if (online()) renderMembers();
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
      if (before?.avatar !== m.friend.avatar || (before?.name_color ?? null) !== (m.friend.name_color ?? null)) {
        renderPictures();
        if (state.openDm) renderDmAreas(state.openDm);
      }
      if (m.request) {
        toast(`${m.friend.display_name} (@${m.friend.username}) sent you a friend request.`);
        playSound("user_join", m.friend.display_name + " sent you a friend request");
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
      if (f) Object.assign(f, { status: m.status, activity: m.activity, voice: m.voice ?? null });
      if (f && online()) renderMembers();
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
  // "In voice", and where: only a Hopp Cloud server's id and the channel's number. Friends in
  // that server too see where and can join; others just see "In voice". A LAN server's
  // address is never shared (it would show where you are on your network).
  const activity = inVoice() ? "In voice" : null;
  const away = awayVoice();
  const server = away ? away.server : activeServer();
  const channel = away ? away.channel : myVoice();
  const voice = activity && server && isCloud(server) && channel !== null ? server.address + "#" + channel : null;
  const key = activity + "|" + voice;
  if (key === lastActivity || !state.accountConnected) return;
  lastActivity = key;
  invoke("account_send", { msg: { type: "set_activity", activity, voice } }).catch(() => {});
}

const STATUS_LABEL = { online: "Online", idle: "Idle", dnd: "Do Not Disturb", invisible: "Invisible", offline: "Offline" };

/**
 * Away from the computer for a while (no key or mouse anywhere): Idle by itself, like Discord,
 * and Online again once you're back. Only from Online, and only what it set itself: a status
 * you picked (Idle, Do Not Disturb, Invisible) stays as it is.
 */
var AUTO_IDLE_AFTER = 10 * 60;
var autoIdle = false;
async function checkAway() {
  if (!state.accountConnected || !state.me) return;
  let away;
  try {
    away = await invoke("idle_seconds");
  } catch {
    return;
  }
  if (typeof away !== "number") return;
  const status = state.me.status ?? "online";
  if (!autoIdle && status === "online" && away >= AUTO_IDLE_AFTER) {
    autoIdle = true;
    accountSend({ type: "set_status", status: "idle" }).catch(() => (autoIdle = false));
  } else if (autoIdle && status === "idle" && away < 60) {
    autoIdle = false;
    accountSend({ type: "set_status", status: "online" }).catch(() => {});
  } else if (autoIdle && status !== "idle") {
    // Changed somewhere else (another device, the menu): not ours any more.
    autoIdle = false;
  }
}
setInterval(checkAway, 20000);

function openStatusMenu(x, y) {
  const current = state.me?.status ?? "online";
  const item = (status, sub) => ({
    label: STATUS_LABEL[status],
    sub,
    swatch: { online: "var(--green)", idle: "var(--yellow)", dnd: "var(--red)", invisible: "var(--faint)" }[status],
    checked: current === status,
    action: () => {
      autoIdle = false;
      accountSend({ type: "set_status", status }).catch(() => {});
    },
  });
  openMenu(
    [
      { heading: "Status" },
      item("online"),
      item("idle"),
      item("dnd"),
      item("invisible"),
      "sep",
      liveStatus(state.me?.custom_status)
        ? { label: statusLine(state.me.custom_status), sub: "Change your custom status", icon: "edit", action: openStatusDialog }
        : { label: "Set a custom status", icon: "smile", action: openStatusDialog },
      ...(liveStatus(state.me?.custom_status) ? [{ label: "Clear custom status", icon: "x", action: () => setCustomStatus(null) }] : []),
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
  top.append(styleName(el("strong", "ellipsis", f.display_name), f.key, f.display_name, false, "personal"));
  if (f.username) top.append(el("span", "friend-username ellipsis", `@${f.username}`));
  const sub =
    f.state === "incoming" ? "Wants to be friends"
    : f.state === "outgoing" ? "Request sent"
    : f.state === "blocked" ? "Blocked"
    : f.status !== "offline" && customStatusOf(f.key) ? statusLine(customStatusOf(f.key))
    : f.activity && f.status !== "offline" ? whereText(f)
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
  const handle = el("span", "", "@" + state.me.username);
  handle.dataset.private = "";
  mine.append("Your username is ", handle, " · ", copy);
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
    const picture = await adjustPicture(file, { shape: "circle", title: "Adjust your picture", sizes: [[128, 0.85], [128, 0.7], [96, 0.7], [64, 0.7]], limit: 38_000 });
    if (!picture) return;
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
    settings: { at: Number(load("settingsAt", "0")), values: settingValues() },
  };
}

/** The synced settings as saved here (only the ones ever set). */
function settingValues() {
  const values = {};
  for (const k of SYNCED_SETTINGS) {
    try {
      const v = localStorage.getItem(k);
      if (v !== null) values[k] = v;
    } catch {
      // Storage unavailable: nothing to send.
    }
  }
  return values;
}

/** Takes the account's settings from another device: saved here, then shown at once. */
function applySyncedSettings(remote) {
  applyingSettings = true;
  try {
    for (const k of SYNCED_SETTINGS) {
      try {
        if (k in remote.values) localStorage.setItem(k, remote.values[k]);
        else localStorage.removeItem(k);
      } catch {
        // Storage unavailable.
      }
    }
    save("settingsAt", String(remote.at));
    prefs.theme = load("theme", "mid");
    prefs.custom = { a: load("themeColor", "#3b4a46"), b: null, contrast: 50, saturation: 50, ...JSON.parse(load("themeCustom", "{}") || "{}") };
    prefs.custom.mode ??= hexToHsl(prefs.custom.a)[2] > 60 ? "light" : "dark";
    prefs.chatSize = Number(load("chatSize", "15"));
    prefs.chatSpace = Number(load("chatSpace", "18"));
    prefs.compact = load("chatCompact", "0") === "1";
    $("chat-compact").checked = prefs.compact;
    prefs.appFont = load("appFont", "inter");
    $("app-font").value = APP_FONTS[prefs.appFont] ? prefs.appFont : "inter";
    applyTheme();
    syncThemePage();
    prefs.linkPreviews = load("linkPreviews", "1") === "1";
    $("link-previews").checked = prefs.linkPreviews;
    prefs.desktopNotify = load("desktopNotify", "1") === "1";
    prefs.notifyText = load("notifyText", "1") === "1";
    $("desktop-notify").checked = prefs.desktopNotify;
    $("notify-text").checked = prefs.notifyText;
    $("notify-text").disabled = !prefs.desktopNotify;
    prefs.sounds = load("sounds", "1") === "1";
    $("sounds").checked = prefs.sounds;
    prefs.soundStyle = load("soundStyle", "hopp");
    document.querySelectorAll("[data-sound-style]").forEach((b) => b.classList.toggle("active", b.dataset.soundStyle === prefs.soundStyle));
    prefs.soundVolume = Number(load("soundVolume", "50"));
    $("sound-volume").value = prefs.soundVolume;
    $("sound-volume-value").textContent = `${prefs.soundVolume}%`;
    prefs.soundEvents = loadJson("soundEvents", {});
    renderSoundEvents();
    const hideIp = load("hideIp", "0") === "1";
    if (hideIp !== prefs.hideIp) invoke("set_private_route", { on: hideIp }).catch(() => {});
    prefs.hideIp = hideIp;
    $("hide-ip").checked = hideIp;
    prefs.shareSound = load("shareSound", "1") === "1";
    prefs.userVolumes = loadJson("userVolumes", {});
    prefs.attenuate = load("attenuate", "0") === "1";
    prefs.attenuateLevel = Number(load("attenuateLevel", "40"));
    renderAttenuate();
    syncAttenuation();
  } finally {
    applyingSettings = false;
  }
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
      quiet: { ...remote.notify.quiet },
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
      // Settings: the newest change wins; a device that never changed any (new, or just
      // restored) takes the account's.
      const localAt = Number(load("settingsAt", "0"));
      if (remote.settings?.values && (remote.settings.at > localAt || localAt === 0)) applySyncedSettings(remote.settings);
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
    // Your own message is read here (the cloud knows); one you're looking at is marked
    // read below, which also tells the cloud, so it doesn't come back as unread.
    if (mine) conv.last_read = conv.last_at;
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
  playSound("message", (who.group && from ? personFor(from).display_name + " wrote in " + who.display_name : who.display_name + " sent you a message"));
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
  if ((!prefs.notifyText || streamer.on) && /^(dm|channel):/.test(action) && !/friend request/.test(body)) body = "Sent a message";
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

// ---------- friends who wrote, under the Hopp button ----------
//
// Someone you haven't answered shows right under Home, like Discord's: their picture and how
// many messages wait. A click opens the conversation; reading it takes them away again.

var DM_PEEKS = 4;
var peeksShown = new Set();

/** Draws them; returns how many conversations are shown this way. */
function renderDmPeeks() {
  const box = $("dm-peeks");
  if (!box) return 0;
  const me = state.me?.key;
  const waiting = [...(state.conversations ?? [])]
    .filter(([peer, c]) => c.last_at > c.last_read && !dmMuted(peer) && (isGroup(peer) ? state.groups?.has(peer) : state.friends?.get(peer)?.state !== "blocked"))
    .sort((a, b) => b[1].last_at - a[1].last_at);
  const shown = waiting.slice(0, DM_PEEKS);
  const nodes = shown.map(([peer, c]) => {
    const person = personFor(peer);
    const b = el("button", "rail-item dm-peek" + (peeksShown.has(peer) ? "" : " fresh"));
    b.type = "button";
    b.dataset.dm = peer;
    b.setAttribute("aria-label", "Unread messages from " + person.display_name);
    const face = personAvatar(person, "", false);
    face.classList.add("rail-icon");
    b.append(face);
    // How many, when the messages are here; at least the one we know of.
    const count = (state.dmMessages.get(peer) ?? []).filter((m) => m.sent_at > c.last_read && m.from_key !== me).length;
    railBadge(b, Math.max(1, count));
    b.addEventListener("click", () => {
      state.atNews = false;
      openDm(peer);
    });
    return b;
  });
  if (waiting.length > shown.length) {
    const more = el("button", "rail-item dm-peek more");
    more.type = "button";
    more.setAttribute("aria-label", (waiting.length - shown.length) + " more unread conversations");
    more.append(el("span", "rail-icon", "+" + (waiting.length - shown.length)));
    more.addEventListener("click", () => $("home-btn").click());
    nodes.push(more);
  }
  peeksShown = new Set(shown.map(([peer]) => peer));
  box.replaceChildren(...nodes);
  return shown.length;
}

function renderHomeBadge() {
  // Conversations shown under the button speak for themselves; the badge is for the rest.
  const n = unreadDms() - renderDmPeeks() + [...(state.friends?.values() ?? [])].filter((f) => f.state === "incoming").length;
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
      text.append(p.group ? el("span", "row-title ellipsis", p.display_name) : styleName(el("span", "row-title ellipsis", p.display_name), p.key, p.display_name, false, "personal"));
      if (p.group) text.append(el("span", "row-sub ellipsis", `${state.groups.get(peer).members.length} members`));
      else if (p.status !== "offline" && customStatusOf(p.key)) text.append(el("span", "row-sub ellipsis", statusLine(customStatusOf(p.key))));
      else if (p.activity && p.status !== "offline") text.append(el("span", "row-sub ellipsis", whereText(p)));
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
  videosIn("dm|" + peer);
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
        (picked, e) => {
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
    row.append(attach, file, input, emoji, sendButton());
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
    const grouped = !prefs.compact && !newDay && prev.from_key === m.from_key && m.sent_at - prev.sent_at < GROUP_WINDOW_MS;
    const li = el("li", "msg " + (grouped ? "cont" : "first") + (m.pending ? " pending" : "") + (m.failed ? " failed" : ""));
    if (grouped) li.append(el("span", "msg-gutter", clock(m.sent_at)));
    else {
      const author = personFor(m.from_key);
      const headLine = el("div", "msg-head");
      const name = el("span", "msg-author", author.display_name);
      styleName(name, m.from_key, author.display_name, false, "personal");
      headLine.append(el("span", "msg-clock", clock(m.sent_at)), name, el("span", "msg-time", `${day} at ${clock(m.sent_at)}`));
      li.append(personAvatar(author, "s40", false), headLine);
    }
    if (state.dmEditing === m.id) {
      li.append(dmEditor(peer, m));
    } else if (m.text !== null && forwardParts(m.text)) {
      li.append(forwardView(forwardParts(m.text)));
    } else if (m.text !== null && FILE_OFFER.test(m.text)) {
      li.append(fileCard(peer, m));
    } else if (m.text !== null && DM_PICTURE.test(m.text)) {
      const [whole, owner, id, key, w, h] = m.text.match(DM_PICTURE);
      const caption = m.text.slice(whole.length).trim();
      if (caption) li.append(messageText(caption));
      li.append(dmPictureView(owner, id, key, Number(w), Number(h)));
    } else if (m.text !== null && GIF_URL.test(m.text.trim())) {
      li.append(gifNode(m.text.trim()));
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
    if (!m.pending && !m.failed && m.text !== null) {
      const own = m.from_key === state.me?.key;
      const acts = dmActions(peer, m);
      if (acts.childElementCount) li.append(acts);
      li.msg = m;
      li.addEventListener("contextmenu", (e) => {
        if (window.getSelection()?.toString()) return;
        e.preventDefault();
        const current = e.currentTarget.msg;
        const copyText = () => navigator.clipboard.writeText(previewText(current.text)).then(() => toast("Text copied."), () => toast("Couldn't copy.", true));
        openMenu(
          [
            ...(canForward(current.text) ? [{ label: "Forward", icon: "forward", action: () => forwardDm(peer, current) }] : []),
            ...(own && dmEditable(current) ? [{ label: "Edit message", icon: "edit", action: () => startDmEdit(peer, current) }] : []),
            { label: "Copy text", icon: "copy", action: copyText },
            ...(own ? ["sep", { label: "Delete message", icon: "trash", danger: true, action: () => deleteDm(peer, current) }] : []),
          ],
          e.clientX,
          e.clientY,
        );
      });
    }
    li.dataset.key = `${peer}|${m.id}`;
    li.dataset.sig = JSON.stringify([grouped, day, m.text, m.edited_at, m.pending, m.failed, state.dmEditing === m.id, m.from_key, personFor(m.from_key).avatar ?? null, personFor(m.from_key).display_name, prefs.linkPreviews, rawNameStyle(m.from_key)]);
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
  // Hopp's own emojis work here; a server's wouldn't show for someone who isn't in it.
  const text = encodeEmojis(input.value.trim(), false);
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
  if (!state.account) return false;
  if (text.includes(`<@${state.account.publicKey}>`)) return true;
  if (!pingsOn()) return false;
  const mine = meUser()?.roles ?? [];
  for (const [, id] of text.matchAll(/<@&(\d+)>/g)) if (mine.includes(Number(id))) return true;
  return CROWD_WORD.test(text) && !crowdQuiet(currentServer()?.address);
}

/** A message that mentions you or answers one of yours. */
function mentionsMeIn(m) {
  return mentionsMe(m.text) || (!!m.reply && m.reply.author_key === state.account?.publicKey);
}

/** Message text as a person would read it: mentions become @names. */
function plainText(text) {
  return text.replace(MENTION, (_, key) => `@${nameForKey(key)}`).replace(/<@&(\d+)>/g, (_, id) => `@${roleById(Number(id))?.name ?? "deleted-role"}`);
}

/** One line of plain text for previews and notifications: no formatting marks, spoilers hidden. */
function previewText(text) {
  text = emojiWords(text);
  const forwarded = forwardParts(text);
  if (forwarded) return "Forwarded: " + previewText(forwarded.text);
  const poll = pollOf(text);
  if (poll) return "📊 " + (poll.question || "Poll");
  if (VOICE_MESSAGE.test(text)) return "🎤 Voice message";
  if (FILE_OFFER.test(text)) return `📎 ${text.match(FILE_OFFER)[3]}`;
  if (DM_PICTURE.test(text)) return text.slice(text.match(DM_PICTURE)[0].length).trim() || "Image";
  if (PICTURE.test(text)) return text.slice(text.match(PICTURE)[0].length).trim() || "Image";
  if (GIF_URL.test(text.trim())) return "GIF";
  return plainText(text)
    .replace(/\|\|[\s\S]+?\|\|/g, "(spoiler)")
    .replace(/```[a-z0-9+#-]*\n?/gi, "")
    .replace(/^> ?/gm, "")
    .replace(/^(?:#{1,3}|-#) /gm, "")
    .replace(/\[([^\]\n]{1,100})\]\((https?:\/\/[^\s)]{1,500})\)/g, "$1")
    .replace(/\*\*|~~|__|`|\*|\b_|_\b/g, "")
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
  if (isVoiceChannel(m.channel)) return false;
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
  if (isVoiceChannel(channel)) return;
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
  if (!online() || state.view === null || !document.hasFocus() || isVoiceChannel(state.view)) return;
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
  playSound("message", author_name + (mention ? " mentioned you in #" : " wrote in #") + channel_name + ", " + s.label);
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
  if (p?.loading || !/^[0-9a-f]{64}$/.test(key)) return p?.loading || null;
  const loading = invoke("fetch_profile", { cloud: prefs.cloudUrl.replace(/^ws/, "http"), key }).then(
    (r) => {
      const changed = (p?.avatar ?? null) !== (r.avatar ?? null) || p?.display_name !== r.display_name || (p?.name_color ?? null) !== (r.name_color ?? null);
      const statusChanged = JSON.stringify(p?.custom_status ?? null) !== JSON.stringify(r.custom_status ?? null);
      profiles.set(key, { avatar: r.avatar ?? null, display_name: r.display_name, username: r.username, bio: r.bio ?? "", custom_status: r.custom_status ?? null, banner: r.banner ?? null, name_color: r.name_color ?? null, at: Date.now() });
      if (changed || statusChanged) renderPictures();
    },
    () => profiles.set(key, { ...(p ?? { avatar: null }), loading: false, at: Date.now() }),
  );
  profiles.set(key, { ...(p ?? { avatar: null }), loading, at: Date.now() });
  return loading;
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
  out.unshift(...crowdCandidates(q));
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
    if (item.emoji) row.append(emojiText(item.emoji, "mention-emoji"), el("span", "mention-name ellipsis", `:${item.name}:`));
    else if (item.crowd) row.append(el("span", "mention-at", "@"), el("span", "mention-name ellipsis", "@" + item.name));
    else if (item.role) {
      const dot = el("span", "mention-at role");
      dot.style.setProperty("--role", item.role.color ?? "var(--faint)");
      dot.append(icon("shield"));
      row.append(dot, el("span", "mention-name ellipsis", "@" + item.name));
    } else row.append(avatar(item.name, "s24", undefined, pictureFor(item.key)), el("span", "mention-name ellipsis", item.name));
    if (item.username) row.append(el("span", "mention-user ellipsis", item.username));
    row.addEventListener("mouseenter", () => {
      mentionPicker.index = i;
      pop.querySelectorAll(".mention-option").forEach((n, j) => n.classList.toggle("active", j === i));
    });
    row.addEventListener("click", () => pickMention(item));
    return row;
  });
  pop.replaceChildren(el("div", "mention-head", items[0]?.emoji ? "Emoji" : items.some((i) => i.crowd || i.role) ? "Mentions" : "Members"), ...rows);
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
  // @everyone and @here are words of their own; nothing to swap on sending.
  if (item.crowd) {
    chatInput.value = chatInput.value.slice(0, mentionPicker.start) + label + " " + chatInput.value.slice(end);
    const at = mentionPicker.start + label.length + 1;
    chatInput.setSelectionRange(at, at);
    mentionPicker.open = false;
    $("mention-picker").hidden = true;
    chatInput.focus();
    autosize();
    return;
  }
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
    const b = el("button", "icon-btn sm quick-react" + (mine ? " on" : ""));
    b.append(emojiNode(emoji));
    b.type = "button";
    b.dataset.tip = mine ? `Remove ${emoji}` : `React ${emoji}`;
    b.addEventListener("click", () => react(m, emoji, !mine));
    actions.append(b);
  }
  // Quick reactions on the left, what you can do with the message on the right.
  actions.append(el("span", "msg-actions-gap"));
  button("smile", "Add reaction", (e) => openEmojiPicker(e.currentTarget, (emoji) => react(m, emoji, true)));
  button("reply", "Reply", () => setReply(m));
  if (canForward(m.text)) button("forward", "Forward", () => forwardMessage(m));
  if (m.author_key === state.account?.publicKey && !PICTURE.test(m.text) && !FORWARD.test(m.text) && !POLL.test(m.text) && !VOICE_MESSAGE.test(m.text)) button("edit", "Edit", () => startEdit(m));
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
  if (online() && id < (state.drawFrom.get(state.view) ?? 0) && state.chats.get(state.view)?.some((m) => m.id === id)) {
    state.drawFrom.set(state.view, id);
    const scroller = $("scroller");
    const fromBottom = scroller.scrollHeight - scroller.scrollTop;
    renderMessages(true);
    scroller.scrollTop = scroller.scrollHeight - fromBottom;
  }
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

// ---------- custom emojis ----------
//
// Written <:name:id> in messages and reactions. Id 0: one of Hopp's own (built into the app,
// so they work everywhere, DMs too); any other id: one of this server's, uploaded by its admins.
// In the message box they're typed :name: and turned into the token on sending.

var CUSTOM_EMOJI = /<:([a-z0-9_]{2,32}):(\d{1,9})>/;
var CUSTOM_EMOJI_ALL = /<:([a-z0-9_]{2,32}):(\d{1,9})>/g;
/** A message of only emojis (custom ones) shows them big. */
// A message of nothing but emojis (the server's own or ordinary ones), up to 27: shown big.
var ONLY_EMOJI = /^\s*(?:(?:<:[a-z0-9_]{2,32}:\d{1,9}>|(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[0-9#*]\uFE0F\u20E3)(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic}\uFE0F?)*)\s*){1,27}$/u;

/** This server's emojis, when it has any. */
function serverEmojis() {
  return online() && state.roster?.features?.includes("emojis") ? state.roster.emojis ?? [] : [];
}

/** The picture for a token's emoji, or null when it isn't known here (another server's). */
function emojiUrl(name, id) {
  if (Number(id) === 0) return window.HOPP_EMOJI?.[name] ?? null;
  const e = serverEmojis().find((x) => x.id === Number(id));
  return e ? pictureUrl(e.image) : null;
}

/** An emoji to show: a picture for a custom one (its name when unknown here), or the character. */
function emojiNode(emoji, cls = "custom-emoji") {
  const m = typeof emoji === "string" && emoji.match(CUSTOM_EMOJI);
  if (!m || m[0] !== emoji) {
    if (typeof emoji !== "string" || !emoji.match(EMOJI_RUN)) return document.createTextNode(emoji ?? "");
    const frag = document.createDocumentFragment();
    appendText(frag, emoji);
    return frag;
  }
  const url = emojiUrl(m[1], m[2]);
  if (!url) return el("span", "custom-emoji-name", ":" + m[1] + ":");
  const img = el("img", cls);
  img.src = url;
  img.alt = ":" + m[1] + ":";
  img.draggable = false;
  return img;
}

/** How an emoji reads in words (notifications, previews): ":name:" for custom ones. */
function emojiWords(text) {
  return String(text).replace(CUSTOM_EMOJI_ALL, (_, name) => ":" + name + ":");
}

/** ":name:" typed in a message becomes the emoji, if there is one by that name (Hopp's own, or
 *  this server's when `withServer`). Code is left alone. */
function encodeEmojis(text, withServer = true) {
  const mine = withServer ? serverEmojis() : [];
  return text.replace(/(```[\s\S]*?```|`[^`\n]*`)|(?<![<\w]):([a-z0-9_]{2,32}):(?!\d)/g, (all, code, name) => {
    if (code) return code;
    const own = mine.find((e) => e.name === name);
    if (own) return "<:" + name + ":" + own.id + ">";
    if (window.HOPP_EMOJI?.[name]) return "<:" + name + ":0>";
    return all;
  });
}

function reactionRow(m) {
  const row = el("div", "reactions");
  const me = state.account?.publicKey;
  for (const r of m.reactions.filter((x) => !x.emoji.startsWith("poll:"))) {
    const mine = r.keys.includes(me);
    const chip = el("button", "reaction" + (mine ? " mine" : ""));
    chip.type = "button";
    const face = el("span", "reaction-emoji");
    face.append(emojiNode(r.emoji));
    chip.append(face, el("span", "reaction-count", String(r.keys.length)));
    chip.dataset.tip = reactedWords(r);
    chip.reaction = r;
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

/** The send arrow at the end of a message box: does what Enter does there. */
function sendButton() {
  const b = el("button", "composer-icon send-btn");
  b.type = "button";
  b.dataset.tip = "Send";
  b.setAttribute("aria-label", "Send");
  b.append(icon("send"));
  return b;
}
document.addEventListener("mousedown", (e) => e.target.closest?.(".send-btn") && e.preventDefault());
document.addEventListener("click", (e) => {
  const input = e.target.closest?.(".send-btn")?.parentElement.querySelector("textarea");
  if (!input) return;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  input.focus();
});

/** "Elin, Sam and 3 others reacted with :gg:" (a plain emoji is said as itself). */
function reactedWords(r) {
  const names = r.keys.slice(0, 3).map((k) => (k === state.account?.publicKey ? "You" : nameForKey(k)));
  const more = r.keys.length - names.length;
  const who = more > 0 ? names.join(", ") + ` and ${more} ${more === 1 ? "other" : "others"}` : names.length > 1 ? names.slice(0, -1).join(", ") + " and " + names.at(-1) : names[0];
  return `${who} reacted with ${emojiWords(r.emoji)}`;
}

// Hovering a reaction shows which emoji it is, big, and who reacted: the one hover card in
// Hopp (a small custom emoji is hard to make out at chip size).
var reactionPeek = { timer: 0, chip: null };
function hideReactionPeek() {
  clearTimeout(reactionPeek.timer);
  reactionPeek.chip = null;
  $("reaction-peek")?.remove();
}
document.addEventListener("mouseover", (e) => {
  const chip = e.target.closest?.(".reaction:not(.add)");
  if (chip === reactionPeek.chip) return;
  hideReactionPeek();
  if (!chip?.reaction) return;
  reactionPeek.chip = chip;
  reactionPeek.timer = setTimeout(() => {
    if (!chip.isConnected) return;
    const r = chip.reaction;
    const card = el("div", "reaction-peek");
    card.id = "reaction-peek";
    const big = el("div", "reaction-peek-emoji");
    big.append(emojiNode(r.emoji, "custom-emoji"));
    const words = el("div", "reaction-peek-text");
    const custom = r.emoji.match(CUSTOM_EMOJI);
    if (custom) words.append(el("div", "reaction-peek-name", ":" + custom[1] + ":"));
    words.append(el("div", "reaction-peek-who", reactedWords(r).replace(/ reacted with .*$/, " reacted")));
    card.append(big, words);
    document.body.append(card);
    const at = chip.getBoundingClientRect();
    const w = card.offsetWidth,
      h = card.offsetHeight;
    card.style.left = Math.max(8, Math.min(innerWidth - w - 8, at.left + at.width / 2 - w / 2)) + "px";
    card.style.top = (at.top - h - 8 < 8 ? at.bottom + 8 : at.top - h - 8) + "px";
  }, 250);
});
document.addEventListener("wheel", hideReactionPeek, { capture: true, passive: true });
document.addEventListener("mousedown", hideReactionPeek, true);

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

// The full list ships in emoji-list.js (made by tools/make-emoji.mjs); the short one above is
// only a fallback, and where the extra search words in it came from.
if (window.EMOJI_LIST) EMOJI_GROUPS = window.EMOJI_LIST;
var EMOJI_SKINS = window.EMOJI_SKINS ?? {};
var SKIN_SAMPLE = "👋";
// The picture on each group's button in the picker's top row.
var GROUP_ICONS = { Smileys: "😀", People: "👋", Nature: "🐻", Food: "🍔", Travel: "✈️", Activities: "⚽", Objects: "💡", Symbols: "❤️", Flags: "🏁" };

/** An emoji in the skin tone you picked (0 = the default yellow), when it comes in tones. */
function withSkin(emoji) {
  const tone = Number(load("skinTone", "0"));
  return (tone && EMOJI_SKINS[emoji]?.[tone - 1]) || emoji;
}

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
function openEmojiPicker(anchor, onEmoji, onGif, { plain = false } = {}) {
  const pop = $("emoji-picker");
  picker.onEmoji = onEmoji;
  // A status shows everywhere, even where a server's emojis don't: plain emojis only there.
  picker.plain = plain;
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
        tone.hidden = tab !== "emoji";
        renderPickerBody(body, "");
        search.focus();
      });
      tabs.append(b);
    }
  }
  const body = el("div", "picker-body");
  let typing = 0;
  search.addEventListener("input", () => {
    clearTimeout(typing);
    typing = setTimeout(() => renderPickerBody(body, search.value.trim().toLowerCase()), picker.tab === "gif" ? 0 : 90);
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closePopovers();
    }
  });
  const head = el("div", "picker-head");
  const tone = el("button", "skin-tone");
  tone.type = "button";
  tone.dataset.tip = "Skin tone";
  const showTone = () => tone.replaceChildren(emojiNode(withSkin(SKIN_SAMPLE)));
  showTone();
  tone.addEventListener("click", () => {
    const r = tone.getBoundingClientRect();
    const choices = [SKIN_SAMPLE, ...(EMOJI_SKINS[SKIN_SAMPLE] ?? [])];
    const row = el("div", "skin-choices");
    choices.forEach((e, i) => {
      const b = el("button", "skin-choice" + (Number(load("skinTone", "0")) === i ? " on" : ""));
      b.type = "button";
      b.append(emojiNode(e));
      b.addEventListener("click", () => {
        save("skinTone", String(i));
        row.remove();
        showTone();
        if (picker.tab === "emoji") renderPickerBody(body, search.value.trim().toLowerCase());
      });
      row.append(b);
    });
    row.style.top = r.bottom - pop.getBoundingClientRect().top + 4 + "px";
    pop.querySelector(".skin-choices")?.remove();
    pop.append(row);
  });
  const line = el("div", "picker-line");
  line.append(search, tone);
  head.append(...(onGif ? [tabs] : []), line);
  tone.hidden = picker.tab !== "emoji";
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

/** The emoji list, read once (not on every opening or key press). */
var emojiGroupsRead = null;
function emojiGroups() {
  if (!emojiGroupsRead || emojiGroupsRead.from !== EMOJI_GROUPS) {
    emojiGroupsRead = EMOJI_GROUPS.map(([name, list]) => [name, list.split("|").map((x) => [x.split(" ")[0], x.split(" ").slice(1).join(" ")])]);
    emojiGroupsRead.from = EMOJI_GROUPS;
  }
  return emojiGroupsRead;
}
/** A search that matches most of the list shows this many, and asks for more letters. */
var EMOJI_SEARCH_SHOWN = 240;

/** Row and heading heights in the emoji picker (px); its list is laid out from these. */
var PICK_ROW = 42;
var PICK_HEAD = 28;
var PICK_COLS = 8;
var PICK_SIZE = 30;

/**
 * One emoji in the picker: its square of a sheet (emoji-sheets.js), so a group costs one small
 * picture instead of one per emoji. The server's own emojis and Hopp's are pictures as before.
 */
function emojiFace(emoji) {
  const spot = !CUSTOM_EMOJI.test(emoji) && window.EMOJI_SPRITE?.[emoji];
  if (!spot) {
    const node = emojiNode(emoji, "custom-emoji option");
    return node;
  }
  const { tile, cols, sheets } = window.EMOJI_SHEET;
  const [sheet, i] = spot;
  const [w, h] = sheets[sheet];
  const scale = PICK_SIZE / tile;
  const face = el("span", "emoji-sprite");
  face.style.backgroundImage = "url(emoji/sheets/" + sheet + ".png)";
  face.style.backgroundSize = w * scale + "px " + h * scale + "px";
  face.style.backgroundPosition = -(i % cols) * PICK_SIZE + "px " + -Math.floor(i / cols) * PICK_SIZE + "px";
  return face;
}

/**
 * The emoji list: only the rows you can see (and a few around them) exist; scrolling swaps them,
 * so ~1,900 emojis cost the same as ~100, however fast or far you scroll.
 */
function renderPickerBody(body, q) {
  if (picker.tab === "gif") return renderGifs(body, q);
  const pick = (emoji) => {
    rememberEmoji(emoji);
    closePopovers();
    // In a message box a custom one is typed as its name; elsewhere (reactions) it's the emoji.
    const custom = emoji.match(CUSTOM_EMOJI);
    picker.onEmoji(emoji, custom ? ":" + custom[1] + ": " : emoji);
  };
  const all = emojiGroups().slice();
  // Custom ones first: this server's (by its name), then Hopp's own.
  const own = serverEmojis().map((e) => ["<:" + e.name + ":" + e.id + ">", e.name.replace(/_/g, " ") + " " + e.name]);
  const hopp = Object.keys(window.HOPP_EMOJI ?? {}).map((n) => ["<:" + n + ":0>", n.replace(/_/g, " ") + " " + n]);
  if (hopp.length && !picker.plain) all.unshift(["Hopp", hopp]);
  if (own.length && !picker.plain) all.unshift([state.roster?.server_name || "This server", own]);

  // What the list holds, top to bottom: headings and rows of up to eight.
  const items = [];
  const addRows = (list) => {
    for (let i = 0; i < list.length; i += PICK_COLS) items.push({ cells: list.slice(i, i + PICK_COLS) });
  };
  let count = 0;
  const heads = new Map();
  let note = null;
  if (q) {
    // Every word you type has to start one of the emoji's words: "thumbs up", "flag swe".
    const typed = q.split(/\s+/).filter(Boolean);
    const found = all.flatMap(([, l]) => l).filter(([, words]) => {
      const mine = words.split(" ");
      return typed.every((t) => mine.some((w) => w.startsWith(t)));
    });
    addRows(found.slice(0, EMOJI_SEARCH_SHOWN));
    count = Math.min(found.length, EMOJI_SEARCH_SHOWN);
    note = !found.length ? "No emoji found." : found.length > EMOJI_SEARCH_SHOWN ? "Type a little more to see the rest." : null;
  } else {
    const recent = recentEmoji().filter((e) => !CUSTOM_EMOJI.test(e) || (!picker.plain && emojiUrl(...e.match(CUSTOM_EMOJI).slice(1))));
    if (recent.length) {
      items.push({ head: "Recently used" });
      addRows(recent.map((e) => [e, ""]));
    }
    for (const [name, list] of all) {
      heads.set(name, items.length);
      items.push({ head: name });
      addRows(list);
      count += list.length;
    }
  }
  // Where each item sits.
  const tops = [];
  let height = 0;
  for (const item of items) {
    tops.push(height);
    height += item.head ? PICK_HEAD : PICK_ROW;
  }

  const list = el("div", "emoji-list");
  list.style.height = height + "px";
  list.dataset.count = String(count);
  list.addEventListener("click", (e) => {
    const b = e.target.closest(".emoji-option");
    if (b?.dataset.emoji) pick(b.dataset.emoji);
  });
  const drawn = new Map();
  const make = (i) => {
    const item = items[i];
    let node;
    if (item.head) node = el("div", "emoji-head", item.head);
    else {
      node = el("div", "emoji-row");
      for (const [plain, words] of item.cells) {
        const emoji = CUSTOM_EMOJI.test(plain) ? plain : withSkin(plain);
        const b = el("button", "emoji-option");
        b.type = "button";
        b.dataset.emoji = emoji;
        const name = words ? words.split(" ")[0] : "";
        b.setAttribute("aria-label", name ? name.replace(/_/g, " ") : emoji);
        b.dataset.tip = name ? ":" + name + ":" : "";
        b.append(emojiFace(emoji));
        node.append(b);
      }
    }
    node.style.top = tops[i] + "px";
    return node;
  };
  // The rows in view (and some above and below) are on the page; the rest aren't.
  const sync = () => {
    const from = list.offsetTop;
    const top = body.scrollTop - from - 300;
    const bottom = body.scrollTop - from + body.clientHeight + 300;
    let first = 0;
    let lo = 0;
    let hi = tops.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (tops[mid] < top) {
        first = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const keep = new Set();
    for (let i = first; i < items.length && tops[i] < bottom; i++) {
      keep.add(i);
      if (!drawn.has(i)) {
        const node = make(i);
        drawn.set(i, node);
        list.append(node);
      }
    }
    for (const [i, node] of drawn) {
      if (keep.has(i)) continue;
      node.remove();
      drawn.delete(i);
    }
  };
  picker.sync = sync;
  if (!body.dataset.virtualScroll) {
    body.dataset.virtualScroll = "1";
    body.addEventListener("scroll", () => picker.sync?.(), { passive: true });
  }

  const parts = [];
  if (!q) {
    // A row of the groups at the top: one click to jump to Food or Flags.
    const nav = el("div", "emoji-nav");
    for (const [name, groupList] of all) {
      const jump = el("button", "emoji-nav-btn");
      jump.type = "button";
      jump.dataset.tip = name;
      jump.setAttribute("aria-label", name);
      jump.append(emojiNode(GROUP_ICONS[name] ?? groupList[0][0], "custom-emoji option"));
      jump.addEventListener("click", () => {
        body.scrollTop = list.offsetTop + tops[heads.get(name)] - nav.offsetHeight - 4;
        sync();
      });
      nav.append(jump);
    }
    parts.push(nav);
  }
  parts.push(list);
  if (note) parts.push(el("div", "picker-empty", note));
  body.replaceChildren(...parts);
  body.scrollTop = 0;
  sync();
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
      b.setAttribute("aria-label", gif.title);
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
    (picked, emoji) => {
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
var GIF_URL = /^https:\/\/static\d?\.klipy\.com\/[^\s]+\.(gif|webp|mp4)$/i;

/**
 * A GIF in a message. New ones are short videos (MP4): the graphics card plays them, where a GIF
 * file is decoded picture by picture on the processor. They play only while you can see them
 * and Hopp is in front (like Discord), and stop when you scroll past or switch to a game.
 */
function gifNode(url, onLoad) {
  if (!/\.mp4$/i.test(url)) {
    const img = el("img", "msg-gif");
    img.src = url;
    img.alt = "GIF";
    img.loading = "lazy";
    if (onLoad) img.addEventListener("load", onLoad);
    return img;
  }
  const video = el("video", "msg-gif");
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.disablePictureInPicture = true;
  video.setAttribute("aria-label", "GIF");
  video.src = url;
  if (onLoad) video.addEventListener("loadedmetadata", onLoad, { once: true });
  gifWatch.observe(video);
  return video;
}
var gifsInView = new Set();
var gifWatch = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) gifsInView.add(e.target);
    else {
      gifsInView.delete(e.target);
      e.target.pause();
    }
  }
  playGifs();
});
var appFocused = document.hasFocus();
function playGifs() {
  const on = appFocused && !document.hidden;
  for (const v of [...gifsInView]) {
    if (!v.isConnected) {
      gifsInView.delete(v);
      continue;
    }
    if (on) v.play().catch(() => {});
    else v.pause();
  }
}
window.addEventListener("focus", () => {
  appFocused = true;
  playGifs();
});
window.addEventListener("blur", () => {
  appFocused = false;
  playGifs();
});
document.addEventListener("visibilitychange", playGifs);

// ---------- older messages ----------

function olderLoader() {
  return el("li", "older-loader", "Loading older messages…");
}

function loadOlder() {
  if (!online() || state.view === null || state.loadingOlder) return;
  // Older messages already here: draw more of them, keeping your place.
  if (showMoreAbove()) return;
  if (state.olderDone.has(state.view)) return;
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
  text = encodeEmojis(text);
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
  styleName(author, state.account?.publicKey, name);
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
});

// ---------- editing and moving channels (owner) ----------

var editingChannel = null;

function openChannelEdit(ch) {
  editingChannel = ch;
  const text = ch.kind === "text";
  $("channel-edit-sub").textContent = `in ${activeServer()?.label ?? state.roster.server_name}`;
  $("channel-edit-icon").innerHTML = `<use href="#i-${text ? "hash" : "volume"}"/>`;
  $("channel-edit-name-icon").innerHTML = `<use href="#i-${text ? "hash" : "volume"}"/>`;
  $("channel-edit-title").textContent = ch.name;
  $("channel-edit-name").value = ch.name;
  $("channel-edit-topic").value = ch.topic ?? "";
  $("channel-edit-topic-field").hidden = !text;
  $("channel-edit-pictures").checked = !ch.no_pictures;
  $("channel-edit-pictures-row").hidden = !text || !isCloud(activeServer());
  $("channel-edit-pictures-sub").textContent = state.roster?.pictures_off
    ? "Pictures are off for the whole server (Server settings → Overview)."
    : "Members can share pictures in this channel.";
  $("channel-edit-category").value = ch.category ?? "";
  const voiceSettings = !text && !!state.roster?.features?.includes("voice-settings");
  $("channel-edit-voice").hidden = !voiceSettings;
  $("channel-edit-limit").value = ch.user_limit ?? 0;
  $("channel-edit-limit-value").textContent = ch.user_limit ? ch.user_limit + " people" : "No limit";
  $("channel-edit-afk").value = String(ch.afk_after ?? 0);
  $("channel-edit-slow-row").hidden = !modTools();
  const rolesHere = rolesOn() ? state.roster.roles ?? [] : [];
  $("channel-edit-private").hidden = !rolesOn() || !can("manage");
  $("channel-edit-private-on").checked = !!ch.private_roles?.length;
  $("channel-edit-private-roles").hidden = !ch.private_roles?.length;
  $("channel-edit-private-roles").replaceChildren(...(rolesHere.length ? rolesHere.map((r) => {
    const label = el("label", "private-role");
    const box = el("input");
    box.type = "checkbox";
    box.value = r.id;
    box.checked = !!ch.private_roles?.includes(r.id);
    const dot = el("i", "role-dot");
    dot.style.background = r.color ?? "var(--faint)";
    label.append(box, dot, r.name);
    return label;
  }) : [el("p", "hint", "Make a role first (Server settings → Roles), then pick it here.")]));
  $("channel-edit-slow").value = String(ch.slowmode ?? 0);
  $("category-options").replaceChildren(...[...new Set(state.roster.channels.map((c) => c.category).filter(Boolean))].map((c) => {
    const o = el("option");
    o.value = c;
    return o;
  }));
  $("ctab-permissions").hidden = $("channel-edit-private").hidden;
  $("ctab-moderation").hidden = $("channel-edit-slow-row").hidden;
  $("ctab-voice").hidden = $("channel-edit-voice").hidden;
  showChannelTab("overview");
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
  const voiceSettings = !$("channel-edit-voice").hidden;
  const userLimit = voiceSettings ? Number($("channel-edit-limit").value) : null;
  const afkAfter = voiceSettings ? Number($("channel-edit-afk").value) : null;
  const voiceSame = !voiceSettings || (userLimit === (editingChannel.user_limit ?? 0) && afkAfter === (editingChannel.afk_after ?? 0));
  const slowmode = modTools() ? Number($("channel-edit-slow").value) : null;
  const privateOn = !$("channel-edit-private").hidden && $("channel-edit-private-on").checked;
  const privateRoles = $("channel-edit-private").hidden ? null : privateOn ? [...document.querySelectorAll("#channel-edit-private-roles input:checked")].map((b) => Number(b.value)) : [];
  const privateSame = privateRoles === null || JSON.stringify(privateRoles) === JSON.stringify(editingChannel.private_roles ?? []);
  const slowSame = slowmode === null || slowmode === (editingChannel.slowmode ?? 0);
  if (name === editingChannel.name && topic === (editingChannel.topic ?? "") && category === (editingChannel.category ?? "") && picturesSame && voiceSame && slowSame && privateSame) return;
  call("update_channel", { channel: editingChannel.id, name, topic: topic || null, category: category || null, noPictures, userLimit, afkAfter, slowmode, privateRoles: privateSame ? null : privateRoles });
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
      ...(canForward(m.text) ? [{ label: "Forward", icon: "forward", action: () => forwardMessage(m) }] : []),
      ...(threadsHere() && channel(m.channel)?.parent == null && channel(m.channel)?.kind === "text"
        ? [threadFrom(m) ? { label: "Open thread", icon: "message", action: () => openTextChannel(threadFrom(m).id) } : { label: "Start a thread", icon: "message", action: () => openThreadDialog(m) }]
        : []),
      ...(mine && !PICTURE.test(m.text) && !FORWARD.test(m.text) && !POLL.test(m.text) && !VOICE_MESSAGE.test(m.text) ? [{ label: "Edit message", icon: "edit", action: () => startEdit(m) }] : []),
      ...(can("moderate") ? [{ label: m.pinned ? "Unpin message" : "Pin message", icon: "pin", action: () => call("pin_message", { channel: m.channel, id: m.id, on: !m.pinned }) }] : []),
      { label: "Add reaction", icon: "smile", action: () => openEmojiPicker(e.target.closest(".msg"), (emoji) => react(m, emoji, true)) },
      "sep",
      { label: "Mark unread", icon: "bell", action: () => markUnreadFrom(m) },
      { label: "Copy text", icon: "copy", action: () => copy(plainText(m.text), "Text") },
      { label: "Copy message link", icon: "link", action: () => copy(messageLink(m), "Link") },
      ...(canDelete(m) ? ["sep", { label: "Delete message", icon: "trash", danger: true, action: () => deleteMessage(m) }] : []),
    ],
    e.clientX,
    e.clientY,
  );
}

// ---------- threads ----------
//
// A thread is a text channel started in another one (often from one of its messages): its own
// messages, unread, search and pins, the same people as its channel. In the sidebar the lively
// ones sit under their channel; the message it came from shows its name, a click away.

function threadsHere() {
  return online() && !!state.roster?.features?.includes("threads");
}

/** A channel's threads; `lively`: those talked in during the last three days, or new, or open. */
function threadsOf(channelId, lively = false) {
  const address = activeServer()?.address;
  const since = Date.now() - 3 * 86_400_000;
  return (state.roster?.channels ?? [])
    .filter((c) => c.parent === channelId && (!lively || c.id === state.view || !c.last_at || c.last_at > since || channelUnread(address, c.id)))
    .sort((a, b) => (b.last_at ?? Infinity) - (a.last_at ?? Infinity))
    .slice(0, lively ? 5 : undefined);
}

/** The thread started from a message, if any. */
function threadFrom(m) {
  return (state.roster?.channels ?? []).find((c) => c.parent === m.channel && c.starter === m.id) ?? null;
}

function threadChip(t) {
  const chip = el("button", "thread-chip");
  chip.type = "button";
  const count = (state.chats.get(t.id) ?? []).length;
  chip.append(icon("message", "sm"), el("strong", "ellipsis", t.name), el("span", "thread-chip-sub", count ? (count === 1 ? "1 message" : count + " messages") + (t.last_at ? " · " + dayLabel(t.last_at).toLowerCase() : "") : "No messages yet"));
  chip.addEventListener("click", () => openTextChannel(t.id));
  return chip;
}

var threadFromMessage = null;
function openThreadDialog(m) {
  threadFromMessage = m;
  $("thread-from").replaceChildren(el("div", "pin-text", previewText(m.text) || "A message"));
  $("thread-name").value = previewText(m.text).slice(0, 40);
  $("thread-error").hidden = true;
  openModal($("thread-dialog"));
  $("thread-name").focus();
  $("thread-name").select();
}

$("thread-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const m = threadFromMessage;
  const name = $("thread-name").value.trim();
  if (!name) {
    $("thread-error").textContent = "Give the thread a name.";
    $("thread-error").hidden = false;
    return;
  }
  if (!m) return;
  state.pendingThread = { channel: m.channel, starter: m.id, name };
  call("create_thread", { channel: m.channel, message: m.id, name });
  $("thread-dialog").close();
});

// ---------- forwarding ----------
//
// A message passed on to a channel here, a friend or a group, shown there as a quote with who
// wrote it and where. Written as one line saying where it's from, then the message itself:
//   hopp-forward:<base64url {"n": name, "w": where, "t": sent at}>\n<text>
// Mentions in it become plain names, so forwarding never pings anyone. Pictures and files
// stay where they are (they're stored by that server or that conversation).

var FORWARD = /^hopp-forward:([A-Za-z0-9_-]{4,600})\n([\s\S]*)$/;

/** Where a forwarded message came from, and its text; null when it isn't one. */
function forwardParts(text) {
  const m = typeof text === "string" && text.match(FORWARD);
  if (!m) return null;
  try {
    const meta = JSON.parse(fromBase64url(m[1]));
    return { name: String(meta.n ?? "Someone").slice(0, 64), where: String(meta.w ?? "").slice(0, 80), at: Number(meta.t) || 0, text: m[2] };
  } catch {
    return null;
  }
}

function canForward(text) {
  return typeof text === "string" && !!text.trim() && !PICTURE.test(text) && !DM_PICTURE.test(text) && !FILE_OFFER.test(text) && !POLL.test(text) && !VOICE_MESSAGE.test(text);
}

/** The text to send: the original's own source when forwarding something forwarded. */
function forwardText(text, name, where, at) {
  const inner = forwardParts(text);
  const meta = inner ? { n: inner.name, w: inner.where, t: inner.at } : { n: name, w: where, t: at };
  const body = plainText(inner ? inner.text : text).replace(/@(everyone|here)\b/g, "@​$1");
  return ("hopp-forward:" + base64url(JSON.stringify(meta)) + "\n" + body).slice(0, 2000);
}

/** The quote shown in place of a forwarded message's text. */
function forwardView(f) {
  const box = el("div", "forwarded");
  const head = el("div", "forwarded-head");
  head.append(icon("forward", "xs"), el("span", "", "Forwarded"));
  box.append(head);
  if (GIF_URL.test(f.text.trim())) box.append(gifNode(f.text.trim()));
  else box.append(messageText(f.text));
  const from = [f.name, f.where, f.at ? `${dayLabel(f.at)} at ${clock(f.at)}` : ""].filter(Boolean).join(" · ");
  box.append(el("div", "forwarded-from ellipsis", from));
  return box;
}

/** Opens the "Forward to" dialog for a message: `name` wrote it, `where` it was written. */
function openForward(text, name, where, at) {
  const out = forwardText(text, name, where, at);
  const sent = new Set();
  $("forward-preview").replaceChildren(forwardView(forwardParts(out)));
  $("forward-search").value = "";
  const render = () => {
    const q = $("forward-search").value.trim().toLowerCase().replace(/^[#@]/, "");
    const rows = [];
    // This server's text channels you can write in, then your groups and friends, most recent first.
    if (online()) {
      for (const ch of state.roster.channels.filter((c) => c.kind === "text")) {
        rows.push({ id: "ch|" + ch.id, title: "#" + ch.name, sub: state.roster.server_name ?? "", pic: null, send: () => sendChat(ch.id, out, null) });
      }
    }
    const recent = (key) => state.conversations.get(key)?.last_at ?? 0;
    const people = [...(state.groups?.values() ?? [])].map((g) => ({ key: g.id, group: true })).concat([...state.friends.values()].filter((f) => f.state === "friend").map((f) => ({ key: f.key })));
    people.sort((a, b) => recent(b.key) - recent(a.key));
    for (const p of people) {
      const who = personFor(p.key);
      rows.push({ id: "dm|" + p.key, title: who.display_name, sub: p.group ? "Group" : who.username ?? "", person: who, send: () => sendDm(p.key, { value: out, style: {} }) });
    }
    const shown = rows.filter((r) => !q || r.title.toLowerCase().replace(/^#/, "").includes(q) || r.sub.toLowerCase().includes(q));
    if (!shown.length) return $("forward-list").replaceChildren(el("li", "invite-friend-empty", rows.length ? "Nothing by that name." : "Add friends or join a server to forward messages."));
    $("forward-list").replaceChildren(
      ...shown.map((r) => {
        const li = el("li", "invite-friend");
        const who = el("span", "invite-friend-who");
        const names = el("span", "invite-friend-names");
        names.append(el("strong", "ellipsis", r.title));
        if (r.sub) names.append(el("span", "ellipsis", r.sub));
        if (r.person) who.append(personAvatar(r.person, "s40", !r.person.group));
        else {
          const mark = el("span", "forward-channel-icon");
          mark.append(icon("hash"));
          who.append(mark);
        }
        who.append(names);
        const btn = el("button", "btn sm");
        btn.type = "button";
        btn.textContent = sent.has(r.id) ? "Sent" : "Send";
        btn.disabled = sent.has(r.id);
        btn.addEventListener("click", () => {
          sent.add(r.id);
          btn.textContent = "Sent";
          btn.disabled = true;
          r.send();
        });
        li.append(who, btn);
        return li;
      }),
    );
  };
  $("forward-search").oninput = render;
  render();
  openModal($("forward-dialog"));
  $("forward-search").focus();
}

/** Forwards a server message. */
function forwardMessage(m) {
  openForward(m.text, nameHere(m.author_key) ?? m.sender_name, (state.roster?.server_name ? state.roster.server_name + " " : "") + "#" + channelName(m.channel), m.sent_at);
}

/** Forwards a message from a conversation. */
function forwardDm(peer, m) {
  const where = isGroup(peer) ? personFor(peer).display_name : "Direct message";
  openForward(m.text, personFor(m.from_key).display_name, where, m.sent_at);
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
  if (m.kind === "media") return mediaSignal(m);
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
  // An answer can come back before this line ("busy", "offline"): then the call is over.
  if (state.call !== c) return;
  startRinging("ringback");
  c.timeout = setTimeout(() => state.call === c && endCall("missed"), CALL_RING_MS);
  renderCall();
}

async function handleCallSignal(m) {
  if (m.group) return handleGroupCallSignal(m);
  const c = state.call;
  const name = personFor(m.from).display_name;
  if (m.kind === "ring") {
    // The same friend ringing again lost our call (their app closed without saying so): it's over.
    if (c && !c.group && c.peer === m.from && c.id !== m.call_id) await endCall("remote");
    if (state.call) return callSend({ peer: m.from, id: m.call_id }, "busy");
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
  if (m.kind === "media") return mediaSignal(m);
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
  if (state.voiceAway) {
    await invoke("leave_voice").catch(() => {});
    endAwayVoice(false);
  } else if (myVoice() !== null) {
    state.voiceByMe = true;
    await call("leave_voice");
  }
  stopMicTest();
  resetVoiceGuard();
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
  // Voice is ready: the camera and screen buttons can show.
  renderCall();
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
  callSpeaking.clear();
  syncAttenuation();
  stopAllMedia();
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
  const call = state.call;
  if (!call) return;
  playSound(sound);
  // Rings only while that very call is still ringing: never after it ended or was answered.
  state.ringTimer = setInterval(() => {
    if (state.call !== call || (call.status !== "ringing" && !(call.group && call.role === "caller" && !call.inCall.size))) return stopRinging();
    playSound(sound);
  }, sound === "ring" ? 2200 : 3000);
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
  // Who's in the call hears the sound of the screen we share there.
  if (typeof syncStreamAudio === "function") syncStreamAudio();
  const c = state.call;
  // Someone joined or left the call: video follows.
  if (c?.engineReady) syncMedia();
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
  $("dm-video-btn").hidden = $("dm-call-btn").hidden;
  $("dm-search-input-box").hidden = !dmOpen;
  const here = c && dmOpen && c.peer === state.openDm && !ringingHere;
  const stage = $("call-stage");
  stage.hidden = !here && !joinable;
  const who = (person, id) => {
    const wrap = el("div", "call-person");
    wrap.dataset.session = id;
    wrap.append(avatar(person.display_name ?? "?", "s80", undefined, person.avatar), el("span", "call-name ellipsis", person.display_name ?? ""));
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
  stage.classList.toggle("live-call", !!here);
  if (here) renderCallStage(c);
  // The call panel above your name: like the voice panel, with camera, screen and soundboard.
  if (c && !ringingHere) {
    const ready = !!c.engineReady;
    $("call-actions").hidden = !ready;
    $("call-cam-btn").classList.toggle("on", !!media.out.cam);
    $("call-cam-btn").setAttribute("aria-label", media.out.cam ? "Turn off camera" : "Turn on camera");
    $("call-cam-btn").querySelector("use").setAttribute("href", media.out.cam ? "#i-video" : "#i-video-off");
    $("call-share-btn").classList.toggle("on", !!media.out.screen);
    $("call-share-btn").setAttribute("aria-label", media.out.screen ? "Stop sharing your screen" : "Share your screen");
  }
}

/**
 * A call in its conversation, laid out like a voice channel: everyone's tile (camera or
 * picture) and each shared screen as its own tile, sized to fill the call area. Click a
 * video to put it in the middle (the others in a row below); the buttons along the bottom
 * stay over the call, also in full screen. The area's height is yours to drag.
 */
var callFocus = null;
function renderCallStage(c) {
  const stage = $("call-stage");
  const me = state.me ?? {};
  const people = [{ id: "me", session: c.me, name: state.account?.name ?? "You", avatar: me.avatar }];
  if (c.group) for (const k of c.inCall) people.push({ id: k, session: callSession(k), name: personFor(k).display_name, avatar: personFor(k).avatar });
  else people.push({ id: c.peer, session: c.other, name: personFor(c.peer).display_name, avatar: personFor(c.peer).avatar });

  const tiles = [];
  for (const p of people) {
    const cam = mediaStream("cam", p.id);
    const tile = el("button", "voice-tile call-person" + (cam ? " video" : ""));
    tile.type = "button";
    tile.dataset.session = p.session;
    tile.dataset.key = "cam|" + p.id;
    if (cam) tile.append(videoEl("cam|" + p.id, cam, p.id === "me"));
    else tile.append(avatar(p.name ?? "?", "s64", undefined, p.avatar));
    tile.append(styleName(el("span", "voice-tile-name ellipsis", p.id === "me" ? p.name + " (you)" : p.name), p.id === "me" ? state.me?.key : p.id, p.name, false, "tile"));
    if (cam) tile.addEventListener("click", () => setCallFocus("cam|" + p.id));
    tiles.push(tile);
    const screen = mediaStream("screen", p.id);
    if (screen) {
      const st = el("button", "voice-tile video screen-tile");
      st.type = "button";
      st.dataset.key = "screen|" + p.id;
      st.append(videoEl("screen|" + p.id, screen, false), el("span", "voice-tile-name ellipsis", p.id === "me" ? "Your screen" : p.name + "'s screen"));
      const marks = el("span", "voice-tile-marks");
      marks.append(el("span", "live-pill", "LIVE"));
      st.append(marks);
      st.addEventListener("click", () => setCallFocus("screen|" + p.id));
      tiles.push(st);
    } else if (p.id !== "me" && liveIn.has(p.id)) {
      // Sharing, and not watched yet: a tile to start watching (or one saying it's on its way).
      const st = el("button", "voice-tile screen-back screen-offer");
      st.type = "button";
      st.dataset.offer = p.id;
      st.dataset.key = "screen|" + p.id;
      const mark = el("span", "screen-back-icon");
      mark.append(icon("monitor"));
      const marks = el("span", "voice-tile-marks");
      marks.append(el("span", "live-pill", "LIVE"));
      st.append(mark, el("span", "voice-tile-name ellipsis", p.name + "'s screen"), marks);
      if (wantIn.has(p.id)) st.append(el("span", "screen-offer-wait", "Connecting…"));
      else st.append(el("span", "btn primary sm screen-offer-go", "Watch"));
      st.addEventListener("click", () => !wantIn.has(p.id) && watchCallScreen(p.id));
      tiles.push(st);
    }
  }
  // A screen just shared (by anyone else) goes in the middle by itself, once.
  const screens = tiles.filter((t) => t.classList.contains("screen-tile")).map((t) => t.dataset.key);
  for (const k of screens) if (!callSeen.has(k)) {
    callSeen.add(k);
    if (k !== "screen|me" && callFocus === null) callFocus = k;
  }
  for (const k of [...callSeen]) if (!screens.includes(k)) callSeen.delete(k);
  if (callFocus && !tiles.some((t) => t.dataset.key === callFocus)) callFocus = null;

  // Nothing in the middle and someone is sharing: offered big there, as in a voice channel.
  const offers = callFocus ? [] : people.filter((p) => p.id !== "me" && liveIn.has(p.id) && !wantIn.has(p.id) && !mediaStream("screen", p.id));
  const grid = el("div", "voice-tiles" + (callFocus || offers.length ? " strip" : ""));
  let main = null;
  for (const t of tiles) {
    if (t.dataset.key === callFocus) {
      t.classList.add("focus");
      main = el("div", "stage-main");
      main.append(t);
    } else if (!offers.some((p) => p.id === t.dataset.offer)) grid.append(t);
  }
  if (offers.length) {
    main = el("div", "stage-main");
    const cards = el("div", "stream-cards");
    for (const p of offers) {
      const card = el("button", "stream-card");
      card.type = "button";
      card.dataset.stream = p.id;
      const badge = el("span", "stream-card-icon");
      badge.append(icon("monitor"));
      card.append(badge, el("strong", "ellipsis", p.name), el("span", "stream-card-sub", "is sharing their screen"), el("span", "btn primary sm", "Watch"));
      card.addEventListener("click", () => watchCallScreen(p.id));
      cards.append(card);
    }
    main.append(cards);
  }
  const watchedHere = callFocus?.startsWith("screen|") && callFocus !== "screen|me" ? callFocus.slice(7) : null;

  // Top: how long, and the view's buttons.
  const top = el("div", "call-top");
  top.append(el("span", "call-stage-status", callStatusText(c)));
  const bar = el("div", "stage-bar");
  const btn = (name, label, fn) => {
    const x = el("button", "stage-btn");
    x.type = "button";
    x.setAttribute("aria-label", label);
    x.append(icon(name));
    x.addEventListener("click", fn);
    bar.append(x);
  };
  if (main && !offers.length) {
    btn("pip", "Pop out", () => {
      const v = main.querySelector("video");
      if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
      else v?.requestPictureInPicture?.().catch(() => toast("This video can't pop out right now.", true));
    });
    btn("grid", "Show everyone", () => setCallFocus(null));
    if (watchedHere) btn("eye-off", "Stop watching", () => stopWatchingCallScreen(watchedHere));
  }
  btn(document.fullscreenElement === stage ? "minimize" : "maximize", "Full screen", () => (document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen()).catch(() => {}));
  top.append(bar);

  // Bottom: mic, camera, screen, hang up — over the call, also in full screen.
  const controls = el("div", "call-controls");
  const control = (name, label, on, fn, cls = "") => {
    const x = el("button", "call-btn media" + (on ? " on" : "") + cls);
    x.type = "button";
    x.setAttribute("aria-label", label);
    x.append(icon(name));
    x.addEventListener("click", fn);
    controls.append(x);
  };
  control(state.muted ? "mic-off" : "mic", state.muted ? "Unmute" : "Mute", false, () => $("mute-btn").click(), state.muted ? " off" : "");
  if (c.engineReady) {
    control(media.out.cam ? "video" : "video-off", media.out.cam ? "Turn off camera" : "Turn on camera", !!media.out.cam, () => (media.out.cam ? stopOut("cam") : startCamera()));
    control("monitor", media.out.screen ? "Stop sharing your screen" : "Share your screen", !!media.out.screen, () => (media.out.screen ? stopOut("screen") : startCallScreen()));
  }
  const hang = el("button", "call-btn decline");
  hang.type = "button";
  hang.setAttribute("aria-label", "Hang up");
  hang.append(icon("phone-off"));
  hang.addEventListener("click", () => endCall());
  controls.append(hang);

  const grip = el("div", "call-grip");
  grip.addEventListener("mousedown", startCallResize);
  stage.replaceChildren(top, ...(main ? [main] : []), grid, controls, grip);
  stage.classList.toggle("has-video", tiles.some((t) => t.classList.contains("video")));
  const h = callHeight();
  stage.style.height = h + "px";
  // Too low for a row of people under the one in the middle: just the one.
  stage.classList.toggle("low", !!main && h < 400 && document.fullscreenElement !== stage);
  fitCallTiles();
}
var callSeen = new Set();

function setCallFocus(key) {
  callFocus = callFocus === key ? null : key;
  renderCall();
}

/** The call area's height: what you dragged it to, or a size that suits what's in it. */
function callHeight() {
  const view = $("home").clientHeight || window.innerHeight;
  const video = $("call-stage").classList.contains("has-video");
  // With video: most of the room, leaving the conversation a few lines below.
  const wanted = prefs.callHeight ?? (video ? view - 230 : 300);
  return Math.round(Math.max(220, Math.min(wanted, view - 170)));
}
prefs.callHeight = loadJson("callHeight", null);

function startCallResize(e) {
  e.preventDefault();
  const stage = $("call-stage");
  const startY = e.clientY;
  const startH = stage.offsetHeight;
  document.body.classList.add("resizing-call");
  const move = (ev) => {
    prefs.callHeight = startH + ev.clientY - startY;
    stage.style.height = callHeight() + "px";
    fitCallTiles();
  };
  const up = () => {
    document.body.classList.remove("resizing-call");
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    prefs.callHeight = $("call-stage").offsetHeight;
    save("callHeight", JSON.stringify(prefs.callHeight));
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

function fitCallTiles() {
  fitTiles(document.querySelector("#call-stage .voice-tiles"));
}
new ResizeObserver(() => fitCallTiles()).observe($("call-stage"));
document.addEventListener("fullscreenchange", () => state.call && renderCall());

$("call-cam-btn").addEventListener("click", () => (media.out.cam ? stopOut("cam") : startCamera()));
$("call-share-btn").addEventListener("click", () => (media.out.screen ? stopOut("screen") : startCallScreen()));
$("call-sound-btn").addEventListener("click", (e) => openSoundboard(e.currentTarget));

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
    ev.speaking ? callSpeaking.add(ev.session_id) : callSpeaking.delete(ev.session_id);
    syncAttenuation();
    document.querySelectorAll(`.call-person[data-session="${ev.session_id}"]`).forEach((n) => n.classList.toggle("speaking", ev.speaking));
  } else if (ev.type === "speaking_while_muted") {
    mutedReminder();
  } else if (ev.type === "devices_changed") {
    // A headset unplugged mid-call: carry on with what's there.
    devicesChanged();
  } else if (ev.type === "need_relay") {
    useRelay();
  } else if (ev.type === "peer_quality") {
    guardVoice("call|" + ev.session_id, ev.rtt_ms, ev.loss);
  } else if (ev.type === "queue_delay") {
    queueSeen(ev.ms);
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

// ---------- voice messages ----------
//
// Recorded here (Opus in WebM, up to a minute, small enough for the server's store), sent
// as hopp-voice:<id> <length in ms>, and played in the chat with a bar you can click to seek.

var VOICE_MESSAGE = /^hopp-voice:([0-9a-f]{32}) (\d{1,6})$/;
var VOICE_MAX_MS = 60_000;
var recording = null;

function voiceMessagesHere() {
  return online() && !!state.roster?.features?.includes("voice-messages");
}

function clockLength(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

async function startRecording() {
  if (recording || state.view === null || !voiceMessagesHere()) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (err) {
    return toast(err?.name === "NotAllowedError" ? "Hopp wasn't allowed to use your microphone." : "Couldn't start recording. " + (err?.message ?? ""), true);
  }
  const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 32_000 });
  const r = { recorder, stream, chunks: [], started: Date.now(), channel: state.view, send: false, timer: null };
  recording = r;
  recorder.addEventListener("dataavailable", (e) => e.data.size && r.chunks.push(e.data));
  recorder.addEventListener("stop", () => finishRecording(r));
  recorder.start(250);
  r.timer = setInterval(() => {
    const ms = Date.now() - r.started;
    $("recorder-time").textContent = clockLength(ms);
    if (ms >= VOICE_MAX_MS) stopRecording(true);
  }, 200);
  $("recorder-time").textContent = "0:00";
  $("recorder").hidden = false;
  document.querySelector("#composer .composer-row").hidden = true;
}

function stopRecording(send) {
  const r = recording;
  if (!r) return;
  r.send = send;
  r.length = Math.min(VOICE_MAX_MS, Date.now() - r.started);
  clearInterval(r.timer);
  if (r.recorder.state !== "inactive") r.recorder.stop();
  r.stream.getTracks().forEach((t) => t.stop());
  $("recorder").hidden = true;
  document.querySelector("#composer .composer-row").hidden = false;
  recording = null;
}

async function finishRecording(r) {
  if (!r.send) return;
  if (r.length < 700) return toast("Hold on a little longer: that was too short to send.");
  const bytes = new Uint8Array(await new Blob(r.chunks, { type: "audio/webm" }).arrayBuffer());
  if (bytes.length < 200) return toast("Nothing was recorded. Check your microphone in Windows sound settings.", true);
  if (bytes.length > 320_000) return toast("That voice message is too long to send.", true);
  try {
    const id = await invoke("upload_image", { cloud: cloudHttp(), serverId: activeServer().address.slice("cloud:".length), data: Array.from(bytes), kind: "audio/webm" });
    sendChat(r.channel, `hopp-voice:${id} ${Math.round(r.length)}`, null);
  } catch (err) {
    toast(friendlyError(err), true);
  }
}

$("voice-msg-btn").addEventListener("click", startRecording);
$("voice-msg-btn").addEventListener("mousedown", (e) => e.preventDefault());
$("recorder-cancel").addEventListener("click", () => stopRecording(false));
$("recorder-send").addEventListener("click", () => stopRecording(true));
// Escape throws a recording away.
document.addEventListener("keydown", (e) => recording && e.key === "Escape" && stopRecording(false));

/** The player in the chat: play/pause, a bar to seek, and the time. */
function voiceView(id, length) {
  const box = el("div", "voice-msg");
  const play = el("button", "voice-msg-play");
  play.type = "button";
  play.setAttribute("aria-label", "Play");
  play.append(icon("play"));
  const bar = el("div", "voice-msg-bar");
  const fill = el("div", "voice-msg-fill");
  bar.append(fill);
  const time = el("span", "voice-msg-time", clockLength(length));
  let audio = null;
  const total = () => (audio && Number.isFinite(audio.duration) ? audio.duration * 1000 : length);
  const show = () => {
    const at = audio ? audio.currentTime * 1000 : 0;
    fill.style.width = Math.min(100, (at / total()) * 100) + "%";
    time.textContent = audio && (at > 0 || !audio.paused) ? clockLength(at) + " / " + clockLength(total()) : clockLength(length);
    play.replaceChildren(icon(audio && !audio.paused ? "pause" : "play"));
    play.setAttribute("aria-label", audio && !audio.paused ? "Pause" : "Play");
  };
  const load = () => {
    if (audio) return audio;
    audio = new Audio(pictureUrl(id));
    audio.addEventListener("timeupdate", show);
    audio.addEventListener("play", show);
    audio.addEventListener("pause", show);
    audio.addEventListener("ended", () => {
      audio.currentTime = 0;
      show();
    });
    audio.addEventListener("error", () => toast("That voice message can't be played. It may have been removed.", true));
    return audio;
  };
  play.addEventListener("click", () => {
    const a = load();
    // One at a time, like everywhere else.
    for (const other of document.querySelectorAll(".voice-msg")) if (other !== box) other.pauseVoice?.();
    if (a.paused) a.play().catch(() => {});
    else a.pause();
  });
  bar.addEventListener("click", (e) => {
    const a = load();
    const r = bar.getBoundingClientRect();
    const seek = ((e.clientX - r.left) / r.width) * (total() / 1000);
    if (Number.isFinite(seek)) a.currentTime = Math.max(0, seek);
    if (a.paused) a.play().catch(() => {});
  });
  box.pauseVoice = () => audio?.pause();
  box.append(play, bar, time);
  return box;
}

// ---------- polls ----------
//
// A poll is a message: hopp-poll:<base64url {"q": question, "a": [answers], "end": ms, "multi": bool}>.
// A vote is a reaction "poll:<answer>"; the server keeps one per person unless more are
// allowed, and none after the end. Results show once you've voted, or when it's closed.

var POLL = /^hopp-poll:([A-Za-z0-9_-]{4,2600})$/;

function pollOf(text) {
  const m = typeof text === "string" && text.match(POLL);
  if (!m) return null;
  try {
    const p = JSON.parse(fromBase64url(m[1]));
    const answers = (Array.isArray(p.a) ? p.a : []).slice(0, 10).map((a) => String(a).slice(0, 55));
    if (answers.length < 2) return null;
    return { question: String(p.q ?? "").slice(0, 300), answers, end: Number(p.end) || 0, multi: !!p.multi };
  } catch {
    return null;
  }
}

function pollsHere() {
  return online() && !!state.roster?.features?.includes("polls");
}

/** "3 h left", "2 days left", "Closed". */
function pollTimeLeft(end) {
  const left = end - Date.now();
  if (left <= 0) return "Closed";
  const h = left / 3_600_000;
  if (h >= 48) return Math.round(h / 24) + " days left";
  if (h >= 1) return Math.round(h) + " h left";
  return Math.max(1, Math.round(left / 60_000)) + " min left";
}

function pollView(m, p) {
  const me = state.account?.publicKey;
  const votes = p.answers.map((_, i) => m.reactions?.find((r) => r.emoji === "poll:" + i)?.keys ?? []);
  const voters = new Set(votes.flat());
  const mine = votes.map((keys) => keys.includes(me));
  const closed = Date.now() > p.end;
  const showResults = closed || mine.some(Boolean);
  const top = Math.max(...votes.map((v) => v.length));
  const card = el("div", "poll");
  card.append(el("div", "poll-question", p.question || "Poll"), el("div", "poll-hint", closed ? "Results" : p.multi ? "Pick one or more answers" : "Pick one answer"));
  p.answers.forEach((answer, i) => {
    const row = el("button", "poll-answer" + (mine[i] ? " mine" : "") + (closed && votes[i].length === top && top > 0 ? " winner" : ""));
    row.type = "button";
    row.disabled = closed;
    const share = voters.size ? Math.round((votes[i].length / voters.size) * 100) : 0;
    if (showResults) row.style.setProperty("--share", share + "%");
    const mark = el("span", "poll-mark" + (p.multi ? " multi" : ""));
    if (mine[i]) mark.append(icon("check", "xs"));
    row.append(mark, el("span", "poll-text", answer));
    if (showResults) row.append(el("span", "poll-share", share + "%"));
    row.addEventListener("click", () => react(m, "poll:" + i, !mine[i]));
    card.append(row);
  });
  const n = voters.size;
  card.append(el("div", "poll-foot", `${n} ${n === 1 ? "vote" : "votes"} · ${pollTimeLeft(p.end)}`));
  return card;
}

function openPollDialog() {
  $("poll-question").value = "";
  $("poll-multi").checked = false;
  $("poll-duration").value = "24";
  $("poll-error").hidden = true;
  $("poll-answers").replaceChildren();
  addPollAnswer();
  addPollAnswer();
  openModal($("poll-dialog"));
  $("poll-question").focus();
}

function addPollAnswer() {
  const list = $("poll-answers");
  if (list.children.length >= 10) return;
  const row = el("div", "poll-answer-input");
  const input = el("input");
  input.type = "text";
  input.maxLength = 55;
  input.placeholder = "Answer " + (list.children.length + 1);
  const remove = el("button", "icon-btn sm");
  remove.type = "button";
  remove.setAttribute("aria-label", "Remove answer");
  remove.append(icon("x", "sm"));
  remove.addEventListener("click", () => {
    if (list.children.length > 2) row.remove();
    $("poll-add").hidden = list.children.length >= 10;
  });
  row.append(input, remove);
  list.append(row);
  $("poll-add").hidden = list.children.length >= 10;
}

$("poll-add").addEventListener("click", () => {
  addPollAnswer();
  $("poll-answers").lastElementChild?.querySelector("input").focus();
});

$("poll-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("poll-question").value.trim();
  const answers = [...$("poll-answers").querySelectorAll("input")].map((i) => i.value.trim()).filter(Boolean);
  const fail = (text) => {
    $("poll-error").textContent = text;
    $("poll-error").hidden = false;
  };
  if (!q) return fail("Write a question.");
  if (answers.length < 2) return fail("A poll needs at least two answers.");
  if (state.view === null || !pollsHere()) return fail("Polls aren't available here.");
  const end = Date.now() + Number($("poll-duration").value) * 3_600_000;
  sendChat(state.view, "hopp-poll:" + base64url(JSON.stringify({ q, a: answers, end, multi: $("poll-multi").checked })), null);
  $("poll-dialog").close();
});

// ---------- inbox ----------
//
// Every mention of you (and every reply to you) in any server, kept by your account, newest
// first: a click takes you to it. The bell counts the ones since you last opened it, on any
// device. @everyone and @here are left out for servers where you suppressed them.

state.inbox = [];
state.inboxSeen = 0;

function inboxItems() {
  return state.inbox.filter((i) => !(i.crowd && crowdQuiet(i.server)));
}

function renderInboxBadge() {
  const fresh = inboxItems().filter((i) => i.at > state.inboxSeen).length;
  for (const b of document.querySelectorAll(".inbox-badge")) {
    b.hidden = !fresh;
    b.textContent = fresh > 99 ? "99+" : String(fresh);
  }
}

/** A new mention while we're here (from channel_activity). */
function addToInbox(m) {
  if (state.inbox.some((i) => i.server === m.server && i.channel === m.channel && i.id === m.id)) return;
  state.inbox.unshift({ server: m.server, channel: m.channel, id: m.id, at: m.last_at || Date.now(), server_name: m.server_name, channel_name: m.channel_name, author_key: m.author_key, author_name: m.author_name, preview: m.preview ?? "", crowd: !!m.crowd });
  state.inbox.length = Math.min(state.inbox.length, 200);
  renderInboxBadge();
  if (!$("inbox-pop").hidden) renderInbox();
}

/** Goes to a message in a server, connecting to it first if needed. */
async function goToMessage(address, channel, id) {
  const server = prefs.servers.find((s) => s.address === address);
  if (!server) return toast("That message is in a server you're no longer in.", true);
  if (server.id === state.activeId && online()) {
    state.atHome = false;
    openTextChannel(channel);
    jumpToMessage(id);
    return;
  }
  state.pendingView = channel;
  state.pendingJump = id;
  await connectTo(server);
}

function renderInbox() {
  const pop = $("inbox-pop");
  const head = el("div", "inbox-head");
  head.append(el("span", "pins-title", "Mentions"));
  const items = inboxItems();
  if (items.length) {
    const clear = el("button", "btn-link sm", "Clear all");
    clear.type = "button";
    clear.addEventListener("click", () => {
      state.inbox = [];
      renderInbox();
      renderInboxBadge();
      invoke("account_send", { msg: { type: "inbox_clear", all: true } }).catch(() => {});
    });
    head.append(clear);
  }
  if (!items.length) return pop.replaceChildren(head, el("div", "pins-empty", "Nothing here yet. When someone mentions you or replies to you, it shows up here."));
  const list = el("div", "pins-list");
  for (const i of items) {
    const item = el("div", "pin-item inbox-item" + (i.at > state.inboxSeen ? " fresh" : ""));
    item.tabIndex = 0;
    const top = el("div", "pin-head");
    top.append(avatar(i.author_name, "s24", undefined, pictureFor(i.author_key)), el("strong", "ellipsis", i.author_name), el("span", "search-where ellipsis", "#" + i.channel_name + " · " + i.server_name), el("span", "pin-date", dayLabel(i.at)));
    const x = el("button", "icon-btn sm inbox-x");
    x.type = "button";
    x.setAttribute("aria-label", "Remove");
    x.append(icon("x", "sm"));
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      state.inbox = state.inbox.filter((o) => o !== i);
      renderInbox();
      renderInboxBadge();
      invoke("account_send", { msg: { type: "inbox_clear", server: i.server, channel: i.channel, id: i.id } }).catch(() => {});
    });
    top.append(x);
    item.append(top, el("div", "pin-text", previewText(i.preview) || "Mentioned you"));
    const go = () => {
      closePopovers();
      goToMessage(i.server, i.channel, i.id);
    };
    item.addEventListener("click", go);
    item.addEventListener("keydown", (e) => e.key === "Enter" && go());
    list.append(item);
  }
  pop.replaceChildren(head, list);
}

for (const btn of document.querySelectorAll(".inbox-btn")) {
  btn.addEventListener("click", (e) => {
    const pop = $("inbox-pop");
    if (!pop.hidden) return closePopovers();
    renderInbox();
    const r = e.currentTarget.getBoundingClientRect();
    placePopover(pop, r.right - 380, r.bottom + 8);
    // Opened: what's here now counts as seen, on every device (the "new" marks stay while it's open).
    const now = Math.max(Date.now(), ...state.inbox.map((i) => i.at));
    state.inboxSeen = now;
    renderInboxBadge();
    invoke("account_send", { msg: { type: "inbox_seen", at: now } }).catch(() => {});
  });
}

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
  if (!mine) toast(`${server.label} was deleted by its owner.`);
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
  // One way, like the voice panel: how long voice takes to reach them.
  const parts = [q.rtt != null ? Math.round(q.rtt / 2) + " ms" : null, q.loss > 0 ? q.loss + "% lost" : null, q.relayed ? "through the relay" : null].filter(Boolean);
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

// From the Microsoft Store: Microsoft keeps it up to date, so Hopp's own updater stays out of sight.
invoke("store_install")
  .then((yes) => {
    state.storeInstall = !!yes;
    if (yes) renderUpdates();
  })
  .catch(() => {});

async function checkForUpdate(manual) {
  if (state.storeInstall) return;
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
  // Always there: grey when Hopp is up to date (a click looks for a newer one), green when a
  // newer one is ready. Installing is always your choice.
  btn.classList.toggle("ready", !!updates.found);
  btn.setAttribute("aria-label", updates.found ? "Update available" : "Updates");
  btn.dataset.tip = updates.found ? `Hopp ${updates.found.version} is ready` : `Hopp ${updates.version} · up to date`;

  $("version-title").textContent = updates.version ? `Hopp ${updates.version}` : "Hopp";
  $("settings-version").textContent = updates.version ? `Hopp ${updates.version}` : "Hopp";
  btn.hidden = !!state.storeInstall;
  $("version-btn").hidden = !!state.storeInstall;
  if (state.storeInstall) {
    $("version-sub").textContent = "Updates come from the Microsoft Store.";
    return;
  }
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
  // Opening it while up to date looks for a newer version right away.
  if (!updates.found && updates.status !== "checking") checkForUpdate(true);
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
// Looked for often, so the green arrow shows by itself: soon after start, every 15 minutes,
// and when you come back to Hopp (at most every 2 minutes). The update file is a plain
// static file on Hopp Cloud, so this costs nothing against its daily limit.
var lastUpdateCheck = 0;
function checkSoon() {
  if (Date.now() - lastUpdateCheck < 2 * 60_000) return;
  lastUpdateCheck = Date.now();
  checkForUpdate();
}
setTimeout(checkSoon, 8000);
setInterval(checkSoon, 15 * 60_000);
window.addEventListener("focus", checkSoon);

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
  // Who's around: friends in voice first (where, and a way in), then everyone else online.
  // Rows, not cards, so a long list stays calm.
  const aside = el("aside", "active-now");
  const online = [...(state.friends?.values() ?? [])].filter((f) => f.state === "friend" && f.status !== "offline");
  const busy = online.filter((f) => f.activity);
  const rest = online.filter((f) => !f.activity).sort((a, b) => a.display_name.localeCompare(b.display_name));
  const head = el("div", "around-head");
  head.append(el("h3", "", "Around"));
  if (online.length) head.append(el("span", "around-count", String(online.length)));
  aside.append(head);
  if (!online.length) {
    const empty = el("div", "around-empty");
    empty.append(el("p", "", "Nobody's around right now. Friends who come online show up here, and where they're talking."));
    aside.append(empty);
    return aside;
  }
  const row = (f, sub) => {
    const r = el("div", "around-row");
    r.tabIndex = 0;
    r.setAttribute("role", "button");
    r.addEventListener("click", () => openDm(f.key));
    r.addEventListener("keydown", (e) => e.key === "Enter" && openDm(f.key));
    const text = el("div", "around-text");
    text.append(styleName(el("strong", "ellipsis", f.display_name), f.key, f.display_name, false, "personal"));
    if (sub) text.append(sub);
    r.append(personAvatar(f, "s32", true), text);
    return r;
  };
  if (busy.length) {
    aside.append(el("div", "around-label", "In voice"));
    for (const f of busy) {
      const where = friendVoice(f);
      const sub = el("span", "around-sub ellipsis");
      sub.append(icon("volume", "xs"), el("span", "ellipsis", where?.server ? (where.channelName ? where.channelName + " · " : "") + where.server.label : f.activity));
      const r = row(f, sub);
      r.classList.add("talking");
      if (where?.server) {
        const here = activeServer()?.id === where.server.id && myVoice() === where.channel;
        if (here) r.append(el("span", "around-here", "With you"));
        else {
          const join = el("button", "btn sm around-join", "Join");
          join.type = "button";
          join.addEventListener("click", (e) => {
            e.stopPropagation();
            joinFriendVoice(where);
          });
          r.append(join);
        }
      }
      aside.append(r);
    }
  }
  if (rest.length) {
    aside.append(el("div", "around-label", "Online"));
    for (const f of rest) aside.append(row(f, f.status === "idle" || f.status === "dnd" ? el("span", "around-sub ellipsis", STATUS_LABEL[f.status]) : null));
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
  // With the server's own roles, those decide (given from the Roles menu); the old picker would only confuse.
  wrap.hidden = roles.length === 0 || rolesOn();
  const select = $("user-role");
  select.replaceChildren(...roles.map((r) => {
    const opt = el("option", "", r ? ROLE_LABEL[r] : "Member");
    opt.value = r ?? "";
    return opt;
  }));
  select.value = roleOf(user) ?? "";
  $("user-transfer").hidden = true;
}

async function setRole(member, role) {
  try {
    await invoke("set_role", { publicKey: member.public_key, role });
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
  } catch (err) {
    toast(friendlyError(err), true);
  }
}

/** Server settings → Members, with the server's own roles: who has which, and (for admins) a tick list to change it. */
function memberRolesButton(m) {
  const all = state.roster?.roles ?? [];
  const has = all.filter((r) => m.roles?.includes(r.id));
  const label = m.role === "owner" ? "Owner" : has.length ? has.map((r) => r.name).join(", ") : "No roles";
  const givable = all.filter((r) => r.level !== "admin" || can("own"));
  const mine = m.public_key === state.account?.publicKey;
  const above = !can("own") && !mine && (ROLE_RANK[m.role] ?? 0) >= rankOf(me());
  if (!can("manage") || above || !givable.length) return el("span", "role-label member-roles", label);
  const b = el("button", "row-select member-roles", "");
  b.type = "button";
  b.append(el("span", "ellipsis", label));
  b.setAttribute("aria-label", "Roles for " + m.name);
  b.addEventListener("click", () => {
    const r = b.getBoundingClientRect();
    openMenu(givable.map((role) => ({
      label: role.name,
      check: !!m.roles?.includes(role.id),
      action: async (on) => {
        try {
          await invoke("assign_role", { publicKey: m.public_key, role: role.id, on });
          m.roles = on ? [...new Set([...(m.roles ?? []), role.id])] : (m.roles ?? []).filter((id) => id !== role.id);
          renderMemberList();
        } catch (err) {
          toast(friendlyError(err), true);
        }
      },
    })), r.left, r.bottom + 4);
  });
  return b;
}

/** Server settings → Members: everyone who belongs here, online or not. */
function renderMemberList() {
  const list = $("server-members");
  if (!$("server-settings").open || list.closest("[data-spanel]")?.hidden) return;
  const q = $("member-search").value.trim().toLowerCase();
  const online = new Set((state.roster?.users ?? []).map((u) => u.public_key));
  const members = state.members
    .filter((m) => !q || m.name.toLowerCase().includes(q) || (m.account_name ?? "").toLowerCase().includes(q))
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
      text.append(name, el("span", "admin-sub", `${m.nick && m.account_name && m.account_name !== m.nick ? m.account_name + " · " : ""}${online.has(m.public_key) ? "Online · " : ""}Joined ${joined}`));
      who.append(text);
      li.append(who);
      const actions = el("span", "member-admin-actions");
      if (rolesOn() && (state.roster?.roles ?? []).length) {
        // The server's own roles decide here, the same ones the Roles tab makes.
        actions.append(memberRolesButton(m));
      } else if (rolesICanGive(target).length) {
        actions.append(roleSelect(target, (role) => setRole(m, role)));
      } else {
        actions.append(el("span", `role-label ${m.role ?? "member"}`, m.role ? ROLE_LABEL[m.role] : "Member"));
      }
      if (can("moderate") && m.public_key !== state.account?.publicKey && rankOf(me()) > (ROLE_RANK[m.role] ?? 0)) {
        const kick = el("button", "icon-btn", "");
        kick.type = "button";
        kick.setAttribute("aria-label", `Kick ${m.name}`);
        kick.append(icon("logout"));
        kick.addEventListener("click", () => removeUser(false, { name: m.name, public_key: m.public_key, session_id: 0, offline: true }));
        actions.append(kick);
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
$("attach-btn").addEventListener("click", (e) => {
  if (!pollsHere()) return $("attach-file").click();
  const r = e.currentTarget.getBoundingClientRect();
  openMenu(
    [
      ...(picturesAllowed() ? [{ label: "Upload a picture", icon: "camera", action: () => $("attach-file").click() }] : []),
      { label: "Create a poll", icon: "grid", action: openPollDialog },
    ],
    r.left,
    r.top - 8,
    true,
  );
});
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
    // Those you can still invite first; friends already here go last.
    .sort((a, b) => here.has(a.key) - here.has(b.key) || (a.status === "offline") - (b.status === "offline") || a.display_name.localeCompare(b.display_name));
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
      names.append(styleName(el("strong", "ellipsis", f.display_name), f.key, f.display_name, false, "personal"));
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
const playingVideos = new Set(); // "video id|start" playing inline, kept across re-renders of the same conversation
/** The conversation those videos play in. Another one starts with nothing playing. */
let videoScope = "";
function videosIn(scope) {
  if (scope === videoScope) return;
  videoScope = scope;
  playingVideos.clear();
}
/** Players in these rows go back to their picture (and stop), so nothing plays again by itself. */
function stopVideosIn(root) {
  for (const card of root.querySelectorAll(".yt-card")) {
    if (!card.querySelector("iframe")) continue;
    const [, id, start] = (card.dataset.keep ?? "").split("|");
    if (!id) continue;
    playingVideos.delete(id + "|" + start);
    card.replaceWith(youtubeCard(id, Number(start) || 0, card.querySelector(".yt-title")?.href ?? "https://youtu.be/" + id));
  }
}

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

/**
 * A YouTube player is a whole page of YouTube's in its own process, and keeps running (and
 * holding 100-250 MB) when paused. So Hopp listens to it (YouTube's player messages): paused
 * for a while, paused out of sight or behind another window, or finished, the player is closed
 * and the picture comes back with "Continue at 2:31", which opens it again where it was.
 */
var YT_REST_MS = 3000;
var ytResume = new Map(); // "id|start" → seconds to continue from
var ytPlayers = new Map(); // the player's window → its state
function ytWatch(player, key, sleep) {
  const ctrl = { player, key, sleep, state: -1, time: 0, timer: 0, seen: true };
  ytPlayers.set(player.contentWindow, ctrl);
  // Ask the player to tell us about itself, until it answers.
  let tries = 0;
  const hello = setInterval(() => {
    if (!player.isConnected || ctrl.state !== -1 || ++tries > 40) return clearInterval(hello);
    player.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: key, channel: "widget" }), "*");
  }, 250);
  player.addEventListener("load", () => ytPlayers.set(player.contentWindow, ctrl));
  ytSight.observe(player);
  return ctrl;
}
function ytSettle(ctrl) {
  clearTimeout(ctrl.timer);
  if (!ctrl.player.isConnected) {
    ytPlayers.delete(ctrl.player.contentWindow);
    return;
  }
  const paused = ctrl.state === 2;
  const ended = ctrl.state === 0;
  if (ended) ctrl.timer = setTimeout(() => ctrl.sleep(0), 1500);
  else if (paused && (!ctrl.seen || !appFocused || document.hidden)) ctrl.sleep(ctrl.time);
  else if (paused) ctrl.timer = setTimeout(() => ctrl.sleep(ctrl.time), YT_REST_MS);
}
window.addEventListener("message", (e) => {
  if (!/^https:\/\/www\.youtube(-nocookie)?\.com$/.test(e.origin)) return;
  const ctrl = [...ytPlayers.values()].find((c) => c.player.contentWindow === e.source);
  if (!ctrl) return;
  let data;
  try {
    data = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
  } catch {
    return;
  }
  const info = data?.info;
  if (data?.event === "onStateChange" && typeof info === "number") ctrl.state = info;
  if (info && typeof info === "object") {
    if (typeof info.playerState === "number") ctrl.state = info.playerState;
    if (typeof info.currentTime === "number") ctrl.time = info.currentTime;
  }
  if (ctrl.state === -1 && data?.event) ctrl.state = 5; // answered: ready, not started
  ytSettle(ctrl);
});
var ytSight = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const ctrl = ytPlayers.get(e.target.contentWindow);
    if (!ctrl) continue;
    ctrl.seen = e.isIntersecting;
    ytSettle(ctrl);
  }
});
const ytAll = () => ytPlayers.forEach((c) => ytSettle(c));
window.addEventListener("blur", ytAll);
document.addEventListener("visibilitychange", ytAll);
function ytClock(seconds) {
  const t = Math.floor(seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? h + ":" + String(m).padStart(2, "0") + ":" + sec : m + ":" + sec;
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
  const picture = () => {
    const thumb = el("img");
    thumb.src = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
    thumb.alt = "";
    thumb.loading = "lazy";
    const button = el("button", "yt-play");
    button.type = "button";
    const from = ytResume.get(key) ?? 0;
    button.setAttribute("aria-label", from > 3 ? "Continue at " + ytClock(from) : "Play video");
    button.append(el("span", "yt-play-icon"));
    button.addEventListener("click", play);
    frame.replaceChildren(thumb, button);
    if (from > 3) frame.append(el("span", "yt-resume", "Continue at " + ytClock(from)));
  };
  const play = () => {
    playingVideos.add(key);
    const from = Math.floor(ytResume.get(key) ?? start ?? 0);
    const player = el("iframe");
    player.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&enablejsapi=1&origin=${encodeURIComponent(location.origin)}${from ? "&start=" + from : ""}`;
    player.title = title.textContent;
    player.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    player.allowFullscreen = true;
    player.referrerPolicy = "strict-origin-when-cross-origin";
    frame.replaceChildren(player);
    // Paused a while, out of sight or finished: the player goes, the picture comes back.
    ytWatch(player, key, (at) => {
      if (!player.isConnected) return;
      ytPlayers.delete(player.contentWindow);
      if (at > 0) ytResume.set(key, at);
      else ytResume.delete(key);
      playingVideos.delete(key);
      picture();
    });
  };
  if (playingVideos.has(key)) play();
  else picture();
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
  return m.text !== null && !DM_PICTURE.test(m.text) && !FILE_OFFER.test(m.text) && !GIF_URL.test(m.text.trim()) && !FORWARD.test(m.text);
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
  const own = m.from_key === state.me?.key;
  if (canForward(m.text)) button("forward", "Forward", () => forwardDm(peer, m));
  if (own && dmEditable(m)) button("edit", "Edit", () => startDmEdit(peer, m));
  if (own) button("trash", "Delete message", (e) => deleteDm(peer, m, e.shiftKey), "danger-hover");
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
/** How far the sender may run ahead of what the receiver has written to disk. */
const FILE_WINDOW = 16 * 1024 * 1024;
/** The receiver says how far it has got about this often. */
const FILE_ACK_EVERY = 1024 * 1024;
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

const fileCardTimers = new Map();
/** Redraws a transfer's cards in place (not the whole conversation), at most ~8 times a second each. */
function refreshFileCards(transfer, now) {
  const draw = () => {
    clearTimeout(fileCardTimers.get(transfer));
    fileCardTimers.delete(transfer);
    for (const card of document.querySelectorAll(`.file-card[data-transfer="${transfer}"]`)) {
      const fresh = fileCard(card.peer, card.message);
      card.replaceWith(fresh);
    }
  };
  if (now) return draw();
  if (!fileCardTimers.has(transfer)) fileCardTimers.set(transfer, setTimeout(draw, 120));
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
  out.onAck?.();
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
  const pc = new RTCPeerConnection(await rtcConfig());
  out.pc = pc;
  out.status = "connecting";
  out.sent = 0;
  out.acked = null;
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
    } else if (typeof e.data === "string" && e.data.startsWith("ack ")) {
      // How much the other side has saved: we never run far ahead of a slow disk.
      out.acked = Number(e.data.slice(4)) || 0;
      out.onAck?.();
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
      // (Older versions never say how far they've got; they get it all as before.)
      while (out.acked !== null && out.sent - out.acked > FILE_WINDOW && out.status === "sending") {
        await new Promise((done) => (out.onAck = done));
      }
      if (out.status !== "sending") return;
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
  const pc = new RTCPeerConnection(await rtcConfig());
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
  let written = 0;
  let told = 0;
  const tell = () => {
    told = written;
    try {
      channel.send("ack " + written);
    } catch {
      // Closing; the transfer ends by itself.
    }
  };
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
    tell();
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
    writing = writing.then((id) =>
      invoke("download_chunk", piece, { headers: { "x-download": inc.download ?? id } }).then(() => {
        written += piece.byteLength;
        if (written - told >= FILE_ACK_EVERY) tell();
        return id;
      }),
    );
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
  if (nicknamesOn() && (isSelf || (can("moderate") && outranks(u))) && key) items.push({ label: "Change nickname", icon: "edit", action: () => changeNickname(u) });
  // Your own roles, from your own menu.
  if (isSelf) {
    const mine = roleItems(u);
    if (mine.length) items.push("sep", ...mine);
  }
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
    // How you hear them: drag it down (or up, to 200%). Only for someone in voice.
    if (u.voice_channel !== null) {
      items.push("sep", {
        label: "User volume",
        slider: { value: vol, min: 0, max: 200, step: 5, format: (v) => v + "%", onInput: (v) => {
          cardUser = u;
          setUserVolume(v);
        } },
      });
      items.push({ label: "Mute", check: vol === 0, action: (on) => {
        cardUser = u;
        setUserVolume(on ? 0 : 100);
      } });
    }
    // What a moderator can do, folded into three short groups that open to the side.
    const mod = can("moderate") && outranks(u);
    const hard = [];
    if (mod) {
      hard.push(...timeoutItems(u));
      hard.push({ label: `Kick ${u.name}`, icon: "logout", danger: true, action: () => {
        cardUser = u;
        removeUser(false);
      } });
      if (can("manage")) hard.push({ label: `Ban ${u.name}`, icon: "ban", danger: true, action: () => {
        cardUser = u;
        removeUser(true);
      } });
    }
    if (isOwner() && isCloud(activeServer()) && key) hard.push("sep", { label: "Transfer ownership", icon: "crown", danger: true, action: () => transferOwnership({ public_key: u.public_key, name: u.name }) });
    const groups = [...(mod ? roleItems(u) : []), ...(mod ? voiceModItems(u) : [])];
    if (hard.length) groups.push({ label: "Moderation", submenu: hard[0] === "sep" ? hard.slice(1) : hard });
    if (groups.length) items.push("sep", ...groups);
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
  const recent = recentEmoji().filter((e) => !CUSTOM_EMOJI.test(e) || emojiUrl(...e.match(CUSTOM_EMOJI).slice(1)));
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
  // Among those, the shortest name first: :fir is :fire: before :fire_engine:.
  const rank = (e) => (e.name.startsWith(query) ? 0 : 1);
  return emojiIndex
    .filter((e) => e.words.some((w) => w.startsWith(query)))
    .sort((a, b) => rank(a) - rank(b) || a.name.length - b.name.length)
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
// ---------- hiding your IP address ----------
//
// On, voice and calls go only through the relay (the voice engine announces nothing of ours),
// and so do screens, cameras and files (WebRTC uses relay addresses only). The others see
// the relay's address, never yours.

prefs.hideIp = load("hideIp", "0") === "1";
$("hide-ip").checked = prefs.hideIp;
invoke("set_private_route", { on: prefs.hideIp }).catch(() => {});
$("hide-ip").addEventListener("change", (e) => {
  prefs.hideIp = e.target.checked;
  save("hideIp", prefs.hideIp ? "1" : "0");
  invoke("set_private_route", { on: prefs.hideIp }).catch(() => {});
});

/** How a video, screen or file connection is made: through the relay only, when hiding your address. */
async function rtcConfig() {
  const iceServers = await fileIce();
  if (!prefs.hideIp) return { iceServers };
  if (!iceServers.some((x) => String(x.urls).includes("turn:"))) {
    toast("Hopp's relay isn't available right now, so this can't connect without showing your IP address. Turn off Hide my IP address in Privacy & safety, or try again in a moment.", true);
  }
  return { iceServers, iceTransportPolicy: "relay" };
}

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

/** "from:elin in:general has:link gg" → the filters (lowercase) and the words left to find
 *  (the server reads the same; names with spaces go in quotes: from:"Big Sam"). */
function parseSearch(query) {
  const out = { words: "", from: [], in: [], has: [] };
  const rest = query.replace(/(^|\s)(from|in|has):(?:"([^"]{1,64})"|(\S{1,64}))/gi, (_, space, key, quoted, word) => {
    out[key.toLowerCase()].push(String(quoted ?? word).toLowerCase().replace(/^[@#]/, ""));
    return space;
  });
  out.words = rest.replace(/\s+/g, " ").trim();
  return out;
}
var SEARCH_HINT = "Type at least two letters, or narrow it down with from:name, in:channel, has:link or has:image";

async function runSearch(query, where) {
  const f = parseSearch(query.trim());
  const filtered = f.from.length || f.in.length || f.has.length;
  showSearchPanel(where);
  if (!filtered && f.words.length < 2) {
    searching = null;
    return searchStatus(where.dm ? SEARCH_HINT.replace(", in:channel", "") : SEARCH_HINT);
  }
  if (filtered && !where.dm && !state.roster?.features?.includes("search-filters")) return searchStatus("This server needs an update before it can use from:, in: and has:");
  const mine = { query, where };
  searching = mine;
  searchStatus("Searching…");
  if (where.dm) {
    const found = await searchConversation(where.dm, f);
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

/** A conversation's messages matching the words and filters, newest first, after loading
 *  what's older. */
async function searchConversation(peer, f) {
  const needle = f.words.toLowerCase();
  const me = state.me?.key ?? state.account?.publicKey;
  const isFrom = (m) =>
    !f.from.length ||
    f.from.some((name) => {
      const p = personFor(m.from_key);
      return [p.display_name, p.username, m.from_key === me ? "me" : null].some((n) => n && n.toLowerCase() === name);
    });
  const has = (m) =>
    f.has.every((h) =>
      /^links?$/.test(h) ? /https?:\/\//i.test(m.text) : /^(images?|pictures?)$/.test(h) ? DM_PICTURE.test(m.text) || PICTURE.test(m.text) : /^files?$/.test(h) ? FILE_OFFER.test(m.text) : false,
    );
  if (f.in.length) return [];
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
    .filter((m) => m.text && !m.pending && previewText(m.text).toLowerCase().includes(needle) && isFrom(m) && has(m))
    .reverse()
    .slice(0, 25);
}

function showResults(s, messages) {
  s.done = true;
  const needle = parseSearch(s.query.trim()).words.toLowerCase();
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
// built around one colour (and, for a colour theme, a second one it fades into): dark, or
// light for a light colour. "Mid grey" is the stylesheet itself. Contrast spreads the shades
// further apart, colourfulness lets more of the colour through; text always stays readable.

var THEMES = [
  { id: "mid", name: "Mid grey", base: "#3c3c42" },
  { id: "dark", name: "Dark", base: "#2a2a2e" },
  { id: "midnight", name: "Midnight", base: "#2b3140" },
  { id: "light", name: "Light grey", base: "#f2f2f4" },
];

/** Colour themes: two colours, fading from one to the other. */
var GRADIENTS = [
  { id: "dusk", name: "Dusk", a: "#3a2f52", b: "#23384a" },
  { id: "forest", name: "Forest", a: "#2c3d33", b: "#3b4632" },
  { id: "ember", name: "Ember", a: "#4a2e36", b: "#4a3a2a" },
  { id: "ocean", name: "Ocean", a: "#1f3346", b: "#1f4141" },
  { id: "plum", name: "Plum", a: "#40284a", b: "#2e2a4a" },
  { id: "dawn", name: "Dawn", a: "#f3e9ef", b: "#e8eef8" },
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
function themeTokens(base, { contrast = 50, saturation = 50, mode } = {}) {
  const [h, sRaw, picked] = hexToHsl(base);
  // Light or dark: as asked, or else from the colour. The colour's lightness then moves the
  // theme smoothly within a range where text always reads well.
  const light = mode ? mode === "light" : picked > 60;
  const l = light ? 86 + (picked / 100) * 11 : 12 + (Math.min(picked, 80) / 80) * 20;
  // Surfaces stay calm: even a bright pick becomes a tint (more of it with colourfulness up).
  const s = Math.min(sRaw, 6 + (saturation / 100) * 38);
  // Contrast spreads the steps between surfaces.
  const k = 0.6 + (contrast / 100) * 0.8;
  const at = (dl, sat = s) => "hsl(" + h.toFixed(1) + " " + sat.toFixed(1) + "% " + Math.max(0, Math.min(100, l + dl * k)).toFixed(1) + "%)";
  const tint = (lightness, sat = Math.min(s, 10)) => "hsl(" + h.toFixed(1) + " " + sat.toFixed(1) + "% " + lightness + "%)";
  if (light) {
    // Light: what's further back is a little darker; text is near-black.
    return {
      frame: at(-9), "side-2": at(-6), side: at(-4), main: at(0), elev: at(-7), "elev-2": at(-11), "elev-3": at(-15), deep: at(-5),
      border: at(-11), "border-strong": at(-17), "border-active": at(-25), "border-focus": at(-32), "focus-ring": at(-35),
      hover: "rgb(0 0 0 / 0.05)", active: "rgb(0 0 0 / 0.08)", "msg-hover": "rgb(0 0 0 / 0.03)",
      layer: "rgb(255 255 255 / 0.55)", "layer-2": "rgb(255 255 255 / 0.8)", sink: "rgb(0 0 0 / 0.045)", tile: "rgb(0 0 0 / 0.07)", "app-solid": at(-6), "rail-shade": "rgb(0 0 0 / 0.045)",
      text: tint(12), "text-2": tint(22), muted: tint(38), faint: tint(53),
      link: "#1a63d6", "primary-hover": tint(25), "name-s": "38%", "name-l": "34%", green: "#15804f", yellow: "#b7791f", red: "#d93a40", scheme: "light",
    };
  }
  return {
    frame: at(-6.7), "side-2": at(-3.9), side: at(-2.1), main: at(0), elev: at(4.3), "elev-2": at(8.2), "elev-3": at(12.4), deep: at(-7.8),
    border: at(4.3), "border-strong": at(10.4), "border-active": at(16.3), "border-focus": at(20.4), "focus-ring": at(21.5),
    hover: "rgb(255 255 255 / 0.05)", active: "rgb(255 255 255 / 0.09)", "msg-hover": "rgb(0 0 0 / 0.06)",
    layer: "rgb(255 255 255 / 0.06)", "layer-2": "rgb(255 255 255 / 0.09)", sink: "rgb(0 0 0 / 0.2)", tile: "rgb(255 255 255 / 0.065)", "app-solid": at(-6.5), "rail-shade": "rgb(0 0 0 / 0.16)",
    text: tint(98), "text-2": tint(91), muted: tint(72), faint: tint(62),
    link: "#8ab4f8", "primary-hover": "#ffffff", "name-s": "22%", "name-l": "80%", green: "#3ccf8e", yellow: "#f0b232", red: "#f2555a", scheme: "dark",
  };
}

var THEME_KEYS = [...Object.keys(themeTokens("#3c3c42")), "app-bg"];

/** What to paint: a preset, a colour theme, or your own. */
function themeSpec() {
  if (prefs.theme === "custom") return { a: prefs.custom.a, b: prefs.custom.b, contrast: prefs.custom.contrast, saturation: prefs.custom.saturation, mode: prefs.custom.mode };
  const g = GRADIENTS.find((x) => x.id === prefs.theme);
  if (g) return { a: g.a, b: g.b, contrast: 50, saturation: 60 };
  return { a: THEMES.find((t) => t.id === prefs.theme)?.base ?? THEMES[0].base, b: null, contrast: 50, saturation: 50 };
}

/** Tokens for a whole spec: the first colour's shades, and fades into the second's. */
function specTokens(spec) {
  const t = themeTokens(spec.a, spec);
  if (spec.b) {
    const u = themeTokens(spec.b, spec);
    // Light and dark don't mix: the second colour follows the first.
    if (u.scheme === t.scheme) {
      // One background for the whole window: the colours fade across it, under everything.
      t["app-bg"] = "linear-gradient(135deg, " + t["app-solid"] + " 0%, " + u["app-solid"] + " 100%)";
    }
  }
  return t;
}

function applyTheme() {
  const root = document.documentElement.style;
  for (const k of THEME_KEYS) root.removeProperty(k === "scheme" ? "color-scheme" : "--" + k);
  // Mid grey is the stylesheet's own colours.
  if (prefs.theme !== "mid" && prefs.theme) {
    for (const [k, v] of Object.entries(specTokens(themeSpec()))) root.setProperty(k === "scheme" ? "color-scheme" : "--" + k, v);
  }
  root.setProperty("--chat-size", prefs.chatSize + "px");
  root.setProperty("--chat-space", prefs.chatSpace + "px");
  document.documentElement.classList.toggle("compact-chat", !!prefs.compact);
  const font = (typeof APP_FONTS !== "undefined" && APP_FONTS[prefs.appFont]) || '"Inter"';
  document.documentElement.style.setProperty("--app-font", font);
  if (typeof syncWindowColor === "function") setTimeout(syncWindowColor, 0);
  // Names in role colours are adjusted for light and dark: redraw them.
  if (state.roster && typeof online === "function" && online()) {
    renderSidebar();
    renderMembers();
    if (state.view !== null && renderedChannel === state.view) renderMessages(true);
  }
}

function setTheme(id) {
  prefs.theme = id;
  save("theme", id);
  applyTheme();
  syncThemePage();
}

var themeFrame = 0;
function saveCustom(change) {
  Object.assign(prefs.custom, change);
  save("themeCustom", JSON.stringify(prefs.custom));
  prefs.theme = "custom";
  save("theme", "custom");
  // Dragging a colour fires many times a frame: paint once per frame.
  clearTimeout(themeFrame);
  themeFrame = setTimeout(() => {
    applyTheme();
    syncThemePage();
  }, 16);
}

/** A little picture of a theme: the sidebar, the chat and two lines of text. */
function themePicture(spec) {
  const t = specTokens(spec);
  const pic = el("span", "theme-pic");
  pic.style.background = t["app-bg"] ?? t["app-solid"];
  const side = el("span", "theme-pic-side");
  side.style.background = "transparent";
  const main = el("span", "theme-pic-main");
  main.style.background = t.layer;
  for (const w of [70, 45]) {
    const line = el("i");
    line.style.width = w + "%";
    line.style.background = t.faint;
    main.append(line);
  }
  pic.append(side, main);
  return pic;
}

/** A colour as a bright, clear swatch (the theme itself uses its calm, dark shades). */
function swatchColor(hex) {
  const [h, s, l] = hexToHsl(hex);
  return "hsl(" + h.toFixed(0) + " " + Math.min(70, s + 25).toFixed(0) + "% " + (l > 60 ? 82 : 46) + "%)";
}

/** Builds the Appearance page once; after that only marks and colours change, so a colour picker stays open while you use it. */
function renderThemes() {
  const list = $("theme-list");
  if (!list || list.childElementCount) return syncThemePage();
  const card = (id, name, spec) => {
    const b = el("button", "theme-card");
    b.type = "button";
    b.dataset.theme = id;
    b.append(themePicture(spec), el("span", "theme-name", name));
    b.addEventListener("click", () => setTheme(id));
    return b;
  };
  list.replaceChildren(
    ...THEMES.map((t) => card(t.id, t.name, { a: t.base, b: null, contrast: 50, saturation: 50 })),
    card("custom", "Your own", { ...prefs.custom }),
  );
  $("gradient-list").replaceChildren(
    ...GRADIENTS.map((g) => {
      const b = el("button", "gradient-swatch");
      b.type = "button";
      b.dataset.theme = g.id;
      b.dataset.tip = g.name;
      b.style.background = "linear-gradient(135deg, " + swatchColor(g.a) + ", " + swatchColor(g.b) + ")";
      b.addEventListener("click", () => setTheme(g.id));
      return b;
    }),
  );
  syncThemePage();
}

/** The page follows the settings without being rebuilt. */
function syncThemePage() {
  // Your own colours show when you pick "Your own"; the ready themes need nothing more.
  if ($("theme-editor")) $("theme-editor").hidden = prefs.theme !== "custom";
  for (const n of document.querySelectorAll(".theme-card, .gradient-swatch")) n.classList.toggle("active", n.dataset.theme === prefs.theme);
  const custom = document.querySelector('.theme-card[data-theme="custom"]');
  if (custom) custom.querySelector(".theme-pic").replaceWith(themePicture({ ...prefs.custom }));
  const c = prefs.custom;
  if (document.activeElement !== $("theme-a")) $("theme-a").value = c.a;
  if (document.activeElement !== $("theme-b")) $("theme-b").value = c.b ?? c.a;
  $("theme-b").parentElement.classList.toggle("off", !c.b);
  $("theme-b-clear").hidden = !c.b;
  for (const b of document.querySelectorAll(".theme-mode .segment")) {
    b.classList.toggle("active", b.dataset.look === c.mode);
    b.setAttribute("aria-checked", String(b.dataset.look === c.mode));
  }
  $("theme-contrast").value = c.contrast;
  $("theme-contrast-value").textContent = c.contrast + "%";
  $("theme-saturation").value = c.saturation;
  $("theme-saturation-value").textContent = c.saturation + "%";
  $("chat-size").value = prefs.chatSize;
  $("chat-size-value").textContent = prefs.chatSize + " px";
  $("chat-space").value = prefs.chatSpace;
  $("chat-space-value").textContent = prefs.chatSpace + " px";
}

prefs.theme = load("theme", "mid");
prefs.custom = { a: load("themeColor", "#3b4a46"), b: null, contrast: 50, saturation: 50, ...JSON.parse(load("themeCustom", "{}") || "{}") };
// Older saves picked light or dark from the colour; keep what they had.
prefs.custom.mode ??= hexToHsl(prefs.custom.a)[2] > 60 ? "light" : "dark";
for (const b of document.querySelectorAll(".theme-mode .segment")) b.addEventListener("click", () => saveCustom({ mode: b.dataset.look }));
prefs.chatSize = Number(load("chatSize", "15"));
prefs.chatSpace = Number(load("chatSpace", "18"));
prefs.compact = load("chatCompact", "0") === "1";
$("chat-compact").checked = prefs.compact;
/** The font for all of Hopp (Appearance → Chat). */
var APP_FONTS = { inter: '"Inter"', rounded: '"Nunito"', readable: '"Atkinson Hyperlegible"', dyslexic: '"OpenDyslexic"', system: '"Segoe UI"' };
prefs.appFont = load("appFont", "inter");
$("app-font").value = APP_FONTS[prefs.appFont] ? prefs.appFont : "inter";
$("app-font").addEventListener("change", (e) => {
  prefs.appFont = e.target.value;
  save("appFont", prefs.appFont);
  applyTheme();
});
$("chat-compact").addEventListener("change", (e) => {
  prefs.compact = e.target.checked;
  save("chatCompact", prefs.compact ? "1" : "0");
  applyTheme();
  // Every message gets its own name line in compact mode: drawn again.
  if (typeof online === "function" && online()) renderMessages(true);
  if (state.openDm) renderDmView(true);
});

$("theme-a").addEventListener("input", (e) => saveCustom({ a: e.target.value }));
$("theme-b").addEventListener("input", (e) => saveCustom({ b: e.target.value }));
$("theme-b-clear").addEventListener("click", () => saveCustom({ b: null }));
$("theme-contrast").addEventListener("input", (e) => saveCustom({ contrast: Number(e.target.value) }));
$("theme-saturation").addEventListener("input", (e) => saveCustom({ saturation: Number(e.target.value) }));
$("chat-size").addEventListener("input", (e) => {
  prefs.chatSize = Number(e.target.value);
  save("chatSize", String(prefs.chatSize));
  applyTheme();
  syncThemePage();
});
$("chat-space").addEventListener("input", (e) => {
  prefs.chatSpace = Number(e.target.value);
  save("chatSpace", String(prefs.chatSpace));
  applyTheme();
  syncThemePage();
});
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

/**
 * How a shared screen is sent: its size and how many pictures a second. Yours to choose
 * (right-click the share button, or the cog on your own stream), also while sharing.
 * Sixty a second is for games and video; thirty keeps text at its sharpest.
 */
var SHARE_SIZES = [
  { id: "720", label: "720p", w: 1280, h: 720 },
  { id: "1080", label: "1080p", w: 1920, h: 1080 },
  { id: "1440", label: "1440p", w: 2560, h: 1440 },
  { id: "source", label: "Source (as it is)", w: 0, h: 0 },
];
var SHARE_RATES = [15, 30, 60];
/** Megabits a second, to each viewer, at most. */
var SHARE_MBIT = { 720: { 15: 1.5, 30: 2.5, 60: 4 }, 1080: { 15: 2.5, 30: 4.5, 60: 7 }, 1440: { 15: 4, 30: 7, 60: 10 }, source: { 15: 4, 30: 7, 60: 10 } };

// ---------- voice comes first ----------
//
// Video and voice share the same line out of your home. When video fills it, voice is what
// suffers: it arrives late, or not at all. So Hopp watches how voice is doing (its round trip
// and how much is lost, every second) and, the moment it strains while you send video, makes
// the video smaller; when voice has been fine for a while, video gets its room back.
var voiceGuard = { budget: 1, floor: new Map(), calm: 0, strained: 0, queued: 0, held: 0, told: null };
/** Video never shrinks below this share of what you chose: a smaller picture, never a broken one. */
var VIDEO_BUDGET_MIN = 0.45;
function sendingVideo() {
  return !!screenShare.stream || (typeof media !== "undefined" && Object.keys(media.out).length > 0);
}
/** The share of its usual size video may use right now (1 = all of it). */
function videoBudget() {
  return voiceGuard.budget;
}
function guardVoice(id, rtt, loss) {
  const g = voiceGuard;
  tellSendingVideo();
  // How fast voice is when nothing is in its way: the best seen, creeping up slowly so a
  // network that simply got slower becomes the new normal within a couple of minutes.
  if (rtt != null) {
    const floor = g.floor.get(id);
    g.floor.set(id, floor == null ? rtt : Math.min(rtt, floor + 0.5));
  }
  const before = g.budget;
  if (!sendingVideo()) {
    g.budget = 1;
    g.calm = 0;
    g.strained = 0;
  } else {
    // Some networks always lose a little and wobble a little: only a clear, lasting change
    // counts (two readings in a row), not one bad second.
    const floor = g.floor.get(id);
    // Delay is watched closely by queueSeen; here a big jump still counts (an older peer
    // that doesn't answer often enough to time), and so does heavy loss.
    const strained = loss >= 10 || (rtt != null && floor != null && rtt > floor + 120);
    if (strained) {
      g.calm = 0;
      if (++g.strained >= 2) {
        g.strained = 0;
        g.budget = Math.max(VIDEO_BUDGET_MIN, g.budget * 0.8);
      }
    } else {
      g.strained = 0;
      if (++g.calm >= 4) {
        g.calm = 0;
        g.budget = Math.min(1, g.budget * 1.25);
      }
    }
  }
  if (g.budget !== before) retuneVideo();
}
/**
 * Five times a second while we send video: how long voice waits in the queue on its way out.
 * Like the best real-time apps (Google's congestion control), video gives way as soon as a
 * queue starts building, not once voice already sounds bad: above 30 ms twice in a row, the
 * video steps down to 85% and waits a moment for the queue to drain; below 12 ms it creeps
 * back up, a few percent at a time. Between the two it holds.
 */
function queueSeen(ms) {
  const g = voiceGuard;
  if (!sendingVideo()) return;
  const before = g.budget;
  if (ms > 30) {
    if (++g.queued >= 2 && Date.now() > g.held) {
      g.queued = 0;
      g.budget = Math.max(VIDEO_BUDGET_MIN, g.budget * 0.85);
      // The cut needs a moment to show in the queue; don't cut again before it can.
      g.held = Date.now() + 700;
    }
  } else {
    g.queued = 0;
    if (ms < 12 && Date.now() > g.held) g.budget = Math.min(1, g.budget * 1.02);
  }
  if (Math.abs(g.budget - before) > 0.001) retuneVideo();
}

/** Tells voice whether we send video, so it watches the way out closely only then. */
function tellSendingVideo() {
  const on = sendingVideo();
  if (voiceGuard.told === on) return;
  voiceGuard.told = on;
  invoke("set_sending_video", { on }).catch(() => {});
}

/** Every video we send follows the room voice leaves it. */
function retuneVideo() {
  tellSendingVideo();
  for (const pc of screenShare.peers.values()) tuneShare(pc);
  if (typeof media !== "undefined") for (const [kind, out] of Object.entries(media.out)) for (const pc of out.peers.values()) if (pc.getSenders) tuneSender(pc, kind);
  if (watching?.local) screenInfo();
}
/** A new voice channel or call: what was normal before says nothing about this one. */
function resetVoiceGuard() {
  voiceGuard.floor.clear();
  voiceGuard.calm = 0;
  if (voiceGuard.budget !== 1) {
    voiceGuard.budget = 1;
    retuneVideo();
  }
}
prefs.shareQuality = { size: "1080", rate: 30, ...loadJson("shareQuality", {}) };
if (!SHARE_SIZES.some((x) => x.id === prefs.shareQuality.size)) prefs.shareQuality.size = "1080";
if (!SHARE_RATES.includes(prefs.shareQuality.rate)) prefs.shareQuality.rate = 30;

function shareSize() {
  return SHARE_SIZES.find((x) => x.id === prefs.shareQuality.size) ?? SHARE_SIZES[1];
}
function shareBitrate() {
  return Math.round(SHARE_MBIT[prefs.shareQuality.size][prefs.shareQuality.rate] * 1_000_000);
}
/** What to ask the screen for. */
function shareConstraints() {
  const { w, h } = shareSize();
  const rate = prefs.shareQuality.rate;
  return { frameRate: { ideal: rate, max: rate }, ...(w ? { width: { ideal: w, max: w }, height: { ideal: h, max: h } } : {}) };
}
/** Motion first at sixty a second; sharp text first otherwise. */
function shareHint() {
  return prefs.shareQuality.rate >= 60 ? "motion" : "detail";
}
/** The graphics card encodes a shared screen (H.264) where it can, at every quality, so games don't slow down. */
function preferSmoothCodec(pc) {
  try {
    const all = RTCRtpSender.getCapabilities("video")?.codecs ?? [];
    const first = all.filter((c) => /h264/i.test(c.mimeType));
    if (!first.length) return;
    const order = [...first, ...all.filter((c) => !/h264/i.test(c.mimeType))];
    for (const t of pc.getTransceivers()) if (t.sender?.track?.kind === "video") t.setCodecPreferences(order);
  } catch {
    // The usual order works too.
  }
}
/** A screen sender follows the chosen quality. */
function tuneShare(pc) {
  for (const sender of pc.getSenders?.() ?? []) {
    if (sender.track?.kind !== "video") continue;
    setSenderParams(sender, (params) => {
      params.encodings[0].maxBitrate = Math.round(shareBitrate() * videoBudget());
      params.encodings[0].maxFramerate = prefs.shareQuality.rate;
      params.degradationPreference = prefs.shareQuality.rate >= 60 ? "maintain-framerate" : "maintain-resolution";
    });
  }
}

/**
 * Changes how a video is sent, one change at a time per sender: a change made while the last
 * one is still being applied would be refused (and quietly lost), so the last wish always lands.
 */
function setSenderParams(sender, change) {
  sender.hoppWish = change;
  if (sender.hoppBusy) return;
  sender.hoppBusy = true;
  const next = async () => {
    while (sender.hoppWish) {
      const wish = sender.hoppWish;
      sender.hoppWish = null;
      try {
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        wish(params);
        await sender.setParameters(params);
      } catch {
        // Closed meanwhile, or not ready yet: the next change tries again.
      }
    }
    sender.hoppBusy = false;
  };
  next();
}
/** A new choice, also in the middle of sharing: the screen and everyone watching follow at once. */
function setShareQuality(change) {
  Object.assign(prefs.shareQuality, change);
  // What you just picked is what's sent: the room made for voice starts over from there.
  voiceGuard.budget = 1;
  voiceGuard.calm = 0;
  voiceGuard.strained = 0;
  save("shareQuality", JSON.stringify(prefs.shareQuality));
  const streams = [screenShare.stream, typeof media !== "undefined" ? media.out.screen?.stream : null].filter(Boolean);
  for (const stream of streams) {
    const track = stream.getVideoTracks()[0];
    if (!track) continue;
    track.contentHint = shareHint();
    track.applyConstraints(shareConstraints()).catch(() => {});
  }
  for (const pc of screenShare.peers.values()) tuneShare(pc);
  if (typeof media !== "undefined") for (const pc of media.out.screen?.peers.values() ?? []) tuneShare(pc);
  renderScreenStage();
}
// ---------- the computer's sound with a shared screen ----------
//
// Like Discord's "share sound": everything playing on this computer except Hopp itself (so
// nobody hears their own voice back), to the people watching. On unless you turn it off.

prefs.shareSound = load("shareSound", "1") === "1";
var streamAudio = { told: "", failed: false };

/** Who should hear our screen's sound right now, and in which (a call or a voice channel). */
function streamListeners() {
  if (!prefs.shareSound) return null;
  if (screenShare.stream) return { call: false, to: [...screenShare.peers.keys()].map(Number).filter((n) => n > 0) };
  if (typeof media !== "undefined" && media.out.screen && state.call?.engineReady) {
    const c = state.call;
    return { call: true, to: c.group ? [...c.inCall].map(callSession) : [c.other].filter(Boolean) };
  }
  return null;
}

/** Keeps the voice engine's sending of our screen's sound in step with who's watching. */
function syncStreamAudio() {
  const want = streamListeners();
  const key = want ? (want.call ? "call:" : "voice:") + want.to.sort((a, b) => a - b).join(",") : "";
  if (key === streamAudio.told) return;
  const before = streamAudio.told;
  streamAudio.told = key;
  // Switching between a call and a voice channel: the old one stops first.
  if (before && (!want || before.split(":")[0] !== key.split(":")[0])) invoke("set_stream_audio", { watchers: null, call: before.startsWith("call:") }).catch(() => {});
  if (!want) return;
  invoke("set_stream_audio", { watchers: want.to, call: want.call }).catch((err) => {
    if (streamAudio.failed) return;
    streamAudio.failed = true;
    toast(friendlyError(err), true);
  });
}

function setShareSound(on) {
  prefs.shareSound = on;
  save("shareSound", on ? "1" : "0");
  syncStreamAudio();
}

/** "1080p · 60 fps", as chosen. */
function shareQualityText() {
  const size = shareSize();
  return (size.w ? size.label : "Source") + " · " + prefs.shareQuality.rate + " fps" + (prefs.shareSound ? " · sound" : "");
}
function openShareQuality(x, y, above) {
  const q = prefs.shareQuality;
  openMenu([
    { heading: "Resolution" },
    ...SHARE_SIZES.map((z) => ({ label: z.label, checked: q.size === z.id, action: () => setShareQuality({ size: z.id }) })),
    "sep",
    { heading: "Frame rate" },
    ...SHARE_RATES.map((r) => ({ label: r + " fps" + (r === 60 ? " (games, video)" : r === 30 ? " (sharpest text)" : " (light on your network)"), checked: q.rate === r, action: () => setShareQuality({ rate: r }) })),
    "sep",
    { heading: "Up to " + SHARE_MBIT[q.size][q.rate] + " Mbit/s to each viewer" },
    "sep",
    { label: "Share my computer's sound", check: prefs.shareSound, action: (on) => setShareSound(on) },
  ], x, y, above);
}

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
    stream = await navigator.mediaDevices.getDisplayMedia({ video: shareConstraints(), audio: false });
  } catch (err) {
    // Closing the picker isn't an error.
    if (err?.name !== "NotAllowedError" && err?.name !== "AbortError") toast("Couldn't share your screen. " + (err?.message ?? ""), true);
    return;
  }
  const track = stream.getVideoTracks()[0];
  if (!track || !canShare()) return stream.getTracks().forEach((t) => t.stop());
  // Text and windows stay sharp, or motion stays smooth: as chosen.
  track.contentHint = shareHint();
  // Windows' own "Stop sharing" ends it too.
  track.addEventListener("ended", () => stopShare());
  screenShare.stream = stream;
  queueMicrotask(syncStreamerAuto);
  tellSendingVideo();
  call("set_sharing", { on: true });
  renderVoicePanel();
  // See what the others see.
  watchScreen(state.roster.me);
}

function stopShare(quiet = false) {
  queueMicrotask(syncStreamerAuto);
  if (!screenShare.stream) return;
  for (const [viewer, pc] of screenShare.peers) {
    if (!quiet) screenSend(viewer, { k: "stop", s: "viewer" });
    pc.close();
  }
  screenShare.peers.clear();
  if (watching?.local) stopWatching(false);
  screenShare.stream.getTracks().forEach((t) => t.stop());
  screenShare.stream = null;
  tellSendingVideo();
  syncStreamAudio();
  if (!quiet && connected()) call("set_sharing", { on: false });
  renderVoicePanel();
}

/** Someone asked to watch: a connection carrying our screen to them. */
async function serveViewer(viewer) {
  screenShare.peers.get(viewer)?.close();
  // Held at once, so asking twice in a row doesn't leave a second connection behind.
  const hold = { close() {}, pendingIce: [] };
  screenShare.peers.set(viewer, hold);
  const pc = new RTCPeerConnection(await rtcConfig());
  if (!screenShare.stream || screenShare.peers.get(viewer) !== hold) return pc.close();
  pc.pendingIce = [];
  screenShare.peers.set(viewer, pc);
  pc.onicecandidate = (e) => e.candidate && screenSend(viewer, { k: "ice", s: "viewer", c: e.candidate.toJSON() });
  pc.onconnectionstatechange = () => {
    if ((pc.connectionState === "failed" || pc.connectionState === "closed") && screenShare.peers.get(viewer) === pc) screenShare.peers.delete(viewer);
    // How many watch shows on your own stream; whoever watches hears its sound.
    if (watching?.local) screenInfo();
    syncStreamAudio();
  };
  const track = screenShare.stream.getVideoTracks()[0];
  pc.addTrack(track, screenShare.stream);
  preferSmoothCodec(pc);
  await pc.setLocalDescription(await pc.createOffer());
  screenSend(viewer, { k: "offer", s: "viewer", sdp: pc.localDescription.sdp });
}

/** As good as chosen (1080p at 30 a second unless you pick otherwise: up to 6 Mbit/s, sharp text first). */
function tuneScreenSender(pc) {
  tuneShare(pc);
}

function watchScreen(session, asked = false) {
  if (asked) {
    skippedStreams.delete(session);
    // Asking for a screen puts it in the middle, also when a camera was there.
    if (typeof focusTile !== "undefined") focusTile = null;
  }
  // Like Discord: watching takes you to their voice channel, where the stream shows big.
  const where = state.roster?.users.find((u) => u.session_id === session)?.voice_channel;
  if (where != null && voiceChat() && state.view !== where) openTextChannel(where);
  // Not in their voice channel: join it, then the stream starts (streams are for who's there).
  if (where != null && session !== state.roster?.me && myVoice() !== where) {
    skippedStreams.delete(session);
    state.pendingWatch = { session, channel: where, at: Date.now() };
    joinVoice(where);
    return;
  }
  if (watching?.from === session) return;
  stopWatching();
  if (session === state.roster?.me) {
    // Your own: shown straight from your screen.
    if (!screenShare.stream) return;
    watching = { from: session, pc: null, pending: [], local: true };
    $("screen-video").srcObject = screenShare.stream;
    renderScreenStage();
    renderSidebar();
    return;
  }
  const w = { from: session, pc: null, pending: [], tries: 0 };
  watching = w;
  renderScreenStage();
  renderSidebar();
  askForScreen(w);
}

/** Streams you closed (or that couldn't be reached): they wait for a click instead of starting again. */
var skippedStreams = new Set();

/** Asks the one sharing for their screen; says so if nothing comes of it. */
function askForScreen(w) {
  const attempt = ++w.tries;
  screenSend(w.from, { k: "watch", s: "sharer" });
  setTimeout(() => {
    if (watching !== w || w.tries !== attempt || w.pc?.connectionState === "connected") return;
    retryScreen(w);
  }, 10_000);
}

/** The stream didn't come through: once more from the start, then give up and say why. */
function retryScreen(w) {
  if (watching !== w) return;
  w.pc?.close();
  w.pc = null;
  w.pending = [];
  if (w.tries >= 3) {
    skippedStreams.add(w.from);
    toast("Couldn't connect to " + (userName(w.from) ?? "their") + (userName(w.from) ? "'s" : "") + " screen. Their network or yours is blocking it.", true);
    return stopWatching();
  }
  $("screen-video").srcObject = null;
  $("screen-wait").hidden = false;
  askForScreen(w);
}

/**
 * In the voice channel you're looking at, a screen someone shares starts by itself: when it's
 * the only one, and you didn't close it. Several at once wait for you to pick.
 */
function autoWatch() {
  if (watching || state.pendingWatch || !state.roster || !online()) return;
  const mine = myVoice();
  if (mine === null || state.view !== mine) return;
  const sharers = state.roster.users.filter((u) => u.sharing && u.voice_channel === mine && u.session_id !== state.roster.me);
  if (sharers.length === 1 && !skippedStreams.has(sharers[0].session_id)) {
    if (typeof focusTile !== "undefined") focusTile = null;
    watchScreen(sharers[0].session_id);
  }
}

function stopWatching(tell = true) {
  if (!watching) return;
  if (tell && !watching.local) screenSend(watching.from, { k: "stop", s: "sharer" });
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
  if (m.v === "m") return handleMedia(from, m, voiceRoom);
  if (m.s === "sharer") {
    // To us, as the one sharing.
    if (!screenShare.stream) return;
    if (m.k === "watch") return serveViewer(from);
    const pc = screenShare.peers.get(from);
    if (!pc) return;
    if (!pc.setRemoteDescription) {
      // Still being set up: only "stop" means anything yet.
      if (m.k === "stop") screenShare.peers.delete(from);
      return;
    }
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
      if (watching?.local) screenInfo();
      syncStreamAudio();
    }
    return;
  }
  // To us, as a viewer.
  const w = watching;
  if (!w || w.from !== from) return;
  if (m.k === "offer") {
    w.pc?.close();
    const pc = new RTCPeerConnection(await rtcConfig());
    if (watching !== w) return pc.close();
    w.pc = pc;
    pc.ontrack = (ev) => ($("screen-video").srcObject = ev.streams[0] ?? new MediaStream([ev.track]));
    pc.onicecandidate = (ev) => ev.candidate && screenSend(from, { k: "ice", s: "sharer", c: ev.candidate.toJSON() });
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" && watching === w && w.pc === pc) retryScreen(w);
    };
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
    skippedStreams.clear();
    return;
  }
  for (const id of skippedStreams) if (!state.roster.users.some((u) => u.session_id === id && u.sharing && u.voice_channel === myVoice())) skippedStreams.delete(id);
  // Your own stays while you share (the server may not have said so yet).
  if (watching && !watching.local) {
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
    if (state.view !== null && isVoiceChannel(state.view)) renderVoiceStage();
    return;
  }
  $("screen-who").textContent = watching.local ? "Your screen" : (userName(watching.from) ?? "Someone") + "'s screen";
  $("screen-quality").hidden = !watching.local;
  $("screen-close").setAttribute("aria-label", watching.local ? "Hide your own stream" : "Stop watching");
  screenInfo();
  if (isVoiceChannel(state.view)) renderVoiceStage();
  $("screen-wait").hidden = !!video.srcObject && !video.paused;
}

/** Beside the name: how good it is (yours: as chosen, and how many watch; theirs: as it arrives). */
function screenInfo() {
  const video = $("screen-video");
  if (!watching) return;
  if (video.videoWidth && video.videoHeight) video.parentElement.style.setProperty("--ar", (video.videoWidth / video.videoHeight).toFixed(4));
  if (watching.local) {
    const n = [...screenShare.peers.values()].filter((pc) => pc.connectionState === "connected").length;
    $("screen-info").textContent = shareQualityText() + (n ? " · " + n + " watching" : "") + (videoBudget() < 1 ? " · making room for voice" : "");
  } else {
    $("screen-info").textContent = video.videoHeight ? Math.min(video.videoWidth, video.videoHeight) + "p" : "";
  }
}
for (const ev of ["loadedmetadata", "resize"]) $("screen-video").addEventListener(ev, screenInfo);

// What's on the picture fades away when the pointer rests, and comes back when it moves.
(() => {
  const frame = $("screen-video").parentElement;
  let rest = 0;
  const wake = () => {
    frame.classList.remove("idle");
    clearTimeout(rest);
    rest = setTimeout(() => {
      if (!frame.querySelector(".screen-bar:hover, .screen-tag:hover")) frame.classList.add("idle");
    }, 2500);
  };
  frame.addEventListener("pointermove", wake);
  frame.addEventListener("pointerdown", wake);
  frame.addEventListener("pointerleave", () => {
    clearTimeout(rest);
    rest = setTimeout(() => frame.classList.add("idle"), 700);
  });
  $("screen-video").addEventListener("playing", wake);
})();

$("screen-quality").addEventListener("click", (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  openShareQuality(r.left, r.top, true);
});
$("share-btn").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  openShareQuality(e.clientX, e.clientY, true);
});

$("screen-video").addEventListener("playing", () => ($("screen-wait").hidden = true));
$("screen-video").addEventListener("dblclick", () => toggleScreenFull());
$("screen-full").addEventListener("click", () => toggleScreenFull());
$("screen-close").addEventListener("click", () => {
  // Closed by hand: it stays closed until you ask for it again.
  if (watching && !watching.local) skippedStreams.add(watching.from);
  stopWatching();
});
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

// ---------- switching servers without the wait ----------
//
// Leaving a server keeps what was on screen (channels, messages, members). Coming back shows
// it at once, quietly and not clickable, until the server answers a moment later; the fresh
// view then reuses those very messages, so nothing jumps.

/** What each server looked like when you left it, for this session. */
var serverViews = new Map();

function rememberServerView() {
  // Leaving a server stops what was playing there: remembered rows must not start it again.
  stopVideosIn($("messages"));
  if (!state.activeId || !state.roster || state.atHome) return;
  serverViews.set(state.activeId, {
    channel: $("chat-channel").textContent,
    topic: $("chat-topic").textContent,
    sidebar: [...$("sidebar-body").children],
    messages: [...$("messages").children].filter((n) => n.dataset.key || n.classList.contains("welcome") || n.classList.contains("day-divider")),
    members: [...$("member-list").children],
  });
}

/** Connected again: the remembered view gives way to the real one. */
function freshView() {
  for (const n of [$("sidebar-body"), $("messages"), $("member-list")]) n.classList.remove("stale");
}

// ---------- long channels stay fast ----------
//
// Only a window of a channel is drawn: the newest DRAW_WINDOW messages (and back to the first
// unread). Scrolling up draws more from memory before asking the server; new messages join
// the window, and at the bottom it's trimmed back, out of sight.

var DRAW_WINDOW = 70;
var DRAW_MORE = 100;
/** The oldest message drawn in each channel. */
state.drawFrom = new Map();

function drawWindow(all, opening, unreadFrom, atBottom) {
  const view = state.view;
  if (!all.length) return all;
  let from = state.drawFrom.get(view);
  const newest = all[Math.max(0, all.length - DRAW_WINDOW)].id;
  if (opening || from === undefined) {
    from = newest;
    // Back to the first unread, so the "New" line is there.
    if (unreadFrom !== null && unreadFrom !== undefined) from = Math.min(from, all.find((m) => m.id > unreadFrom)?.id ?? from);
  } else if (atBottom && all.length - all.findIndex((m) => m.id >= from) > DRAW_WINDOW * 2) {
    // At the bottom with a long tail drawn above: let the old part go.
    from = newest;
  }
  state.drawFrom.set(view, from);
  return all.filter((m) => m.id >= from);
}

/** Draws older messages that are already here, keeping what you see in place. False if none. */
function showMoreAbove() {
  const all = state.chats.get(state.view) ?? [];
  const from = state.drawFrom.get(state.view);
  const at = all.findIndex((m) => m.id >= from);
  if (from === undefined || at <= 0) return false;
  state.drawFrom.set(state.view, all[Math.max(0, at - DRAW_MORE)].id);
  const scroller = $("scroller");
  const fromBottom = scroller.scrollHeight - scroller.scrollTop;
  renderMessages(true);
  scroller.scrollTop = scroller.scrollHeight - fromBottom;
  if (state.jumpTo) jumpToMessage(state.jumpTo);
  return true;
}

// ---------- a voice channel's own view ----------
//
// Open a voice channel and its people are on a stage at the top (lit while they talk, LIVE to
// watch a screen), with the channel's own chat below.

/**
 * A voice channel is its own view, like Discord's: everyone's tile fills the space (sized so
 * all fit), cameras play in their tiles, and a screen you watch or a camera you pick takes the
 * middle with the others in a row below. The channel's chat opens beside it from the header.
 * The whole view can go full screen; a focused video can pop out.
 */
function renderVoiceStage() {
  const stage = $("voice-stage");
  const view = state.view;
  const show = online() && view !== null && isVoiceChannel(view);
  const chat = stage.closest(".chat");
  chat.classList.toggle("voice-mode", show);
  chat.classList.toggle("chat-open", show && voiceChatOpen());
  document.querySelector(".channel-view").classList.toggle("voice-view", show);
  $("voice-chat-btn").hidden = !show;
  $("voice-chat-btn").classList.toggle("selected", show && voiceChatOpen());
  $("members-toggle").hidden = show;
  stage.hidden = !show;
  const screen = $("screen-stage");
  // Leaving the voice view in full screen would leave an empty black screen.
  if (!show && document.fullscreenElement === stage) document.exitFullscreen().catch(() => {});
  if (!show) {
    // Watching from a text channel: the screen sits above that chat, where it always did.
    if (screen.parentElement !== chat) chat.insertBefore(screen, stage);
    return;
  }
  autoWatch();
  const here = state.roster.users.filter((u) => u.voice_channel === view).sort(byName);
  const mine = myVoice() === view;
  const camOf = (u) => mediaStream("cam", u.session_id === state.roster.me ? "me" : u.session_id);
  // What's in the middle is what you picked last: a camera you clicked, or else the screen you watch.
  const watchingHere = !!watching && here.some((u) => u.session_id === watching.from);
  const camFocus = focusTile !== null && here.some((u) => u.session_id === focusTile && camOf(u));
  const screenFocus = watchingHere && !camFocus;
  // A camera in the middle while a screen plays: the screen waits in the row below, a click away.
  chat.classList.toggle("screen-aside", watchingHere && camFocus);
  // Screens being shared that you aren't watching: offered big, in the middle.
  const offers = screenFocus || camFocus ? [] : here.filter((u) => u.sharing && u.session_id !== state.roster.me);
  const focused = screenFocus || camFocus || offers.length > 0;
  const tiles = el("div", "voice-tiles" + (focused ? " strip" : ""));
  const main = focused ? el("div", "stage-main") : null;
  for (const u of here) {
    const tile = el("button", "voice-tile" + (state.speaking.has(u.session_id) ? " speaking" : ""));
    tile.type = "button";
    tile.dataset.user = u.session_id;
    const isMe = u.session_id === state.roster.me;
    const cam = camOf(u);
    tile.classList.toggle("video", !!cam);
    if (cam) tile.append(videoEl("cam|" + (isMe ? "me" : u.session_id), cam, isMe));
    else tile.append(avatar(u.name, "s64", undefined, pictureFor(keyOf(u))));
    const marks = el("span", "voice-tile-marks");
    if (u.muted || u.server_muted) marks.append(icon("mic-off", "xs"));
    if (u.deafened || u.server_deafened) marks.append(icon("headphones-off", "xs"));
    if (u.sharing) marks.append(el("span", "live-pill" + (watching?.from === u.session_id ? " watching" : ""), "LIVE"));
    tile.append(styleName(el("span", "voice-tile-name ellipsis", u.name), keyOf(u), u.name, false, "tile"), marks);
    tile.addEventListener("click", (e) => {
      if (e.target.closest(".live-pill")) return watchScreen(u.session_id, true);
      // A camera: in the middle, big (click it again for everyone).
      if (cam) {
        focusTile = focusTile === u.session_id ? null : u.session_id;
        return renderVoiceStage();
      }
      if (u.sharing) return watchScreen(u.session_id, true);
      if (!isMe) openUserCard(u, tile);
    });
    if (camFocus && u.session_id === focusTile) {
      tile.classList.add("focus");
      main.append(tile);
    } else tiles.append(tile);
  }
  if (watchingHere && camFocus) {
    const back = el("button", "voice-tile screen-back");
    back.type = "button";
    const mark = el("span", "screen-back-icon");
    mark.append(icon("monitor"));
    const marks = el("span", "voice-tile-marks");
    marks.append(el("span", "live-pill watching", "LIVE"));
    back.append(mark, el("span", "voice-tile-name ellipsis", watching.local ? "Your screen" : (userName(watching.from) ?? "Someone") + "'s screen"), marks);
    back.addEventListener("click", () => {
      focusTile = null;
      renderVoiceStage();
    });
    tiles.prepend(back);
  }
  if (offers.length) {
    const cards = el("div", "stream-cards");
    for (const u of offers) {
      const card = el("button", "stream-card");
      card.type = "button";
      card.dataset.stream = u.session_id;
      const badge = el("span", "stream-card-icon");
      badge.append(icon("monitor"));
      card.append(badge, el("strong", "ellipsis", u.name), el("span", "stream-card-sub", "is sharing their screen"), el("span", "btn primary sm", mine ? "Watch" : "Join and watch"));
      card.addEventListener("click", () => watchScreen(u.session_id, true));
      cards.append(card);
    }
    main.append(cards);
  }
  if (screenFocus) {
    main.append(screen);
    screen.querySelector("video")?.play?.().catch(() => {});
  } else if (screen.parentElement !== chat) chat.insertBefore(screen, stage);

  // Top right: back to everyone, pop out, full screen.
  const bar = el("div", "stage-bar");
  const button = (iconName, label, onClick) => {
    const btn = el("button", "stage-btn");
    btn.type = "button";
    btn.setAttribute("aria-label", label);
    btn.append(icon(iconName));
    btn.addEventListener("click", onClick);
    bar.append(btn);
  };
  if (camFocus) {
    button("pip", "Pop out", () => {
      const v = main.querySelector("video");
      if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
      else v?.requestPictureInPicture?.().catch(() => toast("This video can't pop out right now.", true));
    });
    button("grid", "Show everyone", () => {
      focusTile = null;
      renderVoiceStage();
    });
  }
  button(document.fullscreenElement === stage ? "minimize" : "maximize", "Full screen", () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else stage.requestFullscreen().catch(() => {});
  });

  const foot = el("div", "voice-stage-foot");
  if (!mine) {
    const join = el("button", "btn primary", here.length ? "Join voice" : "Join, and be the first");
    join.type = "button";
    join.addEventListener("click", () => joinVoice(view));
    foot.append(join);
  } else if (here.length === 1) {
    foot.append(el("span", "voice-stage-hint", "Nobody else is here yet."));
  }
  if (mine) {
    const invite = el("button", "btn sm", "Invite friends");
    invite.type = "button";
    invite.addEventListener("click", () => openInvite());
    foot.append(invite);
  }
  if (channel(view)?.afk_after) foot.prepend(el("span", "voice-stage-hint", "This is the AFK channel: people away for " + channel(view).afk_after + " minutes end up here."));
  // A screen in the middle brings its own buttons (pop out, full screen, stop watching).
  stage.replaceChildren(...(screenFocus ? [] : [bar]), ...(main ? [main] : []), here.length ? tiles : el("p", "voice-stage-empty", "Nobody is in " + channelName(view) + " right now."), ...(screenFocus && mine ? [] : [foot]));
  fitTiles();
}

/** Sizes the tiles so everyone fits the space as big as possible (16:9 each). */
function fitTiles(box = document.querySelector("#voice-stage .voice-tiles")) {
  if (!box || box.classList.contains("strip")) return;
  const n = box.children.length;
  const w = box.clientWidth;
  const h = box.clientHeight;
  if (!n || !w || !h) return;
  const gap = 8;
  const sizes = [];
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    sizes.push(Math.min((w - gap * (cols - 1)) / cols, ((h - gap * (rows - 1)) / rows) * (16 / 9)));
  }
  // Side by side reads better than a tall stack: the most columns within a tenth of the biggest size.
  const top = Math.max(...sizes);
  let best = top;
  for (let i = sizes.length - 1; i >= 0; i--) if (sizes[i] >= top * 0.9) { best = sizes[i]; break; }
  box.style.setProperty("--tile-w", Math.floor(Math.max(120, Math.min(best, 720))) + "px");
}
new ResizeObserver(() => fitTiles()).observe($("voice-stage"));
document.addEventListener("fullscreenchange", () => {
  if (document.fullscreenElement === $("voice-stage") || !document.fullscreenElement) renderVoiceStage();
});

/** The chat beside a voice channel: open unless you closed it. */
function voiceChatOpen() {
  // Until you choose, it opens when there is room for it beside everyone.
  return prefs.voiceChatOpen ?? window.innerWidth >= 1100;
}
prefs.voiceChatOpen = loadJson("voiceChatOpen", null);
$("voice-chat-btn").addEventListener("click", () => {
  prefs.voiceChatOpen = !voiceChatOpen();
  save("voiceChatOpen", JSON.stringify(prefs.voiceChatOpen));
  $("voice-chat-dot").hidden = true;
  renderVoiceStage();
  if (prefs.voiceChatOpen) {
    renderMessages(false);
    $("chat-input").focus();
  }
});

// ---------- moderating voice ----------
//
// Moderators can take someone out of voice, move them to another voice channel (from the
// menu, or by dragging them onto it), and mute or deafen them for everyone.

function voiceMod() {
  return !!state.roster?.features?.includes("voice-mod") && can("moderate");
}

/** The voice part of a moderator's menu on someone in voice. */
function voiceModItems(u) {
  if (!voiceMod() || u.voice_channel === null) return [];
  const others = voiceChannels().filter((c) => c.id !== u.voice_channel);
  // What the server says now (the menu may stay open across changes).
  const latest = () => state.roster?.users.find((x) => x.session_id === u.session_id) ?? u;
  const moves = others.map((c) => ({ label: c.name, icon: "volume", action: () => call("move_voice", { sessionId: u.session_id, channel: c.id }) }));
  return [{ label: "Voice", submenu: [
    { label: "Server mute", check: !!u.server_muted, action: (on) => call("server_mute", { sessionId: u.session_id, muted: on, deafened: !!latest().server_deafened }) },
    { label: "Server deafen", check: !!u.server_deafened, action: (on) => call("server_mute", { sessionId: u.session_id, muted: !!latest().server_muted, deafened: on }) },
    ...(moves.length ? ["sep", { heading: "Move to" }, ...moves] : []),
    "sep",
    { label: "Disconnect", icon: "logout", danger: true, action: () => call("disconnect_voice", { sessionId: u.session_id }) },
  ] }];
}

/** Moderators drag people between voice channels. */
var voiceDrag = null;

function draggableVoiceUser(row, u) {
  if (!voiceMod() || !outranks(u)) return row;
  row.draggable = true;
  row.addEventListener("dragstart", (e) => {
    voiceDrag = u;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", u.name);
    requestAnimationFrame(() => row.classList.add("dragging"));
  });
  row.addEventListener("dragend", () => {
    voiceDrag = null;
    document.querySelectorAll(".voice-user.dragging, .channel-row.drop-into").forEach((n) => n.classList.remove("dragging", "drop-into"));
  });
  return row;
}

function acceptVoiceDrop(row, ch) {
  row.addEventListener("dragover", (e) => {
    if (!voiceDrag || voiceDrag.voice_channel === ch.id) return;
    e.preventDefault();
    row.classList.add("drop-into");
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-into"));
  row.addEventListener("drop", (e) => {
    if (!voiceDrag || voiceDrag.voice_channel === ch.id) return;
    e.preventDefault();
    row.classList.remove("drop-into");
    call("move_voice", { sessionId: voiceDrag.session_id, channel: ch.id });
    voiceDrag = null;
  });
}

/** What a moderator did to you: say so, and keep your microphone in line with it. */
function followModerators(before, after, mineBefore) {
  const me = state.roster?.users.find((u) => u.session_id === state.roster.me);
  if (!me) return;
  // Moved or disconnected by someone else (you didn't click anything).
  if (before !== null && after !== before && !state.voiceByMe) {
    if (after === null) toast("A moderator disconnected you from voice.");
    else toast("A moderator moved you to " + channelName(after) + ".");
  }
  state.voiceByMe = false;
  if (me.server_muted && !mineBefore?.server_muted) {
    state.forcedMute = !state.muted;
    if (!state.muted) setMuted(true);
    toast("A moderator muted you.");
  } else if (!me.server_muted && mineBefore?.server_muted) {
    if (state.forcedMute) setMuted(false);
    state.forcedMute = false;
    toast("A moderator unmuted you.");
  }
  if (me.server_deafened && !mineBefore?.server_deafened) {
    state.forcedDeafen = !state.deafened;
    if (!state.deafened) setDeafened(true);
    toast("A moderator deafened you.");
  } else if (!me.server_deafened && mineBefore?.server_deafened) {
    if (state.forcedDeafen) setDeafened(false);
    state.forcedDeafen = false;
  }
}

// ---------- camera video, and screens in calls ----------
//
// Turn your camera on and it goes straight to everyone in your voice channel or call (WebRTC,
// encrypted on the way, through the relay when blocked); theirs come to you the same way and
// show in their tiles. In calls, a shared screen goes to everyone too. Handshakes travel with
// the voice channel (the server passes them on) or the call (your account passes them on).

/** What we send ("cam", "screen" in calls): the stream and a connection per person. */
var media = { out: {} };
/** What we receive, by "kind|person": its connection and stream. */
var mediaIn = new Map();
/** The tile shown big in a voice channel. */
var focusTile = null;
/** Video elements kept across redraws, so a stream never flickers. */
var videoEls = new Map();

/** Where video goes now: the call, or the voice channel. */
var voiceRoom = {
  kind: "voice",
  peers: () => (canShare() ? state.roster.users.filter((u) => u.voice_channel === myVoice() && u.session_id !== state.roster.me).map((u) => u.session_id) : []),
  send: (peer, msg) => screenSend(peer, msg),
};
var callRoom = {
  kind: "call",
  peers: () => {
    const c = state.call;
    if (!c?.engineReady) return [];
    return c.group ? [...c.inCall] : [c.peer];
  },
  send: (peer, msg) => state.call && callSend(state.call, "media", { data: JSON.stringify(msg) }, state.call.group ? [peer] : undefined),
};
function mediaRoom() {
  if (state.call?.engineReady) return callRoom;
  if (canShare()) return voiceRoom;
  return null;
}

function mediaStream(kind, id) {
  if (id === "me") return media.out[kind]?.stream ?? null;
  return mediaIn.get(kind + "|" + id)?.stream ?? null;
}

/** One video element per stream, reused wherever it's shown. */
function videoEl(key, stream, mirror) {
  let v = videoEls.get(key);
  if (!v) {
    v = document.createElement("video");
    v.autoplay = true;
    v.muted = true;
    v.playsInline = true;
    v.className = "tile-video";
    videoEls.set(key, v);
  }
  if (v.srcObject !== stream) v.srcObject = stream;
  v.classList.toggle("mirror", !!mirror);
  return v;
}

async function startCamera() {
  const room = mediaRoom();
  if (!room || media.out.cam) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false });
  } catch (err) {
    if (err?.name === "NotAllowedError") return toast("Hopp wasn't allowed to use your camera.", true);
    return toast(err?.name === "NotFoundError" ? "No camera found." : "Couldn't start your camera. " + (err?.message ?? ""), true);
  }
  startOut("cam", stream, room);
}

/** In a call, your screen goes to everyone in it. */
async function startCallScreen() {
  const room = mediaRoom();
  if (room?.kind !== "call" || media.out.screen) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: shareConstraints(), audio: false });
  } catch (err) {
    if (err?.name !== "NotAllowedError" && err?.name !== "AbortError") toast("Couldn't share your screen. " + (err?.message ?? ""), true);
    return;
  }
  stream.getVideoTracks()[0].contentHint = shareHint();
  startOut("screen", stream, room);
}

function startOut(kind, stream, room) {
  if (kind === "screen") queueMicrotask(syncStreamerAuto);
  const out = (media.out[kind] = { stream, room, peers: new Map(), told: new Set() });
  queueMicrotask(tellSendingVideo);
  queueMicrotask(syncStreamAudio);
  stream.getVideoTracks()[0]?.addEventListener("ended", () => stopOut(kind));
  for (const peer of room.peers()) reachOut(kind, out, peer);
  renderMediaViews();
}

// A camera goes to everyone at once. A screen in a call is watched on demand, like Discord: we
// only say we're live, and send it to whoever asks to watch (and stop when they stop).
function reachOut(kind, out, peer) {
  if (kind !== "screen") return offerMedia(kind, peer);
  out.told.add(String(peer));
  out.room.send(peer, { v: "m", t: "screen", d: "r", k: "live" });
}

/** Screens being shared with us in a call (by Hopp ID), and the ones we asked to watch. */
var liveIn = new Set();
var wantIn = new Set();

function watchCallScreen(peer) {
  if (!state.call) return;
  wantIn.add(peer);
  callRoom.send(peer, { v: "m", t: "screen", d: "s", k: "want" });
  callFocus = "screen|" + peer;
  renderMediaViews();
}

function stopWatchingCallScreen(peer) {
  wantIn.delete(peer);
  callRoom.send(peer, { v: "m", t: "screen", d: "s", k: "unwant" });
  const key = "screen|" + peer;
  mediaIn.get(key)?.pc?.close();
  mediaIn.delete(key);
  videoEls.delete(key);
  if (callFocus === key) callFocus = null;
  renderMediaViews();
}

function stopOut(kind, quiet = false) {
  if (kind === "screen") queueMicrotask(syncStreamerAuto);
  const out = media.out[kind];
  if (!out) return;
  delete media.out[kind];
  queueMicrotask(tellSendingVideo);
  queueMicrotask(syncStreamAudio);
  // Everyone we sent it to, or told we were live, hears that it ended.
  const told = new Set([...out.told].concat([...out.peers.keys()].map(String)));
  for (const pc of out.peers.values()) pc.close();
  if (!quiet) for (const peer of told) out.room.send(peer, { v: "m", t: kind, d: "r", k: "stop" });
  out.stream.getTracks().forEach((t) => t.stop());
  videoEls.delete(kind + "|me");
  renderMediaViews();
}

function stopAllMedia() {
  for (const kind of Object.keys(media.out)) stopOut(kind, true);
  for (const [key, m] of mediaIn) {
    m.pc?.close();
    videoEls.delete(key);
  }
  mediaIn.clear();
  liveIn.clear();
  wantIn.clear();
  focusTile = null;
}

/** Sends one of our streams to one person. */
async function offerMedia(kind, peer) {
  const out = media.out[kind];
  if (!out) return;
  out.peers.get(peer)?.close();
  // Held at once, so a redraw meanwhile doesn't start a second one.
  out.peers.set(peer, { close() {}, pending: true });
  const pc = new RTCPeerConnection(await rtcConfig());
  if (media.out[kind] !== out || !out.peers.has(peer)) return pc.close();
  pc.pendingIce = [];
  out.peers.set(peer, pc);
  pc.onicecandidate = (e) => e.candidate && out.room.send(peer, { v: "m", t: kind, d: "r", k: "ice", c: e.candidate.toJSON() });
  // Didn't get through: twice more from the start (the other side takes a new offer as a fresh one).
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") out.tries?.delete(peer);
    if (pc.connectionState !== "failed" || media.out[kind] !== out || out.peers.get(peer) !== pc) return;
    out.tries ??= new Map();
    const tries = (out.tries.get(peer) ?? 0) + 1;
    out.tries.set(peer, tries);
    if (tries <= 2) offerMedia(kind, peer);
  };
  pc.addTrack(out.stream.getVideoTracks()[0], out.stream);
  if (kind === "screen") preferSmoothCodec(pc);
  await pc.setLocalDescription(await pc.createOffer());
  out.room.send(peer, { v: "m", t: kind, d: "r", k: "offer", sdp: pc.localDescription.sdp });
}

function tuneSender(pc, kind) {
  if (kind === "screen") return tuneShare(pc);
  for (const sender of pc.getSenders()) {
    setSenderParams(sender, (p) => {
      p.encodings[0].maxBitrate = Math.round(1_800_000 * videoBudget());
      p.degradationPreference = "balanced";
    });
  }
}

/** A call's media handshake (people in a call are known by their Hopp ID). */
function mediaSignal(m) {
  let data;
  try {
    data = JSON.parse(m.data);
  } catch {
    return;
  }
  if (data.v === "m") handleMedia(m.from, data, callRoom);
}

async function handleMedia(from, m, room) {
  const kind = m.t === "screen" ? "screen" : "cam";
  if (m.d === "s") {
    // To us as the one sending: they want to watch, they stopped watching, their answer, or
    // their network addresses.
    if (m.k === "want") return media.out[kind] && offerMedia(kind, from);
    if (m.k === "unwant") {
      const out = media.out[kind];
      out?.peers.get(from)?.close();
      out?.peers.delete(from);
      return;
    }
    const pc = media.out[kind]?.peers.get(from);
    if (!pc || pc.pending) return;
    if (m.k === "answer") {
      await pc.setRemoteDescription({ type: "answer", sdp: m.sdp }).catch(() => {});
      for (const c of pc.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      tuneSender(pc, kind);
    } else if (m.k === "ice") {
      if (pc.remoteDescription) await pc.addIceCandidate(m.c).catch(() => {});
      else pc.pendingIce.push(m.c);
    }
    return;
  }
  // To us as the one receiving.
  const key = kind + "|" + from;
  if (m.k === "live") {
    if (room !== callRoom) return;
    liveIn.add(from);
    // We were watching before (they started again, or we came back): carry on watching.
    if (wantIn.has(from)) room.send(from, { v: "m", t: "screen", d: "s", k: "want" });
    renderMediaViews();
    return;
  }
  if (m.k === "offer") {
    if (kind === "screen" && room === callRoom) liveIn.add(from);
    mediaIn.get(key)?.pc?.close();
    const entry = { pc: null, stream: null, pending: [] };
    mediaIn.set(key, entry);
    const pc = new RTCPeerConnection(await rtcConfig());
    if (mediaIn.get(key) !== entry) return pc.close();
    entry.pc = pc;
    pc.ontrack = (ev) => {
      entry.stream = ev.streams[0] ?? new MediaStream([ev.track]);
      renderMediaViews();
    };
    pc.onicecandidate = (ev) => ev.candidate && room.send(from, { v: "m", t: kind, d: "s", k: "ice", c: ev.candidate.toJSON() });
    await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
    for (const c of entry.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    await pc.setLocalDescription(await pc.createAnswer());
    room.send(from, { v: "m", t: kind, d: "s", k: "answer", sdp: pc.localDescription.sdp });
  } else if (m.k === "ice") {
    const entry = mediaIn.get(key);
    if (entry?.pc?.remoteDescription) await entry.pc.addIceCandidate(m.c).catch(() => {});
    else entry?.pending.push(m.c);
  } else if (m.k === "stop") {
    mediaIn.get(key)?.pc?.close();
    mediaIn.delete(key);
    videoEls.delete(key);
    if (kind === "screen") {
      liveIn.delete(from);
      wantIn.delete(from);
    }
    if (focusTile === from) focusTile = null;
    renderMediaViews();
  }
}

/** After every change in who's around: video only for the people still with us. */
function syncMedia() {
  const room = mediaRoom();
  if (!room) {
    if (Object.keys(media.out).length || mediaIn.size) stopAllMedia();
    return;
  }
  const peers = new Set(room.peers().map(String));
  for (const [kind, out] of Object.entries(media.out)) {
    if (out.room !== room) {
      stopOut(kind, true);
      continue;
    }
    // Newcomers get our camera (or hear our screen is live); people who left are let go.
    for (const p of room.peers()) {
      if (kind === "screen") {
        if (!out.told.has(String(p))) reachOut(kind, out, p);
      } else if (!out.peers.has(p)) offerMedia(kind, p);
    }
    for (const [p, pc] of out.peers) {
      if (!peers.has(String(p))) {
        pc.close();
        out.peers.delete(p);
      }
    }
    for (const p of out.told) if (!peers.has(p)) out.told.delete(p);
  }
  for (const p of [...liveIn]) {
    if (!peers.has(String(p))) {
      liveIn.delete(p);
      wantIn.delete(p);
    }
  }
  for (const [key, m] of mediaIn) {
    if (!peers.has(key.split("|")[1])) {
      m.pc?.close();
      mediaIn.delete(key);
      videoEls.delete(key);
    }
  }
}

function renderMediaViews() {
  renderVoiceStage();
  renderVoicePanel();
  if (state.call) renderCall();
}

$("cam-btn").addEventListener("click", () => (media.out.cam ? stopOut("cam") : startCamera()));
$("screen-pip").addEventListener("click", () => {
  const v = $("screen-video");
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
  else v.requestPictureInPicture?.().catch(() => toast("This stream can't pop out right now.", true));
});

// Zoom into a shared screen with the wheel, and drag to look around; double-click resets.
(() => {
  const frame = $("screen-video").parentElement;
  const video = $("screen-video");
  let zoom = 1;
  let x = 0;
  let y = 0;
  const apply = () => {
    video.style.transform = zoom === 1 ? "" : "translate(" + x + "px, " + y + "px) scale(" + zoom + ")";
    frame.classList.toggle("zoomed", zoom > 1);
  };
  frame.addEventListener("wheel", (e) => {
    if (!watching) return;
    e.preventDefault();
    zoom = Math.min(4, Math.max(1, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    if (zoom === 1) x = y = 0;
    apply();
  }, { passive: false });
  frame.addEventListener("pointerdown", (e) => {
    if (zoom === 1 || e.target.closest(".screen-bar, .screen-tag")) return;
    frame.setPointerCapture(e.pointerId);
    const start = { px: e.clientX, py: e.clientY, x, y };
    const move = (ev) => {
      x = start.x + ev.clientX - start.px;
      y = start.y + ev.clientY - start.py;
      apply();
    };
    const up = () => {
      frame.removeEventListener("pointermove", move);
      frame.removeEventListener("pointerup", up);
    };
    frame.addEventListener("pointermove", move);
    frame.addEventListener("pointerup", up);
  });
  video.addEventListener("dblclick", () => {
    zoom = 1;
    x = y = 0;
    apply();
  });
})();

// ---------- the AFK channel ----------
//
// Away from the computer (no key or mouse anywhere in Windows) and silent for as long as the
// server's AFK channel says: you're moved there, muted, and told so when you're back.

var afk = { since: null };

async function checkAfk() {
  if (!connected() || myVoice() === null) return;
  const target = voiceChannels().find((c) => c.afk_after);
  if (!target || myVoice() === target.id) return;
  const idle = await invoke("idle_seconds").catch(() => 0);
  const quiet = !state.speaking.has(state.roster.me);
  if (idle >= target.afk_after * 60 && quiet) {
    afk.since = Date.now();
    await joinVoice(target.id);
    if (!state.muted) await setMuted(true);
    toast("You were away, so you were moved to " + target.name + ". Join a voice channel to come back.");
  }
}
setInterval(checkAfk, 30_000);

// Reaching the submenu keeps it open.
$("server-submenu").addEventListener("mouseenter", () => clearTimeout(submenuTimer));

// ---------- the soundboard ----------
//
// Short sounds everyone in your voice channel or call hears (deafened people don't).

var SOUNDBOARD = [
  ["ding", "Ding", "🔔"], ["tada", "Ta-da", "🎉"], ["horn", "Air horn", "📯"], ["drums", "Ba-dum-tss", "🥁"],
  ["boing", "Boing", "🌀"], ["sad", "Sad trombone", "🎺"], ["cheer", "Cheer", "👏"], ["pop", "Pop", "🫧"],
];
var soundboardAt = 0;

function openSoundboard(anchor) {
  const pop = $("soundboard");
  if (!pop.hidden) return closePopovers();
  const grid = el("div", "soundboard-grid");
  for (const [name, label, emoji] of SOUNDBOARD) {
    const b = el("button", "sound");
    b.type = "button";
    b.append(emojiText(emoji, "sound-emoji"), el("span", "sound-name", label));
    b.addEventListener("click", () => playSoundboard(name));
    grid.append(b);
  }
  pop.replaceChildren(el("div", "pins-title", "Soundboard"), grid, el("p", "soundboard-hint", "Everyone in the channel hears it."));
  const r = anchor.getBoundingClientRect();
  placePopover(pop, r.left, r.top);
  pop.style.top = Math.max(8, r.top - pop.offsetHeight - 8) + "px";
}

async function playSoundboard(name) {
  // One every couple of seconds, so it stays fun.
  if (Date.now() - soundboardAt < 2000) return;
  soundboardAt = Date.now();
  await invoke("play_soundboard", { name }).catch((err) => toast(friendlyError(err), true));
}

$("soundboard-btn").addEventListener("click", (e) => openSoundboard(e.currentTarget));

// ---------- timeouts, slowmode and the audit log ----------

function modTools() {
  return !!state.roster?.features?.includes("mod-tools");
}

function meUser() {
  return state.roster?.users.find((u) => u.session_id === state.roster.me);
}

/** When someone's timeout ends, if they're timed out right now. */
function timedOutUntil(u) {
  return u?.timed_out_until && u.timed_out_until > Date.now() ? u.timed_out_until : null;
}

var TIMEOUTS = [["60 seconds", 1], ["5 minutes", 5], ["10 minutes", 10], ["1 hour", 60], ["1 day", 1440], ["1 week", 10080]];

function timeoutItems(u) {
  if (!modTools()) return [];
  if (timedOutUntil(u)) return [{ label: `Remove timeout`, icon: "clock", action: () => call("timeout_member", { sessionId: u.session_id, minutes: 0 }) }];
  return [{ label: `Timeout ${u.name}`, icon: "clock", danger: true, action: async () => {
    const ok = await confirmDialog({
      title: `Timeout ${u.name}`,
      text: `${u.name} can't write, react or talk until it ends. You can lift it early from their menu.`,
      ok: "Timeout",
      choice: { label: "How long", options: TIMEOUTS.map(([label, minutes]) => [String(minutes), label]), value: "10" },
    });
    if (ok) call("timeout_member", { sessionId: u.session_id, minutes: Number(confirmDialog.choice) });
  } }];
}

/** What the message box says: where you write, slowmode, or your timeout. */
function composerHint(view) {
  const until = timedOutUntil(meUser());
  if (until) return "You're timed out until " + clock(until);
  const where = isVoiceChannel(view) || channel(view)?.parent != null ? "Message " + channelName(view) : "Message #" + channelName(view);
  const slow = channel(view)?.slowmode;
  return slow && !can("moderate") ? where + " · slowmode " + slowText(slow) : where;
}

function slowText(seconds) {
  return seconds >= 3600 ? seconds / 3600 + " h" : seconds >= 60 ? seconds / 60 + " min" : seconds + " s";
}

var lastSentAt = new Map();
function noteSent(view) {
  lastSentAt.set(view, Date.now());
}
/** Seconds left before slowmode lets you write here again. */
function slowmodeWait(view) {
  const slow = channel(view)?.slowmode;
  if (!slow || can("moderate")) return 0;
  return Math.max(0, Math.ceil((lastSentAt.get(view) ?? 0) / 1000 + slow - Date.now() / 1000));
}

var AUDIT_WORDS = {
  kick: "kicked", nickname: "changed the nickname of", ban: "banned", unban: "unbanned", timeout: "timed out", untimeout: "lifted the timeout for",
  role: "changed the role of", transfer: "gave the server to", create_channel: "created the channel", update_channel: "edited the channel",
  delete_channel: "deleted the channel", delete_message: "deleted a message by", server_mute: "server-muted", server_unmute: "unmuted",
  server_deafen: "server-deafened", server_undeafen: "undeafened", voice_disconnect: "disconnected", voice_move: "moved",
};

listen("audit-log", (e) => {
  const entries = e.payload ?? [];
  $("audit-list").replaceChildren(
    ...(entries.length
      ? entries.map((a) => {
          const li = el("li", "audit-row");
          const what = el("span", "audit-what");
          what.append(el("strong", "", a.actor), " " + (AUDIT_WORDS[a.action] ?? a.action) + " ", el("strong", "", a.target ?? ""));
          if (a.detail) what.append(el("span", "audit-detail", " · " + a.detail));
          li.append(what, el("span", "audit-when", dayLabel(a.at) + " " + clock(a.at)));
          return li;
        })
      : [el("li", "admin-empty", "Nothing has happened yet.")]),
  );
});

// A timeout ending lets you write again without anyone doing anything.
setInterval(() => {
  const me = meUser();
  if (me?.timed_out_until && !timedOutUntil(me) && $("chat-input").disabled) renderChannelView();
}, 5000);

// ---------- roles ----------
//
// A server's own roles: a colour for names, a heading of their own in the member list, and
// what they may do (nothing extra, moderate, or run the server). Private channels show
// only to the roles picked (and admins).

function rolesOn() {
  return !!state.roster?.features?.includes("roles");
}

/** The colour of someone's highest role that has one. */
function roleColor(u) {
  if (!u?.roles?.length) return null;
  const c = (state.roster.roles ?? []).find((r) => r.color && u.roles.includes(r.id))?.color ?? null;
  return c && isLightTheme() ? "color-mix(in srgb, " + c + " 62%, #000)" : c;
}

function isLightTheme() {
  return getComputedStyle(document.documentElement).colorScheme === "light";
}
function roleColorByKey(key) {
  return roleColor(state.roster?.users.find((u) => keyOf(u) === key));
}

/**
 * Someone's name style, as kept with their profile: "#rrggbb", "#rrggbb #rrggbb" (a fade
 * between two colours) and/or "f:<font>" (one of NAME_FONTS). Older apps read just the colour.
 */
var NAME_FONTS = {
  rounded: ["Rounded", '"Nunito"'],
  hand: ["Handwritten", '"Caveat"'],
  graffiti: ["Graffiti", '"Sedgwick Ave Display"'],
  block: ["Block", '"Bungee"'],
  pixel: ["Pixel", '"Pixelify Sans"'],
  serif: ["Serif", '"Playfair Display"'],
  mono: ["Mono", '"JetBrains Mono"'],
};
function parseNameStyle(raw) {
  const out = { c1: null, c2: null, font: null };
  for (const t of String(raw ?? "").split(" ")) {
    if (/^#[0-9a-f]{6}$/i.test(t)) {
      if (!out.c1) out.c1 = t;
      else out.c2 ??= t;
    } else if (t.startsWith("f:") && NAME_FONTS[t.slice(2)]) out.font = t.slice(2);
  }
  return out;
}
function joinNameStyle(s) {
  return [s.c1, s.c1 && s.c2, s.font && "f:" + s.font].filter(Boolean).join(" ") || null;
}
/** The style someone picked for their own name (theirs to choose in their profile), if any. */
function rawNameStyle(key) {
  if (!key) return null;
  if (key === state.account?.publicKey || key === state.me?.key) return state.me?.name_color ?? null;
  const friend = state.friends?.get(key);
  if (friend) return friend.state === "blocked" ? null : friend.name_color ?? null;
  return profiles.get(key)?.name_color ?? null;
}
/**
 * Writes a name the way its owner styled it: their font, and their colour or fade.
 * `where`: "server" (a role colour there comes first), "personal" (friends, DMs: no server's
 * roles), "tile" (on a picture or video: just the font, the colour stays what reads there).
 * `fallback` false: no made-up colour when they picked none.
 */
function styleName(node, key, name, fallback = true, where = "server") {
  const s = parseNameStyle(rawNameStyle(key));
  const role = where === "server" ? roleColorByKey(key) : null;
  if (where === "tile") {
    node.style.fontFamily = s.font ? NAME_FONTS[s.font][1] + ", Inter, sans-serif" : "";
    if (s.font) node.dataset.nameFont = s.font;
    else delete node.dataset.nameFont;
    return node;
  }
  node.style.color = role ?? (s.c1 ? readableColor(s.c1) : fallback ? "hsl(" + hue(name) + " var(--name-s) var(--name-l))" : "");
  node.style.fontFamily = s.font ? NAME_FONTS[s.font][1] + ", Inter, sans-serif" : "";
  if (s.font) node.dataset.nameFont = s.font;
  else delete node.dataset.nameFont;
  const fade = !role && s.c1 && s.c2;
  node.classList.toggle("name-fade", !!fade);
  node.style.backgroundImage = fade ? "linear-gradient(90deg, " + readableColor(s.c1) + ", " + readableColor(s.c2) + ")" : "";
  return node;
}

/** Any colour, made to read on the theme: never too dark on dark, never too pale on light. */
function readableColor(hex) {
  const [h, sat, l] = hexToHsl(hex);
  const light = isLightTheme();
  const lightness = light ? Math.min(l, 40) : Math.max(l, 64);
  return "hsl(" + h.toFixed(0) + " " + Math.min(sat, 90).toFixed(0) + "% " + lightness.toFixed(0) + "%)";
}


/** "Roles" in someone's menu, for admins: tick to give, untick to take. */
function roleItems(u) {
  // Admin-level roles are the owner's to give: others don't see them here.
  const roles = (state.roster?.roles ?? []).filter((r) => r.level !== "admin" || can("own"));
  if (!rolesOn() || !can("manage") || !roles.length || !keyOf(u)) return [];
  return [{
    label: "Roles",
    submenu: roles.map((r) => ({
      label: r.name,
      check: !!u.roles?.includes(r.id),
      action: (on) => call("assign_role", { publicKey: keyOf(u), role: r.id, on }),
    })),
  }];
}

var ROLE_COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#46a758", "#12a594", "#0090ff", "#6e56cf", "#d6409f", "#8d8d86", null];
var editingRole = null;
var roleColorPick = null;

function renderRolesTab() {
  const roles = state.roster?.roles ?? [];
  $("roles-empty").hidden = roles.length > 0;
  $("roles-layout").hidden = roles.length === 0;
  $("role-list").replaceChildren(...(roles.length ? roles.map((r, i) => {
    const li = el("li", "role-row" + (editingRole === r.id ? " active" : ""));
    const dot = el("i", "role-dot");
    dot.style.background = r.color ?? "var(--faint)";
    const count = state.roster.users.filter((u) => u.roles?.includes(r.id)).length;
    li.append(dot, el("span", "role-row-name ellipsis", r.name), el("span", "role-row-count", count ? String(count) : ""));
    const move = (d) => {
      const order = roles.map((x) => x.id);
      const j = i + d;
      if (j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]];
      call("reorder_roles", { order });
    };
    const up = el("button", "role-move");
    up.type = "button";
    up.setAttribute("aria-label", "Higher");
    up.append(icon("chevron"));
    up.addEventListener("click", (e) => {
      e.stopPropagation();
      move(-1);
    });
    const down = el("button", "role-move down");
    down.type = "button";
    down.setAttribute("aria-label", "Lower");
    down.append(icon("chevron"));
    down.addEventListener("click", (e) => {
      e.stopPropagation();
      move(1);
    });
    li.append(up, down);
    li.addEventListener("click", () => openRole(r));
    return li;
  }) : [el("li", "admin-empty", "No roles yet.")]));
  const current = roles.find((r) => r.id === editingRole);
  if (current) openRole(current, true);
  else $("role-editor").hidden = true;
}

function openRole(r, keepEdits) {
  editingRole = r.id;
  document.querySelectorAll(".role-row").forEach((n, i) => n.classList.toggle("active", state.roster.roles[i]?.id === r.id));
  $("role-editor").hidden = false;
  if (keepEdits && document.activeElement?.closest?.("#role-editor")) return;
  $("role-name").value = r.name;
  $("role-hoist").checked = r.hoist;
  $("role-mentionable").checked = !!r.mentionable;
  $("role-level").value = r.level ?? "";
  // Admin-level roles are the owner's to give.
  $("role-level").querySelector('option[value="admin"]').disabled = !can("own");
  roleColorPick = r.color;
  renderRoleColors();
}

function renderRoleColors() {
  $("role-colors").replaceChildren(...ROLE_COLORS.map((c) => {
    const b = el("button", "role-swatch" + (c === roleColorPick ? " active" : "") + (c ? "" : " none"));
    b.type = "button";
    b.setAttribute("aria-label", c ?? "No colour");
    if (c) b.style.background = c;
    b.addEventListener("click", () => {
      roleColorPick = c;
      renderRoleColors();
    });
    return b;
  }));
}

$("role-new").addEventListener("click", () => call("create_role", { name: "new role", color: null, hoist: false, level: null }));
$("role-editor").addEventListener("submit", (e) => {
  e.preventDefault();
  if (editingRole === null) return;
  call("update_role", { id: editingRole, name: $("role-name").value.trim() || "role", color: roleColorPick, hoist: $("role-hoist").checked, level: $("role-level").value || null, mentionable: $("role-mentionable").checked });
});
$("role-delete").addEventListener("click", async () => {
  const r = state.roster.roles.find((x) => x.id === editingRole);
  if (!r) return;
  const ok = await confirmDialog({ title: "Delete " + r.name, text: "Everyone with this role loses it. Private channels only it could see stay for admins.", ok: "Delete role" });
  if (!ok) return;
  editingRole = null;
  call("delete_role", { id: r.id });
});
$("channel-edit-private-on").addEventListener("change", (e) => ($("channel-edit-private-roles").hidden = !e.target.checked));

// ---------- the channel settings window ----------

function showChannelTab(tab) {
  document.querySelectorAll("[data-ctab]").forEach((t) => t.classList.toggle("active", t.dataset.ctab === tab));
  document.querySelectorAll("[data-cpanel]").forEach((p) => (p.hidden = p.dataset.cpanel !== tab));
}
document.querySelectorAll("[data-ctab]").forEach((t) => t.addEventListener("click", () => showChannelTab(t.dataset.ctab)));
$("channel-delete").addEventListener("click", () => {
  const ch = editingChannel;
  if (!ch) return;
  $("channel-edit-dialog").close();
  deleteChannel(ch);
});
$("role-new-empty").addEventListener("click", () => call("create_role", { name: "new role", color: null, hoist: false, level: null }));

// ---------- @everyone, @here and role mentions ----------
//
// Moderators may ping everyone who can see a channel (@everyone), everyone who's here right
// now (@here) and any role; others only roles that allow it. The server turns the rest into
// plain words, so they look like text and ping nobody. Per server, people can turn @everyone
// and @here off for themselves.

var CROWD_WORD = /(?<![\p{L}\p{N}_@])@(everyone|here)(?![\p{L}\p{N}_])/u;

function pingsOn() {
  return !!state.roster?.features?.includes("pings");
}

function roleById(id) {
  return state.roster?.roles?.find((r) => r.id === id);
}

function crowdQuiet(address) {
  return !!address && !!prefs.notify.quiet?.[address];
}

function setCrowdQuiet(s, on) {
  prefs.notify.quiet = { ...prefs.notify.quiet };
  if (on) prefs.notify.quiet[s.address] = true;
  else delete prefs.notify.quiet[s.address];
  saveNotify();
}

/** @everyone, @here and roles you may mention, for the picker. */
function crowdCandidates(q) {
  if (!pingsOn()) return [];
  const out = [];
  const mod = can("moderate");
  if (mod) {
    for (const [name, sub] of [["everyone", "Everyone who can see this channel"], ["here", "Everyone online right now"]]) {
      if (name.startsWith(q)) out.push({ key: name, name, crowd: true, username: sub });
    }
  }
  for (const r of state.roster?.roles ?? []) {
    if ((mod || r.mentionable) && r.name.toLowerCase().includes(q)) out.push({ key: "&" + r.id, name: r.name, role: r, username: "Role" });
  }
  return out;
}

/** A role mention in a message: in the role's colour, lit when it's one of yours. */
function roleMentionNode(id) {
  const r = roleById(id);
  const mine = (meUser()?.roles ?? []).includes(id);
  const node = el("span", "mention role-mention" + (mine ? " mine" : ""), "@" + (r?.name ?? "deleted-role"));
  if (r?.color) node.style.setProperty("--role", r.color);
  return node;
}

// Making an invite from the Invites page: it opens over settings, and the list follows when it's closed.
$("invites-create").addEventListener("click", () => {
  openInvite();
  $("invite-dialog").addEventListener("close", () => { if ($("server-settings").open) call("get_server_settings"); }, { once: true });
});

// About me: a line or two that friends and people in your servers see on your card.
$("bio-edit").addEventListener("click", async () => {
  const text = await askText({ title: "About me", label: "About me", value: state.me?.bio ?? "", hint: "Up to 190 characters. Friends and people in your servers see it on your card." });
  if (text === null || text === undefined) return;
  accountSend({ type: "set_profile", bio: text.trim() }).catch((err) => toast(friendlyError(err), true));
});

// ---------- servers kept connected ----------
//
// Like Discord, Hopp stays connected to your servers while you look at another one, so
// switching is instant: no logging in again, just the server's channels sent once more. A
// server waiting in the background still marks channels unread and pings you.

var warmStarted = false;

/** A moment after login, connects to your other servers in the background, one at a time. */
function warmServersSoon() {
  if (warmStarted) return;
  warmStarted = true;
  setTimeout(async () => {
    const wanted = (s) => state.account && !s.invite && s.id !== state.activeId && s.id !== state.connectingId;
    // A LAN server that is off can take long to give up: those go on their own, so Hopp
    // Cloud servers (one at a time) never wait for them.
    for (const s of prefs.servers.filter((x) => !isCloud(x))) if (wanted(s)) invoke("warm", { address: endpoint(s) }).catch(() => {});
    for (const s of prefs.servers.filter(isCloud)) {
      if (wanted(s)) await invoke("warm", { address: endpoint(s) }).catch(() => {});
    }
  }, 2500);
}

listen("background-chat", (e) => {
  const { address, message: m, channel_name, voice, roles, pings } = e.payload;
  const server = prefs.servers.find((s) => endpoint(s) === address);
  if (!server || voice || server.id === state.activeId) return;
  const me = state.account?.publicKey;
  const mention =
    m.text.includes("<@" + me + ">") ||
    m.reply?.author_key === me ||
    [...m.text.matchAll(/<@&(\d+)>/g)].some(([, id]) => (roles ?? []).includes(Number(id))) ||
    (!!pings && CROWD_WORD.test(m.text) && !crowdQuiet(server.address));
  const k = readKey(server.address, m.channel);
  const cur = state.reads.get(k) ?? { server: server.address, channel: m.channel, read_id: 0, last_id: 0, mentions: 0 };
  state.reads.set(k, cur);
  if (m.id <= cur.last_id) return;
  cur.last_id = m.id;
  if (m.author_key === me) {
    cur.read_id = m.id;
    cur.mentions = 0;
  } else {
    if (mention && m.id > cur.read_id) cur.mentions += 1;
    notifyMention({ server: server.address, channel: m.channel, author_key: m.author_key, author_name: m.sender_name, channel_name: channel_name ?? "", text: previewText(m.text), mention });
  }
  renderUnread();
});

// A video call: the call starts, and your camera turns on as soon as it is connected.
$("dm-video-btn").addEventListener("click", async () => {
  const peer = state.openDm;
  if (!peer) return;
  await (isGroup(peer) ? startGroupCall(peer) : startCall(peer));
  const started = Date.now();
  const wait = setInterval(() => {
    if (!state.call || Date.now() - started > 90_000) return clearInterval(wait);
    if (state.call.engineReady) {
      clearInterval(wait);
      startCamera();
    }
  }, 300);
});

// The member list over the chat (narrow windows) closes when you click elsewhere.
document.addEventListener("mousedown", (e) => {
  const view = document.querySelector(".channel-view.members-over");
  if (!view || e.target.closest(".members, #members-toggle, .popover, .menu")) return;
  view.classList.remove("members-over");
});

// Roles (or who has them) changed: names in the chat take their new colour at once. Only
// the rows whose look changed are rebuilt.
var lastRoleLook = "";
function roleLookChanged() {
  const look = JSON.stringify([state.roster?.roles ?? [], (state.roster?.users ?? []).map((u) => [u.public_key, u.roles ?? [], u.role ?? null, u.name])]);
  if (look === lastRoleLook) return;
  lastRoleLook = look;
  if (online() && state.view !== null && renderedChannel === state.view) renderMessages(true);
}

// A list waiting for the server's answer never says "Loading…" forever: an older server, or a
// lost answer, gets a plain message instead.
setInterval(() => {
  for (const n of document.querySelectorAll(".admin-empty, .pins-empty")) {
    if (n.textContent !== "Loading…") continue;
    const since = Number(n.dataset.since || 0);
    if (!since) n.dataset.since = String(Date.now());
    else if (Date.now() - since > 8000) n.textContent = "Couldn't load this. Close it and try again.";
  }
}, 1000);

// ---------- where friends are in voice ----------

/** A friend's voice channel, when it's in a server you're in too (otherwise just "in voice"). */
function friendVoice(f) {
  if (!f?.voice || f.status === "offline") return null;
  const i = f.voice.lastIndexOf("#");
  const address = f.voice.slice(0, i);
  const channel = Number(f.voice.slice(i + 1));
  const server = prefs.servers.find((x) => x.address === address);
  if (!server) return { server: null, channel };
  // The channel's name, when we know that server's channels (the one you're in).
  const channelName = activeServer()?.id === server.id ? state.roster?.channels.find((c) => c.id === channel)?.name ?? null : null;
  return { server, channel, channelName };
}

/** "In Lobby · The Crew", "In voice · The Crew" or just "In voice". */
function whereText(f) {
  const w = friendVoice(f);
  if (!w?.server) return f.activity;
  return (w.channelName ? "In " + w.channelName : "In voice") + " · " + w.server.label;
}

/** Joins a friend in their voice channel: into their server, then the channel. */
async function joinFriendVoice(where) {
  if (activeServer()?.id !== where.server.id || state.atHome) {
    const ok = await connectTo(where.server);
    if (!ok) return;
  }
  if (!voiceChannels().some((c) => c.id === where.channel)) return toast("That voice channel isn't there anymore.", true);
  openTextChannel(where.channel);
  joinVoice(where.channel);
}

/** A picture blurred into a tiny one (kept per picture), for soft backgrounds that cost nothing to draw. */
var blurCache = new Map();
function blurredArt(src) {
  if (blurCache.has(src)) return blurCache.get(src);
  const done = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = 24;
      c.height = 24;
      const g = c.getContext("2d");
      g.filter = "blur(2px) saturate(1.2)";
      g.drawImage(img, -4, -4, 32, 32);
      resolve(c.toDataURL("image/png"));
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
  blurCache.set(src, done);
  return done;
}

// The window behind the page takes the app's colour, so growing the window never shows black
// before the page catches up.
var windowColor = "";
function syncWindowColor() {
  const probe = document.createElement("span");
  probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--app-solid").trim() || "#333338";
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  const m = color.match(/[\d.]+/g);
  if (!m) return;
  const [r, g, b] = (color.startsWith("color(") ? m.slice(0, 3).map((v) => v * 255) : m.slice(0, 3).map(Number)).map((v) => Math.round(v));
  const hex = "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
  if (hex === windowColor) return;
  windowColor = hex;
  invoke("window_color", { rgb: hex }).catch(() => {});
}
syncWindowColor();

// ---------- Hopp's own sounds ----------
//
// Made right here, no files: soft mallet and glass tones (a few partials each, gently
// decaying), small pitch glides for the "hop", a quiet room around them and a soft top end.
// "Classic" keeps the old plain beeps.

prefs.soundStyle = load("soundStyle", "hopp");

var hoppBus = null;
function hoppOut() {
  if (hoppBus?.ctx === soundCtx) return hoppBus.input;
  const ctx = soundCtx;
  const input = ctx.createGain();
  // A soft top end, and nothing ever clips.
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = 5200;
  tone.Q.value = 0.4;
  const limit = ctx.createDynamicsCompressor();
  limit.threshold.value = -14;
  limit.ratio.value = 6;
  // A small room: two short echoes, darker each time.
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  wet.gain.value = 0.16;
  const d1 = ctx.createDelay(1);
  d1.delayTime.value = 0.071;
  const d2 = ctx.createDelay(1);
  d2.delayTime.value = 0.113;
  const fb = ctx.createGain();
  fb.gain.value = 0.32;
  const damp = ctx.createBiquadFilter();
  damp.type = "lowpass";
  damp.frequency.value = 2400;
  input.connect(tone);
  tone.connect(dry).connect(limit);
  tone.connect(d1);
  tone.connect(d2);
  d1.connect(damp);
  d2.connect(damp);
  damp.connect(fb).connect(d1);
  damp.connect(wet).connect(limit);
  limit.connect(ctx.destination);
  hoppBus = { ctx, input };
  return input;
}

/** One soft voice. kind: "mallet" (marimba-like), "glass" (bell-like), "bubble" (a pitch glide). */
function hoppVoice(kind, freq, at, { dur = 0.35, gain = 1, glide = null } = {}) {
  const ctx = soundCtx;
  const out = hoppOut();
  const t = ctx.currentTime + 0.02 + at;
  const partials = kind === "mallet" ? [[1, 1, 1], [4, 0.22, 0.25], [9.8, 0.05, 0.12]]
    : kind === "glass" ? [[1, 1, 1], [2.76, 0.32, 0.55], [5.4, 0.1, 0.3]]
    : [[1, 1, 1], [2, 0.12, 0.6]];
  for (const [ratio, level, life] of partials) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq * ratio, t);
    if (glide) osc.frequency.exponentialRampToValueAtTime(glide * ratio, t + Math.min(dur * 0.55, 0.12));
    const peak = 0.22 * gain * level;
    const end = t + dur * life;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(peak, t + (kind === "bubble" ? 0.012 : 0.004));
    env.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(env).connect(out);
    osc.start(t);
    osc.stop(end + 0.05);
  }
}

// Notes, for reading the sounds below.
var N = { G4: 392, A4: 440, B4: 493.9, C5: 523.3, D5: 587.3, E5: 659.3, F5: 698.5, G5: 784, A5: 880, B5: 987.8, C6: 1046.5, D6: 1174.7, E6: 1318.5, G6: 1568 };

var HOPP_SOUNDS = {
  // Your microphone: a small drop off, a small lift on.
  mute: (v) => hoppVoice("bubble", N.A5, 0, { dur: 0.13, gain: 1.3 * v, glide: N.D5 }),
  unmute: (v) => hoppVoice("bubble", N.D5, 0, { dur: 0.13, gain: 1.3 * v, glide: N.A5 }),
  // Your ears: two soft mallet notes, down and up.
  deafen: (v) => { hoppVoice("mallet", N.E5, 0, { dur: 0.3, gain: 0.8 * v }); hoppVoice("mallet", N.A4, 0.09, { dur: 0.4, gain: 0.8 * v }); },
  undeafen: (v) => { hoppVoice("mallet", N.A4, 0, { dur: 0.3, gain: 0.8 * v }); hoppVoice("mallet", N.E5, 0.09, { dur: 0.4, gain: 0.8 * v }); },
  // Joining voice: the "hop" — up, and landing on a chord.
  join: (v) => { hoppVoice("bubble", N.C5, 0, { dur: 0.16, gain: 0.7 * v, glide: N.G5 }); hoppVoice("mallet", N.E5, 0.1, { dur: 0.45, gain: 0.7 * v }); hoppVoice("mallet", N.G5, 0.1, { dur: 0.5, gain: 0.55 * v }); hoppVoice("glass", N.C6, 0.16, { dur: 0.6, gain: 0.3 * v }); },
  leave: (v) => { hoppVoice("mallet", N.G5, 0, { dur: 0.3, gain: 0.6 * v }); hoppVoice("bubble", N.E5, 0.08, { dur: 0.2, gain: 0.6 * v, glide: N.A4 }); },
  // Others: quieter, two glass notes.
  user_join: (v) => { hoppVoice("glass", N.G5, 0, { dur: 0.4, gain: 0.65 * v }); hoppVoice("glass", N.D6, 0.08, { dur: 0.5, gain: 0.6 * v }); },
  user_leave: (v) => { hoppVoice("glass", N.D6, 0, { dur: 0.35, gain: 0.6 * v }); hoppVoice("glass", N.G5, 0.08, { dur: 0.45, gain: 0.55 * v }); },
  // A message: a light, short "pling".
  message: (v) => { hoppVoice("glass", N.E6, 0, { dur: 0.35, gain: 0.8 * v }); hoppVoice("glass", N.B5, 0.06, { dur: 0.5, gain: 0.6 * v }); },
  // Someone calling you: a friendly little tune (repeats while it rings).
  ring: (v) => { [[N.C5, 0], [N.E5, 0.13], [N.G5, 0.26], [N.E5, 0.39], [N.G5, 0.6], [N.C6, 0.73]].forEach(([f, at]) => hoppVoice("mallet", f, at, { dur: 0.5, gain: 0.75 * v })); },
  // You calling: a calm, low "waiting" tone.
  ringback: (v) => { hoppVoice("mallet", N.G4, 0, { dur: 0.6, gain: 0.7 * v }); hoppVoice("mallet", N.B4, 0, { dur: 0.6, gain: 0.45 * v }); hoppVoice("mallet", N.G4, 0.32, { dur: 0.7, gain: 0.6 * v }); },
  // Lost the connection: down, muffled.
  disconnect: (v) => { hoppVoice("mallet", N.E5, 0, { dur: 0.3, gain: 0.6 * v }); hoppVoice("mallet", N.B4, 0.12, { dur: 0.35, gain: 0.6 * v }); hoppVoice("bubble", N.G4, 0.24, { dur: 0.25, gain: 0.5 * v, glide: 196 }); },
  // Push to talk: tiny ticks.
  ptt_on: (v) => hoppVoice("bubble", N.G5, 0, { dur: 0.05, gain: 0.7 * v, glide: N.C6 }),
  ptt_off: (v) => hoppVoice("bubble", N.C6, 0, { dur: 0.05, gain: 0.65 * v, glide: N.G5 }),
  // Talking while muted: two soft low knocks.
  muted: (v) => { hoppVoice("mallet", N.D5, 0, { dur: 0.18, gain: 0.6 * v }); hoppVoice("mallet", N.D5, 0.15, { dur: 0.18, gain: 0.6 * v }); },
};

function playHoppSound(name, volume) {
  HOPP_SOUNDS[name](Math.max(0, Math.min(1, volume)) * 1.6);
}

// The style, chosen in Notifications.
document.querySelectorAll("[data-sound-style]").forEach((b) => {
  b.classList.toggle("active", b.dataset.soundStyle === prefs.soundStyle);
  b.addEventListener("click", () => {
    prefs.soundStyle = b.dataset.soundStyle;
    save("soundStyle", prefs.soundStyle);
    document.querySelectorAll("[data-sound-style]").forEach((x) => x.classList.toggle("active", x === b));
    playSound("join", "You picked a sound style");
  });
});

// ---------- streamer mode ----------
//
// For streaming or sharing your screen: what others shouldn't see is blurred (anything marked
// data-private: invite links, your username), notifications don't show what was
// written, and the recovery phrase can't be shown. Turned on by hand, or by itself while you
// share your screen (and off again after, unless you turned it on yourself).

var streamer = { manual: load("streamerMode", "0") === "1", auto: false, on: false };
prefs.streamerAuto = load("streamerAuto", "1") === "1";

function applyStreamer() {
  streamer.on = streamer.manual || streamer.auto;
  document.documentElement.classList.toggle("streamer", streamer.on);
  $("streamer-pill").hidden = !streamer.on;
  $("streamer-mode").checked = streamer.on;
  $("streamer-auto").checked = prefs.streamerAuto;
}

/** Sharing your screen (in voice or a call) turns it on by itself, when that's wanted. */
function syncStreamerAuto() {
  const sharing = !!(typeof media !== "undefined" && media.out?.screen) || !!(typeof screenShare !== "undefined" && screenShare.stream);
  const auto = prefs.streamerAuto && sharing;
  if (auto === streamer.auto) return;
  streamer.auto = auto;
  applyStreamer();
}

$("streamer-mode").addEventListener("change", (e) => {
  streamer.manual = e.target.checked;
  // Turned off by hand while sharing: it stays off until the next share.
  if (!e.target.checked) streamer.auto = false;
  save("streamerMode", streamer.manual ? "1" : "0");
  applyStreamer();
});
$("streamer-auto").addEventListener("change", (e) => {
  prefs.streamerAuto = e.target.checked;
  save("streamerAuto", prefs.streamerAuto ? "1" : "0");
  syncStreamerAuto();
});
$("streamer-pill").addEventListener("click", () => {
  streamer.manual = false;
  streamer.auto = false;
  save("streamerMode", "0");
  applyStreamer();
});
applyStreamer();

// ---------- custom status ----------
//
// An emoji and a few words under your name ("🎮 Playing Valorant"), until a time you pick.
// It lives in your profile, so friends and people in your servers see it.

/** A status, unless it has run out. */
function liveStatus(s) {
  return s && (s.text || s.emoji) && (s.until == null || s.until > Date.now()) ? s : null;
}

/** Someone's custom status: friends from your account, others from their profile. */
function customStatusOf(key) {
  if (!key) return null;
  if (key === state.account?.publicKey) return liveStatus(state.me?.custom_status);
  const f = state.friends?.get(key);
  if (f && f.state === "friend" && f.custom_status !== undefined) {
    try {
      return liveStatus(typeof f.custom_status === "string" ? JSON.parse(f.custom_status) : f.custom_status);
    } catch {
      return null;
    }
  }
  return liveStatus(profiles.get(key)?.custom_status);
}

function statusLine(s) {
  const live = liveStatus(s);
  return live ? [live.emoji, live.text].filter(Boolean).join(" ") : null;
}

function statusParts(s) {
  const out = [];
  if (s.emoji) out.push(emojiText(s.emoji, "status-emoji-mark"));
  if (s.text) out.push(el("span", "ellipsis", s.text));
  return out;
}

var statusEmoji = null;
function openStatusDialog() {
  closePopovers();
  const s = liveStatus(state.me?.custom_status);
  statusEmoji = s?.emoji ?? null;
  $("status-emoji").replaceChildren(emojiNode(statusEmoji ?? "🙂"));
  $("status-emoji").classList.toggle("empty", !statusEmoji);
  $("status-text").value = s?.text ?? "";
  $("status-until").value = s ? (s.until == null ? "" : "60") : "240";
  openModal($("status-dialog"));
  $("status-text").focus();
}

async function setCustomStatus(status) {
  try {
    await accountSend({ type: "set_profile", custom_status: status });
  } catch (err) {
    toast(friendlyError(err), true);
  }
}

$("status-emoji").addEventListener("click", (e) =>
  openEmojiPicker(
    e.currentTarget,
    (emoji) => {
      statusEmoji = emoji;
      $("status-emoji").replaceChildren(emojiNode(emoji));
      $("status-emoji").classList.remove("empty");
    },
    null,
    { plain: true },
  ),
);
$("status-clear-text").addEventListener("click", () => {
  $("status-text").value = "";
  statusEmoji = null;
  $("status-emoji").replaceChildren(emojiNode("🙂"));
  $("status-emoji").classList.add("empty");
  $("status-text").focus();
});
$("status-form").addEventListener("submit", (e) => {
  const text = $("status-text").value.trim();
  if (!text && !statusEmoji) {
    setCustomStatus(null);
    return;
  }
  const v = $("status-until").value;
  let until = null;
  if (v === "today") {
    const end = new Date();
    end.setHours(23, 59, 59, 0);
    until = end.getTime();
  } else if (v) until = Date.now() + Number(v) * 60_000;
  e.preventDefault();
  $("status-dialog").close();
  setCustomStatus({ text, emoji: statusEmoji, until });
});
// A status running out disappears without anyone doing anything.
setInterval(() => {
  const mine = state.me?.custom_status;
  if (mine && mine.until != null && mine.until <= Date.now() && !mine.gone) {
    mine.gone = true;
    renderUserPanel();
  }
}, 30_000);

// ---------- nicknames ----------
//
// A name of your own in a server (and moderators can change people's). The server sends it
// as the person's name; messages show the name someone has here now.

function nicknamesOn() {
  return !!state.roster?.features?.includes("nicknames");
}

/** Someone's name in this server right now, when they're here. */
function nameHere(key) {
  if (!key || !online()) return null;
  return state.roster.users.find((u) => keyOf(u) === key)?.name ?? null;
}

/** Their own name, when the one shown here is a nickname. */
function accountNameOf(u) {
  const key = keyOf(u);
  const own = key === state.account?.publicKey ? state.account?.name : state.friends?.get(key)?.display_name ?? profiles.get(key)?.display_name;
  return own && own !== u.name ? own : null;
}

async function changeNickname(u) {
  if (!u) return;
  const self = u.session_id === state.roster?.me;
  const own = self ? state.account?.name : accountNameOf(u) ?? u.name;
  const value = await askText({
    title: self ? "Your nickname here" : "Nickname for " + u.name,
    label: "Nickname",
    value: u.name === own ? "" : u.name,
    hint: (self ? "Only in " : "Only in ") + (activeServer()?.label ?? "this server") + ". Leave it empty to use " + (self ? "your own name" : "their own name") + " (" + own + ").",
  });
  if (value === null || value === undefined) return;
  try {
    await invoke("set_nickname", { publicKey: keyOf(u), nick: value.trim() || null });
  } catch (err) {
    toast(friendlyError(err), true);
  }
}

// ---------- profile banner ----------
//
// The top of your profile card: one of a few colours, or a picture of your own.

var BANNER_COLORS = ["#5b6ee1", "#2f9e7a", "#d9534f", "#e6883a", "#c9a227", "#9b59b6", "#d6409f", "#4a4a52"];

function bannerOf(key) {
  if (!key) return null;
  if (key === state.account?.publicKey) return state.me?.banner ?? null;
  return profiles.get(key)?.banner ?? null;
}

/** Paints a banner: its picture, its colour, or (none) a soft colour from the name. */
function paintBanner(node, banner, name) {
  node.style.setProperty("--hue", hue(name ?? ""));
  for (const p of ["background", "background-image", "background-color", "--banner"]) node.style.removeProperty(p);
  if (!banner) return;
  if (banner.startsWith("#")) node.style.backgroundColor = banner;
  else {
    node.style.backgroundColor = "var(--elev)";
    node.style.backgroundImage = 'url("' + banner + '")';
    node.style.backgroundSize = "cover";
    node.style.backgroundPosition = "center";
  }
}

// ---------- your name's colour ----------
//
// Yours to pick, for your name in chat. A server's role colour comes first there; whatever
// you pick is adjusted a little so it always reads, on dark themes and light.

var NAME_COLORS = ["#8ab4f8", "#7fd6c2", "#9be28a", "#f2d16b", "#f5a36a", "#f28b9b", "#d9a4f4", "#b3b9ff"];

function renderNameColors() {
  const style = parseNameStyle(state.me?.name_color);
  const current = style.c1;
  $("name-colors").replaceChildren(...NAME_COLORS.map((c) => {
    const b = el("button", "banner-swatch" + (c === current ? " active" : ""));
    b.type = "button";
    b.style.background = c;
    b.setAttribute("aria-label", "Name colour " + c);
    b.addEventListener("click", () => setNameColor(c));
    return b;
  }));
  $("name-color-remove").hidden = !current;
  if (current) $("name-color-own").value = current;
  $("name-color-own").parentElement.classList.toggle("active", !!current && !NAME_COLORS.includes(current));
  // A fade needs a first colour to start from.
  $("name-fade-row").hidden = !current;
  $("name-fade-off").hidden = !style.c2;
  if (style.c2) $("name-color-two").value = style.c2;
  $("name-color-two").parentElement.classList.toggle("active", !!style.c2);
  const me = state.account?.name ?? "Aa";
  $("name-fonts").replaceChildren(
    ...[[null, "Default", ""], ...Object.entries(NAME_FONTS).map(([id, [label, family]]) => [id, label, family])].map(([id, label, family]) => {
      const b = el("button", "name-font" + ((style.font ?? null) === id ? " active" : ""));
      b.type = "button";
      b.setAttribute("aria-label", label);
      const sample = el("span", "name-font-sample", me);
      if (family) sample.style.fontFamily = family + ", Inter, sans-serif";
      if (id) sample.dataset.nameFont = id;
      b.append(sample, el("span", "name-font-label", label));
      b.addEventListener("click", () => setNameStyle({ font: id }));
      return b;
    }),
  );
}

/** Changes part of your name style (colour, second colour or font), keeping the rest. */
async function setNameStyle(change) {
  const next = { ...parseNameStyle(state.me?.name_color), ...change };
  if (!next.c1) next.c2 = null;
  try {
    await accountSend({ type: "set_profile", name_color: joinNameStyle(next) });
  } catch (err) {
    toast(friendlyError(err), true);
  }
}
function setNameColor(color) {
  return setNameStyle({ c1: color });
}
$("name-fade-off").addEventListener("click", () => setNameStyle({ c2: null }));
$("name-color-two").addEventListener("change", (e) => setNameStyle({ c2: e.target.value }));
$("name-color-remove").addEventListener("click", () => setNameColor(null));
// Dragging in the colour box fires all the time: only where you land is saved.
$("name-color-own").addEventListener("change", (e) => setNameColor(e.target.value));

function renderBannerColors() {
  const current = state.me?.banner ?? null;
  $("banner-colors").replaceChildren(...BANNER_COLORS.map((c) => {
    const b = el("button", "banner-swatch" + (c === current ? " active" : ""));
    b.type = "button";
    b.style.background = c;
    b.setAttribute("aria-label", "Banner colour " + c);
    b.addEventListener("click", () => setBanner(c));
    return b;
  }));
  $("banner-remove").hidden = !current;
}

async function setBanner(banner) {
  try {
    await accountSend({ type: "set_profile", banner });
  } catch (err) {
    toast(friendlyError(err), true);
  }
}

$("banner-upload").addEventListener("click", () => $("banner-file").click());
$("banner-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const banner = await adjustPicture(file, { shape: "banner", title: "Adjust your banner", sizes: [[600, 0.82], [600, 0.68], [480, 0.65], [360, 0.6]], limit: 78_000 });
    if (banner) await setBanner(banner);
  } catch (err) {
    if (err instanceof Error) toast(err.message, true);
  }
});
$("banner-remove").addEventListener("click", () => setBanner(null));

// ---------- adjusting a picture before it's used ----------
//
// Your profile picture (a circle) or banner (a wide strip): drag to move it, zoom with the
// slider or the wheel; what's inside the frame is what's saved.

function adjustPicture(file, { shape, title, sizes, limit }) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const unreadable = () => reject(new Error("That file isn't a picture Hopp can read. Use PNG, JPEG or WebP."));
    reader.onerror = unreadable;
    reader.onload = () => {
      const img = new Image();
      img.onerror = unreadable;
      img.onload = () => openCrop(img, shape, title, sizes, limit, resolve, reject);
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function openCrop(img, shape, title, sizes, limit, resolve, reject) {
  const dialog = $("crop-dialog");
  const canvas = $("crop-canvas");
  const stageW = 420;
  const stageH = shape === "banner" ? 220 : 320;
  // The frame: what will be kept.
  const frameW = shape === "banner" ? 400 : 240;
  const frameH = shape === "banner" ? Math.round(400 * 0.35) : 240;
  canvas.width = stageW;
  canvas.height = stageH;
  $("crop-stage").style.height = stageH + "px";
  const frame = $("crop-frame");
  frame.className = "crop-frame " + (shape === "banner" ? "strip" : "circle");
  frame.style.width = frameW + "px";
  frame.style.height = frameH + "px";
  $("crop-title").textContent = title;
  // At zoom 1 the picture just covers the frame.
  const base = Math.max(frameW / img.naturalWidth, frameH / img.naturalHeight);
  let zoom = 1;
  let x = 0; // the picture's centre, relative to the frame's centre (in stage pixels)
  let y = 0;
  const g = canvas.getContext("2d");
  const clamp = () => {
    const w = img.naturalWidth * base * zoom;
    const h = img.naturalHeight * base * zoom;
    const mx = Math.max(0, (w - frameW) / 2);
    const my = Math.max(0, (h - frameH) / 2);
    x = Math.max(-mx, Math.min(mx, x));
    y = Math.max(-my, Math.min(my, y));
  };
  const draw = () => {
    clamp();
    const w = img.naturalWidth * base * zoom;
    const h = img.naturalHeight * base * zoom;
    g.clearRect(0, 0, stageW, stageH);
    g.drawImage(img, stageW / 2 + x - w / 2, stageH / 2 + y - h / 2, w, h);
  };
  $("crop-zoom").value = "1";
  $("crop-zoom").oninput = (e) => {
    zoom = Number(e.target.value);
    draw();
  };
  canvas.onwheel = (e) => {
    e.preventDefault();
    zoom = Math.max(1, Math.min(4, zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
    $("crop-zoom").value = String(zoom);
    draw();
  };
  canvas.onpointerdown = (e) => {
    canvas.setPointerCapture(e.pointerId);
    const sx = e.clientX - x;
    const sy = e.clientY - y;
    canvas.onpointermove = (ev) => {
      x = ev.clientX - sx;
      y = ev.clientY - sy;
      draw();
    };
    canvas.onpointerup = () => (canvas.onpointermove = null);
  };
  let done = false;
  const finish = (value) => {
    if (done) return;
    done = true;
    resolve(value);
  };
  $("crop-cancel").onclick = () => {
    dialog.close();
    finish(null);
  };
  dialog.onclose = () => finish(null);
  $("crop-form").onsubmit = (e) => {
    e.preventDefault();
    // The part of the picture inside the frame, in the picture's own pixels.
    const scale = base * zoom;
    const sw = frameW / scale;
    const sh = frameH / scale;
    const sx = img.naturalWidth / 2 - x / scale - sw / 2;
    const sy = img.naturalHeight / 2 - y / scale - sh / 2;
    for (const [w, q] of sizes) {
      const out = document.createElement("canvas");
      out.width = w;
      out.height = Math.round(w * (frameH / frameW));
      out.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, out.width, out.height);
      let data = out.toDataURL("image/webp", q);
      if (!data.startsWith("data:image/webp")) data = out.toDataURL("image/jpeg", q);
      if (data.length <= limit) {
        finish(data);
        dialog.close();
        return;
      }
    }
    dialog.close();
    reject(new Error("That picture is too large. Try a smaller one."));
  };
  openModal(dialog);
  draw();
}

// ---------- Discover Hopp ----------
//
// A page of its own behind the compass at the bottom of the server list, like Discord's
// Discovery: what's new in every version, guides to what Hopp can do, and about Hopp. The
// sidebar lists the sections; a dot on the compass until you've read the latest news.

var whatsNew = null;
var newsSection = "news";

async function loadWhatsNew() {
  if (whatsNew) return whatsNew;
  // The app's own copy; if that can't be read, the same file from Hopp Cloud. A miss isn't
  // remembered, so the page fills in the next time it's opened.
  for (const from of ["whats-new.json", typeof cloudHttp === "function" ? cloudHttp().replace(/\/$/, "") + "/whats-new.json" : null]) {
    if (!from) continue;
    try {
      const notes = await (await fetch(from)).json();
      // An empty list is an answer too: there's just nothing to tell yet.
      if (notes && typeof notes === "object") return (whatsNew = notes);
    } catch {
      // Try the next place.
    }
  }
  return {};
}

function versionKey(v) {
  return v.split(".").map((n) => n.padStart(5, "0")).join(".");
}

function newsVersions() {
  return Object.keys(whatsNew ?? {}).sort((a, b) => versionKey(b).localeCompare(versionKey(a)));
}

async function renderNewsDot() {
  await loadWhatsNew();
  const newest = newsVersions()[0];
  $("news-dot").hidden = !newest || load("newsSeen", "") === newest;
}

var NEWS_SECTIONS = [
  ["news", "What's new", "compass", "Everything that's new and better, version by version."],
  ["start", "Getting started", "user-plus", "Friends, servers and making Hopp yours, in a minute."],
  ["voice", "Voice, video and calls", "volume", "Talking, cameras, screens and calls with friends."],
  ["servers", "Servers and roles", "server", "Channels, roles and keeping a server friendly."],
  ["privacy", "Privacy and safety", "lock", "What stays private, and who can reach you."],
  ["keys", "Shortcuts", "keyboard", "Get around Hopp without the mouse."],
  ["about", "About Hopp", "logo", "Voice, video and chat for you and your friends."],
];

/** What each section holds: [id, title, icon, text] (versions for What's new are added live). */
var NEWS_ABOUT = [
  ["hang-out", "A place to hang out", "users", "Hopp is where you and your friends talk, play and share: servers with text and voice channels, calls, cameras and screens, and messages between friends."],
  ["free", "Free, all of it", "check", "Screen sharing in full quality, cameras, profile banners, uploads and every look. There is nothing to unlock. To keep it that way, Hopp Cloud has a few limits; they're all below."],
  ["private", "Private by design", "lock", "Messages between friends are end-to-end encrypted, your Hopp ID is a key that stays on your computer, and calls go straight between you whenever they can. No ads and no tracking."],
  ["fast", "Light and fast", "signal", "A small download that starts quickly and switches between servers at once. Updates come when you choose to install them."],
];

/** Every limit Hopp Cloud has, and why (the numbers are the cloud's own). */
var CLOUD_LIMITS = [
  ["A few hours", "Busy days", "The free plan has a daily limit for the whole of Hopp Cloud. On a very busy day it can be reached, and Hopp Cloud pauses for a few hours. Your messages and servers are safe meanwhile."],
  ["1,000", "Messages kept per channel", "Each channel keeps its newest 1,000 messages, and each conversation between friends its newest 5,000. Storage is what a free plan has least of."],
  ["40 a day", "Pictures", "Hopp makes pictures small (about 300 KB at most). You can share 40 a day in each server and 40 a day with friends, and a server keeps up to 100 MB of them. Again: storage."],
  ["10", "People in voice", "Voice and video go straight between the people talking, not through a server. That keeps calls free and private, but everyone sends to everyone, and past 10 people a home connection can't keep up. The same goes for group calls."],
  ["25", "People in a group", "Group conversations are encrypted for each person in them, so they stay small."],
  ["12 a day", "Relay sign-ins", "When two people can't reach each other directly (some networks block it), voice goes through a relay. That costs, so each person gets 12 relay sign-ins a day; one lasts all day."],
  ["1 a second", "Spam protection", "A burst of 5 messages, then one a second. 10 new servers and 30 friend requests a day per person. This keeps bots and spam out, not you."],
];

/** Guides: a few short articles each, plain and friendly. [title, icon, text] */
var NEWS_GUIDES = {
  start: [
    ["Add your friends", "user-plus", "Go Home, open Add friend and type their username. Once they accept, you can message and call them, and invite them anywhere with one click."],
    ["Make a server", "plus", "Press + in the server list and pick Create a server. It's on Hopp Cloud, free and always on. Invite people with a link, or straight from your friends list."],
    ["Join one", "link", "Got an invite link? Press + and Join a server, or just click the link in a chat."],
    ["Make it yours", "user", "Settings → Profile: your picture, a banner, About me. Click your name at the bottom left for your status and a custom status."],
  ],
  voice: [
    ["Voice channels", "volume", "Click a voice channel to join. Everyone shows as a tile; click a camera or a screen to put it in the middle, and use full screen when you want to watch."],
    ["Camera and screen", "monitor", "The buttons under your voice panel turn on your camera, share your screen, or play a sound from the soundboard for everyone in the channel."],
    ["Calls with friends", "phone", "Open a conversation and press the phone or the camera at the top. The call sits above your messages; drag its edge to make it bigger."],
    ["Hearing people right", "headphones", "Right-click someone for their volume. Settings → Voice & audio picks your microphone and headset, noise suppression and push to talk."],
  ],
  servers: [
    ["Channels", "hash", "Text channels for chatting and voice channels for talking; every voice channel has a chat of its own. Right-click a channel to edit it."],
    ["Roles", "shield", "Server settings → Roles: give people a colour, their own heading in the member list, and what they may do. Private channels only chosen roles can see."],
    ["Keeping it friendly", "clock", "Moderators can time people out, use slowmode, move or mute people in voice, and everything is in the audit log."],
    ["Nicknames", "edit", "Change nickname in the server menu gives you a name for just that server."],
  ],
  privacy: [
    ["Your messages", "lock", "Direct messages and group chats are end-to-end encrypted: only the people in them can read them, not even Hopp Cloud."],
    ["Calls", "phone", "Voice and video go straight between you and the people you talk to whenever the network allows."],
    ["Who can reach you", "shield", "Settings → Privacy & safety decides who may send you friend requests. Block anyone from their menu."],
    ["Your Hopp ID", "eye-off", "You sign in with a key kept on your computer. Back up your recovery phrase in Settings → Password & security."],
  ],
  keys: [
    ["Getting around", "keyboard", "Ctrl+K jumps to any server, channel or friend. Alt+↑ and Alt+↓ move between channels. Ctrl+F searches the chat you're in."],
    ["In voice", "mic", "Ctrl+M mutes you, Ctrl+D deafens you. Push to talk uses the key you pick in Settings → Keybinds."],
    ["Writing", "edit", "↑ in an empty message box edits your last message. Type : for emoji and @ to mention someone. Esc marks a channel read."],
  ],
};

/** The parts of About Hopp, for the quick list under it in the sidebar: [anchor, label]. */
function newsParts(key) {
  // Only the long page gets a quick list; short ones are seen at a glance.
  if (key !== "about") return [];
  return [...NEWS_ABOUT.map(([id, title]) => [id, title]), ["limits", "Hopp Cloud, honestly"], ["own", "Your own server"]];
}

function renderNewsNav(body, head) {
  $("sidebar-title").textContent = "Discover";
  head.disabled = true;
  body.classList.remove("stale");
  const rows = [];
  for (const [key, label, ic] of NEWS_SECTIONS) {
    const current = newsSection === key;
    const b = el("button", "channel-row news-nav" + (current ? " current" : ""));
    b.type = "button";
    b.append(icon(ic), el("span", "ellipsis", label));
    b.addEventListener("click", () => {
      newsSection = key;
      renderSidebar();
      renderNews();
      $("news-body").scrollTop = 0;
    });
    rows.push(b);
    // The open section folds out its parts: a click scrolls right to one.
    if (current && newsParts(key).length) {
      const parts = el("div", "news-parts");
      for (const [anchor, text] of newsParts(key)) {
        const p = el("button", "news-part", text);
        p.type = "button";
        p.dataset.anchor = anchor;
        p.addEventListener("click", () => document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" }));
        parts.append(p);
      }
      rows.push(parts);
    }
  }
  body.replaceChildren(...rows);
}

function newsHero(kicker, title, text, ic) {
  const hero = el("header", "news-hero");
  const words = el("div", "news-hero-words");
  words.append(el("span", "news-kicker", kicker), el("h1", "", title), el("p", "", text));
  const art = el("span", "news-hero-art");
  art.append(icon(ic));
  hero.append(words, art);
  return hero;
}

function newsCard(id, title, ic, text, cls = "") {
  const card = el("article", "news-card" + cls);
  card.id = id;
  const mark = el("span", "news-card-icon");
  mark.append(icon(ic));
  card.append(mark, el("h3", "", title), el("p", "", text));
  return card;
}

async function renderNews() {
  await loadWhatsNew();
  const body = $("news-body");
  const [, label, ic, sub] = NEWS_SECTIONS.find(([k]) => k === newsSection) ?? NEWS_SECTIONS[0];
  $("news-title").textContent = label;
  const page = el("div", "news-page");
  if (newsSection === "news") {
    const versions = newsVersions();
    page.append(newsHero("What's new", versions[0] ? "Hopp " + versions[0] : "Hopp", sub, "compass"));
    if (!versions.length) page.append(newsCard("news-none", "Nothing here yet", "compass", "Hopp is still finding its feet. When there's news worth telling, it shows up here."));
    const line = el("div", "news-timeline");
    versions.forEach((v, i) => {
      const item = el("article", "news-release" + (i === 0 ? " latest" : ""));
      item.id = "v-" + v.replaceAll(".", "-");
      const h = el("div", "news-release-head");
      h.append(el("h2", "", "Version " + v));
      if (i === 0) h.append(el("span", "news-new", "Latest"));
      const list = el("ul", "news-points");
      for (const ln of whatsNew[v].split("\n")) {
        const text = ln.replace(/^\s*•\s*/, "").trim();
        if (!text) continue;
        const li = el("li");
        li.append(icon("check"), el("span", "", text));
        list.append(li);
      }
      item.append(h, list);
      line.append(item);
    });
    if (versions.length) page.append(line);
    if (versions[0]) save("newsSeen", versions[0]);
    $("news-dot").hidden = true;
  } else if (newsSection === "about") {
    page.append(newsHero("About", "Hopp", sub + " Free, with no ads and no tracking.", "logo"));
    const grid = el("div", "news-grid");
    for (const [id, title, i, text] of NEWS_ABOUT) grid.append(newsCard(id, title, i, text));
    page.append(grid);
    const limits = el("section", "news-block");
    limits.id = "limits";
    limits.append(el("span", "news-kicker", "Hopp Cloud, honestly"), el("h2", "", "Why there are limits"), el("p", "news-lead", "Hopp Cloud runs on a free plan. That's how Hopp stays free, with no ads and nothing to pay. A free plan only does so much each day and only stores so much, so Hopp keeps things small and shares them fairly. Here is every limit, and why it's there."));
    const list = el("div", "news-limits");
    for (const [value, what, why] of CLOUD_LIMITS) {
      const row = el("div", "news-limit");
      const words = el("div", "news-limit-words");
      words.append(el("strong", "", what), el("span", "", why));
      row.append(el("span", "news-limit-value", value), words);
      list.append(row);
    }
    limits.append(list);
    page.append(limits);
    const own = el("section", "news-cta");
    own.id = "own";
    const words = el("div", "");
    words.append(el("h2", "", "No limits of your own"), el("p", "", "Run a server on your own computer: it keeps what you want, and nothing goes through Hopp Cloud."));
    const go = el("button", "btn primary", "Run your own server");
    go.type = "button";
    go.addEventListener("click", () => openAddDialog("host"));
    own.append(words, go);
    page.append(own, el("p", "news-version", "Hopp " + (updates.version || "")));
  } else {
    page.append(newsHero("Guide", label, sub, ic));
    const grid = el("div", "news-grid");
    (NEWS_GUIDES[newsSection] ?? []).forEach(([title, i, text], n) => grid.append(newsCard("g-" + n, title, i, text)));
    page.append(grid);
  }
  body.replaceChildren(page);
  watchNewsParts();
}

/** While you scroll, the part you're reading is marked in the sidebar. */
var newsSpy = null;
function watchNewsParts() {
  newsSpy?.disconnect();
  const marks = [...document.querySelectorAll(".news-part")];
  if (!marks.length) return;
  const mark = (anchor) => marks.forEach((m) => m.classList.toggle("current", m.dataset.anchor === anchor));
  mark(marks[0].dataset.anchor);
  newsSpy = new IntersectionObserver((entries) => {
    const seen = entries.filter((e) => e.isIntersecting).sort((x, y) => x.boundingClientRect.top - y.boundingClientRect.top)[0];
    if (seen) mark(seen.target.id);
  }, { root: $("news-body"), rootMargin: "0px 0px -60% 0px" });
  for (const m of marks) {
    const target = document.getElementById(m.dataset.anchor);
    if (target) newsSpy.observe(target);
  }
}

function openDiscover() {
  closePopovers();
  saveDraft();
  state.atNews = true;
  renderAll();
}

$("news-btn").addEventListener("click", openDiscover);
// Anything else in the server list (Home, a server, Add) leaves the page.
$("server-list").parentElement.addEventListener("click", (e) => {
  if (!state.atNews || e.target.closest("#news-btn") || !e.target.closest(".rail-item")) return;
  state.atNews = false;
  setTimeout(renderAll, 0);
}, true);
renderNewsDot();
