// Link previews: a card under ordinary links, fetched once, kept across redraws, and off when you say so.

(async () => {
  await inServer();
  await wait(200);
  const card = () => document.querySelector("#messages .link-card");
  check("a link gets a card", card()?.querySelector(".link-card-title")?.textContent === "Patch 4.2 notes");
  check("with the site and what it says", card().querySelector(".link-card-site").textContent === "example.com" && card().querySelector(".link-card-desc").textContent.startsWith("Balance"));
  const asked = sent.filter((m) => m.type === "link_preview").length;
  const before = card();
  renderMessages(true);
  emit("reactions", { channel: 0, id: state.chats.get(0).find((m) => m.text.includes("example.com")).id, reactions: [{ emoji: "🔥", keys: [KEYS.elin] }] });
  await wait(100);
  check("the same card stays through redraws", card() === before);
  check("fetched only once", sent.filter((m) => m.type === "link_preview").length === asked, String(asked));
  check("videos, invites and GIFs aren't previewed", !previewable("https://youtu.be/dQw4w9WgXcQ") && !previewable("https://static.klipy.com/a/b.gif") && !previewable("https://x.com/pic.png"));

  // Off in Privacy & safety: no cards, nothing fetched.
  openSettings("privacy");
  document.getElementById("link-previews").click();
  await wait(100);
  check("switching them off removes the cards", !card() && !prefs.linkPreviews);
  sent.length = 0;
  emit("chat", { id: 9001, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "look https://news.example.org/story", sent_at: Date.now() });
  await wait(100);
  check("and nothing more is fetched", !sent.some((m) => m.type === "link_preview"));
  document.getElementById("link-previews").click();
  document.getElementById("settings").close();
  report();
})();
