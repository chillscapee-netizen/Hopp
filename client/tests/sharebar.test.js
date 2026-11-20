// The call row in a voice channel: Share starts it, the same button stops it (and shows it's
// off), and it starts again; the screen's own Stop ends it too; nothing is left on.

(async () => {
  try {
    await inServer();
    const c = document.createElement("canvas");
    c.width = 320;
    c.height = 180;
    const g = c.getContext("2d");
    const draw = setInterval(() => g.fillRect(0, 0, 4, 4), 33);
    let asked = 0;
    navigator.mediaDevices.getDisplayMedia = async () => {
      asked++;
      return c.captureStream(10);
    };
    const r = structuredClone(state.roster);
    r.features = [...(r.features ?? []), "screen", "voice-chat"];
    r.users.find((u) => u.session_id === r.me).voice_channel = 1;
    emit("roster", r);
    emit("voice-state", { ready: true });
    await wait(80);
    openTextChannel(1);
    await wait(200);
    const btn = () => document.querySelector('#voice-stage [data-vc="share"]');
    check("Share in the row", !!btn());
    btn().click();
    btn().click();
    await wait(300);
    check("two quick clicks ask for one screen", asked === 1, String(asked));
    check("sharing, and the button shows it", !!screenShare.stream && btn().classList.contains("on"), String(!!screenShare.stream));
    btn().click();
    await wait(300);
    check("the same button stops it", !screenShare.stream && !btn().classList.contains("on"), `${!!screenShare.stream} ${btn()?.className}`);
    check("without asking for a screen again", asked === 1, String(asked));
    btn().click();
    await wait(300);
    check("and it starts again", !!screenShare.stream && btn().classList.contains("on") && asked === 2);
    // Windows' own "Stop sharing" ends the track.
    screenShare.stream.getVideoTracks()[0].stop();
    screenShare.stream.getVideoTracks()[0].dispatchEvent(new Event("ended"));
    await wait(300);
    check("the screen's own Stop ends it, and the button follows", !screenShare.stream && !btn().classList.contains("on"));
    clearInterval(draw);
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
