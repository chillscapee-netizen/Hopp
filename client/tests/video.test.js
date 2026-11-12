// real-time: 60000
// Camera video in a voice channel and in a call, and screens in calls, over real WebRTC
// (the handshakes come back to this page, so it plays both sides).

(async () => {
  try {
  await inServer();
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const g = canvas.getContext("2d");
  let frame = 0;
  const draw = setInterval(() => {
    g.fillStyle = `hsl(${(frame += 7) % 360} 50% 45%)`;
    g.fillRect(0, 0, 320, 180);
  }, 33);
  navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(30);
  navigator.mediaDevices.getDisplayMedia = async () => canvas.captureStream(30);
  const playing = async (sel) => {
    for (let i = 0; i < 100; i++) {
      const v = document.querySelector(sel);
      if (v?.videoWidth > 0) return v;
      await wait(100);
    }
    return null;
  };

  // In a voice channel.
  const r = structuredClone(state.roster);
  r.features = ["search", "screen", "voice-chat", "voice-mod"];
  r.users.find((u) => u.session_id === r.me).voice_channel = 1;
  emit("roster", r);
  await wait(100);
  openTextChannel(1);
  await wait(100);
  const cam = document.getElementById("cam-btn");
  check("in voice, there's a camera button", !cam.hidden);
  cam.click();
  await wait(200);
  check("it turns on", cam.classList.contains("on") && !!media.out.cam);
  const me = document.querySelector(`.voice-tile[data-user="${state.roster.me}"] video`);
  check("you see yourself, mirrored", !!me && me.classList.contains("mirror"));
  const elin = state.roster.users.find((u) => u.name === "Elin");
  const theirs = await playing(`.voice-tile[data-user="${elin.session_id}"] video`);
  check("the others' cameras arrive over a real connection", theirs?.videoWidth === 320, String(theirs?.videoWidth));
  document.querySelector(`.voice-tile[data-user="${elin.session_id}"]`).click();
  await wait(50);
  check("clicking a camera focuses it", document.querySelector(".stage-main .voice-tile.focus")?.dataset.user === String(elin.session_id) && !!document.querySelector(".voice-tiles.strip"));
  check("with pop out and back-to-everyone buttons", document.querySelectorAll(".stage-bar .stage-btn").length === 3);
  document.querySelector(`.voice-tile[data-user="${elin.session_id}"]`).click();
  await wait(50);
  check("and again shows everyone", !document.querySelector(".stage-main") && !document.querySelector(".voice-tiles.strip"));
  cam.click();
  await wait(300);
  check("turning it off stops it for everyone", !media.out.cam && !document.querySelector(`.voice-tile[data-user="${elin.session_id}"] video`));

  // Leaving voice ends your camera.
  cam.click();
  await wait(200);
  const out = structuredClone(state.roster);
  out.users.find((u) => u.session_id === out.me).voice_channel = null;
  emit("roster", out);
  await wait(100);
  check("leaving voice turns the camera off", !media.out.cam && mediaIn.size === 0);

  // In a call.
  document.getElementById("home-btn").click();
  await wait(100);
  emit("account", { type: "call", from: KEYS.elin, kind: "ring", call_id: "abcdabcd-1111", sealed: "plain:" + "cd".repeat(32) });
  await wait(150);
  document.getElementById("call-accept").click();
  await wait(300);
  const callButtons = () => document.querySelectorAll("#call-stage .call-btn.media");
  const callCam = callButtons()[1];
  check("calls have mic, camera and screen buttons", callButtons().length === 3);
  callCam.click();
  const elinCam = await playing(`#call-stage .call-person[data-session="1"] video`);
  check("a camera in a call arrives", elinCam?.videoWidth === 320, String(elinCam?.videoWidth));
  callButtons()[2].click();
  const screen = await playing("#call-stage .screen-tile video");
  check("a shared screen in a call shows big", !!screen);
  // On demand: the other side hears we're live, and gets the screen only after Watch.
  for (let i = 0; i < 30 && !document.querySelector("#call-stage .stream-card, #call-stage .screen-offer"); i++) await wait(100);
  check("the other side is offered it, not sent it", liveIn.has(KEYS.elin) && !mediaIn.has("screen|" + KEYS.elin) && media.out.screen.peers.size === 0);
  watchCallScreen(KEYS.elin);
  let theirScreen = null;
  for (let i = 0; i < 100 && !theirScreen; i++) {
    const v = mediaIn.get("screen|" + KEYS.elin)?.stream;
    if (v) theirScreen = v;
    await wait(100);
  }
  check("Watch brings it over a real connection", !!theirScreen && media.out.screen.peers.size === 1);
  stopWatchingCallScreen(KEYS.elin);
  await wait(300);
  check("Stop watching closes it on both sides", !mediaIn.has("screen|" + KEYS.elin) && media.out.screen.peers.size === 0);
  emit("account", { type: "call", from: KEYS.elin, kind: "end", call_id: "abcdabcd-1111" });
  await wait(200);
  check("the call ending ends its video", Object.keys(media.out).length === 0 && mediaIn.size === 0);
  clearInterval(draw);
  } catch (err) {
    check("no crash", false, err.stack);
  }
  report();
})();
