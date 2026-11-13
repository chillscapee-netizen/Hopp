// A visual sweep: opens the app in many states (every view, light and dark, big and the
// smallest window, long names) and reports what an eye would catch:
//  - text cut off without "…" (or spilling out of its box)
//  - things outside the window
//  - clickable things covering each other
//  - text too faint to read on its background
//
//   node client/tests/visual.mjs            prints findings; exits 1 if any
//
// It runs the page like the page tests do (mock.js for Tauri).

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const src = join(here, "..", "src");
const work = join(tmpdir(), "hopp-visual");
const edge = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => {
  try { readFileSync(p); return true; } catch { return false; }
});
mkdirSync(work, { recursive: true });
cpSync(src, work, { recursive: true });
copyFileSync(join(here, "mock.js"), join(work, "mock.js"));
const page = readFileSync(join(src, "index.html"), "utf8");

// Each scene: what to do before looking.
const STRESS = `
  const r = structuredClone(state.roster);
  r.features = ["search","screen","voice-chat","voice-mod","voice-settings","mod-tools","roles","pings","resync"];
  r.roles = [{ id: 7, name: "A rather long role name", color: "#46a758", hoist: true, level: "mod", position: 2, mentionable: true }];
  r.channels.push({ id: 9, name: "a-really-quite-long-channel-name-here", kind: "text", topic: "A long topic that goes on and on to see what happens in the header of the channel" });
  r.users.find((u) => u.name === "Elin").name = "Elinorabella Strandberg-Lindqvist";
  r.users[1].roles = [7];
  emit("roster", r); await wait(150);`;
