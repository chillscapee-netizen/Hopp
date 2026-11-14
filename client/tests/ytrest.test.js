// A paused YouTube video doesn't keep its player (a whole YouTube page) running: after a while
// paused, or when it ends, the picture comes back with "Continue at", which opens it again there.

(async () => {
  await inServer();
  emit("chat", { id: 9901, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "look https://www.youtube.com/watch?v=dQw4w9WgXcQ", sent_at: Date.now() });
  await wait(80);
  const card = () => document.querySelector('.msg[data-id="9901"] .yt-card');
  card().querySelector(".yt-play").click();
  await wait(50);
  const player = card().querySelector("iframe");
  check("playing opens the player", !!player);
  check("which tells Hopp how it's doing", /enablejsapi=1/.test(player?.src ?? ""), player?.src);
  YT_REST_MS = 150;
  const tell = (info) => window.dispatchEvent(new MessageEvent("message", { origin: "https://www.youtube-nocookie.com", source: player.contentWindow, data: JSON.stringify({ event: "infoDelivery", info }) }));
  tell({ playerState: 1, currentTime: 140 });
  await wait(300);
  check("while it plays, it stays", !!card().querySelector("iframe"));
  tell({ playerState: 2, currentTime: 151 });
  await wait(80);
  check("just paused: still there (you might go on)", !!card().querySelector("iframe"));
  await wait(250);
  check("paused a while: the player is closed", !card().querySelector("iframe"));
  check("and says where it was", card().querySelector(".yt-resume")?.textContent === "Continue at 2:31", card().querySelector(".yt-resume")?.textContent);
  card().querySelector(".yt-play").click();
  await wait(50);
  check("pressing it goes on from there", /[?&]start=151\b/.test(card().querySelector("iframe")?.src ?? ""), card().querySelector("iframe")?.src);

  // Finished: closed too, and starts over next time.
  const again = card().querySelector("iframe");
  window.dispatchEvent(new MessageEvent("message", { origin: "https://www.youtube-nocookie.com", source: again.contentWindow, data: JSON.stringify({ event: "onStateChange", info: 0 }) }));
  await wait(1800);
  check("when it ends, it closes", !card().querySelector("iframe") && !card().querySelector(".yt-resume"));

  // Messages from anywhere else are ignored.
  card().querySelector(".yt-play").click();
  await wait(50);
  const third = card().querySelector("iframe");
  window.dispatchEvent(new MessageEvent("message", { origin: "https://evil.example", source: third.contentWindow, data: JSON.stringify({ event: "onStateChange", info: 0 }) }));
  await wait(1800);
  check("only YouTube itself can say it stopped", !!card().querySelector("iframe"));
  YT_REST_MS = 3000;
  report();
})();
