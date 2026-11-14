// Sends this version's Store package (HoppChat) to the Microsoft Store and submits it for
// certification, with Microsoft's own command-line tool (msstore). Run by `npm run deploy` in
// cloud/ after the website and updater; it never stops the deploy: when the tool isn't set up,
// the package isn't built, this version was already sent, or a submission is still being
// certified, it says so and carries on.
//
// One-time setup (Partner Center: Account settings, User management, Microsoft Entra applications):
//   1. winget install "Microsoft Store Developer CLI"
//   2. msstore reconfigure --tenantId <..> --sellerId <..> --clientId <..> --clientSecret <..>
//      (the secret stays in Windows' credential store, never in this repo)

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STORE_ID = "9MW46LXNB9X6";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(readFileSync(join(root, "client", "src-tauri", "tauri.conf.json"), "utf8"));
const version = conf.version.split(".").concat(["0", "0", "0"]).slice(0, 3).join(".") + ".0";
const target = process.env.CARGO_TARGET_DIR ?? join(root, "target-release");
const msix = join(target, "msix", `HoppChat_${version}_x64.msix`);
const sentFile = join(target, "msix", "last-sent.txt");
const say = (text) => console.log("Microsoft Store: " + text);

const tool = spawnSync("msstore", ["--version"], { encoding: "utf8", shell: true });
if (tool.status !== 0) {
  say("skipped (the msstore tool isn't installed; see tools/publish-store.mjs).");
  process.exit(0);
}
if (!existsSync(msix)) {
  say(`skipped (no package for ${version}: run node tools/make-msix.mjs after building).`);
  process.exit(0);
}
if (existsSync(sentFile) && readFileSync(sentFile, "utf8").trim() === version) {
  say(`${version} was already sent.`);
  process.exit(0);
}
// msstore wants a folder holding the package.
const folder = join(target, "msix", "to-store");
rmSync(folder, { recursive: true, force: true });
mkdirSync(folder, { recursive: true });
copyFileSync(msix, join(folder, `HoppChat_${version}_x64.msix`));
try {
  execFileSync("msstore", ["publish", folder, "-id", STORE_ID], { stdio: "inherit", shell: true });
  writeFileSync(sentFile, version);
  say(`${version} sent for certification. Everyone with HoppChat gets it automatically once Microsoft approves it.`);
} catch {
  say(`couldn't send ${version} (often: the last version is still being certified). Run it again later with: node tools/publish-store.mjs`);
}
