// The voice relay: asked for when the engine needs it, handed to the engines.

(async () => {
  await inServer();
  sent.length = 0;
  emit("voice", { type: "need_relay" });
  await wait(100);
  check("asks the account for a relay login", sent.some((m) => m.type === "turn_login"));
  check("hands the login to the engines", sent.some((m) => m.type === "set_relay" && m.login.server === "turn.example:3478"));

  // A second request reuses the login instead of asking again.
  sent.length = 0;
  emit("call-voice", { type: "need_relay" });
  await wait(100);
  check("reuses the login", !sent.some((m) => m.type === "turn_login") && sent.some((m) => m.type === "set_relay"));

  // Someone unreachable: no scary message at once, the relay gets its chance first.
  emit("voice", { type: "peer_reach", session_id: 2, reachable: false });
  await wait(200);
  check("no warning while the relay tries", !document.body.textContent.includes("so you can't hear each other"));
  emit("voice", { type: "peer_reach", session_id: 2, reachable: true });
  report();
})();
