// Custom emojis: Hopp's own (everywhere) and a server's own (uploaded by its admins), typed
// :name:, shown as pictures in messages, reactions, the picker and the hover bar.
(async () => {
  await inServer();
  const r = structuredClone(state.roster);
  r.features = [...(r.features ?? []), "emojis"];
  r.emojis = [{ id: 7, name: "pog", image: "ab".repeat(16) }];
  emit("roster", r);
  await wait(50);

  // Typed :name: becomes the emoji on sending.
  const sent = [];
  commands.send_chat = (a) => sent.push(a.text);
  chatInput.value = "gg :hopp_party: and :pog: but not :nothing: or `:pog:`";
  chatInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(50);
  chatInput.value = "by the arrow";
  document.querySelector("#composer .send-btn").click();
  await wait(50);
  check("the send arrow sends", sent[1] === "by the arrow" && chatInput.value === "", JSON.stringify(sent));
  check("typed names become emojis (code stays as it is)", sent[0] === "gg <:hopp_party:0> and <:pog:7> but not :nothing: or `:pog:`", sent[0]);

  // Shown as pictures.
  emit("chat", { id: 9701, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: sent[0], sent_at: Date.now() });
  emit("chat", { id: 9702, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "<:hopp_love:0> <:pog:7>", sent_at: Date.now() });
  emit("chat", { id: 9703, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "from elsewhere <:other:99>", sent_at: Date.now() });
  await wait(100);
  const row = document.querySelector('.msg[data-id="9701"]');
  const pics = [...row.querySelectorAll(".custom-emoji")];
  check("in a message they're pictures", pics.length === 2 && pics[0].src.startsWith("data:image/svg+xml") && pics[1].src.includes("/images/" + "ab".repeat(16)), pics.map((p) => p.src.slice(0, 40)).join(" | "));
  check("a message of only emojis shows them big", !!document.querySelector('.msg[data-id="9702"] .msg-text.jumbo'));
  check("one from another server reads as its name", document.querySelector('.msg[data-id="9703"] .custom-emoji-name')?.textContent === ":other:");
  check("previews say the name", previewText(sent[0]).includes(":hopp_party:"), previewText(sent[0]));

  // The picker offers them first, and a reaction with one shows its picture.
  const reacted = [];
  commands.react = (a) => reacted.push(a.emoji);
  row.querySelector(".msg-actions .icon-btn:not(.quick-react)").click();
  await wait(60);
  const heads = [...document.querySelectorAll("#emoji-picker .emoji-head")].map((n) => n.textContent);
  check("the picker has the server's and Hopp's own first", heads[0] === state.roster.server_name && heads[1] === "Hopp", heads.slice(0, 3).join(" | "));
  document.querySelector("#emoji-picker .emoji-option .custom-emoji").click();
  await wait(30);
  check("picking one reacts with it", reacted[0] === "<:pog:7>", JSON.stringify(reacted));
  emit("reactions", { channel: 0, id: 9701, reactions: [{ emoji: "<:pog:7>", keys: [ME] }] });
  await wait(60);
  check("the reaction shows its picture", !!document.querySelector('.msg[data-id="9701"] .reaction .custom-emoji'));
  // Hovering it shows the emoji big, its name and who reacted.
  const chipEl = document.querySelector('.msg[data-id="9701"] .reaction:not(.add)');
  chipEl.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  await wait(350);
  const peek = $("reaction-peek");
  check("hovering a reaction shows which emoji it is", !!peek?.querySelector(".custom-emoji") && peek.textContent.includes(":pog:") && peek.textContent.includes("You reacted"), String(peek?.textContent) + "/ connected: " + chipEl.isConnected + " / " + !!document.querySelector('.msg[data-id="9701"] .reaction:not(.add)').reaction);
  document.body.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  check("and it goes away again", !$("reaction-peek"));

  // The status picker keeps to plain emojis (a status shows where a server's don't).
  openEmojiPicker(document.body, () => {}, null, { plain: true });
  await wait(30);
  check("the status picker leaves custom ones out", ![...document.querySelectorAll("#emoji-picker .emoji-head")].some((n) => n.textContent === "Hopp"));
  closePopovers();

  // Admins manage them in Server settings → Emoji.
  openServerSettings();
  await wait(80);
  showServerTab("emojis");
  await wait(30);
  check("the Emoji tab lists the server's", $("emoji-list").textContent.includes(":pog:") && !document.querySelector('[data-stab="emojis"]').hidden);
  $("server-settings").close();
  report();
})();
