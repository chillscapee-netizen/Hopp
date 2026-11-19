// Anyone in a server can be blocked from their menu, friend or not (asked first), and
// unblocked again from the same menu.

(async () => {
  await inServer();
  state.accountConnected = true;
  const sent = [];
  const send = commands.account_send;
  commands.account_send = (a) => {
    sent.push(a.msg);
    return null;
  };
  const items = () => [...$("server-menu").querySelectorAll(".menu-item")].map((b) => b.textContent.trim());
  const pick = (label) => [...$("server-menu").querySelectorAll(".menu-item")].find((b) => b.textContent.trim() === label);
  const other = state.roster.users.find((u) => u.session_id !== state.roster.me);
  const key = keyOf(other);
  state.friends.delete(key);

  openUserMenu(other, document.querySelector(".member"), new MouseEvent("contextmenu", { clientX: 200, clientY: 200 }));
  await wait(30);
  check("someone who isn't a friend can be blocked", items().includes("Block"), items().join(", "));
  pick("Block").click();
  await wait(30);
  check("it asks first", $("confirm-dialog").open && !sent.some((m) => m.type === "block"));
  $("confirm-ok").click();
  await wait(30);
  check("then blocks them", sent.some((m) => m.type === "block" && m.key === key));

  emit("account", { type: "friend", friend: { key, username: null, display_name: other.name, avatar: null, state: "blocked", status: "offline", activity: null } });
  await wait(30);
  openUserMenu(other, document.querySelector(".member"), new MouseEvent("contextmenu", { clientX: 200, clientY: 200 }));
  await wait(30);
  check("blocked: the menu offers to unblock", items().includes("Unblock") && !items().includes("Block"), items().join(", "));
  pick("Unblock").click();
  await wait(30);
  check("and unblocks", sent.some((m) => m.type === "unblock" && m.key === key));
  closePopovers();
  emit("account", { type: "friend_removed", key });
  commands.account_send = send;
  report();
})();
