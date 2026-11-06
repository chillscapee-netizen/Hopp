// A custom status: set from your status menu, shown under your name, on friends' rows, in
// members, on cards; it runs out on its own.
(async () => {
  await inServer();
  const sent = [];
  const send = commands.account_send;
  commands.account_send = (a) => {
    if (a.msg.type === "set_profile") {
      sent.push(a.msg);
      emit("account", { type: "profile", me: { custom_status: a.msg.custom_status } });
    }
    return send(a);
  };
  $("me-card").click();
  await wait(50);
  [...document.querySelectorAll("#server-menu .menu-item")].find((b) => b.textContent.includes("Set a custom status")).click();
  await wait(50);
  check("the status menu opens the dialog", $("status-dialog").open);
  $("status-text").value = "Playing Valorant";
  statusEmoji = "🎮";
  $("status-until").value = "60";
  $("status-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await wait(50);
  const s = sent.at(-1)?.custom_status;
  check("it's saved with an emoji and a time", s?.text === "Playing Valorant" && s.emoji === "🎮" && s.until > Date.now() + 50 * 60_000);
  check("your line under your name shows it", $("me-status").textContent === "🎮 Playing Valorant");

  // A friend's status, on their rows and in the member list.
  const elin = state.friends.get(KEYS.elin);
  elin.custom_status = JSON.stringify({ text: "Back at 8", emoji: "🍕", until: null });
  renderAll();
  await wait(50);
  const member = [...document.querySelectorAll(".member")].find((x) => x.textContent.includes("Elin"));
  check("a member shows their status", member?.textContent.includes("Back at 8"));
  $("home-btn").click();
  await wait(100);
  check("friends and DMs show it", document.body.textContent.includes("🍕 Back at 8"));
  elin.custom_status = JSON.stringify({ text: "old", emoji: null, until: Date.now() - 1000 });
  check("a status that ran out shows nowhere", customStatusOf(KEYS.elin) === null);

  // Clearing.
  $("me-card").click();
  await wait(50);
  [...document.querySelectorAll("#server-menu .menu-item")].find((b) => b.textContent.includes("Clear custom status")).click();
  await wait(50);
  check("clearing it sends nothing", sent.at(-1).custom_status === null && !$("me-status").textContent.includes("Valorant"));
  commands.account_send = send;
  report();
})();
