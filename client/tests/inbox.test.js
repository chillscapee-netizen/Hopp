// The inbox: mentions of you from every server, kept by the account; the bell counts the new
// ones, opening it marks them seen everywhere, a click goes to the message.

(async () => {
  await inServer();
  const sent = [];
  const realSend = commands.account_send;
  commands.account_send = (a) => {
    sent.push(a.msg);
    return realSend(a);
  };
  const badge = () => document.querySelector("#inbox-btn .inbox-badge");
  emit("account", {
    type: "inbox",
    items: [
      { server: "cloud:crew0001", channel: 2, id: 77, at: Date.now() - 60000, server_name: "The Crew", channel_name: "lfg", author_key: KEYS.elin, author_name: "Elin", preview: "@Marcus you in?", crowd: false },
      { server: "cloud:crew0001", channel: 0, id: 70, at: Date.now() - 120000, server_name: "The Crew", channel_name: "general", author_key: KEYS.elin, author_name: "Elin", preview: "@everyone raid", crowd: true },
    ],
  });
  await wait(50);
  check("the bell counts new mentions", !badge().hidden && badge().textContent === "2", badge().textContent);

  $("inbox-btn").click();
  await wait(50);
  const pop = $("inbox-pop");
  const items = () => [...pop.querySelectorAll(".inbox-item")];
  check("opening it lists them, newest first", !pop.hidden && items().length === 2 && items()[0].textContent.includes("you in?") && items()[0].textContent.includes("#lfg"));
  check("and counts them as seen, on every device", badge().hidden && sent.some((m) => m.type === "inbox_seen"));

  // A new one while here.
  closePopovers();
  emit("account", { type: "channel_activity", server: "cloud:crew0001", channel: 0, id: 80, last_id: 80, last_at: Date.now() + 1000, read_id: 0, mentions: 1, server_name: "The Crew", channel_name: "general", author_key: KEYS.elin, author_name: "Elin", mention: true, crowd: false, preview: "@Marcus look" });
  await wait(50);
  check("a new mention counts at once", !badge().hidden && badge().textContent === "1", badge().textContent);

  // Removing one, then going to another.
  $("inbox-btn").click();
  await wait(50);
  items()[1].querySelector(".inbox-x").click();
  await wait(30);
  check("one can be removed", items().length === 2 && sent.some((m) => m.type === "inbox_clear" && m.id === 77));
  items()[0].click();
  await wait(150);
  check("a click goes to it", pop.hidden && state.view === 0, String(state.view));

  // Suppressing @everyone in that server hides those.
  setCrowdQuiet(prefs.servers.find((s) => s.address === "cloud:crew0001"), true);
  $("inbox-btn").click();
  await wait(50);
  check("@everyone is left out where it's suppressed", !items().some((i) => i.textContent.includes("raid")));
  pop.querySelector(".inbox-head .btn-link").click();
  await wait(30);
  check("Clear all", items().length === 0 && sent.some((m) => m.type === "inbox_clear" && m.all));
  commands.account_send = realSend;
  report();
})();
