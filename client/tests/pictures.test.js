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

  // Self-hosted servers have no picture button.
  await connectTo(prefs.servers.find((s) => s.address === "192.168.8.35"));
  await wait(200);
  check("no picture button on a self-hosted server", $("attach-btn").hidden);
  report();
})();
