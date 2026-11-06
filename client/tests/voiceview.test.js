// A voice channel is its own view: everyone's tiles fill it, its chat opens beside it, a
// screen you watch takes the middle, and the whole thing can go full screen.

(async () => {
  await inServer();
  const r = structuredClone(state.roster);
  r.features = ["search", "screen", "voice-chat", "voice-mod", "voice-settings"];
  r.users.find((u) => u.name === "Jonas").sharing = true;
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

  // Watching a screen from a text channel takes you to the voice view, big in the middle.
  [...document.querySelectorAll(".channel-row")].find((n) => n.textContent.includes("general")).click();
  await wait(100);
  const jonas = state.roster.users.find((u) => u.name === "Jonas");
  watchScreen(jonas.session_id);
  await wait(100);
  check("watching opens their voice channel", state.view === 1);
  check("the screen is in the middle, everyone in a row below", !!document.querySelector(".stage-main #screen-stage") && !!document.querySelector(".voice-tiles.strip"));
  check("with its own buttons only (no second full screen)", !document.querySelector(".stage-bar"));
  stopWatching();
  await wait(50);
  check("stopping goes back to everyone", !document.querySelector(".stage-main") && !document.querySelector(".voice-tiles.strip"));
  [...document.querySelectorAll(".channel-row")].find((n) => n.textContent.includes("general")).click();
  await wait(80);
  check("a text channel is a normal chat again", !chat.classList.contains("voice-mode") && getComputedStyle($("scroller")).display !== "none");
  report();
})();