const scenes = {
  chat: ``,
  longchannel: `[...document.querySelectorAll(".channel-row")].find((n) => n.textContent.includes("really"))?.click(); await wait(150);`,
  voice: `const m = structuredClone(state.roster); m.users[0].voice_channel = 1; emit("roster", m); emit("voice-state", { ready: true }); await wait(50); [...document.querySelectorAll(".channel-row")].find((n) => n.textContent.includes("Lobby"))?.click(); await wait(250);`,
  membermenu: `[...document.querySelectorAll(".member")].find((x) => x.textContent.includes("Elin"))?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 9999, clientY: 9999 })); await wait(150); [...document.querySelectorAll("#server-menu .menu-item")].find((b) => b.textContent.trim() === "Voice")?.dispatchEvent(new MouseEvent("mouseenter")); await wait(150);`,
  usercard: `[...document.querySelectorAll(".member")].find((x) => x.textContent.includes("Elin"))?.click(); await wait(150);`,
  home: `$("home-btn").click(); await wait(250);`,
  dm: `$("home-btn").click(); await wait(100); document.querySelector(".dm-row")?.click(); await wait(250);`,
  settings: `openSettings("profile"); await wait(200);`,
  appearance: `openSettings("appearance"); await wait(200);`,
  voicesettings: `openSettings("voice"); await wait(200);`,
  notifications: `openSettings("sounds"); await wait(200);`,
  serversettings: `openServerSettings(); await wait(200);`,
  roles: `openServerSettings(); await wait(50); showServerTab("roles"); document.querySelector(".role-row")?.click(); await wait(200);`,
  members: `openServerSettings(); await wait(50); showServerTab("members"); await wait(200);`,
  channeledit: `openChannelEdit(state.roster.channels[0]); await wait(200);`,
  invite: `openInvite(); await wait(250);`,
  add: `openModal($("add-dialog")); await wait(200);`,
  emoji: `$("emoji-btn").click(); await wait(250);`,
  servermenu: `$("sidebar-head").click(); await wait(150); [...document.querySelectorAll("#server-menu .menu-item")].find((b) => b.textContent.trim() === "Notifications")?.dispatchEvent(new MouseEvent("mouseenter")); await wait(150);`,
  status: `$("me-card").click(); await wait(200);`,
  call: `$("home-btn").click(); await wait(100); openDm(KEYS.elin); await wait(150); await startCall(KEYS.elin); state.call.status = "live"; state.call.startedAt = Date.now() - 60000; state.call.engineReady = true; renderCall(); await wait(200);`,
  callscreen: `$("home-btn").click(); await wait(100); openDm(KEYS.elin); await wait(150); await startCall(KEYS.elin); state.call.status = "live"; state.call.startedAt = Date.now() - 60000; state.call.engineReady = true; const c = document.createElement("canvas"); c.width = 640; c.height = 360; c.getContext("2d").fillRect(0, 0, 640, 360); mediaIn.set("screen|" + KEYS.elin, { stream: c.captureStream(5) }); renderCall(); await wait(300);`,
  // What came later: the inbox, a poll, a voice message, formatting, name styles, forwarding,
  // keybinds, streamer mode, and a screen offered in a call.
  inbox: `emit("account", { type: "inbox", items: [{ server: "cloud:crew0001", channel: 2, id: 77, at: Date.now() - 60000, server_name: "The Crew With A Very Long Server Name", channel_name: "a-really-quite-long-channel-name-here", author_key: KEYS.elin, author_name: "Elinorabella Strandberg-Lindqvist", preview: "@Marcus you in for the raid tonight? It's going to be a long one so bring snacks and water", crowd: false }] }); await wait(50); $("inbox-btn").click(); await wait(200);`,
  posts: `const r2 = structuredClone(state.roster); r2.features = [...(r2.features ?? []), "polls", "voice-messages"]; emit("roster", r2); await wait(80); state.friends.get(KEYS.elin).name_color = "#8ab4f8 #f28b9b f:graffiti"; emit("chat", { id: 9981, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "hopp-poll:" + base64url(JSON.stringify({ q: "What do we play tonight, after the raid, if everyone is still awake?", a: ["Raid", "Arena with a really long answer that goes on", "Sleep"], end: Date.now() + 3600000 })), sent_at: Date.now(), reactions: [{ emoji: "poll:0", keys: [ME] }] }); emit("chat", { id: 9982, channel: 0, sender: 3, sender_name: "Jonas", author_key: KEYS.jonas, text: "hopp-voice:" + "cd".repeat(16) + " 42000", sent_at: Date.now() }); emit("chat", { id: 9983, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "# Raid night\\n-# small print [Sign up](https://example.com/raid)\\n- one\\n1. two", sent_at: Date.now() }); await wait(250);`,
  forward: `forwardMessage(state.chats.get(0).at(-1)); await wait(250);`,
  keybinds: `prefs.keybinds = { mute: { key: 5, mods: 7, label: "Ctrl + Shift + Alt + Mouse 4" } }; renderKeybinds(); openSettings("keys"); await wait(200);`,
  streamer: `$("streamer-mode").checked = true; $("streamer-mode").dispatchEvent(new Event("change")); $("update-btn").hidden = false; openSettings("privacy"); await wait(200);`,
  threads: `const r3 = structuredClone(state.roster); r3.features = [...(r3.features ?? []), "threads"]; r3.channels.push({ id: 77, name: "A thread with a really quite long name about the raid on Saturday", kind: "text", parent: 0, starter: 9601, creator: ME, last_at: Date.now() }); emit("roster", r3); await wait(60); emit("chat", { id: 9601, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "Raid on Saturday? Who is in, and who brings what, and when do we start", sent_at: Date.now() }); await wait(80); openTextChannel(77); await wait(200);`,
  calloffer: `$("home-btn").click(); await wait(100); openDm(KEYS.elin); await wait(150); await startCall(KEYS.elin); state.call.status = "live"; state.call.startedAt = Date.now() - 60000; state.call.engineReady = true; callRoom.send = () => {}; await handleMedia(KEYS.elin, { v: "m", t: "screen", d: "r", k: "live" }, callRoom); await wait(250);`,
};
const themes = ["dusk", "light", "mid"];
const sizes = [[1366, 768], [940, 560]];

