// Long channels stay fast: only the newest part is drawn, more comes from memory as you
// scroll up (before the server is asked), and jumps reach messages that aren't drawn yet.

(async () => {
  await inServer();
  const many = [];
  for (let i = 1; i <= 600; i++) many.push({ id: 5000 + i, channel: 3, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "message number " + i, sent_at: Date.now() - (600 - i) * 60_000 });
  state.chats.set(3, many);
  state.olderDone.add(3);
  openTextChannel(3);
  await wait(100);
  const drawn = () => document.querySelectorAll("#messages .msg").length;
  check("only the newest 150 are drawn", drawn() === 150, String(drawn()));
  check("with a hint that more is above, not the channel's start", !!document.querySelector("#messages .older-loader") && !document.querySelector("#messages .welcome"));

  // Scrolling to the top draws more from memory, keeping your place, without asking the server.
  sent.length = 0;
  const scroller = document.getElementById("scroller");
  const anchor = document.querySelector('#messages .msg[data-id="5451"]');
  scroller.scrollTop = 0;
  scroller.dispatchEvent(new Event("scroll"));
  await wait(50);
  check("100 more appear", drawn() === 250, String(drawn()));
  check("the one you were at stays where it was", anchor.getBoundingClientRect().top > 0 && anchor.isConnected);
  check("no server needed", !sent.some((m) => m.type === "load_older"));

  // A jump to a message that's here but not drawn goes right to it.
  jumpToMessage(5010);
  await wait(600);
  const target = document.querySelector('#messages .msg[data-id="5010"]');
  check("a jump reaches a message far up", !!target && target.classList.contains("flash"));

  // Back at the bottom with a lot drawn: trimmed again, out of sight.
  // (A jump scrolls smoothly; in real time it may still be moving.)
  await wait(800);
  scroller.scrollTop = scroller.scrollHeight;
  await wait(100);
  scroller.scrollTop = scroller.scrollHeight;
  await wait(50);
  emit("chat", { id: 5601, channel: 3, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "newest", sent_at: Date.now() });
  await wait(100);
  check("at the bottom it's trimmed back", drawn() <= 151, String(drawn()));
  check("and the newest is there", document.querySelector("#messages .msg:last-of-type")?.textContent.includes("newest"));
  report();
})();
