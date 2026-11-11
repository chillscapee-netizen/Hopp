// In a voice channel, looking at another server doesn't take you out of it: the voice panel
// stays (and takes you back), the others' comings and goings still sound, and hanging up or
// joining somewhere else ends it.

(async () => {
  await inServer();
  const first = activeServer();
  const rows = [...document.querySelectorAll("#server-list .rail-item")];
  const base = structuredClone(state.roster);
  base.features = ["search", "screen", "voice-chat", "resync"];
  base.users.find((u) => u.session_id === base.me).voice_channel = 1;
  base.users.find((u) => u.name === "Jonas").voice_channel = 1;
  emit("roster", base);
  await wait(60);
  check("in voice on the first server", myVoice() === 1 && !$("voice-panel").hidden);
  check("the server shows where your voice is", !!document.querySelector(`.rail-item[data-server="${first.id}"] .rail-voice`));

  const sent = [];
  commands.leave_voice = () => sent.push("leave");
  commands.set_user_volume = (a) => sent.push("volume " + a.sessionId);
  rows[1].click();
  for (let i = 0; i < 40 && !(online() && activeServer()?.id !== first.id); i++) await wait(50);
  await wait(100);
  check("on the other server", activeServer()?.id !== first.id);
  check("still in voice: nothing was left", !!state.voiceAway && !sent.includes("leave") && inVoice());
  check("the voice panel stays, saying where", !$("voice-panel").hidden && $("voice-where").textContent.includes("Lobby") && $("voice-where").textContent.includes(first.label), $("voice-where").textContent);
  check("camera and screen sharing wait for you to come back", $("cam-btn").hidden && $("share-btn").hidden);
  check("your own line says where you are", $("me-status").textContent.includes("Lobby"), $("me-status").textContent);
  check("the mark is on the server with your voice", !!document.querySelector(`.rail-item[data-server="${first.id}"] .rail-voice`) && document.querySelectorAll(".rail-voice").length === 1);
  check("nobody's volume here is touched", !sent.some((x) => x.startsWith("volume")), sent.join());

  // Someone talking over there doesn't light up a stranger here.
  emit("voice", { type: "speaking", session_id: 2, speaking: true });
  emit("voice", { type: "speaking", session_id: base.me, speaking: true });
  await wait(30);
  check("talk over there lights nobody here", !state.speaking.size && !document.querySelector(".speaking:not(#me-card)"));
  check("but you see yourself talking", $("me-card").classList.contains("speaking"));
  emit("voice", { type: "speaking", session_id: base.me, speaking: false });

  // Someone joins the channel you're in: the roster over there moves on.
  const more = structuredClone(base);
  more.users.find((u) => u.name === "Elin").voice_channel = 1;
  emit("voice-away", { address: endpoint(first), roster: more });
  await wait(30);
  check("the channel over there is followed", state.voiceAway.roster.users.filter((u) => u.voice_channel === 1).length === 3);

  // The panel's line takes you back, still in voice.
  $("voice-where").click();
  for (let i = 0; i < 40 && activeServer()?.id !== first.id; i++) await wait(50);
  await wait(100);
  check("the panel takes you back to the channel", activeServer()?.id === first.id && !state.voiceAway);

  // Away again, and hang up from there.
  emit("roster", more);
  await wait(30);
  rows[1].click();
  for (let i = 0; i < 40 && !(online() && activeServer()?.id !== first.id); i++) await wait(50);
  await wait(60);
  $("hangup-btn").click();
  await wait(30);
  check("hanging up from the other server leaves voice", sent.includes("leave") && !state.voiceAway && $("voice-panel").hidden && !document.querySelector(".rail-voice"));

  // Thrown out over there (or the connection went): the panel goes, with a word about it.
  rows[0].click();
  for (let i = 0; i < 40 && activeServer()?.id !== first.id; i++) await wait(50);
  emit("roster", more);
  await wait(30);
  rows[1].click();
  for (let i = 0; i < 40 && !(online() && activeServer()?.id !== first.id); i++) await wait(50);
  await wait(60);
  check("away in voice once more", !!state.voiceAway);
  emit("voice-away", { address: endpoint(first), roster: null, lost: true });
  await wait(30);
  check("a lost connection over there ends voice, and says so", !state.voiceAway && $("voice-panel").hidden && /lost/.test(document.querySelector(".toast")?.textContent ?? ""), document.querySelector(".toast")?.textContent);
  report();
})();
