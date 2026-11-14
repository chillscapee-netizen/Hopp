// Memory when scrolling fast through the whole emoji picker: the page is opened, the picker
// scrolled to the bottom in quick steps, and the browser's memory (all its processes) read
// before and after. Emoji pictures should cost a few MB, not hundreds.
//
//   node client/tests/emojimem.mjs        (exits 1 above the limit)

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LIMIT_MB = 120;
const here = fileURLToPath(new URL(".", import.meta.url));
const work = join(tmpdir(), "hopp-emojimem");
const edge = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => {
  try { readFileSync(p); return true; } catch { return false; }
});
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
cpSync(join(here, "..", "src"), work, { recursive: true });
copyFileSync(join(here, "mock.js"), join(work, "mock.js"));
writeFileSync(join(work, "setup.js"), `
(async () => {
  await inServer();
  window.phase = "ready";
  while (window.phase !== "go") await wait(100);
  openEmojiPicker($("chat-input"), () => {}, null);
  const body = document.querySelector("#emoji-picker .picker-body");
  for (let i = 1; i <= 60; i++) {
    body.scrollTop = (body.scrollHeight / 60) * i;
    body.dispatchEvent(new Event("scroll"));
    await wait(40);
  }
  await wait(3000);
  window.phase = "scrolled:" + document.querySelectorAll("#emoji-picker img.emoji").length;
})();`);
writeFileSync(join(work, "page.html"), readFileSync(join(here, "..", "src", "index.html"), "utf8").replace('<script src="main.js"></script>', '<script src="mock.js"></script><script src="main.js"></script><script src="setup.js"></script>'));

const memory = () => {
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -like '*hopp-emojimem*' } | ForEach-Object { (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).PrivateMemorySize64 } | Measure-Object -Sum).Sum"], { encoding: "utf8" });
  return Number(out.trim()) / 1048576;
};
const cleanUp = () => {
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -like '*hopp-emojimem*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], { stdio: "ignore" });
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
  const cdp = (method, params = {}) => new Promise((done) => {
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
  const settled = async () => {
    await cdp("HeapProfiler.collectGarbage");
    await sleep(3000);
    await cdp("HeapProfiler.collectGarbage");
    await sleep(1000);
    return memory();
  };
  const run = (expression) => new Promise((done) => {
    const mine = ++id;
    const on = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id !== mine) return;
      ws.removeEventListener("message", on);
      done(msg.result?.result?.value);
    };
    ws.addEventListener("message", on);
    ws.send(JSON.stringify({ id: mine, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });
  for (let i = 0; i < 120 && (await run("window.phase")) !== "ready"; i++) await sleep(250);
  const before = await settled();
  await run("window.phase = 'go'");
  let phase = "";
  for (let i = 0; i < 120 && !String(phase).startsWith("scrolled"); i++) {
    await sleep(500);
    phase = await run("window.phase");
  }
  const after = await settled();
  const grew = after - before;
  failed = grew > LIMIT_MB;
  console.log(`${failed ? "FAIL" : "ok  "} scrolling through every emoji: memory ${before.toFixed(0)} → ${after.toFixed(0)} MB (+${grew.toFixed(0)} MB, limit ${LIMIT_MB}); ${String(phase).split(":")[1]} emoji pictures drawn`);
  ws.close();
} finally {
  browser.kill();
  cleanUp();
}
process.exit(failed ? 1 : 0);
