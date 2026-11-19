// Themes: presets, colour themes, your own (with a picker that stays open while you use it),
// kept for next time, and Mid grey is the stylesheet itself. Chat text size and spacing too.

(async () => {
  await inServer();
  const root = document.documentElement;
  const css = (name) => getComputedStyle(root).getPropertyValue(name).trim();
  const bodyBg = () => getComputedStyle(document.body).backgroundColor;

  check("starts in Mid grey, with no colour overridden", prefs.theme === "mid" && !root.style.getPropertyValue("--main"));
  const midBg = bodyBg();

  openSettings("appearance");
  await wait(50);
  const cards = [...document.querySelectorAll(".theme-card")];
  check("a card for each theme, the colour ones, and your own", cards.map((c) => c.dataset.theme).join() === "mid,dark,midnight,light,twilight,sunset,dusk,ocean,forest,ember,aurora,hero,dawn,new" && cards.every((c) => c.querySelector(".theme-pic") && c.querySelector(".theme-name").textContent.trim()));
  check("the chosen one is marked", document.querySelector(".theme-card.active")?.dataset.theme === "mid");

  cards.find((c) => c.dataset.theme === "light").click();
  await wait(50);
  check("Light grey turns the app light", css("color-scheme") === "light" && bodyBg() !== midBg);
  const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
  check("with a light background", r > 200 && g > 200 && b > 200, `${r} ${g} ${b}`);
  const text = getComputedStyle(document.body).color.match(/\d+/g).map(Number);
  check("and dark text", text[0] < 60, text.join(" "));
  check("kept for next time", localStorage.getItem("theme") === "light");
  check("the card follows", document.querySelector(".theme-card.active")?.dataset.theme === "light");

  // Your own colours: round colours that open the colour picker, + adds one, × takes one away.
  document.querySelector('.theme-card[data-theme="new"]').click();
  await wait(120);
  check("your own colours show when you pick Your own", !$("theme-editor").hidden && document.querySelectorAll("#own-colours .own-colour input[type=color]").length >= 1);
  const picker = document.querySelector("#own-colours .own-colour input");
  picker.focus();
  picker.value = "#ff2a6d";
  picker.dispatchEvent(new Event("input"));
  await wait(50);
  check("the picker isn't rebuilt while you use it", document.querySelector("#own-colours .own-colour input") === picker && document.activeElement === picker);
  check("your own colour is used", prefs.theme === "custom" && ownColours()[0] === "#ff2a6d" && JSON.parse(load("themeCustom", "{}")).a === "#ff2a6d");
  check("dark colours give a dark theme", css("color-scheme") === "dark");
  const main = css("--main");
  check("tinted, calm and dark enough to read on", /^hsl\(341\.\d 25\.0% 2\d\.\d%\)$/.test(main), main);

  // Light or dark is your choice: picking light colours doesn't flip it.
  const modeBefore = prefs.mode;
  for (const c of ["#9a9aa0", "#c8c8d0", "#f0f0f6"]) {
    picker.value = c;
    picker.dispatchEvent(new Event("input"));
    await wait(30);
  }
  check("light colours keep a dark theme dark", css("color-scheme") === "dark");
  document.querySelector('.theme-mode .segment[data-look="light"]').click();
  await wait(30);
  check("Light makes it light", css("color-scheme") === "light" && document.querySelector(".theme-mode .segment.active")?.dataset.look === "light");
  check("your voice settings are untouched", prefs.mode === modeBefore);
  document.querySelector('.theme-mode .segment[data-look="dark"]').click();
  picker.value = "#ff2a6d";
  picker.dispatchEvent(new Event("input"));
  await wait(30);

  // More colours: a fade through all of them.
  document.querySelector("#own-colours .own-colour-add").click();
  await wait(30);
  document.querySelector("#own-colours .own-colour-add").click();
  await wait(50);
  check("+ adds colours, and they fade across the window", ownColours().length === 3 && document.querySelectorAll("#own-colours .own-colour").length === 3 && css("--app-bg").startsWith("linear-gradient") && (css("--app-bg").match(/hsl\(/g) ?? []).length === 3, css("--app-bg"));
  for (let i = 0; i < 5; i++) document.querySelector("#own-colours .own-colour-add:not([hidden])")?.click();
  await wait(30);
  check("five at most", ownColours().length === 5 && document.querySelector("#own-colours .own-colour-add").hidden);
  while (ownColours().length > 1) {
    document.querySelector("#own-colours .own-colour-remove").click();
    await wait(20);
  }
  check("× takes them away again, down to one: no fade", ownColours().length === 1 && !document.querySelector("#own-colours .own-colour-remove") && !css("--app-bg"));

  // Colour themes.
  document.querySelector('.theme-card[data-theme="dusk"]').click();
  await wait(50);
  check("a colour theme fades between its colours", prefs.theme === "dusk" && css("--app-bg").startsWith("linear-gradient") && document.querySelector(".theme-card.active")?.dataset.theme === "dusk");

  // Chat text size and spacing.
  const size = document.getElementById("chat-size");
  size.value = "18";
  size.dispatchEvent(new Event("input"));
  await wait(50);
  check("chat text gets bigger", getComputedStyle(document.querySelector("#messages .msg-text")).fontSize === "18px");

  // Back to Mid grey: exactly the stylesheet again.
  document.querySelector('.theme-card[data-theme="mid"]').click();
  size.value = "15";
  size.dispatchEvent(new Event("input"));
  await wait(50);
  check("Mid grey clears every colour", !root.style.getPropertyValue("--main") && !root.style.getPropertyValue("--app-bg") && bodyBg() === midBg);

  document.getElementById("settings").close();
  report();
})();
