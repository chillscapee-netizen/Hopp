// Several accounts on one computer: each sees only its own servers.

(async () => {
  await inServer();
  check("Marcus sees his servers", prefs.servers.length === 2);

  // Someone else logs in on this computer.
  const other = "9".repeat(64);
  useAccountData(other);
  renderRail();
  check("another account starts with no servers", prefs.servers.length === 0 && document.querySelectorAll("#server-list .rail-item").length === 0);
  prefs.servers.push(newServer("cloud:theirs01", "Their server"));
  saveServers();

  // Back to Marcus: his list is untouched, theirs isn't mixed in.
  useAccountData(ME);
  check("Marcus's list is still his", prefs.servers.map((s) => s.label).join(",") === "The Crew,Raid Night");

  // A list saved the old way (for the whole computer) is given to nobody.
  localStorage.setItem("servers", JSON.stringify([{ id: "x", address: "cloud:old", label: "Old shared" }]));
  useAccountData(other);
  check("old shared list isn't handed to anyone", !prefs.servers.some((s) => s.label === "Old shared"));
  check("old shared list is cleared", localStorage.getItem("servers") === null);

  // Logging out: a change still waiting to sync goes up, and nothing is left for the next account.
  useAccountData(ME);
  await wait(100);
  sent.length = 0;
  syncState.ready = true;
  syncState.saving = false; // the mock cloud never answers an earlier save
  scheduleSync();
  // Logged out for real: the next start shows the login, it doesn't sign in again.
  commands.account_status = () => ({ exists: true, name: "Marcus", public_key: ME, logged_in: false, remembered: false, backed_up: true });
  await logout();
  check("pending sync sent before logging out", sent.some((m) => m.type === "set_sync"));
  check("sync starts over for the next account", !syncState.ready && syncState.version === 0 && !syncState.dirty);
  check("friends and servers gone after logout", state.friends.size === 0 && prefs.servers.length === 0);
  report();
})();
