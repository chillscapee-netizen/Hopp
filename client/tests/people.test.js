// People: two computers for one person, two people with one name.

(async () => {
  await inServer();
  // Elin is also on her laptop.
  const r = structuredClone(state.roster);
  r.users.push({ session_id: 9, name: "Elin", voice_channel: null, muted: false, deafened: false, owner: false, public_key: KEYS.elin });
  // And another Elin, a different person.
  r.users.push({ session_id: 10, name: "Elin", voice_channel: null, muted: false, deafened: false, owner: false, public_key: KEYS.kim });
  emit("roster", r);
  await wait(150);
  const rows = [...document.querySelectorAll("#member-list .member")].filter((li) => li.textContent.includes("Elin"));
  check("one person on two computers shows once; a namesake shows separately", rows.length === 2);

  // Messages from the two Elins in a row aren't grouped as one person.
  emit("chat", { id: 3001, channel: 0, sender: 2, sender_name: "Elin", author_key: KEYS.elin, text: "first Elin", sent_at: Date.now() });
  emit("chat", { id: 3002, channel: 0, sender: 10, sender_name: "Elin", author_key: KEYS.kim, text: "second Elin", sent_at: Date.now() });
  await wait(150);
  check("namesakes aren't grouped together", document.querySelector('.msg[data-id="3002"]').classList.contains("first"));

  // Each has their own volume.
  cardUser = r.users.find((u) => u.session_id === 10);
  setUserVolume(40);
  check("volume is per person, not per name", userVolume(r.users.find((u) => u.session_id === 10)) === 40 && userVolume(r.users.find((u) => u.session_id === 2)) === undefined);

  // A space on a focused button presses it instead of typing.
  const button = document.querySelector("#members-toggle");
  button.focus();
  document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
  check("space on a button doesn't jump into the message box", document.activeElement === button);
  report();
})();
