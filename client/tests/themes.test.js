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
  check("a card for each theme, and your own", cards.map((c) => c.dataset.theme).join() === "mid,dark,midnight,light,custom");
  check("the chosen one is marked", document.querySelector(".theme-card.active")?.dataset.theme === "mid");

  cards.find((c) => c.dataset.theme === "light").click();
  await wait(50);
  check("Light grey turns the app light", css("color-scheme") === "light" && bodyBg() !== midBg);
  const [r, g, b] = getComputedStyle(document.querySelector(".frame")).backgroundColor.match(/\d+/g).map(Number);
  check("with a light background", r > 200 && g > 200 && b > 200, `${r} ${g} ${b}`);
  const text = getComputedStyle(document.body).color.match(/\d+/g).map(Number);
  check("and dark text", text[0] < 60, text.join(" "));
  check("kept for next time", localStorage.getItem("theme") === "light");
  check("the card follows", document.querySelector(".theme-card.active")?.dataset.theme === "light");

  // Your own colour: the picker is the same element all along, so it stays open while you drag.
  const picker = document.getElementById("theme-a");
  picker.focus();
  picker.value = "#ff2a6d";
  picker.dispatchEvent(new Event("input"));
  await wait(50);
  check("the picker isn't rebuilt while you use it", document.getElementById("theme-a") === picker && document.activeElement === picker);
  check("your own colour is used", prefs.theme === "custom" && JSON.parse(load("themeCustom", "{}")).a === "#ff2a6d");
  check("dark colours give a dark theme", css("color-scheme") === "dark");
  const main = css("--main");
  check("tinted, calm and dark enough to read on", /^hsl\(341\.\d 25\.0% 2\d\.\d%\)$/.test(main), main);

  // Light or dark is your choice: dragging through light colours doesn't flip it.
  const modeBefore = prefs.mode;
  for (const c of ["#9a9aa0", "#c8c8d0", "#f0f0f6"]) {
    picker.value = c;
    picker.dispatchEvent(new Event("input"));
    await wait(30);
  }
  check("light colours keep a dark theme dark", css("color-scheme") === "dark");
  const lighter = css("--main");
  picker.value = "#30303a";
  picker.dispatchEvent(new Event("input"));
  await wait(30);
  check("and still change it, a step at a time", css("--main") !== lighter);
  document.querySelector('.theme-mode .segment[data-look="light"]').click();
  await wait(30);
  check("Light makes it light", css("color-scheme") === "light" && document.querySelector(".theme-mode .segment.active")?.dataset.look === "light");
  check("your voice settings are untouched", prefs.mode === modeBefore);
  document.querySelector('.theme-mode .segment[data-look="dark"]').click();
  picker.value = "#ff2a6d";
  picker.dispatchEvent(new Event("input"));
  await wait(30);

  // A second colour: a fade.
  const second = document.getElementById("theme-b");
  second.value = "#2a6dff";
  second.dispatchEvent(new Event("input"));
  await wait(50);
  check("a second colour makes a fade", css("--sheet-bg").startsWith("linear-gradient"));
  const contrast = document.getElementById("theme-contrast");
  contrast.value = "100";
  contrast.dispatchEvent(new Event("input"));
  await wait(50);
  check("contrast spreads the shades", css("--frame") !== "" && document.getElementById("theme-contrast-value").textContent === "100%");
  document.getElementById("theme-b-clear").click();
  await wait(50);
  check("one colour again: no fade", !css("--sheet-bg"));

  // Colour themes.
  document.querySelector('.gradient-swatch[data-theme="dusk"]').click();
  await wait(50);
  check("a colour theme fades between its colours", prefs.theme === "dusk" && css("--frame-bg").startsWith("linear-gradient") && document.querySelector(".gradient-swatch.active")?.dataset.theme === "dusk");

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
  check("Mid grey clears every colour", !root.style.getPropertyValue("--main") && !root.style.getPropertyValue("--sheet-bg") && bodyBg() === midBg);
  document.getElementById("settings").close();
  report();
})();
