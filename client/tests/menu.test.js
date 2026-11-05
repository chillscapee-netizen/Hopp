// Menus: ticks change in place and the menu stays; the submenu stays while you use it.

(async () => {
  await inServer();
  const r = structuredClone(state.roster);
  r.features = ["search", "screen", "voice-chat", "voice-mod", "voice-settings"];
  r.users.find((u) => u.session_id === r.me).voice_channel = 1;
  emit("roster", r);
  await wait(100);
  const elin = state.roster.users.find((u) => u.name === "Elin");
  document.querySelector(`.voice-user[data-user="${elin.session_id}"]`).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 240, clientY: 200 }));
  await wait(50);
  const menu = document.getElementById("server-menu");
  const item = (t) => [...menu.querySelectorAll(".menu-item")].find((b) => b.textContent.trim() === t);
  item("Mute").click();
  await wait(30);
  check("ticking Mute keeps the menu open", !menu.hidden && item("Mute").querySelector(".menu-check.on"));
  check("and mutes them for you", userVolume(elin) === 0);
  item("Mute").click();
  await wait(30);
  check("ticking again unmutes", (userVolume(elin) ?? 100) === 100 && !item("Mute").querySelector(".menu-check.on"));

  // The submenu: open it, pass over another row on the way, and reach it.
  const sub = document.getElementById("server-submenu");
  item("Move to").dispatchEvent(new MouseEvent("mouseenter"));
  await wait(20);
  check("Move to opens its submenu", !sub.hidden && sub.textContent.includes("Gaming"));
  item("Disconnect").dispatchEvent(new MouseEvent("mouseenter"));
  await wait(100);
  sub.dispatchEvent(new MouseEvent("mouseenter"));
  sub.querySelector(".menu-item").dispatchEvent(new MouseEvent("mouseenter"));
  await wait(400);
  check("passing a row on the way doesn't close it", !sub.hidden);
  commands.move_voice = (a) => sent.push({ type: "move_voice", ...a });
  sub.querySelector(".menu-item").click();
  await wait(30);
  check("choosing a channel moves them", sent.some((m) => m.type === "move_voice" && m.sessionId === elin.session_id) && menu.hidden && sub.hidden);
  report();
})();
