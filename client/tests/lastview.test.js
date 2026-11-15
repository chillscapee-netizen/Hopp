// Each server opens on the channel you last read there. Channel numbers belong to their server:
// the one you read in another server must never land you in a voice channel here.

(async () => {
  await inServer();
  const first = activeServer();
  const other = prefs.servers.find((s) => s.id !== first.id);
  // The other server numbers its channels differently: its 3 is a voice channel.
  const connect = commands.connect;
  commands.connect = (a) => {
    const r = connect(a);
    if (a.address !== other.address) return r;
    return { ...r, features: ["voice-chat"], channels: [
      { id: 5, name: "welcome", kind: "text" },
      { id: 3, name: "Hangout", kind: "voice" },
    ] };
  };

  openTextChannel(3);
  await wait(50);
  check("reading clips (3) in the first server", state.view === 3 && channelName(3) === "clips");

  await connectTo(other);
  renderAll();
  await wait(100);
  check("the other server opens on its text channel, not its voice channel 3", state.view === 5, String(state.view));
  check("and you are not in voice", myVoice() === null);

  await connectTo(first);
  renderAll();
  await wait(100);
  check("back in the first server: clips again, where you were", state.view === 3, String(state.view));

  await connectTo(other);
  await wait(50);
  check("and the other server remembers its own channel", state.view === 5, String(state.view));
  check("kept for next time Hopp starts", JSON.parse(load("lastViews", "{}"))[first.id] === 3);
  commands.connect = connect;
  report();
})();
