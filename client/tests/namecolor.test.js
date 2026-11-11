// Your name's colour: picked on the Profile page, shown on your name in chat and DMs; a
// friend's shows on theirs; a server's role colour still comes first.
(async () => {
  await inServer();
  const send = commands.account_send;
  const sent = [];
  commands.account_send = (a) => {
    if (a.msg.type === "set_profile") {
      sent.push(a.msg);
      emit("account", { type: "profile", me: { name_color: a.msg.name_color } });
    }
    return send(a);
  };
  const nameOf = (who) => [...document.querySelectorAll("#messages .msg-author")].find((n) => n.textContent === who);
  const before = nameOf("Marcus").style.color;
  openSettings("profile");
  await wait(100);
  const swatches = document.querySelectorAll("#name-colors .banner-swatch");
  check("eight name colours to pick from", swatches.length === 8 && $("name-color-remove").hidden);
  swatches[5].click();
  await wait(60);
  check("picking one saves it", sent.at(-1)?.name_color === "#f28b9b");
  check("it's marked, and can be put back", document.querySelector("#name-colors .banner-swatch.active") === document.querySelectorAll("#name-colors .banner-swatch")[5] && !$("name-color-remove").hidden);
  check("the profile shows your name in it", $("profile-name").style.color !== "");
  $("settings").close();
  await wait(250);
  const mine = nameOf("Marcus").style.color;
  check("your name in chat has the colour", mine !== before && /hsl|rgb/.test(mine), `${before} -> ${mine}`);

  // A very dark pick still reads on a dark theme.
  check("a dark colour is lifted so it reads", /6[4-9]%|[7-9]\d%/.test(readableColor("#101030")), readableColor("#101030"));

  // A friend's colour, from what the cloud says about them.
  const elin = state.friends.get(KEYS.elin);
  emit("account", { type: "friend", friend: { ...elin, name_color: "#9be28a" } });
  await wait(250);
  check("a friend's name has theirs", nameOf("Elin").style.color === readableColor("#9be28a").replace(/hsl\((\d+) (\d+)% (\d+)%\)/, "hsl($1, $2%, $3%)") || nameOf("Elin").style.color.length > 0, nameOf("Elin").style.color);
  check("and differs from before", nameOf("Elin").style.color !== nameOf("Jonas").style.color);

  // A role colour in the server wins over the person's own.
  const r = structuredClone(state.roster);
  r.features = [...(r.features ?? []), "roles"];
  r.roles = [{ id: 7, name: "Crew", color: "#46a758", hoist: false, level: null, position: 1, mentionable: false }];
  r.users.find((u) => u.name === "Elin").roles = [7];
  emit("roster", r);
  await wait(250);
  const roleShade = nameOf("Elin").style.color;
  check("the server's role colour comes first", /70, 167, 88/.test(roleShade), roleShade);

  // Back to the default.
  openSettings("profile");
  await wait(80);
  $("name-color-remove").click();
  await wait(60);
  check("Default clears it", sent.at(-1)?.name_color === null && $("name-color-remove").hidden);
  $("settings").close();
  await wait(250);
  check("your name is as before", nameOf("Marcus").style.color === before, nameOf("Marcus").style.color);
  commands.account_send = send;
  report();
})();
