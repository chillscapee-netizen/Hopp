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
  const sentVideo = [];
  commands.set_sending_video = ({ on }) => sentVideo.push(on);
  const soundTo = [];
  commands.set_stream_audio = (a) => soundTo.push(a);
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
  const rate = () => peer?.getSenders()[0]?.getParameters().encodings?.[0]?.maxBitrate;
  const params = peer?.getSenders()[0]?.getParameters();
  check("the computer's sound goes to whoever watches", soundTo.some((x) => !x.call && x.watchers?.includes(viewer.session_id)), JSON.stringify(soundTo));
  setShareSound(false);
  check("and stops when you turn the sound off", soundTo.at(-1)?.watchers === null, JSON.stringify(soundTo.at(-1)));
  setShareSound(true);
  check("sent at high quality", params?.encodings?.[0]?.maxBitrate === 4_500_000, JSON.stringify(params?.encodings));

  // Voice comes first: when it strains while video is sent, the video shrinks; when voice is fine again, it grows back.
  emit("voice", { type: "peer_quality", session_id: viewer.session_id, rtt_ms: 40, loss: 0, relayed: false });
  await wait(30);
  check("voice doing fine leaves the video alone", rate() === 4_500_000 && videoBudget() === 1);
  emit("voice", { type: "peer_quality", session_id: viewer.session_id, rtt_ms: 190, loss: 0, relayed: false });
  await wait(30);
  check("one bad second changes nothing", videoBudget() === 1);
  emit("voice", { type: "peer_quality", session_id: viewer.session_id, rtt_ms: 40, loss: 4, relayed: false });
  emit("voice", { type: "peer_quality", session_id: viewer.session_id, rtt_ms: 40, loss: 4, relayed: false });
  await wait(30);
  check("a little steady loss changes nothing either", videoBudget() === 1);
  for (let i = 0; i < 20; i++) emit("voice", { type: "peer_quality", session_id: viewer.session_id, rtt_ms: 190, loss: 10, relayed: false });
  await wait(60);
  check("voice clearly straining makes the video smaller, but never broken", videoBudget() === VIDEO_BUDGET_MIN && rate() === Math.round(4_500_000 * VIDEO_BUDGET_MIN), videoBudget() + " " + rate());
  check("and your own stream says why", $("screen-info").textContent.includes("making room for voice") || !watching?.local, $("screen-info").textContent);
  setShareQuality({ rate: 30 });
  await wait(30);
  check("picking a quality yourself gives it all its room again", videoBudget() === 1 && rate() === 4_500_000, videoBudget() + " " + rate());
  for (let i = 0; i < 4; i++) emit("voice", { type: "peer_quality", session_id: viewer.session_id, rtt_ms: 190, loss: 10, relayed: false });
  for (let i = 0; i < 40; i++) emit("voice", { type: "peer_quality", session_id: viewer.session_id, rtt_ms: 42, loss: 0, relayed: false });
  await wait(60);
  check("voice fine again: the video gets its room back by itself", videoBudget() === 1 && rate() === 4_500_000, videoBudget() + " " + rate());

  // The queue on our way out, watched closely while we send video: video gives way at once.
  check("voice is told we send video", sentVideo.at(-1) === true, JSON.stringify(sentVideo));
  setShareQuality({ rate: 30 });
  for (let i = 0; i < 4; i++) emit("voice", { type: "queue_delay", ms: 5 });
  await wait(20);
  check("an empty queue changes nothing", videoBudget() === 1);
  emit("voice", { type: "queue_delay", ms: 45 });
  await wait(20);
  check("one reading over isn't enough", videoBudget() === 1);
  emit("voice", { type: "queue_delay", ms: 50 });
  await wait(30);
  check("a queue building up steps the video down at once", Math.abs(videoBudget() - 0.85) < 0.001 && rate() === Math.round(4_500_000 * 0.85), videoBudget() + " " + rate());
  emit("voice", { type: "queue_delay", ms: 50 });
  emit("voice", { type: "queue_delay", ms: 50 });
  await wait(20);
  check("then waits for the cut to show before cutting again", Math.abs(videoBudget() - 0.85) < 0.001);
  voiceGuard.held = 0;
  for (let i = 0; i < 20; i++) emit("voice", { type: "queue_delay", ms: 4 });
  await wait(30);
  check("an empty queue lets it creep back up", videoBudget() > 0.85, String(videoBudget()));
  setShareQuality({ rate: 30 });

  // The quality menu: one size and one rate, each picked like a round button.
  openShareQuality(400, 400);
  await wait(30);
  const radios = document.querySelectorAll("#server-menu .menu-item.checked");
  check("one size and one rate are marked, never more", radios.length === 2 && document.querySelectorAll("#server-menu .menu-check").length === 1, String(radios.length));
  [...document.querySelectorAll("#server-menu .menu-item")].find((b) => b.textContent.startsWith("720p")).click();
  await wait(30);
  check("picking one closes the menu and uses it", $("server-menu").hidden && prefs.shareQuality.size === "720");
  setShareQuality({ size: "1080" });

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
