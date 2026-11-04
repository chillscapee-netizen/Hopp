// Clicks through every part of the app and fails on any error the page throws.

async function step(name, fn) {
  const before = pageErrors.length;
  try {
    await fn();
  } catch (e) {
    pageErrors.push(name + ": " + e.message);
  }
  await wait(150);
  const errs = pageErrors.splice(before);
  check(name, errs.length === 0, errs.join(" | "));
  closePopovers();
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
}

(async () => {
  await inServer();
  await wait(300);
  check("server opens with messages", document.querySelectorAll("#messages .msg").length >= 5, String(document.querySelectorAll("#messages .msg").length) + " messages");
  check("voice users listed", document.querySelectorAll(".voice-user").length === 2);
  check("topic shown", document.getElementById("chat-topic").textContent === "Say hi");

  for (const tab of ["profile", "voice", "sounds", "windows"]) {
    await step("settings: " + tab, () => {
      openSettings(tab);
      document.querySelector(`.settings-tab[data-tab="${tab}"]`).click();
    });
  }
  await step("server menu", () => openServerMenu(prefs.servers[0], 300, 300));
  await step("channel menu", () => document.querySelector(".channel-row").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 200, clientY: 200 })));
  await step("edit channel dialog", () => openChannelEdit(state.roster.channels[0]));
  await step("create channel dialog", () => openChannelDialog("text"));
  await step("invite dialog", () => document.getElementById("invite-head-btn")?.click());
  await step("emoji picker", () => document.getElementById("emoji-btn").click());
  await step("GIF tab", () => {
    document.getElementById("emoji-btn").click();
    document.querySelector(".picker-tab")?.click();
  });
  await step("quick switcher", () => {
    openQuick();
    const input = document.getElementById("quick-input");
    input.value = "#cl";
    input.dispatchEvent(new Event("input"));
    check("quick switcher finds #clips", [...document.querySelectorAll(".quick-name")].some((n) => n.textContent === "clips"));
    closeQuick();
  });
  await step("message menu", () => document.querySelector(".msg").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 400, clientY: 300 })));
  await step("reply and cancel", () => {
    setReply(state.chats.get(0)[0]);
    check("reply bar shows", !document.getElementById("reply-bar").hidden);
    setReply(null);
  });
  await step("edit own message", () => {
    const mine = state.chats.get(0).find((m) => m.author_key === state.account.publicKey);
    startEdit(mine);
    check("editor opens", !!document.querySelector(".msg-editor textarea"));
    stopEdit();
  });
  await step("send a message", async () => {
    const input = document.getElementById("chat-input");
    input.value = "hello **world**";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait(200);
    check("sent message shows formatted", [...document.querySelectorAll(".msg-text strong")].some((n) => n.textContent === "world"));
  });
  await step("reactions render", () => check("reaction chip", !!document.querySelector(".reaction.mine")));
  await step("pins", () => document.getElementById("pins-btn").click());
  await step("member list toggle", () => {
    document.getElementById("members-toggle").click();
    document.getElementById("members-toggle").click();
  });
  await step("user card", () => document.querySelectorAll(".member")[1]?.click());
  await step("link warning", () => {
    openExternal("https://example.com/x");
    check("link dialog opens", document.getElementById("link-dialog").open);
  });
  await step("delete server dialog", () => deleteServer(prefs.servers[0]));
  await step("notification levels", () => {
    setServerLevel(prefs.servers[0], "all");
    setServerLevel(prefs.servers[0], "mentions");
  });
  await step("mute a channel", () => {
    setChannelMuted(prefs.servers[0].address, 3, true);
    setChannelMuted(prefs.servers[0].address, 3, false);
  });
  await step("switch channel", () => [...document.querySelectorAll(".channel-row")].find((r) => r.textContent.includes("lfg")).click());

  await step("go home", () => document.getElementById("home-btn").click());
  await wait(300);
  await step("friends tabs", () => {
    for (const t of ["all", "pending", "blocked", "add", "online"]) document.querySelector(`[data-ftab="${t}"]`)?.click();
  });
  await step("open a DM", async () => {
    document.querySelector(".dm-row")?.click();
    await wait(200);
    check("DM messages show", document.querySelectorAll(".dm-messages .msg").length >= 2);
  });
  await step("send a DM", async () => {
    const input = document.getElementById("dm-input");
    input.value = "on my way";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await wait(200);
    check("DM sent", sent.some((m) => m.type === "dm_send"));
  });
  await step("DM emoji button", () => document.querySelector(".dm-composer .composer-icon")?.click());
  await step("group dialog", () => openGroupDialog(null));
  await step("incoming call", async () => {
    emit("account", { type: "call", from: KEYS.elin, kind: "ring", call_id: "11112222-abcd", sealed: "plain:" + "ab".repeat(32) });
    await wait(200);
    check("incoming call card", !document.getElementById("incoming-call").hidden);
    document.getElementById("call-decline").click();
    check("decline sent", sent.some((m) => m.type === "call" && m.kind === "decline"));
  });
  await step("status menu", () => document.getElementById("me-card")?.click());
  await step("first steps", () => {
    state.onboarding = { step: "username", link: null };
    showWelcomeStep("picture");
    showWelcomeStep("mic");
    state.onboarding = null;
  });
  await step("username dialog", () => openUsernameDialog(false));
  report();
})();
