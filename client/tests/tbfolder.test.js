// real-time: 20000
// Taskbar: a folder grows out sideways when it opens and folds in when it closes.

(async () => {
  try {
    await inServer();
    prefs.layout = "taskbar";
    prefs.railSize = "small";
    applyTheme();
    prefs.rail = [{ folder: "f1", name: "Games", color: "#6e56cf", open: false, ids: prefs.servers.map((s) => s.id) }];
    renderRail();
    await wait(100);
    const head = () => document.querySelector('#server-list .folder-head[data-folder="f1"]');
    const homeAt = $("home-btn").getBoundingClientRect().left;
    head().click();
    await wait(60);
    const box = document.querySelector("#server-list .folder-open");
    const mid = box?.getBoundingClientRect().width ?? 0;
    await wait(400);
    const full = document.querySelector("#server-list .folder-open")?.getBoundingClientRect().width ?? 0;
    check("opening grows it sideways, not in one jump", mid > 30 && mid < full, `${mid} then ${full}`);
    check("open, its servers show (small list too)", document.querySelectorAll("#server-list .folder-open > .rail-item").length === prefs.servers.length + 1 && full > 80);
    check("Hopp stays where it is when a folder opens", Math.abs($("home-btn").getBoundingClientRect().left - homeAt) < 1);
    head().click();
    await wait(60);
    const closing = document.querySelector("#server-list .folder-open")?.getBoundingClientRect().width ?? 0;
    await wait(400);
    check("closing folds it in first", closing > 0 && closing < full, `${closing} of ${full}`);
    check("then it's closed", !!head()?.querySelector(".folder-closed") && !prefs.rail[0].open);
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
