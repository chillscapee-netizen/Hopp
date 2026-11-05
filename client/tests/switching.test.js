// Coming back to a server shows what you saw at once, until it answers; then the very same
// messages carry on, nothing redrawn from scratch.

(async () => {
  await inServer();
  const first = activeServer();
  const firstRow = document.querySelector("#messages .msg");
  const rows = [...document.querySelectorAll("#server-list .rail-item")];
  check("there are two servers to switch between", rows.length >= 2);

  // Make connecting slow, like a real network.
  const connect = commands.connect;
  let release;
  // As with the real server, the history arrives just before the connection is done.
  commands.connect = (a) => new Promise((resolve) => (release = () => { const r = connect(a); setTimeout(() => resolve(r), 60); }));

  rows[1].click();
  await wait(50);
  release();
  await wait(200);
  check("on the other server now", activeServer()?.id !== first.id);

  // Back to the first: its messages are there before it has even answered.
  rows[0].click();
  await wait(50);
  const msgs = document.getElementById("messages");
  check("its messages show at once", msgs.querySelectorAll(".msg").length >= 5 && !msgs.querySelector(".skeleton-msg"));
  check("quietly, and not clickable yet", msgs.classList.contains("stale") && getComputedStyle(msgs).pointerEvents === "none");
  check("its channels too", !document.querySelector("#sidebar-body .skeleton-row") && document.getElementById("sidebar-body").textContent.includes("general"));
  release();
  for (let i = 0; i < 40 && !online(); i++) await wait(50);
  await wait(200);
  check("connected: the real view takes over", !msgs.classList.contains("stale") && !document.getElementById("sidebar-body").classList.contains("stale"));
  const nowRow = document.querySelector("#messages .msg");
  check("with the very same message rows", nowRow === firstRow, `old ${firstRow.dataset.key} connected=${firstRow.isConnected} new ${nowRow?.dataset.key}`);
  commands.connect = connect;

  // A server never visited still shows the placeholders.
  serverViews.clear();
  report();
})();
