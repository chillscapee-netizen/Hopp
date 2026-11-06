// Runs the page tests in headless Edge: each *.test.js in this folder runs on its
// own copy of the app's page, with mock.js standing in for Tauri.
//
//   node client/tests/run.mjs            all tests
//   node client/tests/run.mjs smoke      tests whose name contains "smoke"

import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const src = join(here, "..", "src");
const work = join(tmpdir(), "hopp-page-tests");
const edge = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
});
if (!edge) throw new Error("Microsoft Edge not found");

mkdirSync(work, { recursive: true });
cpSync(src, work, { recursive: true });
copyFileSync(join(here, "mock.js"), join(work, "mock.js"));
const page = readFileSync(join(src, "index.html"), "utf8");

// Two functions with one name: the later one silently replaces the earlier everywhere.
const declared = new Map();
for (const [, name] of readFileSync(join(src, "main.js"), "utf8").matchAll(/^(?:async )?function (\w+)/gm)) declared.set(name, (declared.get(name) ?? 0) + 1);
for (const [, name] of readFileSync(join(src, "style.css"), "utf8").matchAll(/@keyframes ([\w-]+)/g)) declared.set("@keyframes " + name, (declared.get("@keyframes " + name) ?? 0) + 1);
const twice = [...declared].filter(([, n]) => n > 1).map(([name]) => name);
if (twice.length) {
  console.log("FAIL declared twice (main.js functions or style.css animations): " + twice.join(", "));
  process.exit(1);
}

// The lint runs first: names used but never defined, defined twice, dead code.
try {
  execFileSync(process.execPath, [join(here, "..", "node_modules", "eslint", "bin", "eslint.js"), "--max-warnings", "0", "."], { cwd: join(here, ".."), stdio: "pipe" });
} catch (e) {
  console.log("FAIL lint (npm run lint in client/):\n" + String(e.stdout ?? e));
  process.exit(1);
}

// Some Edge builds (e.g. while an update waits for a restart) print nothing with --dump-dom.
// Then every test runs live over the debugging port (slower, in real time).
const probeFile = join(work, "probe.html");
writeFileSync(probeFile, "<html><body>probe-ok</body></html>");
let dumpWorks = false;
try {
  dumpWorks = execFileSync(edge, ["--headless=new", "--disable-gpu", `--user-data-dir=${join(work, "profile-probe")}`, "--dump-dom", pathToFileURL(probeFile).href], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000 }).includes("probe-ok");
} catch (e) {
  dumpWorks = String(e.stdout ?? "").includes("probe-ok");
}
if (!dumpWorks) console.log("(Edge prints no pages here: running every test live)");
const filter = process.argv[2] ?? "";
const tests = readdirSync(here).filter((f) => f.endsWith(".test.js") && f.includes(filter));
let failed = 0;
for (const test of tests) {
  copyFileSync(join(here, test), join(work, test));
  const html = page.replace('<script src="main.js"></script>', `<script src="mock.js"></script><script src="main.js"></script><script src="${test}"></script>`);
  const file = join(work, test.replace(".test.js", ".html"));
  writeFileSync(file, html);
  // A test that needs longer (decoding big pictures uses virtual time) says "// virtual-time: <ms>".
  const source = readFileSync(join(here, test), "utf8");
  const budget = source.match(/\/\/ virtual-time: (\d+)/)?.[1] ?? "30000";
  // Networking (WebRTC) needs the real clock: "// real-time: <ms>" runs it live and waits
  // up to that long for the results.
  const real = source.match(/\/\/ real-time: (\d+)/)?.[1];
  let dom;
  if (real || !dumpWorks) dom = await runLive(file, test, Number(real ?? budget) + (real ? 0 : 15000));
  else {
    try {
      dom = execFileSync(edge, ["--headless=new", "--disable-gpu", "--allow-file-access-from-files", `--user-data-dir=${join(work, "profile-" + test)}`, "--window-size=1280,800", `--virtual-time-budget=${budget}`, "--dump-dom", pathToFileURL(file).href], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    } catch (e) {
      // Edge sometimes exits with an error after printing the page; use what it printed.
      dom = String(e.stdout ?? "");
    }
  }
  const m = dom.match(/<pre id="test-results">([\s\S]*?)<\/pre>/);
  const lines = m ? m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").split("\n") : ["FAIL the test never reported (it crashed or took too long)"];
  console.log(`\n${test}`);
  for (const line of lines) {
    console.log("  " + line);
    if (line.startsWith("FAIL")) failed++;
  }
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);

/** Runs a page in real time through Edge's debugging port; returns its results block. */
/** Ends headless Edge processes this runner started (an updating Edge restarts itself in a new
 *  process that kill() never reaches; left over, they slow every later test). */
function cleanUp() {
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'msedge.exe' -and $_.CommandLine -like '*hopp-page-tests*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], { stdio: "ignore" });
  } catch {
    // Nothing to end.
  }
}

async function runLive(file, test, timeoutMs) {
  cleanUp();
  const port = 9300 + Math.floor(Math.random() * 500);
  const browser = spawn(edge, ["--headless=new", "--disable-gpu", "--allow-file-access-from-files", `--user-data-dir=${join(work, "live-" + test)}`, "--window-size=1280,800", `--remote-debugging-port=${port}`, "about:blank"], { stdio: "ignore" });
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
    const evaluate = (expression) =>
      new Promise((resolve) => {
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
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const html = await evaluate("document.getElementById('test-results')?.outerHTML ?? null");
      if (html) {
        ws.close();
        return html;
      }
      await sleep(300);
    }
    ws.close();
    return "";
  } finally {
    browser.kill();
    cleanUp();
  }
}
