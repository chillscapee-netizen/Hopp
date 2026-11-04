// Things that involve other people: unread and mentions, invites, calls and groups.

(async () => {
  await inServer();
  const crew = prefs.servers[0];

  // A message in another channel: a dot, no red count, no sound.
  emit("chat", { id: 9100, channel: 3, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "new clip", sent_at: Date.now() });
  await wait(250);
  const clips = () => [...document.querySelectorAll(".channel-row")].find((r) => r.textContent.includes("clips"));
  check("other channel turns unread", clips().classList.contains("unread"));
  check("no red count without a mention", !clips().querySelector(".count-badge"));

  // A mention: a red count on the channel and the server.
  emit("chat", { id: 9101, channel: 3, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: `look <@${ME}>`, sent_at: Date.now() });
  await wait(250);
  check("mention counts on the channel", clips().querySelector(".count-badge")?.textContent === "1");
  check("mention counts on the server", document.querySelector('#server-list .rail-item[data-server="a"] .rail-badge')?.textContent === "1");

  // Opening the channel reads it and shows where you stopped.
  clips().click();
  await wait(250);
  check("the New line shows", !!document.querySelector(".new-divider"));
  check("opening reads it", !clips().classList.contains("unread") && !clips().querySelector(".count-badge"));
  check("the mention is highlighted", !!document.querySelector('.msg[data-id="9101"].mentions-me'));
  check("the mention reads as a name", [...document.querySelectorAll(".mention.me")].some((n) => n.textContent === "@Marcus"));

  // A reply to you counts like a mention.
  [...document.querySelectorAll(".channel-row")].find((r) => r.textContent.includes("general")).click();
  await wait(200);
  emit("chat", { id: 9102, channel: 4, sender: 4, sender_name: "Sara", author_key: KEYS.sara, text: "agreed", sent_at: Date.now(), reply: { id: 1, sender_name: "Marcus", author_key: ME, text: "ranked?" } });
  await wait(250);
  const lfg = [...document.querySelectorAll(".channel-row")].find((r) => r.textContent.includes("lfg"));
  check("a reply to you counts as a mention", lfg.querySelector(".count-badge")?.textContent === "1");

  // A muted channel shows nothing.
  setChannelMuted(crew.address, 4, true);
  await wait(100);
  check("muted channel shows no unread", !lfg.isConnected || ![...document.querySelectorAll(".channel-row")].find((r) => r.textContent.includes("lfg")).classList.contains("unread"));
  setChannelMuted(crew.address, 4, false);

  // Invites: a card with the server and a Join button, for every link form.
  for (const [label, text] of [
    ["web link", "https://hopp-cloud.hoppchat.workers.dev/i/K7P2QX9M"],
    ["old web link", "https://strom-cloud.strom-chat.workers.dev/i/K7P2QX9M"],
    ["hopp link", "hopp://K7P2QX9M"],
    ["long cloud link", "hopp://cloud/abc123def456/K7P2QX9M"],
  ]) {
    const id = 9200 + label.length;
    emit("chat", { id, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text, sent_at: Date.now() });
    await wait(250);
    const node = document.querySelector(`.msg[data-id="${id}"]`);
    check(`invite card: ${label}`, node?.querySelector(".invite-card .invite-join")?.textContent === "Join", node?.querySelector(".invite-card")?.textContent?.slice(0, 40) ?? "no card");
    check(`no raw address: ${label}`, !node?.querySelector(".msg-text"));
  }

  // Answering a call starts voice and tells the caller where to reach us.
  document.getElementById("home-btn").click();
  await wait(200);
  emit("account", { type: "call", from: KEYS.elin, kind: "ring", call_id: "aaaabbbb-1111", sealed: "plain:" + "cd".repeat(32) });
  await wait(200);
  document.getElementById("call-accept").click();
  await wait(300);
  check("answer sent", sent.some((m) => m.type === "call" && m.kind === "answer"));
  check("our address sent", sent.some((m) => m.type === "call" && m.kind === "endpoint"));
  emit("account", { type: "call", from: KEYS.elin, kind: "end", call_id: "aaaabbbb-1111" });
  await wait(150);
  check("the call ends when they hang up", !state.call && document.getElementById("call-panel").hidden);

  // A group message is sealed once per member.
  emit("account", { type: "group", group: { id: "g:00112233", name: "Raid crew", members: [ME, KEYS.elin, KEYS.jonas], created_at: Date.now() } });
  await wait(150);
  openDm("g:00112233");
  await wait(200);
  const input = document.getElementById("dm-input");
  input.value = "hi all";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(250);
  const groupMsg = sent.find((m) => m.type === "group_send");
  check("group message sealed for each member", groupMsg && Object.keys(groupMsg.sealed).length === 3);
  report();
})();
