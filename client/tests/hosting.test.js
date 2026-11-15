// Hosting a server on this computer from inside Hopp: a name and a button; you're the owner,
// invite links carry the server's key and, once the router let Hopp open the way in, the
// home's public address; it says plainly when only the home network can reach it.

(async () => {
  await inServer();
  const pin = "a".repeat(32);
  const calls = [];
  commands.host_start = ({ name }) => { calls.push("start " + name); return { running: true, name, port: 7777, pin, lan: "192.168.1.20", public: null, reach: "checking" }; };
  commands.host_stop = () => { calls.push("stop"); return null; };
  const asked = [];
  const realConnect = commands.connect;
  commands.connect = (a) => { asked.push(a.address); return realConnect(a); };

  openAddDialog("host");
  await wait(20);
  check("a name and a start button", !$("host-off").hidden && !$("host-start").hidden && $("host-stop").hidden);
  $("host-name").value = "Movie night";
  $("host-start").click();
  await wait(120);
  check("starting it runs the server here", calls.includes("start Movie night"));
  check("and connects you to it (you're the owner), only with its key", asked.includes(`${pin}@localhost:7777`), asked.join(" "));
  const server = prefs.servers.find((s) => s.address === "localhost:7777");
  check("it is in your server list, known by its key", !!server && server.pin === pin);
  check("it starts again with Hopp", JSON.parse(load("hosting", "null"))?.name === "Movie night");

  state.activeId = server.id;
  emit("host-status", { running: true, name: "Movie night", port: 7777, pin, lan: "192.168.1.20", public: null, reach: "home" });
  await wait(20);
  let share = await shareableAddress();
  check("router said no: links use the home network address", share.address === `${pin}@192.168.1.20:7777` || share.address.startsWith(`${pin}@`), share.address);
  check("and the invite says only the home network can join", /home network/.test($("invite-reach").textContent) && !$("invite-reach").hidden);
  emit("host-status", { running: true, name: "Movie night", port: 7777, pin, lan: "192.168.1.20", public: "81.229.10.20", reach: "open" });
  await wait(20);
  share = await shareableAddress();
  check("router opened the way: links use the home's public address", share.address === `${pin}@81.229.10.20:7777`, share.address);
  check("and say friends anywhere can join", /anywhere/.test($("invite-reach").textContent));

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
