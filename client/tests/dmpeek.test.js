// A friend who wrote shows under the Hopp button, with how many messages wait; a click opens
// the conversation and they go again.
(async () => {
  await inServer();
  await wait(200);
  const peeks = () => [...document.querySelectorAll("#dm-peeks .dm-peek:not(.more)")];
  const unreadNow = [...state.conversations].filter(([, c]) => c.last_at > c.last_read).length;
  check("unread conversations show under Home", peeks().length === Math.min(unreadNow, 4) && peeks().length >= 1, `${peeks().length} of ${unreadNow}`);
  const first = peeks()[0];
  check("with the friend's picture and a count", !!first.querySelector(".avatar") && Number(first.querySelector(".rail-badge")?.textContent) >= 1);
  check("Home's own badge no longer counts them twice", (() => {
    const requests = [...state.friends.values()].filter((f) => f.state === "incoming").length;
    const badge = $("home-btn").querySelector(".rail-badge");
    const hidden = unreadNow - peeks().length + requests;
    return hidden === 0 ? badge.hidden : badge.textContent === String(hidden);
  })());

  // A new message from someone else: they appear, newest on top.
  emit("account", { type: "dm", with: KEYS.sara, message: { id: "peek1", from_key: KEYS.sara, sealed: "plain:hey there", sent_at: Date.now() } });
  await wait(150);
  check("a friend who writes appears on top", peeks()[0]?.dataset.dm === KEYS.sara, peeks().map((n) => n.dataset.dm.slice(0, 6)).join());
  emit("account", { type: "dm", with: KEYS.sara, message: { id: "peek2", from_key: KEYS.sara, sealed: "plain:you around?", sent_at: Date.now() + 1 } });
  await wait(150);
  check("their count goes up", peeks()[0].querySelector(".rail-badge").textContent === "2", peeks()[0].querySelector(".rail-badge")?.textContent);

  // A click opens the conversation; read, they leave the rail.
  peeks()[0].click();
  await wait(200);
  check("a click opens the conversation", state.openDm === KEYS.sara && !online());
  check("read: they're gone from under Home", !peeks().some((n) => n.dataset.dm === KEYS.sara));

  // Many at once: four show, the rest as "+N".
  const now = Date.now() + 10;
  for (let i = 0; i < 6; i++) state.conversations.set("f".repeat(63) + i, { last_at: now + i, last_read: 0 });
  for (let i = 0; i < 6; i++) state.friends.set("f".repeat(63) + i, { key: "f".repeat(63) + i, display_name: "Friend " + i, username: "friend" + i, avatar: null, state: "friend", status: "online" });
  renderRail();
  await wait(30);
  check("at most four show, the rest as +N", peeks().length === 4 && /^\+\d+$/.test(document.querySelector("#dm-peeks .dm-peek.more")?.textContent ?? ""), document.querySelector("#dm-peeks .dm-peek.more")?.textContent);
  report();
})();
