// Streamer mode: private things blurred, notifications without what was written, the
// recovery phrase kept hidden, a note in the top bar that turns it off; on by itself while
// sharing your screen (and off after), unless that's turned off.

(async () => {
  await inServer();
  const blurred = (el) => getComputedStyle(el).filter.includes("blur");
  check("off to begin with", !document.documentElement.classList.contains("streamer") && $("streamer-pill").hidden);

  $("streamer-mode").checked = true;
  $("streamer-mode").dispatchEvent(new Event("change"));
  await wait(30);
  check("on: the note shows in the top bar", !$("streamer-pill").hidden);
  check("invite links and your username are blurred", blurred($("invite-link")) && blurred($("profile-username")) && blurred($("profile-handle")));
  const notes = [];
  commands.notify = (a) => notes.push(a.body);
  const hasFocus = document.hasFocus;
  document.hasFocus = () => false;
  await desktopNotify({ display_name: "Elin" }, "my address is 12 Secret Street", "dm:" + KEYS.elin);
  document.hasFocus = hasFocus;
  check("notifications don't show what was written", notes[0] === "Sent a message", notes[0]);
  const toasts = [];
  const realToast = toast;
  window.toast = (t) => toasts.push(t);
  await openBackup({ viewOnly: true });
  window.toast = realToast;
  check("the recovery phrase can't be shown", !$("backup-dialog")?.open && toasts.some((t) => /streamer mode/i.test(t)), toasts.join(" | "));

  $("streamer-pill").click();
  await wait(30);
  check("the note turns it off", !document.documentElement.classList.contains("streamer") && $("streamer-pill").hidden && !blurred($("invite-link")));

  // By itself while sharing.
  media.out.screen = { peers: new Map(), told: new Set() };
  syncStreamerAuto();
  check("sharing your screen turns it on", document.documentElement.classList.contains("streamer"));
  delete media.out.screen;
  syncStreamerAuto();
  check("and off again after", !document.documentElement.classList.contains("streamer"));
  $("streamer-auto").checked = false;
  $("streamer-auto").dispatchEvent(new Event("change"));
  media.out.screen = { peers: new Map(), told: new Set() };
  syncStreamerAuto();
  check("unless that's turned off", !document.documentElement.classList.contains("streamer"));
  delete media.out.screen;
  report();
})();
