// Hopp's logo top left can be seen in every theme: a grey theme keeps its grey tile, a colour
// theme lends the logo its colours with the H in white; never a white H on nothing.

(async () => {
  try {
    await inServer();
    // Colours as they end up, not halfway through a fade (the hidden test window never finishes one).
    const still = document.createElement("style");
    still.textContent = "* { transition: none !important; }";
    document.head.append(still);
    const rgb = (c) => (c.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const contrast = (a, b) => {
      const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
      return (x + 0.05) / (y + 0.05);
    };
    const ids = [...THEMES.map((t) => t.id), ...GRADIENTS.map((g) => g.id)];
    for (const id of ids) {
      setTheme(id);
      for (const active of [true, false]) {
        if (active) $("home-btn").click();
        else openTextChannel(0);
        await wait(250);
        const icon = document.querySelector("#home-btn .rail-icon");
        const cs = getComputedStyle(icon);
        const fg = rgb(cs.color);
        const tinted = cs.backgroundImage !== "none";
        const bg = rgb(cs.backgroundColor);
        // A see-through tile is seen over the window behind it.
        const under = rgb(getComputedStyle(document.body).backgroundColor);
        const a = bg[3] ?? 1;
        const seen = [0, 1, 2].map((k) => bg[k] * a + (under[k] ?? 0) * (1 - a));
        const ok = tinted ? lum(fg) > 0.8 : contrast(fg, seen) >= 3;
        check(`${id}${active ? " (open)" : ""}: the logo can be seen`, ok, `${cs.backgroundColor} ${cs.backgroundImage.slice(0, 40)} / ${cs.color}`);
      }
    }
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
