// Hide my IP address: on by default (a switch in Privacy & safety). Voice is told, and video,
// screens and files connect through the relay only; turned off, they may go straight across.
(async () => {
  await inServer();
  const told = [];
  commands.set_private_route = ({ on }) => told.push(on);
  openSettings("privacy");
  await wait(80);
  const box = $("hide-ip");
  check("the switch is there, on at first", !!box && box.checked && prefs.hideIp && box.closest(".row").textContent.includes("Hide my IP address"));
  const hidden = await rtcConfig();
  check("so video, screens and files use the relay only", hidden.iceTransportPolicy === "relay", JSON.stringify(hidden));
  box.click();
  await wait(30);
  const open = await rtcConfig();
  check("turned off: voice is told, and connections may go direct", told.at(-1) === false && !prefs.hideIp && !open.iceTransportPolicy);
  box.click();
  await wait(30);
  check("on again: voice is told", told.at(-1) === true && prefs.hideIp);
  $("settings").close();
  report();
})();
