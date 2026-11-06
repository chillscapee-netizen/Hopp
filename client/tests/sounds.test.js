// real-time: 30000
// Hopp's own sounds: each one is audible, never clips, and is short (rendered offline and measured).
(async () => {
  await inServer();
  const report2 = [];
  for (const name of Object.keys(HOPP_SOUNDS)) {
    const ctx = new OfflineAudioContext(1, 44100 * 2, 44100);
    soundCtx = ctx;
    hoppBus = null;
    // Offline time starts at 0.
    playHoppSound(name, 1);
    const buf = await ctx.startRendering();
    const data = buf.getChannelData(0);
    let peak = 0;
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
      if (a > 0.003) last = i;
    }
    const length = last / 44100;
    report2.push(name + " " + peak.toFixed(2) + " " + length.toFixed(2) + "s");
    check(name + " is heard, never clips", peak > 0.05 && peak < 0.98, peak.toFixed(3));
    check(name + " is short", length < (name === "ring" ? 1.8 : 1.2), length.toFixed(2) + " s");
  }
  soundCtx = null;
  hoppBus = null;
  check("levels", true, report2.join(" | "));
  report();
})();
