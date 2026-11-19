// Invites to a server hosted in Hopp: a short link with the server's name (like Hopp Cloud's),
// shown in chat as that name, and joining it reaches the server through its tunnel with its key.

(async () => {
  await inServer();
  const tunnel = "cd".repeat(16);
  const pin = "ab".repeat(16);
  commands.invite_preview = ({ code }) => (code === "HOSTED12" ? { name: "Marcus server", icon: null, address: `tunnel:${tunnel}`, pin, code, hosted: true } : Promise.reject("This invite is invalid or has expired."));

  // In chat: the server's name, not its tunnel.
  emit("chat", { id: 9401, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: `${cloudHttp()}/i/HOSTED12`, sent_at: Date.now() });
  await wait(150);
  const card = document.querySelector('.msg[data-id="9401"] .invite-card');
  check("the invite shows the server's name", card?.textContent.includes("Marcus server") && !card.textContent.includes("tunnel:"), card?.textContent);
  check("and says it's on someone's computer", /own computer/.test(card?.textContent ?? ""));

  // Joining: through the tunnel, with its key, named as its owner named it.
  const connect = window.connectTo;
  window.connectTo = () => {};
  await joinInvite(`${cloudHttp()}/i/HOSTED12`);
  const joined = prefs.servers.find((s) => s.address === `tunnel:${tunnel}`);
  check("joining reaches it through its tunnel, with its key and name", joined?.pin === pin && joined.label === "Marcus server" && joined.invite === "HOSTED12", JSON.stringify(joined));
  window.connectTo = connect;
  prefs.servers = prefs.servers.filter((s) => s !== joined);

  // Hosting: the invite dialog gives the short link once Hopp Cloud keeps it.
  state.host = { running: true, name: "Marcus server", port: 7777, pin, tunnel, online: true };
  const s = activeServer();
  const before = { address: s.address, pin: s.pin };
  s.address = "localhost:7777";
  s.pin = pin;
  const registered = [];
  commands.host_register_invite = (a) => registered.push(a);
  openInvite();
  await wait(100);
  await showInvite({ code: "HOSTED34", expires_at: null, max_uses: null, uses: 0 });
  check("your own server's invite is a short link", $("invite-link").value === `${cloudHttp()}/i/HOSTED34`, $("invite-link").value);
  check("registered with Hopp Cloud", registered.some((r) => r.code === "HOSTED34"));
  commands.host_register_invite = () => Promise.reject("offline");
  await showInvite({ code: "HOSTED56", expires_at: null, max_uses: null, uses: 0 });
  check("if Hopp Cloud can't keep it, the long link still works", $("invite-link").value.startsWith("hopp://") && $("invite-link").value.includes("tunnel:"));
  $("invite-dialog").close();
  Object.assign(s, before);
  state.host = { running: false };
  report();
})();
