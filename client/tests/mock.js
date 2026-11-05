// A stand-in for Tauri, so the app's page can be tested in a plain browser:
// one logged-in account (Marcus) with two servers, friends and direct messages.
// Tests drive it through `emit` (events the backend would send) and read what
// the page sent through `sent`.

const ME = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9a";
const KEYS = { elin: "e".repeat(64), jonas: "b".repeat(64), sara: "c".repeat(64), ali: "d".repeat(64), kim: "f".repeat(64) };
const now = Date.now();
const ago = (minutes) => now - minutes * 60_000;

/** ?empty: a brand-new account with no servers and no friends. */
const EMPTY = new URLSearchParams(location.search).has("empty");

try {
  localStorage.clear();
  if (!EMPTY) localStorage.setItem(
    "servers@" + ME.slice(0, 16),
    JSON.stringify([
      { id: "a", address: "cloud:crew0001", label: "The Crew", customLabel: false, joined: true },
      { id: "b", address: "192.168.8.35", label: "Raid Night", customLabel: true, joined: true },
    ]),
  );
} catch {}

const handlers = {};
const sent = [];
const emit = (name, payload) => handlers[name]?.({ payload });

const roster = {
  server_name: "The Crew",
  server_icon: null,
  me: 1,
  channels: [
    { id: 0, name: "general", kind: "text", topic: "Say hi" },
    { id: 3, name: "clips", kind: "text" },
    { id: 4, name: "lfg", kind: "text" },
    { id: 1, name: "Lobby", kind: "voice" },
    { id: 2, name: "Gaming", kind: "voice" },
  ],
  users: [
    { session_id: 1, name: "Marcus", voice_channel: null, muted: false, deafened: false, owner: true, public_key: ME },
    { session_id: 2, name: "Elin", voice_channel: 1, muted: false, deafened: false, owner: false, public_key: KEYS.elin },
    { session_id: 3, name: "Jonas", voice_channel: 1, muted: true, deafened: false, owner: false, public_key: KEYS.jonas },
    { session_id: 4, name: "Sara", voice_channel: null, muted: false, deafened: false, owner: false, public_key: KEYS.sara },
  ],
};

let nextId = 100;
const msg = (session, name, key, text, minutes, channel = 0, extra = {}) => ({
  id: nextId++, channel, sender: session, sender_name: name, author_key: key, text, sent_at: ago(minutes), ...extra,
});
const history = [
  msg(2, "Elin", KEYS.elin, "Anyone up for a round tonight?", 120),
  msg(3, "Jonas", KEYS.jonas, "I'm in after 8", 110),
  msg(1, "Marcus", ME, "Servers are **invite-only** now", 30),
  msg(4, "Sara", KEYS.sara, "Patch notes: https://example.com/patch", 20),
  msg(2, "Elin", KEYS.elin, "nice, see you there", 5, 0, { reactions: [{ emoji: "👍", keys: [ME, KEYS.sara] }] }),
];

const friends = [
  { key: KEYS.elin, username: "elin", display_name: "Elin", avatar: null, state: "friend", status: "online", activity: "In voice" },
  { key: KEYS.jonas, username: "jonas", display_name: "Jonas", avatar: null, state: "friend", status: "idle", activity: null },
  { key: KEYS.sara, username: "sara", display_name: "Sara", avatar: null, state: "friend", status: "dnd", activity: null },
  { key: KEYS.kim, username: "kim", display_name: "Kim", avatar: null, state: "friend", status: "offline", activity: null },
  { key: KEYS.ali, username: "ali", display_name: "Ali", avatar: null, state: "incoming", status: "offline", activity: null },
];

// Direct messages are "sealed" as "plain:<text>" here; dm_open/dm_seal undo and do that.
const dmHistory = {
  [KEYS.elin]: [
    { id: "d1", from_key: KEYS.elin, sealed: "plain:Ready for tonight? 🎮", sent_at: ago(15) },
    { id: "d2", from_key: ME, sealed: "plain:Yes! Join Lobby in 5", sent_at: ago(14) },
  ],
};

/** Encrypted DM pictures the app uploaded, by id (what the cloud would store). */
const uploadedDm = new Map();

