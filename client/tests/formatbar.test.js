// Formatting in the message box, as in Discord: a bar shows over selected text (headings, bold,
// italics, underline, lists...), each press puts the marks on or takes them off; Ctrl+B/I/U too.

(async () => {
  try {
    await inServer();
    openTextChannel(0);
    await wait(60);
    const box = $("chat-input");
    const bar = document.querySelector(".format-bar");
    const pick = (a, b) => {
      box.focus();
      box.setSelectionRange(a, b);
      document.dispatchEvent(new Event("selectionchange"));
    };
    box.value = "Game night";
    pick(0, 4);
    await wait(30);
    check("selecting text shows the bar", !bar.hidden);
    bar.querySelector(".format-B").click();
    check("bold puts ** around it", box.value === "**Game** night", box.value);
    bar.querySelector(".format-B").click();
    check("again takes them off", box.value === "Game night", box.value);
    pick(0, 4);
    bar.querySelector(".format-H1").click();
    check("a heading starts the line with #", box.value === "# Game night", box.value);
    bar.querySelector(".format-H2").click();
    check("another heading size replaces it", box.value === "## Game night", box.value);
    box.value = "a\nb";
    pick(0, 3);
    bar.querySelector(".format-x").click();
    check("a list marks every selected line", box.value === "- a\n- b", box.value);
    box.value = "hello";
    pick(0, 5);
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "i", ctrlKey: true, bubbles: true }));
    check("Ctrl+I makes it italic", box.value === "*hello*", box.value);
    pick(3, 3);
    await wait(30);
    check("no selection: no bar", bar.hidden);
    box.value = "";

    // The overview makes a #welcome channel, only staff write in.
    const r = structuredClone(state.roster);
    r.features = [...(r.features ?? []), "rules", "announce"];
    emit("roster", r);
    await wait(60);
    const created = [];
    const updated = [];
    const saved = [];
    commands.create_channel = (x) => created.push(x);
    commands.update_channel = (x) => updated.push(x);
    commands.set_rules = (x) => saved.push(x);
    openServerSettings();
    await wait(60);
    $("welcome-channel").value = "new";
    $("rules-save").click();
    await wait(30);
    check("a #welcome channel is made", created.some((c) => c.name === "welcome"));
    const n = structuredClone(state.roster);
    n.channels.push({ id: 60, name: "welcome", kind: "text" });
    emit("roster", n);
    await wait(80);
    check("only staff write in it", updated.some((u) => u.channel === 60 && u.announce === true));
    check("and welcomes go there", saved.some((x) => x.welcomeChannel === 60), JSON.stringify(saved));
    $("server-settings").close();
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
