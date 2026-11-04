// Roles on a server: who sees what, and handing out roles.

(async () => {
  await inServer();
  const users = () => state.roster.users;
  const setRoles = (roles) => {
    const r = structuredClone(state.roster);
    for (const u of r.users) {
      const role = roles[u.name];
      u.owner = role === "owner";
      if (role && role !== "owner") u.role = role;
      else delete u.role;
    }
    emit("roster", r);
  };
  const rowOf = (name) => [...document.querySelectorAll("#member-list-pane .member, .members .member, li.member")].find((li) => li.textContent.includes(name));

  // As the owner.
  setRoles({ Marcus: "owner", Elin: "admin", Jonas: "mod" });
  await wait(150);
  const text = document.body.textContent;
  check("member list groups by role", text.includes("Admins — 1") && text.includes("Moderators — 1") && text.includes("Online — 1"));
  check("admin and moderator marks shown", document.querySelector(".role-mark.admin") && document.querySelector(".role-mark.mod"));

  const elin = users().find((u) => u.name === "Elin");
  openUserCard(elin, document.body);
  check("owner may change an admin's role", !$("user-role-wrap").hidden && [...$("user-role").options].map((o) => o.value).join(",") === ",mod,admin");
  check("owner sees transfer", !$("user-transfer").hidden);
  check("owner can kick and ban an admin", !$("user-mod").hidden && !$("user-ban").hidden);
  $("user-role").value = "mod";
  $("user-role").dispatchEvent(new Event("change"));
  await wait(50);
  closePopovers();

  // As a moderator: kick members only, no settings, no roles.
  setRoles({ Elin: "owner", Marcus: "mod", Jonas: "admin" });
  await wait(150);
  check("moderator has no server settings", (() => {
    $("sidebar-head").click();
    const has = $("server-menu").textContent.includes("Server settings");
    closePopovers();
    return !has;
  })());
  const sara = users().find((u) => u.name === "Sara");
  openUserCard(sara, document.body);
  check("moderator may kick a member", !$("user-mod").hidden && $("user-ban").hidden);
  check("moderator can't hand out roles", $("user-role-wrap").hidden);
  closePopovers();
  openUserCard(users().find((u) => u.name === "Jonas"), document.body);
  check("moderator can't act on an admin", $("user-mod").hidden);
  closePopovers();
  check("moderator may delete a member's message", canDelete({ author_key: KEYS.sara }));
  check("moderator may not delete an admin's message", !canDelete({ author_key: KEYS.jonas }));

  // As an admin: settings, moderators, but not admins.
  setRoles({ Elin: "owner", Marcus: "admin", Jonas: "mod" });
  await wait(150);
  $("sidebar-head").click();
  check("admin has server settings", $("server-menu").textContent.includes("Server settings"));
  closePopovers();
  openUserCard(users().find((u) => u.name === "Jonas"), document.body);
  check("admin names moderators, not admins", [...$("user-role").options].map((o) => o.value).join(",") === ",mod");
  check("admin can't transfer", $("user-transfer").hidden);
  closePopovers();

  // Server settings → Members.
  openServerSettings();
  emit("members", [
    { public_key: KEYS.elin, name: "Elin", role: "owner", joined_at: Date.now() - 9e8 },
    { public_key: ME, name: "Marcus", role: "admin", joined_at: Date.now() - 8e8 },
    { public_key: KEYS.jonas, name: "Jonas", role: "mod", joined_at: Date.now() - 7e8 },
    { public_key: KEYS.kim, name: "Kim", role: null, joined_at: Date.now() - 1e8 },
  ]);
  await wait(100);
  const rows = [...document.querySelectorAll("#server-members .admin-row")];
  check("members tab lists everyone, owner first", rows.length === 4 && rows[0].textContent.includes("Elin"));
  check("offline members listed too", rows.some((r) => r.textContent.includes("Kim") && !r.textContent.includes("Online")));
  check("admin gets role pickers for those below", rows.filter((r) => r.querySelector("select")).length === 2);
  $("member-search").value = "ki";
  $("member-search").dispatchEvent(new Event("input"));
  check("search narrows the list", document.querySelectorAll("#server-members .admin-row").length === 1);
  $("server-settings").close();
  report();
})();
