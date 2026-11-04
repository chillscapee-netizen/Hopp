// People you block: their messages fold away, they're silent in voice, no notifications.

(async () => {
  await inServer();
  emit("account", { type: "friend", friend: { key: KEYS.sara, username: "sara", display_name: "Sara", avatar: null, state: "blocked", status: "offline", activity: null } });
  await wait(250);
  const sara = state.chats.get(0).find((m) => m.author_key === KEYS.sara);
  check("their message folds away", !!document.querySelector(".blocked-msg") && !document.querySelector(`.msg[data-id="${sara.id}"]`));
  document.querySelector(".blocked-msg .link").click();
  await wait(150);
  check("Show reveals it", !!document.querySelector(`.msg[data-id="${sara.id}"]`));
  check("other people's messages still show", state.chats.get(0).filter((m) => m.author_key === KEYS.elin).every((m) => document.querySelector(`.msg[data-id="${m.id}"]`)));
  emit("account", { type: "friend_removed", key: KEYS.sara });
  await wait(150);
  check("unblocking shows them again", !document.querySelector(".blocked-msg"));
  report();
})();
