// The window behind the page takes the app's colour (no black while it grows), and follows the theme.
(async () => {
  const sent = [];
  commands.window_color = ({ rgb }) => sent.push(rgb);
  await inServer();
  windowColor = "";
  syncWindowColor();
  await wait(50);
  check("the window gets the app's colour", /^#[0-9a-f]{6}$/.test(sent.at(-1) ?? ""), sent.join(","));
  setTheme("light");
  await wait(50);
  const light = sent.at(-1);
  check("a light theme gives a light window", parseInt(light.slice(1, 3), 16) > 200, light);
  setTheme("mid");
  report();
})();
