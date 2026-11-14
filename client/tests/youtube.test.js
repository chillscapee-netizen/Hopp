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
  check("the changes still show", document.querySelector('.msg[data-id="961"]') && [...document.querySelectorAll(".reaction img.emoji")].some((i) => i.alt === "🔥"));

  // Reactions on the video's own message, from someone else and from me: it keeps playing.
  emit("reactions", { channel: 0, id: 960, reactions: [{ emoji: "👍", keys: [KEYS.sara] }] });
  await wait(100);
  check("someone's reaction shows, video keeps playing", document.querySelector('.msg[data-id="960"] .reaction') && document.querySelector('.msg[data-id="960"] iframe') === player && player.isConnected);
  emit("reactions", { channel: 0, id: 960, reactions: [{ emoji: "👍", keys: [KEYS.sara, ME] }, { emoji: "🔥", keys: [ME] }] });
  await wait(100);
  check("my reaction too", document.querySelectorAll('.msg[data-id="960"] .reaction:not(.add)').length === 2 && document.querySelector('.msg[data-id="960"] iframe') === player);

  // The message is edited: new text, same player.
  emit("message-edited", { channel: 0, id: 960, text: "WATCH THIS https://www.youtube.com/watch?v=dQw4w9WgXcQ", edited_at: Date.now() });
  await wait(100);
  check("edited text shows, video keeps playing", document.querySelector('.msg[data-id="960"]').textContent.includes("WATCH THIS") && document.querySelector('.msg[data-id="960"] iframe') === player && player.isConnected);
  check("the row's menu knows the new text", document.querySelector('.msg[data-id="960"]').msg.text.startsWith("WATCH THIS"));

  // Hovering and opening the message menu doesn't touch it either.
  document.querySelector('.msg[data-id="960"]').dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  document.querySelector('.msg[data-id="960"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
  closePopovers();
  check("hover and menu leave it playing", document.querySelector('.msg[data-id="960"] iframe') === player && player.isConnected);

  // Going to another server and back: nothing starts playing by itself.
  const rail = [...document.querySelectorAll("#server-list .rail-item")];
  const home = activeServer().id;
  rail[1].click();
  for (let i = 0; i < 40 && !(online() && activeServer()?.id !== home); i++) await wait(50);
  check("leaving the server stops the video", !document.querySelector("#messages iframe"));
  rail[0].click();
  for (let i = 0; i < 40 && !(online() && activeServer()?.id === home); i++) await wait(50);
  await wait(300);
  check("coming back shows its picture, not a playing video", !document.querySelector("#messages iframe") && (!document.querySelector('.msg[data-id="960"]') || !!document.querySelector('.msg[data-id="960"] .yt-play')));
  report();
})();
