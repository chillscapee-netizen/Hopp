// real-time: 20000
// Server folders open and close smoothly: they grow and shrink to their new height (the rest
// of the list glides along), and end up drawn open or closed, saved that way.

(async () => {
  await inServer();
  const [crew, raid] = prefs.servers;
  prefs.rail = [{ folder: "f1", name: "Games", color: "#6e56cf", open: false, ids: [crew.id, raid.id] }];
  renderRail();
  await wait(50);
  const head = () => document.querySelector('#server-list .folder-head[data-folder="f1"]');
  check("closed: one tile with little pictures", !!head()?.querySelector(".folder-closed") && !document.querySelector("#server-list .folder-open"));
  const closedH = head().getBoundingClientRect().height;

  head().click();
  await wait(60);
  const box = document.querySelector("#server-list .folder-open");
  const mid = box?.getBoundingClientRect().height ?? 0;
  check("opening grows it, not in one jump", mid > closedH && mid < box.scrollHeight, `${mid} between ${closedH} and ${box?.scrollHeight}`);
  await wait(300);
  check("then it's open with its servers", document.querySelectorAll("#server-list .folder-open > .rail-item").length === 3 && prefs.rail[0].open);

  head().click();
  await wait(60);
  check("closing shrinks it first", !!document.querySelector("#server-list .folder-open") && document.querySelector("#server-list .folder-open").getBoundingClientRect().height < box.scrollHeight);
  await wait(300);
  check("then it's closed, and saved closed", !!head()?.querySelector(".folder-closed") && !prefs.rail[0].open);
  report();
})();
