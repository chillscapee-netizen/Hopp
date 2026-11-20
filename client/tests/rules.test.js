// Rules and welcomes, and announcement channels: someone new reads the rules and agrees before
// writing; a welcome is a row of its own; only staff write in an announcement channel; whoever
// runs the server sets the rules and where welcomes go.

(async () => {
  try {
    await inServer();
    openTextChannel(0);
    const base = structuredClone(state.roster);
    base.features = [...(base.features ?? []), "rules", "announce", "perms"];

    // Me, new here: no switches.
    const r = structuredClone(base);
    Object.assign(r.users.find((u) => u.session_id === r.me), { owner: false, role: null, perms: undefined });
    emit("roster", r);
    await wait(80);
    const accepted = [];
    commands.accept_rules = () => accepted.push(true);
    emit("rules", { rules: "Be kind.\nNo spam.", at: 5, accepted: false, welcome_channel: 0 });
    await wait(80);
    check("the rules open by themselves", $("rules-dialog").open && /Be kind/.test($("rules-body").textContent));
    $("rules-later").click();
    await wait(30);
    check("later: a bar above the message box asks instead", !$("rules-bar").hidden && $("chat-input").disabled);
    $("rules-open").click();
    await wait(30);
    $("rules-agree").click();
    await wait(30);
    check("I agree tells the server", accepted.length === 1);
    emit("rules", { rules: "Be kind.\nNo spam.", at: 5, accepted: true, welcome_channel: 0 });
    await wait(60);
    check("agreed: the message box is back", $("rules-bar").hidden && !$("chat-input").disabled);

    // A welcome.
    emit("chat", { id: 9701, channel: 0, sender: 0, sender_name: "Sara", author_key: KEYS.sara, text: "hopp-joined", sent_at: Date.now() });
    await wait(60);
    const row = document.querySelector('.msg[data-id="9701"]');
    check("a welcome is a row of its own", !!row?.classList.contains("join-msg") && /Sara joined the server/.test(row.textContent));

    // An announcement channel: read only for me.
    const a = structuredClone(r);
    a.channels.find((c) => c.id === 0).announce = true;
    emit("roster", a);
    await wait(80);
    check("an announcement channel: I can't write", $("chat-input").disabled && /Only moderators and admins/.test($("chat-input").placeholder), $("chat-input").placeholder);
    check("its icon is a megaphone", !!document.querySelector('#channel-list use[href="#i-megaphone"], .channel-row use[href="#i-megaphone"]'));

    // The owner: rules and welcomes in the overview, announcement in channel settings.
    const o = structuredClone(base);
    o.channels.find((c) => c.id === 0).announce = true;
    emit("roster", o);
    await wait(80);
    check("the owner writes in it", !$("chat-input").disabled);
    const saved = [];
    commands.set_rules = (x) => saved.push(x);
    openServerSettings();
    await wait(80);
    check("the overview has rules and welcomes", !$("rules-settings").hidden && $("rules-text-input").value === "Be kind.\nNo spam.");
    $("rules-text-input").value = "Be kind.";
    $("welcome-channel").value = "0";
    $("rules-save").click();
    await wait(30);
    check("saving sends the rules and the welcome channel", saved[0]?.rules === "Be kind." && saved[0]?.welcomeChannel === 0, JSON.stringify(saved));
    $("server-settings").close();
    openChannelEdit(state.roster.channels.find((c) => c.id === 0));
    await wait(60);
    check("channel settings offer announcement", !$("channel-edit-announce-row").hidden && $("channel-edit-announce").checked);
    document.querySelector("dialog[open]")?.close();
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
