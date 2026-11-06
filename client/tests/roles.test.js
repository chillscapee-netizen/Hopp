// Roles: names in their colour, a heading of their own, a Roles menu, the Roles tab, private channels.

(async () => {
  await inServer();
  const r = structuredClone(state.roster);
  r.features = ["search", "screen", "voice-chat", "voice-mod", "voice-settings", "mod-tools", "roles"];
  r.roles = [{ id: 7, name: "Crew", color: "#46a758", hoist: true, level: "mod", position: 2 }, { id: 8, name: "Friends", color: "#0090ff", hoist: false, level: null, position: 1 }];
  const elin = r.users.find((u) => u.name === "Elin");
  elin.roles = [7, 8];
  emit("roster", r);
  await wait(100);
  for (const c of ["assign_role", "create_role", "update_role", "update_channel", "reorder_roles"]) commands[c] = (a) => sent.push({ type: c, ...a });

  const heads = [...document.querySelectorAll(".member-group")].map((h) => h.textContent);
  check("a role shown separately gets its own heading", heads.includes("Crew — 1"), heads.join(" | "));
  const name = [...document.querySelectorAll(".member .member-name")].find((n) => n.textContent === "Elin");
  check("names take their highest role's colour", name?.style.color === "rgb(70, 167, 88)", name?.style.color);

  // Roles in someone's menu.
  [...document.querySelectorAll(".member")].find((x) => x.textContent.includes("Jonas")).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 600, clientY: 200 }));
  await wait(30);
  const item = (t) => [...document.querySelectorAll("#server-menu .menu-item, #server-submenu .menu-item")].find((b) => b.textContent.trim() === t);
  item("Roles").dispatchEvent(new MouseEvent("mouseenter"));
  await wait(20);
  sent.length = 0;
  item("Crew").click();
  check("ticking a role gives it", sent.some((m) => m.type === "assign_role" && m.role === 7 && m.on === true));
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

  // The Roles tab.
  openServerSettings();
  await wait(50);
  showServerTab("roles");
  await wait(30);
  check("the Roles tab lists the roles", document.querySelectorAll("#role-list .role-row").length === 2);
  document.querySelector("#role-list .role-row").click();
  check("a role opens for editing", !document.getElementById("role-editor").hidden && document.getElementById("role-name").value === "Crew");
  document.getElementById("role-name").value = "Core crew";
  sent.length = 0;
  document.getElementById("role-editor").requestSubmit();
  check("saving sends the change", sent.some((m) => m.type === "update_role" && m.id === 7 && m.name === "Core crew" && m.color === "#46a758" && m.level === "mod"));
  document.getElementById("server-settings").close();

  // A private channel.
  openChannelEdit(state.roster.channels.find((c) => c.id === 0));
  await wait(30);
  check("channels can be made private", !document.getElementById("channel-edit-private").hidden);
  document.getElementById("channel-edit-private-on").click();
  document.querySelector('#channel-edit-private-roles input[value="7"]').checked = true;
  sent.length = 0;
  document.getElementById("channel-edit-form").requestSubmit();
  await wait(20);
  check("for the roles picked", sent.some((m) => m.type === "update_channel" && JSON.stringify(m.privateRoles) === "[7]"));
  const p = structuredClone(state.roster);
  p.channels.find((c) => c.id === 0).private_roles = [7];
  emit("roster", p);
  await wait(50);
  check("a private channel shows a lock", !!document.querySelector(".channel-row.current use[href='#i-lock']"));
  report();
})();
