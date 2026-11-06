// Giving someone a coloured role colours their name in the chat right away.
(async () => {
  await inServer();
  const r = structuredClone(state.roster);
  r.features = ["roles"];
  r.roles = [{ id: 7, name: "Crew", color: "#46a758", hoist: true, level: null, position: 1 }];
  r.users.find((u) => u.name === "Elin").roles = [7];
  emit("roster", r);
  await wait(100);
  const name = [...document.querySelectorAll(".msg-author")].find((n) => n.textContent === "Elin");
  check("their name in chat takes the role's colour", name?.style.color === "rgb(70, 167, 88)", name?.style.color);
  report();
})();
