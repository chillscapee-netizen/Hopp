// Discover Hopp: the compass opens a page of its own (not a popup) with sections in the
// sidebar: what's new (every version, newest first), guides, about; a dot until read.
(async () => {
  try { localStorage.removeItem("newsSeen"); } catch {}
  await inServer();
  await renderNewsDot();
  check("a dot shows news you haven't read", !$("news-dot").hidden);
  $("news-btn").click();
  await wait(150);
  check("the compass opens a page of its own", $("shell").classList.contains("news") && getComputedStyle($("news-view")).display !== "none" && !document.querySelector("dialog[open]"));
  check("the sidebar lists its sections", document.querySelectorAll("#sidebar-body .news-nav").length === 7 && $("sidebar-title").textContent === "Discover");
  const items = [...document.querySelectorAll("#news-body .news-release")];
  check("what's new: every version, newest first", items.length >= 5 && items[0].textContent.includes("Version 0.3.5") && !!items[0].querySelector(".news-new"));
  check("reading it clears the dot", $("news-dot").hidden);
  [...document.querySelectorAll(".news-nav")].find((b) => b.textContent.includes("Voice, video")).click();
  await wait(80);
  check("a short guide has no list under it", !document.querySelector("#sidebar-body .news-part"));
  check("a guide opens in the page", $("news-title").textContent === "Voice, video and calls" && document.querySelectorAll("#news-body .news-card").length >= 3);
  [...document.querySelectorAll(".news-nav")].find((b) => b.textContent.includes("About Hopp")).click();
  await wait(80);
  const parts = [...document.querySelectorAll("#sidebar-body .news-part")].map((b) => b.textContent);
  check("the open section folds out its parts", parts.includes("Hopp Cloud, honestly") && parts.includes("Free, all of it"), parts.join(" | "));
  check("each part is on the page to jump to", parts.length > 0 && [...document.querySelectorAll(".news-part")].every((b) => document.getElementById(b.dataset.anchor)));
  check("the limits list every number", document.querySelectorAll(".news-limit").length === 7);
  check("the compass is marked, not Home or a server", $("news-btn").classList.contains("active") && !$("home-btn").classList.contains("active") && !document.querySelector("#server-list .rail-item.active"));
  document.querySelector("#server-list .rail-item").click();
  await wait(150);
  check("a server in the list leaves the page", !$("shell").classList.contains("news") && getComputedStyle($("news-view")).display === "none");
  report();
})();
