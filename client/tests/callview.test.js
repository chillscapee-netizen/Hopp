// A DM call laid out like a voice channel: everyone's tile, a shared screen in the middle by
// itself, buttons always there, the call panel like the voice panel, and a height you drag.

(async () => {
  await inServer();
  $("home-btn").click();
  await wait(100);
  openDm(KEYS.elin);
  await wait(150);
  await startCall(KEYS.elin);
  state.call.status = "live";
  state.call.startedAt = Date.now() - 30000;
  state.call.engineReady = true;
  renderCall();
  await wait(100);
  const stage = $("call-stage");
  check("two people, two tiles, with names", stage.querySelectorAll(".voice-tile").length === 2 && stage.textContent.includes("Marcus (you)") && stage.textContent.includes("Elin"));
  check("mic, camera, screen and hang up", stage.querySelectorAll(".call-controls .call-btn").length === 4);
  check("the call panel has camera, screen and soundboard", !$("call-actions").hidden && $("call-actions").querySelectorAll(".voice-action").length === 3);
  check("the conversation is still there below", getComputedStyle(document.querySelector("#home-body")).display !== "none");

  // Elin shares her screen: it goes in the middle by itself, the others in a row.
  const c = document.createElement("canvas");
  c.width = 320;
  c.height = 180;
  c.getContext("2d").fillRect(0, 0, 320, 180);
  mediaIn.set("screen|" + KEYS.elin, { stream: c.captureStream(5) });
  renderCall();
  await wait(100);
  check("a shared screen goes in the middle", stage.querySelector(".stage-main .screen-tile") !== null && stage.querySelector(".voice-tiles.strip") !== null);
  check("with pop out, back to everyone, stop watching and full screen", stage.querySelectorAll(".stage-bar .stage-btn").length === 4);
  stage.querySelector('.stage-bar [aria-label="Show everyone"]').click();
  await wait(50);
  check("back to everyone: all tiles the same", !stage.querySelector(".stage-main") && stage.querySelectorAll(".voice-tile").length === 3);
  stage.querySelector(".screen-tile").click();
  await wait(50);
  check("clicking the screen puts it in the middle again", !!stage.querySelector(".stage-main .screen-tile"));

  mediaIn.delete("screen|" + KEYS.elin);
  callFocus = null;

  // Watched on demand: Elin says she's live, and nothing is sent until we ask to watch.
  const asked = [];
  const send = callRoom.send;
  callRoom.send = (peer, msg) => asked.push(msg.k);
  await handleMedia(KEYS.elin, { v: "m", t: "screen", d: "r", k: "live" }, callRoom);
  await wait(50);
  check("a screen being shared is offered with Watch", !!stage.querySelector(".stage-main .stream-card") && !stage.querySelector("video.tile-video:not([hidden])"));
  stage.querySelector(".stream-card").click();
  await wait(50);
  check("Watch asks for it", asked.includes("want") && wantIn.has(KEYS.elin), JSON.stringify(asked));
  check("and says it's on its way", stage.querySelector(".stage-main .screen-offer")?.textContent.includes("Connecting"));
  mediaIn.set("screen|" + KEYS.elin, { stream: c.captureStream(5) });
  renderCall();
  await wait(50);
  check("when it arrives it plays in the middle", !!stage.querySelector(".stage-main .screen-tile video"));
  stage.querySelector('.stage-bar [aria-label="Stop watching"]').click();
  await wait(50);
  check("Stop watching lets it go and offers it again", asked.includes("unwant") && !mediaIn.has("screen|" + KEYS.elin) && !!stage.querySelector(".stream-card"));
  await handleMedia(KEYS.elin, { v: "m", t: "screen", d: "r", k: "stop" }, callRoom);
  await wait(50);
  check("when she stops, the offer goes", !stage.querySelector(".stream-card") && !stage.querySelector(".screen-offer"));
  callRoom.send = send;

  // Dragging the edge changes the height, and it's kept.
  const before = stage.offsetHeight;
  stage.querySelector(".call-grip").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientY: 400 }));
  window.dispatchEvent(new MouseEvent("mousemove", { clientY: 340 }));
  window.dispatchEvent(new MouseEvent("mouseup", { clientY: 340 }));
  await wait(30);
  check("dragging its edge makes it smaller", stage.offsetHeight < before, before + " -> " + stage.offsetHeight);
  check("and the size is remembered", typeof prefs.callHeight === "number");

  mediaIn.delete("screen|" + KEYS.elin);
  endCall();
  await wait(100);
  check("hanging up clears it", stage.hidden && $("call-panel").hidden);
  report();
})();
