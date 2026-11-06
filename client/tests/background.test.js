// Servers kept connected: switching doesn't disconnect; a server waiting in the background
// still marks channels unread and pings you; your other servers are connected after login.

(async () => {
  const warmed = [];
  commands.warm = ({ address }) => { warmed.push(address); };
  let disconnects = 0;
  commands.disconnect = () => { disconnects++; };
  await inServer();
  const crew = prefs.servers.find((s) => s.address === "cloud:crew0001");
  const raid = prefs.servers.find((s) => s.address === "192.168.8.35");
  await connectTo(raid);
  await wait(100);
  check("switching doesn't disconnect first (the app keeps the old one)", disconnects === 0);
  await wait(3000);
  check("your other servers are connected in the background", warmed.includes(endpoint(crew)), warmed.join(", "));

  // Something new in the server you aren't looking at.
  const before = serverMentions(crew);
  emit("background-chat", { address: endpoint(crew), message: { id: 99001, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: `hey <@${ME}>`, sent_at: Date.now() }, channel_name: "general", voice: false, roles: [], pings: true });
  await wait(30);
  check("it marks the server unread and counts the mention", serverMentions(crew) === before + 1 && serverHasUnread(crew.address));
  emit("background-chat", { address: endpoint(crew), message: { id: 99002, channel: 1, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "voice chat", sent_at: Date.now() }, channel_name: "Lobby", voice: true, roles: [], pings: true });
  await wait(30);
  check("voice chat doesn't count", serverMentions(crew) === before + 1);
  report();
})();
