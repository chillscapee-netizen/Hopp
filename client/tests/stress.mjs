// Stress test: does what people do in Hopp, many times over, and times each thing. Anything
// that holds the app up longer than a frame or two is flagged, so slow spots (like the emoji
// picker drawing ~1,900 emojis at once) are found here and not by someone using the app.
//
//   node client/tests/stress.mjs            (exits 1 when something is too slow or grows)
//
// Times are per action, measured in the page including the layout that follows. The browser
// here is faster than a busy PC with a game running, so the limits are strict.

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const work = join(tmpdir(), "hopp-stress");
const edge = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => {
  try { readFileSync(p); return true; } catch { return false; }
});
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
cpSync(join(here, "..", "src"), work, { recursive: true });
copyFileSync(join(here, "mock.js"), join(work, "mock.js"));

// What runs in the page: each scenario is done `times` times; we keep the slowest and average.
const scenarios = String.raw`
const LIMIT_MS = 50;      // one action may hold the app up at most this long
const stressRows = [];
const nodes = () => document.getElementsByTagName("*").length;
const settle = () => new Promise((r) => setTimeout(r, 0));
async function measure(name, times, action, { limit = LIMIT_MS, before, grows = false } = {}) {
  window.__stressAt = name;
  const ms = [];
  const startNodes = nodes();
  for (let i = 0; i < times; i++) {
    if (before) await before(i);
    await settle();
    const t = performance.now();
    await action(i);
    void document.body.offsetHeight; // the layout it causes counts too
    ms.push(performance.now() - t);
  }
  await settle();
  stressRows.push({ name, times, mayGrow: grows, avg: ms.reduce((a, b) => a + b, 0) / ms.length, max: Math.max(...ms), limit, grew: nodes() - startNodes });
}

window.addEventListener("error", (e) => (window.__lastError = e.message));
(async () => {
  try {
  await inServer();
  const ME_KEY = state.account?.publicKey;
  const msg = (id, ch, text, who = "Elin", key = KEYS.elin) => ({ id, channel: ch, sender: 2, sender_name: who, author_key: key, text, sent_at: Date.now() - (100000 - id) * 1000 });

  // A busy channel: 400 messages with emojis, links and mentions.
  const many = [];
  for (let i = 0; i < 400; i++) many.push(msg(20000 + i, 3, i % 7 === 0 ? "gg 🔥🔥 <@" + ME_KEY + "> https://example.com/" + i : i % 5 === 0 ? "😂" : "message number " + i + " with some words in it"));
  await measure("open a channel with 400 messages", 1, async () => { emit("chat-history", { channel: 3, messages: many }); openTextChannel(3); });
  await measure("switch between two channels", 20, (i) => openTextChannel(i % 2 ? 0 : 3));
  openTextChannel(3);
  await measure("a new message arrives (busy chat)", 60, (i) => emit("chat", msg(30000 + i, 3, "new " + i + " 👍")));
  await measure("reactions pour in", 40, (i) => emit("reactions", { channel: 3, id: 20399, reactions: [{ emoji: ["🔥", "😂", "👍", "❤️"][i % 4], keys: [KEYS.elin, KEYS.sara].slice(0, 1 + (i % 2)) }, { emoji: "🎉", keys: [KEYS.jonas] }] }));
  await measure("scroll up and down the chat", 30, (i) => { const s = $("scroller"); s.scrollTop = i % 2 ? 0 : s.scrollHeight; s.dispatchEvent(new Event("scroll")); }, { grows: true });

  // The emoji picker, opened and searched like people do.
  await measure("open the emoji picker", 10, () => openEmojiPicker($("chat-input"), () => {}, null), { before: () => closePopovers() });
  closePopovers();
  openEmojiPicker($("chat-input"), () => {}, null);
  await measure("type a search in the emoji picker", 8, (i) => renderPickerBody(document.querySelector("#emoji-picker .picker-body"), "firework".slice(0, i + 1)));
  await measure("scroll through every emoji", 12, (i) => { const b = document.querySelector("#emoji-picker .picker-body"); b.scrollTop = (b.scrollHeight / 12) * (i + 1); b.dispatchEvent(new Event("scroll")); });
  closePopovers();

  // Typing in the message box: suggestions for :emoji: and @mentions.
  const input = $("chat-input");
  await measure("type :emoji: suggestions", 6, (i) => { input.value = ":fire".slice(0, i + 1) || ":"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await measure("type @mention suggestions", 4, (i) => { input.value = "@" + "elin".slice(0, i); input.dispatchEvent(new Event("input", { bubbles: true })); });
  input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true }));

  // A big member list.
  const big = [];
  for (let i = 0; i < 300; i++) big.push({ public_key: (i + 1000).toString(16).padStart(64, "0"), name: "Member " + i, role: null, joined_at: i, roles: [], status: i % 3 ? undefined : "online" });
  const r = structuredClone(state.roster); r.features = [...(r.features ?? []), "members"]; emit("roster", r);
  await measure("a 300-member list arrives", 5, () => emit("members", big), { grows: true });
  await measure("someone's status changes (whole list again)", 10, (i) => { big[i].status = big[i].status ? undefined : "idle"; emit("members", big); });

  // Settings, every tab.
  const tabs = [...document.querySelectorAll("#settings .settings-tab[data-tab]")].map((t) => t.dataset.tab);
  await measure("open settings and go through the tabs", tabs.length, (i) => openSettings(tabs[i]));
  $("settings").close?.();

  // Friends and DMs.
  await measure("go to Friends and back", 10, (i) => (i % 2 ? document.querySelector("#server-list .rail-item")?.click() : document.querySelector(".rail-item.home")?.click()));

  } catch (e) {
    window.__lastError = (stressRows.at(-1)?.name ?? "start") + " → next scenario: " + e.message;
  }
  window.stressResults = stressRows;
})();
`;
writeFileSync(join(work, "setup.js"), scenarios);
writeFileSync(join(work, "page.html"), readFileSync(join(here, "..", "src", "index.html"), "utf8").replace('<script src="main.js"></script>', '<script src="mock.js"></script><script src="main.js"></script><script src="setup.js"></script>'));

