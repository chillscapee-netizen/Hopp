// Icons that open a little window close it again when pressed a second time (a real press:
// mouse down, then click), and the gear opens your account, not voice settings.

(async () => {
  await inServer();
  const press = async (node) => {
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await wait(60);
  };
  const shown = (id) => !$(id).hidden;
  for (const [button, pop] of [["pins-btn", "pins-pop"], ["inbox-btn", "inbox-pop"], ["emoji-btn", "emoji-picker"]]) {
    await press($(button));
    check(`${button}: opens`, shown(pop));
    await press($(button));
    check(`${button}: pressed again, closes`, !shown(pop));
  }
  await press($("me-card"));
  check("status menu: opens", shown("server-menu"));
  await press($("me-card"));
  check("status menu: pressed again, closes", !shown("server-menu"));
  await press($("sidebar-head"));
  check("server menu: opens", shown("server-menu"));
  await press($("sidebar-head"));
  check("server menu: pressed again, closes", !shown("server-menu"));

  document.querySelector(".open-settings").click();
  await wait(60);
  check("the gear opens your account", !document.querySelector('[data-panel="profile"]').hidden && document.querySelector('[data-panel="voice"]').hidden);
  $("settings").close();
  report();
})();
