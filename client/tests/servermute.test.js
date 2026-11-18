// Right-clicking a server: Mark as read is always there (greyed when there's nothing to read),
// and Mute server hides its unread dot and quiets its notifications for a while or until
// unmuted; a mention still gets through.

(async () => {
  await inServer();
  const raid = prefs.servers.find((s) => s.id !== state.activeId);
  const rows = () => [...document.querySelectorAll("#server-menu .menu-item")].map((b) => b.textContent.trim() + (b.disabled ? " (off)" : ""));
  const tile = () => document.querySelector(`#server-list .rail-item[data-id="${raid.id}"], #server-list [data-server="${raid.id}"]`);

  openServerMenu(raid, 300, 300);
  await wait(30);
  check("Mark as read is there, greyed when nothing is unread", rows().includes("Mark as read (off)"), rows().join(", "));
  check("and Mute server", rows().some((r) => r.startsWith("Mute server")));
  closePopovers();

  state.reads.set(readKey(raid.address, 0), { server: raid.address, channel: 0, read_id: 1, last_id: 9, mentions: 0 });
  renderUnread();
  await wait(50);
  check("news in it: the unread dot", serverUnread(raid));
  openServerMenu(raid, 300, 300);
  await wait(30);
  check("then Mark as read can be used", rows().includes("Mark as read"), rows().join(", "));
  closePopovers();

  setServerMuted(raid, 60);
  await wait(50);
  check("muted for an hour: no unread dot", !serverUnread(raid) && prefs.notify.muted[raid.address] > Date.now() + 59 * 60_000);
  const sounds = [];
  const play = playSound;
  window.playSound = (name, why) => sounds.push(why);
  notifyMention({ server: raid.address, channel: 0, author_key: KEYS.elin, author_name: "Elin", channel_name: "general", text: "hi", mention: false });
  notifyMention({ server: raid.address, channel: 0, author_key: KEYS.elin, author_name: "Elin", channel_name: "general", text: "hi @you", mention: true });
  window.playSound = play;
  check("a plain message stays quiet, a mention still gets through", sounds.length === 1 && /mentioned you/.test(sounds[0]), JSON.stringify(sounds));
  openServerMenu(raid, 300, 300);
  await wait(30);
  check("the menu offers to unmute, saying until when", rows().some((r) => r.startsWith("Unmute server") && /Muted until/.test(r)), rows().join(", "));
  closePopovers();

  prefs.notify.muted[raid.address] = Date.now() - 1000;
  check("when the hour is up, the dot comes back", serverUnread(raid));
  setServerMuted(raid, 0);
  check("muted until unmuted", serverMuted(raid) && prefs.notify.muted[raid.address] === 0);
  setServerMuted(raid, null);
  check("unmuted", !serverMuted(raid) && serverUnread(raid));
  report();
})();
