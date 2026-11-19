// Reporting: someone else's message, a person or a server can be reported (your own can't),
// the dialog asks what's wrong, sends what's reported as you see it, and says thanks or why not.

(async () => { try {
  await inServer();
  state.accountConnected = true;
  const items = () => [...$("server-menu").querySelectorAll(".menu-item")].map((b) => b.textContent.trim());
  const pick = (label) => [...$("server-menu").querySelectorAll(".menu-item")].find((b) => b.textContent.trim() === label);
  const reports = [];
  const send = commands.account_send;
  let reply = { type: "report_sent" };
  commands.account_send = (a) => {
    if (a.msg.type === "report") {
      reports.push(a.msg);
      setTimeout(() => emit("account", reply), 10);
      return null;
    }
    return send(a);
  };

  const theirs = state.chats.get(0).find((m) => m.author_key === KEYS.elin);
  const mine = state.chats.get(0).find((m) => m.author_key === state.account?.publicKey);
  if (mine) {
    openMessageMenu(mine, new MouseEvent("contextmenu", { clientX: 200, clientY: 200 }));
    check("your own message can't be reported", !items().includes("Report message"), items().join(", "));
    closePopovers();
  }
  openMessageMenu(theirs, new MouseEvent("contextmenu", { clientX: 200, clientY: 200 }));
  check("someone else's can", items().includes("Report message"), items().join(", "));
  pick("Report message").click();
  await wait(30);
  check("the dialog opens, showing what's reported", $("report-dialog").open && $("report-what").textContent.includes(theirs.sender_name));

  $("report-send").click();
  await wait(30);
  check("it asks what's wrong first", !$("report-error").hidden && !reports.length);
  $("report-reason").value = "spam";
  $("report-details").value = "  sells fake coins ";
  $("report-send").click();
  await wait(80);
  const r = reports[0];
  check("sent with what's reported", r && r.kind === "message" && r.reason === "spam" && r.details === "sells fake coins" && r.user_key === KEYS.elin && r.message === theirs.text && r.server === activeServer().address, JSON.stringify(r));
  check("closed, with thanks", !$("report-dialog").open && [...document.querySelectorAll(".toast")].some((t) => /report was sent/.test(t.textContent)));

  // Turned down: the dialog stays and says why.
  reply = { type: "error", for: "report", message: "You've sent a lot of reports today. Try again tomorrow." };
  reportServer(prefs.servers[0]);
  await wait(30);
  $("report-reason").value = "illegal";
  $("report-send").click();
  await wait(80);
  check("turned down: the dialog stays and says why", $("report-dialog").open && /tomorrow/.test($("report-error").textContent) && !$("report-send").disabled);
  $("report-dialog").close();

  // People and servers have it in their menus.
  const elin = state.roster.users.find((u) => u.session_id !== state.roster.me);
  openUserMenu(elin, document.querySelector(".member"), new MouseEvent("contextmenu", { clientX: 200, clientY: 200 }));
  await wait(30);
  check("a person's menu: Report", items().includes("Report"), items().join(", "));
  closePopovers();
  const other = prefs.servers.find((s) => s.id !== state.activeId);
  openServerMenu(other, 300, 300);
  await wait(30);
  check("a server's menu: Report server", items().includes("Report server"), items().join(", "));
  closePopovers();

  // Offline: says so instead of opening.
  state.accountConnected = false;
  reportServer(other);
  check("offline: not opened", !$("report-dialog").open);
  state.accountConnected = true;
  commands.account_send = send;
  } catch (e) {
    check("crashed: " + e.message + " " + String(e.stack).slice(0, 300), false);
  }
  report();
})();
