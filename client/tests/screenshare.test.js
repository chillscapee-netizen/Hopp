// real-time: 40000
// Screen sharing: the button in voice, LIVE on whoever shares, watching over real WebRTC
// (this page plays both sides: its handshakes come back to it), and stopping cleanly.

(async () => {
  await inServer();
  // A "screen": a moving picture on a canvas stands in for the real one.
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const g = canvas.getContext("2d");
  let frame = 0;
  const draw = setInterval(() => {
    g.fillStyle = `hsl(${frame++ % 360} 60% 40%)`;
    g.fillRect(0, 0, 640, 360);
  }, 33);
  let asked = 0;
  navigator.mediaDevices.getDisplayMedia = async () => {
    asked++;
    return canvas.captureStream(30);
  };

  const r = structuredClone(state.roster);
  r.features = ["search", "screen"];
  r.users.find((u) => u.session_id === r.me).voice_channel = 1;
  emit("roster", r);
  await wait(100);
  const btn = document.getElementById("share-btn");
  check("in voice, the share button is there", !btn.hidden);

  btn.click();
  await wait(200);
  check("it asks which screen", asked === 1);
  check("and tells the server", sent.some((m) => m.type === "set_sharing" && m.on));
  check("the button shows it's on", btn.classList.contains("on") && document.getElementById("voice-where").textContent.startsWith("Sharing your screen"));
  const myRow = document.querySelector(`.voice-user[data-user="${state.roster.me}"]`);
  check("LIVE shows on your own name", !!myRow?.querySelector(".live-pill"));

  // Your own stream shows at once, straight from your screen.
  const video = document.getElementById("screen-video");
  check("you see your own stream", !document.getElementById("screen-stage").hidden && video.srcObject === screenShare.stream && document.getElementById("screen-who").textContent.startsWith("Your screen"));
  check("without a connection to yourself", screenShare.peers.size === 0);
  document.getElementById("screen-close").click();
  myRow.querySelector(".live-pill").click();
  await wait(50);
  check("your own LIVE opens it again", !document.getElementById("screen-stage").hidden && watching?.local);
  stopWatching();

  // Someone watching it over a real connection: the handshakes come back to this page as if
  // from Elin, so this page is both the one sharing and the one watching.
  const viewer = state.roster.users.find((u) => u.session_id !== state.roster.me && u.voice_channel === 1);
  const rv = structuredClone(state.roster);
  rv.users.find((u) => u.session_id === viewer.session_id).sharing = true;
  emit("roster", rv);
  await wait(50);
  watchScreen(viewer.session_id);
  for (let i = 0; i < 80 && !(video.videoWidth > 0); i++) await wait(100);
  check("the screen arrives over a real connection", video.videoWidth === 640, `${video.videoWidth}x${video.videoHeight}`);
  check("shown above the chat", !document.getElementById("screen-stage").hidden && document.getElementById("screen-who").textContent.endsWith("'s screen"));
  check("'Connecting…' goes once it plays", document.getElementById("screen-wait").hidden);
  const peer = screenShare.peers.get(viewer.session_id);
  const params = peer?.getSenders()[0]?.getParameters();
  check("sent at high quality", params?.encodings?.[0]?.maxBitrate === 6_000_000, JSON.stringify(params?.encodings));

  // Stopping: the viewer is told, the server too.
  sent.length = 0;
  btn.click();
  await wait(300);
  check("stopping tells the viewer", document.getElementById("screen-stage").hidden && !watching);
  check("and the server", sent.some((m) => m.type === "set_sharing" && m.on === false));
  check("and lets the screen go", !screenShare.stream && screenShare.peers.size === 0);

  // Someone else shares: LIVE on their name, a click asks to watch.
  const elin = state.roster.users.find((u) => u.session_id !== state.roster.me && u.voice_channel === 1);
  const r2 = structuredClone(state.roster);
  r2.users.find((u) => u.session_id === elin.session_id).sharing = true;
  emit("roster", r2);
  await wait(100);
  const live = document.querySelector(`.voice-user[data-user="${elin.session_id}"] .live-pill`);
  check("LIVE on whoever shares", !!live);
  sent.length = 0;
  live.click();
  await wait(50);
  const ask = sent.find((m) => m.type === "screen_signal");
  check("a click asks them for their screen", ask?.to === elin.session_id && JSON.parse(ask.data).k === "watch");
  check("the stage waits for it", !document.getElementById("screen-stage").hidden && !document.getElementById("screen-wait").hidden);
  // They stop: the stage goes.
  const r3 = structuredClone(state.roster);
  r3.users.find((u) => u.session_id === elin.session_id).sharing = false;
  emit("roster", r3);
  await wait(100);
  check("when they stop, the stage goes", document.getElementById("screen-stage").hidden && !watching);

  // Leaving voice ends your sharing too.
  btn.click();
  await wait(200);
  const out = structuredClone(state.roster);
  out.users.find((u) => u.session_id === out.me).voice_channel = null;
  emit("roster", out);
  await wait(100);
  check("leaving voice stops sharing", !screenShare.stream && document.getElementById("voice-panel").hidden, `stream=${!!screenShare.stream}`);
  clearInterval(draw);
  report();
})();
