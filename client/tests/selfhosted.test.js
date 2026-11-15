// A server on someone's computer has everything Hopp Cloud has: pictures, voice messages and
// emojis go to the server itself over the app's own connection (never to the cloud), pictures
// show through Hopp's own address, and your status reaches its member list. An older server
// that only has the basics still says so.

(async () => {
  await inServer();
  const home = prefs.servers.find((s) => !isCloud(s));
  const full = ["search", "screen", "voice-chat", "voice-mod", "voice-settings", "mod-tools", "roles", "pings", "resync", "nicknames", "members", "emojis", "search-filters", "polls", "voice-messages", "threads"];
  const asked = [];
  const real = { connect: commands.connect };
  commands.connect = (a) => ({ ...real.connect(a), features: full, mesh: true });
  commands.server_upload = ({ data, kind }) => { asked.push(["server_upload", kind, data.length]); return "cd".repeat(16); };
  commands.upload_image = () => { asked.push(["upload_image"]); return "ab".repeat(16); };
  commands.set_server_status = ({ status }) => { asked.push(["status", status]); return null; };
  state.me = { ...state.me, status: "dnd" };

  await connectTo(home);
  renderAll();
  await wait(60);
  check("a server on a computer counts as having everything", cloudLike() && meshVoice());
  check("pictures can be added there", picturesAllowed() && !$("attach-btn").hidden);
  check("your status goes to it, for its member list", asked.some(([t, s]) => t === "status" && s === "dnd"), JSON.stringify(asked));

  const id = await storePicture(new Uint8Array([1, 2, 3]), "image/webp");
  check("a picture goes to the server itself, not to the cloud", id === "cd".repeat(16) && asked.some(([t, k]) => t === "server_upload" && k === "image/webp") && !asked.some(([t]) => t === "upload_image"));
  const url = pictureUrl("cd".repeat(16));
  check("and shows through Hopp's own address, from that server", url === `http://hoppimg.localhost/${encodeURIComponent(endpoint(home))}/${"cd".repeat(16)}`, url);

  // An older server on a computer: only the basics.
  commands.connect = (a) => ({ ...real.connect(a), features: ["search", "screen"], mesh: false });
  await connectTo(prefs.servers.find((s) => isCloud(s)));
  await connectTo(home);
  renderAll();
  await wait(60);
  check("an older one says it can't take pictures yet", !cloudLike() && !picturesAllowed() && $("attach-btn").hidden);
  commands.connect = real.connect;
  report();
})();
