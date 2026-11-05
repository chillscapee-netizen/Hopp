// Opening a channel with lots of new messages starts at the first one you haven't read.

(async () => {
  await inServer();
  const address = activeServer().address;
  // #clips: 60 messages; you'd read up to the 15th.
  const many = [];
  for (let i = 1; i <= 60; i++) many.push({ id: 1000 + i, channel: 3, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "clip number " + i, sent_at: Date.now() - (60 - i) * 60_000 });
  emit("chat-history", { channel: 3, messages: many });
  await wait(50);
  state.reads.set(readKey(address, 3), { server: address, channel: 3, read_id: 1015, last_id: 1060, mentions: 0 });
  openTextChannel(3);
  await wait(150);
  const scroller = document.getElementById("scroller");
  const divider = document.querySelector("#messages .new-divider");
  const top = divider.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  check("the New line is right before message 16", divider?.nextElementSibling?.textContent.includes("clip number 16"));
  check("and it opens there, not at the bottom", top > 0 && top < 120, `line at ${Math.round(top)}px`);
  check("the bar says how much is new", !document.getElementById("jump-bar").hidden && document.getElementById("jump-text").textContent === "45 new messages");
  document.getElementById("jump-bar").click();
  await wait(600);
  check("Jump to present goes to the newest", scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 5);

  // A little new: it just opens at the bottom, the line in view.
  for (const m of many) m.channel = 4;
  state.reads.set(readKey(address, 4), { server: address, channel: 4, read_id: 1058, last_id: 1060, mentions: 0 });
  emit("chat-history", { channel: 4, messages: many.map((m) => ({ ...m, channel: 4 })) });
  await wait(50);
  openTextChannel(4);
  await wait(150);
  check("a little new opens at the bottom", scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 5);
  report();
})();
