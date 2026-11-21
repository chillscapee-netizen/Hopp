// real-time: 90000
// Files over several lanes: a bigger file arrives whole and in order even though its pieces come
// over four channels at once; and an older app that asks for no lanes gets one, as before.

(async () => {
  try {
    await inServer();
    prefs.hideIp = false;
    openDm(KEYS.elin);
    await wait(300);
    const send = async (size, name, askLanes) => {
      const bytes = new Uint8Array(size).map((_, i) => (i * 13 + (i >> 9)) & 255);
      const file = new File([bytes], name);
      sent.length = 0;
      offerFile(KEYS.elin, file);
      await wait(200);
      const transfer = sent.find((m) => m.type === "dm_send")?.sealed.match(/hopp-file:([0-9a-f]{32})/)?.[1];
      emit("account", { type: "dm", with: KEYS.elin, message: { id: "x" + transfer, from_key: KEYS.elin, sealed: `plain:hopp-file:${transfer} ${size} ${name}`, sent_at: Date.now() } });
      await wait(200);
      downloaded.parts.length = 0;
      // An older app's request: no lanes asked for.
      if (!askLanes) {
        const real = commands.account_send;
        commands.account_send = (a) => {
          if (a.msg?.type === "file_signal" && a.msg.sealed?.startsWith("plain:")) {
            const sig = JSON.parse(a.msg.sealed.slice(6));
            if (sig.kind === "request") {
              delete sig.lanes;
              a = { msg: { ...a.msg, sealed: "plain:" + JSON.stringify(sig) } };
            }
          }
          return real(a);
        };
        setTimeout(() => (commands.account_send = real), 3000);
      }
      const card = [...document.querySelectorAll(".dm-messages .file-card")].find((c) => c.message.from_key === KEYS.elin && c.dataset.transfer === transfer);
      card.querySelector("button").click();
      for (let i = 0; i < 600 && !["done", "failed"].includes(state.incomingFiles.get(transfer)?.status); i++) await wait(100);
      const inc = state.incomingFiles.get(transfer);
      const got = new Uint8Array(downloaded.parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of downloaded.parts) {
        got.set(p, at);
        at += p.length;
      }
      return { inc, ok: got.length === bytes.length && got.every((b, i) => b === bytes[i]), lanes: state.outgoingFiles.get(transfer)?.lanes };
    };
    const big = await send(6 * 1024 * 1024 + 12345, "big.bin", true);
    check("a 6 MB file over four lanes arrives", big.inc?.status === "done" && big.lanes === 4, big.inc?.status + " " + big.lanes + " " + (big.inc?.error ?? ""));
    check("whole and in order", big.ok);
    const old = await send(700_000, "old.bin", false);
    check("an older app gets one lane, as before", old.inc?.status === "done" && old.lanes === 1 && old.ok, old.inc?.status + " " + old.lanes);
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
