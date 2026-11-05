// A voice channel's own view: its people on a stage, its own chat, nothing made unread.

(async () => {
  await inServer();
  const r = structuredClone(state.roster);
  r.features = ["search", "screen", "voice-chat"];
  emit("roster", r);
  await wait(100);
  commands.join_voice = (a) => { sent.push({ type: "join_voice", ...a }); };
  const lobby = [...document.querySelectorAll(".channel-row")].find((row) => row.textContent.includes("Lobby"));
  sent.length = 0;
  lobby.click();
  await wait(150);
  check("clicking a voice channel joins it", sent.some((m) => m.type === "join_voice" && m.channel === 1));
  check("and opens it", state.view === 1 && document.getElementById("chat-channel").textContent === "Lobby");
  check("the header shows a speaker, not a #", document.getElementById("chat-head-icon").innerHTML.includes("i-volume"));
  const tiles = [...document.querySelectorAll("#voice-stage .voice-tile")];
  check("its people are on the stage", tiles.length >= 2 && tiles.some((t) => t.textContent.includes("Elin")));
  check("the box writes in this channel", document.getElementById("chat-input").placeholder === "Message Lobby");

  // Talking lights up the tile.
  const elin = state.roster.users.find((u) => u.name === "Elin");
  emit("voice", { type: "speaking", session_id: elin.session_id, speaking: true });
  check("the one talking lights up", document.querySelector(`.voice-tile[data-user="${elin.session_id}"]`).classList.contains("speaking"));

  // A message here doesn't make anything unread.
  const address = activeServer().address;
  emit("chat", { id: 7001, channel: 1, sender: elin.session_id, sender_name: "Elin", author_key: KEYS.elin, text: "hi from voice", sent_at: Date.now() });
  await wait(50);
  check("its chat shows here", document.getElementById("messages").textContent.includes("hi from voice"));
  openTextChannel(0);
  emit("chat", { id: 7002, channel: 1, sender: elin.session_id, sender_name: "Elin", author_key: KEYS.elin, text: "while you're in general", sent_at: Date.now() });
  await wait(50);
  check("voice chat never marks anything unread", !channelUnread(address, 1) && !document.querySelector(".channel-row.unread"));
  check("text channels have no stage", document.getElementById("voice-stage").hidden);

  // Servers without voice chat: the old way, just joining.
  const old = structuredClone(state.roster);
  old.features = ["search"];
  emit("roster", old);
  await wait(50);
  [...document.querySelectorAll(".channel-row")].find((row) => row.textContent.includes("Gaming")).click();
  await wait(100);
  check("an older server only joins", state.view === 0);
  report();
})();
