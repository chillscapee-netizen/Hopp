// Moderation: timeouts, slowmode, bans that delete history, the audit log.

(async () => {
  await inServer();
  const r = structuredClone(state.roster);
  r.features = ["search", "screen", "voice-chat", "voice-mod", "voice-settings", "mod-tools"];
  emit("roster", r);
  await wait(100);
  for (const c of ["timeout_member", "kick", "update_channel", "get_audit_log"]) commands[c] = (a) => sent.push({ type: c, ...a });

  // Timing someone out from their menu.
  const sara = state.roster.users.find((u) => u.name === "Sara");
  [...document.querySelectorAll("li.member, .member")].find((x) => x.textContent.includes("Sara")).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 600, clientY: 200 }));
  await wait(30);
  const item = (t) => [...document.querySelectorAll("#server-menu .menu-item, #server-submenu .menu-item")].find((b) => b.textContent.trim() === t);
  item("Moderation").dispatchEvent(new MouseEvent("mouseenter"));
  await wait(20);
  check("Moderation folds out timeout, kick and ban", ["Timeout Sara", "Kick Sara"].every((t) => !!item(t)));
  item("Timeout Sara").click();
  await wait(50);
  const lengths = [...document.getElementById("confirm-choice").options].map((o) => o.textContent);
  check("Timeout asks how long", !document.getElementById("confirm-choice-row").hidden && ["60 seconds", "10 minutes", "1 week"].every((t) => lengths.includes(t)));
  sent.length = 0;
  document.getElementById("confirm-ok").click();
  await wait(50);
  check("choosing one times them out", sent.some((m) => m.type === "timeout_member" && m.sessionId === sara.session_id && m.minutes === 10));

  // Timed out yourself: the box says so and won't take text.
  const me = structuredClone(state.roster);
  me.users.find((u) => u.session_id === me.me).timed_out_until = Date.now() + 600_000;
  emit("roster", me);
  await wait(50);
  const box = document.getElementById("chat-input");
  check("timed out, you can't write", box.disabled && box.placeholder.startsWith("You're timed out until"));
  const back = structuredClone(state.roster);
  delete back.users.find((u) => u.session_id === back.me).timed_out_until;
  emit("roster", back);
  await wait(50);
  check("and can again after", !box.disabled);

  // Slowmode: shown in the box, and a second message waits (moderators aren't held to it, so act as a member).
  const slow = structuredClone(state.roster);
  slow.channels.find((c) => c.id === 0).slowmode = 30;
  slow.users.find((u) => u.session_id === slow.me).owner = false;
  emit("roster", slow);
  await wait(50);
  check("slowmode shows in the box", box.placeholder.includes("slowmode 30 s"));
  box.value = "first";
  box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(100);
  box.value = "second";
  box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(100);
  check("a second message waits", box.value === "second" && document.body.textContent.includes("Slowmode is on here"));
  const owner = structuredClone(state.roster);
  owner.users.find((u) => u.session_id === owner.me).owner = true;
  owner.channels.find((c) => c.id === 0).slowmode = undefined;
  emit("roster", owner);
  await wait(50);

  // Banning asks whether to delete their messages.
  cardUser = sara;
  removeUser(true);
  await wait(50);
  check("a ban offers to delete their messages", !document.getElementById("confirm-choice-row").hidden);
  document.getElementById("confirm-choice").value = "24";
  sent.length = 0;
  document.getElementById("confirm-ok").click();
  await wait(50);
  check("and sends the choice", sent.some((m) => m.type === "kick" && m.ban && m.deleteHours === 24));

  // The audit log.
  openServerSettings?.();
  await wait(50);
  showServerTab("audit");
  emit("audit-log", [{ at: Date.now(), actor: "Marcus", action: "timeout", target: "Sara", detail: "10 minutes" }]);
  await wait(30);
  check("the audit log says who did what", document.getElementById("audit-list").textContent.includes("Marcus timed out Sara · 10 minutes"));
  report();
})();
