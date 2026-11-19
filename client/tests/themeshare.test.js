// Your own theme can be saved with a name, used again, renamed, deleted, and shared as a code:
// pasted in a chat it's a card to try or save. Broken codes are just text.

(async () => {
  await inServer();
  localStorage.removeItem("savedThemes");
  prefs.savedThemes = [];
  openSettings("appearance");
  document.querySelector('.settings-tab[data-tab="appearance"]').click();
  await wait(50);
  // A new theme of your own: made, picked, and edited; every change is kept in it.
  document.querySelector(".own-new").click();
  await wait(50);
  check("Make a new theme makes one among yours, and opens it", prefs.savedThemes.length === 1 && !$("theme-editor").hidden && !$("saved-themes").hidden && document.querySelector("[data-ttab=yours]").classList.contains("active"));
  setOwnColours(["#2a3ad6", "#9b2ad6"]);
  $("own-name").value = "Night drive";
  $("own-name").dispatchEvent(new Event("input"));
  await wait(100);
  check("changes show at once and wait for Save", !$("own-unsaved").hidden && !$("own-save").disabled && prefs.savedThemes[0].colors.join() !== "#2a3ad6,#9b2ad6");
  $("own-save").click();
  await wait(300);
  check("Save keeps its colours and name", prefs.savedThemes[0].name === "Night drive" && prefs.savedThemes[0].colors.join() === "#2a3ad6,#9b2ad6");
  check("kept for next time (and your other devices)", JSON.parse(localStorage.getItem("savedThemes"))[0].colors.join() === "#2a3ad6,#9b2ad6" && SYNCED_SETTINGS.includes("savedThemes"));
  check("and marked as the one in use", document.querySelector("#saved-themes .saved-theme").classList.contains("active"));
  keepTheme(currentOwnTheme("Again"));
  check("the same colours aren't saved twice", prefs.savedThemes.length === 1);

  // A second one, then back to the first: each keeps its own colours.
  document.querySelector(".own-new").click();
  await wait(50);
  setOwnColours(["#d6402a"]);
  await wait(100);
  $("own-save").click();
  await wait(300);
  check("several of your own, side by side", prefs.savedThemes.length === 2 && document.querySelectorAll("#saved-themes .saved-theme:not(.own-new)").length === 2 && prefs.savedThemes[0].colors.join() === "#2a3ad6,#9b2ad6" && prefs.savedThemes[1].colors.join() === "#d6402a");
  check("the new one is the one in use", document.querySelectorAll("#saved-themes .saved-theme")[1].classList.contains("active") && !document.querySelectorAll("#saved-themes .saved-theme")[0].classList.contains("active"));
  document.querySelectorAll("#saved-themes .saved-theme")[0].click();
  await wait(30);
  check("clicking the first uses it again", ownColours().join() === "#2a3ad6,#9b2ad6" && prefs.theme === "custom" && $("own-name").value === "Night drive");
  prefs.savedThemes.splice(1, 1);
  saveSavedThemes();

  // A shared theme tried isn't saved by trying it.
  const shared = { name: "Peach", colors: ["#d6402a", "#e0862a"], mode: "dark", saturation: 80 };
  useTheme(shared);
  await wait(300);
  check("trying a theme saves nothing", prefs.savedThemes.length === 1);
  useTheme(prefs.savedThemes[0]);
  await wait(30);

  // A code: there and back.
  const code = themeCode(prefs.savedThemes[0]);
  const back = themeOf(code);
  check("its code carries it whole", /^hopp-theme:/.test(code) && back.name === "Night drive" && back.colors.join() === "#2a3ad6,#9b2ad6" && back.mode === prefs.savedThemes[0].mode);
  check("broken codes are just text", themeOf("hopp-theme:!!!") === null && themeOf("hopp-theme:" + base64url('{"c":["red"]}')) === null && themeOf("hello") === null);
  const evil = themeOf("hopp-theme:" + base64url(JSON.stringify({ n: "<img src=x onerror=alert(1)>".repeat(5), c: ["#ffffff", "#000000", "#123456", "#abcdef", "#fedcba", "#111111"], m: "nope", s: 9999 })));
  check("and odd ones are tamed", evil.name.length <= 32 && evil.colors.length === 5 && evil.mode === "dark" && evil.saturation === 100);

  // In a chat: a card to try or save.
  $("settings").close();
  prefs.savedThemes = [];
  saveSavedThemes();
  const friend = themeCode({ name: "Peach", colors: ["#d6402a", "#e0862a"], mode: "dark", saturation: 80 });
  emit("chat", { id: 9001, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: friend, sent_at: Date.now() });
  await wait(80);
  const card = document.querySelector("#messages .theme-share");
  check("a shared theme shows as a card", !!card && card.textContent.includes("Peach") && !card.textContent.includes("hopp-theme:"));
  check("its preview reads as a theme", previewText(friend) === "🎨 Theme: Peach");
  const [tryBtn, saveBtn] = card.querySelectorAll("button");
  tryBtn.click();
  await wait(50);
  check("Try uses it", prefs.theme === "custom" && ownColours().join() === "#d6402a,#e0862a");
  saveBtn.click();
  await wait(50);
  check("Save keeps it, and says so", prefs.savedThemes.some((t) => t.name === "Peach") && saveBtn.textContent === "Saved" && saveBtn.disabled);
  setTheme("mid");
  report();
})();
