// Search: a field always in the header; results in a panel on the right. A server's channels
// are searched by the server, a conversation here (DMs are encrypted). Matches are marked,
// and a click goes to the message while the results stay.

async function type(input, text, enter = true) {
  input.value = text;
  input.dispatchEvent(new Event("input"));
  if (enter) input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await wait(enter ? 60 : 450);
}

(async () => {
  await inServer();
  const panel = document.getElementById("search-panel");
  const count = () => document.getElementById("search-count").textContent;
  const input = document.getElementById("search-input");
  check("the field is always there", !!input.offsetParent && panel.hidden);

  // An older server can't search: it says so instead of hanging.
  state.roster.features = [];
  await type(input, "round");
  check("an old server says it needs an update", !panel.hidden && count().includes("needs an update") && !sent.some((m) => m.type === "search"));

  state.roster.features = ["search"];
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }));
  check("Ctrl+F puts the cursor in it", document.activeElement === input);
  await type(input, "e");
  check("one letter asks for more", count().includes("at least two"));
  // Typing searches on its own after a pause.
  await type(input, "TONIGHT", false);
  const items = panel.querySelectorAll(".search-item");
  check("finds it, in any case", items.length === 1 && items[0].textContent.includes("Anyone up for a round tonight?") && count() === "1 result");
  check("the panel takes the member list's place", document.querySelector(".channel-body.searching") && getComputedStyle(document.querySelector(".members")).display === "none");
  check("marks the words", items[0].querySelector("mark")?.textContent === "tonight");
  check("says which channel", items[0].querySelector(".search-where")?.textContent === "#general");
  items[0].click();
  await wait(100);
  check("the results stay open", !panel.hidden && items[0].classList.contains("active"));
  check("and the message lights up", !!document.querySelector("#messages .msg.flash"));

  await type(input, "zzz nothing");
  check("says when nothing is found", count() === "Nothing found");
  // Clearing the field closes the panel; Escape too.
  await type(input, "", false);
  check("an empty field closes it", panel.hidden && !document.querySelector(".channel-body.searching"));
  await type(input, "tonight");
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  check("Escape closes and clears", panel.hidden && input.value === "");

  // A conversation: searched here, older messages loaded first.
  document.getElementById("home-btn").click();
  await wait(150);
  openDm(KEYS.elin);
  await wait(250);
  const dmInput = document.getElementById("dm-search-input");
  check("conversations have the field too", !!dmInput.offsetParent);
  sent.length = 0;
  await type(dmInput, "lobby");
  await wait(250);
  const dmItems = panel.querySelectorAll(".search-item");
  check("finds a DM, beside the conversation", dmItems.length === 1 && dmItems[0].textContent.includes("Join Lobby in 5") && panel.parentElement.id === "home-body");
  check("never asks a server about DMs", !sent.some((m) => m.type === "search"));
  dmItems[0].click();
  await wait(100);
  check("goes to it in the conversation", !!document.querySelector("li.flash"));

  // Filters work in a conversation too, without any words.
  await type(dmInput, "from:me");
  await wait(250);
  let found = [...panel.querySelectorAll(".search-item")].map((n) => n.textContent);
  check("from:me finds only yours", found.length >= 1 && found.every((t) => t.includes("Marcus")), found.join(" | "));
  await type(dmInput, "from:elin tonight");
  await wait(250);
  found = [...panel.querySelectorAll(".search-item")].map((n) => n.textContent);
  check("from: with words", found.length === 1 && found[0].includes("Ready for tonight"), found.join(" | "));
  check("the words are marked, not the filter", panel.querySelector(".search-item mark")?.textContent.toLowerCase() === "tonight");
  await type(dmInput, "x");
  check("a single letter shows how to filter", count().includes("from:name") && !count().includes("in:channel"));
  report();
})();
