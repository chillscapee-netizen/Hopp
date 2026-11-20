// In a voice channel, the row's mic and headphones show what's on at once.

(async () => {
  try {
    await inServer();
    const r = structuredClone(state.roster);
    r.features = [...(r.features ?? []), "screen", "voice-chat"];
    r.users.find((u) => u.session_id === r.me).voice_channel = 1;
    emit("roster", r);
    emit("voice-state", { ready: true });
    await wait(80);
    openTextChannel(1);
    await wait(200);
    const btn = (vc) => document.querySelector(`#voice-stage [data-vc="${vc}"]`);
    btn("mute").click();
    await wait(120);
    check("muting shows on the row's mic", btn("mute").classList.contains("on"));
    btn("deafen").click();
    await wait(120);
    check("deafening shows on the headphones", btn("deafen").classList.contains("on"));
    $("mute-btn").click();
    await wait(150);
    check("the panel's button changes the row too", !btn("mute").classList.contains("on") && !btn("deafen").classList.contains("on"));
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
