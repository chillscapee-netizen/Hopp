// Pinned conversations, friend groups, the sidebar's width and bigger groups.

(async () => {
  try {
  for (let i = 0; i < 60 && !state.accountConnected; i++) await wait(50);
  emit("account", { type: "group", group: { id: "g:00aa11bb", name: "Squad", members: [ME, KEYS.elin, KEYS.jonas], created_at: Date.now() } });
  state.conversations.set("g:00aa11bb", { peer: "g:00aa11bb", last_at: Date.now(), last_read: Date.now() });
  renderAll();
  await wait(100);
  const rows = () => [...document.querySelectorAll(".dm-row .row-title")].map((r) => r.textContent);
  check("newest conversation first", rows()[0].startsWith("Squad"), rows().join(" | "));

  // Pin Elin: she goes to the top, with a pin.
  const elinRow = [...document.querySelectorAll(".dm-row")].find((r) => r.querySelector(".row-title").textContent === "Elin");
  elinRow.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 100, clientY: 200 }));
  await wait(50);
  const pin = [...document.querySelectorAll(".menu-item")].find((m) => m.textContent.includes("Pin conversation"));
  check("the menu offers to pin", !!pin);
  pin.click();
  await wait(50);
  check("a pinned conversation comes first", rows()[0].startsWith("Elin"), rows().join(" | "));
  check("kept with your synced settings", prefs.notify.pinned?.[KEYS.elin] === true && JSON.parse(load("notify", "{}")).pinned?.[KEYS.elin]);

  // Friend groups: put Jonas in "Gaming"; the list shows the group first.
  state.friendTab = "all";
  state.openDm = null;
  renderAll();
  await wait(50);
  const jonas = [...state.friends.values()].find((f) => f.display_name === "Jonas");
  const ask = pickFriendGroup(jonas);
  await wait(50);
  check("asks for the group's name", document.getElementById("text-dialog").open && document.getElementById("text-label").textContent === "Group for Jonas");
  document.getElementById("text-input").value = "Gaming";
  document.getElementById("text-ok").click();
  await ask;
  await wait(50);
  const heads = [...document.querySelectorAll(".friend-group-head")].map((h) => h.textContent);
  check("the group gets its own heading", heads[0] === "Gaming — 1" && heads[1]?.startsWith("Other friends"), heads.join(" | "));
  check("with Jonas under it", document.querySelector(".friend-group-head + .friend-list")?.textContent.includes("Jonas"));
  // Suggested next time.
  pickFriendGroup(state.friends.get(KEYS.sara));
  await wait(50);
  check("your groups are offered next time", [...document.querySelectorAll("#text-options option")].map((o) => o.value).join() === "Gaming");
  document.getElementById("text-cancel").click();
  await wait(50);
  check("cancel changes nothing", !friendGroup(KEYS.sara));
  setFriendGroup(jonas.key, "");
  await wait(50);
  check("an empty group leaves the list plain", !document.querySelector(".friend-group-head"));

  // The sidebar: dragged wider, kept, and put back with a double-click.
  check("the sidebar starts at its usual width", Math.round(document.querySelector(".sidebar").getBoundingClientRect().width) === 248);
  setSidebarWidth(330);
  await wait(30);
  check("it can be made wider", Math.round(document.querySelector(".sidebar").getBoundingClientRect().width) === 330 && load("sidebarWidth", "") === "330");
  check("but not too wide", setSidebarWidth(900) === 420 && setSidebarWidth(50) === 200);
  document.querySelector(".sidebar-grip").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await wait(30);
  check("a double-click puts it back", Math.round(document.querySelector(".sidebar").getBoundingClientRect().width) === 248);

  // Groups of up to 25.
  check("groups hold 25 people", GROUP_MAX === 25 && GROUP_CALL_MAX === 10);
  } catch (err) {
    check("no crash", false, err.stack);
  }
  report();
})();
