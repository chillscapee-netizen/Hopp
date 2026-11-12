// Draws Hopp's logo everywhere it's used, from one drawing: the app's icons, the website's
// logo, and the installer's sidebar and header pictures.
//
//   node tools/make-logo.mjs
//
// The mark: a throw-up style H (fat, leaning forward, legs of uneven height) with a shine cut
// out of its left leg. Needs Microsoft Edge (for drawing) and runs `tauri icon` for the app.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const work = join(tmpdir(), "hopp-logo");
mkdirSync(work, { recursive: true });

/** The H on a 100 × 100 grid, `color` filled, the shine cut so what's behind shows through. */
export function mark(color, id = "hopp-shine") {
  return (
    `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="-10" y="-10" width="120" height="120">` +
    `<rect x="-10" y="-10" width="120" height="120" fill="#fff"/>` +
    `<path d="M21 20 C 19 28, 19 36, 20 42" stroke="#000" stroke-width="5" stroke-linecap="round" fill="none"/>` +
    `<circle cx="20.5" cy="50" r="2.6" fill="#000"/></mask></defs>` +
    `<g transform="translate(4 0) skewX(-9)" fill="${color}" mask="url(#${id})">` +
    `<rect x="12" y="6" width="31" height="80" rx="15.5"/><rect x="56" y="16" width="29" height="76" rx="14.5"/><rect x="30" y="34" width="40" height="24" rx="12"/></g>`
  );
}

/** The app icon: the white H on a dark rounded square. */
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2e2e33"/><stop offset="1" stop-color="#18181b"/></linearGradient></defs><rect width="1024" height="1024" rx="232" fill="url(#bg)"/><rect x="6" y="6" width="1012" height="1012" rx="226" fill="none" stroke="#fff" stroke-opacity=".08" stroke-width="12"/><g transform="translate(236 222) scale(6)">${mark("#fff")}</g></svg>`;
const siteLogo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect width="1024" height="1024" rx="230" fill="#2a2d31"/><g transform="translate(236 222) scale(6)">${mark("#f2f2f4")}</g></svg>`;

writeFileSync(join(root, "client/src-tauri/icons/hopp.svg"), appIcon);
writeFileSync(join(root, "cloud/public/site/logo.svg"), siteLogo);

const edge = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
});
const shoot = (name, html, w, h, transparent = false) => {
  const page = join(work, name + ".html");
  writeFileSync(page, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;${transparent ? "background:transparent" : ""}}</style>${html}`);
  const out = join(work, name + ".png");
  execFileSync(edge, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${join(work, "profile")}`, `--window-size=${w},${h}`, ...(transparent ? ["--default-background-color=00000000"] : []), `--screenshot=${out}`, pathToFileURL(page).href], { stdio: "ignore" });
  return out;
};

// The app's icons, every size, from a large transparent drawing.
const big = shoot("icon", `<img src="data:image/svg+xml;base64,${Buffer.from(appIcon).toString("base64")}" width="1024" height="1024" style="display:block">`, 1024, 1024, true);
execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["tauri", "icon", big], { cwd: join(root, "client"), stdio: "inherit", shell: process.platform === "win32" });

// The installer: a sidebar (328 × 628) and a header (300 × 114), as 24-bit bitmaps.
const tile = (size) => `<img src="data:image/svg+xml;base64,${Buffer.from(appIcon).toString("base64")}" width="${size}" height="${size}" style="display:block">`;
const sidebar = shoot(
  "sidebar",
  `<div style="box-sizing:border-box;width:328px;height:628px;padding:72px 44px 0;background:radial-gradient(circle at 30% 18%,#2c2c31,#19191c 70%);font-family:'Segoe UI',sans-serif;color:#f2f2f4;position:relative">
    ${tile(96)}
    <div style="margin-top:28px;font-size:48px;font-weight:700;letter-spacing:-1px">Hopp</div>
    <div style="margin-top:8px;font-size:21px;line-height:1.45;color:#c9c9d0">Voice and chat for you and your friends.</div>
    <div style="position:absolute;left:44px;bottom:40px;font-size:16px;line-height:1.7;color:#9a9aa3"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#3ccf8e;margin-right:9px"></span>Free · no ads<br>Private messages stay private</div>
  </div>`,
  328,
  628,
);
const header = shoot("header", `<div style="width:300px;height:114px;background:#fff;display:flex;justify-content:flex-end;align-items:center;padding-right:30px;box-sizing:border-box">${tile(70)}</div>`, 300, 114);
for (const [png, bmp] of [[sidebar, "sidebar.bmp"], [header, "header.bmp"]]) {
  const dest = join(root, "client/src-tauri/installer", bmp);
  execFileSync("powershell.exe", ["-NoProfile", "-Command", `Add-Type -AssemblyName System.Drawing; $i=[System.Drawing.Image]::FromFile('${png}'); $b=New-Object System.Drawing.Bitmap $i.Width,$i.Height,([System.Drawing.Imaging.PixelFormat]::Format24bppRgb); $g=[System.Drawing.Graphics]::FromImage($b); $g.DrawImage($i,0,0,$i.Width,$i.Height); $b.Save('${dest}',[System.Drawing.Imaging.ImageFormat]::Bmp); $g.Dispose(); $b.Dispose(); $i.Dispose()`], { stdio: "inherit" });
}
console.log("Logo drawn: app icons, website logo, installer pictures.");