const commands = {
  account_status: () => ({ exists: true, name: "Marcus", public_key: ME, logged_in: true, remembered: true, backed_up: true }),
  take_pending_link: () => null,
  windows_hello_available: () => false,
  list_devices: () => ({ inputs: ["Headset Microphone"], outputs: ["Headphones"], default_input: "Headset Microphone", default_output: "Headphones" }),
  autostart_enabled: () => false,
  check_update: () => null,
  connect: () => {
    setTimeout(() => {
      emit("chat-history", { channel: 0, messages: history });
      emit("chat-history", { channel: 3, messages: [] });
      emit("chat-history", { channel: 4, messages: [msg(4, "Sara", KEYS.sara, "lfg ranked?", 3, 4)] });
    }, 30);
    return structuredClone(roster);
  },
  start_account: () => {
    setTimeout(() => {
      emit("account-state", { connected: true });
      emit("account", {
        type: "welcome",
        me: { key: ME, username: "marcus", display_name: "Marcus", avatar: null, bio: "", status: "online", privacy: "everyone" },
        sync: { data: null, version: 0 },
        friends: EMPTY ? [] : friends,
        conversations: EMPTY ? [] : [{ peer: KEYS.elin, last_at: ago(14), last_read: ago(20) }],
        channels: [],
        groups: [],
      });
    }, 20);
  },
  account_send: ({ msg: m }) => {
    sent.push(m);
    if (m.type === "dm_history") setTimeout(() => emit("account", { type: "dm_history", with: m.with, messages: dmHistory[m.with] ?? [], complete: true }), 10);
    if (m.type === "dm_edit") setTimeout(() => emit("account", { type: "dm_edited", with: m.with, id: m.id, sealed: typeof m.sealed === "string" ? m.sealed : m.sealed[ME], edited_at: Date.now() }), 10);
    if (m.type === "dm_delete") setTimeout(() => emit("account", { type: "dm_deleted", with: m.with, id: m.id }), 10);
    if (m.type === "dm_send") setTimeout(() => emit("account", { type: "dm", with: m.to, nonce: m.nonce, message: { id: "d" + nextId++, from_key: ME, sealed: m.sealed, sent_at: Date.now() } }), 10);
  },
  dm_seal: ({ text }) => "plain:" + text,
  dm_open: ({ sealed }) => {
    if (!sealed.startsWith("plain:")) throw new Error("can't open");
    return sealed.slice(6);
  },
  seal_private: () => "sealed",
  open_private: () => "{}",
  invite_preview: ({ code }) => ({ name: "Night Raiders", icon: null, members: 12, online: 4, server_id: "nr0001", code, inviter: "Elin" }),
  set_role: (a) => { sent.push({ type: "set_role", ...a }); },
  transfer_ownership: (a) => { sent.push({ type: "transfer_ownership", ...a }); },
  upload_image: ({ data, kind }) => { sent.push({ type: "upload_image", size: data.length, kind }); return "ab".repeat(16); },
  update_server: (a) => { sent.push({ type: "update_server", ...a }); },
  update_channel: (a) => { sent.push({ type: "update_channel", ...a }); },
  upload_dm_image: ({ data }) => { const id = "cd".repeat(16); uploadedDm.set(id, new Uint8Array(data)); sent.push({ type: "upload_dm_image", size: data.length }); return id; },
  gif_search: () => ({ gifs: [], next: null }),
  fetch_profile: ({ key }) => ({ key, username: null, display_name: "Someone", avatar: null, bio: "" }),
  send_chat: ({ channel, text }) => {
    setTimeout(() => emit("chat", { id: nextId++, channel, sender: 1, sender_name: "Marcus", author_key: ME, text, sent_at: Date.now() }), 10);
  },
};

window.__TAURI__ = {
  core: {
    invoke: async (cmd, args) => {
      const fn = commands[cmd];
      return fn ? fn(args ?? {}) : undefined;
    },
  },
  event: {
    listen: async (name, fn) => {
      handlers[name] = fn;
      return () => {};
    },
  },
  window: { getCurrentWindow: () => ({ minimize() {}, toggleMaximize() {}, isMaximized: async () => false, onResized() {} }) },
};

// ---------- for tests ----------

const results = [];
const pageErrors = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
window.addEventListener("error", (e) => pageErrors.push(e.message + " @" + e.lineno));
window.addEventListener("unhandledrejection", (e) => pageErrors.push("promise: " + (e.reason?.message ?? e.reason)));

/** Records one check; any "FAIL" line makes the whole run fail. */
function check(name, ok, detail = "") {
  results.push((ok ? "ok   " : "FAIL ") + name + (detail ? "  (" + detail + ")" : ""));
}

/** Waits for the app to be in a server, ready to test. */
async function inServer() {
  for (let i = 0; i < 60 && !document.querySelector("#server-list .rail-item"); i++) await wait(100);
  document.querySelector("#server-list .rail-item")?.click();
  // The channel history has arrived (live messages before it would be replaced).
  for (let i = 0; i < 80 && !(state.chats.get(0)?.length >= 5 && document.querySelector("#messages .msg")); i++) await wait(100);
}

/** Puts the results on the page, where the runner reads them. */
function report() {
  for (const e of pageErrors) results.push("FAIL page error: " + e);
  const pre = document.createElement("pre");
  pre.id = "test-results";
  pre.textContent = results.join("\n");
  document.body.append(pre);
}
