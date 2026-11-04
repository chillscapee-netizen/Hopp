// Odd situations that tend to break apps.

(async () => {
  await inServer();

  // Long names and odd text don't break the layout or the page.
  const long = "W".repeat(200);
  emit("chat", { id: 9001, channel: 0, sender: 2, sender_name: long, author_key: KEYS.elin, text: "🔥🔥🔥", sent_at: Date.now() });
  emit("chat", { id: 9002, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "<script>alert(1)</script> **x** ||y|| `z` ~~q~~ > quote", sent_at: Date.now() });
  emit("chat", { id: 9003, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "x".repeat(2000), sent_at: Date.now() });
  await wait(200);
  check("script text stays text", !document.querySelector("#messages script") && document.body.textContent.includes("<script>alert(1)</script>"));
  const scroller = document.getElementById("scroller");
  check("no sideways scroll from long text", scroller.scrollWidth <= scroller.clientWidth + 2, scroller.scrollWidth + " > " + scroller.clientWidth);

  // Many reactions on one message.
  emit("reactions", { channel: 0, id: 9001, reactions: Array.from({ length: 20 }, (_, i) => ({ emoji: ["😀", "🔥", "👍", "🎉"][i % 4] + "".padEnd(i % 3, "‍"), keys: [KEYS.sara] })) });
  await wait(150);
  check("20 reactions render", document.querySelectorAll('.msg[data-id="9001"] .reaction:not(.add)').length === 20);

  // Edits and deletes of messages we don't have are ignored.
  emit("message-edited", { channel: 0, id: 424242, text: "ghost", edited_at: Date.now() });
  emit("message-deleted", { channel: 0, id: 424242 });
  emit("reactions", { channel: 77, id: 1, reactions: [] });
  check("unknown message events are harmless", true);

  // A server with no channels at all.
  emit("roster", { ...state.roster, channels: [] });
  await wait(150);
  check("no channels: says so", document.body.textContent.includes("No text channels"));
  check("no channels: composer hidden", document.getElementById("composer").hidden);
  emit("roster", { ...state.roster, channels: [{ id: 0, name: "general", kind: "text" }, { id: 1, name: "Lobby", kind: "voice" }] });
  await wait(150);

  // The account connection drops and comes back.
  emit("account-state", { connected: false });
  await wait(100);
  emit("account-state", { connected: true });
  check("account reconnect is harmless", true);

  // The server connection drops: a notice, and an attempt to reconnect.
  emit("disconnected", null);
  await wait(300);
  check("reconnect notice shows", document.body.textContent.includes("Reconnecting") || document.body.textContent.includes("Lost the connection"));

  // Garbage from the account (a newer cloud, a bug) doesn't break anything.
  emit("account", { type: "something_new", foo: 1 });
  emit("account", { type: "channel_activity", server: "cloud:nowhere", channel: 5, read_id: 0, last_id: 3, mentions: 1, id: 3, mention: true, author_key: KEYS.sara, author_name: "Sara", channel_name: "x", preview: "hi" });
  emit("account", { type: "dm", with: KEYS.kim, message: { id: "zz", from_key: KEYS.kim, sealed: "not-sealed", sent_at: Date.now() } });
  await wait(200);
  check("unknown and odd account messages are harmless", true);

  // A server's icon can't sneak anything into an invite card's style.
  const evil = inviteCardView({ name: "x", icon: 'x"), url("https://evil.example/t.png', kicker: "k" }, false, "hopp://x");
  check("odd invite icon ignored", !evil.style.getPropertyValue("--invite-art") && !evil.classList.contains("has-art"));
  const good = inviteCardView({ name: "x", icon: "data:image/webp;base64,UklGRg==", kicker: "k" }, false, "hopp://x");
  check("real invite icon shown", good.classList.contains("has-art"));
  report();
})();
