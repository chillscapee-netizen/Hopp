// Nicknames: your own from the server menu, someone else's as a moderator; the name here shows
// in the chat, and the card says who it really is.
(async () => {
  await inServer();
  const r = structuredClone(state.roster);
  r.features = ["search", "voice-chat", "nicknames"];
  emit("roster", r);
  await wait(100);
  const sent = [];
  commands.set_nickname = (a) => {
    sent.push(a);
    const n = structuredClone(state.roster);
    const u = n.users.find((x) => x.public_key === a.publicKey);
    u.name = a.nick ?? (a.publicKey === ME ? "Marcus" : "Elin");
    setTimeout(() => emit("roster", n), 5);
  };
  // Your own, from the server menu.
  openServerMenu(activeServer(), 10, 10);
  [...document.querySelectorAll("#server-menu .menu-item")].find((b) => b.textContent.trim() === "Change nickname").click();
  await wait(50);
  check("the server menu asks for your nickname", $("text-dialog").open && $("text-title").textContent === "Your nickname here");
  $("text-input").value = "Meppa";
  $("text-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await wait(80);
  check("it's sent for you", sent.at(-1)?.publicKey === ME && sent.at(-1).nick === "Meppa");
  check("your old messages show the name you have here now", [...document.querySelectorAll(".msg-author")].some((n) => n.textContent === "Meppa"));

  // Someone else's, as the owner, from their menu.
  [...document.querySelectorAll(".member")].find((x) => x.textContent.includes("Elin")).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 900, clientY: 200 }));
  await wait(30);
  [...document.querySelectorAll("#server-menu .menu-item")].find((b) => b.textContent.trim() === "Change nickname").click();
  await wait(50);
  $("text-input").value = "Elly";
  $("text-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await wait(80);
  check("a moderator renames someone", sent.at(-1)?.publicKey === KEYS.elin && sent.at(-1).nick === "Elly");
  const elly = state.roster.users.find((u) => u.name === "Elly");
  openUserCard(elly, document.querySelector(".member"));
  await wait(30);
  check("their card says who they really are", !$("user-card-realname").hidden && $("user-card-realname").textContent === "Elin");
  report();
})();
