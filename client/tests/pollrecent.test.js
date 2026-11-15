// Voting in a poll doesn't put "poll:0" among your recent emojis (it travels like a reaction).

(async () => {
  await inServer();
  localStorage.setItem("recentEmoji", JSON.stringify(["poll:1", "👍"]));
  check("an old vote saved there is left out", JSON.stringify(recentEmoji()) === JSON.stringify(["👍"]), JSON.stringify(recentEmoji()));
  rememberEmoji("poll:0");
  rememberEmoji("🔥");
  check("a new vote isn't remembered as an emoji", !recentEmoji().some((e) => e.startsWith("poll:")) && recentEmoji()[0] === "🔥", JSON.stringify(recentEmoji()));
  report();
})();
