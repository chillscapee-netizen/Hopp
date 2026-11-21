// A server on someone's computer answers to its own key: once known, a link with another key
// for the same address doesn't replace it (that would let someone else pass for the server).

(async () => {
  await inServer();
  const address = "203.0.113.9:7777";
  const known = newServer(address, "Friend's server");
  known.pin = "a".repeat(64);
  prefs.servers.push(known);
  const connect = window.connectTo;
  window.connectTo = () => {};
  addAndConnect(address, "NEWCODE1", undefined, "b".repeat(64));
  await wait(30);
  check("a different key for a known server isn't taken", known.pin === "a".repeat(64));
  check("and says why", [...document.querySelectorAll(".toast, .notice-line")].some((t) => /different key/.test(t.textContent)));
  addAndConnect(address, "NEWCODE2", undefined, "a".repeat(64));
  check("the same key: the new invite is used", known.invite === "NEWCODE2");
  window.connectTo = connect;
  prefs.servers = prefs.servers.filter((s) => s !== known);
  report();
})();
