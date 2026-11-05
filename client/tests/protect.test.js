// Protecting accounts: a recovery phrase never leaves by accident, and "free gift" links
// from others get a quiet warning.

const MINE = "abandon ability able about above absent absorb abstract absurd abuse access accident";
const OTHERS = "zoo zone zero youth young yellow year wrong write wrist worth world";

async function enterIn(input) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(150);
}

(async () => {
  await inServer();
  const chat = document.getElementById("chat-input");
  const dialog = document.getElementById("confirm-dialog");

  // Our own phrase in a server: refused outright, the text stays to fix.
  sent.length = 0;
  chat.value = "here are my words " + MINE;
  await enterIn(chat);
  check("our own phrase is stopped", dialog.open && document.getElementById("confirm-title").textContent === "That's your recovery phrase");
  check("with no way to send it anyway", document.getElementById("confirm-cancel").hidden);
  document.getElementById("confirm-ok").click();
  await wait(100);
  check("nothing was sent", !state.outbox.some((o) => o.text.includes("abandon")) && !state.chats.get(state.view).some((m) => m.text.includes("abandon")));
  check("the text is still there to change", chat.value.includes("abandon"));

  // Someone else's phrase: asked first; "Don't send" keeps it back.
  chat.value = OTHERS;
  await enterIn(chat);
  check("someone else's phrase asks first", dialog.open && document.getElementById("confirm-title").textContent === "This looks like a recovery phrase");
  check("the cancel button is back", !document.getElementById("confirm-cancel").hidden);
  document.getElementById("confirm-cancel").click();
  await wait(100);
  check("not sent when you say no", !state.outbox.some((o) => o.text.includes("zoo")));
  // Saying yes sends it.
  await enterIn(chat);
  document.getElementById("confirm-ok").click();
  await wait(200);
  check("sent when you insist", state.chats.get(state.view).some((m) => m.text.includes("zoo")));

  // Ordinary messages go straight out.
  chat.value = "good game everyone, same time tomorrow?";
  await enterIn(chat);
  check("ordinary chat isn't asked about", !dialog.open && state.chats.get(state.view).some((m) => m.text.startsWith("good game")));

  // In a DM too.
  document.getElementById("home-btn").click();
  await wait(150);
  openDm(KEYS.elin);
  await wait(200);
  const dm = document.getElementById("dm-input");
  sent.length = 0;
  dm.value = MINE;
  await enterIn(dm);
  check("stopped in DMs too", dialog.open && !sent.some((m) => m.type === "dm_send"));
  document.getElementById("confirm-ok").click();
  await wait(100);

  // Bait from a friend gets a warning; the same from us, or a plain link, doesn't.
  emit("account", { type: "dm", with: KEYS.elin, message: { id: "bait1", from_key: KEYS.elin, sealed: "plain:FREE nitro for you! claim it here https://disc0rd-gift.com/abc", sent_at: Date.now() } });
  emit("account", { type: "dm", with: KEYS.elin, message: { id: "plain1", from_key: KEYS.elin, sealed: "plain:look at this clip https://example.com/clip", sent_at: Date.now() } });
  await wait(200);
  const row = (id) => document.querySelector(`li[data-key="${KEYS.elin}|${id}"]`);
  check("free-gift bait is flagged", !!row("bait1")?.querySelector(".bait-warning"));
  check("an ordinary link isn't", !!row("plain1") && !row("plain1").querySelector(".bait-warning"));
  check("our own messages are never flagged", !looksLikeBait("free gift https://x.com", true) && looksLikeBait("free gift https://x.com", false));
  check("no link, no warning", !looksLikeBait("free food at my place tonight", false));
  report();
})();
