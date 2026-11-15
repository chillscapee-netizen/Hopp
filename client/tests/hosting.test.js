// Hosting a server on this computer from inside Hopp: a name and a button; you're the owner,
// invite links carry the server's key and its tunnel through Hopp Cloud (never an address);
// it says whether friends can reach it right now.

(async () => {
  await inServer();
  const pin = "a".repeat(32);
  const calls = [];
  const tunnel = "b".repeat(32);
  commands.host_start = ({ name }) => { calls.push("start " + name); return { running: true, name, port: 7777, pin, tunnel, online: false }; };
  commands.host_stop = () => { calls.push("stop"); return null; };
  const asked = [];
  const realConnect = commands.connect;
  commands.connect = (a) => { asked.push(a.address); return realConnect(a); };

  openAddDialog("host");
  await wait(20);
  check("a name and a start button", !$("host-off").hidden && !$("host-start").hidden && $("host-stop").hidden);
  check("no warning about your address: it stays hidden", !$("add-dialog").textContent.includes("see your IP"));
  $("host-name").value = "Movie night";
  $("host-start").click();
  await wait(120);
  check("starting it runs the server here", calls.includes("start Movie night"));
  check("and connects you to it (you're the owner), only with its key", asked.includes(`${pin}@localhost:7777`), asked.join(" "));
  const server = prefs.servers.find((s) => s.address === "localhost:7777");
  check("it is in your server list, known by its key", !!server && server.pin === pin);
  check("it starts again with Hopp", JSON.parse(load("hosting", "null"))?.name === "Movie night");

  state.activeId = server.id;
  const share = await shareableAddress();
  check("invite links lead through the tunnel, with no address in them", share.address === `${pin}@tunnel:${tunnel}`, share.address);
  emit("host-status", { running: true, name: "Movie night", port: 7777, pin, tunnel, online: false });
  await wait(20);
  check("while the tunnel connects, it says so", /Connecting/.test($("invite-reach").textContent));
  emit("host-status", { running: true, name: "Movie night", port: 7777, pin, tunnel, online: true });
  await wait(20);
  check("connected: friends anywhere can join, and nobody sees your address", /anywhere/.test($("invite-reach").textContent) && /nobody sees your address/.test($("invite-reach").textContent));

  // A friend's side: the link opens the tunnel, and the server shows no address.
  const p = parseInvite(`hopp://${pin}@tunnel:${tunnel}/ABCD1234`);
  check("a friend's link reads as the tunnel and the key", p.address === "tunnel:" + tunnel && p.pin === pin && p.invite === "ABCD1234", JSON.stringify(p));
  check("and the server shows as private, not an address", displayAddress({ address: "tunnel:" + tunnel }) === "Private server");

  openAddDialog("host");
  await wait(20);
  check("the dialog shows it's running, with a stop button", !$("host-on").hidden && !$("host-stop").hidden);
  window.confirmDialog = async () => true;
  $("host-stop").click();
  await wait(60);
  check("stopping it stops the server and forgets to start it with Hopp", calls.includes("stop") && !load("hosting", ""));
  commands.connect = realConnect;
  report();
})();
