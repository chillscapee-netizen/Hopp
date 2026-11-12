// Connection bars in the voice channel: nothing while it's good, bars when it isn't,
// the numbers on the profile card, and all of it gone after leaving voice.

(async () => {
  await inServer();
  // Join the Lobby, where others already are.
  const r = structuredClone(state.roster);
  r.users.find((u) => u.session_id === r.me).voice_channel = 1;
  emit("roster", r);
  await wait(100);
  const other = state.roster.users.find((u) => u.session_id !== r.me && u.voice_channel === 1);
  const row = () => [...document.querySelectorAll(".voice-user")].find((el) => el.textContent.includes(other.name));
  check("someone else is in voice with us", !!other && !!row());

  emit("voice", { type: "peer_quality", session_id: other.session_id, rtt_ms: 35, loss: 0 });
  await wait(50);
  check("a good connection shows nothing", !row().querySelector(".signal-bars"));

  emit("voice", { type: "peer_quality", session_id: other.session_id, rtt_ms: 180, loss: 4 });
  await wait(50);
  let bars = row().querySelector(".signal-bars");
  check("an okay one shows yellow bars", bars?.classList.contains("fair"));
  check("two of three lit", bars?.querySelectorAll("i.on").length === 2);
  check("the tooltip has the numbers", bars?.dataset.tip === "Okay connection: 90 ms, 4% lost", bars?.dataset.tip);

  // The same grade again doesn't redraw the list.
  const drawn = row();
  emit("voice", { type: "peer_quality", session_id: other.session_id, rtt_ms: 190, loss: 5 });
  await wait(50);
  check("no redraw while the grade stays", row() === drawn);

  emit("voice", { type: "peer_quality", session_id: other.session_id, rtt_ms: 90, loss: 22 });
  await wait(50);
  bars = row().querySelector(".signal-bars");
  check("a weak one shows red, one bar lit", bars?.classList.contains("poor") && bars.querySelectorAll("i.on").length === 1);

  // The profile card says it in words, and keeps up.
  row().click();
  await wait(50);
  const line = document.getElementById("user-card-connection");
  check("the card shows the connection", !line.hidden && line.textContent === "Weak connection: 45 ms, 22% lost", line.textContent);
  emit("voice", { type: "peer_quality", session_id: other.session_id, rtt_ms: 40, loss: 0 });
  await wait(50);
  check("and follows it", line.textContent === "Good connection: 20 ms", line.textContent);
  check("good again: the bars go", !row().querySelector(".signal-bars"));
  closePopovers();

  // Leaving voice forgets it all.
  const out = structuredClone(state.roster);
  out.users.find((u) => u.session_id === out.me).voice_channel = null;
  emit("roster", out);
  await wait(50);
  check("forgotten after leaving voice", state.quality.size === 0);
  report();
})();
