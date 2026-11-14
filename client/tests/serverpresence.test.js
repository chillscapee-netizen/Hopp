// Online is online: someone with Hopp open shows as online in a server's member list even when
// they're in another server or their DMs, with their real status (idle, busy). Offline is only
// for those without Hopp open. Your account is told which cloud servers you're in for this.

(async () => {
  await inServer();
  const r = structuredClone(state.roster);
  r.features = [...(r.features ?? []), "members"];
  const here = r.users.map((u) => ({ public_key: keyOf(u), name: u.name, role: u.owner ? "owner" : null, joined_at: 1, roles: [] }));
  // Elin is here but busy; Nora has Hopp open elsewhere and is idle; Omar is online elsewhere; Pia is offline.
  // Elin is here; as a stranger (not a friend) her status comes from the server.
  const stranger = r.users.find((u) => u.name === "Elin");
  const elinAsFriend = state.friends?.get(keyOf(stranger));
  state.friends?.delete(keyOf(stranger));
  here.find((m) => m.public_key === keyOf(stranger)).status = "dnd";
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
  check("people here show their status too (busy, not always green)", !!row(stranger.name)?.querySelector(".status-dot.dnd"), stranger.name);
  const groups = [...document.querySelectorAll("#member-list .member-group")].map((n) => n.textContent);
  check("only those without Hopp open are Offline", groups.at(-1) === "Offline — 1" && row("Pia")?.classList.contains("offline"), groups.join(" | "));
  check("nobody is listed twice", document.querySelectorAll("#member-list .member").length === r.users.length + 3);

  // A status change arrives as a fresh list: Nora closes Hopp.
  everyone.find((m) => m.name === "Nora").status = undefined;
  emit("members", everyone);
  await wait(60);
  check("closing Hopp moves you to Offline", row("Nora")?.classList.contains("offline"));

  // What the app knows first hand shows at once, without waiting for the server:
  // your own status, and a friend who is online.
  const meRow = () => document.querySelector("#member-list .member.self");
  state.me = { ...(state.me ?? {}), status: "online" };
  emit("account", { type: "status", status: "idle" });
  await wait(40);
  check("changing your own status shows in the list at once", !!meRow()?.querySelector(".status-dot.idle"), meRow()?.innerHTML.slice(0, 120));
  emit("account", { type: "status", status: "invisible" });
  await wait(40);
  check("invisible shows grey to you", !!meRow()?.querySelector(".status-dot.offline"));
  emit("account", { type: "status", status: "online" });
  state.friends.set("ef".repeat(32), { key: "ef".repeat(32), state: "friend", display_name: "Pia", status: "offline" });
  emit("account", { type: "presence", key: "ef".repeat(32), status: "dnd", activity: null });
  await wait(40);
  check("a friend who comes online shows online, even before the server says so", row("Pia") && !row("Pia").classList.contains("offline") && !!row("Pia").querySelector(".status-dot.dnd"));
  emit("account", { type: "presence", key: "ef".repeat(32), status: "offline", activity: null });
  await wait(40);
  check("and offline when they close Hopp", row("Pia")?.classList.contains("offline"));
  state.friends.delete("ef".repeat(32));

  // The dots have shapes, not only colours: a moon, a bar, a ring.
  const shape = (n) => !!n && getComputedStyle(n, "::after").content !== "none";
  const sample = el("li", "member");
  const dots = Object.fromEntries(["online", "idle", "dnd", "offline"].map((k) => {
    const av = avatar("Test", "", k);
    sample.append(av);
    return [k, av.querySelector(".status-dot")];
  }));
  $("member-list").append(sample);
  check("idle, busy and offline dots have shapes", shape(dots.idle) && shape(dots.dnd) && shape(dots.offline) && !shape(dots.online));
  sample.remove();

  // Away from the computer: Idle by itself, Online again when back; never over a status you picked.
  const statuses = [];
  const realSend = commands.account_send;
  commands.account_send = (x) => {
    if (x.msg.type === "set_status") {
      statuses.push(x.msg.status);
      setTimeout(() => emit("account", { type: "status", status: x.msg.status }), 1);
    }
    return Promise.resolve();
  };
  state.accountConnected = true;
  let away = 30;
  commands.idle_seconds = () => away;
  await checkAway();
  check("at the computer: nothing changes", statuses.length === 0);
  away = 11 * 60;
  await checkAway();
  await wait(20);
  check("ten minutes away: Idle", statuses.at(-1) === "idle" && state.me.status === "idle", statuses.join());
  away = 5;
  await checkAway();
  await wait(20);
  check("back again: Online", statuses.at(-1) === "online" && state.me.status === "online", statuses.join());
  emit("account", { type: "status", status: "dnd" });
  await wait(10);
  away = 20 * 60;
  await checkAway();
  check("a status you picked stays (busy is not turned into idle)", statuses.length === 2, statuses.join());
  emit("account", { type: "status", status: "online" });
  commands.account_send = realSend;

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
  if (elinAsFriend) state.friends.set(keyOf(stranger), elinAsFriend);
  report();
})();