const probe = `
function rgb(c) {
  const m = c.match(/[\\d.]+/g);
  if (!m) return null;
  const v = m.map(Number);
  // color(srgb r g b / a) gives 0 to 1 (what color-mix() computes to).
  return c.startsWith("color(") ? [v[0] * 255, v[1] * 255, v[2] * 255, v[3] ?? 1] : v;
}
function lum([r, g, b]) { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); }
function bgOf(el) {
  // The first solid-ish background behind an element (layers mixed over the window's colour).
  const layers = [];
  for (let n = el; n; n = n.parentElement) {
    const c = rgb(getComputedStyle(n).backgroundColor);
    if (c && (c[3] ?? 1) > 0) { layers.push(c); if ((c[3] ?? 1) >= 0.95) break; }
  }
  let base = rgb(getComputedStyle(document.documentElement).getPropertyValue("--app-solid").trim() ? getComputedStyle(document.body).backgroundColor : "rgb(40,40,45)") ?? [40, 40, 45];
  if ((base[3] ?? 1) < 0.5) base = [51, 51, 56];
  for (const c of layers.reverse()) { const a = c[3] ?? 1; base = [0, 1, 2].map((i) => c[i] * a + base[i] * (1 - a)); }
  return base;
}
function visible(n) {
  const r = n.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const cs = getComputedStyle(n);
  if (cs.visibility === "hidden" || Number(cs.opacity) < 0.3) return false;
  for (let p = n; p; p = p.parentElement) { const s = getComputedStyle(p); if (s.display === "none" || Number(s.opacity) < 0.3) return false; }
  return true;
}
const out = [];
const W = innerWidth, H = innerHeight;
const label = (n) => (n.id ? "#" + n.id : "") + "." + [...n.classList].slice(0, 2).join(".") + ' "' + (n.textContent || "").trim().slice(0, 30) + '"';
for (const n of document.querySelectorAll("body *")) {
  if (!visible(n) || n.closest("#test-results, svg, video, canvas, .emoji-grid, iframe, .reaction-emoji, .emoji")) continue;
  const cs = getComputedStyle(n);
  const r = n.getBoundingClientRect();
  const ownText = [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
  // Cut-off text: content wider than the box, no ellipsis, not a scroller.
  if (ownText && n.scrollWidth > n.clientWidth + 1 && cs.textOverflow !== "ellipsis" && !/(auto|scroll)/.test(cs.overflowX) && cs.overflowX === "hidden") out.push("cut off without …: " + label(n));
  if (ownText && cs.overflowX === "visible" && n.scrollWidth > n.clientWidth + 2 && cs.whiteSpace === "nowrap" && !n.closest(".menu, .submenu")) {
    const parent = n.parentElement.getBoundingClientRect();
    if (r.right > parent.right + 2) out.push("text spills out of its box: " + label(n));
  }
  // Outside the window.
  if ((r.right > W + 1 || r.bottom > H + 1 || r.left < -1 || r.top < -1) && cs.position === "fixed") out.push("outside the window: " + label(n));
  // Contrast for text.
  if (ownText && n.textContent.trim().length > 1) {
    const fg = rgb(cs.color);
    if (fg && (fg[3] ?? 1) > 0.5) {
      const bg = bgOf(n);
      const L1 = lum(fg), L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const size = parseFloat(cs.fontSize);
      const need = n.closest("button:disabled, [disabled], .skeleton, .placeholder") ? 1.5 : size >= 18 ? 3 : 3.2;
      if (ratio < need && !n.matches("input, textarea")) out.push("hard to read (" + ratio.toFixed(1) + ":1): " + label(n));
    }
  }
}
// Clickable things covering each other (the top one at a button's middle isn't it).
for (const b of document.querySelectorAll("button, a[href], [role=button]")) {
  if (!visible(b) || b.closest("#test-results")) continue;
  const r = b.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  if (x < 0 || y < 0 || x > W || y > H) continue;
  const top = document.elementFromPoint(x, y);
  if (top && !b.contains(top) && !top.contains(b) && top.closest("button, a[href], [role=button], input") && !top.closest(".popover, .menu, dialog[open], .modal, #server-submenu") === !b.closest(".popover, .menu, dialog[open], .modal, #server-submenu")) out.push("covered by another control: " + label(b) + " under " + label(top));
}
const pre = document.createElement("pre");
pre.id = "test-results";
pre.textContent = [...new Set(out)].join("\\n");
document.body.append(pre);
`;

