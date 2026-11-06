// @everyone, @here and role mentions: the picker, how they show, and turning them off per server.

(async () => {
  await inServer();
  const r = structuredClone(state.roster);
  r.features = ["search", "screen", "voice-chat", "voice-mod", "voice-settings", "mod-tools", "roles", "pings"];
  r.roles = [{ id: 7, name: "Crew", color: "#46a758", hoist: true, level: null, position: 2, mentionable: false }];
  r.users.find((u) => u.session_id === r.me).roles = [7];
  emit("roster", r);
  await wait(100);
  const input = $("chat-input");
  const type = (text) => {
    input.focus();
    input.value = text;
    input.setSelectionRange(text.length, text.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };

  // The owner may ping everyone and any role.
  type("@ev");
  const pop = $("mention-picker");
  check("@ev offers @everyone", !pop.hidden && pop.textContent.includes("@everyone"));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  check("picking it writes the word", input.value === "@everyone ");
  type("hi @cr");
  check("roles are offered too", pop.textContent.includes("@Crew"));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  sent.length = 0;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(30);
  check("a role is sent as its id", state.chats.get(0)?.some((m) => m.text === "hi <@&7>"));

  // How they show.
  emit("chat", { id: 9301, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "@everyone tonight!", sent_at: Date.now() });
  emit("chat", { id: 9302, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "<@&7> ready?", sent_at: Date.now() });
  emit("chat", { id: 9303, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "@​everyone from someone who can't", sent_at: Date.now() });
  await wait(50);
  const row = (id) => document.querySelector(`[data-id="${id}"]`);
  check("@everyone lights up", !!row(9301)?.querySelector(".mention.me") && row(9301).classList.contains("mentions-me"));
  check("a role shows by name, lit when it's mine", row(9302)?.querySelector(".role-mention.mine")?.textContent === "@Crew" && row(9302).classList.contains("mentions-me"));
  check("a refused @everyone is plain text", !row(9303)?.querySelector(".mention") && !row(9303).classList.contains("mentions-me"));

  // Turned off for this server.
  setCrowdQuiet(activeServer(), true);
  check("suppressed, @everyone no longer pings me", !mentionsMe("@everyone hello"));
  check("roles still do", mentionsMe("<@&7> hello"));
  setCrowdQuiet(activeServer(), false);

  // Older servers: plain words.
  const old = structuredClone(state.roster);
  old.features = ["search"];
  emit("roster", old);
  await wait(50);
  check("an older server doesn't offer @everyone", (type("@ev"), pop.hidden || !pop.textContent.includes("@everyone")));
  check("or ping with it", !mentionsMe("@everyone hello"));
  report();
})();
