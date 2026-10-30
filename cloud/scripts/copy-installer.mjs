// Puts the newest Windows release where Hopp Cloud serves it:
//   /download/Hopp-setup.exe        the installer behind every invite link
//   /download/Hopp_<version>_x64-setup.exe and /update/latest.json   for automatic updates
// Build first (in client/) with the signing key set:
//   TAURI_SIGNING_PRIVATE_KEY=<path to hopp-updater.key> npx tauri build
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const CLOUD = "https://hopp-cloud.hoppchat.workers.dev";
const dir = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const bundles = dir("../../target/release/bundle/nsis/");
const download = dir("../public/download/");
const update = dir("../public/update/");
const { version } = JSON.parse(readFileSync(dir("../../client/src-tauri/tauri.conf.json"), "utf8"));

const name = `Hopp_${version}_x64-setup.exe`;
const setup = join(bundles, name);
if (!existsSync(setup)) {
  console.warn(`No ${name} in target/release/bundle/nsis; the cloud keeps the release it already has.`);
  process.exit(0);
}
mkdirSync(download, { recursive: true });
mkdirSync(update, { recursive: true });
copyFileSync(setup, join(download, "Hopp-setup.exe"));
copyFileSync(setup, join(download, name));
const sig = setup + ".sig";
if (existsSync(sig)) {
  writeFileSync(join(update, "latest.json"), JSON.stringify({
    version,
    notes: "A new version of Hopp.",
    pub_date: new Date(statSync(setup).mtimeMs).toISOString(),
    platforms: { "windows-x86_64": { signature: readFileSync(sig, "utf8").trim(), url: `${CLOUD}/download/${name}` } },
  }, null, 2));
  console.log(`Release ${version} ready: installer and update.`);
} else {
  console.warn("The installer isn't signed (no .sig), so it's not offered as an update. Build with TAURI_SIGNING_PRIVATE_KEY set.");
}
// Old installers aren't needed once a newer one is out.
for (const f of readdirSync(download)) if (/^Hopp_.*-setup\.exe$/.test(f) && f !== name) console.log("old installer kept:", f);
