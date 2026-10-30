// Puts the newest Windows installer where the cloud serves it: /download/Hopp-setup.exe.
// Build it first with `npx tauri build` in client/.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const bundles = new URL("../../target/release/bundle/nsis/", import.meta.url);
const out = new URL("../public/download/", import.meta.url);
const setups = existsSync(bundles) ? readdirSync(bundles).filter((f) => f.endsWith("-setup.exe")) : [];
if (!setups.length) {
  console.warn("No installer found in target/release/bundle/nsis; the download link keeps the last one deployed.");
} else {
  const newest = setups.map((f) => join(bundles.pathname.replace(/^\/([A-Z]:)/, "$1"), f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  mkdirSync(out, { recursive: true });
  copyFileSync(newest, new URL("Hopp-setup.exe", out));
  console.log("Installer ready for the download link:", newest);
}
