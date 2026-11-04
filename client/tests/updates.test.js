// A newer Hopp: the arrow in the top bar, what's new, and installing it.

(async () => {
  await inServer();
  check("grey arrow without an update", !$("update-btn").hidden && !$("update-btn").classList.contains("ready"));

  updates.version = "0.2.1";
  let installed = 0;
  commands.check_update = () => ({ version: "0.2.2", notes: "• Cleaner logo\n• Update arrow" });
  commands.install_update = () => { installed++; return new Promise(() => {}); };
  await checkForUpdate();
  check("arrow turns green when an update is out", $("update-btn").classList.contains("ready"));

  $("update-btn").click();
  const pop = document.querySelector(".update-pop");
  check("popup opens", !!pop);
  check("popup names both versions", pop?.textContent.includes("0.2.1 → 0.2.2"));
  check("popup shows what's new", pop?.textContent.includes("Cleaner logo"));

  [...pop.querySelectorAll("button")].find((b) => b.textContent === "Restart and update").click();
  await wait(50);
  check("install started", installed === 1);
  emit("update-progress", { done: 50, total: 200 });
  await wait(50);
  check("progress shown", document.querySelector(".update-pop")?.textContent.includes("25%"));
  document.body.click();
  check("popup stays while installing", !!document.querySelector(".update-pop"));
  check("settings card follows", $("version-sub").textContent.includes("25%") && $("version-btn").disabled);

  // Asking by hand when there's nothing new.
  updates.status = "idle";
  closeUpdatePop();
  commands.check_update = () => null;
  await checkForUpdate(true);
  check("says you have the newest", $("version-sub").textContent === "You have the newest version." && !$("update-btn").classList.contains("ready"));
  check("version shown", $("version-title").textContent === "Hopp 0.2.1");
  $("update-btn").click();
  check("grey arrow opens up to date and Check", document.querySelector(".update-pop")?.textContent.includes("newest version") && document.querySelector(".update-pop")?.textContent.includes("Check for updates"));
  closeUpdatePop();

  commands.check_update = () => { throw "network down"; };
  await checkForUpdate(true);
  check("a failed check you asked for says so", $("version-sub").textContent.length > 0 && updates.status === "failed");
  report();
})();
