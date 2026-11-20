// Server settings → Members, on a server with its own roles: staff come first in groups, roles
// show as chips, and ⋯ gives a role (the menu sits on top of the settings, where it's clicked).

(async () => {
  try {
    await inServer();
    const r = structuredClone(state.roster);
    r.features = [...(r.features ?? []), "roles", "members"];
    r.roles = [{ id: 7, name: "Crew", color: "#46a758", hoist: true, level: "mod", position: 2 }, { id: 9, name: "Brand new", color: null, hoist: false, level: null, position: 1 }];
    emit("roster", r);
    await wait(80);
    const sent = [];
    commands.assign_role = (a) => sent.push(a);
    commands.get_members = () => {};
    openServerSettings();
    await wait(50);
    showServerTab("members");
    emit("members", [
      { public_key: "elin-key", name: "Elin", role: "mod", roles: [7], joined_at: Date.now() },
      { public_key: "jonas-key", name: "Jonas", role: null, roles: [], joined_at: Date.now() },
    ]);
    await wait(50);
    const groups = [...document.querySelectorAll("#server-members .member-group")].map((g) => g.textContent);
    check("staff come first, in groups", groups.join("|") === "Moderators — 1|Members — 1", groups.join("|"));
    const row = (n) => [...document.querySelectorAll("#server-members .member-admin-row")].find((li) => li.textContent.includes(n));
    check("someone's roles show as chips", [...row("Elin").querySelectorAll(".member-chip")].map((c) => c.textContent).join() === "Crew");
    check("no roles: no chips", !row("Jonas").querySelector(".member-chip"));
    row("Jonas").querySelector(".member-more").click();
    await wait(30);
    const menuEl = document.getElementById("server-menu");
    const box = menuEl.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    check("the menu shows on top of the settings, where you can click it", !menuEl.hidden && menuEl.contains(top), top?.outerHTML?.slice(0, 80));
    const fold = [...menuEl.querySelectorAll(".menu-item")].find((b) => b.textContent.trim().startsWith("Roles"));
    fold?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    fold?.click();
    await wait(60);
    const pick = [...document.querySelectorAll(".menu-item")].find((b) => b.textContent.trim() === "Brand new");
    check("the new role is in its Roles", !!pick);
    pick?.click();
    await wait(30);
    check("ticking it gives it", sent.some((a) => a.publicKey === "jonas-key" && a.role === 9 && a.on === true), JSON.stringify(sent));
    check("and the row shows it", [...row("Jonas").querySelectorAll(".member-chip")].some((c) => c.textContent === "Brand new"));
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
