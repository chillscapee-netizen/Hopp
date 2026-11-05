// A playing YouTube video keeps playing while the chat changes around it.

(async () => {
  await inServer();
  emit("chat", { id: 960, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "watch https://www.youtube.com/watch?v=dQw4w9WgXcQ", sent_at: Date.now() });
  await wait(150);
  const card = document.querySelector('.msg[data-id="960"] .yt-card');
  check("a YouTube link becomes a card", !!card && !!card.querySelector(".yt-play"));
  card.querySelector(".yt-play").click();
  const player = document.querySelector('.msg[data-id="960"] iframe');
  check("plays in the chat", !!player && player.src.includes("youtube-nocookie.com/embed/dQw4w9WgXcQ"));
  const row = document.querySelector('.msg[data-id="960"]');

  // Things that redraw the chat.
  const mine = state.chats.get(0).find((m) => m.author_key === ME);
  startEdit(mine);
  await wait(50);
  stopEdit();
  emit("reactions", { channel: 0, id: mine.id, reactions: [{ emoji: "🔥", keys: [KEYS.sara] }] });
  emit("chat", { id: 961, channel: 0, sender: 4, sender_name: "Sara", author_key: KEYS.sara, text: "lol", sent_at: Date.now() });
  renderMessages(true);
  await wait(150);
  check("the same player is still there, untouched", document.querySelector('.msg[data-id="960"] iframe') === player && player.isConnected);
  check("its row was never rebuilt", document.querySelector('.msg[data-id="960"]') === row);
  check("the changes still show", document.querySelector('.msg[data-id="961"]') && document.body.textContent.includes("🔥"));

  // Reacting to the video's own message redraws only that row.
  emit("reactions", { channel: 0, id: 960, reactions: [{ emoji: "👍", keys: [KEYS.sara] }] });
  await wait(100);
  check("a change to that message itself does redraw it", document.querySelector('.msg[data-id="960"] .reaction') !== null);
  report();
})();
