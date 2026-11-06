// Calling someone who answers "busy" (or "offline") at once never leaves the ringing going.
(async () => {
  await inServer();
  $("home-btn").click();
  await wait(100);
  // Their answer arrives before the ring has even been sent off.
  const send = commands.account_send;
  commands.account_send = (a) => {
    if (a.msg.type === "call" && a.msg.kind === "ring") emit("account", { type: "call", from: a.msg.to, kind: "busy", call_id: a.msg.call_id });
    return send(a);
  };
  openDm(KEYS.elin);
  await wait(100);
  await startCall(KEYS.elin);
  await wait(100);
  check("the call is over", !state.call);
  check("and nothing rings", !state.ringTimer);
  commands.account_send = send;

  // An answered call stops ringing even if a timer was left.
  await startCall(KEYS.elin);
  await wait(50);
  check("calling rings", !!state.ringTimer);
  state.call.status = "live";
  await wait(3200);
  check("once answered, the ringing stops by itself", !state.ringTimer);
  await endCall();

  // A friend whose app closed mid-call rings again: the old call is over, the new one rings.
  emit("account", { type: "call", from: KEYS.elin, kind: "ring", call_id: "aaaa1111-0001", sealed: "plain:" + "cd".repeat(32) });
  await wait(100);
  state.call.status = "live";
  const busy = [];
  commands.account_send = (a) => { if (a.msg.kind === "busy") busy.push(a); return send(a); };
  emit("account", { type: "call", from: KEYS.elin, kind: "ring", call_id: "aaaa1111-0002", sealed: "plain:" + "cd".repeat(32) });
  await wait(150);
  check("the same friend ringing again replaces the lost call", state.call?.id === "aaaa1111-0002" && state.call.status === "ringing" && !busy.length);
  emit("account", { type: "call", from: KEYS.jonas, kind: "ring", call_id: "bbbb2222-0001", sealed: "plain:" + "cd".repeat(32) });
  await wait(100);
  check("someone else ringing then hears busy", busy.length === 1 && state.call.id === "aaaa1111-0002");
  commands.account_send = send;
  await endCall();
  report();
})();
