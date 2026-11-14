// Doing less when it isn't needed: the microphone level only travels while a meter is on
// screen, echo removal is off for headphones, and a hidden Hopp gives memory back.

(async () => {
  await inServer();
  const asked = [];
  const record = (name) => (a) => { asked.push([name, a]); return null; };
  commands.set_level_meter = record("meter");
  commands.set_echo_cancellation = record("echo");
  commands.set_memory_low = record("memory");
  const last = (name) => asked.filter(([n]) => n === name).at(-1)?.[1];

  // Level meter: on while the voice settings show one, off when they close.
  openSettings("voice");
  await wait(1100);
  check("voice settings open: the level is wanted", last("meter")?.on === true, JSON.stringify(last("meter")));
  $("settings").close?.();
  await wait(1100);
  await wait(150);
  check("closed: not wanted any more", last("meter")?.on === false, JSON.stringify(last("meter")));

  // Echo removal follows the output: off for headphones, on for speakers, never against your choice.
  prefs.echo = true;
  applyEcho({ default_output: "Hörlurar (Realtek(R) Audio)", outputs: [] });
  check("headphones: echo removal off", last("echo")?.on === false);
  applyEcho({ default_output: "Speakers (Realtek(R) Audio)", outputs: [] });
  check("speakers: echo removal on", last("echo")?.on === true);
  applyEcho({ default_output: "Headset Earphone (Arctis 7)", outputs: [] });
  check("a headset counts as headphones", last("echo")?.on === false);
  prefs.echo = false;
  applyEcho({ default_output: "Speakers", outputs: [] });
  check("turned off by you: stays off on speakers", last("echo")?.on === false);
  prefs.echo = true;

  // Hidden: less memory; shown again: back to normal.
  Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
  document.dispatchEvent(new Event("visibilitychange"));
  check("hidden: give memory back", last("memory")?.low === true);
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  document.dispatchEvent(new Event("visibilitychange"));
  check("shown again: normal", last("memory")?.low === false);
  report();
})();
