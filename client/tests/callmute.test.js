// In a call, the row's mic and headphones show what's on, at once: muting, deafening, and
// unmuting while deafened (which undeafens too).

(async () => {
  try {
    await inServer();
    $("home-btn").click();
    await wait(100);
    openDm(KEYS.elin);
    await wait(150);
    await startCall(KEYS.elin);
    state.call.status = "live";
    state.call.startedAt = Date.now();
    state.call.engineReady = true;
    renderCall();
    await wait(100);
    const btn = (vc) => document.querySelector(`#call-stage [data-vc="${vc}"]`);
    btn("mute").click();
    await wait(100);
    check("muting shows on the call's mic", btn("mute").classList.contains("on") && btn("mute").getAttribute("aria-label") === "Unmute");
    btn("deafen").click();
    await wait(100);
    check("deafening shows on the headphones", btn("deafen").classList.contains("on"));
    btn("mute").click();
    await wait(150);
    check("unmuting while deafened turns both back on", !btn("mute").classList.contains("on") && !btn("deafen").classList.contains("on"));
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
