// Log in with email: an optional email when making an account saves it to Hopp Cloud; "Log in
// with email" on the first screen brings it to a new computer; Settings can set it up (and
// remove it) for an account made before; a new password saves it again.

(async () => {
  try {
    await inServer();
    const calls = [];
    let saved = null;
    commands.cloud_backup_status = () => saved;
    commands.cloud_backup_save = (a) => {
      calls.push({ type: "save", ...a });
      saved = a.email;
    };
    commands.cloud_backup_remove = () => {
      calls.push({ type: "remove" });
      saved = null;
    };
    commands.cloud_backup_login = (a) => {
      calls.push({ type: "login", ...a });
      if (a.password !== "right password") throw "Wrong email or password.";
      return "Marcus";
    };

    // Settings → Password & security: set up, then shown as saved, then removed.
    openSettings("security");
    await wait(80);
    check("settings offer it", $("cloud-backup-btn").textContent === "Set up" && !$("cloud-backup-sub").textContent.includes("@"));
    $("cloud-backup-btn").click();
    $("cb-email").value = "me@example.com";
    $("cb-password").value = "my password";
    $("cloud-backup-form").requestSubmit();
    await wait(80);
    check("saving sends the email and password", calls.some((c) => c.type === "save" && c.email === "me@example.com" && c.password === "my password" && c.cloud.startsWith("http")));
    check("then it says where it's saved", $("cloud-backup-sub").textContent.includes("me@example.com") && $("cloud-backup-btn").textContent === "Remove");

    // A new password: saved again with it.
    calls.length = 0;
    $("change-password-btn").click();
    $("cp-current").value = "my password";
    $("cp-new").value = "a new password";
    if ($("cp-confirm")) $("cp-confirm").value = "a new password";
    commands.change_password = () => {};
    $("change-password-form").requestSubmit();
    await wait(120);
    check("a new password saves it again", calls.some((c) => c.type === "save" && c.password === "a new password"), JSON.stringify(calls));

    $("cloud-backup-btn").click();
    await wait(60);
    document.querySelector("#confirm-dialog [value=ok], #confirm-ok")?.click();
    await wait(80);
    check("removing it", calls.some((c) => c.type === "remove") && $("cloud-backup-btn").textContent === "Set up");
    $("settings").close();

    // The first screen: both ways back in, seen without scrolling.
    showAuth("create");
    await wait(60);
    const ways = [...document.querySelectorAll("#create-form .auth-top-switch button")].map((b) => b.textContent);
    check("first screen: log in with email and restore with the phrase, at the top", ways.includes("Log in with email") && ways.some((w) => w.includes("recovery phrase")));
    document.querySelector('#create-form [data-auth="email"]').click();
    await wait(60);
    check("email login opens", !$("email-login-form").hidden);
    $("email-login-email").value = "me@example.com";
    $("email-login-password").value = "wrong";
    $("email-login-form").requestSubmit();
    await wait(80);
    check("a wrong password says so", !$("email-login-error").hidden && $("email-login-error").textContent.includes("Wrong"));
    $("email-login-password").value = "right password";
    $("email-login-form").requestSubmit();
    await wait(200);
    check("the right one logs in", calls.some((c) => c.type === "login" && c.password === "right password" && c.email === "me@example.com"));
  } catch (e) {
    check("no crash: " + e.message + " " + String(e.stack).slice(0, 200), false);
  }
  report();
})();
