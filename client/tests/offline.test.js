// The member list also shows who isn't here right now, under Offline; their profile opens too.
(async () => {
  await inServer();
  let asked = 0;
  const everyone = [
    ...state.roster.users.map((u) => ({ public_key: keyOf(u), name: u.name, role: u.owner ? "owner" : null, joined_at: 1, roles: [] })),
    { public_key: "ab".repeat(32), name: "Nora", role: null, joined_at: 2, roles: [] },
    { public_key: "cd".repeat(32), name: "Omar", role: null, joined_at: 3, roles: [] },
  ];
  commands.get_members = () => { asked++; setTimeout(() => emit("members", everyone), 5); };
  check("a server that doesn't share its members shows none offline", !document.querySelector("#member-list .member.offline"));
  const r = structuredClone(state.roster);
  r.features = [...(r.features ?? []), "members"];
  emit("roster", r);
  await wait(120);
  check("the members are asked for once", asked === 1, String(asked));
  const groups = [...document.querySelectorAll("#member-list .member-group")].map((n) => n.textContent);
  check("people who aren't here are under Offline", groups.at(-1) === "Offline — 2", groups.join(" | "));
  const rows = [...document.querySelectorAll("#member-list .member.offline")];
  check("by name, a step back, with an offline dot", rows.map((n) => n.querySelector(".member-name").textContent).join() === "Nora,Omar" && !!rows[0].querySelector(".status-dot.offline") && Number(getComputedStyle(rows[0]).opacity) < 1);
  check("nobody is listed twice", document.querySelectorAll("#member-list .member").length === state.roster.users.length + 2);

  // Someone closes Hopp: from Online to Offline, without asking again. (Leaving the server
  // while Hopp is still open keeps you online; that's in serverpresence.test.js.)
  const sara = state.friends?.get(KEYS.sara);
  if (sara) sara.status = "offline";
  const r2 = structuredClone(state.roster);
  r2.users = r2.users.filter((u) => u.name !== "Sara");
  emit("roster", r2);
  await wait(80);
  check("someone who leaves moves to Offline", [...document.querySelectorAll("#member-list .member.offline")].some((n) => n.querySelector(".member-name").textContent === "Sara") && asked === 1, String(asked));

  // Their profile opens like anyone's.
  [...document.querySelectorAll("#member-list .member.offline")].find((n) => n.querySelector(".member-name").textContent === "Nora").click();
  await wait(60);
  check("an offline member's profile opens", !$("user-card").hidden && $("user-card-name").textContent === "Nora");
  closePopovers();

  // The owner kicks someone who isn't here: asked first, then sent by their Hopp ID.
  const kicks = [];
  commands.kick = (a) => kicks.push(a);
  const nora = [...document.querySelectorAll("#member-list .member.offline")].find((n) => n.querySelector(".member-name").textContent === "Nora");
  nora.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 900, clientY: 300 }));
  await wait(50);
  const kick = [...document.querySelectorAll("#server-menu .menu-item")].find((n) => n.textContent.includes("Kick Nora"));
  check("right-click offers Kick to the owner", !!kick);
  kick.click();
  await wait(100);
  const dialog = document.querySelector("dialog[open]");
  check("it asks first, and says they need a new invite", /new invite/.test(dialog?.textContent ?? ""), dialog?.textContent?.slice(0, 120));
  [...dialog.querySelectorAll("button")].find((b) => b.textContent.trim() === "Kick").click();
  await wait(100);
  check("the kick goes by Hopp ID", kicks.length === 1 && kicks[0].publicKey === "ab".repeat(32) && kicks[0].ban === false, JSON.stringify(kicks));
  report();
})();
