// Every sound Hopp plays is listed with why, under Settings → Notifications → Recent sounds.
// And nothing pops up to confirm what you just did yourself.
(async () => {
  await inServer();
  soundLog.length = 0;
  openSettings("notifications");
  await wait(80);
  check("nothing played yet: it says so", document.querySelector("#sound-log .empty") !== null);
  $("settings").close();

  // A DM from a friend while looking at a server.
  emit("account", { type: "dm", with: KEYS.sara, message: { id: "sl1", from_key: KEYS.sara, sealed: "plain:hello", sent_at: Date.now() } });
  await wait(150);
  check("a message sound is noted with who wrote", /Sara sent you a message/.test(soundLog[0]?.why ?? ""), soundLog[0]?.why);

  // Someone joins your voice channel.
  const r = structuredClone(state.roster);
  r.users.find((u) => u.session_id === r.me).voice_channel = 1;
  emit("roster", r);
  await wait(50);
  const r2 = structuredClone(r);
  r2.users.find((u) => u.name === "Sara").voice_channel = 1;
  emit("roster", r2);
  await wait(50);
  check("joining voice and someone joining you are noted, by name", soundLog.some((x) => x.why === "You joined voice") && soundLog[0].why === "Sara joined your voice channel", soundLog.map((x) => x.why).join(" | "));
  const r3 = structuredClone(r2);
  r3.users.find((u) => u.name === "Sara").voice_channel = null;
  emit("roster", r3);
  await wait(50);
  check("and who left", soundLog[0].why === "Sara left your voice channel", soundLog[0].why);

  // Moved to another channel: that's joining somewhere new, and it sounds like it.
  const gaming = state.roster.channels.find((c) => c.name === "Gaming");
  const rm = structuredClone(r3);
  rm.users.find((u) => u.session_id === rm.me).voice_channel = gaming.id;
  emit("roster", rm);
  await wait(50);
  check("moving to another channel plays the join sound", soundLog[0].why === "You moved to Gaming", soundLog[0].why);
  emit("roster", r3);
  await wait(50);

  // A lost connection while only reading: no sound, nothing listed.
  const before = soundLog.length;
  const r4 = structuredClone(r3);
  r4.users.find((u) => u.session_id === r4.me).voice_channel = null;
  emit("roster", r4);
  await wait(50);
  const afterLeave = soundLog.length;
  emit("disconnected", "lost connection to server");
  await wait(80);
  check("a blink in the connection while reading plays nothing", soundLog.length === afterLeave && afterLeave === before + 1, `${before} ${afterLeave} ${soundLog.length}`);

  openSettings("notifications");
  await wait(80);
  const rows = [...document.querySelectorAll("#sound-log li")];
  check("the list shows them, newest first, with the time", rows.length === soundLog.length && /^\d{1,2}[:.]\d{2}/.test(rows[0].querySelector("time")?.textContent ?? "") && rows[0].textContent.includes("You left voice"), rows[0]?.textContent);
  report();
})();
