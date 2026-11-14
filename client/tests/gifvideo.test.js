// GIFs as short videos (as Discord does): played by the graphics card, silent and looping, and
// only while you can see them. Older GIF links still show as pictures.

(async () => {
  await inServer();
  const send = (id, text) => emit("chat", { id, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text, sent_at: Date.now() });
  send(9801, "https://static.klipy.com/ii/abc/12/34/clip.mp4");
  send(9802, "https://static1.klipy.com/ii/def/56/78/old.gif");
  await wait(80);
  const v = document.querySelector('.msg[data-id="9801"] video.msg-gif');
  check("a GIF video shows as a video", !!v, document.querySelector('.msg[data-id="9801"]')?.innerHTML.slice(0, 120));
  check("silent, looping, inline, no picture-in-picture", v && v.muted && v.loop && v.playsInline && v.disablePictureInPicture);
  check("it doesn't download the whole thing before it's seen", v?.preload === "metadata");
  check("an old GIF link is still a picture", !!document.querySelector('.msg[data-id="9802"] img.msg-gif'));
  check("previews call it a GIF", previewText("https://static.klipy.com/ii/abc/12/34/clip.mp4") === "GIF");
  check("not shown as a link preview card", !document.querySelector('.msg[data-id="9801"] .link-card'));

  // Pauses when Hopp isn't in front.
  gifsInView.add(v);
  let paused = 0;
  v.pause = () => paused++;
  window.dispatchEvent(new Event("blur"));
  check("pauses when you switch to another window", paused > 0);
  report();
})();
