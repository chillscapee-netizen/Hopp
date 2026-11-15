// Holds the server people run on their own computers to Hopp Cloud's behaviour: runs Hopp
// Cloud's own tests against it (through a test server that looks like the cloud from outside).
//
//   node tools/parity.mjs

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = 8790;
const built = spawnSync("cargo", ["build", "-q", "-p", "strom-server", "--example", "cloudlike"], { cwd: root, stdio: "inherit", shell: true });
if (built.status !== 0) process.exit(built.status ?? 1);
const exe = join(root, "target", "debug", "examples", process.platform === "win32" ? "cloudlike.exe" : "cloudlike");
const server = spawn(exe, [String(port)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const tests = spawnSync(process.execPath, ["--test", "test/cloud.test.mjs"], {
  cwd: join(root, "cloud"),
  stdio: "inherit",
  env: { ...process.env, STROM_CLOUD_URL: `ws://127.0.0.1:${port}` },
});
server.kill();
process.exit(tests.status ?? 1);
