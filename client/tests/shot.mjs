// Takes a screenshot of the app's page after a setup script, to look at a change.
//
//   node client/tests/shot.mjs <setup.js> <out.png> [width] [height]
//
// The setup script runs after main.js, with mock.js standing in for Tauri.

import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [setup, out, width = "1280", height = "800"] = process.argv.slice(2);
if (!setup || !out) throw new Error("usage: shot.mjs <setup.js> <out.png> [width] [height]");
const here = fileURLToPath(new URL(".", import.meta.url));
const work = join(tmpdir(), "hopp-page-shots");
const edge = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
});
mkdirSync(work, { recursive: true });
cpSync(join(here, "..", "src"), work, { recursive: true });
copyFileSync(join(here, "mock.js"), join(work, "mock.js"));
copyFileSync(setup, join(work, "setup.js"));
const page = readFileSync(join(here, "..", "src", "index.html"), "utf8").replace('<script src="main.js"></script>', '<script src="mock.js"></script><script src="main.js"></script><script src="setup.js"></script>');
const file = join(work, "shot.html");
writeFileSync(file, page);
try {
  execFileSync(edge, ["--headless=new", "--disable-gpu", "--allow-file-access-from-files", `--user-data-dir=${join(work, "profile")}`, `--window-size=${width},${height}`, "--virtual-time-budget=8000", `--screenshot=${resolve(out)}`, pathToFileURL(file).href], { stdio: "ignore" });
} catch {
  // Edge may exit with an error after writing the picture.
}
console.log("saved", basename(out));
