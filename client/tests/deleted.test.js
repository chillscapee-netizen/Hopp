// The owner deletes the server while we're in it.

(async () => {
  await inServer();
  emit("server-deleted", {});
  await wait(200);
  check("server leaves the list", !prefs.servers.some((s) => s.address === "cloud:crew0001"));
  check("says the owner deleted it", document.body.textContent.includes("was deleted by its owner"));

  // Kicked, banned, or signed in elsewhere: each says so.
  const spare = structuredClone(prefs.servers.at(-1));
  for (const [what, setup, words] of [
    ['kicked', () => emit('kicked', false), 'You were kicked'],
    ['banned', () => emit('kicked', true), 'You were banned'],
  ]) {
    // (Being removed takes the server off the list, so it's put back for the next round.)
    if (!prefs.servers.length) prefs.servers.push(structuredClone(spare));
    const server = prefs.servers[0];
    await connectTo(server);
    await wait(150);
    setup();
    emit('disconnected', {});
    await wait(200);
    check(what + ': says so', document.body.textContent.includes(words));
    check(what + ': the server leaves your list', !prefs.servers.some((x) => x.id === server.id));
  }
  report();
})();
