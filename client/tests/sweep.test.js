// virtual-time: 120000
// A sweep through every view, dialog, settings page and menu, on a Hopp Cloud server and on a
// server on someone's computer: no errors thrown, nothing outside the window or cut off by its
// box, no text cut off without "…", no button without a name, no broken picture, and no
// "undefined", "NaN" or "[object Object]" shown.

const problems = [];

function visible(n) {
  if (!(n instanceof Element)) return false;
  const r = n.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const s = getComputedStyle(n);
  return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
}

/** The nearest box that cuts off what sticks out of it (not one that scrolls). */
function clipBox(n) {
  for (let p = n.parentElement; p && p !== document.documentElement; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (/(auto|scroll)/.test(s.overflowX + s.overflowY)) return null;
    if (/(hidden|clip)/.test(s.overflowX + s.overflowY)) return p;
  }
  return null;
}

/** Inside a list that scrolls: what's beyond its edge is scrolled to, not lost. */
function inScroller(n) {
  for (let p = n.parentElement; p && p !== document.documentElement; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (/(auto|scroll)/.test(s.overflowX + s.overflowY) && p.scrollHeight > p.clientHeight + 1) return true;
  }
  return false;
}

/** Text that's cut off without the … that says so. */
function cutText(n) {
  const s = getComputedStyle(n);
  if (s.textOverflow === "ellipsis" || n.closest(".ellipsis")) return false;
  if (!/(hidden|clip)/.test(s.overflowX)) return false;
  return n.children.length === 0 && n.textContent.trim().length > 0 && n.scrollWidth > n.clientWidth + 2;
}

function audit(where) {
  const root = document.querySelector("dialog[open]") ?? document.body;
  const found = [];
  const w = innerWidth;
  const h = innerHeight;
  for (const n of root.querySelectorAll("button, a, input, select, textarea, label, h1, h2, h3, p, span, li, img")) {
    if (!visible(n)) continue;
    // Inside a closed <details> (laid out but not shown), or a colour picker hidden in its round swatch.
    if (n.closest("details:not([open]) > :not(summary)") || n.matches("input[type=color]")) continue;
    const r = n.getBoundingClientRect();
    const name = `${n.tagName.toLowerCase()}${n.id ? "#" + n.id : ""}.${String(n.className).split(" ")[0]} "${n.textContent.trim().slice(0, 24)}"`;
    if (r.right > w + 1 || r.left < -1 || r.top < -1 || r.bottom > h + 1) {
      if (!inScroller(n)) found.push(`outside the window (${w}×${h}): ${name}`);
    }
    const box = clipBox(n);
    if (box && n.tagName !== "IMG" && getComputedStyle(n).textOverflow !== "ellipsis") {
      const b = box.getBoundingClientRect();
      if (r.right > b.right + 2 || r.bottom > b.bottom + 2 || r.left < b.left - 2) found.push(`cut off by its box (${String(box.className).split(" ")[0]}): ${name}`);
    }
    if (cutText(n)) found.push(`text cut off without …: ${name}`);
    if (n.tagName === "BUTTON" && !n.textContent.trim() && !n.getAttribute("aria-label") && !n.title && !n.dataset.tip && !n.querySelector("img[alt]:not([alt=''])")) {
      found.push(`button without a name: ${n.id ? "#" + n.id : ""}.${n.className}`);
    }
    if (n.tagName === "IMG" && n.complete && n.getAttribute("src") && n.naturalWidth === 0 && !/hoppimg|example|hopp-cloud|127\.0\.0\.1/.test(n.src)) found.push(`broken picture: ${n.src.slice(0, 60)}`);
  }
  const text = root.innerText ?? "";
  const bad = text.match(/\b(undefined|NaN)\b|\[object Object\]|(^|\s)null(\s|$)/);
  if (bad) {
    const at = text.indexOf(bad[0].trim());
    found.push(`shows "${bad[0].trim()}": …${text.slice(Math.max(0, at - 40), at + 30).replace(/\s+/g, " ")}…`);
  }
  for (const f of [...new Set(found)].slice(0, 8)) problems.push(`${where}: ${f}`);
}

const fakeClick = (x, y) => ({ clientX: x, clientY: y, preventDefault() {}, stopPropagation() {}, target: document.body, currentTarget: document.body });

