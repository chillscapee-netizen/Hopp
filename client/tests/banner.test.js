// Profile banner: a colour from the Profile page, shown on your card; others' from their profile.
(async () => {
  await inServer();
  const send = commands.account_send;
  const sent = [];
  commands.account_send = (a) => {
    if (a.msg.type === "set_profile") {
      sent.push(a.msg);
      emit("account", { type: "profile", me: { banner: a.msg.banner } });
    }
    return send(a);
  };
  openSettings("profile");
  await wait(100);
  const swatches = document.querySelectorAll("#banner-colors .banner-swatch");
  check("eight banner colours to pick from", swatches.length === 8);
  swatches[2].click();
  await wait(50);
  check("picking one saves it", sent.at(-1)?.banner === "#d9534f");
  check("the preview shows it", $("profile-banner").style.backgroundColor.includes("217, 83, 79"));
  check("and it can be removed", !$("banner-remove").hidden);
  $("settings").close();
  const me = state.roster.users.find((u) => u.session_id === state.roster.me);
  openUserCard(me, document.querySelector(".member"));
  await wait(30);
  check("your card has it", $("user-card-banner").style.backgroundColor.includes("217, 83, 79"));
  closePopovers();
  // Someone else's picture banner, from their profile.
  profiles.set(KEYS.sara, { avatar: null, display_name: "Sara", banner: "data:image/png;base64,iVBORw0KGgo=", at: Date.now() });
  const sara = state.roster.users.find((u) => u.name === "Sara");
  openUserCard(sara, document.querySelector(".member"));
  await wait(30);
  check("someone's picture banner shows on their card", $("user-card-banner").style.backgroundImage.includes("data:image/png"));
  commands.account_send = send;
  report();
})();
