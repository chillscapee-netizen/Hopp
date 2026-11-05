// A chat that flows: type anywhere, quick reactions, mark unread, keyboard, :emoji.

(async () => {
  await inServer();
  const input = $("chat-input");

  // Start typing anywhere: the message box takes it.
  input.blur();
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "h", bubbles: true }));
  check("typing anywhere focuses the message box", document.activeElement === input);

  // Quick reactions on hover.
  const row = [...document.querySelectorAll("#messages .msg")].find((li) => li.msg?.author_key === KEYS.elin);
  const quick = [...row.querySelectorAll(".quick-react")];
  check("three quick reactions on hover", quick.length === 3);
  sent.length = 0;
  quick[0].click();
  check("one click reacts", sent.some((m) => m.type === "react" && m.on === true));

  // Mark unread: stays unread while you're looking, Escape catches up.
  const crew = activeServer();
  const target = state.chats.get(0)[2];
  openMessageMenu(target, new MouseEvent("contextmenu", { clientX: 200, clientY: 200 }));
  sent.length = 0;
  [...$("server-menu").querySelectorAll(".menu-item")].find((b) => b.textContent === "Mark unread").click();
  await wait(50);
  check("marked unread here and on other devices", channelUnread(crew.address, 0) && sent.some((m) => m.type === "channel_read" && m.unread === true && m.id === target.id - 1));
  markViewedRead();
  check("stays unread while you look", channelUnread(crew.address, 0));
  check("a New line shows where it starts", !!document.querySelector("#messages .new-divider"));
  input.focus();
  input.value = "";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  check("Escape catches up", !channelUnread(crew.address, 0));

  // Alt+↓ / Alt+↑ between channels.
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }));
  await wait(50);
  check("Alt+↓ goes to the next channel", state.view === textChannels()[1].id);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }));
  await wait(50);
  check("Alt+↑ goes back", state.view === textChannels()[0].id);

  // :emoji suggestions.
  input.focus();
  input.value = "this is :fir";
  input.setSelectionRange(input.value.length, input.value.length);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  const pop = $("mention-picker");
  check(":fir suggests 🔥", !pop.hidden && pop.textContent.includes("🔥"));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  check("Enter puts the emoji in", input.value === "this is 🔥" && pop.hidden);
  report();
})();
