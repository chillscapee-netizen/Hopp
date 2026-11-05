// Tooltips only where they tell you something: plain icons show none.

(async () => {
  await inServer();
  const tip = document.getElementById("tooltip");
  const hover = (node) => node.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  hover(document.getElementById("members-toggle"));
  check("no tooltip on a plain icon", tip.hidden);
  check("its words stay for screen readers", document.getElementById("members-toggle").getAttribute("aria-label")?.includes("member list"));
  document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  const server = document.querySelector("#server-list .rail-item");
  hover(server);
  check("a server's name still shows on the rail", !tip.hidden && tip.textContent.length > 0);
  report();
})();
