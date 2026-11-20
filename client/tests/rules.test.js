// Rules and welcomes, and announcement channels: someone new reads the rules and agrees before
// writing; a welcome is a row of its own with a wave; only staff write in an announcement
// channel; #rules and #welcome are made like any channel and written in place.

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
    emit("rules", { rules: "Be kind.\nNo spam.", at: 5, accepted: false, welcome_channel: 0, rules_channel: null });
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
    emit("rules", { rules: "Be kind.\nNo spam.", at: 5, accepted: true, welcome_channel: 0, rules_channel: null });
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

    // The owner makes #rules like any channel, and writes the rules in it.
    const o = structuredClone(base);
    emit("roster", o);
    emit("rules", { rules: null, at: 0, accepted: true, welcome_channel: null, rules_channel: null });
    await wait(80);
    const created = [];
    const saved = [];
    const updated = [];
    commands.create_channel = (x) => created.push(x);
    commands.set_rules = (x) => saved.push(x);
    commands.update_channel = (x) => updated.push(x);
    openChannelDialog("text");
    await wait(30);
    check("Create channel offers Rules and Welcome", !document.querySelector('.type-option[data-kind="rules"]').hidden && !document.querySelector('.type-option[data-kind="welcome"]').hidden);
    document.querySelector('.type-option[data-kind="rules"]').click();
    check("Rules comes named", $("channel-name").value === "rules");
    $("channel-form").requestSubmit();
    await wait(30);
    check("a text channel called rules is made", created.some((c) => c.name === "rules" && c.kind === "text"));
    const withRules = structuredClone(state.roster);
    withRules.channels.push({ id: 51, name: "rules", kind: "text" });
    emit("roster", withRules);
    await wait(100);
    check("it becomes the rules channel", saved.some((x) => x.rulesChannel === 51), JSON.stringify(saved));
    emit("rules", { rules: null, at: 0, accepted: true, welcome_channel: null, rules_channel: 51 });
    await wait(100);
    check("and opens, ready to write the rules", state.view === 51 && !!document.querySelector("#messages .rules-card.editing"), JSON.stringify({ view: state.view, done: state.olderDone.has(51), editing: rulesEditing, rc: state.rules?.rules_channel, first: document.querySelector("#messages > li")?.className }));
    const inputs = () => [...document.querySelectorAll("#messages .rules-card.editing input")];
    inputs()[0].value = "Be kind.";
    inputs()[0].dispatchEvent(new Event("input"));
    [...document.querySelectorAll("#messages .rules-card.editing button")].find((b) => /Add a rule/.test(b.textContent)).click();
    await wait(20);
    inputs()[1].value = "Have fun.";
    inputs()[1].dispatchEvent(new Event("input"));
    [...document.querySelectorAll("#messages .rules-card.editing button")].find((b) => b.textContent === "Save rules").click();
    await wait(40);
    check("saving sends the rules", saved.some((x) => x.rules === "Be kind.\nHave fun." && x.rulesChannel === 51), JSON.stringify(saved));
    emit("rules", { rules: "Be kind.\nHave fun.", at: 7, accepted: true, welcome_channel: null, rules_channel: 51 });
    await wait(80);
    const card = document.querySelector("#messages .rules-card");
    check("the channel shows them, with Edit rules for me", !!card && !card.classList.contains("editing") && card.querySelectorAll(".rules-item").length === 2 && /Edit rules/.test(card.textContent));

    // #welcome: made the same way; only staff write there; a template for the first welcome.
    created.length = 0;
    saved.length = 0;
    openChannelDialog("text");
    await wait(30);
    check("Rules isn't offered twice", document.querySelector('.type-option[data-kind="rules"]').hidden);
    document.querySelector('.type-option[data-kind="welcome"]').click();
    $("channel-form").requestSubmit();
    await wait(30);
    const withWelcome = structuredClone(state.roster);
    withWelcome.channels.push({ id: 52, name: "welcome", kind: "text" });
    emit("roster", withWelcome);
    await wait(100);
    check("a #welcome channel only staff write in", created.some((c) => c.name === "welcome") && updated.some((u) => u.channel === 52 && u.announce === true));
    check("and welcomes go there", saved.some((x) => x.welcomeChannel === 52 && x.rulesChannel === 51), JSON.stringify(saved));
    emit("rules", { rules: "Be kind.\nHave fun.", at: 7, accepted: true, welcome_channel: 52, rules_channel: 51 });
    await wait(100);
    const helper = document.querySelector("#messages .welcome-helper");
    check("an empty #welcome offers a template", state.view === 52 && !!helper);
    helper?.querySelector("button")?.click();
    await wait(30);
    check("the template is a welcome with headings and the rules", /^# Welcome to /.test($("chat-input").value) && /#rules/.test($("chat-input").value), $("chat-input").value);
    $("chat-input").value = "";
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
