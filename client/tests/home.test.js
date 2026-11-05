// Home and back: the server stays connected (and voice goes on), going back is instant.

(async () => {
  await inServer();
  let connects = 0;
  let disconnects = 0;
  const realConnect = commands.connect;
  commands.connect = (a) => { connects++; return realConnect(a); };
  commands.disconnect = () => { disconnects++; };

  // In voice.
  const r = structuredClone(state.roster);
  r.users.find((u) => u.session_id === r.me).voice_channel = 1;
  emit("roster", r);
  await wait(100);
  check("in voice", myVoice() === 1 && !$("voice-panel").hidden);

  $("home-btn").click();
  await wait(100);
  check("Home is on screen", !online() && $("home-btn").classList.contains("active") && !document.querySelector(".rail-item.active:not(#home-btn)"));
  check("still connected, nothing hung up", connected() && disconnects === 0);
  check("still in voice, panel showing", myVoice() === 1 && !$("voice-panel").hidden);

  // A message while away: it waits as unread.
  emit("chat", { id: 950, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "while you were home", sent_at: Date.now() });
  await wait(100);
  const crew = prefs.servers.find((s) => s.address === "cloud:crew0001");
  check("counts as unread on Home", channelUnread(crew.address, 0));

  // Opening a DM keeps the server too.
  openDm(KEYS.elin);
  await wait(100);
  check("a DM keeps the server connected", connected() && disconnects === 0 && !!document.querySelector(".dm-view"));

  // Back: instant, no new connection, and the message is there.
  await connectTo(crew);
  await wait(100);
  check("back to the server without reconnecting", online() && connects === 0);
  check("the message from meanwhile shows", !!document.querySelector('.msg[data-id="950"]'));
  check("server lit in the rail again", !$("home-btn").classList.contains("active"));

  // Switching to another server is a real switch.
  await connectTo(prefs.servers.find((s) => s.address === "192.168.8.35"));
  check("another server connects", connects === 1);
  report();
})();
