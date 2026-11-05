// Sending many messages fast: the list only grows, nothing jumps back.

(async () => {
  await inServer();
  const scroller = $("scroller");
  const input = $("chat-input");
  const heights = [scroller.scrollHeight];
  let shrank = 0;
  const watch = () => {
    const h = scroller.scrollHeight;
    if (h < heights.at(-1)) shrank++;
    heights.push(h);
  };
  new MutationObserver(watch).observe($("messages"), { childList: true, subtree: true });
  for (let i = 0; i < 8; i++) {
    input.value = "spam " + i;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    watch();
    await wait(4);
    watch();
  }
  await wait(200);
  watch();
  check("the list never shrinks back while spamming", shrank === 0, heights.join(","));
  check("everything sent shows", [...document.querySelectorAll("#messages .msg")].filter((li) => /spam \d/.test(li.textContent)).length === 8);
  check("still at the bottom", scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 5);
  check("your own messages don't slide in twice", !document.querySelector(".msg.arrive"));
  report();
})();
