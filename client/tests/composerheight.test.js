// The message box keeps its one-line height and shows no scrollbar after switching servers:
// its height was measured while hidden (connecting), which made it too low.

(async () => {
  await inServer();
  const input = $("chat-input");
  const normal = input.offsetHeight;
  // As while a server connects: the box is hidden and a draft is put back.
  $("composer").hidden = true;
  autosize();
  check("hidden, it isn't given a measured height", input.style.height === "", input.style.height);
  renderAll();
  await wait(50);
  check("shown again: one line high, as before", !$("composer").hidden && Math.abs(input.offsetHeight - normal) <= 1, `${input.offsetHeight} vs ${normal}`);
  check("and no scrollbar", getComputedStyle(input).overflowY === "hidden" && input.scrollHeight <= input.clientHeight + 1);

  // A long message still grows the box, and scrolls only past its tallest.
  input.value = Array.from({ length: 60 }, (_, i) => "line " + i).join("\n");
  autosize();
  check("a long message: as tall as it may be, then it scrolls", input.offsetHeight > normal * 3 && getComputedStyle(input).overflowY === "auto");
  input.value = "";
  autosize();
  check("emptied: back to one line, no scrollbar", Math.abs(input.offsetHeight - normal) <= 1 && getComputedStyle(input).overflowY === "hidden");
  report();
})();
