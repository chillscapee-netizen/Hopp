// Keybinds for mute and deafen that work anywhere: picked in Settings → Keybinds (a key with
// Ctrl, Shift or Alt if wanted), handed to the backend, and acted on when it says pressed.

(async () => {
  await inServer();
  const calls = [];
  commands.record_keybind = () => calls.push("record");
  commands.set_keybinds = (a) => calls.push(a.binds);
  openSettings("keys");
  await wait(100);
  check("both rows offer a key to pick", $("bind-mute").textContent === "Pick a key" && $("bind-deafen").textContent === "Pick a key");
  $("bind-mute").dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
  await wait(20);
  check("clicking listens for a key", calls.includes("record") && $("bind-mute").classList.contains("recording"));
  emit("keybind-recorded", { key: 0x05, mods: 1, label: "Ctrl + Mouse 4" });
  await wait(30);
  const sent = calls.filter((c) => Array.isArray(c)).at(-1);
  check("the key is kept and handed to the backend", $("bind-mute").textContent === "Ctrl + Mouse 4" && sent?.[0]?.id === "mute" && sent[0].key === 5 && sent[0].mods === 1, JSON.stringify(sent));
  check("and remembered", JSON.parse(localStorage.getItem("keybinds")).mute.label === "Ctrl + Mouse 4");

  // The same key for deafen takes it from mute.
  $("bind-deafen").dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
  emit("keybind-recorded", { key: 0x05, mods: 1, label: "Ctrl + Mouse 4" });
  await wait(30);
  check("one key does one thing", !prefs.keybinds.mute && prefs.keybinds.deafen?.key === 5 && $("bind-mute").textContent === "Pick a key");

  // Pressed anywhere: the backend says so.
  const before = state.deafened;
  emit("keybind", "deafen");
  await wait(50);
  check("pressing it deafens", state.deafened !== before);
  emit("keybind", "deafen");
  await wait(50);
  $("bind-deafen-clear").click();
  await wait(20);
  check("Clear lets it go", !prefs.keybinds.deafen && calls.filter((c) => Array.isArray(c)).at(-1).length === 0);
  report();
})();
