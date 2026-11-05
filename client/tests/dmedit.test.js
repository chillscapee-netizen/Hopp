// Editing and deleting your own DMs.

(async () => {
  await inServer();
  openDm(KEYS.elin);
  await wait(300);
  const input = $("dm-input");
  input.value = "see you at 8";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(300);
  const mine = () => [...document.querySelectorAll(".dm-messages .msg")].filter((li) => li.textContent.includes("see you at") || li.textContent.includes("see you at 9")).pop();
  check("own message has edit and delete", !!mine()?.querySelector(".msg-actions [data-tip='Edit']") && !!mine()?.querySelector(".msg-actions [data-tip='Delete message']"));
  check("only your own messages have actions", document.querySelectorAll(".dm-messages .msg-actions").length === state.dmMessages.get(KEYS.elin).filter((m) => m.from_key === ME && !m.pending).length);

  // Up in the empty box edits the last message.
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  await wait(100);
  const box = document.querySelector(".dm-messages .msg-editor textarea");
  check("up arrow opens the editor", !!box && box.value === "see you at 8");
  sent.length = 0;
  box.value = "see you at 9";
  box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(300);
  const edit = sent.find((m) => m.type === "dm_edit");
  check("edit is sealed and sent", edit && edit.sealed === "plain:see you at 9");
  check("shows the new text, marked edited", mine()?.textContent.includes("see you at 9") && mine()?.textContent.includes("(edited)"));

  // A friend's edit arrives.
  const theirs = state.dmMessages.get(KEYS.elin).find((m) => m.from_key === KEYS.elin);
  emit("account", { type: "dm_edited", with: KEYS.elin, id: theirs.id, sealed: "plain:changed my mind", edited_at: Date.now() });
  await wait(200);
  check("friend's edit shows", document.querySelector(".dm-messages").textContent.includes("changed my mind"));

  // Deleting (Shift skips the question).
  sent.length = 0;
  mine().querySelector(".msg-actions [data-tip='Delete message']").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }));
  await wait(300);
  check("delete sent", sent.some((m) => m.type === "dm_delete"));
  check("gone from the conversation", !document.querySelector(".dm-messages").textContent.includes("see you at 9"));
  report();
})();
