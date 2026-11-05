// Search: a server's channels (searched by the server) and a conversation (searched here,
// since DMs are encrypted); matches are marked, and a click goes to the message.

(async () => {
  await inServer();
  const pop = document.getElementById("search-pop");

  // An older server can't search: it says so instead of hanging.
  state.roster.features = [];
  document.getElementById("search-btn").click();
  let input = pop.querySelector("input");
  check("the search opens with the cursor in it", !pop.hidden && document.activeElement === input);
  input.value = "round";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await wait(50);
  check("an old server says it needs an update", pop.textContent.includes("needs an update") && !sent.some((m) => m.type === "search"));
  closePopovers();

  // A server that can search.
  state.roster.features = ["search"];
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true }));
  await wait(50);
  input = pop.querySelector("input");
  check("Ctrl+F opens it too", !pop.hidden && document.activeElement === input);
  input.value = "e";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await wait(50);
  check("one letter asks for more", pop.textContent.includes("at least two"));
  // Typing searches on its own after a pause.
  input.value = "TONIGHT";
  input.dispatchEvent(new Event("input"));
  await wait(500);
  const items = pop.querySelectorAll(".search-item");
  check("finds it, in any case", items.length === 1 && items[0].textContent.includes("Anyone up for a round tonight?"));
  check("marks the words", items[0].querySelector("mark")?.textContent === "tonight");
  check("says which channel", items[0].querySelector(".search-where")?.textContent === "#general");
  items[0].click();
  await wait(100);
  check("a click closes the search", pop.hidden);
  check("and lights up the message", !!document.querySelector("#messages .msg.flash"));

  input.value = "zzz nothing";
  document.getElementById("search-btn").click();
  input = pop.querySelector("input");
  input.value = "zzz nothing";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await wait(50);
  check("says when nothing is found", pop.textContent.includes("Nothing found"));
  closePopovers();

  // A conversation: searched here, older messages loaded first.
  document.getElementById("home-btn").click();
  await wait(150);
  openDm(KEYS.elin);
  await wait(250);
  const dmBtn = document.getElementById("dm-search-btn");
  check("conversations have a search too", !dmBtn.hidden);
  sent.length = 0;
  dmBtn.click();
  input = pop.querySelector("input");
  check("named after the friend", input.placeholder === "Search Elin");
  input.value = "lobby";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  await wait(300);
  const dmItems = pop.querySelectorAll(".search-item");
  check("finds a DM", dmItems.length === 1 && dmItems[0].textContent.includes("Join Lobby in 5"));
  check("never asks a server about DMs", !sent.some((m) => m.type === "search"));
  dmItems[0].click();
  await wait(100);
  check("goes to it in the conversation", !!document.querySelector("li.flash"));
  report();
})();
