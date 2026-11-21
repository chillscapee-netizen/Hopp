// #rules and #welcome keep their own icons in the channel list, also when the rules arrive after
// the channels (they're read-only, but not shown as announcement megaphones).

(async () => {
  try {
    await inServer();
    const r = structuredClone(state.roster);
    r.features = [...(r.features ?? []), "rules", "announce"];
    r.channels.push({ id: 40, name: "rules", kind: "text", announce: true }, { id: 41, name: "welcome", kind: "text", announce: true });
    emit("roster", r);
    await wait(80);
    emit("rules", { rules: "Be kind.", at: 5, accepted: true, welcome_channel: 41, rules_channel: 40 });
    await wait(80);
    const iconOf = (name) => [...document.querySelectorAll(".channel-row")].find((n) => n.textContent.trim() === name)?.querySelector("use")?.getAttribute("href");
    check("#rules shows a book", iconOf("rules") === "#i-book", iconOf("rules"));
    check("#welcome shows its own icon", iconOf("welcome") === "#i-user-plus", iconOf("welcome"));
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
