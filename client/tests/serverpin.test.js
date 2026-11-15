// Self-hosted servers are known by their key: an invite's key is kept, used on every connect
// (only that server is accepted), put in new invite links, and learned on the first encrypted
// connect when a server was added without one.

(async () => {
  await inServer();
  const pin = "0123456789abcdef0123456789abcdef";
  const parsed = parseInvite(`hopp://${pin}@203.0.113.5:7777/abcd1234`);
  check("an invite's key is read", parsed.pin === pin && parsed.address === "203.0.113.5:7777" && parsed.invite === "ABCD1234", JSON.stringify(parsed));
  check("old links without a key still read", parseInvite("hopp://203.0.113.5:7777/ABCD1234").pin === undefined);

  const asked = [];
  const realConnect = commands.connect;
  commands.connect = (a) => { asked.push(a.address); return realConnect(a); };
  await joinInvite(`hopp://${pin}@203.0.113.5:7777/ABCD1234`);
  await wait(100);
  const server = prefs.servers.find((s) => s.address === "203.0.113.5:7777");
  check("the server keeps its key, apart from its address", server?.pin === pin);
  check("and connects with only that key accepted", asked.includes(`${pin}@203.0.113.5:7777`), asked.join(" "));

  state.activeId = server.id;
  const share = await shareableAddress();
  check("invite links made there carry the key", share.address === `${pin}@203.0.113.5:7777`, share.address);

  // Added before keys existed: the first encrypted connect teaches it the key.
  const old = { id: "old-one", address: "198.51.100.7:7777", label: "Old", customLabel: false, joined: true };
  prefs.servers.push(old);
  emit("server-pin", { address: "198.51.100.7:7777", pin });
  await wait(20);
  check("a server without a key learns it", old.pin === pin && endpoint(old) === `${pin}@198.51.100.7:7777`);
  emit("server-pin", { address: "198.51.100.7:7777", pin: "f".repeat(32) });
  await wait(20);
  check("but a known key is never replaced quietly", old.pin === pin);
  commands.connect = realConnect;
  report();
})();
