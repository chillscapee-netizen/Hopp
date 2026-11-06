// What's new: the sparkle in the server list opens every version's news, newest first; a dot
// until you've read the latest.
(async () => {
  try { localStorage.removeItem("newsSeen"); } catch {}
  await inServer();
  await renderNewsDot();
  check("a dot shows news you haven't read", !$("news-dot").hidden);
  $("news-btn").click();
  await wait(150);
  const items = [...document.querySelectorAll(".news-item")];
  check("the page opens with every version", $("news-dialog").open && items.length >= 5);
  check("newest first, marked Latest", items[0].textContent.includes("0.2.5") && !!items[0].querySelector(".news-new"));
  check("each point on its own line", items[0].querySelectorAll(".news-points li").length > 3);
  check("reading it clears the dot", $("news-dot").hidden);
  report();
})();
