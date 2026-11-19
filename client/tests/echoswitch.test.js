// Echo removal follows the output: off for headphones, on again for speakers, also when you
// pick the output yourself (not only when Windows changes its devices).

(async () => {
  await inServer();
  const echo = [];
  const set = commands.set_echo_cancellation;
  commands.set_echo_cancellation = (a) => echo.push(a.on);
  commands.list_devices = () => ({ inputs: ["Mic"], outputs: ["Headphones (Arctis)", "Speakers (Realtek)"], default_input: "Mic", default_output: "Speakers (Realtek)" });
  prefs.echo = true;
  state.deviceList = commands.list_devices();

  prefs.outputDevice = "Headphones (Arctis)";
  await applyDevices();
  check("headphones: echo removal off", echo.at(-1) === false, JSON.stringify(echo));
  prefs.outputDevice = "Speakers (Realtek)";
  await applyDevices();
  check("picked speakers: echo removal on again", echo.at(-1) === true, JSON.stringify(echo));
  commands.set_echo_cancellation = set;
  report();
})();