async function view(name, open) {
  const before = pageErrors.length;
  try {
    await open();
  } catch (e) {
    pageErrors.push("threw: " + e.message);
  }
  await wait(250);
  audit(name);
  for (const e of pageErrors.splice(before)) problems.push(`${name}: error: ${e}`);
  if (typeof closePopovers === "function") closePopovers();
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  await wait(50);
}

async function sweep(label) {
  const me = state.roster.users.find((u) => u.session_id === state.roster.me);
  const other = state.roster.users.find((u) => u.session_id !== state.roster.me);
  const text = state.roster.channels.find((c) => c.kind === "text");
  const voice = state.roster.channels.find((c) => c.kind === "voice");
  const msg = (state.chats.get(text.id) ?? [])[0];
  await view(`${label} chat`, () => openTextChannel(text.id));
  await view(`${label} voice channel view`, () => openTextChannel(voice.id));
  await view(`${label} back to text`, () => openTextChannel(text.id));
  for (const tab of ["profile", "security", "privacy", "appearance", "voice", "sounds", "keys", "windows"]) {
    await view(`${label} settings ${tab}`, () => {
      openSettings(tab);
      document.querySelector(`.settings-tab[data-tab="${tab}"]`)?.click();
    });
  }
  for (const tab of ["overview", "invites", "members", "roles", "emojis", "audit", "bans"]) {
    await view(`${label} server settings ${tab}`, () => {
      openServerSettings();
      showServerTab(tab);
    });
  }
  for (const step of ["choose", "join", "create", "host"]) await view(`${label} add server: ${step}`, () => openAddDialog(step));
  await view(`${label} invite`, () => openInvite());
  await view(`${label} edit text channel`, () => openChannelEdit(text));
  await view(`${label} edit voice channel`, () => openChannelEdit(voice));
  await view(`${label} poll`, () => openPollDialog());
  if (msg) {
    await view(`${label} thread`, () => openThreadDialog(msg));
    await view(`${label} message menu`, () => openMessageMenu(msg, fakeClick(400, 300)));
    await view(`${label} forward`, () => openForward(msg.text, msg.sender_name, "general", msg.sent_at));
  }
  await view(`${label} channel menu`, () => openChannelMenu(text, fakeClick(200, 200)));
  await view(`${label} server menu`, () => openServerMenu(activeServer(), 300, 300));
  if (other) {
    await view(`${label} user card`, () => openUserCard(other, document.querySelector(".member") ?? document.body));
    await view(`${label} user menu`, () => openUserMenu(other, document.querySelector(".member"), fakeClick(600, 300)));
  }
  if (me) await view(`${label} my card`, () => openUserCard(me, document.querySelector(".user-panel") ?? document.body));
  await view(`${label} emoji picker`, () => openEmojiPicker(document.getElementById("emoji-btn"), () => {}, () => {}));
  await view(`${label} status`, () => openStatusDialog());
}

(async () => {
  await inServer();
  await wait(300);
  await sweep("cloud");

  // A server on someone's computer, with everything Hopp Cloud has.
  const home = prefs.servers.find((s) => !isCloud(s));
  const connect = commands.connect;
  commands.connect = (a) => ({ ...connect(a), features: ["search", "screen", "voice-chat", "voice-mod", "voice-settings", "mod-tools", "roles", "pings", "resync", "nicknames", "members", "emojis", "search-filters", "polls", "voice-messages", "threads"], mesh: true });
  await connectTo(home);
  renderAll();
  await wait(300);
  await sweep("own server");
  commands.connect = connect;

  // The longest names allowed everywhere: nothing may spill or overlap.
  const W = (n) => "W".repeat(n);
  const long = structuredClone(state.roster);
  long.server_name = W(40);
  for (const c of long.channels) {
    c.name = c.kind === "text" ? "w".repeat(32) + c.id : W(31) + c.id;
    c.topic = "A very long topic ".repeat(11).slice(0, 200);
  }
  for (const u of long.users) u.name = W(31) + u.session_id;
  activeServer().label = W(40);
  emit("roster", long);
  await wait(300);
  await sweep("long names");

  // Home: friends, messages, a group.
  for (const tab of ["online", "all", "pending", "blocked", "add"]) await view(`home ${tab}`, () => goHomeTab(tab));
  await view("home: group dialog", () => openGroupDialog());

  for (const p of problems.slice(0, 80)) check(p, false);
  check(`swept every view (${problems.length} problems)`, problems.length === 0);
  report();
})();
