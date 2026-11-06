// Active now: a friend in voice in a server you're in shows where, with Join; the card opens
// your conversation; someone in a server you aren't in just shows "In voice".
(async () => {
  await inServer();
  state.friends.get(KEYS.jonas).activity = "In voice";
  state.friends.get(KEYS.jonas).voice = "cloud:elsewhere99#4";
  state.friends.get(KEYS.jonas).status = "online";
  $("home-btn").click();
  await wait(200);
  const cards = [...document.querySelectorAll(".active-card")];
  const elin = cards.find((c) => c.textContent.includes("Elin"));
  const jonas = cards.find((c) => c.textContent.includes("Jonas"));
  check("a friend in your server shows where", elin?.querySelector(".active-place")?.textContent.includes("The Crew"));
  check("with Join", !!elin?.querySelector(".active-place .btn"));
  check("a server you're not in shows nothing more (no way in)", !!jonas && !jonas.querySelector(".active-place"));
  check("no Message or Call buttons on cards", !document.querySelector(".active-card .active-actions"));
  const joined = [];
  commands.join_voice = ({ channel }) => joined.push(channel);
  elin.querySelector(".active-place .btn").click();
  await wait(300);
  check("Join takes you to their server and voice channel", !state.atHome && joined.includes(1) && state.view === 1);
  $("home-btn").click();
  await wait(100);
  document.querySelector(".active-card").click();
  await wait(100);
  check("the card opens your conversation", !!state.openDm);
  report();
})();
