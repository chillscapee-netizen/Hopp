// Emojis read at a glance: drawn as pictures (the same on every computer, flags too), bigger
// than the words in a message, big on their own, and roomy in reactions and the picker.

(async () => {
  await inServer();
  const send = (id, text) => emit("chat", { id, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text, sent_at: Date.now() });
  send(9701, "that was so good 😂🔥 haha");
  send(9702, "😂 👍🏽 🇸🇪");
  send(9703, "a heart ❤️ and a family 👨‍👩‍👧");
  await wait(150);
  const msg = (id) => document.querySelector(`.msg[data-id="${id}"] .msg-text`);
  const pics = (id) => [...msg(id).querySelectorAll("img.emoji")];
  const inLine = msg(9701);
  const words = parseFloat(getComputedStyle(inLine).fontSize);
  check("emojis in a sentence are pictures", pics(9701).map((i) => i.alt).join("") === "😂🔥", pics(9701).map((i) => i.alt).join("|"));
  check("from the set shipped with the app", pics(9701)[0].getAttribute("src") === "emoji/1f602.svg" && pics(9701)[0].naturalWidth > 0, pics(9701)[0].getAttribute("src"));
  check("and bigger than the words", pics(9701)[0].getBoundingClientRect().height > words * 1.3, pics(9701)[0].getBoundingClientRect().height + " vs " + words);
  check("the text around them is unchanged", inLine.textContent.includes("that was so good") && inLine.textContent.includes("haha"));

  check("a message of only emojis is big", msg(9702).classList.contains("jumbo") && pics(9702)[0].getBoundingClientRect().height >= 48, msg(9702).className);
  check("skin tones and flags stay whole", pics(9702).map((i) => i.alt).join("|") === "😂|👍🏽|🇸🇪");
  check("a flag is a picture, not two letters", pics(9702)[2].getAttribute("src") === "emoji/1f1f8-1f1ea.svg" && pics(9702)[2].naturalWidth > 0);
  check("joined emojis stay one", pics(9703).map((i) => i.alt).join("|") === "❤️|👨‍👩‍👧" && pics(9703)[0].getAttribute("src") === "emoji/2764.svg");
  check("words with an emoji aren't big", !msg(9701).classList.contains("jumbo") && !msg(9703).classList.contains("jumbo"));

  emit("reactions", { channel: 0, id: 9701, reactions: [{ emoji: "🔥", keys: [KEYS.elin] }] });
  await wait(60);
  const r = document.querySelector('.msg[data-id="9701"] .reaction-emoji img.emoji');
  check("reactions are pictures, easy to see", r && r.getBoundingClientRect().height >= 18, r && r.getBoundingClientRect().height);

  // The picker: every emoji, a row to jump between groups, skin tones, and search by several words.
  openEmojiPicker($("chat-input"), () => {}, null);
  await wait(60);
  const opts = document.querySelectorAll("#emoji-picker .emoji-option");
  check("the picker has the whole set", opts.length > 1500, opts.length);
  check("with a row of groups to jump between", document.querySelectorAll("#emoji-picker .emoji-nav-btn").length >= 8);
  const search = document.querySelector("#emoji-picker .picker-search");
  search.value = "flag swe";
  search.dispatchEvent(new Event("input"));
  await wait(30);
  const found = [...document.querySelectorAll("#emoji-picker .emoji-option img.emoji")].map((i) => i.alt);
  check("searching with two words finds the flag", found.includes("🇸🇪"), found.slice(0, 5).join(" "));
  search.value = "";
  search.dispatchEvent(new Event("input"));
  document.querySelector("#emoji-picker .skin-tone").click();
  await wait(20);
  const tones = document.querySelectorAll("#emoji-picker .skin-choice");
  check("six skin tones to choose from", tones.length === 6, tones.length);
  tones[3].click();
  await wait(40);
  const thumbs = [...document.querySelectorAll("#emoji-picker .emoji-option img.emoji")].map((i) => i.alt);
  check("picking one changes the hands", thumbs.includes("👍🏽") && !thumbs.includes("👍"));
  tones.length && document.querySelector("#emoji-picker .skin-tone").click();
  await wait(20);
  document.querySelectorAll("#emoji-picker .skin-choice")[0]?.click();
  closePopovers();

  // Copying a message copies the emojis, not empty space.
  const range = document.createRange();
  range.selectNodeContents(msg(9701));
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  const data = new DataTransfer();
  document.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }));
  check("copying keeps the emojis", data.getData("text/plain").includes("😂🔥"), data.getData("text/plain"));
  getSelection().removeAllRanges();
  report();
})();
