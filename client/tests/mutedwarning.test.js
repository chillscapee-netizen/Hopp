// Talking into a muted mic: one reminder per mute, not a box that keeps coming back.

(async () => {
  await inServer();
  const warned = () => !$("toast").hidden && $("toast").textContent.startsWith("You're muted");
  const hide = () => ($("toast").hidden = true);
  const talkMuted = () => emit("voice", { type: "speaking_while_muted" });

  await setMuted(true);
  hide();
  talkMuted();
  await wait(30);
  check("the first time: you're told", warned());
  hide();
  talkMuted();
  emit("call-voice", { type: "speaking_while_muted" });
  await wait(30);
  check("still muted: not again (voice or call)", !warned());

  await setMuted(false);
  await setMuted(true);
  hide();
  talkMuted();
  await wait(30);
  check("muted again later: told once more", warned());

  hide();
  await setMuted(false);
  await setMuted(true);
  prefs.mutedWarning = false;
  talkMuted();
  await wait(30);
  check("with the reminder turned off: nothing", !warned());
  prefs.mutedWarning = true;
  report();
})();
