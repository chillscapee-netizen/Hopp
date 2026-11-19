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

/** The H on a 100 × 100 grid, `color` filled. The shine is cut out of it: `shine` black lets
 *  what's behind show right through, a light grey only tints it, and null leaves it out. */
export function mark(color, id = "hopp-shine", shine = "#000") {
  if (!shine) return `<g transform="translate(4 0) skewX(-9)" fill="${color}"><rect x="12" y="6" width="31" height="80" rx="15.5"/><rect x="56" y="16" width="29" height="76" rx="14.5"/><rect x="30" y="34" width="40" height="24" rx="12"/></g>`;
  return (
    `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="-10" y="-10" width="120" height="120">` +
    `<rect x="-10" y="-10" width="120" height="120" fill="#fff"/>` +
    `<path d="M21 20 C 19 28, 19 36, 20 42" stroke="${shine}" stroke-width="5" stroke-linecap="round" fill="none"/>` +
    `<circle cx="20.5" cy="50" r="2.6" fill="${shine}"/></mask></defs>` +
    `<g transform="translate(4 0) skewX(-9)" fill="${color}" mask="url(#${id})">` +
    `<rect x="12" y="6" width="31" height="80" rx="15.5"/><rect x="56" y="16" width="29" height="76" rx="14.5"/><rect x="30" y="34" width="40" height="24" rx="12"/></g>`
  );
}

/** Hopp's colours: a strong red top left turning to a deep blue bottom right. */
const brand = `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e3263f"/><stop offset=".55" stop-color="#9b1f6e"/><stop offset="1" stop-color="#2346c8"/></linearGradient>`;

/** The app icon: the white H on a rounded square in Hopp's colours, its shine a soft glint (cut
 *  right through, it reads as a red mark on a white letter). */
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs>${brand}</defs><rect width="1024" height="1024" rx="232" fill="url(#bg)"/><rect x="6" y="6" width="1012" height="1012" rx="226" fill="none" stroke="#fff" stroke-opacity=".08" stroke-width="12"/><g transform="translate(236 222) scale(6)">${mark("#fff", "hopp-shine", "#d8d8d8")}</g></svg>`;
/** Small icons (the taskbar, the Start menu): no shine, which would only be speckles there, and a
 *  slightly bigger H so it still reads at 16 pixels. */
const smallIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs>${brand}</defs><rect width="1024" height="1024" rx="232" fill="url(#bg)"/><g transform="translate(196 182) scale(6.8)">${mark("#fff", "hopp-shine", null)}</g></svg>`;
const siteLogo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs>${brand}</defs><rect width="1024" height="1024" rx="230" fill="url(#bg)"/><g transform="translate(236 222) scale(6)">${mark("#fff", "hopp-shine", "#d8d8d8")}</g></svg>`;

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
  execFileSync(edge, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${join(work, "profile")}`, `--window-size=${w},${h}`, "--force-device-scale-factor=1", ...(transparent ? ["--default-background-color=00000000"] : []), `--screenshot=${out}`, pathToFileURL(page).href], { stdio: "ignore" });
  return out;
};

// The app's icons, every size, from a large transparent drawing.
const big = shoot("icon", `<img src="data:image/svg+xml;base64,${Buffer.from(appIcon).toString("base64")}" width="1024" height="1024" style="display:block">`, 1024, 1024, true);
execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["tauri", "icon", big], { cwd: join(root, "client"), stdio: "inherit", shell: process.platform === "win32" });

// The small sizes, each drawn at its own size (not shrunk from the big one), so they stay sharp:
// the app's own small pictures, the taskbar sizes for the Store package, and the .ico Windows uses.
const sizes = [16, 20, 24, 30, 32, 36, 40, 44, 48, 50, 64, 256];
let x = 0;
const placed = sizes.map((z) => {
  const at = x;
  x += z + 4;
  const svg = z <= 50 ? smallIcon : appIcon;
  return { z, at, img: `<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" width="${z}" height="${z}" style="position:absolute;left:${at}px;top:0">` };
});
const sheet = shoot("sheet", placed.map((p) => p.img).join(""), x, 256, true);
const small = join(work, "small");
mkdirSync(small, { recursive: true });
execFileSync("powershell.exe", ["-NoProfile", "-Command", `Add-Type -AssemblyName System.Drawing; $i=[System.Drawing.Image]::FromFile('${sheet}'); foreach($p in @(${placed.map((p) => `@(${p.z},${p.at})`).join(",")})){ $b=New-Object System.Drawing.Bitmap $p[0],$p[0],([System.Drawing.Imaging.PixelFormat]::Format32bppArgb); $g=[System.Drawing.Graphics]::FromImage($b); $g.DrawImage($i,(New-Object System.Drawing.Rectangle 0,0,$p[0],$p[0]),(New-Object System.Drawing.Rectangle $p[1],0,$p[0],$p[0]),[System.Drawing.GraphicsUnit]::Pixel); $b.Save('${small}/' + $p[0] + '.png',[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $b.Dispose() }; $i.Dispose()`], { stdio: "inherit" });
const png = (z) => readFileSync(join(small, z + ".png"));
const icons = join(root, "client/src-tauri/icons");
for (const [z, name] of [[30, "Square30x30Logo"], [32, "32x32"], [44, "Square44x44Logo"], [50, "StoreLogo"]]) writeFileSync(join(icons, name + ".png"), png(z));
mkdirSync(join(icons, "msix"), { recursive: true });
for (const z of [16, 20, 24, 30, 32, 36, 40, 44, 48, 64, 256]) writeFileSync(join(icons, "msix", `Square44x44Logo.targetsize-${z}_altform-unplated.png`), png(z));
// The .ico: pictures stored as PNG, which Windows reads at every size.
const ico = [16, 24, 32, 48, 64, 256];
const head = Buffer.alloc(6 + 16 * ico.length);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(ico.length, 4);
let offset = head.length;
ico.forEach((z, k) => {
  const o = 6 + 16 * k;
  head[o] = z % 256;
  head[o + 1] = z % 256;
  head.writeUInt16LE(1, o + 4);
  head.writeUInt16LE(32, o + 6);
  head.writeUInt32LE(png(z).length, o + 8);
  head.writeUInt32LE(offset, o + 12);
  offset += png(z).length;
});
writeFileSync(join(icons, "icon.ico"), Buffer.concat([head, ...ico.map(png)]));

// The installer: a sidebar (328 × 628) and a header (300 × 114), as 24-bit bitmaps.
const tile = (size) => `<img src="data:image/svg+xml;base64,${Buffer.from(appIcon).toString("base64")}" width="${size}" height="${size}" style="display:block">`;
const sidebar = shoot(
  "sidebar",
  `<div style="box-sizing:border-box;width:328px;height:628px;padding:72px 44px 0;background:radial-gradient(circle at 30% 18%,#4a1230,#1a1236 72%);font-family:'Segoe UI',sans-serif;color:#f2f2f4;position:relative">
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
console.log("Logo drawn: app icons (small ones drawn at their size), website logo, installer pictures.");
