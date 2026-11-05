// real-time: 30000
// Settings: you at the top, the account split into small pages, notifications you control.

(async () => {
  await inServer();
  openSettings("windows");
  await wait(50);
  check("you're at the top of the menu", document.getElementById("settings-me-name").textContent === "Marcus" && !!document.querySelector("#settings-me-avatar .avatar"));
  document.getElementById("settings-me").click();
  check("and it opens your profile", !document.querySelector('[data-panel="profile"]').hidden);
  for (const tab of ["security", "privacy", "keys", "sounds"]) {
    document.querySelector(`.settings-tab[data-tab="${tab}"]`).click();
    check(`the ${tab} page opens on its own`, !document.querySelector(`[data-panel="${tab}"]`).hidden && document.querySelectorAll("#settings .settings-page:not([hidden])").length === 1);
  }
  check("the password lives under security", !!document.querySelector('[data-panel="security"] #change-password-btn'));
  check("friend requests live under privacy", !!document.querySelector('[data-panel="privacy"] #privacy-requests'));
  check("log out sits at the foot", !!document.querySelector(".settings-nav-foot #logout-btn"));
  check("debug info moved into App", !!document.querySelector('[data-panel="windows"] #copy-debug'));

  // Notifications: off means none; without the text, only who wrote.
  const sees = () => sent.filter((m) => m.type === "notify");
  document.hasFocus = () => false; // Notifications are only for when Hopp is in the background.
  sent.length = 0;
  document.getElementById("notify-text").click();
  await desktopNotify({ display_name: "Elin" }, "the secret plan", "dm:abc");
  check("without the text, a message only says who wrote", sees()[0]?.body === "Sent a message", JSON.stringify(sees()[0]));
  await desktopNotify({ display_name: "Elin" }, "Sent you a friend request", "friend-requests");
  check("other notices still say what happened", sees()[1]?.body === "Sent you a friend request");
  document.getElementById("desktop-notify").click();
  check("the text switch rests while notifications are off", document.getElementById("notify-text").disabled);
  await desktopNotify({ display_name: "Elin" }, "hello", "dm:abc");
  check("off means none", sees().length === 2);
  document.getElementById("desktop-notify").click();
  document.getElementById("notify-text").click();
  check("kept for next time", localStorage.getItem("desktopNotify") === "1" && localStorage.getItem("notifyText") === "1");

  // Blocked people: Manage goes straight to the Blocked tab.
  document.getElementById("privacy-blocked").click();
  await wait(150);
  check("Manage shows your blocked people", !document.getElementById("settings").open && state.friendTab === "blocked", `tab=${state.friendTab} dm=${state.openDm} open=${document.getElementById("settings").open} home=${!!document.getElementById("home-btn")}`);
  report();
})();