// Some Edge builds print nothing with --dump-dom (an update waiting for a restart): then each
// scene runs live over the debugging port.
const probeFile = join(work, "probe.html");
writeFileSync(probeFile, "<html><body>probe-ok</body></html>");
let dumpWorks = false;
try {
  dumpWorks = execFileSync(edge, ["--headless=new", "--disable-gpu", "--mute-audio", `--user-data-dir=${join(work, "profile-probe")}`, "--dump-dom", pathToFileURL(probeFile).href], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000 }).includes("probe-ok");
} catch (e) {
  dumpWorks = String(e.stdout ?? "").includes("probe-ok");
}

function cleanUp() {
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -like '*hopp-visual*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], { stdio: "ignore" });
  } catch {
    // Nothing to end.
  }
}

async function runLive(file, w, h) {
  cleanUp();
  const port = 9300 + Math.floor(Math.random() * 500);
  const browser = spawn(edge, ["--headless=new", "--disable-gpu", "--mute-audio", "--allow-file-access-from-files", `--user-data-dir=${join(work, "live")}`, `--window-size=${w},${h}`, `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    let target = null;
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(200);
      target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(pathToFileURL(file).href)}`, { method: "PUT" }).then((r) => r.json()).catch(() => null);
    }
    if (!target) return "";
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    let id = 0;
    const evaluate = (expression) => new Promise((resolve) => {
      const mine = ++id;
      const onMessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.id !== mine) return;
        ws.removeEventListener("message", onMessage);
        resolve(msg.result?.result?.value ?? null);
      };
      ws.addEventListener("message", onMessage);
      ws.send(JSON.stringify({ id: mine, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    });
    const until = Date.now() + 25000;
    while (Date.now() < until) {
      const out = await evaluate("document.getElementById('test-results')?.outerHTML ?? null");
      if (out) { ws.close(); return out; }
      await sleep(300);
    }
    ws.close();
    return "";
  } finally {
    browser.kill();
    cleanUp();
  }
}

let total = 0;
for (const [w, h] of sizes) {
  for (const theme of themes) {
    for (const [name, steps] of Object.entries(scenes)) {
      const script = `(async () => { await inServer(); prefs.theme = "${theme}"; applyTheme(); ${STRESS} ${steps} await wait(150); ${probe} })();`;
      const file = join(work, "v.js");
      writeFileSync(file, script);
      const html = join(work, "v.html");
      writeFileSync(html, page.replace('<script src="main.js"></script>', '<script src="mock.js"></script><script src="main.js"></script><script src="v.js"></script>'));
      let dom = "";
      if (dumpWorks) {
        try {
          dom = execFileSync(edge, ["--headless=new", "--disable-gpu", "--mute-audio", "--allow-file-access-from-files", `--user-data-dir=${join(work, "profile")}`, `--window-size=${w},${h}`, "--virtual-time-budget=20000", "--dump-dom", pathToFileURL(html).href], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
        } catch (e) {
          dom = String(e.stdout ?? "");
        }
      } else dom = await runLive(html, w, h);
      const m = dom.match(/<pre id="test-results">([\s\S]*?)<\/pre>/);
      const lines = (m?.[1] ?? "scene never finished").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').split("\n").filter(Boolean);
      if (lines.length) {
        console.log(`\n${name} · ${theme} · ${w}×${h}`);
        for (const l of lines) console.log("  " + l);
        total += lines.length;
      }
    }
  }
}
console.log(total ? `\n${total} findings` : "\nnothing found");
process.exit(total ? 1 : 0);
