// Around (beside Friends): friends in voice first, with where they are and Join when it's a
// server you're in; someone in a server you aren't in just shows "In voice"; a row opens your
// conversation; nobody online says so (Add friend is already in the header).
(async () => {
  await inServer();
  state.friends.get(KEYS.jonas).activity = "In voice";
  state.friends.get(KEYS.jonas).voice = "cloud:elsewhere99#4";
  state.friends.get(KEYS.jonas).status = "online";
  $("home-btn").click();
  await wait(200);
  const rows = [...document.querySelectorAll(".around-row.talking")];
  const elin = rows.find((c) => c.textContent.includes("Elin"));
  const jonas = rows.find((c) => c.textContent.includes("Jonas"));
  check("a friend in your server shows where", elin?.querySelector(".around-sub")?.textContent.includes("The Crew"), elin?.textContent);
  check("with Join", !!elin?.querySelector(".around-join"));
  check("a server you're not in shows no way in", !!jonas && !jonas.querySelector(".around-join") && jonas.textContent.includes("In voice"));
  check("those in voice come before the rest", document.querySelector(".around-label")?.textContent === "In voice");
  check("a thin line sets it apart", getComputedStyle(document.querySelector(".active-now")).borderLeftWidth === "1px");
  const joined = [];
  commands.join_voice = ({ channel }) => joined.push(channel);
  elin.querySelector(".around-join").click();
  await wait(300);
  check("Join takes you to their server and voice channel", !state.atHome && joined.includes(1) && state.view === 1);
  $("home-btn").click();
  await wait(100);
  document.querySelector(".around-row").click();
  await wait(100);
  check("a row opens your conversation", !!state.openDm);

  // Nobody online.
  for (const f of state.friends.values()) f.status = "offline";
  state.openDm = null;
  $("home-btn").click();
  document.querySelector('.friend-tab[data-ftab="online"]')?.click();
  await wait(150);
  const empty = document.querySelector(".around-empty");
  check("nobody around says so, in Hopp's words", !!empty && !document.querySelector(".active-now").textContent.includes("Active now"));
  report();
})();
