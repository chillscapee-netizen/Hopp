// Server and channel settings: the server on top, an empty Roles page that invites, the channel window's tabs.

(async () => {
  await inServer();
  const r = structuredClone(state.roster);
  r.features = ["search", "screen", "voice-chat", "voice-mod", "voice-settings", "mod-tools", "roles"];
  r.roles = [];
  emit("roster", r);
  await wait(100);
  commands.create_role = (a) => sent.push({ type: "create_role", ...a });

  openServerSettings();
  await wait(50);
  check("the server's icon is on top", !!document.querySelector("#server-settings-icon .settings-server-icon"));
  showServerTab("roles");
  await wait(30);
  check("no roles shows an empty page", !$("roles-empty").hidden && $("roles-layout").hidden);
  sent.length = 0;
  $("role-new-empty").click();
  check("its button makes the first role", sent.some((m) => m.type === "create_role"));
  $("server-settings").close();

  const voice = state.roster.channels.find((c) => c.kind === "voice");
  openChannelEdit(voice);
  await wait(30);
  check("a voice channel has a Voice tab", !$("ctab-voice").hidden);
  check("it opens on Overview", !document.querySelector('[data-cpanel="overview"]').hidden && document.querySelector('[data-cpanel="voice"]').hidden);
  document.querySelector('[data-ctab="voice"]').click();
  check("a tab shows its page", !document.querySelector('[data-cpanel="voice"]').hidden && document.querySelector('[data-cpanel="overview"]').hidden);
  $("channel-edit-dialog").close();

  const text = state.roster.channels.find((c) => c.kind !== "voice");
  openChannelEdit(text);
  await wait(30);
  check("a text channel has no Voice tab", $("ctab-voice").hidden);
  check("and opens on Overview again", !document.querySelector('[data-cpanel="overview"]').hidden);
  $("channel-delete").click();
  await wait(30);
  check("Delete channel asks first", $("channel-edit-dialog").open === false && document.querySelector("dialog[open]") !== null);
  report();
})();
