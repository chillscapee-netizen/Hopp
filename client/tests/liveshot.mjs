// A screenshot taken live over Edge's debugging port, once the page says it's ready
// (window.shotReady = true), so real video and real timing show as they would.
//
//   node client/tests/liveshot.mjs setup.js out.png [width] [height]

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [setup, out, width = "1280", height = "800"] = process.argv.slice(2);
if (!setup || !out) throw new Error("usage: liveshot.mjs <setup.js> <out.png> [width] [height]");
const here = fileURLToPath(new URL(".", import.meta.url));
const work = join(tmpdir(), "hopp-live-shots");
const edge = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => {
  try { readFileSync(p); return true; } catch { return false; }
});
mkdirSync(work, { recursive: true });
cpSync(join(here, "..", "src"), work, { recursive: true });
copyFileSync(join(here, "mock.js"), join(work, "mock.js"));
copyFileSync(setup, join(work, "setup.js"));
const page = readFileSync(join(here, "..", "src", "index.html"), "utf8").replace('<script src="main.js"></script>', '<script src="mock.js"></script><script src="main.js"></script><script src="setup.js"></script>');
const file = join(work, "shot.html");
writeFileSync(file, page);

const cleanUp = () => {
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -like '*hopp-live-shots*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], { stdio: "ignore" });
  } catch {
    // Nothing to end.
  }
};
cleanUp();
const port = 9300 + Math.floor(Math.random() * 500);
const browser = spawn(edge, ["--headless=new", "--disable-gpu", "--mute-audio", "--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required", `--user-data-dir=${join(work, "profile")}`, `--window-size=${width},${height}`, `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let target = null;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(pathToFileURL(file).href)}`, { method: "PUT" }).then((r) => r.json()).catch(() => null);
  }
  if (!target) throw new Error("Edge didn't start");
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
  await send("Emulation.setDeviceMetricsOverride", { width: Number(width), height: Number(height), deviceScaleFactor: 1, mobile: false });
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const r = await send("Runtime.evaluate", { expression: "!!window.shotReady", returnByValue: true });
    if (r?.result?.value) break;
    await sleep(250);
  }
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(resolve(out), Buffer.from(shot.data, "base64"));
  console.log("saved", out);
  ws.close();
} finally {
  browser.kill();
  cleanUp();
}
