// Limits a person meets: a box takes what it promises, and what the server wouldn't keep is said
// before sending (not "Saved", or a poll that vanishes with a cryptic error).

(async () => {
  try {
    await inServer();
    const r = structuredClone(state.roster);
    r.features = [...(r.features ?? []), "polls", "automod"];
    emit("roster", r);
    await wait(80);
    openTextChannel(0);
    await wait(80);

    // A long poll (å, ä, ö take more room once encoded): kept open with a reason.
    const sent = [];
    const send = commands.send_chat;
    commands.send_chat = (a) => {
      sent.push(a);
      return send?.(a);
    };
    openPollDialog();
    await wait(30);
    $("poll-question").value = "å".repeat(300);
    while ($("poll-answers").querySelectorAll("input").length < 10) addPollAnswer();
    for (const i of $("poll-answers").querySelectorAll("input")) i.value = "ö".repeat(55);
    $("poll-form").requestSubmit();
    await wait(50);
    check("a poll too long to send says so, and stays open", $("poll-dialog").open && !$("poll-error").hidden && /too long/.test($("poll-error").textContent));
    check("and isn't sent", !sent.some((a) => /^hopp-poll:/.test(a.text ?? "")));
    $("poll-dialog").close();

    // AutoMod: a phrase past what the server keeps isn't quietly dropped.
    const saved = [];
    commands.set_automod = (a) => saved.push(a);
    $("safety-words").value = "fine\n" + "x".repeat(41);
    $("safety-save").click();
    await wait(50);
    check("a too-long blocked phrase is said, not saved", saved.length === 0 && $("safety-saved").hidden);
    $("safety-words").value = "fine\nalso fine";
    $("safety-save").click();
    await wait(50);
    check("short ones are saved", saved.length === 1 && saved[0].words.length === 2);
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
