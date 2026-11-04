// Catching up: jump back to the present, and marking servers and channels read.

(async () => {
  await inServer();
  const scroller = $("scroller");
  for (let i = 0; i < 60; i++) emit("chat", { id: 500 + i, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "line " + i, sent_at: Date.now() });
  await wait(200);
  check("no bar at the bottom", $("jump-bar").hidden);
  scroller.scrollTop = 0;
  scroller.dispatchEvent(new Event("scroll"));
  await wait(100);
  check("bar shows when scrolled up", !$("jump-bar").hidden && $("jump-text").textContent.includes("older"));
  emit("chat", { id: 700, channel: 0, sender: 4, sender_name: "Sara", author_key: KEYS.sara, text: "you there?", sent_at: Date.now() });
  emit("chat", { id: 701, channel: 0, sender: 4, sender_name: "Sara", author_key: KEYS.sara, text: "hello?", sent_at: Date.now() });
  await wait(150);
  check("counts what arrived meanwhile", $("jump-text").textContent === "2 new messages");
  $("jump-bar").click();
  await wait(1200);
  scroller.dispatchEvent(new Event("scroll"));
  check("jumps back down and hides", scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 5 && $("jump-bar").hidden);

  // Mark as read: a whole server, then one channel.
  const crew = prefs.servers.find((s) => s.address === "cloud:crew0001");
  state.reads.set(readKey(crew.address, 3), { server: crew.address, channel: 3, read_id: 1, last_id: 9, mentions: 2 });
  state.reads.set(readKey(crew.address, 4), { server: crew.address, channel: 4, read_id: 1, last_id: 5, mentions: 0 });
  renderUnread();
  openServerMenu(crew, 10, 10);
  const item = [...$("server-menu").querySelectorAll(".menu-item")].find((b) => b.textContent.includes("Mark as read"));
  check("server menu offers Mark as read", !!item);
  sent.length = 0;
  item.click();
  await wait(700);
  check("server marked read", !serverHasUnread(crew.address) && channelMentions(crew.address, 3) === 0);
  check("read marks reach the account", sent.filter((m) => m.type === "channel_read").length === 2);
  openServerMenu(crew, 10, 10);
  check("nothing to mark: no menu item", ![...$("server-menu").querySelectorAll(".menu-item")].some((b) => b.textContent.includes("Mark as read")));
  closePopovers();

  state.reads.set(readKey(crew.address, 4), { server: crew.address, channel: 4, read_id: 1, last_id: 7, mentions: 0 });
  markChannelRead(crew.address, 4);
  check("one channel marked read", !channelUnread(crew.address, 4));
  report();
})();
