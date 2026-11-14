// Builds the emoji picker's sheets: one picture per group (and per skin tone for the groups
// with hands and people) holding all its emojis in a grid, 40 px each. The picker shows each
// emoji as its square of a sheet, so a whole group costs one small picture instead of
// hundreds, and memory stays the same however far you scroll.
//
//   node tools/make-emoji-sheets.mjs     (after make-emoji.mjs; writes client/src/emoji/sheets/
//                                         and client/src/emoji-sheets.js)

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TILE = 40;
const COLS = 16;
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "client");
const svgDir = join(root, "node_modules", "@twemoji", "svg");
const outDir = join(root, "src", "emoji", "sheets");
const { Resvg } = createRequire(join(root, "package.json"))("@resvg/resvg-js");

const listJs = readFileSync(join(root, "src", "emoji-list.js"), "utf8");
const groups = JSON.parse(listJs.match(/window\.EMOJI_LIST = (\[.*?\]);\n/s)[1]);
const skins = JSON.parse(listJs.match(/window\.EMOJI_SKINS = (\{.*?\});\n/s)[1]);

/** Twemoji's file name for an emoji (same rule as the app's emojiFile). */
function emojiFile(text) {
  const cps = [...text].map((c) => c.codePointAt(0).toString(16));
  return (text.includes("‍") ? cps : cps.filter((c) => c !== "fe0f")).join("-");
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const sheets = {};
const sprite = {};
const draw = (name, emojis) => {
  const rows = Math.ceil(emojis.length / COLS);
  const w = Math.min(emojis.length, COLS) * TILE;
  const h = rows * TILE;
  let body = "";
  emojis.forEach((e, i) => {
    const b64 = readFileSync(join(svgDir, emojiFile(e) + ".svg")).toString("base64");
    body += `<image x="${(i % COLS) * TILE}" y="${Math.floor(i / COLS) * TILE}" width="${TILE}" height="${TILE}" href="data:image/svg+xml;base64,${b64}"/>`;
    sprite[e] = [name, i];
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`;
  writeFileSync(join(outDir, name + ".png"), new Resvg(svg).render().asPng());
  sheets[name] = [w, h];
};

groups.forEach(([, list], g) => {
  const emojis = list.split("|").map((x) => x.split(" ")[0]);
  draw(`g${g}`, emojis);
  // The same group in each skin tone: only the emojis that come in tones.
  const toned = emojis.filter((e) => skins[e]);
  if (toned.length) for (let t = 0; t < 5; t++) draw(`g${g}t${t + 1}`, toned.map((e) => skins[e][t]));
});

writeFileSync(join(root, "src", "emoji-sheets.js"),
  "// Made by tools/make-emoji-sheets.mjs: where each emoji sits in the picker's sheets.\n" +
  `window.EMOJI_SHEET = ${JSON.stringify({ tile: TILE, cols: COLS, sheets })};\n` +
  `window.EMOJI_SPRITE = ${JSON.stringify(sprite)};\n`);
console.log(`${Object.keys(sheets).length} sheets, ${Object.keys(sprite).length} emojis`);