const cleanUp = () => {
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -like '*hopp-stress*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], { stdio: "ignore" });
  } catch {
    // Nothing to end.
  }
};
cleanUp();
const port = 9300 + Math.floor(Math.random() * 500);
const browser = spawn(edge, ["--headless=new", "--mute-audio", "--allow-file-access-from-files", `--user-data-dir=${join(work, "profile")}`, "--window-size=1366,768", `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
try {
  let target = null;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(pathToFileURL(join(work, "page.html")).href)}`, { method: "PUT" }).then((r) => r.json()).catch(() => null);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const send = (method, params = {}) => new Promise((done) => {
    const mine = ++id;
    const on = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id !== mine) return;
      ws.removeEventListener("message", on);
      done(msg.result);
    };
    ws.addEventListener("message", on);
    ws.send(JSON.stringify({ id: mine, method, params }));
  });
  let results = null;
  for (let i = 0; i < 360 && !results; i++) {
    await sleep(500);
    const r = await send("Runtime.evaluate", { expression: "JSON.stringify(window.stressResults ?? null)", returnByValue: true });
    results = JSON.parse(r?.result?.value ?? "null");
  }
  const err = await send("Runtime.evaluate", { expression: "String(window.__lastError ?? '')", returnByValue: true });
  if (err?.result?.value) { console.log("FAIL a scenario crashed: " + err.result.value); failed = true; }
  if (!results) {
    const at = await send("Runtime.evaluate", { expression: "String(window.__stressAt ?? 'before the first scenario')", returnByValue: true });
    console.log("FAIL the stress run didn't finish; it was at: " + at?.result?.value);
    const d = await send("Runtime.evaluate", { expression: "JSON.stringify({ ready: document.readyState, inServer: typeof inServer, rail: document.querySelectorAll('#server-list .rail-item').length, locked: document.getElementById('shell')?.className, msgs: document.querySelectorAll('#messages .msg').length, err: window.__lastError ?? null, url: location.href })", returnByValue: true });
    console.log("     page: " + d?.result?.value);
    failed = true;
  } else {
    for (const r of results) {
      const slow = r.max > r.limit;
      // Doing the same thing again and again shouldn't keep adding to the page.
      const grows = !r.mayGrow && r.times > 4 && r.grew > 2000;
      if (slow || grows) failed = true;
      console.log(`${slow || grows ? "SLOW" : "ok  "} ${r.name.padEnd(48)} avg ${r.avg.toFixed(1).padStart(6)} ms  worst ${r.max.toFixed(1).padStart(6)} ms  (x${r.times})${grows ? `  page grew by ${r.grew} elements` : ""}`);
    }
  }
  ws.close();
} finally {
  browser.kill();
  cleanUp();
}
process.exit(failed ? 1 : 0);
