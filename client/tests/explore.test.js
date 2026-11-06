// Walks through nearly every part of the app (servers, channels, menus, dialogs, settings,
// voice, Home, DMs) and fails on any page error, or on something left open that shouldn't be.

(async () => {
  await inServer();
  const r = structuredClone(state.roster);
  r.features = ["search", "screen", "voice-chat", "voice-mod", "voice-settings", "mod-tools", "roles", "pings", "resync"];
  r.roles = [{ id: 7, name: "Crew", color: "#46a758", hoist: true, level: "mod", position: 2, mentionable: true }];
  r.users.find((u) => u.name === "Elin").roles = [7];
  emit("roster", r);
  await wait(100);
  const noop = (a) => sent.push(a);
  for (const c of ["kick", "timeout_member", "assign_role", "create_role", "update_role", "delete_role", "update_channel", "delete_channel", "move_voice", "disconnect_voice", "server_mute", "get_audit_log", "play_soundboard", "search_messages", "pin_message", "delete_message", "edit_message", "react"]) commands[c] = noop;
  const menuItems = () => [...document.querySelectorAll("#server-menu .menu-item")];
  const close = () => {
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  };
  const openSubs = async () => {
    for (const b of menuItems().filter((x) => x.classList.contains("has-sub"))) {
      b.dispatchEvent(new MouseEvent("mouseenter"));
      await wait(20);
      check(`submenu "${b.textContent.trim()}" opens with something in it`, !$("server-submenu").hidden && $("server-submenu").querySelectorAll(".menu-item").length > 0);
    }
  };

  // Every channel, text and voice.
  for (const ch of state.roster.channels) {
    [...document.querySelectorAll(".channel-row")].find((n) => n.textContent.includes(ch.name))?.click();
    await wait(80);
  }
  check("channels open without errors", true);

  // Right-click menus: channels, people, messages, servers, rail.
  for (const row of document.querySelectorAll(".channel-row")) {
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 200, clientY: 200 }));
    await wait(20);
    check(`channel menu for ${row.textContent.trim().slice(0, 12)} has items`, menuItems().length > 0);
    close();
  }
  for (const row of document.querySelectorAll(".member")) {
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 900, clientY: 200 }));
    await wait(20);
    await openSubs();
    close();
  }
  for (const vu of document.querySelectorAll(".voice-user")) {
    vu.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 200, clientY: 300 }));
    await wait(20);
    await openSubs();
    close();
  }
  [...document.querySelectorAll(".channel-row")].find((n) => n.textContent.includes("general")).click();
  await wait(100);
  for (const msg of [...document.querySelectorAll(".msg")].slice(0, 4)) {
    msg.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 500, clientY: 300 }));
    await wait(20);
    check("message menu has items", menuItems().length > 0);
    close();
  }
  for (const item of document.querySelectorAll("#server-list .rail-item")) {
    item.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 120 }));
    await wait(20);
    await openSubs();
    close();
  }
  $("sidebar-head").click();
  await wait(20);
  check("server header menu opens", menuItems().length > 0);
  close();

  // Profile cards.
  for (const row of document.querySelectorAll(".member")) {
    row.click();
    await wait(30);
    check("a profile card opens for " + row.textContent.trim().slice(0, 10), !$("user-card").hidden || !$("me-pop")?.hidden);
    close();
  }

  // Header buttons, composer buttons, popovers.
  for (const id of ["pins-btn", "members-toggle", "members-toggle", "emoji-btn", "invite-head-btn"]) {
    $(id)?.click();
    await wait(60);
    close();
  }
  // Search.
  $("search-input").focus();
  $("search-input").value = "round";
  $("search-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(150);
  close();
  // Quick switcher.
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  await wait(50);
  check("Ctrl+K opens the switcher", !$("quick").hidden);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  await wait(30);

  // Composer: write, reply, mention, edit.
  const input = $("chat-input");
  input.focus();
  input.value = "@";
  input.setSelectionRange(1, 1);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(30);
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));

  // Voice: join, the panel's buttons, leave.
  const me = structuredClone(state.roster);
  me.users.find((u) => u.session_id === me.me).voice_channel = 1;
  emit("roster", me);
  emit("voice-state", { ready: true });
  await wait(100);
  check("in voice, the panel shows", !$("voice-panel").hidden);
  $("soundboard-btn")?.click();
  await wait(50);
  close();
  for (const id of ["mute-btn", "mute-btn", "deafen-btn", "deafen-btn"]) {
    $(id).click();
    await wait(20);
  }
  const out = structuredClone(state.roster);
  out.users.find((u) => u.session_id === out.me).voice_channel = null;
  emit("roster", out);
  await wait(50);

  // Settings: every tab, then server settings and a channel's.
  openSettings("profile");
  for (const t of document.querySelectorAll(".settings-tab[data-tab]")) {
    t.click();
    await wait(40);
  }
  check("settings tabs all open", true);
  $("settings").close();
  openServerSettings();
  for (const t of document.querySelectorAll("[data-stab]")) {
    if (t.hidden) continue;
    t.click();
    await wait(40);
  }
  document.querySelector(".role-row")?.click();
  await wait(30);
  $("server-settings").close();
  for (const ch of state.roster.channels) {
    openChannelEdit(ch);
    for (const t of document.querySelectorAll("[data-ctab]")) {
      if (t.hidden) continue;
      t.click();
      await wait(20);
    }
    $("channel-edit-dialog").close();
  }
  openChannelDialog("text");
  await wait(30);
  $("channel-dialog")?.close();
  openInvite();
  await wait(50);
  $("invite-dialog").close();

  // Themes: each one, then back.
  for (const t of ["dark", "midnight", "light", "dusk", "dawn", "mid"]) {
    setTheme(t);
    await wait(20);
  }

  // Home, friends tabs, a DM, back to the server.
  $("home-btn").click();
  await wait(100);
  for (const tab of document.querySelectorAll(".friends-head button, .friends-tab")) {
    tab.click();
    await wait(30);
  }
  const dm = document.querySelector(".dm-row");
  dm?.click();
  await wait(100);
  check("a DM opens from Home", !!state.openDm || !dm);
  document.querySelector("#server-list .rail-item")?.click();
  await wait(200);
  check("back in the server", online() && !state.atHome);

  // Nothing left hanging open.
  close();
  await wait(50);
  check("no dialog left open", !document.querySelector("dialog[open]"));
  check("no popover left open", ![...document.querySelectorAll(".popover")].some((p) => !p.hidden));
  report();
})();
