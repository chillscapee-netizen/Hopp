// Watching together: a button in the voice view starts a YouTube video for everyone in the
// channel; it plays in the middle, follows what's shared, and goes when it stops.

(async () => {
  try {
    await inServer();
    const r = structuredClone(state.roster);
    r.features = [...(r.features ?? []), "watch"];
    r.users.find((u) => u.session_id === r.me).voice_channel = 1;
    emit("roster", r);
    await wait(100);
    openTextChannel(1);
    await wait(150);
    const sent = [];
    commands.watch_set = (a) => {
      sent.push(a);
      setTimeout(() => emit("watch", { channel: 1, video: a.video, position: a.position, playing: a.playing, at_ago: 0, by: "Marcus" }), 5);
    };
    const button = () => document.querySelector('#voice-stage [data-vc="watch"]');
    check("the voice view has Watch together", !!button());

    // Starting: a link asked for, then shared.
    button().click();
    await wait(50);
    check("it asks for a YouTube link", $("text-dialog").open);
    $("text-input").value = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30";
    $("text-form").requestSubmit();
    await wait(150);
    check("it's shared with where to start", sent.some((m) => m.video === "dQw4w9WgXcQ" && m.position === 30 && m.playing));
    const frame = () => $("watch-frame").querySelector("iframe");
    check("it plays in the middle of the voice view", !$("watch-stage").hidden && /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/.test(frame()?.src ?? "") && !!document.querySelector("#voice-stage .watch-slot"));
    check("saying who started it", /started by Marcus/.test($("watch-by").textContent));

    // Someone else's change of video: the player follows.
    emit("watch", { channel: 1, video: "aaaaaaaaaaa", position: 5, playing: true, at_ago: 0, by: "Elin" });
    await wait(80);
    check("another video: the player follows", /embed\/aaaaaaaaaaa/.test(frame()?.src ?? "") && /started by Elin/.test($("watch-by").textContent));

    // A text channel, then back: not shown there, back in the voice view.
    openTextChannel(0);
    await wait(80);
    check("in a text channel, the player isn't shown", $("watch-stage").hidden);
    openTextChannel(1);
    await wait(150);
    check("back in the voice view, it's there again", !$("watch-stage").hidden, JSON.stringify({ here: watchHere(), slot: !!document.querySelector("#voice-stage .watch-slot"), frame: !!watchPlayer.frame, view: state.view, voice: myVoice(), w: state.watch }));

    // Stopped: gone.
    $("watch-stop").click();
    await wait(80);
    check("Stop ends it for everyone", sent.some((m) => m.video === null) && $("watch-stage").hidden && !frame());

    // Leaving the channel: it's forgotten here (if they stop it while you're away, you'd never hear).
    emit("watch", { channel: 1, video: "bbbbbbbbbbb", position: 0, playing: true, at_ago: 0, by: "Elin" });
    await wait(50);
    const out = structuredClone(state.roster);
    out.users.find((u) => u.session_id === out.me).voice_channel = null;
    emit("roster", out);
    await wait(80);
    check("leaving the channel forgets what it was watching", state.watch === null && $("watch-stage").hidden);
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
