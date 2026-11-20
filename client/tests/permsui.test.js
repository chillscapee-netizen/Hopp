// Switches in the app: someone sees just the buttons their switches allow, and a role saves its
// switches; older servers (only levels) keep the three level cards.

(async () => {
  try {
    await inServer();
    const base = structuredClone(state.roster);
    base.features = [...(base.features ?? []), "roles", "perms", "automod", "emojis"];
    base.roles = [
      { id: 1, name: "Kickers", color: null, hoist: false, level: "mod", position: 2, mentionable: false, perms: ["kick"] },
      { id: 2, name: "Builders", color: null, hoist: false, level: null, position: 1, mentionable: false, perms: ["manage_channels"] },
    ];

    // Me with only Kick.
    const r = structuredClone(base);
    const mine = r.users.find((u) => u.session_id === r.me);
    Object.assign(mine, { owner: false, role: "mod", roles: [1], perms: ["kick"] });
    emit("roster", r);
    await wait(100);
    check("only kick: may kick", may("kick"));
    check("but not ban, time out or manage channels", !may("ban") && !may("timeout") && !may("manage_channels"));
    openServerSettings();
    await wait(100);
    const visible = [...document.querySelectorAll("[data-stab]")].filter((t) => !t.hidden).map((t) => t.dataset.stab);
    check("settings show only what kick reaches (members)", visible.join() === "members", visible.join());
    check("and open on it", !document.querySelector('[data-spanel="members"]')?.hidden);
    $("server-settings").close();
    $("server-settings").dispatchEvent(new Event("close"));

    // A person's menu: Kick, no Ban, no Time out.
    const elin = r.users.find((u) => u.name === "Elin");
    const row = [...document.querySelectorAll("#members .member, .member")].find((x) => /Elin/.test(x.textContent));
    row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 300, clientY: 200 }));
    await wait(80);
    // Moderation folds out to the side.
    const fold = [...$("server-menu").querySelectorAll(".menu-item")].find((b) => /Moderation/.test(b.textContent));
    check("a person's menu has Moderation", !!fold);
    fold?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    fold?.click();
    await wait(80);
    const words = document.body.textContent;
    check("with Kick in it", /Kick Elin/.test(words));
    check("and no Ban or Time out", !/Ban Elin/.test(words) && !/Time out/.test(words));
    closePopovers();

    // The owner edits a role's switches; they're saved.
    const o = structuredClone(base);
    emit("roster", o);
    await wait(100);
    const sent = [];
    commands.update_role = (a) => sent.push(a);
    openServerSettings();
    showServerTab("roles");
    await wait(100);
    openRole(state.roster.roles[1]);
    await wait(80);
    check("switches, not level cards", !$("role-perms").hidden && $("role-levels").hidden);
    const sw = (p) => $("role-perms").querySelector(`input[data-perm="${p}"]`);
    check("the role's switch is on", sw("manage_channels").checked && !sw("kick").checked);
    sw("ban").click();
    await wait(30);
    $("role-editor").requestSubmit();
    await wait(50);
    check("saving sends its switches", JSON.stringify(sent.at(-1)?.perms) === JSON.stringify(["manage_channels", "ban"]), JSON.stringify(sent.at(-1)));
    // Administrator includes all: the others show on and can't be changed.
    sw("administrator").click();
    await wait(30);
    check("Administrator includes everything", sw("kick").checked && sw("kick").disabled);
    // Start from Moderator fills the checklist in; it can still be changed.
    document.querySelector('#role-perms [data-preset="mod"]').click();
    await wait(30);
    check("Moderator ticks its things", sw("kick").checked && sw("timeout").checked && !sw("ban").checked);
    sw("kick").click();
    await wait(30);
    check("and a moderator role can be changed (no kicking)", !sw("kick").checked && sw("timeout").checked && /time out/.test(document.querySelector(".role-summary").textContent));
    check("every thing a role can do is listed", $("role-perms").querySelectorAll("input[data-perm]").length === 18);

    // Members: who has it, and adding someone by name.
    const given = [];
    commands.assign_role = (a) => given.push(a);
    showRoleTab("members");
    $("role-member-search").value = "sar";
    $("role-member-search").dispatchEvent(new Event("input"));
    await wait(30);
    const add = [...$("role-member-results").querySelectorAll("button")].find((b) => b.textContent === "Add");
    add?.click();
    await wait(30);
    check("adding someone gives them the role at once", given.some((g) => g.on === true && g.role === 2));
    showRoleTab("display");
    $("server-settings").close();

    // An older server: three level cards as before.
    const old = structuredClone(base);
    old.features = old.features.filter((f) => f !== "perms");
    old.roles.forEach((x) => delete x.perms);
    emit("roster", old);
    await wait(100);
    openServerSettings();
    showServerTab("roles");
    await wait(80);
    openRole(state.roster.roles[0]);
    await wait(50);
    check("an older server keeps the level cards", $("role-perms").hidden && !$("role-levels").hidden);
    $("server-settings").close();
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
