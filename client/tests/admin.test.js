// Hopp admin, for whoever runs Hopp Cloud: the shield shows only for admins, with how many
// reports are open (and updates when one comes in); the panel lists them with what was
// reported, filters them, and its buttons ask first and send the right thing.

(async () => {
  await inServer();
  const sent = [];
  const target = JSON.stringify({ server: "cloud:crew0001xyz", server_name: "The Crew", channel: "general", user_key: KEYS.elin, user_name: "Elin", message: "something awful", message_id: "0/100" });
  const reports = {
    rows: [
      { id: 7, at: Date.now() - 3_600_000, reporter: KEYS.sara, reporter_name: "sara", kind: "message", reason: "hate", details: "keeps doing it", target, user_key: KEYS.elin, server: "cloud:crew0001xyz", done: 0, note: null, action: null },
      { id: 8, at: Date.now() - 60_000, reporter: KEYS.sara, reporter_name: "sara", kind: "server", reason: "child", details: "", target: JSON.stringify({ server: "tunnel:" + "ab".repeat(16), server_name: "Hidden place" }), user_key: "", server: "tunnel:" + "ab".repeat(16), done: 0 },
    ],
    aboutUser: { [KEYS.elin]: 3 },
    aboutServer: {},
    byReporter: { [KEYS.sara]: 2 },
    banned: {},
    blocked: {},
    servers: { crew0001xyz: { name: "The Crew", owner: KEYS.dana ?? KEYS.sara, owner_name: "Dana", members: 12, created_at: 0 } },
    stats: { open: 2, urgent: 1, today: 2, handled: 0, bans: 0, blocked: 0, byReason: { hate: 1, child: 1 } },
  };
  const send = commands.account_send;
  commands.account_send = (a) => {
    if (a.msg.type !== "admin") return send(a);
    sent.push(a.msg);
    const answer = { reports, bans: { bans: [{ key: KEYS.elin, name: "Elin", reason: "Hate", at: Date.now() }], tunnels: [] }, admins: { admins: [{ key: "1".repeat(64), username: "owner", role: "owner" }, { key: KEYS.sara, username: "sara", role: "admin", added_by: "owner" }] }, log: { log: [{ at: Date.now(), action: "banned", subject: "Elin", detail: "owner: Hate" }] } }[a.msg.op] ?? { ok: true };
    setTimeout(() => emit("account", { type: "admin", req: a.msg.req, op: a.msg.op, ...answer }), 5);
    return null;
  };
  const shield = () => document.querySelector("#admin-btn");

  check("not an admin: no shield", shield().hidden);
  emit("account", { type: "admin_role", role: "owner" });
  emit("account", { type: "admin_open", open: 2 });
  await wait(20);
  check("an admin: the shield, with 2 open reports", !shield().hidden && shield().querySelector(".admin-count").textContent === "2" && shield().classList.contains("waiting") && !shield().classList.contains("urgent"));

  shield().click();
  await wait(120);
  const cards = [...document.querySelectorAll("#admin-body .admin-card")];
  check("the panel opens on the reports", $("admin-dialog").open && cards.length === 2, String(cards.length));
  check("the numbers on top", /2\s*open/.test($("admin-body").querySelector(".admin-stats").textContent) && /1\s*urgent/.test($("admin-body").querySelector(".admin-stats").textContent));
  const msgCard = cards.find((c) => c.textContent.includes("something awful"));
  check("a card: why, who, where, what and from whom", msgCard && /Hate/.test(msgCard.textContent) && /Elin/.test(msgCard.textContent) && /The Crew · #general/.test(msgCard.textContent) && /12 members/.test(msgCard.textContent) && /Reporter says: keeps doing it/.test(msgCard.textContent));
  check("reported often: says so", /Reported 3 times/.test(msgCard.textContent));
  check("while streaming, who reported and what was said are blurred", msgCard.querySelector(".admin-from [data-private]")?.textContent === "sara" && msgCard.querySelector(".admin-quote")?.hasAttribute("data-private") && msgCard.querySelector(".admin-key")?.hasAttribute("data-private"));
  const urgent = cards.find((c) => c.classList.contains("urgent"));
  check("child content stands out, and a tunnel server can be blocked", urgent && /Block tunnel/.test(urgent.textContent));
  const buttons = (card) => [...card.querySelectorAll(".admin-act")].map((b) => b.textContent);
  check("a message in a server on Hopp Cloud: remove it, ban them, ban the owner, take it down", ["Handled", "Remove message", "Ban Elin", "Ban the owner", "Take down server"].every((l) => buttons(msgCard).includes(l)), buttons(msgCard).join(", "));
  check("an owner: Owner on top, and can delete a report", $("admin-role").textContent === "Owner" && buttons(msgCard).includes("Delete report"));

  // Ban asks first, then sends.
  sent.length = 0;
  [...msgCard.querySelectorAll(".admin-act")].find((b) => b.textContent === "Ban Elin").click();
  await wait(30);
  check("ban asks first", $("confirm-dialog").open && /Ban Elin from Hopp Cloud/.test($("confirm-title").textContent) && !sent.some((m) => m.op === "ban"));
  $("confirm-ok").click();
  await wait(60);
  check("then bans them", sent.some((m) => m.op === "ban" && m.key === KEYS.elin));

  // Handled needs no question.
  sent.length = 0;
  [...document.querySelectorAll("#admin-body .admin-card")][0].querySelector(".admin-act.primary").click();
  await wait(60);
  check("Handled marks it at once", sent.some((m) => m.op === "settle" && m.done === true));

  // Filters ask again.
  sent.length = 0;
  [...document.querySelectorAll(".admin-seg button")].find((b) => b.textContent === "Handled").click();
  await wait(60);
  check("Handled shows handled ones", sent.some((m) => m.op === "reports" && m.view === "done"));
  [...document.querySelectorAll(".admin-seg button")].find((b) => b.textContent === "Open").click();
  await wait(60);
  sent.length = 0;
  [...document.querySelectorAll("#admin-body .admin-many")][0].click();
  await wait(60);
  check("Reported 3 times shows everything about them", sent.some((m) => m.op === "reports" && m.user === KEYS.elin && m.view === "all") && /Only reports about/.test($("admin-body").textContent));

  // The other tabs.
  document.querySelector('.admin-tab[data-atab="bans"]').click();
  await wait(60);
  check("Banned: who, with Unban, and a ban by username for the owner", /Elin/.test($("admin-body").textContent) && /Unban/.test($("admin-body").textContent) && !!$("admin-body").querySelector(".admin-add"));
  // An admin, not an owner: no lifting bans, no deleting reports.
  admin.role = "admin";
  refreshAdmin();
  await wait(80);
  check("an admin can't lift bans or ban without a report", !/Unban/.test([...$("admin-body").querySelectorAll(".admin-act")].map((b) => b.textContent).join()) && !$("admin-body").querySelector(".admin-add"));
  showAdminTab("reports");
  await wait(80);
  check("nor delete reports", ![...$("admin-body").querySelectorAll(".admin-act")].some((b) => b.textContent === "Delete report") && $("admin-role").textContent === "Admin");
  admin.role = "owner";
  document.querySelector('.admin-tab[data-atab="bans"]').click();
  await wait(60);
  document.querySelector('.admin-tab[data-atab="admins"]').click();
  await wait(60);
  check("Admins: an owner can add and remove", /@sara/.test($("admin-body").textContent) && !!$("admin-body").querySelector(".admin-add") && /Remove/.test($("admin-body").textContent));
  document.querySelector('.admin-tab[data-atab="log"]').click();
  await wait(60);
  check("Log: what admins did", /banned/.test($("admin-body").textContent));

  // A new report comes in while looking: the number goes up.
  emit("account", { type: "admin_open", open: 3, urgent: 1 });
  await wait(20);
  check("a new urgent report: the number goes up, and it turns red", shield().querySelector(".admin-count").textContent === "3" && shield().classList.contains("urgent"));

  // No longer an admin: the shield and the panel go.
  emit("account", { type: "admin_role", role: null });
  await wait(20);
  check("no longer an admin: gone", shield().hidden && !$("admin-dialog").open);
  commands.account_send = send;
  report();
})();
