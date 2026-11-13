// Server settings → Members, on a server with its own roles: a new role shows there and can be given.

(async () => {
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
    { public_key: "elin-key", name: "Elin", role: null, roles: [7], joined_at: Date.now() },
    { public_key: "jonas-key", name: "Jonas", role: null, roles: [], joined_at: Date.now() },
  ]);
  await wait(50);
  const row = (n) => [...document.querySelectorAll("#server-members .member-admin-row")].find((li) => li.textContent.includes(n));
  check("someone's roles show by name", row("Elin")?.querySelector(".member-roles")?.textContent.includes("Crew"), row("Elin")?.textContent);
  check("no roles says so", row("Jonas")?.querySelector(".member-roles")?.textContent.includes("No roles"));
  row("Jonas").querySelector("button.member-roles").click();
  await wait(30);
  const menuEl = document.getElementById("server-menu");
  const box = menuEl.getBoundingClientRect();
  const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  check("the menu shows on top of the settings, where you can click it", !menuEl.hidden && menuEl.contains(top), top?.outerHTML?.slice(0, 80));
  const items = [...document.querySelectorAll("#server-menu .menu-item")].map((b) => b.textContent.trim());
  check("the new role is in the list", items.includes("Brand new"), items.join(", "));
  [...document.querySelectorAll("#server-menu .menu-item")].find((b) => b.textContent.trim() === "Brand new").click();
  await wait(30);
  check("ticking it gives it", sent.some((a) => a.publicKey === "jonas-key" && a.role === 9 && a.on === true), JSON.stringify(sent));
  check("and the row shows it", row("Jonas")?.querySelector(".member-roles")?.textContent.includes("Brand new"));
  report();
})();
