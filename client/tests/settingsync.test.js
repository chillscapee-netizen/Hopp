// Your settings follow your Hopp ID: a new or restored device takes the account's, a change
// here goes up, and an older copy from elsewhere doesn't undo a newer change.

(async () => {
  await inServer();
  let remote = null;
  let sealedText = null;
  commands.open_private = () => JSON.stringify(remote);
  commands.seal_private = (a) => {
    sealedText = a.text;
    return "sealed";
  };

  // A device that never changed a setting (just restored) takes the account's.
  remote = syncDoc();
  remote.settings = { at: 5000, values: { theme: "light", chatSize: "18", sounds: "0", linkPreviews: "0" } };
  emit("account", { type: "sync", version: 3, data: "sealed" });
  await wait(150);
  check("the account's theme is used", prefs.theme === "light" && document.documentElement.style.getPropertyValue("--chat-size") === "18px", prefs.theme + " " + document.documentElement.style.getPropertyValue("--chat-size"));
  check("and its switches show it", $("sounds").checked === false && $("link-previews").checked === false && prefs.linkPreviews === false);
  check("a device setting stays this computer's", localStorage.getItem("inputDevice") === null || prefs.inputDevice === localStorage.getItem("inputDevice"));

  emit("account", { type: "sync_saved", version: 4 });
  await wait(50);
  // A change here goes to the account, newer than what it had.
  sealedText = null;
  $("chat-size").value = 20;
  $("chat-size").dispatchEvent(new Event("input"));
  await wait(1800);
  emit("account", { type: "sync_saved", version: 5 });
  await wait(100);
  const up = sealedText && JSON.parse(sealedText);
  check("a change here is saved to the account", up?.settings?.values?.chatSize === "20" && up.settings.at > 5000, JSON.stringify(up?.settings));

  // An older copy from another device doesn't undo it.
  remote = syncDoc();
  remote.settings = { at: 1000, values: { theme: "mid", chatSize: "15" } };
  emit("account", { type: "sync", version: 4, data: "sealed" });
  await wait(150);
  check("an older copy doesn't undo a newer change", prefs.chatSize === 20 && prefs.theme === "light", prefs.chatSize + " " + prefs.theme);

  // A newer one from another device is taken.
  remote = syncDoc();
  remote.settings = { at: Date.now() + 1000, values: { theme: "mid", chatSize: "16", sounds: "1" } };
  emit("account", { type: "sync", version: 5, data: "sealed" });
  await wait(150);
  check("a newer change from another device is taken", prefs.chatSize === 16 && prefs.theme === "mid" && $("sounds").checked && prefs.linkPreviews === true);
  report();
})();
