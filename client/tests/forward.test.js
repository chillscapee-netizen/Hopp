// Forwarding: from a channel or a conversation to a channel here, a friend or a group, shown
// as a quote with who wrote it and where; mentions never ping, pictures stay where they are.

(async () => {
  await inServer();
  const sentChat = [];
  commands.send_chat = (a) => sentChat.push(a.text);
  emit("chat", { id: 9901, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "gg <@" + ME + "> and @everyone", sent_at: Date.now() - 60000 });
  emit("chat", { id: 9902, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "hopp-image:" + "ab".repeat(16) + " 100x100", sent_at: Date.now() });
  await wait(100);

  // The menu offers it, not for a picture.
  const menuLabels = (id) => {
    document.querySelector(`.msg[data-id="${id}"]`).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 300, clientY: 300 }));
    const labels = [...document.querySelectorAll(".menu-item, .context-menu button, [role=menuitem]")].map((b) => b.textContent.trim());
    closePopovers();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    return labels;
  };
  const textMenu = menuLabels(9901);
  check("a message can be forwarded", textMenu.some((l) => l.includes("Forward")), textMenu.join(", "));
  check("a picture can't", !menuLabels(9902).some((l) => l.includes("Forward")));
  check("the hover bar has it too", !!document.querySelector('.msg[data-id="9901"] .msg-actions [data-tip="Forward"]'));

  // The dialog: this server's channels, then friends and groups.
  forwardMessage(state.chats.get(0).find((m) => m.id === 9901));
  await wait(80);
  const rows = [...document.querySelectorAll("#forward-list .invite-friend")];
  check("it lists channels and friends", rows.some((r) => r.textContent.includes("#general")) && rows.some((r) => r.textContent.includes("Elin")), rows.map((r) => r.textContent).join(" | "));
  check("with a preview of what goes", $("forward-preview").textContent.includes("Forwarded") && $("forward-preview").textContent.includes("@Marcus"));
  rows.find((r) => r.textContent.includes("#general")).querySelector("button").click();
  await wait(50);
  const out = sentChat.at(-1) ?? "";
  check("sends it to the channel", out.startsWith("hopp-forward:"), out.slice(0, 40));
  check("mentions don't ping", !out.includes("<@") && !new RegExp("(^|[^" + String.fromCharCode(0x200b) + "])@everyone").test(out.split("\n").slice(1).join("\n")), out);
  check("the button says it went", rows.find((r) => r.textContent.includes("#general")).querySelector("button").textContent === "Sent");
  $("forward-search").value = "eli";
  $("forward-search").dispatchEvent(new Event("input"));
  check("search narrows the list", [...document.querySelectorAll("#forward-list .invite-friend")].every((r) => r.textContent.includes("Elin")));
  $("forward-dialog").close();

  // Shown as a quote, with where it's from.
  emit("chat", { id: 9903, channel: 0, sender: 1, sender_name: "Marcus", author_key: ME, text: out, sent_at: Date.now() });
  await wait(100);
  const quote = document.querySelector('.msg[data-id="9903"] .forwarded');
  check("a forwarded message shows as a quote", !!quote && quote.textContent.includes("Forwarded") && quote.textContent.includes("Elin") && quote.textContent.includes("#general"), quote?.textContent);
  check("previews say it's forwarded", previewText(out).startsWith("Forwarded: gg"), previewText(out));
  check("it can't be edited", !document.querySelector('.msg[data-id="9903"] .msg-actions [data-tip="Edit"]'));

  // From a conversation: someone else's message has Forward, and forwarding a forward keeps its source.
  document.getElementById("home-btn").click();
  await wait(100);
  openDm(KEYS.elin);
  await wait(200);
  const theirs = [...document.querySelectorAll(".dm-messages li")].find((li) => li.textContent.includes("Ready for tonight"));
  check("a friend's DM can be forwarded", !!theirs?.querySelector('.msg-actions [data-tip="Forward"]'));
  check("but not deleted by you", !theirs?.querySelector('.msg-actions [data-tip="Delete message"]'));
  const again = forwardText(out, "Marcus", "Direct message", Date.now());
  check("forwarding a forward keeps the original source", forwardParts(again).name === "Elin" && forwardParts(again).where.includes("#general"));
  report();
})();
