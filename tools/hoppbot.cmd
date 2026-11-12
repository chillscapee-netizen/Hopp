@echo off
rem Hoppbot: a second Hopp account on this computer that repeats what you say, to try voice.
rem
rem   hoppbot.cmd                     starts it (add "hoppbot" as a friend in Hopp, then call it)
rem   hoppbot.cmd --add yourname      also sends you a friend request
rem   hoppbot.cmd --net italy         starts it as if it were in Italy
rem
rem While it runs, write to it in a DM: "net italy", "net us", "net asia", "net wifi",
rem "net mobile", "net nordic", "net off", or "net 120 20 3" (round trip ms, jitter ms, loss %).
rem Close this window to stop it.
cd /d "%~dp0.."
cargo run --release -p strom-voice --example testbot -- %*
pause
