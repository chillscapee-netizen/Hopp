// The soundboard: a button in voice, a grid of sounds, one every couple of seconds.

(async () => {
  await inServer();
  const r = structuredClone(state.roster);
  r.features = ["search", "screen", "voice-chat", "voice-mod", "voice-settings"];
  r.users.find((u) => u.session_id === r.me).voice_channel = 1;
  emit("roster", r);
  await wait(100);
  commands.play_soundboard = (a) => sent.push({ type: "sound", ...a });
  document.getElementById("soundboard-btn").click();
  const pop = document.getElementById("soundboard");
  check("it opens with the sounds", !pop.hidden && pop.querySelectorAll(".sound").length === 8);
  sent.length = 0;
  pop.querySelector(".sound").click();
  await wait(20);
  pop.querySelectorAll(".sound")[1].click();
  await wait(20);
  check("a sound plays for everyone", sent.filter((m) => m.type === "sound").map((m) => m.name).join() === "ding");
  report();
})();
