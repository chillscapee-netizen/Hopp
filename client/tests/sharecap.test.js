// Your address is hidden unless you choose otherwise, and shared screens stay at the size you
// picked; only when most of the month's free relay is used do they go to 720p, until next month.

(async () => {
  await inServer();
  check("your address is hidden by default", prefs.hideIp === true && $("hide-ip").checked);
  prefs.shareQuality = { size: "1080", rate: 60 };
  check("screens are shared at the size you picked", shareSizeId() === "1080" && shareSize().h === 1080);
  onRelayLogin({ type: "turn_login", login: { username: "u", credential: "c", urls: [] }, tight: false });
  check("plenty of relay left: still full size", shareSizeId() === "1080");
  onRelayLogin({ type: "turn_login", login: { username: "u", credential: "c", urls: [] }, tight: true });
  check("relay nearly used up: 720p for now", shareSizeId() === "720" && shareBitrate() === 4_000_000, shareSizeId() + " " + shareBitrate());
  prefs.hideIp = false;
  check("sharing straight to the others (address shown, by your choice): full size again", shareSizeId() === "1080");
  prefs.hideIp = true;
  onRelayLogin({ type: "turn_login", login: { username: "u", credential: "c", urls: [] }, tight: false });
  check("next month: back to full size", shareSizeId() === "1080");
  report();
})();
