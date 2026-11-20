// Reactions in DMs, like in a server: Add reaction on a message, the chips under it, a click on
// your own takes it back. What goes to the cloud is your whole list, sealed (never the emoji itself).

(async () => {
  try {
    await inServer();
    openDm(KEYS.elin);
    await wait(300);
    emit("account", { type: "dm", with: KEYS.elin, message: { id: "r1", from_key: KEYS.elin, sealed: "plain:gg", sent_at: Date.now() } });
    await wait(150);
    const row = () => document.querySelector(`.dm-messages [data-key="${CSS.escape(KEYS.elin + "|r1")}"]`);
    check("Add reaction in the hover bar", !!row()?.querySelector(".msg-actions [data-tip='Add reaction']"));
    sent.length = 0;
    await reactDm(KEYS.elin, state.dmMessages.get(KEYS.elin).find((m) => m.id === "r1"), "🔥", true);
    await wait(150);
    const out = sent.find((m) => m.type === "dm_react");
    check("your list goes sealed, not the emoji itself", out?.id === "r1" && out.sealed === 'plain:["🔥"]', JSON.stringify(out));
    check("the chip shows at once", row()?.querySelector(".reaction.mine")?.textContent.includes("1"));

    // The cloud says both of you reacted: two on the chip.
    emit("account", { type: "dm_reactions", with: KEYS.elin, id: "r1", reactions: { [ME]: 'plain:["🔥"]', [KEYS.elin]: 'plain:["🔥","😂"]' } });
    await wait(150);
    const chips = [...(row()?.querySelectorAll(".reaction:not(.add)") ?? [])].map((c) => c.textContent);
    check("both people's reactions, counted", chips.some((c) => c.includes("2")) && chips.length === 2, chips.join(" | "));

    // Clicking your own takes it back: an empty list means nothing to seal.
    sent.length = 0;
    row().querySelector(".reaction.mine").click();
    await wait(150);
    const off = sent.find((m) => m.type === "dm_react");
    check("taking it back sends no emoji at all", off && off.sealed === null, JSON.stringify(off));
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
