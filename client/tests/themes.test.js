// Themes: presets, your own colour, kept for next time, and Mid grey is the stylesheet itself.

(async () => {
  await inServer();
  const root = document.documentElement;
  const css = (name) => getComputedStyle(root).getPropertyValue(name).trim();
  const bodyBg = () => getComputedStyle(document.body).backgroundColor;

  check("starts in Mid grey, with nothing overridden", prefs.theme === "mid" && root.style.length === 0);
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

  // Your own colour: a bright pick becomes a calm dark theme around it.
  const picker = document.querySelector(".theme-color");
  picker.value = "#ff2a6d";
  picker.dispatchEvent(new Event("input"));
  await wait(50);
  check("your own colour is used", prefs.theme === "custom" && localStorage.getItem("themeColor") === "#ff2a6d");
  check("dark colours give a dark theme", css("color-scheme") === "dark");
  const main = css("--main");
  check("tinted, calm and dark enough to read on", /^hsl\(341\.\d 22\.0% 30\.0%\)$/.test(main), main);

  // Back to Mid grey: exactly the stylesheet again.
  document.querySelector('.theme-card[data-theme="mid"]').click();
  await wait(50);
  check("Mid grey clears every override", root.style.length === 0 && bodyBg() === midBg);
  document.getElementById("settings").close();
  report();
})();
