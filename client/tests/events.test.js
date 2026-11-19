// Events: planned from the + menu, posted as a card; Going and Maybe answer; a reminder rings when
// it starts; a card shows Loading (not "gone") before the server has said which events there are.

(async () => {
  try {
  await inServer();
  const r = structuredClone(state.roster);
  r.features = [...(r.features ?? []), "events", "polls"];
  const sent = [];
  let events = [];
  const tell = () => setTimeout(() => emit("events", structuredClone(events)), 5);
  commands.get_events = () => tell();
  commands.create_event = (a) => {
    sent.push({ type: "create_event", ...a });
    const ev = { id: 7, name: a.name, description: a.description, channel: a.channel, starts_at: a.startsAt, creator: ME, creator_name: "Marcus", going: [ME], maybe: [] };
    events = [ev];
    setTimeout(() => emit("event-created", 7), 5);
    tell();
  };
  commands.rsvp = (a) => {
    sent.push({ type: "rsvp", ...a });
    const ev = events[0];
    ev.going = ev.going.filter((k) => k !== ME);
    ev.maybe = ev.maybe.filter((k) => k !== ME);
    if (a.answer === "yes") ev.going.push(ME);
    if (a.answer === "maybe") ev.maybe.push(ME);
    tell();
  };

  // A card before the events have come: Loading, not gone.
  state.eventsLoaded = false;
  emit("chat", { id: 9601, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "hopp-event:99", sent_at: Date.now() });
  await wait(60);
  check("before the events are known, a card says Loading", /Loading the event/.test(document.querySelector('.msg[data-id="9601"] .event-card')?.textContent ?? ""));

  emit("roster", r);
  await wait(80);
  check("the server's events are asked for once connected", eventsAsked === state.activeId);
  await wait(50);
  check("an unknown event then reads as over", /over or was cancelled/.test(document.querySelector('.msg[data-id="9601"] .event-card')?.textContent ?? ""));

  // Planning one.
  $("attach-btn").click();
  await wait(30);
  const plan = [...$("server-menu").querySelectorAll(".menu-item")].find((b) => b.textContent.trim() === "Plan an event");
  check("the + menu offers Plan an event", !!plan);
  plan.click();
  await wait(30);
  check("the dialog opens", $("event-dialog").open);
  $("event-name").value = "Game night";
  const at = new Date(Date.now() + 3_600_000);
  const pad = (n) => String(n).padStart(2, "0");
  $("event-time").value = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
  $("event-form").requestSubmit();
  await wait(150);
  check("it's planned with its name and time", sent.some((m) => m.type === "create_event" && m.name === "Game night" && Math.abs(m.startsAt - at.getTime()) < 60_000));
  const card = () => [...document.querySelectorAll("#messages .event-card[data-event='7']")].at(-1);
  check("its card is posted in the channel", !!card() && /Game night/.test(card().textContent) && /1 going/.test(card().textContent));

  // Going, then Maybe; a reminder is kept for it.
  card().querySelector(".event-answer.active")?.click();
  await wait(60);
  check("Going again takes it back", sent.some((m) => m.type === "rsvp" && m.answer === null) && /0 going/.test(card().textContent));
  [...card().querySelectorAll(".event-answer")].find((b) => b.textContent === "Maybe").click();
  await wait(60);
  check("Maybe answers maybe", /1 maybe/.test(card().textContent));
  const reminders = loadJson("eventReminders", {});
  check("a reminder is kept for it", Object.values(reminders).some((x) => x.name === "Game night"));

  // It starts: a sound and a notification.
  const sounds = [];
  const play = playSound;
  window.playSound = (name, why) => sounds.push(why);
  const key = Object.keys(reminders).find((k) => reminders[k].name === "Game night");
  remindEvent(key, reminders[key]);
  window.playSound = play;
  check("when it starts, it rings", sounds.some((w) => /Game night is starting/.test(w)));
  check("only once", !loadJson("eventReminders", {})[key]);
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
