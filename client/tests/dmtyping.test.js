// "Typing…" in DMs: writing tells them (not more than every 5 seconds), and their typing shows
// under the box until they send or stop.

(async () => {
  try {
    await inServer();
    openDm(KEYS.elin);
    await wait(300);
    sent.length = 0;
    const input = $("dm-input");
    for (const t of ["h", "he", "hey"]) {
      input.value = t;
      input.dispatchEvent(new Event("input"));
    }
    await wait(50);
    check("typing tells them once, not per letter", sent.filter((m) => m.type === "dm_typing" && m.with === KEYS.elin).length === 1);
    emit("account", { type: "dm_typing", with: KEYS.elin, from: KEYS.elin });
    await wait(80);
    check("their typing shows under the box", document.querySelector(".dm-typing")?.textContent.includes("is typing"));
    emit("account", { type: "dm", with: KEYS.elin, message: { id: "t1", from_key: KEYS.elin, sealed: "plain:hello", sent_at: Date.now() } });
    await wait(150);
    check("their message ends it", !document.querySelector(".dm-typing")?.textContent.includes("typing"));
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
