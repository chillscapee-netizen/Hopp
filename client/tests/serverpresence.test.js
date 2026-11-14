// Online is online: someone with Hopp open shows as online in a server's member list even when
// they're in another server or their DMs, with their real status (idle, busy). Offline is only
// for those without Hopp open. Your account is told which cloud servers you're in for this.

(async () => {
  await inServer();
  const r = structuredClone(state.roster);
  r.features = [...(r.features ?? []), "members"];
  const here = r.users.map((u) => ({ public_key: keyOf(u), name: u.name, role: u.owner ? "owner" : null, joined_at: 1, roles: [] }));
  // Elin is here but busy; Nora has Hopp open elsewhere and is idle; Omar is online elsewhere; Pia is offline.
  here.find((m) => m.name === "Elin").status = "dnd";
  const everyone = [
    ...here,
    { public_key: "ab".repeat(32), name: "Nora", role: null, joined_at: 2, roles: [], status: "idle" },
    { public_key: "cd".repeat(32), name: "Omar", role: "mod", joined_at: 3, roles: [], status: "online" },
    { public_key: "ef".repeat(32), name: "Pia", role: null, joined_at: 4, roles: [] },
  ];
  commands.get_members = () => setTimeout(() => emit("members", everyone), 5);
  emit("roster", r);
  await wait(150);
  const row = (name) => [...document.querySelectorAll("#member-list .member")].find((n) => n.querySelector(".member-name")?.textContent === name);
  check("someone in Hopp but not here is online, not offline", row("Nora") && !row("Nora").classList.contains("offline"));
  check("with their real status", !!row("Nora")?.querySelector(".status-dot.idle") && !!row("Omar")?.querySelector(".status-dot.online"));
  check("under the same groups as everyone (a moderator under Moderators)", (() => {
    const items = [...document.querySelectorAll("#member-list > li")];
    const head = items.findIndex((n) => n.textContent.startsWith("Moderators"));
    return head >= 0 && items[head + 1] === row("Omar");
  })());
  check("people here show their status too (busy, not always green)", !!row("Elin")?.querySelector(".status-dot.dnd"));
  const groups = [...document.querySelectorAll("#member-list .member-group")].map((n) => n.textContent);
  check("only those without Hopp open are Offline", groups.at(-1) === "Offline — 1" && row("Pia")?.classList.contains("offline"), groups.join(" | "));
  check("nobody is listed twice", document.querySelectorAll("#member-list .member").length === r.users.length + 3);

  // A status change arrives as a fresh list: Nora closes Hopp.
  everyone.find((m) => m.name === "Nora").status = undefined;
  emit("members", everyone);
  await wait(60);
  check("closing Hopp moves you to Offline", row("Nora")?.classList.contains("offline"));

  // The account hears which cloud servers you're in, once, and again when that changes.
  const sent = [];
  commands.account_send = (a) => { sent.push(a.msg); return Promise.resolve(); };
  prefs.servers.push({ id: "cloud-test", label: "Cloud test", address: "cloud:abcdefabcdef12" });
  state.accountFeatures = ["server-presence"];
  tellAccountServers(true);
  await wait(10);
  const told = sent.filter((m) => m.type === "set_servers");
  check("the account is told your cloud servers", told.length === 1 && told[0].ids.includes("abcdefabcdef12"), JSON.stringify(told));
  saveServers();
  await wait(10);
  check("not again when nothing changed", sent.filter((m) => m.type === "set_servers").length === 1);
  prefs.servers = prefs.servers.filter((x) => x.id !== "cloud-test");
  saveServers();
  await wait(10);
  const last = sent.filter((m) => m.type === "set_servers").at(-1);
  check("leaving one tells it again", sent.filter((m) => m.type === "set_servers").length === 2 && !last.ids.includes("abcdefabcdef12"));
  state.accountFeatures = [];
  report();
})();
