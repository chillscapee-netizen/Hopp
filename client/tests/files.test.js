// real-time: 60000
// Files between friends: offered in the DM, sent straight across, saved whole.

(async () => {
  await inServer();
  openDm(KEYS.elin);
  await wait(300);
  check("the + takes files in a DM", document.querySelector(".dm-composer .attach-btn")?.dataset.tip === "Add a picture or file");

  // A file of 300 kB with a pattern, so every byte can be checked.
  const bytes = new Uint8Array(300_000).map((_, i) => (i * 7 + 3) & 255);
  const file = new File([bytes], "notes.zip", { type: "application/zip" });
  sent.length = 0;
  offerFile(KEYS.elin, file);
  await wait(200);
  const offer = sent.find((m) => m.type === "dm_send");
  const transfer = offer?.sealed.match(/hopp-file:([0-9a-f]{32})/)?.[1];
  check("the DM carries only an offer", offer && /^plain:hopp-file:[0-9a-f]{32} 300000 notes\.zip$/.test(offer.sealed));
  check("sender sees it waiting", document.querySelector(".dm-messages .file-card")?.textContent.includes("Waiting for"));

  // The same offer as the friend sees it.
  emit("account", { type: "dm", with: KEYS.elin, message: { id: "f1", from_key: KEYS.elin, sealed: `plain:hopp-file:${transfer} 300000 notes.zip`, sent_at: Date.now() } });
  await wait(200);
  const theirs = [...document.querySelectorAll(".dm-messages .file-card")].find((c) => c.message.from_key === KEYS.elin);
  check("receiver gets a Download button", theirs?.querySelector("button")?.textContent === "Download");
  theirs.querySelector("button").click();
  for (let i = 0; i < 300 && state.incomingFiles.get(transfer)?.status !== "done" && state.incomingFiles.get(transfer)?.status !== "failed"; i++) await wait(100);
  const inc = state.incomingFiles.get(transfer);
  check("transfer finished", inc?.status === "done", inc?.status + " " + (inc?.error ?? ""));
  const got = new Uint8Array(downloaded.parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of downloaded.parts) {
    got.set(p, at);
    at += p.length;
  }
  check("every byte arrived", got.length === bytes.length && got.every((b, i) => b === bytes[i]));
  check("receiver can show it in the folder", document.body.textContent.includes("Saved to Downloads") && document.body.textContent.includes("Show in folder"));
  await wait(800);
  check("sender sees it sent", state.outgoingFiles.get(transfer)?.status === "sent");

  // Programs come with a warning first.
  emit("account", { type: "dm", with: KEYS.elin, message: { id: "f2", from_key: KEYS.elin, sealed: `plain:hopp-file:${"ab".repeat(16)} 1000 setup.exe`, sent_at: Date.now() } });
  await wait(200);
  const exe = [...document.querySelectorAll(".dm-messages .file-card")].find((c) => c.dataset.transfer === "ab".repeat(16));
  check("programs are marked", exe?.querySelector(".file-icon.risky") && exe.textContent.includes("only open it if you trust"));
  exe.querySelector("button").click();
  await wait(100);
  check("a warning comes before downloading a program", $("confirm-dialog").open && $("confirm-title").textContent === "This is a program");
  $("confirm-dialog").close();

  // A file the sender no longer has.
  emit("account", { type: "dm", with: KEYS.elin, message: { id: "f3", from_key: KEYS.elin, sealed: `plain:hopp-file:${"cd".repeat(16)} 1000 old.txt`, sent_at: Date.now() } });
  await wait(200);
  [...document.querySelectorAll(".dm-messages .file-card")].find((c) => c.dataset.transfer === "cd".repeat(16)).querySelector("button").click();
  await wait(500);
  check("a file that's gone says so", state.incomingFiles.get("cd".repeat(16))?.error?.includes("isn't available anymore"));
  check("preview names the file", previewText(`hopp-file:${transfer} 300000 notes.zip`) === "📎 notes.zip");
  report();
})();
