// Measures what resizing the window costs: the page is resized 40 times in a row (like a
// drag) and the browser's own time for styles, layout and painting is read before and after.
//
//   node client/tests/resizeperf.mjs [setup.js]

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const work = join(tmpdir(), "hopp-resize");
const edge = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => {
  try { readFileSync(p); return true; } catch { return false; }
});
mkdirSync(work, { recursive: true });
cpSync(join(here, "..", "src"), work, { recursive: true });
copyFileSync(join(here, "mock.js"), join(work, "mock.js"));
const setup = process.argv[2] ? readFileSync(process.argv[2], "utf8") : "(async () => { await inServer(); window.shotReady = true; })();";
writeFileSync(join(work, "setup.js"), setup);
writeFileSync(join(work, "page.html"), readFileSync(join(here, "..", "src", "index.html"), "utf8").replace('<script src="main.js"></script>', '<script src="mock.js"></script><script src="main.js"></script><script src="setup.js"></script>'));
const cleanUp = () => {
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -like '*hopp-resize*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], { stdio: "ignore" });
  } catch {
    // Nothing to end.
  }
};
cleanUp();
const port = 9300 + Math.floor(Math.random() * 500);
const browser = spawn(edge, ["--headless=new", "--allow-file-access-from-files", `--user-data-dir=${join(work, "profile")}`, "--window-size=1366,768", `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  for (let i = 0; i < 120; i++) {
    const r = await send("Runtime.evaluate", { expression: "!!window.shotReady", returnByValue: true });
    if (r?.result?.value) break;
    await sleep(250);
  }
  await send("Performance.enable");
  const metrics = async () => Object.fromEntries((await send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  const before = await metrics();
  const t0 = Date.now();
  for (let i = 0; i < 40; i++) {
    const w = 1000 + Math.round(300 * Math.sin(i / 4));
    const h = 620 + Math.round(120 * Math.cos(i / 4));
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    // A frame, as a real drag gets.
    await send("Runtime.evaluate", { expression: "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))", awaitPromise: true });
  }
  const wall = Date.now() - t0;
  const after = await metrics();
  const d = (k) => ((after[k] - before[k]) * 1000).toFixed(0);
  console.log(`40 resizes in ${wall} ms (${(wall / 40).toFixed(1)} ms each)`);
  console.log(`  styles ${d("RecalcStyleDuration")} ms, layout ${d("LayoutDuration")} ms, scripts ${d("ScriptDuration")} ms, tasks ${d("TaskDuration")} ms`);
  console.log(`  layouts ${after.LayoutCount - before.LayoutCount}, style recalcs ${after.RecalcStyleCount - before.RecalcStyleCount}, DOM nodes ${after.Nodes}`);
  ws.close();
} finally {
  browser.kill();
  cleanUp();
}
