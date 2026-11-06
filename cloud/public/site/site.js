// The home page: the newest version and what's new come from the same files the app uses,
// so the page is current after every release without anyone touching it.

const key = (v) => v.split(".").map((n) => n.padStart(5, "0")).join(".");

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

async function news() {
  let notes = {};
  try {
    notes = await (await fetch("/whats-new.json")).json();
  } catch {
    return;
  }
  const versions = Object.keys(notes).sort((a, b) => key(b).localeCompare(key(a)));
  if (!versions.length) return;
  document.getElementById("version").textContent = "Hopp " + versions[0];
  const box = document.getElementById("releases");
  const release = (v, i) => {
    const item = el("article", "release reveal in" + (i === 0 ? " latest" : ""));
    const h = el("h3", "", "Version " + v);
    if (i === 0) h.append(el("span", "tag", "Latest"));
    const list = el("ul");
    for (const line of notes[v].split("\n")) {
      const text = line.replace(/^\s*•\s*/, "").trim();
      if (text) list.append(el("li", "", text));
    }
    item.append(h, list);
    return item;
  };
  versions.slice(0, 3).forEach((v, i) => box.append(release(v, i)));
  if (versions.length > 3) {
    const more = el("button", "more", "Show every version");
    more.type = "button";
    more.addEventListener("click", () => {
      versions.slice(3).forEach((v, i) => box.append(release(v, i + 3)));
      more.remove();
    });
    box.after(more);
  }
}
news();

// Sections fade up as they come into view.
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) {
      e.target.classList.add("in");
      io.unobserve(e.target);
    }
  }
}, { threshold: 0.15 });
for (const n of document.querySelectorAll(".feature, .grid article, .value, .honest, .final")) {
  n.classList.add("reveal");
  io.observe(n);
}
