// Lowering other apps while people talk: asked of the backend when someone else starts
// talking, put back after a short calm; never for your own voice, not while deafened or off.

(async () => {
  await inServer();
  const asked = [];
  commands.set_attenuation = (a) => asked.push(a.on ? "lower " + a.level : "restore");
  const me = state.roster.me;
  const elin = state.roster.users.find((u) => u.name === "Elin").session_id;
  const talk = (id, on) => emit("voice", { type: "speaking", session_id: id, speaking: on });

  talk(elin, true);
  await wait(30);
  check("off by default: nothing is lowered", asked.length === 0);

  openSettings("voice");
  $("attenuate").checked = true;
  $("attenuate").dispatchEvent(new Event("change"));
  await wait(30);
  check("turned on while Elin talks: others go down", asked.at(-1) === "lower 0.4", asked.join(", "));
  check("the level shows", !$("attenuate-level-row").hidden && $("attenuate-level-value").textContent === "40%");
  talk(elin, false);
  await wait(200);
  check("not back straight away (a pause between words)", asked.at(-1) === "lower 0.4");
  talk(elin, true);
  await wait(30);
  check("talking again keeps it down without asking twice", asked.filter((a) => a.startsWith("lower")).length === 1);
  talk(elin, false);
  await wait(900);
  check("after a calm moment, back to normal", asked.at(-1) === "restore", asked.join(", "));

  asked.length = 0;
  talk(me, true);
  await wait(30);
  check("your own voice doesn't lower anything", asked.length === 0);
  talk(me, false);
  report();
})();
