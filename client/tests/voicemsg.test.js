// real-time: 30000
// Voice messages: recorded from the microphone (a tone stands in), sent as Opus in WebM,
// shown as a player; too short isn't sent, cancel throws it away.

(async () => {
  try {
    await inServer();
    const r = structuredClone(state.roster);
    r.features = [...(r.features ?? []), "voice-messages"];
    emit("roster", r);
    await wait(60);
    const ctx = new AudioContext();
    navigator.mediaDevices.getUserMedia = async () => {
      const osc = ctx.createOscillator();
      const dest = ctx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      return dest.stream;
    };
    const uploads = [];
    commands.upload_image = (a) => {
      uploads.push(a);
      return "cd".repeat(16);
    };
    const sent = [];
    commands.send_chat = (a) => sent.push(a.text);

    check("the message box has a record button", !$("voice-msg-btn").hidden);
    $("voice-msg-btn").click();
    await wait(300);
    check("recording shows in the message box", !$("recorder").hidden && document.querySelector("#composer .composer-row").hidden);
    $("recorder-cancel").click();
    await wait(300);
    check("cancel throws it away", $("recorder").hidden && !uploads.length && !sent.length);

    $("voice-msg-btn").click();
    await wait(1600);
    $("recorder-send").click();
    for (let i = 0; i < 30 && !sent.length; i++) await wait(100);
    const up = uploads[0];
    check("it's uploaded as Opus in WebM", up?.kind === "audio/webm" && up.data[0] === 0x1a && up.data[1] === 0x45 && up.data[2] === 0xdf && up.data[3] === 0xa3, up && up.kind + " " + up.data.slice(0, 4));
    check("and small", up?.data.length < 40_000, String(up?.data.length));
    const m = sent[0]?.match(VOICE_MESSAGE);
    check("then sent as a voice message with its length", !!m && Number(m[2]) >= 1200 && Number(m[2]) < 4000, sent[0]);

    emit("chat", { id: 9960, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "hopp-voice:" + "cd".repeat(16) + " 12500", sent_at: Date.now() });
    await wait(80);
    const player = document.querySelector('.msg[data-id="9960"] .voice-msg');
    check("it shows as a player with its length", !!player && player.querySelector(".voice-msg-time").textContent === "0:13" && !!player.querySelector(".voice-msg-play"));
    check("previews say it's a voice message", previewText("hopp-voice:" + "cd".repeat(16) + " 12500") === "🎤 Voice message");
    check("it can't be forwarded or edited", !canForward("hopp-voice:" + "cd".repeat(16) + " 12500"));

    // Too short: not sent.
    sent.length = 0;
    $("voice-msg-btn").click();
    await wait(200);
    $("recorder-send").click();
    await wait(400);
    check("a blip isn't sent", !sent.length);
  } catch (err) {
    check("no crash", false, err.stack);
  }
  report();
})();
