// virtual-time: 90000
// Pictures in DMs: encrypted before they leave, readable only with the key in the message.

(async () => {
  await inServer();
  openDm(KEYS.elin);
  await wait(300);
  const input = $("dm-input");
  check("DM has a picture button", !!document.querySelector(".dm-composer .attach-btn"));

  const c = document.createElement("canvas");
  c.width = 320;
  c.height = 200;
  const g = c.getContext("2d");
  g.fillStyle = "#c9895a";
  g.fillRect(0, 0, 320, 200);
  const png = c.toDataURL("image/png");
  const file = new File([Uint8Array.from(atob(png.split(",")[1]), (x) => x.charCodeAt(0))], "dm.png", { type: "image/png" });
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  paste.clipboardData = { files: [file] };
  input.dispatchEvent(paste);
  for (let i = 0; i < 100 && !state.dmAttachment; i++) await wait(200);
  check("pasted picture waits in the DM tray", !!state.dmAttachment && !$("dm-attach-tray").hidden);

  // The cloud only hands back what it got: serve the uploads to the app's fetch.
  window.fetch = async (url) => {
    const id = String(url).split("/").pop();
    const data = uploadedDm.get(id);
    return data ? new Response(data) : new Response("Gone", { status: 404 });
  };
  sent.length = 0;
  input.value = "for you";
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  for (let i = 0; i < 50 && !sent.some((m) => m.type === "dm_send"); i++) await wait(100);
  const dm = sent.find((m) => m.type === "dm_send");
  const stored = uploadedDm.get("cd".repeat(16));
  check("uploaded encrypted, not as a picture", stored && stored.length > 28 && !String.fromCharCode(...stored.slice(0, 16)).includes("RIFF") && !(stored[0] === 0xff && stored[1] === 0xd8));
  check("the key travels only in the sealed message", dm && /^plain:hopp-dm-image:[0-9a-f]{64}:c{0}(cd){16}:[A-Za-z0-9_-]{43} \d+x\d+\nfor you$/.test(dm.sealed));

  for (let i = 0; i < 50 && !document.querySelector(".dm-messages .msg-picture img[src^='blob:']"); i++) await wait(100);
  const shown = document.querySelector(".dm-messages .msg-picture img[src^='blob:']");
  check("decrypted and shown", !!shown);
  check("caption shown, token hidden", document.querySelector(".dm-messages").textContent.includes("for you") && !document.querySelector(".dm-messages").textContent.includes("hopp-dm-image"));
  check("preview says the caption", previewText(dm.sealed.slice(6)) === "for you");

  // A picture whose key is wrong (or that's gone) says so instead of breaking.
  const bad = dmPictureView(ME, "ef".repeat(16), "A".repeat(43), 100, 100);
  document.body.append(bad);
  await wait(300);
  check("missing picture says so", bad.classList.contains("gone"));
  report();
})();
