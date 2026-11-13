//   node cloud/scripts/build-site.mjs
// Builds the Hopp site's pages from one shared frame (nav and footer), so every page matches.
import { readFileSync, writeFileSync } from "node:fs";

import { fileURLToPath } from "node:url";
const out = fileURLToPath(new URL("../public/", import.meta.url));
const parts = fileURLToPath(new URL("../site/", import.meta.url));
const DL = "download/Hopp-setup.exe";
const ARROW = `<svg viewBox="0 0 24 24"><path d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19.5h14"/></svg>`;
const PAGES = [["features", "Features"], ["limits", "Limits"], ["hopp-id", "Hopp ID"], ["about", "About"], ["privacy", "Privacy"], ["help", "Help"], ["whats-new", "What's new"]];

function page(file, current, title, description, body) {
  const nav = PAGES.map(([f, label]) => `<a href="${f}.html"${f === current ? ' class="here"' : ""}>${label}</a>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta name="theme-color" content="#0e0e10">
<link rel="icon" href="site/logo.svg">
<link rel="stylesheet" href="site/site.css">
<link rel="stylesheet" href="site/pages.css">
</head>
<body>
<div class="sky"></div>
<header class="nav">
  <a class="brand" href="index.html"><img src="site/logo.svg" alt=""><span>Hopp</span><span class="beta">Beta</span></a>
  <nav>${nav}</nav>
  <a class="btn small" href="${DL}">Download</a>
</header>
<main>
${body}
</main>
<footer class="foot">
  <div class="foot-brand"><a class="brand" href="index.html"><img src="site/logo.svg" alt=""><span>Hopp</span></a><p>Voice, video and chat for you and your friends. Free, with no ads and no tracking.</p></div>
  <div><h4>Hopp</h4><a href="features.html">Features</a><a href="whats-new.html">What's new</a><a href="${DL}">Download for Windows</a></div>
  <div><h4>Learn more</h4><a href="about.html">About Hopp</a><a href="limits.html">Limits</a><a href="hopp-id.html">Your Hopp ID</a><a href="privacy.html">Privacy &amp; safety</a><a href="help.html">Help</a><a href="code-signing.html">Code signing</a></div>
</footer>
<script src="site/site.js"></script>
</body>
</html>
`;
}

const head = (kicker, h1, lead) => `<section class="page-head"><span class="kicker">${kicker}</span><h1>${h1}</h1><p class="lead">${lead}</p></section>`;

// ---------- the drawn app (no names, no words) ----------
const APP = readFileSync(parts + "app.part.html", "utf8");

const LIMITS = [
  ["A few hours", "Busy days", "The free plan has a daily limit for the whole of Hopp Cloud. On a very busy day it can be reached, and Hopp Cloud pauses for a few hours. Your messages and servers are safe meanwhile."],
  ["1,000", "Messages kept per channel", "Each channel keeps its newest 1,000 messages, and each conversation between friends its newest 5,000. Storage is what a free plan has least of."],
  ["40 a day", "Pictures", "Hopp makes pictures small (about 300 KB at most). You can share 40 a day in each server and 40 a day with friends, and a server keeps up to 100 MB of them."],
  ["10", "People in voice", "Voice and video go straight between the people talking, not through a server. That keeps calls free and private, but everyone sends to everyone, and past 10 people a home connection can't keep up."],
  ["25", "People in a group", "Group conversations are encrypted for each person in them, so they stay small."],
  ["12 a day", "Relay sign-ins", "When two people can't reach each other directly, voice goes through a relay. That costs, so each person gets 12 sign-ins a day; one lasts all day."],
  ["1 a second", "Spam protection", "A burst of 5 messages, then one a second. 10 new servers and 30 friend requests a day per person. It keeps bots and spam out, not you."],
];
const limitRows = () => LIMITS.map(([v, w, why]) => `<div class="limit"><span class="value">${v}</span><div><strong>${w}</strong><p>${why}</p></div></div>`).join("\n    ");

// ---------- home ----------
const home = `
<section class="hero">
  <div class="hero-words">
    <a class="beta-pill" href="about.html#beta"><span class="dot"></span>Hopp is in beta: free to use, still growing. <b>What that means</b></a>
    <h1>Hang out with your friends.</h1>
    <p class="lead">Talk in voice channels, call each other, share your screen and keep the chat going. Hopp is free, all of it, with no ads and no tracking.</p>
    <div class="actions">
      <a class="btn" href="${DL}">${ARROW}Download for Windows</a>
      <span class="meta"><span class="version-line">Free</span><br>About 5 MB · Windows 10 and 11 · <a href="limits.html">Limits</a></span>
    </div>
  </div>
  ${APP}
</section>

<section class="overview">
  <h2 class="section-title">Everything you need to hang out</h2>
  <div class="blocks">
    <a href="features.html#servers" class="block"><span class="shape s-servers"><i></i><i></i><i></i></span><h3>Servers</h3><p>A place for your group, with text channels to write in and voice channels to talk in.</p></a>
    <a href="features.html#voice" class="block"><span class="shape s-voice"><i></i><i></i><i></i><i></i></span><h3>Voice channels</h3><p>One click and you're talking. Everyone's a tile, cameras play right in them.</p></a>
    <a href="features.html#calls" class="block"><span class="shape s-call"><i></i><i></i></span><h3>Calls</h3><p>Call a friend or a whole group, with your camera on if you like.</p></a>
    <a href="features.html#screen" class="block"><span class="shape s-screen"><i></i></span><h3>Screen sharing</h3><p>Show a game or a video in full quality. Free, no catch.</p></a>
    <a href="features.html#chat" class="block"><span class="shape s-chat"><i></i><i></i><i></i></span><h3>Chat</h3><p>Replies, reactions, GIFs, pictures, link previews, pins and search.</p></a>
    <a href="features.html#friends" class="block"><span class="shape s-friends"><i></i><i></i></span><h3>Friends</h3><p>Messages and groups between friends, end-to-end encrypted.</p></a>
    <a href="features.html#roles" class="block"><span class="shape s-roles"><i></i><i></i><i></i></span><h3>Roles and moderation</h3><p>Colours, private channels, timeouts, slowmode and an audit log.</p></a>
    <a href="features.html#yours" class="block"><span class="shape s-yours"><i></i><i></i><i></i></span><h3>Make it yours</h3><p>Themes, a banner, a custom status, nicknames and Hopp's own sounds.</p></a>
  </div>
</section>

<section class="home-limits">
  <div class="words">
    <span class="kicker">Limits</span>
    <h2 class="section-title">Free, with a few limits</h2>
    <p>Hopp Cloud runs on a free plan. That keeps Hopp free with no ads, but a free plan only does so much. These are the limits, out in the open.</p>
    <a class="more-link" href="limits.html">Why each one is there</a>
  </div>
  <div class="limit-chips">
    ${LIMITS.map(([v, w]) => `<div><strong>${v}</strong><span>${w}</span></div>`).join("\n    ")}
  </div>
</section>

<section class="rows">
  <div class="row">
    <div class="words"><span class="kicker">Voice</span><h2>Jump into a voice channel.</h2><p>One click and you're in. Everyone shows up as a tile, the one talking lights up, and cameras play right in place. Every voice channel has its own chat for links and clips.</p><a class="more-link" href="features.html#voice">More about voice</a></div>
    <div class="pic voice" aria-hidden="true"><div class="t" data-who="0"><i class="p1"></i></div><div class="t" data-who="1"><i class="p2"></i></div><div class="t" data-who="2"><i class="p3"></i></div><div class="t cam"></div><div class="t" data-who="3"><i class="p4"></i></div><div class="t" data-who="4"><i class="p5"></i></div></div>
  </div>
  <div class="row flip">
    <div class="words"><span class="kicker">Screen sharing</span><h2>Share your screen. Free.</h2><p>Show a game, a video or whatever you're working on, in full quality, to a voice channel or straight to a friend in a call. Pop it out or watch it full screen.</p><a class="more-link" href="features.html#screen">More about sharing</a></div>
    <div class="pic screen" aria-hidden="true"><div class="shared"><div class="fake"><span class="fs"></span><span class="b1"></span><span class="b2"></span><span class="sq"></span></div><svg class="cursor" viewBox="0 0 24 24"><path d="M5 3l13 7-6 1.5L9 18z"/></svg><span class="live">LIVE</span></div><div class="people"><i class="p1"></i><i class="p2 talk"></i><i class="p4"></i></div></div>
  </div>
  <div class="row">
    <div class="words"><span class="kicker">Your look</span><h2>Make it look like yours.</h2><p>Calm greys or colour themes that flow across the whole window, or mix your own. Add a banner, a status and a nickname for each server.</p><a class="more-link" href="features.html#yours">More ways to make it yours</a></div>
    <div class="pic themes" aria-hidden="true"><div class="mini th1"><span></span><span></span><span></span></div><div class="mini th2"><span></span><span></span><span></span></div><div class="mini th3"><span></span><span></span><span></span></div></div>
  </div>
</section>

<section class="steps">
  <h2 class="section-title">Up and running in a minute</h2>
  <ol>
    <li><span class="num">1</span><h3>Download Hopp</h3><p>A small installer for Windows. It updates itself when you say so.</p></li>
    <li><span class="num">2</span><h3>Make your Hopp ID</h3><p>Pick a name and a password. No email, no phone number. You'll get 24 words to keep safe. <a href="hopp-id.html">Why?</a></p></li>
    <li><span class="num">3</span><h3>Bring your friends</h3><p>Make a server and send an invite link, or add friends by their username.</p></li>
  </ol>
</section>



<section class="values">
  <div><h3>Free, all of it</h3><p>Screen sharing, cameras, uploads and every look. Nothing to unlock, ever.</p></div>
  <div><h3>Private</h3><p>Messages and calls between friends are end-to-end encrypted. <a href="privacy.html">How it works</a></p></div>
  <div><h3>Beta</h3><p>Hopp works every day but it's still young: expect bugs and changes. <a href="about.html#beta">What beta means</a></p></div>
</section>

<section class="split">
  <div class="news">
    <h2 class="section-title">What's new</h2>
    <div class="releases" data-show="3"></div>
    <a class="more-link" href="whats-new.html">Every version</a>
  </div>
  <div class="faq-short">
    <h2 class="section-title">Questions</h2>
    <details><summary>Is it really free?</summary><p>Yes. Everything in Hopp is free and there's nothing to buy. Hopp Cloud runs on a free plan, which is why it has a few limits.</p></details>
    <details><summary>Windows says it doesn't know Hopp</summary><p>Hopp is new, so Windows hasn't seen it much yet. Choose More info, then Run anyway.</p></details>
    <details><summary>How many people fit in a voice channel?</summary><p>Up to 10 at once. Voice goes straight between you, which keeps it free and private.</p></details>
    <details><summary>Why do I get 24 words?</summary><p>They're the key to your account, so you can get back in if you forget your password. Hopp has no email reset, because it never holds your password. <a href="hopp-id.html">How your Hopp ID works</a></p></details>
    <details><summary>Is there a Mac or phone version?</summary><p>Not yet. Hopp is for Windows for now.</p></details>
    <a class="more-link" href="help.html">All questions</a>
  </div>
</section>

<section class="end">
  <img src="site/logo.svg" alt="">
  <h2>Bring your friends.</h2>
  <a class="btn" href="${DL}">${ARROW}Download for Windows</a>
</section>`;

// ---------- features ----------
const feat = (id, kicker, h2, text, items, pic = "") => `
<section class="feature" id="${id}">
  <div class="words"><span class="kicker">${kicker}</span><h2>${h2}</h2><p>${text}</p><ul class="ticks">${items.map((i) => `<li>${i}</li>`).join("")}</ul></div>
  ${pic}
</section>`;
const features = head("Features", "Everything in Hopp", "All of it is free. Here's what you can do, part by part.") + `
<nav class="chips">
  <a href="#servers">Servers</a><a href="#voice">Voice</a><a href="#calls">Calls</a><a href="#screen">Screen sharing</a><a href="#chat">Chat</a><a href="#friends">Friends</a><a href="#roles">Roles</a><a href="#yours">Make it yours</a><a href="#more">More</a>
</nav>
${feat("servers", "Servers", "A place for your group", "Make a server in a click, on Hopp Cloud: free and always on. Or run one on your own computer.", [
  "Text channels to write in and voice channels to talk in, in categories you name",
  "Invite links that you decide how long work and how many can use",
  "A server picture and name, and topics for each channel",
  "Switching between servers is instant: Hopp stays connected in the background",
], `<div class="pic voice small" aria-hidden="true"><div class="t"><i class="p1"></i></div><div class="t" data-who="0"><i class="p2"></i></div><div class="t"><i class="p4"></i></div></div>`)}
${feat("voice", "Voice channels", "Jump in, everyone's there", "Click a voice channel and you're talking. No ringing, no waiting.", [
  "Everyone as a tile that fills the view; the one talking lights up",
  "Cameras play right in the tiles; click one to put it in the middle",
  "Every voice channel has its own chat beside it",
  "Noise suppression, push to talk, and a volume for each person",
  "A soundboard to play a sound for the whole channel",
  "Up to 10 people at once, talking straight to each other",
])}
${feat("calls", "Calls", "Call a friend, or a whole group", "Press the phone or the camera in a conversation. The call sits above your messages, so you can keep writing.", [
  "Voice and video calls with friends and group calls with up to 10",
  "Drag the call's edge to make it bigger or smaller",
  "Calls between friends are end-to-end encrypted",
  "See where friends are in voice, and join them with one click",
])}
${feat("screen", "Screen sharing", "Show your screen, in full quality", "Share a game, a video or a window, to a voice channel or in a call. It's free and it stays free.", [
  "Click a shared screen to put it in the middle, everyone else in a row below",
  "Pop it out, or watch it full screen",
  "Zoom in with the mouse wheel and drag to look around",
  "Your own screen shows you what the others see",
])}
${feat("chat", "Chat", "Everything a chat needs", "Write, reply and react, in servers and between friends.", [
  "Replies, reactions, edits and pins",
  "GIFs, emoji, pictures and files",
  "Links and YouTube videos show as cards that play right in the chat",
  "Search, a line where you stopped reading, and a jump back to the newest",
  "@mentions of people, roles, @everyone and @here",
])}
${feat("friends", "Friends", "Friends and messages", "Add friends by username and talk one to one or in small groups.", [
  "Direct messages and groups of up to 25, end-to-end encrypted",
  "Pictures and files between friends",
  "Online, idle, do not disturb or invisible, and a custom status",
  "Decide who may send you friend requests, and block anyone",
])}
${feat("roles", "Roles and moderation", "Keep your server friendly", "Give people roles and the tools to look after the server.", [
  "Roles with colours, their own heading in the member list, and what they may do",
  "Private channels only chosen roles can see",
  "Timeouts, slowmode, kicks and bans that can clean up messages",
  "Mute, deafen, move or disconnect people in voice",
  "An audit log of who did what, that nobody can change",
])}
${feat("yours", "Make it yours", "Your Hopp, your look", "Change how Hopp looks and sounds.", [
  "Calm greys, colour themes that flow across the whole window, or your own colours",
  "Contrast, colourfulness, text size and spacing",
  "A profile picture and banner you can move and zoom, and an About me",
  "A nickname for each server",
  "Hopp's own soft sounds, or classic beeps",
])}
${feat("more", "And more", "The little things", "Small things that make it nice to use.", [
  "Notifications per server and channel, and do not disturb",
  "Ctrl+K to jump anywhere, and shortcuts for mute and deafen",
  "Updates that wait for you to install them",
  "Discover in the app: what's new, guides and about Hopp",
])}`;

// ---------- about ----------

const about = head("About", "What Hopp is", "Hopp is an app for talking, playing and hanging out with your friends. Servers, voice channels, calls, cameras and screen sharing, all in one small app.") + `
<section class="prose" id="why">
  <h2>Why I made Hopp</h2>
  <p>I wanted a place to hang out with my friends that didn't keep asking for money. In the big chat apps, sharing your screen in good quality, sending bigger files or picking how it all looks sits behind a monthly payment, and more and more of them come with ads, quests and things to buy. Some now even want a photo of your ID or your face.</p>
  <p>So I started making my own. One where everything is free, where messages between friends are actually private, where nobody needs your email, phone number or ID, and where the app stays small and quick instead of eating your computer. Where accounts are hard to steal, and where the look is yours to change.</p>
  <p>And I wanted it to be fast. A lot of chat apps are a whole web browser in disguise: they take up a big chunk of your memory just sitting there, slow down your games, take ages to start, and voice gets choppy or stuck on "connecting". Hopp is built differently. Its heart is written in Rust, a language made for speed, and it uses the browser engine Windows already has instead of shipping its own. That's why the download is about 5 MB, why it starts in a moment and switches servers at once, and why voice goes straight between you and your friends instead of around the world and back.</p>
  <p>Hopp is made by one person, with friends testing it along the way. It's not a company and it doesn't sell anything.</p>
</section>

<section class="beta-box" id="beta">
  <span class="kicker">Beta</span>
  <h2>Hopp is in beta</h2>
  <p>That means Hopp works and you can use it every day, but it's still young. Honestly:</p>
  <ul class="ticks">
    <li>You'll find bugs. New versions come often, sometimes every week, and fix them.</li>
    <li>Things can change and move as Hopp gets better. Every change is listed on What's new.</li>
    <li>Hopp Cloud runs on a free plan and can pause for a few hours on a very busy day.</li>
    <li>It's for Windows only for now.</li>
    <li>Your account, servers and messages are kept between versions; nothing is wiped when Hopp updates.</li>
  </ul>
  <p>Found something broken? In Hopp, open Settings, then App, and press Copy next to Debug info. Send it, with what happened, to the person who invited you or to whoever runs your server.</p>
</section>

<section class="prose">
  <h2>What Hopp stands for</h2>
  <p>Hanging out with friends online shouldn't cost money, show you ads or follow you around. So Hopp is free, all of it: screen sharing in full quality, cameras, uploads and every look. There's nothing to unlock.</p>
  <p>It's also private where it matters most. Messages and calls between friends are end-to-end encrypted, your Hopp ID is a key that stays on your own computer, and voice goes straight between the people talking whenever it can.</p>
  <p>And it's light. Hopp is a small download that starts quickly and switches between servers at once. Updates come when you choose to install them.</p>

  <h2>How it stays free</h2>
  <p>Servers made in Hopp run on Hopp Cloud, which uses a free plan. Calls and voice don't go through it at all: they go straight between you and your friends. That's how Hopp can be free with no ads and nothing to pay. A free plan only does so much each day and only stores so much, so Hopp keeps a few limits.</p>
</section>

<section class="prose" id="limits">
  <h2>The limits</h2>
  <p>Every limit Hopp Cloud has, and why it's there, is on its own page: <a href="limits.html">Limits</a>.</p>
</section>

<section class="prose">
  <h2>Want no limits?</h2>
  <p>Run your own server. It runs on a computer of yours, keeps what you want, and nothing goes through Hopp Cloud. In the app, press <b>+</b> in the server list and choose <b>Run your own server</b> to see how.</p>
  <h2>Where Hopp is going</h2>
  <p>Hopp gets better every week. You can follow along on <a href="whats-new.html">What's new</a>, and the app tells you when a new version is ready.</p>
</section>`;

// ---------- privacy ----------
const privacy = head("Privacy & safety", "What stays private", "Plain answers about what's encrypted, what Hopp Cloud keeps, and how you stay in control.") + `
<section class="cards-2">
  <div class="card"><h3>End-to-end encrypted</h3><ul class="ticks"><li>Direct messages and group conversations</li><li>Pictures and files between friends</li><li>Calls with friends, voice and video</li></ul><p>Only the people in the conversation can read or hear them. Not even Hopp Cloud.</p></div>
  <div class="card"><h3>Encrypted on the way</h3><ul class="ticks"><li>Voice and cameras in voice channels</li><li>Screen sharing</li></ul><p>They go straight between the people in the channel whenever possible. When a network blocks that, they pass through a relay that can't read them.</p></div>
</section>

<section class="prose">
  <h2>What Hopp Cloud keeps</h2>
  <p>To work, Hopp Cloud keeps your username, display name, profile picture, banner, About me and your friends list. Your settings and server list are kept too, sealed so only your Hopp ID can read them.</p>
  <p>Messages in servers are kept on Hopp Cloud so everyone in the server can see them, the newest 1,000 per channel. They aren't end-to-end encrypted, the same as on other chat apps' servers. If you want them on your own computer instead, run your own server.</p>
  <h2>What it doesn't do</h2>
  <p>No ads, no tracking, no selling anything about you. Hopp doesn't need your email or phone number.</p>

  <h2>Your Hopp ID</h2>
  <p>You sign in with a key that's made and kept on your own computer, locked with your password. Your recovery phrase is the only way back in if you forget the password, so write it down somewhere safe. Hopp warns you if you're about to send it to anyone. <a href="hopp-id.html">Everything about your Hopp ID</a></p>

  <h2>Staying safe</h2>
  <ul class="ticks">
    <li>Decide who may send you friend requests: everyone, friends of friends, or nobody</li>
    <li>Block anyone: they can't message you or reach you</li>
    <li>Server moderators can time people out, use slowmode, and ban</li>
    <li>Everything moderators do is in the audit log</li>
  </ul>
</section>`;

// ---------- help ----------
const Q = (q, a) => `<details><summary>${q}</summary><p>${a}</p></details>`;
const help = head("Help", "Questions and answers", "The most common questions. Can't find yours? Ask the person who invited you, or look in Discover inside the app.") + `
<section class="faq">
  <h2>Getting started</h2>
  ${Q("What do I need?", "A computer with Windows 10 or 11. Hopp is about 5 MB.")}
  ${Q("Windows says it doesn't know Hopp", "Hopp is new, so Windows hasn't seen it much yet. Choose <b>More info</b>, then <b>Run anyway</b>.")}
  ${Q("Do I need an email address?", "No. You make a Hopp ID with a name and a password. No email, no phone number.")}
  ${Q("Why do I need a recovery phrase?", "Your account is a key that lives on your computer, not a password kept on a server. The 24 words are that key written out, so you can get back in if you forget your password or move to a new computer. <a href=\"hopp-id.html\">Read more</a>")}
  ${Q("Do I have to save the phrase as a file?", "No. Writing it on paper is safest. Saving it as a file is only there if you'd rather keep it somewhere private on your computer or a USB stick. <a href=\"hopp-id.html#keep\">Where to keep it</a>")}
  ${Q("Is this some crypto thing?", "No. There's no crypto, no wallet and no money. Hopp uses the same kind of word list to write out your key in words people can copy by hand.")}
  ${Q("I forgot my password", "Use your recovery phrase: on the login screen, choose to recover your account and type it in. Without it, nobody can get the account back, not even Hopp.")}
  ${Q("Is there a Mac or phone version?", "Not yet. Hopp is for Windows for now.")}

  <h2>Friends and servers</h2>
  ${Q("How do I add a friend?", "Go Home, open <b>Add friend</b> and type their username. Once they accept, you can message and call them.")}
  ${Q("How do I make a server?", "Press <b>+</b> in the server list and choose <b>Create a server</b>. Then invite people with a link or straight from your friends list.")}
  ${Q("How do I join a server?", "Click an invite link someone sent you, or press <b>+</b> and choose <b>Join a server</b>.")}
  ${Q("Can I change my name in just one server?", "Yes: open the server's menu and choose <b>Change nickname</b>.")}

  <h2>Voice, calls and screens</h2>
  ${Q("People can't hear me, or I can't hear them", "Open Settings, then Voice &amp; audio, and check your microphone and headset. The mic test shows if your microphone picks you up. Also check that you aren't muted.")}
  ${Q("How many people can be in a voice channel or call?", "Up to 10 at once. Voice goes straight between you, which keeps it free and private.")}
  ${Q("How do I share my screen?", "Join a voice channel or start a call, then press the screen button in the panel above your name.")}
  ${Q("What is push to talk?", "Your microphone only sends while you hold a key. Turn it on in Settings, then Voice &amp; audio, and pick the key under Keybinds.")}

  <h2>Hopp itself</h2>
  ${Q("What does beta mean?", "Hopp works and you can use it every day, but it's still young: you'll find bugs, and things can change as it gets better. Your account and messages are kept between versions. <a href=\"about.html#beta\">More about the beta</a>")}
  ${Q("Something is broken. How do I report it?", "In Hopp, open Settings, then App, and press <b>Copy</b> next to <b>Debug info</b>. Send it, with what happened, to the person who invited you or to whoever runs your server.")}
  ${Q("Is it really free?", "Yes, all of it. Hopp Cloud runs on a free plan, which is why it has <a href=\"limits.html\">a few limits</a>.")}
  ${Q("What are the limits?", "Channels keep their newest 1,000 messages, up to 10 people talk in a voice channel, pictures are 40 a day, and on a very busy day Hopp Cloud can pause for a few hours. <a href=\"limits.html\">Every limit, and why</a>")}
  ${Q("How do updates work?", "When a new version is ready, the arrow at the top of Hopp turns green. You choose when to install it.")}
  ${Q("Hopp Cloud seems to be down", "On a very busy day the free plan's daily limit can be reached, and Hopp Cloud pauses for a few hours. Your messages and servers are safe; it comes back by itself.")}
  ${Q("Can I run my own server?", "Yes. In the app, press <b>+</b> and choose <b>Run your own server</b> to see how. It has no limits beyond your own computer.")}
</section>`;

// ---------- limits ----------
const limitsPage = head("Limits", "Every limit, and why", "Hopp is free, all of it. To stay that way, Hopp Cloud runs on a free plan, and a free plan only does so much each day and only stores so much. Here is every limit, out in the open.") + `
<section class="limits-page">
  <div class="limits">
    ${limitRows()}
  </div>
</section>
<section class="prose">
  <h2>What doesn't count</h2>
  <p>Calls and voice don't go through Hopp Cloud: they go straight between you and your friends, so talking doesn't use anything up. Screen sharing and cameras go the same way.</p>
  <h2>Want no limits?</h2>
  <p>Run your own server. It runs on a computer of yours, keeps what you want, and nothing goes through Hopp Cloud. In the app, press <b>+</b> in the server list and choose <b>Run your own server</b>.</p>
  <h2>Will they change?</h2>
  <p>Hopp is in beta. If a limit changes, it says so here and on <a href="whats-new.html">What's new</a>.</p>
</section>`;

// ---------- Hopp ID ----------
const hoppId = head("Your Hopp ID", "How your account works", "Hopp doesn't ask for your email or phone number, and it never keeps your password. Instead, your account is a key that lives on your computer. Here's what that means, and why you get 24 words.") + `
<section class="id-facts">
  <div><strong>No email</strong><span>Nothing to sign up with but a name</span></div>
  <div><strong>No password on any server</strong><span>Not even Hopp Cloud has it</span></div>
  <div><strong>24 words</strong><span>Your key, written out, for getting back in</span></div>
</section>

<section class="prose">
  <h2>Your account is a key</h2>
  <p>When you make a Hopp ID, your computer makes a key: a long secret number that only you have. Every time you join a server or talk to a friend, Hopp proves it's you with that key, without ever sending the key itself. Servers and friends only ever see a public part of it, which is safe to share.</p>
  <p>The key is kept on your computer, locked with your password. Your password never leaves your computer, and it's never sent to Hopp Cloud or anyone else.</p>

  <h2>So why the 24 words?</h2>
  <p>Because nobody else holds your password, nobody can send you a "reset your password" email. That's on purpose: it means nobody can trick a support person into giving away your account, and a leak somewhere can't expose your password.</p>
  <p>The 24 words are your key written out in plain words. With them you can:</p>
  <ul class="ticks">
    <li>Get back in if you forget your password, and pick a new one</li>
    <li>Use your Hopp ID on a new or second computer</li>
    <li>Get your account back if your computer breaks or is replaced</li>
  </ul>
  <p>Without them, and without your password, nobody can get the account back. Not you, and not Hopp.</p>

  <h2>It's not a crypto thing</h2>
  <p>The words come from the same kind of word list that some crypto wallets use, because it's a good way to write a key in words people can copy by hand without mistakes. That's all. There's no crypto, no wallet, no coins and no money in Hopp.</p>
</section>

<section class="beta-box" id="keep">
  <span class="kicker">Keeping it safe</span>
  <h2>Where to keep your words</h2>
  <ul class="ticks">
    <li><b>Best: on paper.</b> Write the 24 words down, in order, and keep the paper somewhere at home.</li>
    <li><b>Or as a file</b>, if you'd rather: Hopp can save them as a file you put somewhere private, like a USB stick or a password manager. You don't have to; it's only there if it suits you better.</li>
  </ul>
  <p class="never"><b>Never</b> keep them in a chat, an email, a screenshot you share, or a note others can see.</p>
  <p>Hopp asks you to type a few of the words back once, so you know you have them right. Until you've saved them, a small reminder stays in Hopp so you don't forget.</p>
</section>

<section class="prose">
  <h2>What Hopp will never do</h2>
  <ul class="ticks">
    <li>Hopp, and anyone who works on it, will never ask for your 24 words or your password</li>
    <li>There's no "log in with a QR code" that someone could trick you into scanning</li>
    <li>If you paste your words into a chat, Hopp stops and warns you before anything is sent</li>
  </ul>
  <p>If anyone asks for your words, for any reason, it's someone trying to take your account.</p>

  <h2>Day to day</h2>
  <p>Most of the time you never think about any of this. Tick <b>Keep me logged in</b> and Hopp opens straight into your account. On Windows you can use <b>Windows Hello</b> (your face, fingerprint or PIN) instead of your password when Hopp asks to confirm it's you.</p>

  <h2>If you lose everything</h2>
  <p>If you lose both your password and your 24 words, the account can't be recovered. You can make a new Hopp ID right away and add your friends again, but your old account, its friends and its messages stay out of reach. That's the price of nobody else holding the keys, and it's why the words matter.</p>
</section>`;

// ---------- code signing ----------
// SignPath Foundation's open-source programme asks for this page (linked from every page).
// SignPath Foundation (free signing for open source) wants a project to be better known first:
// applied 2026-11-12, not yet. Once Hopp is signed, say so here and in the footer.
const SIGNED = false;
const codeSigning = head("Code signing", "Code signing policy", "How Hopp's installer is built and signed, and who decides what gets signed.") + `
<section class="prose">
  <p>${SIGNED ? "<strong>Free code signing provided by <a href=\"https://signpath.io\">SignPath.io</a>, certificate by <a href=\"https://signpath.org\">SignPath Foundation</a>.</strong>" : "<strong>Hopp isn't code-signed yet.</strong> Signing costs money, and the free route for open-source projects asks for a project that more people already know. Until then, Windows may say it doesn't recognise the publisher the first time you install. <a href=\"help.html\">How to install anyway</a>."}</p>
  <h2>What is signed</h2>
  <p>The Hopp installer for Windows. It is built automatically by GitHub Actions from the source code in <a href="https://github.com/chillscapee-netizen/Hopp">github.com/chillscapee-netizen/Hopp</a>, and only that build is sent for signing. Nothing built on someone's own computer is signed.</p>
  <h2>Who does what</h2>
  <p><strong>Committers and reviewers:</strong> <a href="https://github.com/chillscapee-netizen">Marcus</a>. Changes from anyone else are reviewed before they're taken in.</p>
  <p><strong>Approvers:</strong> <a href="https://github.com/chillscapee-netizen">Marcus</a>. Every release is approved by hand before it's signed.</p>
  <h2>Privacy</h2>
  <p>Hopp talks to the internet only for what you use it for:</p>
  <ul>
    <li>Hopp Cloud: your account, your servers and messages, and whether a new version of Hopp is out.</li>
    <li>Servers you join, and your friends' computers while you're in a call or voice channel with them.</li>
    <li>For calls to find a way between computers: Google's and Cloudflare's connection helpers (STUN), and Cloudflare's relay when a direct way doesn't work.</li>
    <li>When a link is shared in a chat: that web page, to show a preview of it (turn previews off in Settings → Privacy &amp; safety). YouTube, when a YouTube link is shown.</li>
    <li>KLIPY, when you search for GIFs and when GIFs are shown.</li>
  </ul>
  <p>Nothing is sent anywhere else, and Hopp has no ads or tracking. <a href="privacy.html">What Hopp keeps, and what's encrypted</a>.</p>
</section>`;

// ---------- what's new ----------
const news = head("What's new", "Better every week", "Every version of Hopp and what it brought. The app tells you when a new one is ready.") + `
<section class="news full"><div class="releases" data-show="all"></div></section>`;

writeFileSync(out + "index.html", page("index", "", "Hopp: hang out with your friends", "Hopp is a free app to talk, play and hang out with your friends. Voice channels, calls, cameras and screen sharing. No ads, no tracking.", home));
writeFileSync(out + "features.html", page("features", "features", "Features · Hopp", "Everything Hopp can do: servers, voice channels, calls, screen sharing, chat, friends, roles and themes.", features));
writeFileSync(out + "limits.html", page("limits", "limits", "Limits · Hopp", "Every limit Hopp Cloud has, and why it is there.", limitsPage));
writeFileSync(out + "hopp-id.html", page("hopp-id", "hopp-id", "Your Hopp ID · Hopp", "How a Hopp ID works: a key on your computer, no email, no password on any server, and 24 words to get back in.", hoppId));
writeFileSync(out + "about.html", page("about", "about", "About · Hopp", "What Hopp is, how it stays free, and every limit and why.", about));
writeFileSync(out + "privacy.html", page("privacy", "privacy", "Privacy & safety · Hopp", "What's encrypted in Hopp, what Hopp Cloud keeps, and how you stay in control.", privacy));
writeFileSync(out + "help.html", page("help", "help", "Help · Hopp", "Answers to the most common questions about Hopp.", help));
writeFileSync(out + "code-signing.html", page("code-signing", "", "Code signing · Hopp", "How Hopp's installer is built and signed, and who approves it.", codeSigning));
writeFileSync(out + "whats-new.html", page("whats-new", "whats-new", "What's new · Hopp", "Every version of Hopp and what it brought.", news));
console.log("built");
