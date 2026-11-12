// Hopp's own emojis: a set for friends who play and hang out together (GG, clutch, salty,
// AFK, lag…), drawn here as SVG so they're sharp at any size and need no files. One look for
// all of them: glossy shaded faces with a bold dark outline and big expressive eyes. Written
// <:hopp_name:0> in messages (id 0 means "built into the app"), so they work in servers,
// DMs and reactions alike.

(() => {
  const OUT = "#22190f";
  const n = (v) => +v.toFixed(2);

  // Cel shading, like a drawn cartoon: a flat colour with one hard-edged shadow along the
  // bottom right (no soft airbrushed gradients).
  const cel = (id, light, dark, cut = 0.76, cx = 0.36, cy = 0.3, r = 0.82) =>
    `<radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${r}"><stop offset="0" stop-color="${light}"/><stop offset="${cut}" stop-color="${light}"/><stop offset="${cut}" stop-color="${dark}"/><stop offset="1" stop-color="${dark}"/></radialGradient>`;
  const DEFS =
    "<defs>" +
    cel("f", "#ffd426", "#f0a10c") +
    cel("fr", "#ff5a36", "#d13017") +
    cel("w", "#ffffff", "#ddd6c8", 0.8, 0.38, 0.32, 0.75) +
    cel("m", "#4a140b", "#4a140b") +
    cel("t", "#ff7a6b", "#d9483c", 0.7, 0.45, 0.3) +
    cel("hr", "#ff3d5a", "#c41634", 0.72) +
    cel("tr", "#7fd0ff", "#3b97e6", 0.7) +
    cel("gs", "#2a2d36", "#15171c") +
    cel("gh", "#ffffff", "#c9cfdf", 0.78) +
    cel("st", "#ffc21f", "#ec8e00", 0.72) +
    cel("fl", "#ffb12e", "#f06a1c", 0.7, 0.5, 0.35) +
    "</defs>";
  const svg = (inside) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 68 68">${DEFS}${inside}</svg>`;

  // ---------- parts ----------
  const stroke = (d, w = 3.2, color = OUT, extra = "") =>
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;
  const shape = (d, fill, w = 2.4) => `<path d="${d}" fill="${fill}" stroke="${OUT}" stroke-width="${w}" stroke-linejoin="round"/>`;
  /** A hard white shine, tilted like a drawn one. */
  const gloss = (cx, cy, rx, ry) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#fff" opacity=".85" transform="rotate(-35 ${cx} ${cy})"/>`;
  const tag = (body) => body;
  // Not a perfect circle: a slightly lopsided, hand-drawn round.
  const FACE = "M32 5.5 C47.5 5 58.8 16.5 58.5 32 C58.2 47.8 47 58.8 31.5 58.5 C16 58.2 5.2 47 5.5 31.5 C5.8 16.5 16.8 6 32 5.5 Z";
  const face = (g = "f") =>
    `<path d="${FACE}" fill="url(#${g})" stroke="${OUT}" stroke-width="3.4" stroke-linejoin="round"/>` +
    `<path d="M12.5 25 C13.5 17 19.5 11.5 27 10.5 C29.5 10.3 30 13 28 13.8 C22.5 15.5 18.5 19.5 16.8 25.5 C16.2 27.6 12.3 27.4 12.5 25 Z" fill="#fff" opacity=".85"/>`;
  const blush = `<ellipse cx="13" cy="39" rx="4.5" ry="2.8" fill="#ff5a5a" opacity=".4"/><ellipse cx="51" cy="39" rx="4.5" ry="2.8" fill="#ff5a5a" opacity=".4"/>`;
  const text = (x, y, size, fill, words, extra = "") =>
    `<text x="${x}" y="${y}" font-family="Segoe UI, Inter, Arial, sans-serif" font-size="${size}" font-weight="900" fill="${fill}" text-anchor="middle" ${extra}>${words}</text>`;

  /** A big glossy eye, its pupil moved by (dx, dy). */
  const eye = (cx, cy, rx, ry, dx = 0, dy = 0, pr = 3.4) => {
    const px = cx + dx,
      py = cy + dy;
    return (
      `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#w)" stroke="${OUT}" stroke-width="2.2"/>` +
      `<circle cx="${n(px)}" cy="${n(py)}" r="${pr}" fill="${OUT}"/><circle cx="${n(px - pr * 0.35)}" cy="${n(py - pr * 0.4)}" r="${n(pr * 0.36)}" fill="#fff"/>`
    );
  };
  /** A half-closed eye: the lid covers its top half. */
  const lidded = (cx, cy, rx, ry, dx, dy, pr = 3) =>
    eye(cx, cy, rx, ry, dx, dy, pr) + shape(`M${cx - rx} ${cy} a${rx} ${ry} 0 0 1 ${rx * 2} 0 Z`, "#ffd426", 2.2);

  let clips = 0;
  /** An open mouth: dark inside, with whatever's inside (teeth, tongue) kept within it. */
  const mouth = (d, inner = "") => {
    const id = "c" + ++clips;
    return `<clipPath id="${id}"><path d="${d}"/></clipPath><path d="${d}" fill="url(#m)"/><g clip-path="url(#${id})">${inner}</g>` + stroke(d, 2.4);
  };
  const tongue = (cx, cy, rx, ry) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#t)"/>`;
  const teeth = (y, h) => `<rect x="0" y="${y}" width="64" height="${h}" fill="#fbf8f0"/>`;
  /** A D-shaped grin from x1 to x2 along y, `depth` deep. */
  const grin = (x1, x2, y, depth) => `M${x1} ${y} H${x2} A${(x2 - x1) / 2} ${depth} 0 0 1 ${x1} ${y} Z`;
  const oval = (cx, cy, rx, ry) => `M${cx - rx} ${cy} a${rx} ${ry} 0 1 0 ${rx * 2} 0 a${rx} ${ry} 0 1 0 ${-rx * 2} 0 Z`;
  const heart = (cx, cy, s) =>
    `M${cx} ${n(cy + s)} C${n(cx - s * 1.8)} ${n(cy - s * 0.2)} ${n(cx - s * 0.9)} ${n(cy - s * 1.4)} ${cx} ${n(cy - s * 0.45)} ` +
    `C${n(cx + s * 0.9)} ${n(cy - s * 1.4)} ${n(cx + s * 1.8)} ${n(cy - s * 0.2)} ${cx} ${n(cy + s)} Z`;
  const star = (cx, cy, R, r) => {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5,
        len = i % 2 ? r : R;
      pts.push(`${n(cx + Math.cos(a) * len)} ${n(cy + Math.sin(a) * len)}`);
    }
    return "M" + pts.join(" L") + " Z";
  };
  /** A drop with its point at (x, y). */
  const drop = (x, y, s) =>
    `M${x} ${y} C${n(x + s * 0.2)} ${n(y + s * 0.6)} ${n(x + s * 0.7)} ${n(y + s * 0.9)} ${n(x + s * 0.7)} ${n(y + s * 1.3)} ` +
    `A${n(s * 0.7)} ${n(s * 0.7)} 0 1 1 ${n(x - s * 0.7)} ${n(y + s * 1.3)} C${n(x - s * 0.7)} ${n(y + s * 0.9)} ${n(x - s * 0.2)} ${n(y + s * 0.6)} ${x} ${y} Z`;
  const spiral = (cx, cy) => stroke(`M${cx} ${cy} a1.5 1.5 0 0 1 3 0 a3 3 0 0 1 -6 0 a4.5 4.5 0 0 1 9 0`, 2);
  const happyEyes = stroke("M16 28 q6 -7 12 0") + stroke("M36 28 q6 -7 12 0");
  const squeezed = stroke("M16 23 l10 5 l-10 5") + stroke("M48 23 l-10 5 l10 5");
  const badge = (x, y, w, fill, words, size = 10) =>
    `<rect x="${x}" y="${y}" width="${w}" height="14" rx="7" fill="${fill}" stroke="${OUT}" stroke-width="2.4"/>` + text(x + w / 2, y + 10.6, size, "#ffffff", words);

  const EMOJIS = {
    // Good game: all smiles, with the two letters that end every good match.
    gg: svg(face() + happyEyes + blush + mouth(grin(17, 47, 37, 15), teeth(37, 5) + tongue(32, 51, 8, 5)) + badge(37, 47, 25, "#2fbf7f", "GG")),
    // Laughing so hard it hurts.
    lol: svg(
      `<g transform="rotate(-12 32 33)">` +
        face() +
        stroke("M15 26 q6 -6 12 0") +
        stroke("M37 26 q6 -6 12 0") +
        shape(drop(12, 29, 7), "url(#tr)", 1.8) +
        shape(drop(52, 29, 7), "url(#tr)", 1.8) +
        mouth(grin(16, 48, 36, 16), teeth(36, 5) + tongue(32, 51, 9, 5)) +
        "</g>",
    ),
    // Wait, what?!
    omg: svg(face() + stroke("M14 17 q7 -7 15 -2", 3.4) + stroke("M35 15 q8 -5 15 2", 3.4) + eye(23, 26, 7, 8.5, 1.5, 0.5) + eye(41, 26, 7, 8.5, 1.5, 0.5) + mouth(oval(32, 45, 7, 9), tongue(32, 53, 6, 4))),
    // Heart eyes.
    love: svg(
      face() +
        shape(heart(22, 28, 6), "url(#hr)", 2.2) +
        shape(heart(42, 28, 6), "url(#hr)", 2.2) +
        `<ellipse cx="18.5" cy="24.5" rx="2" ry="1.3" fill="#fff" opacity=".8"/><ellipse cx="38.5" cy="24.5" rx="2" ry="1.3" fill="#fff" opacity=".8"/>` +
        blush +
        mouth(grin(21, 43, 40, 11), tongue(32, 49, 6, 4)),
    ),
    // Party: a hat, a horn and confetti.
    party: svg(
      face() +
        shape("M11 17 L28 7 L6 1.5 Z", "#7b5cff", 2.4) +
        stroke("M17 13 L10 4", 2.2, "#ffd23a") +
        `<circle cx="6" cy="2.5" r="3" fill="#ff4f7b" stroke="${OUT}" stroke-width="1.8"/>` +
        happyEyes +
        blush +
        mouth(oval(33, 45, 3.5, 4)) +
        shape("M36 45 L58 37 Q62 42 58 47 Z", "#ff4f7b", 2.2) +
        stroke("M47 41 v5", 2, "#ffd23a") +
        `<rect x="44" y="5" width="4" height="2.5" rx="1" fill="#3ccf8e" transform="rotate(25 46 6)"/><rect x="55" y="15" width="4" height="2.5" rx="1" fill="#4f8ff7" transform="rotate(-30 57 16)"/>` +
        `<rect x="3" y="44" width="4" height="2.5" rx="1" fill="#ffd23a" transform="rotate(40 5 45)"/><circle cx="57" cy="26" r="1.8" fill="#ff4f7b"/><circle cx="37" cy="3" r="1.6" fill="#ffd23a"/>`,
    ),
    // Hyped: stars in the eyes.
    hype: svg(
      face() +
        shape(star(22, 27, 9, 4), "url(#st)", 2.2) +
        shape(star(42, 27, 9, 4), "url(#st)", 2.2) +
        mouth(grin(18, 46, 39, 14), teeth(39, 4.5) + tongue(32, 52, 8, 5)) +
        shape(star(56, 9, 5, 2), "#ffffff", 1.6) +
        shape(star(7, 14, 3.6, 1.5), "#ffffff", 1.4),
    ),
    // On fire, and knows it.
    fire: svg(
      tag(shape("M32 2 C37 12 55 18 55 38 A23 22 0 0 1 9 38 C9 27 16 22 18 13 C22 20 24 22 26 22 C26 13 28 7 32 2 Z", "url(#fl)", 3.4)) +
        gloss(26, 26, 9, 5) +
        stroke("M18 31 l10 3.5", 3.4) +
        stroke("M46 31 l-10 3.5", 3.4) +
        eye(24, 40, 5, 5.5, 1, 1, 2.8) +
        eye(40, 40, 5, 5.5, -1, 1, 2.8) +
        mouth(grin(24, 40, 48, 6.5), teeth(48, 3)),
    ),
    // The clutch: cold focus, a bead of sweat and a bolt of lightning.
    clutch: svg(
      face() +
        stroke("M14 19 l13 5", 3.8) +
        stroke("M50 19 l-13 5", 3.8) +
        eye(22, 30, 6, 6, 0.5, 0.8, 3.2) +
        eye(42, 30, 6, 6, -0.5, 0.8, 3.2) +
        mouth(grin(22, 40, 43, 6.5), teeth(43, 3.5)) +
        shape(drop(9, 18, 6), "url(#tr)", 1.8) +
        shape("M53 33 L42 50 H49 L45 62 L59 45 H52 L56 33 Z", "#ffd23a", 2.2),
    ),
    // Easy: sunglasses and a smirk.
    ez: svg(
      face() +
        stroke("M8 24 h48", 2.6) +
        shape("M9 22 h21 v5 a8 8 0 0 1 -8 8 h-5 a8 8 0 0 1 -8 -8 Z", "url(#gs)", 2.4) +
        shape("M34 22 h21 v5 a8 8 0 0 1 -8 8 h-5 a8 8 0 0 1 -8 -8 Z", "url(#gs)", 2.4) +
        stroke("M13 25 l4 6 M38 25 l4 6", 2, "#ffffff", `opacity=".55"`) +
        stroke("M22 46 q11 6 20 -5") +
        stroke("M42.5 38.5 q2 1.5 1 3.5", 2.2),
    ),
    // Big brain: round glasses and front teeth.
    nerd: svg(
      face() +
        eye(21, 29, 4.5, 5, 0, 0.6, 2.6) +
        eye(43, 29, 4.5, 5, 0, 0.6, 2.6) +
        `<circle cx="21" cy="29" r="8.5" fill="#dff1ff" fill-opacity=".25" stroke="${OUT}" stroke-width="3"/><circle cx="43" cy="29" r="8.5" fill="#dff1ff" fill-opacity=".25" stroke="${OUT}" stroke-width="3"/>` +
        stroke("M29.5 28 q2.5 -2.5 5 0", 2.6) +
        stroke("M12.5 27 l-6 -2 M51.5 27 l6 -2", 2.6) +
        mouth(grin(22, 42, 41, 9), `<rect x="28" y="40" width="4" height="6" rx="1" fill="#fbf8f0" stroke="${OUT}" stroke-width="1.2"/><rect x="32" y="40" width="4" height="6" rx="1" fill="#fbf8f0" stroke="${OUT}" stroke-width="1.2"/>`),
    ),
    // Sus: one brow up, one eye narrowed.
    sus: svg(face() + stroke("M15 21 l12 2", 3.4) + stroke("M36 15 q7 -5 13 1", 3.4) + lidded(22, 30, 6.5, 6, 3, 1.5) + eye(42, 28, 7, 8, 3.5, 0.5) + stroke("M24 47 q9 2 16 -4")),
    // Salty: unimpressed, with the salt to prove it.
    salty: svg(
      face() +
        stroke("M15 21 l12 1", 3.2) +
        stroke("M49 21 l-12 1", 3.2) +
        lidded(22, 30, 6.5, 6, 3, 1.5) +
        lidded(42, 30, 6.5, 6, 3, 1.5) +
        stroke("M24 48 q7 -4 14 1") +
        `<rect x="45" y="39" width="12" height="6" rx="2" fill="#9aa3b2" stroke="${OUT}" stroke-width="2"/><rect x="44" y="44" width="14" height="17" rx="4" fill="#f2f4f7" stroke="${OUT}" stroke-width="2.4"/>` +
        `<circle cx="48" cy="42" r=".9" fill="${OUT}"/><circle cx="51" cy="42" r=".9" fill="${OUT}"/><circle cx="54" cy="42" r=".9" fill="${OUT}"/>` +
        `<rect x="56" y="29" width="3" height="3" rx=".6" fill="#fff" stroke="${OUT}" stroke-width="1"/><rect x="59" y="35" width="2.5" height="2.5" rx=".5" fill="#fff" stroke="${OUT}" stroke-width="1"/>`,
    ),
    // Rage: red in the face, teeth clenched.
    rage: svg(
      face("fr") +
        stroke("M13 18 l14 7", 4) +
        stroke("M51 18 l-14 7", 4) +
        eye(22, 31, 6, 5.5, 1.5, 0.8, 3) +
        eye(42, 31, 6, 5.5, -1.5, 0.8, 3) +
        mouth("M20 41 h24 a5 5 0 0 1 0 10 h-24 a5 5 0 0 1 0 -10 Z", teeth(0, 64) + stroke("M12 46 h40 M26 40 v12 M32 40 v12 M38 40 v12", 1.6)) +
        stroke("M49 6 q2 3 0 5 M56 6 q-2 3 0 5 M49 15 q2 -3 0 -4 M56 15 q-2 -3 0 -4", 2.2, "#e0241a"),
    ),
    // Cringe: eyes shut, teeth bared.
    cringe: svg(
      face() + squeezed + mouth("M19 40 h26 a5.5 5.5 0 0 1 0 11 h-26 a5.5 5.5 0 0 1 0 -11 Z", teeth(0, 64) + stroke("M10 45.5 h44 M26 39 v13 M32 39 v13 M38 39 v13", 1.6)) + shape(drop(53, 12, 8), "url(#tr)", 1.8),
    ),
    // Crying.
    cry: svg(
      face() +
        stroke("M14 21 q7 -1 13 -6", 3.4) +
        stroke("M50 21 q-7 -1 -13 -6", 3.4) +
        eye(22, 29, 6.5, 7, 0, 1.5) +
        eye(42, 29, 6.5, 7, 0, 1.5) +
        mouth("M22 50 q10 -12 20 0 q-10 -4 -20 0 Z") +
        shape(drop(16, 35, 8), "url(#tr)", 1.8) +
        shape(drop(48, 35, 8), "url(#tr)", 1.8),
    ),
    // I'm dead.
    dead: svg(
      face() +
        stroke("M17 22 l9 9 M26 22 l-9 9", 3.6) +
        stroke("M38 22 l9 9 M47 22 l-9 9", 3.6) +
        shape("M34 44 h9 v4 a4.5 4.5 0 0 1 -9 0 Z", "url(#t)", 2.2) +
        stroke("M38.5 45.5 v4", 1.6, "#a8302a") +
        stroke("M21 44 h24"),
    ),
    // Bonk: a bump and stars.
    bonk: svg(
      face() +
        `<circle cx="40" cy="8" r="6" fill="#ffd426" stroke="${OUT}" stroke-width="3"/><ellipse cx="40" cy="11.8" rx="5" ry="2.6" fill="#ffd426"/>` +
        squeezed +
        stroke("M24 47 q2 -3 4 0 q2 3 4 0 q2 -3 4 0 q2 3 4 0") +
        shape(star(14, 10, 4.5, 2), "#ffd23a", 1.6) +
        shape(star(56, 16, 4, 1.8), "#ffd23a", 1.6) +
        shape(star(25, 3.5, 3, 1.3), "#ffd23a", 1.4),
    ),
    // Lag: dizzy, still loading.
    lag: svg(
      face() +
        eye(22, 28, 7, 7, 0, 0, 0) +
        eye(42, 28, 7, 7, 0, 0, 0) +
        spiral(21, 28) +
        spiral(41, 28) +
        stroke("M17 45 q2.75 -3 5.5 0 q2.75 3 5.5 0 q2.75 -3 5.5 0 q2.75 3 5.5 0") +
        badge(35, 49, 27, "#e8455d", "999ms", 8),
    ),
    // Away from keyboard: fast asleep.
    afk: svg(
      face() +
        stroke("M16 29 q6 5 12 0") +
        stroke("M36 29 q6 5 12 0") +
        mouth(oval(32, 46, 3.5, 3)) +
        shape(drop(22, 33, 4), "url(#tr)", 1.4) +
        text(51, 17, 15, "#7c86ff", "Z", `stroke="${OUT}" stroke-width="2" paint-order="stroke"`) +
        text(59, 8, 10, "#7c86ff", "z", `stroke="${OUT}" stroke-width="1.6" paint-order="stroke"`),
    ),
    // Ghosted.
    ghost: svg(
      tag(shape("M10 31 a22 22 0 0 1 44 0 v26 l-7.3 -5 l-7.3 5 l-7.3 -5 l-7.3 5 l-7.3 -5 l-7.5 5 Z", "url(#gh)", 3.4)) +
        gloss(28, 14, 12, 5) +
        eye(24, 29, 5.5, 7, 0.5, 1, 3.2) +
        eye(40, 29, 5.5, 7, 0.5, 1, 3.2) +
        `<ellipse cx="16" cy="39" rx="3.5" ry="2.2" fill="#ff7a9a" opacity=".35"/><ellipse cx="48" cy="39" rx="3.5" ry="2.2" fill="#ff7a9a" opacity=".35"/>` +
        mouth(oval(32, 42, 4, 4.5), tongue(32, 46, 3.5, 2.5)),
    ),
  };

  const urls = {};
  for (const [name, art] of Object.entries(EMOJIS)) urls["hopp_" + name] = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(art);
  window.HOPP_EMOJI = urls;
})();
