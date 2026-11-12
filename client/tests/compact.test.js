// Compact messages: time, name and text on one line, no pictures, a name on every message;
// remembered, and it follows the account like the other appearance settings.

(async () => {
  await inServer();
  emit("chat", { id: 9801, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "first", sent_at: Date.now() });
  emit("chat", { id: 9802, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "second, right after", sent_at: Date.now() });
  await wait(100);
  check("normally a follow-up has no name of its own", !document.querySelector('.msg[data-id="9802"] .msg-author'));
  $("chat-compact").checked = true;
  $("chat-compact").dispatchEvent(new Event("change"));
  await wait(100);
  const row = document.querySelector('.msg[data-id="9802"]');
  check("compact is on", document.documentElement.classList.contains("compact-chat") && localStorage.getItem("chatCompact") === "1");
  check("every message has its name", row.querySelector(".msg-author")?.textContent === "Elin");
  check("with the time first", getComputedStyle(row.querySelector(".msg-clock")).display !== "none" && /\d{2}:\d{2}/.test(row.querySelector(".msg-clock").textContent));
  check("and no picture", getComputedStyle(row.querySelector(".avatar")).display === "none");
  check("it follows the account", SYNCED_SETTINGS.includes("chatCompact"));
  $("chat-compact").checked = false;
  $("chat-compact").dispatchEvent(new Event("change"));
  await wait(100);
  check("off again: back to normal", !document.documentElement.classList.contains("compact-chat") && !document.querySelector('.msg[data-id="9802"] .msg-author'));
  report();
})();
