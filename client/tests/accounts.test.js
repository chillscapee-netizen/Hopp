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
  report();
})();
