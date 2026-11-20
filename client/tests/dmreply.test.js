// Replying in DMs, like in a server: Reply on a message, a bar above the box, the answer shows
// what it answers (and goes to it on a click); the mark stays inside the encrypted text and
// never shows as text, in the list or when editing.

(async () => {
  try {
    await inServer();
    openDm(KEYS.elin);
    await wait(300);
    emit("account", { type: "dm", with: KEYS.elin, message: { id: "q1", from_key: KEYS.elin, sealed: "plain:pizza or tacos tonight?", sent_at: Date.now() } });
    await wait(150);
    const theirs = () => document.querySelector(`.dm-messages [data-key="${CSS.escape(KEYS.elin + "|q1")}"]`);
    const replyBtn = theirs()?.querySelector(".msg-actions [data-tip='Reply']");
    check("Reply in the hover bar", !!replyBtn);
    replyBtn.click();
    await wait(50);
    check("the bar says whom you answer", !document.querySelector(".dm-reply-bar").hidden && document.querySelector(".dm-reply-bar").textContent.includes("Replying to"));
    sent.length = 0;
    const input = $("dm-input");
    input.value = "tacos!";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait(250);
    const out = sent.find((m) => m.type === "dm_send");
    check("sent with the id of what it answers, sealed", out?.sealed === "plain:hopp-reply:q1\ntacos!", out?.sealed);
    check("the bar goes away", document.querySelector(".dm-reply-bar").hidden);

    // It arrives (as it would back from the cloud): drawn as a reply.
    emit("account", { type: "dm", with: KEYS.elin, message: { id: "a1", from_key: ME, sealed: "plain:hopp-reply:q1\ntacos!", sent_at: Date.now() + 5 } });
    await wait(200);
    const answer = document.querySelector(`.dm-messages [data-key="${CSS.escape(KEYS.elin + "|a1")}"]`);
    check("the answer shows what it answers", !!answer?.querySelector(".msg-reply") && answer.querySelector(".msg-reply").textContent.includes("pizza or tacos"));
    check("the mark never shows as text", !document.querySelector(".dm-messages").textContent.includes("hopp-reply"));
    check("nor in the conversation list", !document.body.textContent.includes("hopp-reply"));

    // Editing it keeps what it answers.
    sent.length = 0;
    answer.querySelector(".msg-actions [data-tip='Edit']").click();
    await wait(100);
    const box = document.querySelector(".dm-messages .msg-editor textarea");
    check("the editor shows only your words", box?.value === "tacos!");
    box.value = "tacos, obviously";
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait(250);
    const edit = sent.find((m) => m.type === "dm_edit");
    check("an edit keeps the reply", edit?.sealed === "plain:hopp-reply:q1\ntacos, obviously", edit?.sealed);
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
