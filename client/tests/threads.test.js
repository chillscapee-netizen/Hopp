// Threads: started from a message's menu with a name, opened at once; listed under their
// channel in the sidebar; the message shows the thread; the header and composer say where you
// are; whoever started one may delete it.

(async () => {
  try {
    await inServer();
    const r = structuredClone(state.roster);
    r.features = [...(r.features ?? []), "threads"];
    emit("roster", r);
    await wait(60);
    const asked = [];
    commands.create_thread = (a) => asked.push(a);
    emit("chat", { id: 9601, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "Raid on Saturday? Who's in", sent_at: Date.now() });
    await wait(100);
    const row = document.querySelector('.msg[data-id="9601"]');
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 300, clientY: 300 }));
    await wait(30);
    const start = [...document.querySelectorAll(".menu-item, [role=menuitem], .menu button")].find((b) => b.textContent.includes("Start a thread"));
    check("the message menu offers a thread", !!start);
    start.click();
    await wait(50);
    check("the dialog suggests a name from the message", $("thread-dialog").open && $("thread-name").value === "Raid on Saturday? Who's in");
    $("thread-name").value = "Saturday raid";
    $("thread-form").requestSubmit();
    await wait(30);
    check("starting asks the server", asked[0]?.channel === 0 && asked[0]?.message === 9601 && asked[0]?.name === "Saturday raid", JSON.stringify(asked));

    // The server made it: it opens, and shows under its channel and its message.
    const r2 = structuredClone(state.roster);
    r2.channels.push({ id: 77, name: "Saturday raid", kind: "text", parent: 0, starter: 9601, creator: ME });
    emit("roster", r2);
    await wait(150);
    check("it opens at once", state.view === 77);
    check("the header says it's a thread", $("chat-channel").textContent === "Saturday raid" && $("chat-head-icon").innerHTML.includes("i-message"));
    check("the message box says so too", $("chat-input").placeholder === "Message Saturday raid");
    const threadRow = [...document.querySelectorAll(".thread-row")].find((n) => n.textContent.includes("Saturday raid"));
    check("it sits under its channel in the sidebar", !!threadRow && threadRow.previousElementSibling?.textContent.includes("general"));
    openTextChannel(0);
    await wait(120);
    const chip = document.querySelector('.msg[data-id="9601"] .thread-chip');
    check("the message shows its thread", !!chip && chip.textContent.includes("Saturday raid"));
    chip.click();
    await wait(80);
    check("a click opens it", state.view === 77);
    // Its menu: delete, but no channel settings.
    threadRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 200, clientY: 200 }));
    await wait(30);
    const labels = [...document.querySelectorAll(".menu-item, [role=menuitem], .menu button")].map((b) => b.textContent.trim());
    check("whoever started it can delete it, and it has no channel settings", labels.some((l) => l.includes("Delete thread")) && !labels.some((l) => l.includes("Edit channel")), labels.join(", "));
    closePopovers();
    check("a thread is never the channel you land on", textChannels().find((c) => c.parent == null)?.id === 0);
  } catch (err) {
    check("no crash", false, err.stack);
  }
  report();
})();
