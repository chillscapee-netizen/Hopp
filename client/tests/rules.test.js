// Rules and welcomes, and announcement channels: someone new reads the rules and agrees before
// writing; a welcome is a row of its own with a wave; only staff write in an announcement
// channel; whoever runs the server writes the rules one by one and picks where welcomes go.

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
    check("the rules open by themselves, one per row", $("rules-dialog").open && $("rules-body").querySelectorAll(".rules-item").length === 2);
    $("rules-later").click();
    await wait(30);
    check("later: a bar above the message box asks instead", !$("rules-bar").hidden && $("chat-input").disabled);
    $("rules-open").click();
    await wait(30);
    check("agreeing waits for the tick", $("rules-agree").disabled);
    $("rules-check").click();
    $("rules-agree").click();
    await wait(30);
    check("I agree tells the server", accepted.length === 1);
    emit("rules", { rules: "Be kind.\nNo spam.", at: 5, accepted: true, welcome_channel: 0 });
    await wait(60);
    check("agreed: the message box is back", $("rules-bar").hidden && !$("chat-input").disabled);

    // A welcome, and waving to say hi.
    const sentWave = [];
    const sendReal = commands.send_chat;
    commands.send_chat = (x) => {
      sentWave.push(x);
      return sendReal?.(x);
    };
    emit("chat", { id: 9701, channel: 0, sender: 0, sender_name: "Sara", author_key: KEYS.sara, text: "hopp-joined", sent_at: Date.now() });
    await wait(60);
    const row = document.querySelector('.msg[data-id="9701"]');
    check("a welcome is a row of its own", !!row?.classList.contains("join-msg") && /Sara/.test(row.textContent));
    row?.querySelector(".join-wave")?.click();
    await wait(60);
    check("waving says hi as a reply", sentWave.some((x) => /👋/.test(x.text) && x.replyTo === 9701), JSON.stringify(sentWave));

    // An announcement channel: read only for me.
    const a = structuredClone(r);
    a.channels.find((c) => c.id === 0).announce = true;
    emit("roster", a);
    await wait(80);
    check("an announcement channel: I can't write", $("chat-input").disabled && /Only moderators and admins/.test($("chat-input").placeholder), $("chat-input").placeholder);
    check("its icon is a megaphone", !!document.querySelector('use[href="#i-megaphone"]'));

    // The owner: rules one by one and welcomes in the overview, announcement in channel settings.
    const o = structuredClone(base);
    o.channels.find((c) => c.id === 0).announce = true;
    emit("roster", o);
    await wait(80);
    check("the owner writes in it", !$("chat-input").disabled);
    const saved = [];
    commands.set_rules = (x) => saved.push(x);
    openServerSettings();
    await wait(80);
    const inputs = () => [...$("rules-edit").querySelectorAll("input")];
    check("the overview has the rules, one per row", !$("rules-settings").hidden && inputs().map((i) => i.value).join("|") === "Be kind.|No spam.");
    inputs()[1].closest("li").querySelector(".rules-remove").click();
    await wait(20);
    $("rules-add").click();
    await wait(20);
    inputs()[1].value = "Have fun.";
    inputs()[1].dispatchEvent(new Event("input"));
    $("welcome-channel").value = "0";
    $("rules-save").click();
    await wait(30);
    check("saving sends the rules and the welcome channel", saved[0]?.rules === "Be kind.\nHave fun." && saved[0]?.welcomeChannel === 0, JSON.stringify(saved));
    $("server-settings").close();
    openChannelEdit(state.roster.channels.find((c) => c.id === 0));
    await wait(60);
    check("channel settings offer announcement", !$("channel-edit-announce-row").hidden && $("channel-edit-announce").checked);
    document.querySelector("dialog[open]")?.close();

    // The #rules channel shows them as a card.
    emit("rules", { rules: "Be kind.\nHave fun.", at: 6, accepted: true, welcome_channel: 0, rules_channel: 3 });
    await wait(40);
    openTextChannel(3);
    await wait(100);
    const card = document.querySelector("#messages .rules-card");
    check("the #rules channel shows the rules", !!card && card.querySelectorAll(".rules-item").length === 2 && /agreed/.test(card.textContent));

    // Creating an announcement channel: a text channel, made one only staff write in.
    const created = [];
    const updated = [];
    commands.create_channel = (x) => created.push(x);
    commands.update_channel = (x) => updated.push(x);
    openChannelDialog("text");
    document.querySelector('.type-option[data-kind="announce"]').click();
    $("channel-name").value = "news";
    $("channel-form").requestSubmit();
    await wait(30);
    check("an announcement channel is made as text", created[0]?.kind === "text" && created[0]?.name === "news");
    const n = structuredClone(state.roster);
    n.channels.push({ id: 50, name: "news", kind: "text" });
    emit("roster", n);
    await wait(80);
    check("and then set to announcement", updated.some((u) => u.channel === 50 && u.announce === true), JSON.stringify(updated));

    // Settings: create a #rules channel, and the rules point at it.
    created.length = 0;
    saved.length = 0;
    openServerSettings();
    await wait(80);
    $("rules-channel-pick").value = "new";
    $("rules-save").click();
    await wait(30);
    check("a #rules channel is made", created.some((c) => c.name === "rules"));
    const m = structuredClone(state.roster);
    m.channels.push({ id: 51, name: "rules", kind: "text" });
    emit("roster", m);
    await wait(80);
    check("and the rules are shown in it", saved.some((x) => x.rulesChannel === 51), JSON.stringify(saved));
    $("server-settings").close();
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
