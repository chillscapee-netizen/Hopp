// A server's right-click menu: invite, settings and channels right there.

(async () => {
  await inServer();
  const crew = prefs.servers.find((s) => s.address === "cloud:crew0001");
  const items = () => [...$("server-menu").querySelectorAll(".menu-item")].map((b) => b.textContent);

  openServerMenu(crew, 10, 10);
  check("Invite people is first", items()[0] === "Invite people");
  check("owner gets settings and channels", ["Server settings", "Create text channel", "Create voice channel"].every((t) => items().includes(t)));
  [...$("server-menu").querySelectorAll(".menu-item")].find((b) => b.textContent === "Invite people").click();
  await wait(100);
  check("Invite people opens the invite dialog", $("invite-dialog").open);
  $("invite-dialog").close();

  // From Home, the server stays connected and the dialog still opens.
  $("home-btn").click();
  await wait(50);
  openServerMenu(crew, 10, 10);
  [...$("server-menu").querySelectorAll(".menu-item")].find((b) => b.textContent === "Invite people").click();
  await wait(150);
  check("works from Home too", $("invite-dialog").open && online());
  $("invite-dialog").close();

  // Another server: no settings until you're in it, but invite is there.
  const raid = prefs.servers.find((s) => s.address === "192.168.8.35");
  openServerMenu(raid, 10, 10);
  check("other servers: invite, no settings yet", items()[0] === "Invite people" && !items().includes("Server settings"));
  closePopovers();

  // Right-click a person.
  await connectTo(crew);
  await wait(100);
  const kim = state.roster.users.find((u) => u.name === "Sara");
  const row = [...document.querySelectorAll("li.member, .member")].find((x) => x.textContent.includes("Sara"));
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
  check("a person's menu has profile, mention, mute and moderation", ["Profile", "Mention", "Mute", "Kick Sara", "Ban Sara"].every((t) => items().includes(t)));
  check("with a volume slider right there", !!document.querySelector("#server-menu .menu-slider input[type=range]"));
  [...$("server-menu").querySelectorAll(".menu-item")].find((b) => b.textContent === "Mention").click();
  check("Mention puts @name in the box", $("chat-input").value.includes("@Sara "));
  $("chat-input").value = "";

  // Voice channels: everyone gets a menu.
  const lobby = [...document.querySelectorAll(".channel-row")].find((x) => x.textContent.includes("Gaming"));
  lobby.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
  check("voice channel menu: join and invite", items().includes("Join voice") && items().includes("Invite people"));
  closePopovers();
  report();
})();
