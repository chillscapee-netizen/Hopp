// Your server list across devices: a server removed somewhere stays removed here, but one
// joined again afterwards (even while the account was offline) isn't undone by that older
// removal when the account's copy arrives.

(async () => {
  await inServer();
  const address = "cloud:rejoin0001xyz";
  const doc = (removedAt) => ({ v: 1, servers: prefs.servers.filter((s) => s.address !== address).map((s) => ({ address: s.address, label: s.label, customLabel: !!s.customLabel })), rail: [], removed: { [address]: removedAt }, notify: prefs.notify });

  // Removed on another device after it was added here: it goes.
  const old = { ...newServer(address, "Old place"), id: `${Date.now() - 60_000}-aaaaa` };
  prefs.servers.push(old);
  mergeSync(doc(Date.now() - 1000));
  check("removed elsewhere later: it goes here too", !prefs.servers.some((s) => s.address === address));

  // Joined again here after that removal: it stays, and the removal is forgotten.
  const removedAt = Date.now() - 5000;
  prefs.removedServers[address] = removedAt;
  prefs.servers.push(newServer(address, "Back again"));
  mergeSync(doc(removedAt));
  check("joined again after the removal: it stays", prefs.servers.some((s) => s.address === address));
  check("and the old removal is forgotten", !prefs.removedServers[address]);
  check("and it's in the server list", prefs.rail.some((i) => i.id === prefs.servers.find((s) => s.address === address)?.id || i.ids?.includes(prefs.servers.find((s) => s.address === address)?.id)));
  prefs.servers = prefs.servers.filter((s) => s.address !== address);
  normalizeRail();
  report();
})();
