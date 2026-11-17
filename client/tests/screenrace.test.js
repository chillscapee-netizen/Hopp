// real-time: 40000
// Watching a screen when it's offered again (the one sharing restarts the connection): the new
// connection's addresses arrive while it's still being set up, and none may be lost. Through
// the relay there are only one or two of them, so losing them meant no picture at all.

(async () => {
  await inServer();
  prefs.hideIp = false;
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const g = canvas.getContext("2d");
  let frame = 0;
  const draw = setInterval(() => {
    g.fillStyle = `hsl(${frame++ % 360} 60% 40%)`;
    g.fillRect(0, 0, 320, 180);
  }, 33);
  commands.set_sending_video = () => null;
  commands.set_stream_audio = () => null;
  navigator.mediaDevices.getDisplayMedia = async () => canvas.captureStream(30);

  const r = structuredClone(state.roster);
  r.features = ["search", "screen"];
  r.users.find((u) => u.session_id === r.me).voice_channel = 1;
  emit("roster", r);
  await wait(100);
  document.getElementById("share-btn").click();
  await wait(200);
  stopWatching();
  const viewer = state.roster.users.find((u) => u.session_id !== state.roster.me && u.voice_channel === 1);
  const rv = structuredClone(state.roster);
  rv.users.find((u) => u.session_id === viewer.session_id).sharing = true;
  emit("roster", rv);
  await wait(50);
  const video = document.getElementById("screen-video");
  watchScreen(viewer.session_id);
  for (let i = 0; i < 80 && !(video.videoWidth > 0); i++) await wait(100);
  check("watching at first", video.videoWidth === 320);

  // Setting up a connection now takes a moment (as when the relay sign-in is fetched), and the
  // one sharing offers again: its addresses come in meanwhile.
  const quick = rtcConfig;
  window.rtcConfig = async () => {
    await wait(400);
    return quick();
  };
  const first = watching.pc;
  const added = new Map();
  const add = RTCPeerConnection.prototype.addIceCandidate;
  RTCPeerConnection.prototype.addIceCandidate = function (c) {
    added.set(this, (added.get(this) ?? 0) + 1);
    return add.call(this, c);
  };
  added.clear();
  serveViewer(viewer.session_id);
  for (let i = 0; i < 100 && !(watching?.pc && watching.pc !== first && watching.pc.connectionState === "connected"); i++) await wait(100);
  check("the new connection connects", watching?.pc !== first && watching?.pc?.connectionState === "connected", watching?.pc?.connectionState);
  // Over the relay the other side can't be found any other way: every address must reach the new one.
  check("no address went to the old, closed connection", !added.get(first), String(added.get(first)));
  check("they all reached the new one", (added.get(watching?.pc) ?? 0) > 0, String(added.get(watching?.pc)));
  RTCPeerConnection.prototype.addIceCandidate = add;
  window.rtcConfig = quick;
  clearInterval(draw);
  stopShare();
  report();
})();
