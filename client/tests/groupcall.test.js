// Group calls: calling a group rings everyone, people join and leave while it runs,
// someone who missed it can join later, and a call we're in elsewhere isn't rung over.

(async () => {
  for (let i = 0; i < 120 && (!state.accountConnected || $("shell").classList.contains("locked")); i++) await wait(50);
  const G = "g:0badc0de";
  emit("account", { type: "group", group: { id: G, name: "Raid crew", members: [ME, KEYS.elin, KEYS.jonas, KEYS.sara], created_at: Date.now() } });
  await wait(100);
  openDm(G);
  await wait(200);
  const btn = document.getElementById("dm-call-btn");
  check("groups have a call button", !btn.hidden);

  // Calling: the key goes sealed to each member, and our voice starts at once.
  sent.length = 0;
  btn.click();
  await wait(300);
  const rings = sent.filter((m) => m.type === "call" && m.kind === "ring");
  check("rings everyone else in the group", rings.length === 3 && rings.every((m) => m.group === G && m.sealed.startsWith("plain:")), rings.length);
  check("one key for all", new Set(rings.map((m) => m.sealed)).size === 1);
  const start = sent.find((m) => m.type === "start_call");
  check("our voice starts with our own number", start && start.me === callSession(ME));
  const id = rings[0].call_id;
  check("shows the call in the group", !document.getElementById("call-stage").hidden && document.getElementById("call-where").textContent === "Raid crew");

  // Elin answers: she joins and sends her address; we send ours to her.
  sent.length = 0;
  emit("account", { type: "call", from: KEYS.elin, group: G, call_id: id, kind: "join" });
  await wait(50);
  check("our address goes to the one who joined", sent.some((m) => m.type === "call" && m.kind === "endpoint" && m.to === KEYS.elin && m.public === "203.0.113.1:5000"));
  emit("account", { type: "call", from: KEYS.elin, group: G, call_id: id, kind: "endpoint", public: "198.51.100.2:6000", local: [] });
  await wait(50);
  const peer = sent.find((m) => m.type === "call_peer");
  check("her voice is connected", peer?.peer.session_id === callSession(KEYS.elin) && peer.peer.public === "198.51.100.2:6000");
  check("the call is live", state.call.status === "live" && document.querySelectorAll(".call-person").length === 2);

  // Jonas too; then Elin leaves and her voice is let go, the call goes on.
  emit("account", { type: "call", from: KEYS.jonas, group: G, call_id: id, kind: "join" });
  emit("account", { type: "call", from: KEYS.jonas, group: G, call_id: id, kind: "endpoint", public: "198.51.100.3:6000", local: [] });
  await wait(50);
  check("three in the call", document.querySelectorAll(".call-person").length === 3);
  emit("call-voice", { type: "speaking", session_id: callSession(KEYS.jonas), speaking: true });
  check("the one talking lights up", document.querySelector(`.call-person[data-session="${callSession(KEYS.jonas)}"]`)?.classList.contains("speaking"));
  sent.length = 0;
  emit("account", { type: "call", from: KEYS.elin, group: G, call_id: id, kind: "leave" });
  await wait(50);
  check("her voice is let go", sent.some((m) => m.type === "call_drop_peer" && m.sessionId === callSession(KEYS.elin)));
  check("the call goes on", state.call?.status === "live" && document.querySelectorAll(".call-person").length === 2);

  // We leave: everyone hears, and the group still shows the call (Jonas is in it).
  sent.length = 0;
  document.getElementById("call-hangup").click();
  await wait(100);
  const leaves = sent.filter((m) => m.type === "call" && m.kind === "leave");
  check("leaving tells the group", leaves.length === 3);
  check("the group offers to join again", !document.getElementById("call-stage").hidden && document.querySelector("#call-stage .call-btn.accept") && document.getElementById("dm-call-btn").hidden);

  // Joining again: a join to everyone, voice with the same key.
  sent.length = 0;
  document.querySelector("#call-stage .call-btn.accept").click();
  await wait(200);
  check("joins with a join", sent.filter((m) => m.type === "call" && m.kind === "join").length === 3);
  check("same call, same key", state.call?.id === id && sent.some((m) => m.type === "start_call"));
  // Jonas leaves: nobody else is left, so the call ends here too.
  emit("account", { type: "call", from: KEYS.jonas, group: G, call_id: id, kind: "leave" });
  await wait(100);
  check("alone: the call ends", !state.call && document.getElementById("call-stage").hidden);
  check("and nothing is left to join", !state.groupCalls.has(G) && !document.getElementById("dm-call-btn").hidden);

  // Someone rings the group: the card names the group and who's calling.
  emit("account", { type: "call", from: KEYS.sara, group: G, call_id: "feedbeef-2222", kind: "ring", sealed: "plain:" + "ab".repeat(32) });
  await wait(100);
  check("the ring names the group", document.getElementById("incoming-name").textContent === "Raid crew");
  check("and who's calling", document.getElementById("incoming-what").textContent === "Sara is calling the group…");
  sent.length = 0;
  document.getElementById("call-decline").click();
  await wait(100);
  check("declining isn't leaving", !sent.some((m) => m.kind === "leave"));
  check("declined, it can still be joined", !document.getElementById("call-stage").hidden && !!document.querySelector("#call-stage .call-btn.accept"));
  emit("account", { type: "call", from: KEYS.sara, group: G, call_id: "feedbeef-2222", kind: "leave" });
  await wait(50);
  check("once it's over, the join goes", document.getElementById("call-stage").hidden);

  // A call with a friend still works the old way alongside.
  check("friend calls are untouched", typeof startCall === "function" && !state.call);
  report();
})();
