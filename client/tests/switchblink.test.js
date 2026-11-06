// Switching between servers (in a folder too) doesn't blink: servers don't replay their
// unfolding, and the chat keeps what was there until the server's history arrives.

(async () => {
  await inServer();
  const crew = prefs.servers.find((s) => s.address === "cloud:crew0001");
  const raid = prefs.servers.find((s) => s.address === "192.168.8.35");
  prefs.rail = [{ folder: "f1", name: "Games", color: "#6e56cf", open: true, ids: [crew.id, raid.id] }];
  renderRail();
  check("an open folder doesn't animate on a redraw", !document.querySelector(".folder-open.opening"));
  const head = document.querySelector(".folder-head");
  head.click();
  head.click();
  check("opening it does unfold with motion", !!document.querySelector(".folder-open.opening") || document.querySelectorAll(".folder-open").length === 1);

  await connectTo(raid);
  await wait(200);
  await connectTo(crew);
  await wait(200);
  const counts = [];
  const t = setInterval(() => counts.push(document.querySelectorAll(".msg").length), 3);
  connectTo(raid);
  await wait(150);
  clearInterval(t);
  check("the chat never goes empty while switching", counts.length > 5 && counts.every((n) => n > 0), counts.join(","));
  renderRail();
  check("switching servers doesn't replay the folder", !document.querySelector(".folder-open.opening"));
  report();
})();
