// Getting around a long conversation fast: keys and the Jump to present bar.

(async () => {
  await inServer();
  const scroller = $("scroller");
  for (let i = 0; i < 80; i++) emit("chat", { id: 2000 + i, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "line " + i, sent_at: Date.now() });
  await wait(200);
  const bottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 5;
  check("starts at the bottom", bottom());

  // Page Up / Page Down while the cursor is in the message box.
  $("chat-input").focus();
  const before = scroller.scrollTop;
  $("chat-input").dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
  check("Page Up pages back", scroller.scrollTop < before - 200);
  $("chat-input").dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
  check("Page Down pages forward", scroller.scrollTop > before - 50);

  // Ctrl+Home and Ctrl+End.
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", ctrlKey: true, bubbles: true }));
  check("Ctrl+Home goes to the oldest loaded", scroller.scrollTop === 0);
  scroller.dispatchEvent(new Event("scroll"));
  check("the bar offers the way back", !$("jump-bar").hidden);
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "End", ctrlKey: true, bubbles: true }));
  await wait(600);
  check("Ctrl+End goes to the newest", bottom() && $("jump-bar").hidden);

  // The bar itself.
  scroller.scrollTop = 0;
  scroller.dispatchEvent(new Event("scroll"));
  $("jump-bar").click();
  await wait(600);
  check("Jump to present lands at the bottom", bottom());

  // In a DM too.
  openDm(KEYS.elin);
  await wait(300);
  for (let i = 0; i < 60; i++) emit("account", { type: "dm", with: KEYS.elin, message: { id: "x" + i, from_key: KEYS.elin, sealed: "plain:dm line " + i, sent_at: Date.now() + i } });
  await wait(400);
  check("a burst of 60 DMs all arrive", state.dmMessages.get(KEYS.elin).filter((m) => String(m.id).startsWith("x")).length === 60);
  const dm = document.querySelector(".dm-view .dm-scroll");
  dm.scrollTop = 0;
  dm.dispatchEvent(new Event("scroll"));
  const bar = document.querySelector(".dm-jump-bar");
  check("DMs have the bar too", bar && !bar.hidden);
  bar.click();
  await wait(600);
  check("and it takes you down", dm.scrollHeight - dm.scrollTop - dm.clientHeight < 5 && bar.hidden);
  dm.scrollTop = 0;
  $("dm-input").focus();
  $("dm-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(600);
  check("Escape in an empty DM box goes down", dm.scrollHeight - dm.scrollTop - dm.clientHeight < 5);
  report();
})();
