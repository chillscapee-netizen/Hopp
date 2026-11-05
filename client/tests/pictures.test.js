// Pictures in chat: attach, caption, send, show.
// virtual-time: 150000

(async () => {
  await inServer();
  check("picture button on a cloud server", !$("attach-btn").hidden);

  // A big picture, as if pasted.
  const canvas = document.createElement("canvas");
  canvas.width = 1800;
  canvas.height = 1000;
  const g = canvas.getContext("2d");
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `hsl(${i * 37} 70% 50%)`;
    g.fillRect((i * 97) % 1800, (i * 53) % 1000, 180, 120);
  }
  const png = canvas.toDataURL("image/png");
  const file = new File([Uint8Array.from(atob(png.split(",")[1]), (c) => c.charCodeAt(0))], "shot.png", { type: "image/png" });
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  paste.clipboardData = { files: [file] };
  $("chat-input").dispatchEvent(paste);
  for (let i = 0; i < 500 && !state.attachment; i++) await wait(200);
  check("pasted picture waits in the tray", !$("attach-tray").hidden && !!document.querySelector(".attach-card img"));
  check("shrunk to fit", state.attachment && state.attachment.blob.size <= 300_000 && Math.max(state.attachment.width, state.attachment.height) <= 1600);

  sent.length = 0;
  $("chat-input").value = "look at this";
  $("chat-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  for (let i = 0; i < 50 && state.attachment; i++) await wait(100);
  const upload = sent.find((m) => m.type === "upload_image");
  check("uploaded", upload && upload.size > 0 && /^image\/(webp|jpeg)$/.test(upload.kind));
  const msg = [...document.querySelectorAll(".msg")].pop();
  check("tray cleared after sending", $("attach-tray").hidden && !state.attachment);

  // The message as it comes back from the server.
  const text = `hopp-image:${"ab".repeat(16)} 1600x1067\nlook at this`;
  emit("chat", { id: 990, channel: 0, sender: 1, sender_name: "Marcus", author_key: ME, text, sent_at: Date.now() });
  await wait(200);
  const shown = document.querySelector('.msg[data-id="990"]');
  check("picture shown with its caption", shown?.querySelector(".msg-picture") && shown.textContent.includes("look at this") && !shown.textContent.includes("hopp-image"));
  check("sized before loading", shown?.querySelector(".msg-picture")?.style.aspectRatio.replace(/\s/g, "") === "1600/1067");
  check("previews say Image", previewText(`hopp-image:${"cd".repeat(16)} 10x10`) === "Image" && previewText(text) === "look at this");
  startEdit({ id: 990, channel: 0, text, author_key: ME });
  check("pictures aren't edited", !state.editing);

  // Dropping: a picture lands in the tray; any other file gets a clear word.
  const dropOn = (target, file) => {
    const dt = new DataTransfer();
    dt.items.add(file);
    const ev = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
    target.dispatchEvent(ev);
    return ev;
  };
  const small = document.createElement("canvas");
  small.width = 200;
  small.height = 120;
  small.getContext("2d").fillRect(0, 0, 50, 50);
  const smallPng = small.toDataURL("image/png");
  dropOn($("scroller"), new File([Uint8Array.from(atob(smallPng.split(",")[1]), (c) => c.charCodeAt(0))], "drop.png", { type: "image/png" }));
  for (let i = 0; i < 100 && !state.attachment; i++) await wait(200);
  check("dropped picture waits in the tray", !!state.attachment);
  clearAttachment();
  dropOn($("scroller"), new File(["hello"], "notes.txt", { type: "text/plain" }));
  await wait(100);
  check("other files get a clear word", document.body.textContent.includes("Servers take pictures only"));
  const stray = dropOn($("sidebar") ?? document.body, new File(["x"], "x.txt", { type: "text/plain" }));
  check("a stray drop doesn't open the file", stray.defaultPrevented);

  // Server and profile pictures still come out as small image data.
  const iconData = await shrinkPicture(new File([Uint8Array.from(atob(smallPng.split(",")[1]), (c) => c.charCodeAt(0))], "icon.png", { type: "image/png" }));
  check("server and profile pictures still work", typeof iconData === "string" && iconData.startsWith("data:image/"));

  // The owner turns pictures off: in one channel, then everywhere.
  const r = structuredClone(state.roster);
  r.channels.find((c) => c.id === 0).no_pictures = true;
  emit("roster", r);
  await wait(150);
  check("no button where pictures are off", $("attach-btn").hidden);
  dropOn($("scroller"), new File([Uint8Array.from(atob(smallPng.split(",")[1]), (c) => c.charCodeAt(0))], "x.png", { type: "image/png" }));
  await wait(100);
  check("says pictures are off", document.body.textContent.includes("Pictures are turned off in this channel") && !state.attachment);
  openChannelEdit(state.roster.channels.find((c) => c.id === 0));
  check("channel editor shows it off", !$("channel-edit-pictures-row").hidden && !$("channel-edit-pictures").checked);
  $("channel-edit-pictures").checked = true;
  sent.length = 0;
  $("channel-edit-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await wait(50);
  check("turning it back on is saved", sent.some((m) => m.type === "update_channel" && m.noPictures === false));
  $("channel-edit-dialog").close();

  const r2 = structuredClone(state.roster);
  r2.channels.find((c) => c.id === 0).no_pictures = false;
  r2.pictures_off = true;
  emit("roster", r2);
  await wait(150);
  check("off for the whole server", $("attach-btn").hidden);
  openServerSettings();
  check("overview shows it off", !$("overview-pictures-row").hidden && !$("overview-pictures").checked);
  $("overview-pictures").checked = true;
  $("overview-pictures").dispatchEvent(new Event("change"));
  check("changing it offers Save", !$("overview-save-bar").hidden);
  sent.length = 0;
  $("overview-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await wait(50);
  check("saved for the server", sent.some((m) => m.type === "update_server" && m.picturesOff === false));
  $("server-settings").close();

  // Self-hosted servers have no picture button.
  await connectTo(prefs.servers.find((s) => s.address === "192.168.8.35"));
  await wait(200);
  check("no picture button on a self-hosted server", $("attach-btn").hidden);
  report();
})();
