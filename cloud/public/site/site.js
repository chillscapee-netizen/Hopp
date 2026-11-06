// The newest version and what's new come from the same file the app uses, so the page is
// current after every release.

const key = (v) => v.split(".").map((n) => n.padStart(5, "0")).join(".");

function el(tag, text) {
  const n = document.createElement(tag);
  if (text !== undefined) n.textContent = text;
  return n;
}

(async () => {
  let notes = {};
  try {
    notes = await (await fetch("/whats-new.json")).json();
  } catch {
    return;
  }
  const versions = Object.keys(notes).sort((a, b) => key(b).localeCompare(key(a)));
  if (!versions.length) return;
  document.getElementById("version").textContent = "Version " + versions[0];
  const box = document.getElementById("releases");
  const release = (v, i) => {
    const item = el("article");
    item.className = "release";
    const h = el("h3", "Version " + v);
    if (i === 0) h.append(el("span", "newest"));
    const list = el("ul");
    for (const line of notes[v].split("\n")) {
      const text = line.replace(/^\s*•\s*/, "").trim();
      if (text) list.append(el("li", text));
    }
    item.append(h, list);
    return item;
  };
  versions.slice(0, 3).forEach((v, i) => box.append(release(v, i)));
  if (versions.length > 3) {
    const more = el("button", "Every version");
    more.className = "more";
    more.type = "button";
    more.addEventListener("click", () => {
      versions.slice(3).forEach((v, i) => box.append(release(v, i + 3)));
      more.remove();
    });
    box.after(more);
  }
})();
