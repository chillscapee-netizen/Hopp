// Emojis read at a glance: bigger than the words in a message, big on their own, and roomy in reactions and the picker.

(async () => {
  await inServer();
  const send = (id, text) => emit("chat", { id, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text, sent_at: Date.now() });
  send(9701, "that was so good 😂🔥 haha");
  send(9702, "😂 👍🏽 🇸🇪");
  send(9703, "a heart ❤️ and a family 👨‍👩‍👧");
  await wait(60);
  const msg = (id) => document.querySelector(`.msg[data-id="${id}"] .msg-text`);
  const size = (node) => parseFloat(getComputedStyle(node).fontSize);
  const inLine = msg(9701);
  const words = size(inLine);
  const spans = [...inLine.querySelectorAll(".emoji")];
  check("emojis in a sentence get their own span", spans.length === 2 && spans.map((s) => s.textContent).join("") === "😂🔥", spans.map((s) => s.textContent).join("|"));
  check("and are bigger than the words", size(spans[0]) > words * 1.3, size(spans[0]) + " vs " + words);
  check("the text around them is unchanged", inLine.textContent.includes("that was so good") && inLine.textContent.includes("haha"));

  const only = msg(9702);
  check("a message of only emojis is big", only.classList.contains("jumbo") && size(only.querySelector(".emoji")) >= 48, only.className);
  check("skin tones and flags stay whole", [...only.querySelectorAll(".emoji")].map((s) => s.textContent).join("|") === "😂|👍🏽|🇸🇪");
  check("joined emojis stay one", [...msg(9703).querySelectorAll(".emoji")].map((s) => s.textContent).join("|") === "❤️|👨‍👩‍👧");
  check("words with an emoji aren't big", !msg(9701).classList.contains("jumbo") && !msg(9703).classList.contains("jumbo"));

  emit("reactions", { channel: 0, id: 9701, reactions: [{ emoji: "🔥", keys: [KEYS.elin] }] });
  await wait(30);
  const r = document.querySelector('.msg[data-id="9701"] .reaction-emoji');
  check("reactions are easy to see", r && size(r) >= 18, r && size(r));
  report();
})();
