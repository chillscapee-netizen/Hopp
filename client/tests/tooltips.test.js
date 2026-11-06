// No tooltips anywhere: hovering never pops anything up; the words stay for screen readers.

(async () => {
  await inServer();
  const tip = document.getElementById("tooltip");
  const hover = (node) => node.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  hover(document.getElementById("members-toggle"));
  check("no tooltip on an icon", tip.hidden);
  check("its words stay for screen readers", document.getElementById("members-toggle").getAttribute("aria-label")?.includes("member list"));
  hover(document.querySelector("#server-list .rail-item"));
  check("none on a server in the rail either", tip.hidden);
  check("and no native hover text anywhere", ![...document.querySelectorAll("[title]")].some((n) => n.tagName !== "IFRAME" && n.title));
  report();
})();
