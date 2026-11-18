// Every theme reads well and leaves nothing broken behind: the greys, every colour theme, and
// your own with one colour or several, dark and light. Text stands out from the background and
// from every colour of a fade (WCAG's 4.5:1); no token is NaN or empty; a fade is a wallpaper
// and a grey is not; Mid grey afterwards is exactly the stylesheet again; and an older save
// with a first and a second colour still works.

(async () => {
  await inServer();
  const root = document.documentElement;
  const css = (name) => getComputedStyle(root).getPropertyValue(name).trim();
  const probe = document.createElement("span");
  document.body.append(probe);
  const rgb = (colour) => {
    probe.style.color = "";
    probe.style.color = colour;
    return (getComputedStyle(probe).color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  };
  const luminance = ([r, g, b]) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (a, b) => {
    const [x, y] = [luminance(rgb(a)), luminance(rgb(b))].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  };
  const problems = [];
  const look = (label) => {
    const text = css("--text");
    const backgrounds = [css("--app-solid") || "#333338", ...(css("--app-bg").match(/hsl\([^)]*\)|#[0-9a-f]{6}/gi) ?? [])];
    for (const bg of backgrounds) {
      const c = contrast(text, bg);
      if (c < 4.5) problems.push(`${label}: text ${text} on ${bg} is only ${c.toFixed(1)}:1`);
      const m = contrast(css("--muted"), bg);
      if (m < 3) problems.push(`${label}: quiet text on ${bg} is only ${m.toFixed(1)}:1`);
    }
    for (const k of THEME_KEYS) {
      const v = root.style.getPropertyValue(k === "scheme" ? "color-scheme" : "--" + k);
      if (/NaN|undefined/.test(v)) problems.push(`${label}: --${k} is ${v}`);
    }
    const fades = !!css("--app-bg");
    if (fades !== root.classList.contains("wallpaper")) problems.push(`${label}: wallpaper ${root.classList.contains("wallpaper")} but fade ${fades}`);
  };

  for (const t of THEMES) {
    setTheme(t.id);
    look(t.name);
    if (css("--app-bg")) problems.push(`${t.name}: a grey shouldn't fade`);
  }
  for (const g of GRADIENTS) {
    setTheme(g.id);
    look(g.name);
    if (!root.classList.contains("wallpaper")) problems.push(`${g.name}: should be a wallpaper`);
  }
  for (const mode of ["dark", "light"]) {
    for (const colors of [["#ff2a6d"], ["#2a3ad6", "#9b2ad6", "#d6402a"], ["#ffffff", "#ffff00"], ["#000000", "#101010"]]) {
      prefs.custom = { ...prefs.custom, mode, saturation: 100 };
      setOwnColours(colors);
      setTheme("custom");
      look(`your own (${mode}, ${colors.join(" ")})`);
    }
  }
  for (const p of problems.slice(0, 40)) check(p, false);
  check(`every theme reads well, nothing broken (${problems.length} problems)`, problems.length === 0);

  setTheme("mid");
  check("Mid grey afterwards: exactly the stylesheet again", !root.style.getPropertyValue("--main") && !css("--app-bg") && !root.classList.contains("wallpaper"));

  // An older save: a first and a second colour, no list.
  prefs.custom = { a: "#2a6dff", b: "#ff2a6d", contrast: 50, saturation: 60, mode: "dark" };
  check("an older save with two colours is two colours", JSON.stringify(ownColours()) === JSON.stringify(["#2a6dff", "#ff2a6d"]));
  setTheme("custom");
  check("and fades between them", root.classList.contains("wallpaper") && css("--app-bg").startsWith("linear-gradient"));
  setTheme("mid");
  report();
})();
