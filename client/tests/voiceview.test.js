// A voice channel is its own view: everyone's tiles fill it, its chat opens beside it, a
// screen you watch takes the middle, and the whole thing can go full screen.

(async () => {
  await inServer();
  const r = structuredClone(state.roster);
  r.features = ["search", "screen", "voice-chat", "voice-mod", "voice-settings"];
  emit("roster", r);
  await wait(100);
  commands.screen_signal = () => {};
  [...document.querySelectorAll(".channel-row")].find((n) => n.textContent.includes("Lobby")).click();
  await wait(150);
  const chat = document.querySelector(".chat");
  check("a voice channel fills the view with its people", chat.classList.contains("voice-mode") && document.querySelectorAll("#voice-stage .voice-tile").length === 2);
  check("its chat is beside it, open", chat.classList.contains("chat-open") && !$("voice-chat-btn").hidden);
  check("no member list in a voice view", getComputedStyle($("members")).display === "none");
  const w = parseInt(getComputedStyle(document.querySelector("#voice-stage .voice-tiles")).getPropertyValue("--tile-w"));
  check("two people get big tiles", w > 250, String(w));
  $("voice-chat-btn").click();
  await wait(30);
  check("the chat closes from the header", !chat.classList.contains("chat-open") && getComputedStyle($("scroller")).display === "none");
  emit("chat", { id: 9501, channel: 1, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "in voice chat", sent_at: Date.now() });
  await wait(30);
  check("a message there lights the Chat button", !$("voice-chat-dot").hidden);
  $("voice-chat-btn").click();
  await wait(30);
  check("opening it again clears that", chat.classList.contains("chat-open") && $("voice-chat-dot").hidden);
  check("a full screen button for the view", !!document.querySelector(".stage-bar .stage-btn"));

  // Someone shares: their screen is offered big in the middle, one click away.
  const sh = structuredClone(state.roster);
  sh.users.find((u) => u.name === "Jonas").sharing = true;
  emit("roster", sh);
  await wait(80);
  const card = document.querySelector(".stage-main .stream-card");
  check("a shared screen is offered big in the middle", !!card && card.textContent.includes("Jonas") && !!document.querySelector(".voice-tiles.strip"), card?.textContent);
  check("not started for someone only looking at the channel", !watching);

  // Watching a screen from a text channel takes you to the voice view, big in the middle.
  [...document.querySelectorAll(".channel-row")].find((n) => n.textContent.includes("general")).click();
  await wait(100);
  const jonas = state.roster.users.find((u) => u.name === "Jonas");
  commands.join_voice = ({ channel }) => { const j = structuredClone(state.roster); j.users.find((u) => u.session_id === j.me).voice_channel = channel; setTimeout(() => emit("roster", j), 10); };
  watchScreen(jonas.session_id);
  await wait(600);
  check("watching from outside joins their voice channel and opens it", state.view === 1 && myVoice() === 1);
  check("the screen is in the middle, everyone in a row below", !!document.querySelector(".stage-main #screen-stage") && !!document.querySelector(".voice-tiles.strip"));
  check("with its own buttons only (no second full screen)", !document.querySelector(".stage-bar"));
  // A camera can take the middle from the screen; the screen then waits in the row, a click away.
  mediaIn.set("cam|" + jonas.session_id, { pc: null, stream: new MediaStream(), pending: [] });
  renderVoiceStage();
  await wait(30);
  document.querySelector(`.voice-tile[data-user="${jonas.session_id}"]`).click();
  await wait(50);
  check("a camera you click takes the middle, also while a screen plays", !!document.querySelector(".stage-main .voice-tile.focus video") && !document.querySelector(".stage-main #screen-stage") && getComputedStyle($("screen-stage")).display === "none");
  const back = document.querySelector(".voice-tiles .screen-back");
  check("the screen waits in the row below", !!back && back.textContent.includes("Jonas's screen") && !!watching);
  back.click();
  await wait(50);
  check("a click puts the screen back in the middle", !!document.querySelector(".stage-main #screen-stage") && !document.querySelector(".screen-back"));
  mediaIn.delete("cam|" + jonas.session_id);
  renderVoiceStage();
  await wait(30);
  // Closed by hand: it stays closed, offered again as a card; a click brings it back.
  $("screen-close").click();
  await wait(50);
  check("closing it leaves it closed, offered as a card", !watching && !!document.querySelector(".stage-main .stream-card") && !document.querySelector(".stage-main #screen-stage"));
  document.querySelector(".stream-card").click();
  await wait(50);
  check("the card starts it again", watching?.from === jonas.session_id && !!document.querySelector(".stage-main #screen-stage"));
  stopWatching();
  // In the channel and looking at it: a screen someone starts sharing shows by itself.
  const off = structuredClone(state.roster);
  off.users.find((u) => u.name === "Jonas").sharing = false;
  emit("roster", off);
  await wait(50);
  check("no screen shared: back to everyone", !document.querySelector(".stage-main") && !document.querySelector(".voice-tiles.strip"));
  const on = structuredClone(state.roster);
  on.users.find((u) => u.name === "Jonas").sharing = true;
  emit("roster", on);
  await wait(80);
  check("a screen shared while you're there starts by itself", watching?.from === jonas.session_id && !!document.querySelector(".stage-main #screen-stage"));
  // Nothing comes back from them: tried again, then given up with a message, and not started over.
  watching.tries = 3;
  retryScreen(watching);
  await wait(50);
  check("a stream that can't be reached stops, and doesn't start over", !watching && !!document.querySelector(".stream-card") && !!document.querySelector(".toast"), document.querySelector(".toast")?.textContent);
  [...document.querySelectorAll(".channel-row")].find((n) => n.textContent.includes("general")).click();
  await wait(80);
  check("a text channel is a normal chat again", !chat.classList.contains("voice-mode") && getComputedStyle($("scroller")).display !== "none");
  report();
})();
