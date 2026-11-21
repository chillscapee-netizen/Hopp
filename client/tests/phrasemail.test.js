// Settings → Password & security: "Email to myself" right on the recovery phrase's row. It asks
// for your password, then your email app opens with the phrase in a message to yourself.

(async () => {
  try {
    await inServer();
    const phrase = Array.from({ length: 24 }, (_, i) => "word" + i).join(" ");
    commands.show_recovery_phrase = () => phrase;
    const opened = [];
    commands["plugin:opener|open_url"] = (a) => opened.push(a.url);
    openSettings("security");
    await wait(80);
    check("the buttons are on the row", !!$("phrase-mail-btn") && !!$("phrase-onedrive-btn"));
    $("phrase-mail-btn").click();
    await wait(80);
    check("it asks for your password first", $("backup-dialog").open && !document.querySelector('#backup-dialog [data-bstep="verify"]').hidden);
    $("backup-password").value = "my password";
    $("backup-verify").requestSubmit();
    await wait(150);
    const url = opened.find((u) => u.startsWith("mailto:"));
    check("then the email opens with the phrase", !!url && decodeURIComponent(url).includes("1. word0") && decodeURIComponent(url).includes("24. word23"), url?.slice(0, 80));
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
