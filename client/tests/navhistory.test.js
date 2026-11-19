// Back and forward: the arrows above Hopp's logo (and Alt + arrows) walk through the places
// you've been, like a browser; going somewhere new after going back drops what was ahead.

(async () => {
  try {
    await inServer();
    await wait(100);
    const back = () => $("nav-back").click();
    const forward = () => $("nav-forward").click();
    const where = () => (state.atNews ? "news" : state.openDm ? "dm" : state.atHome || !state.activeId ? "home" : "ch" + state.view);

    openTextChannel(0);
    await wait(50);
    openTextChannel(3);
    await wait(50);
    openTextChannel(4);
    await wait(50);
    check("on lfg", where() === "ch4", where());
    check("back is there, forward isn't yet", !$("nav-back").disabled && $("nav-forward").disabled);

    back();
    await wait(80);
    check("back: the channel before", where() === "ch3", where());
    back();
    await wait(80);
    check("back again: the one before that", where() === "ch0", where());
    forward();
    await wait(80);
    check("forward: where you came back from", where() === "ch3", where());

    // Home, and back to the server where you were.
    $("home-btn").click();
    await wait(80);
    check("Home", where() === "home", where());
    check("going somewhere new leaves nothing ahead", $("nav-forward").disabled);
    back();
    await wait(120);
    check("back from Home: the server's channel you were on", where() === "ch3", where());

    // A conversation, then Discover; Alt + ← steps back through them.
    openDm(KEYS.elin);
    await wait(80);
    openDiscover();
    await wait(80);
    check("Discover", where() === "news", where());
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true }));
    await wait(80);
    check("Alt + ← back to the conversation", where() === "dm" && state.openDm === KEYS.elin, where());
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true }));
    await wait(80);
    check("Alt + → forward to Discover", where() === "news", where());

    // Another server, and back to the first one's channel.
    $("home-btn").click();
    await wait(50);
    back();
    await wait(50);
    back();
    await wait(50);
    back();
    await wait(150);
    check("back on the first server", state.activeId === "a" && where() === "ch3", state.activeId + " " + where());
    document.querySelectorAll("#server-list .rail-item")[1].click();
    for (let i = 0; i < 30 && state.activeId !== "b"; i++) await wait(100);
    check("on the other server", state.activeId === "b", String(state.activeId));
    back();
    for (let i = 0; i < 30 && state.activeId !== "a"; i++) await wait(100);
    await wait(100);
    check("back: the first server, on the channel you were on", state.activeId === "a" && where() === "ch3", state.activeId + " " + where());

    // The logo isn't ringed when Home is open (it was cut off at the top).
    $("home-btn").click();
    await wait(80);
    const icon = document.querySelector("#home-btn .rail-icon");
    check("Home's logo has no ring around it", getComputedStyle(icon).boxShadow === "none", getComputedStyle(icon).boxShadow);
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
