// Name styles: a font and a fade between two colours, kept in the profile's name colour field
// (older apps just see the colour); and a font for all of Hopp, just for you.

(async () => {
  try {
  await inServer();
  check("styles read back", JSON.stringify(parseNameStyle("#aabbcc #ddeeff f:hand")) === JSON.stringify({ c1: "#aabbcc", c2: "#ddeeff", font: "hand" }));
  check("unknown bits are ignored", JSON.stringify(parseNameStyle("f:nope red #123456")) === JSON.stringify({ c1: "#123456", c2: null, font: null }));
  check("and are written back the same way", joinNameStyle({ c1: null, c2: "#ffffff", font: "pixel" }) === "f:pixel");

  // Elin styled her name: a font and a fade.
  state.friends.get(KEYS.elin).name_color = "#8ab4f8 #f28b9b f:graffiti";
  emit("chat", { id: 9994, channel: 0, sender: 3, sender_name: "Jonas", author_key: KEYS.jonas, text: "in between", sent_at: Date.now() });
  emit("chat", { id: 9995, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "styled", sent_at: Date.now() });
  await wait(120);
  const author = document.querySelector('.msg[data-id="9995"] .msg-author');
  check("her font shows in chat", author.style.fontFamily.includes("Sedgwick") && author.dataset.nameFont === "graffiti");
  check("and her fade", author.classList.contains("name-fade") && author.style.backgroundImage.includes("linear-gradient"));
  check("the first colour is kept apart", parseNameStyle(rawNameStyle(KEYS.elin)).c1 === "#8ab4f8");

  // Your own, in Profile.
  const sent = [];
  const real = commands.account_send;
  commands.account_send = (a) => {
    sent.push(a.msg);
    return real(a);
  };
  state.me.name_color = "#9be28a";
  openSettings("profile");
  renderNameColors();
  await wait(80);
  check("a fade can be added once there's a colour", !$("name-fade-row").hidden);
  [...document.querySelectorAll("#name-fonts .name-font")].find((b) => b.textContent.includes("Pixel")).click();
  await wait(30);
  check("picking a font keeps your colour", sent.at(-1)?.name_color === "#9be28a f:pixel", sent.at(-1)?.name_color);
  check("every font is offered, plus Default", document.querySelectorAll("#name-fonts .name-font").length === Object.keys(NAME_FONTS).length + 1);
  commands.account_send = real;
  $("settings").close();

  // The app's font.
  $("app-font").value = "dyslexic";
  $("app-font").dispatchEvent(new Event("change"));
  await wait(30);
  check("the app font changes for all of Hopp", getComputedStyle(document.body).fontFamily.includes("OpenDyslexic"));
  check("and follows the account", SYNCED_SETTINGS.includes("appFont"));
  $("app-font").value = "inter";
  $("app-font").dispatchEvent(new Event("change"));
  } catch (err) {
    check("no crash", false, err.stack);
  }
  report();
})();
