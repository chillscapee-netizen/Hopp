// real-time: 20000
// Adjusting a picture: what's inside the frame is saved, a circle as a square, a banner as a strip.
(async () => {
  await inServer();
  const c = document.createElement("canvas");
  c.width = 1200;
  c.height = 800;
  c.getContext("2d").fillRect(0, 0, 1200, 800);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  const file = new File([blob], "x.png", { type: "image/png" });
  const size = (url) => new Promise((r) => { const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.src = url; });
  let p = adjustPicture(file, { shape: "circle", title: "t", sizes: [[128, 0.85]], limit: 80000 });
  await wait(300);
  check("a dialog to adjust it opens", $("crop-dialog").open);
  $("crop-zoom").value = "2";
  $("crop-zoom").dispatchEvent(new Event("input"));
  $("crop-form").dispatchEvent(new Event("submit", { cancelable: true }));
  const pic = await p;
  check("a picture comes out square", JSON.stringify(await size(pic)) === "[128,128]", pic?.slice(0, 30));
  p = adjustPicture(file, { shape: "banner", title: "t", sizes: [[600, 0.8]], limit: 80000 });
  await wait(300);
  $("crop-form").dispatchEvent(new Event("submit", { cancelable: true }));
  check("a banner comes out as a strip", JSON.stringify(await size(await p)) === "[600,210]");
  p = adjustPicture(file, { shape: "circle", title: "t", sizes: [[128, 0.85]], limit: 80000 });
  await wait(300);
  $("crop-cancel").click();
  check("cancel keeps what you had", (await p) === null && !$("crop-dialog").open);
  report();
})();
