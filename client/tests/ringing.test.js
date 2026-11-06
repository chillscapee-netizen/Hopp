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
  report();
})();
