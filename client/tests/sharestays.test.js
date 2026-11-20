// real-time: 20000
// Your stream goes on when you look at another server (like Discord): it ends only when you stop
// or leave voice. And a stream shows in its voice channel, not over every other chat.

(async () => {
  try {
    await inServer();
    const first = activeServer();
    const rows = [...document.querySelectorAll("#server-list .rail-item")];
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const g = canvas.getContext("2d");
    const draw = setInterval(() => g.fillRect(0, 0, 10, 10), 33);
    navigator.mediaDevices.getDisplayMedia = async () => canvas.captureStream(30);
    const sent = [];
    const keep = (type) => (a) => sent.push({ type, ...a });
    commands.set_sharing = keep("set_sharing");
    commands.screen_signal = keep("screen_signal");
    commands.leave_voice = keep("leave_voice");

    const base = structuredClone(state.roster);
    base.features = ["search", "screen", "voice-chat", "resync"];
    base.users.find((u) => u.session_id === base.me).voice_channel = 1;
    const elin = base.users.find((u) => u.session_id !== base.me);
    elin.voice_channel = 1;
    emit("roster", base);
    await wait(80);

    $("share-btn").click();
    await wait(200);
    check("sharing", !!screenShare.stream && sent.some((m) => m.type === "set_sharing" && m.on));
    check("stream settings sit in the call's own row", !document.querySelector("#voice-stage .voice-controls") || !!document.querySelector('#voice-stage [data-vc="quality"]'));

    // Your own stream shows in the voice channel, not above a text channel.
    openTextChannel(1);
    await wait(60);
    check("in the voice channel: your stream shows", !$("screen-stage").hidden);
    const text = textChannels()[0]?.id;
    openTextChannel(text);
    await wait(60);
    check("in a text channel: it doesn't follow you there", $("screen-stage").hidden);
    check("but it's still going", !!screenShare.stream);

    // Another server: the stream goes on.
    sent.length = 0;
    rows[1].click();
    for (let i = 0; i < 40 && !(online() && activeServer()?.id !== first.id); i++) await wait(50);
    await wait(100);
    check("on the other server", activeServer()?.id !== first.id && !!state.voiceAway);
    check("your stream goes on", !!screenShare.stream && !sent.some((m) => m.type === "set_sharing" && !m.on));
    check("nothing of it shows over this server", $("screen-stage").hidden);

    // Someone asks to watch while you're away: they get it.
    emit("screen-signal", { from: elin.session_id, data: JSON.stringify({ k: "watch", s: "sharer" }) });
    for (let i = 0; i < 20 && !sent.some((m) => m.type === "screen_signal" && JSON.parse(m.data).k === "offer"); i++) await wait(50);
    check("a viewer asking meanwhile gets your stream", sent.some((m) => m.type === "screen_signal" && m.to === elin.session_id && JSON.parse(m.data).k === "offer"));

    // Back to the first server: your stream is there in its voice channel again.
    rows[0].click();
    for (let i = 0; i < 40 && !(online() && activeServer()?.id === first.id); i++) await wait(50);
    // (As a real server does: you're still in its voice channel.)
    emit("roster", base);
    await wait(150);
    check("back: still sharing, and your own stream is ready again", !!screenShare.stream && watching?.local === true);
    openTextChannel(1);
    await wait(80);
    check("it shows in the voice channel", !$("screen-stage").hidden);
    rows[1].click();
    for (let i = 0; i < 40 && !(online() && activeServer()?.id !== first.id); i++) await wait(50);
    await wait(100);
    // Hanging up from away ends it.
    $("hangup-btn").click();
    await wait(60);
    check("leaving voice ends your stream", !screenShare.stream);
    clearInterval(draw);
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
