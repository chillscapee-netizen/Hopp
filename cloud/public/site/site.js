// The site. What's new comes from the same file the app uses, so it is current after every
// release; the drawings of the app come alive a little.

const key = (v) => v.split(".").map((n) => n.padStart(5, "0")).join(".");
const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// ---------- what's new ----------
(async () => {
  let notes = {};
  try {
    notes = await (await fetch("whats-new.json")).json();
  } catch {
    return;
  }
  const versions = Object.keys(notes).sort((a, b) => key(b).localeCompare(key(a)));
  // The version on offer comes from the release itself, whether or not it has notes.
  try {
    const latest = (await (await fetch("update/latest.json")).json()).version;
    if (latest) for (const n of document.querySelectorAll(".version-line")) n.textContent = "Free · beta " + latest;
  } catch {
    // The plain "Free" stays.
  }
  if (!versions.length) {
    // Nothing to tell yet: the home page leaves the section out; the page of its own says so.
    for (const box of document.querySelectorAll(".releases")) {
      if (box.dataset.show === "all") box.append(el("p", "none", "Nothing here yet. Hopp is still finding its feet; when there's news worth telling, it shows up here."));
      else box.closest(".news")?.remove();
    }
    return;
  }
  for (const box of document.querySelectorAll(".releases")) {
    const show = box.dataset.show === "all" ? versions.length : Number(box.dataset.show || 3);
    versions.slice(0, show).forEach((v, i) => {
      const item = el("article", "release");
      const h = el("h3", "", "Version " + v);
      if (i === 0) h.append(el("span", "", "Newest"));
      const list = el("ul");
      for (const line of notes[v].split("\n")) {
        const text = line.replace(/^\s*•\s*/, "").trim();
        if (text) list.append(el("li", "", text));
      }
      item.append(h, list);
      box.append(item);
    });
  }
})();

// ---------- the drawings come alive ----------

/** Someone talks, then someone else: their tile and their place in the list light up. */
function talking(scope) {
  const count = scope ? new Set([...scope.querySelectorAll("[data-who]")].map((n) => n.dataset.who)).size : 0;
  if (!count) return;
  let who = 0;
  const show = () => {
    for (const n of scope.querySelectorAll("[data-who]")) n.classList.toggle("talk", Number(n.dataset.who) === who);
  };
  show();
  if (calm || count < 2) return;
  setInterval(() => {
    who = (who + 1 + Math.floor(Math.random() * (count - 1))) % count;
    show();
  }, 1800);
}
talking(document.querySelector(".app"));
for (const pic of document.querySelectorAll(".pic.voice")) talking(pic);

/** New messages arrive now and then in the drawn chat, after a moment of typing. */
const msgs = document.getElementById("msgs");
const typing = document.querySelector(".typing");
const pick = (list) => list[Math.floor(Math.random() * list.length)];
if (!calm && msgs && typing) {
  setInterval(() => {
    typing.classList.add("on");
    setTimeout(() => {
      typing.classList.remove("on");
      const m = el("div", "msg");
      const lines = el("span");
      lines.append(el("span", "bar n " + pick(["w25", "w30", "w35"])));
      lines.append(el("span", "bar " + pick(["w45", "w60", "w75", "w85", "w55"])));
      if (Math.random() < 0.4) lines.append(el("span", "bar " + pick(["w45", "w60", "w75"])));
      m.append(el("i", pick(["p1", "p2", "p3", "p4"])), lines);
      msgs.append(m);
      while (msgs.children.length > 6) msgs.firstElementChild.remove();
    }, 1500);
  }, 5200);
}

// ---------- the pictures on the home page: flip through them ----------
(() => {
  const shot = document.querySelector(".shot");
  if (!shot) return;
  const slides = [...shot.querySelectorAll(".shot-slides img")];
  const dots = [...shot.querySelectorAll(".shot-dots button")];
  const captions = ["Your friends, and who's around", "A server's chat, with reactions and a thread", "Add a friend by their username"];
  let at = 0;
  const show = (i) => {
    at = (i + slides.length) % slides.length;
    slides.forEach((s, j) => s.classList.toggle("on", j === at));
    dots.forEach((d, j) => d.classList.toggle("on", j === at));
    shot.querySelector(".shot-caption").textContent = captions[at];
  };
  shot.querySelectorAll(".shot-arrow").forEach((b) => b.addEventListener("click", () => show(at + Number(b.dataset.step))));
  dots.forEach((d, j) => d.addEventListener("click", () => show(j)));
  // Arrow keys while the pictures are in focus, and a swipe on a phone.
  shot.tabIndex = 0;
  shot.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") show(at - 1);
    else if (e.key === "ArrowRight") show(at + 1);
  });
  let startX = null;
  shot.addEventListener("touchstart", (e) => (startX = e.touches[0].clientX), { passive: true });
  shot.addEventListener("touchend", (e) => {
    if (startX === null) return;
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 40) show(at + (dx < 0 ? 1 : -1));
    startX = null;
  });
})();
