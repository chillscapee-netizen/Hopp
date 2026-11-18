// real-time: 30000
// Switching servers doesn't make the member list blink: coming back to a server, its members
// as last seen show at once (a fresh list follows quietly), instead of the list drawing without
// the offline people first and jumping when the server answers.

(async () => {
  await inServer();
  const offline = [
    { public_key: "1".repeat(64), name: "Olle", role: null, joined_at: 1, roles: [] },
    { public_key: "2".repeat(64), name: "Pia", role: null, joined_at: 2, roles: [] },
  ];
  // Servers that keep a member list.
  const connect = commands.connect;
  commands.connect = (a) => ({ ...connect(a), features: [...(connect(a).features ?? []), "members"] });
  state.roster.features = [...(state.roster.features ?? []), "members"];
  // Like a real server: the list comes a moment after asking.
  commands.get_members = () => {
    setTimeout(() => emit("members", [...state.roster.users.map((u) => ({ public_key: u.public_key, name: u.name, role: null, joined_at: 0, roles: [] })), ...offline]), 150);
    return null;
  };
  const list = $("member-list");
  const rows = () => list.querySelectorAll(".member").length;
  const servers = [...document.querySelectorAll("#server-list .rail-item")];
  // First visits: both servers get to show their lists once.
  servers[1].click();
  await wait(600);
  servers[0].click();
  await wait(600);
  const settled = rows();
  check("the offline people are in the list", list.textContent.includes("Olle") && list.textContent.includes("Pia"), String(settled));

  // Back and forth: count the rows every frame.
  const counts = [];
  let on = true;
  const sample = () => {
    if (online()) counts.push(rows());
    if (on) requestAnimationFrame(sample);
  };
  sample();
  for (let i = 0; i < 4; i++) {
    servers[i % 2 ? 0 : 1].click();
    await wait(500);
  }
  on = false;
  const dips = counts.filter((n) => n < settled).length;
  check("coming back, the list never drops the offline people and jumps back", dips === 0, `${dips} frames short of ${settled} rows, out of ${counts.length}`);
  report();
})();
