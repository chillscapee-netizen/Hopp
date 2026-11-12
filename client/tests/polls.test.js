// Polls: made from the + menu, shown as a card; voting is a "poll:<n>" reaction, results show
// once you've voted or it's closed, and votes never show as reaction chips.

(async () => {
  await inServer();
  const r = structuredClone(state.roster);
  r.features = [...(r.features ?? []), "polls"];
  emit("roster", r);
  await wait(60);
  const sent = [];
  commands.send_chat = (a) => sent.push(a.text);
  const reacted = [];
  commands.react = (a) => reacted.push(a);

  // The + button offers a poll.
  $("attach-btn").click();
  await wait(50);
  const item = [...document.querySelectorAll(".menu-item, [role=menuitem], .menu button")].find((b) => b.textContent.includes("Create a poll"));
  check("the + menu offers a poll", !!item);
  item?.click();
  await wait(50);
  check("the poll dialog opens with two answers", $("poll-dialog").open && $("poll-answers").querySelectorAll("input").length === 2);
  $("poll-post").click();
  await wait(30);
  check("a question is needed", !$("poll-error").hidden && $("poll-dialog").open);
  $("poll-question").value = "What tonight?";
  const inputs = $("poll-answers").querySelectorAll("input");
  inputs[0].value = "Raid";
  inputs[1].value = "Arena";
  $("poll-add").click();
  $("poll-answers").querySelectorAll("input")[2].value = "Sleep";
  $("poll-multi").checked = true;
  $("poll-post").click();
  await wait(50);
  const p = pollOf(sent.at(-1));
  check("posting sends the poll", !$("poll-dialog").open && p?.question === "What tonight?" && p.answers.join() === "Raid,Arena,Sleep" && p.multi && p.end > Date.now() + 23 * 3_600_000, sent.at(-1));

  // Shown as a card, without results until you vote.
  emit("chat", { id: 9950, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: sent.at(-1), sent_at: Date.now() });
  await wait(80);
  const card = () => document.querySelector('.msg[data-id="9950"] .poll');
  check("a poll shows as a card", !!card() && card().textContent.includes("What tonight?") && card().querySelectorAll(".poll-answer").length === 3);
  check("no results before you vote", !card().querySelector(".poll-share"));
  card().querySelectorAll(".poll-answer")[1].click();
  await wait(30);
  check("an answer votes", reacted.at(-1)?.emoji === "poll:1" && reacted.at(-1)?.on === true, JSON.stringify(reacted.at(-1)));
  emit("reactions", { channel: 0, id: 9950, reactions: [{ emoji: "poll:1", keys: [ME, KEYS.elin] }, { emoji: "poll:0", keys: [KEYS.elin] }, { emoji: "🔥", keys: [KEYS.elin] }] });
  await wait(60);
  const shares = [...card().querySelectorAll(".poll-share")].map((n) => n.textContent);
  check("after voting the results show", shares.join() === "50%,100%,0%", shares.join());
  check("your answer is marked", card().querySelectorAll(".poll-answer")[1].classList.contains("mine"));
  check("votes aren't reaction chips", [...document.querySelectorAll('.msg[data-id="9950"] .reaction:not(.add)')].length === 1);
  check("it says how many voted", card().querySelector(".poll-foot").textContent.startsWith("2 votes"));
  check("previews say it's a poll", previewText(sent.at(-1)) === "📊 What tonight?");

  // Closed: results for everyone, no voting.
  const old = "hopp-poll:" + base64url(JSON.stringify({ q: "Old one", a: ["Yes", "No"], end: Date.now() - 1000 }));
  emit("chat", { id: 9951, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: old, sent_at: Date.now(), reactions: [{ emoji: "poll:0", keys: [KEYS.elin] }] });
  await wait(80);
  const closed = document.querySelector('.msg[data-id="9951"] .poll');
  check("a closed poll shows results and can't be voted on", closed.querySelector(".poll-foot").textContent.includes("Closed") && closed.querySelector(".poll-answer").disabled && closed.querySelector(".poll-answer.winner"));
  report();
})();
