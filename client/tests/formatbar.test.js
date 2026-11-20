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
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
