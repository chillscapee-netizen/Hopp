// A message that arrives while you're reading the conversation is read, here and in the
// account, so it doesn't come back as unread later.

(async () => {
  for (let i = 0; i < 120 && (!state.accountConnected || $("shell").classList.contains("locked")); i++) await wait(50);
  document.hasFocus = () => true;
  openDm(KEYS.elin);
  await wait(200);
  sent.length = 0;
  emit("account", { type: "dm", with: KEYS.elin, message: { id: "live1", from_key: KEYS.elin, sealed: "plain:are you there?", sent_at: Date.now() } });
  await wait(150);
  const conv = state.conversations.get(KEYS.elin);
  check("read here", conv.last_read >= conv.last_at);
  check("and the account is told", sent.some((m) => m.type === "dm_read" && m.with === KEYS.elin));
  check("no unread mark on the conversation", !document.querySelector(".dm-row.unread"));

  // Not looking (another window in front): it stays unread until you come back.
  document.hasFocus = () => false;
  sent.length = 0;
  emit("account", { type: "dm", with: KEYS.elin, message: { id: "live2", from_key: KEYS.elin, sealed: "plain:hello?", sent_at: Date.now() + 1000 } });
  await wait(150);
  check("unread while you're away", state.conversations.get(KEYS.elin).last_read < state.conversations.get(KEYS.elin).last_at && !sent.some((m) => m.type === "dm_read"));
  document.hasFocus = () => true;
  window.dispatchEvent(new Event("focus"));
  await wait(100);
  check("read when you're back", sent.some((m) => m.type === "dm_read"));
  report();
})();
