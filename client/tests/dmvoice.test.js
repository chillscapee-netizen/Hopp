// Voice messages in DMs: the microphone in the box records (the bar takes the row's place), and
// sending encrypts the sound and sends a "hopp-dm-voice" message that's drawn as a player.

(async () => {
  try {
    await inServer();
    openDm(KEYS.elin);
    await wait(300);
    // A "microphone": a quiet tone.
    const ctx = new AudioContext();
    navigator.mediaDevices.getUserMedia = async () => {
      const osc = ctx.createOscillator();
      const dest = ctx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      return dest.stream;
    };
    let uploaded = null;
    commands.upload_dm_image = (a) => {
      uploaded = a.data.length;
      return "ab".repeat(16);
    };
    const mic = document.querySelector(".dm-composer [aria-label='Record a voice message']");
    check("a microphone in the DM box", !!mic);
    mic.click();
    await wait(300);
    const bar = document.querySelector(".dm-composer .recorder");
    check("recording: the bar shows instead of the row", !bar.hidden && document.querySelector(".dm-composer .composer-row").hidden);
    // Thrown away first (as in a server), then recorded for real.
    bar.querySelector("[aria-label='Throw away']").click();
    await wait(300);
    check("throwing it away brings the row back", bar.hidden);
    // Sending what was recorded (a headless page has no real sound to record).
    sent.length = 0;
    await sendDmVoice(KEYS.elin, new Uint8Array(5000).fill(7), 2400);
    for (let i = 0; i < 30 && !sent.some((m) => m.type === "dm_send"); i++) await wait(100);
    const out = sent.find((m) => m.type === "dm_send");
    check("the sound was uploaded encrypted", uploaded > 200, String(uploaded) + " " + [...document.querySelectorAll(".toast")].map((t) => t.textContent).join(" | "));
    check("and a voice message sent, sealed", /^plain:hopp-dm-voice:[0-9a-f]{64}:[0-9a-f]{32}:[A-Za-z0-9_-]{43} \d+$/.test(out?.sealed ?? ""), out?.sealed);
    check("the row is back", document.querySelector(".dm-composer .recorder").hidden && !document.querySelector(".dm-composer .composer-row").hidden);
    emit("account", { type: "dm", with: KEYS.elin, message: { id: "v1", from_key: ME, sealed: out.sealed, sent_at: Date.now() + 9 } });
    await wait(200);
    check("drawn as a player", !!document.querySelector(`.dm-messages [data-key="${CSS.escape(KEYS.elin + "|v1")}"] .voice-msg`));
    check("the code never shows", !document.querySelector(".dm-messages").textContent.includes("hopp-dm-voice"));
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
