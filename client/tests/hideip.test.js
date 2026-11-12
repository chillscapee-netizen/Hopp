// Hide my IP address: a switch in Privacy & safety; voice is told, and video, screens and
// files then connect through the relay only.
(async () => {
  await inServer();
  const told = [];
  commands.set_private_route = ({ on }) => told.push(on);
  openSettings("privacy");
  await wait(80);
  const box = $("hide-ip");
  check("the switch is there, off at first", !!box && !box.checked && box.closest(".row").textContent.includes("Hide my IP address"));
  box.click();
  await wait(30);
  check("turning it on tells voice", told.at(-1) === true && prefs.hideIp);
  const config = await rtcConfig();
  check("video, screens and files then use the relay only", config.iceTransportPolicy === "relay", JSON.stringify(config));
  box.click();
  await wait(30);
  const open = await rtcConfig();
  check("off again: voice is told, and connections may go direct", told.at(-1) === false && !open.iceTransportPolicy);
  $("settings").close();
  report();
})();
