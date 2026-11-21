// Layouts: Taskbar puts you with mic and headphones on the left and Add, Discover and settings on
// the right of a bar along the bottom; Classic puts everything back; drawing it again changes nothing.

(async () => {
  try {
    await inServer();
    prefs.layout = "taskbar";
    applyTheme();
    applyTheme();
    applyTheme();
    await wait(50);
    check("taskbar: you stay above the bar with your mic and headphones, Hopp starts the bar", !!document.querySelector(".user-panel #me-card") && !!document.querySelector(".user-panel .panel-controls") && !document.querySelector(".tb-left") && $("home-btn").getBoundingClientRect().left < 40);
    check("Add, Discover and settings on the right", !!document.querySelector(".tb-right #add-server") && !!document.querySelector(".tb-right #news-btn") && !!document.querySelector(".tb-right .open-settings"));
    check("drawn again, nothing doubles", document.querySelectorAll(".tb-right").length === 1 && document.querySelectorAll("#me-card").length === 1);
    // Along the bottom, dragging goes sideways: dropped past the last server, it ends up last.
    renderRail();
    await wait(30);
    const first = document.querySelector("#server-list [data-server]");
    const last = [...document.querySelectorAll("#server-list [data-server]")].pop();
    const lb = last.getBoundingClientRect();
    const hit = dropTarget(lb.right - 2, { id: first.dataset.server });
    check("dragging measures across, not down", hit.kind === "after" && hit.node === last, JSON.stringify({ kind: hit.kind }));
    // Many servers: the ones that fit, then "+N" with the rest in a panel; nothing cut off.
    const base = prefs.servers[0];
    const extra = Array.from({ length: 40 }, (_, i) => ({ ...base, id: "many" + i, label: "S" + i, name: "S" + i }));
    prefs.servers.push(...extra);
    prefs.rail.push(...extra.map((x) => ({ id: x.id })));
    renderRail();
    await wait(30);
    const list = $("server-list");
    const shown = list.querySelectorAll("[data-server]").length;
    const inPanel = $("rail-more-pop")?.querySelectorAll("[data-server]").length ?? 0;
    check("many servers: a +N button at the end", !!$("rail-more") && $("rail-more").textContent === `+${inPanel}`);
    check("nothing on the bar is cut off", list.scrollWidth <= list.clientWidth + 1, `${list.scrollWidth} vs ${list.clientWidth}`);
    check("every server is either on the bar or in the panel", shown + inPanel === prefs.rail.filter((x) => x.id).length, `${shown} + ${inPanel}`);
    $("rail-more").click();
    await wait(30);
    check("+N opens the rest above the bar", !$("rail-more-pop").hidden && $("rail-more-pop").getBoundingClientRect().bottom <= $("rail-more").getBoundingClientRect().top);
    closePopovers();
    prefs.layout = "classic";
    applyTheme();
    await wait(50);
    check("classic: everything back under the channels", !!document.querySelector(".user-panel #me-card") && !!document.querySelector(".user-panel .panel-controls") && !document.querySelector(".tb-right") && !!document.querySelector(".user-panel .panel-controls .open-settings"));
    check("classic: no +N, every server back in the list", !$("rail-more") && $("server-list").querySelectorAll("[data-server]").length === prefs.rail.filter((x) => x.id).length);
    check("Add and Discover back in the server list",$("add-server").parentElement.classList.contains("rail") && $("news-btn").parentElement.classList.contains("rail"));
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
