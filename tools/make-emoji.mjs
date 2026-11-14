// Builds the emoji set the app ships: Twemoji's pictures (client/src/emoji/*.svg) and the
// picker's list with names, search words, groups and skin tones (client/src/emoji-list.js).
// Run after updating @twemoji/svg or emojibase-data:  node tools/make-emoji.mjs
//
// Twemoji graphics: Copyright 2020 Twitter, Inc and other contributors, CC-BY 4.0
// (https://creativecommons.org/licenses/by/4.0/). Names and words: emojibase-data, MIT.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "client");
const svgDir = join(root, "node_modules", "@twemoji", "svg");
const outDir = join(root, "src", "emoji");
const data = JSON.parse(readFileSync(join(root, "node_modules", "emojibase-data", "en", "compact.json"), "utf8"));

/** Twemoji's file name for an emoji: its code points in hex, without FE0F unless it's a joined one. */
export function emojiFile(text) {
  const cps = [...text].map((c) => c.codePointAt(0).toString(16));
  return (text.includes("‍") ? cps : cps.filter((c) => c !== "fe0f")).join("-");
}

const have = new Set(readdirSync(svgDir).filter((f) => f.endsWith(".svg")).map((f) => f.slice(0, -4)));

// The words people already search with in Hopp (rofl, gg, lit…) stay findable.
const main = readFileSync(join(root, "src", "main.js"), "utf8");
const oldWords = new Map();
const oldBlock = main.match(/var EMOJI_GROUPS = \[([\s\S]*?)\n\];/);
if (oldBlock) {
  for (const [, list] of oldBlock[1].matchAll(/\["[^"]+", "([^"]+)"\]/g)) {
    for (const item of list.split("|")) {
      const [e, ...w] = item.split(" ");
      oldWords.set(emojiFile(e), w);
    }
  }
}

const GROUPS = { 0: "Smileys", 1: "People", 3: "Nature", 4: "Food", 5: "Travel", 6: "Activities", 7: "Objects", 8: "Symbols", 9: "Flags" };
const groups = new Map(Object.values(GROUPS).map((g) => [g, []]));
const skins = {};
const words = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").split(/\s+/).filter(Boolean);

for (const e of data.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9))) {
  const group = GROUPS[e.group];
  if (!group || !have.has(emojiFile(e.unicode))) continue;
  const w = [...new Set([...words(e.label), ...(e.tags ?? []).flatMap(words), ...(oldWords.get(emojiFile(e.unicode)) ?? [])])];
  // First word is its name, as typed between colons: :fire:, :thumbs_up:, :flag_sweden:.
  const name = words(e.label).join("_");
  groups.get(group).push(e.unicode + " " + [name, ...w.filter((x) => x !== name)].join(" "));
  // Five tones, lightest first, when Twemoji draws all of them.
  const tones = (e.skins ?? []).filter((s) => !Array.isArray(s.tone) && have.has(emojiFile(s.unicode))).sort((a, b) => a.tone - b.tone).map((s) => s.unicode);
  if (tones.length === 5) skins[e.unicode] = tones;
}

// Every picture Twemoji has (also tones and ones the list doesn't name), so pasted emojis show too.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const name of have) copyFileSync(join(svgDir, name + ".svg"), join(outDir, name + ".svg"));

const list = [...groups].filter(([, l]) => l.length).map(([g, l]) => [g, l.join("|")]);
writeFileSync(join(root, "src", "emoji-list.js"),
  "// Made by tools/make-emoji.mjs from emojibase-data (MIT); pictures are Twemoji (CC-BY 4.0).\n" +
  "window.EMOJI_LIST = " + JSON.stringify(list) + ";\n" +
  "window.EMOJI_SKINS = " + JSON.stringify(skins) + ";\n");
const count = list.reduce((n, [, l]) => n + l.split("|").length, 0);
console.log(`${have.size} pictures, ${count} emojis in the picker, ${Object.keys(skins).length} with skin tones`);
