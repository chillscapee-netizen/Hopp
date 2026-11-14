// Packs the release build of Hopp as an MSIX for the Microsoft Store.
//
//   1. Build as usual (npx tauri build, with CARGO_TARGET_DIR=target-release).
//   2. node tools/make-msix.mjs        → target-release/msix/HoppChat_<version>_x64.msix
//   3. Upload that file in Partner Center (HoppChat → Submit your product → Packages).
//
// The Store signs the package itself, so this one stays unsigned. The same Hopp runs either way;
// inside the package it notices (store.rs) and leaves updates and "start with Windows" to Windows.
//
//   --register   instead installs the unpacked folder for a test (needs Windows' developer mode).

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(readFileSync(join(root, "client", "src-tauri", "tauri.conf.json"), "utf8"));
const target = process.env.CARGO_TARGET_DIR ?? join(root, "target-release");
const exe = join(target, "release", "strom-client.exe");
if (!existsSync(exe)) throw new Error("No release build at " + exe + " (build first).");

// The identity Partner Center gave HoppChat (Product management → Product identity).
const IDENTITY = {
  name: "Hopp.HoppChat",
  publisher: "CN=48A6767A-D373-48A2-A4C4-BD5CF529093B",
  publisherDisplayName: "Hopp",
  displayName: "HoppChat",
};
// The Store wants four numbers, the last one 0.
const version = conf.version.split(".").concat(["0", "0", "0"]).slice(0, 3).join(".") + ".0";

const out = join(target, "msix");
// A test install runs straight from its folder (and keeps it in use), so it gets its own.
const layout = join(out, process.argv.includes("--register") ? "test-install" : "package");
rmSync(layout, { recursive: true, force: true });
mkdirSync(join(layout, "Assets"), { recursive: true });
copyFileSync(exe, join(layout, "Hopp.exe"));

const icons = join(root, "client", "src-tauri", "icons");
for (const f of ["Square44x44Logo.png", "Square71x71Logo.png", "Square150x150Logo.png", "Square310x310Logo.png", "StoreLogo.png"]) {
  copyFileSync(join(icons, f), join(layout, "Assets", f));
}
// The taskbar and Start list use the small one without a plate behind it.
for (const size of [44]) copyFileSync(join(icons, "Square44x44Logo.png"), join(layout, "Assets", `Square44x44Logo.targetsize-${size}_altform-unplated.png`));

const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const protocols = conf.plugins["deep-link"].desktop.schemes
  .map((p) => `        <uap:Extension Category="windows.protocol">
          <uap:Protocol Name="${xml(p)}"><uap:DisplayName>Hopp invite</uap:DisplayName></uap:Protocol>
        </uap:Extension>`)
  .join("\n");

writeFileSync(join(layout, "AppxManifest.xml"), `<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:desktop="http://schemas.microsoft.com/appx/manifest/desktop/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap desktop rescap">
  <Identity Name="${IDENTITY.name}" Publisher="${IDENTITY.publisher}" Version="${version}" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>${xml(IDENTITY.displayName)}</DisplayName>
    <PublisherDisplayName>${xml(IDENTITY.publisherDisplayName)}</PublisherDisplayName>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Applications>
    <Application Id="Hopp" Executable="Hopp.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements
        DisplayName="${xml(IDENTITY.displayName)}"
        Description="Voice, video and chat for you and your friends. Free, with no ads and no tracking."
        BackgroundColor="transparent"
        Square150x150Logo="Assets\\Square150x150Logo.png"
        Square44x44Logo="Assets\\Square44x44Logo.png">
        <uap:DefaultTile Square71x71Logo="Assets\\Square71x71Logo.png" />
      </uap:VisualElements>
      <Extensions>
${protocols}
        <desktop:Extension Category="windows.startupTask" Executable="Hopp.exe" EntryPoint="Windows.FullTrustApplication">
          <desktop:StartupTask TaskId="HoppStartup" Enabled="false" DisplayName="Hopp" />
        </desktop:Extension>
      </Extensions>
    </Application>
  </Applications>
  <Capabilities>
    <Capability Name="internetClient" />
    <Capability Name="internetClientServer" />
    <Capability Name="privateNetworkClientServer" />
    <rescap:Capability Name="runFullTrust" />
    <DeviceCapability Name="microphone" />
    <DeviceCapability Name="webcam" />
  </Capabilities>
</Package>
`);

if (process.argv.includes("--register")) {
  execFileSync("powershell.exe", ["-NoProfile", "-Command", `Add-AppxPackage -Register '${join(layout, "AppxManifest.xml")}'`], { stdio: "inherit" });
  console.log("Installed for testing: find HoppChat in the Start menu.");
  process.exit(0);
}

// makeappx from the newest Windows SDK on this computer.
const kits = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
const sdk = readdirSync(kits).filter((d) => /^10\./.test(d)).sort().reverse().find((d) => existsSync(join(kits, d, "x64", "makeappx.exe")));
if (!sdk) throw new Error("makeappx.exe not found: install the Windows SDK.");
const file = join(out, `HoppChat_${version}_x64.msix`);
execFileSync(join(kits, sdk, "x64", "makeappx.exe"), ["pack", "/d", layout, "/p", file, "/o"], { stdio: "inherit" });
console.log("\nReady for the Store: " + file);
