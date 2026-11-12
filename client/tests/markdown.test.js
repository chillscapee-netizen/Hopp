// Formatting in messages: headings, small print, lists, underline, and links with their own
// words that always show the site they open; previews keep just the words.

(async () => {
  await inServer();
  const text = "# Big\n## Middle\n### Small\nPlain **bold** __under__\n- one\n- two\n3. three\n4. four\n-# fine print\n[Sign up](https://example.com/raid) and #not a heading";
  emit("chat", { id: 9991, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text, sent_at: Date.now() });
  await wait(120);
  const msg = document.querySelector('.msg[data-id="9991"] .msg-text');
  check("three heading sizes", msg.querySelector(".msg-h1")?.textContent === "Big" && msg.querySelector(".msg-h2")?.textContent === "Middle" && msg.querySelector(".msg-h3")?.textContent === "Small");
  check("underline", msg.querySelector("u")?.textContent === "under");
  check("a bullet list", msg.querySelectorAll("ul.msg-list li").length === 2);
  check("a numbered list keeps its first number", msg.querySelector("ol.msg-list")?.start === 3 && msg.querySelectorAll("ol.msg-list li").length === 2);
  check("small print", msg.querySelector(".msg-subtext")?.textContent === "fine print");
  const link = msg.querySelector(".msg-masked");
  check("a link with its own words shows where it goes", link?.querySelector("a")?.textContent === "Sign up" && link.querySelector(".msg-link-host")?.textContent === "example.com");
  check("#word without a space is just text", msg.textContent.includes("#not a heading"));
  check("previews keep the words, not the marks", previewText("# Raid\n-# small [Sign](https://x.io) __u__") === "Raid small Sign u", previewText("# Raid\n-# small [Sign](https://x.io) __u__"));
  report();
})();
