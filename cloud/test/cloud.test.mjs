// End-to-end tests against a running Worker (`npx wrangler dev`), using real
// WebSockets and real Ed25519 keys, exactly like the app does.
//
//   STROM_CLOUD_URL=ws://127.0.0.1:8787 node test/cloud.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const BASE = process.env.STROM_CLOUD_URL ?? "ws://127.0.0.1:8787";
const WAIT_MS = 3000;
const PROTOCOL_VERSION = 5;

function newKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  return { pub, privateKey };
}

const newServerId = () => crypto.randomBytes(12).toString("hex");

function authMessage(nonceHex) {
  return Buffer.concat([Buffer.from("strom-auth-v1\0"), Buffer.from(nonceHex, "hex")]);
}

class Client {
  constructor(ws) {
    this.ws = ws;
    this.inbox = [];
    this.waiters = [];
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      const waiter = this.waiters.shift();
      if (waiter) waiter(msg);
      else this.inbox.push(msg);
    });
  }

  static open(serverId) {
    const ws = new WebSocket(`${BASE}/servers/${serverId}/ws`);
    return new Promise((resolve, reject) => {
      ws.addEventListener("open", () => resolve(new Client(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error("could not connect; is `npx wrangler dev` running?")), { once: true });
    });
  }

  next() {
    if (this.inbox.length) return Promise.resolve(this.inbox.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(done), 1);
        reject(new Error("timed out waiting for a server message"));
      }, WAIT_MS);
      const done = (msg) => {
        clearTimeout(timer);
        resolve(msg);
      };
      this.waiters.push(done);
    });
  }

  async waitFor(pred) {
    for (;;) {
      const msg = await this.next();
      if (pred(msg)) return msg;
    }
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.ws.close();
  }
}

/** Logs in; returns the client and the server's reply to the signed challenge. */
async function login(serverId, name, key = newKey(), { invite, create, signWith } = {}) {
  const client = await Client.open(serverId);
  client.send({ type: "hello", name, protocol_version: PROTOCOL_VERSION, public_key: key.pub, invite, create });
  const challenge = await client.next();
  if (challenge.type !== "challenge") return { client, reply: challenge, key };
  const signature = crypto.sign(null, authMessage(challenge.nonce), (signWith ?? key).privateKey).toString("hex");
  client.send({ type: "auth", signature });
  return { client, reply: await client.next(), key };
}

async function join(serverId, name, opts) {
  const { client, reply, key } = await login(serverId, name, opts?.key, opts);
  assert.equal(reply.type, "welcome", `expected welcome, got ${JSON.stringify(reply)}`);
  client.welcome = reply;
  client.key = key;
  client.id = reply.session_id;
  return client;
}

async function loginError(serverId, name, opts) {
  const { client, reply } = await login(serverId, name, opts?.key, opts);
  client.close();
  assert.equal(reply.type, "error", `expected the login to fail, got ${JSON.stringify(reply)}`);
  return reply.message;
}

/** A fresh server with its owner connected and an unlimited invite for everyone else. */
async function newServer() {
  const id = newServerId();
  const owner = await join(id, "owner", { create: "Test server" });
  owner.send({ type: "create_invite", max_uses: null, expires_in_hours: null });
  const { invite } = await owner.waitFor((m) => m.type === "invite_created");
  return { id, owner, invite: invite.code };
}

const errorOf = async (client) => (await client.waitFor((m) => m.type === "error")).message;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const channelId = (client, name) => client.welcome.channels.find((c) => c.name === name).id;

// ---------- creating & joining ----------

test("creating a server makes you its owner with default channels", async () => {
  const id = newServerId();
  const owner = await join(id, "owner", { create: "My server" });
  assert.equal(owner.welcome.server_name, "My server");
  assert.deepEqual(owner.welcome.channels.map((c) => [c.name, c.kind]), [["general", "text"], ["Lobby", "voice"], ["Gaming", "voice"]]);
  assert.ok(owner.welcome.users.find((u) => u.session_id === owner.id).owner);
  owner.close();
});

test("a server that was never created doesn't exist", async () => {
  assert.match(await loginError(newServerId(), "nobody"), /doesn't exist/);
});

test("a bad signature is rejected", async () => {
  const { id, owner } = await newServer();
  assert.match(await loginError(id, "mallory", { signWith: newKey() }), /invalid signature/);
  owner.close();
});

test("newcomers need a valid invite; members come back without one", async () => {
  const { id, owner, invite } = await newServer();
  const key = newKey();
  assert.match(await loginError(id, "stranger", { key }), /invite-only/);
  assert.match(await loginError(id, "stranger", { key, invite: "NOPE1234" }), /invalid/);
  const first = await join(id, "stranger", { key, invite: invite.toLowerCase() });
  first.close();
  await sleep(100);
  (await join(id, "stranger", { key })).close();
  owner.close();
});

test("invites run out", async () => {
  const { id, owner } = await newServer();
  owner.send({ type: "create_invite", max_uses: 1, expires_in_hours: 24 });
  const { invite } = await owner.waitFor((m) => m.type === "invite_created");
  (await join(id, "first", { invite: invite.code })).close();
  assert.match(await loginError(id, "second", { invite: invite.code }), /invalid/);
  owner.close();
});

test("two friends can share a name; their Hopp IDs tell them apart", async () => {
  const { id, owner, invite } = await newServer();
  const first = await join(id, "Alex", { invite });
  const second = await join(id, "alex", { invite });
  const both = second.welcome.users.filter((u) => u.name.toLowerCase() === "alex");
  assert.equal(both.length, 2);
  assert.notEqual(both[0].public_key, both[1].public_key);
  for (const c of [first, second, owner]) c.close();
});

test("leaving frees the account to come back", async () => {
  const { id, owner, invite } = await newServer();
  const key = newKey();
  const bob = await join(id, "bob", { key, invite });
  bob.close();
  await owner.waitFor((m) => m.type === "user_left" && m.session_id === bob.id);
  (await join(id, "bob", { key })).close();
  owner.close();
});

test("the same Hopp ID on two computers: both stay, and a kick reaches both", async () => {
  const { id, owner, invite } = await newServer();
  const key = newKey();
  const laptop = await join(id, "bob", { key, invite });
  const desktop = await join(id, "bob", { key });
  await sleep(300);
  assert.ok(!laptop.inbox.some((m) => m.type === "error"), "the first computer isn't thrown out");
  assert.equal(desktop.welcome.users.filter((u) => u.public_key === key.pub).length, 2);
  owner.send({ type: "kick", session_id: laptop.id });
  await laptop.waitFor((m) => m.type === "kicked");
  await desktop.waitFor((m) => m.type === "kicked");
  owner.close();
});

test("a connection that went silent is let go when its owner comes back", async () => {
  const { id, owner, invite } = await newServer();
  const key = newKey();
  const stale = await join(id, "bob", { key, invite });
  // It never pings (a crashed app). After half a minute it counts as gone.
  await sleep(31_000);
  const fresh = await join(id, "bob", { key });
  await owner.waitFor((m) => m.type === "user_left" && m.session_id === stale.id);
  assert.equal(fresh.welcome.users.filter((u) => u.public_key === key.pub).length, 1);
  stale.close();
  fresh.close();
  owner.close();
});

test("keep-alive pings are answered", async () => {
  const { owner } = await newServer();
  owner.send({ type: "ping" });
  assert.equal((await owner.waitFor((m) => m.type === "pong")).type, "pong");
  owner.close();
});

// ---------- invites & server profile ----------

const HTTP = BASE.replace(/^ws/, "http");

test("short invite codes show a preview and lead to the right server", async () => {
  const { id, owner, invite } = await newServer();
  const res = await fetch(`${HTTP}/invite/${invite.toLowerCase()}`);
  assert.equal(res.status, 200);
  const preview = await res.json();
  assert.equal(preview.server_id, id);
  assert.equal(preview.name, "Test server");
  assert.equal(preview.members, 1);
  assert.equal(preview.online, 1);
  assert.equal(preview.inviter, "owner");

  // What the app does with a pasted code: preview, then join that server with it.
  (await join(preview.server_id, "friend", { invite: preview.code })).close();
  assert.equal((await (await fetch(`${HTTP}/invite/${invite}`)).json()).members, 2);

  assert.equal((await fetch(`${HTTP}/invite/NOPE1234`)).status, 404);
  owner.send({ type: "revoke_invite", code: invite });
  await owner.waitFor((m) => m.type === "invites");
  assert.equal((await fetch(`${HTTP}/invite/${invite}`)).status, 404, "revoked invites stop resolving");
  owner.close();
});

test("the owner sets the server name and picture", async () => {
  const { id, owner, invite } = await newServer();
  const guest = await join(id, "guest", { invite });
  const icon = "data:image/png;base64,iVBORw0KGgo=";

  guest.send({ type: "update_server", name: "Hack", icon: null });
  assert.match(await errorOf(guest), /owner/);
  owner.send({ type: "update_server", name: "Pics", icon: "data:image/svg+xml;base64,PHN2Zz4=" });
  assert.match(await errorOf(owner), /picture/);

  owner.send({ type: "update_server", name: "  The Crew ", icon });
  const update = await guest.waitFor((m) => m.type === "server_updated");
  assert.deepEqual(update, { type: "server_updated", name: "The Crew", icon, pictures_off: false });

  const late = await join(id, "late", { invite });
  assert.equal(late.welcome.server_name, "The Crew");
  assert.equal(late.welcome.server_icon, icon);
  owner.send({ type: "create_invite", max_uses: null, expires_in_hours: 1 });
  const { invite: fresh } = await owner.waitFor((m) => m.type === "invite_created");
  const preview = await (await fetch(`${HTTP}/invite/${fresh.code}`)).json();
  assert.deepEqual([preview.name, preview.icon], ["The Crew", icon]);
  for (const c of [owner, guest, late]) c.close();
});

// ---------- chat ----------

test("chat reaches everyone, survives reconnects and keeps increasing ids", async () => {
  const { id, owner, invite } = await newServer();
  const general = channelId(owner, "general");
  const bob = await join(id, "bob", { invite });

  owner.send({ type: "send_chat", channel: general, text: "  hello  " });
  const { message } = await bob.waitFor((m) => m.type === "chat");
  assert.equal(message.text, "hello");
  assert.equal(message.sender_name, "owner");
  assert.equal(message.author_key, owner.key.pub);

  const carol = await join(id, "carol", { invite });
  const history = await carol.waitFor((m) => m.type === "chat_history" && m.channel === general);
  assert.deepEqual(history.messages.map((m) => m.text), ["hello"]);

  bob.send({ type: "send_chat", channel: general, text: "again" });
  const second = (await carol.waitFor((m) => m.type === "chat" && m.message.text === "again")).message;
  assert.ok(second.id > message.id);
  for (const c of [owner, bob, carol]) c.close();
});

test("bad chat is rejected and floods are throttled", async () => {
  const { owner } = await newServer();
  const general = channelId(owner, "general");
  owner.send({ type: "send_chat", channel: 999, text: "no such channel" });
  assert.match(await errorOf(owner), /doesn't exist/);
  for (let i = 0; i < 10; i++) owner.send({ type: "send_chat", channel: general, text: `spam ${i}` });
  assert.match(await errorOf(owner), /too fast/);
  owner.close();
});

test("messages can be deleted by their author or the owner", async () => {
  const { id, owner, invite } = await newServer();
  const general = channelId(owner, "general");
  const alice = await join(id, "alice", { invite });
  const bob = await join(id, "bob", { invite });

  alice.send({ type: "send_chat", channel: general, text: "first" });
  const first = (await bob.waitFor((m) => m.type === "chat")).message;
  bob.send({ type: "delete_message", channel: general, id: first.id });
  assert.match(await errorOf(bob), /your own/);
  alice.send({ type: "delete_message", channel: general, id: first.id });
  await bob.waitFor((m) => m.type === "message_deleted" && m.id === first.id);

  alice.send({ type: "send_chat", channel: general, text: "second" });
  const second = (await bob.waitFor((m) => m.type === "chat")).message;
  owner.send({ type: "delete_message", channel: general, id: second.id });
  await bob.waitFor((m) => m.type === "message_deleted" && m.id === second.id);
  for (const c of [owner, alice, bob]) c.close();
});

test("typing reaches others", async () => {
  const { id, owner, invite } = await newServer();
  const bob = await join(id, "bob", { invite });
  owner.send({ type: "typing", channel: channelId(owner, "general") });
  await bob.waitFor((m) => m.type === "typing" && m.session_id === owner.id);
  owner.close();
  bob.close();
});

// ---------- voice presence ----------

test("joining and leaving voice is broadcast", async () => {
  const { id, owner, invite } = await newServer();
  const bob = await join(id, "bob", { invite });
  const lobby = channelId(owner, "Lobby");
  owner.send({ type: "join_voice", channel: lobby });
  await bob.waitFor((m) => m.type === "user_updated" && m.user.session_id === owner.id && m.user.voice_channel === lobby);
  owner.send({ type: "join_voice", channel: channelId(owner, "general") });
  assert.match(await errorOf(owner), /doesn't exist/);
  owner.close();
  bob.close();
});

// ---------- moderation ----------

test("only the owner manages channels", async () => {
  const { id, owner, invite } = await newServer();
  const guest = await join(id, "guest", { invite });
  guest.send({ type: "create_channel", name: "hack", kind: "text" });
  assert.match(await errorOf(guest), /owner/);

  owner.send({ type: "create_channel", name: "  Good Clips ", kind: "text" });
  const { channels } = await guest.waitFor((m) => m.type === "channels_updated");
  assert.deepEqual([channels.at(-1).name, channels.at(-1).kind], ["good-clips", "text"]);

  const gaming = channelId(owner, "Gaming");
  guest.send({ type: "join_voice", channel: gaming });
  await guest.waitFor((m) => m.type === "user_updated" && m.user.voice_channel === gaming);
  owner.send({ type: "delete_channel", channel: gaming });
  await guest.waitFor((m) => m.type === "user_updated" && m.user.session_id === guest.id && m.user.voice_channel === null);
  owner.close();
  guest.close();
});

test("kick, ban and unban", async () => {
  const { id, owner, invite } = await newServer();
  const bobKey = newKey();
  const carolKey = newKey();
  const bob = await join(id, "bob", { key: bobKey, invite });
  const carol = await join(id, "carol", { key: carolKey, invite });

  carol.send({ type: "kick", session_id: bob.id });
  assert.match(await errorOf(carol), /owner/);

  owner.send({ type: "kick", session_id: bob.id });
  assert.deepEqual(await bob.waitFor((m) => m.type === "kicked"), { type: "kicked", banned: false });
  await carol.waitFor((m) => m.type === "user_left" && m.session_id === bob.id);
  // A kick ends the membership: coming back takes an invite again.
  assert.match(await loginError(id, "bob", { key: bobKey }), /invite/);
  const back = await join(id, "bob", { key: bobKey, invite });
  // Someone who isn't here right now can be kicked too, by Hopp ID.
  back.close();
  await sleep(100);
  owner.send({ type: "kick", public_key: bobKey.pub });
  const after = await owner.waitFor((m) => m.type === "members" && !m.members.some((x) => x.public_key === bobKey.pub));
  assert.ok(after.members.some((x) => x.public_key === carolKey.pub));
  assert.match(await loginError(id, "bob", { key: bobKey }), /invite/);

  owner.send({ type: "ban", session_id: carol.id });
  assert.deepEqual(await carol.waitFor((m) => m.type === "kicked"), { type: "kicked", banned: true });
  await sleep(100);
  assert.match(await loginError(id, "carol", { key: carolKey, invite }), /banned/);

  owner.send({ type: "unban", public_key: carolKey.pub });
  await owner.waitFor((m) => m.type === "bans" && m.bans.length === 0);
  (await join(id, "carol", { key: carolKey, invite })).close();
  owner.close();
});

test("voice channels hand out a key and connect peers directly", async () => {
  const { id, owner, invite } = await newServer();
  const bob = await join(id, "bob", { invite });
  const carol = await join(id, "carol", { invite });
  const lobby = channelId(owner, "Lobby");

  owner.send({ type: "join_voice", channel: lobby });
  const first = await owner.waitFor((m) => m.type === "voice_session");
  assert.equal(first.channel, lobby);
  assert.match(first.key, /^[0-9a-f]{64}$/);
  assert.deepEqual(first.peers, []);
  owner.send({ type: "voice_endpoint", public: "203.0.113.5:40000", local: ["192.168.1.2:40000", "not an address"] });
  // Separate sockets: give the endpoint a moment to land before bob joins.
  await sleep(200);

  bob.send({ type: "join_voice", channel: lobby });
  const second = await bob.waitFor((m) => m.type === "voice_session");
  assert.equal(second.key, first.key);
  assert.deepEqual(second.peers, [{ session_id: owner.id, public: "203.0.113.5:40000", local: ["192.168.1.2:40000"] }]);

  bob.send({ type: "voice_endpoint", public: null, local: ["192.168.1.3:5000"] });
  const peer = await owner.waitFor((m) => m.type === "voice_peer");
  assert.deepEqual(peer.peer, { session_id: bob.id, public: null, local: ["192.168.1.3:5000"] });

  // Nobody outside the channel learns the addresses.
  await sleep(300);
  assert.ok(!carol.inbox.some((m) => m.type === "voice_peer" || m.type === "voice_session"));

  // Once everyone has left, the next person gets a new key.
  owner.send({ type: "leave_voice" });
  bob.send({ type: "leave_voice" });
  await carol.waitFor((m) => m.type === "user_updated" && m.user.session_id === bob.id && m.user.voice_channel === null);
  carol.send({ type: "join_voice", channel: lobby });
  const third = await carol.waitFor((m) => m.type === "voice_session");
  assert.notEqual(third.key, first.key);
  assert.deepEqual(third.peers, []);
  for (const c of [owner, bob, carol]) c.close();
});

test("replies, edits, reactions and older messages", async () => {
  const { id, owner, invite } = await newServer();
  const general = channelId(owner, "general");
  const bob = await join(id, "bob", { invite });

  owner.send({ type: "send_chat", channel: general, text: "who is in?" });
  const question = (await bob.waitFor((m) => m.type === "chat")).message;
  bob.send({ type: "send_chat", channel: general, text: "me", reply_to: question.id });
  const answer = (await owner.waitFor((m) => m.type === "chat" && m.message.text === "me")).message;
  assert.deepEqual(answer.reply, { id: question.id, sender_name: "owner", author_key: owner.key.pub, text: "who is in?" });

  bob.send({ type: "edit_message", channel: general, id: question.id, text: "hacked" });
  assert.match(await errorOf(bob), /your own/);
  owner.send({ type: "edit_message", channel: general, id: question.id, text: "who is in tonight?" });
  const edited = await bob.waitFor((m) => m.type === "message_edited");
  assert.equal(edited.text, "who is in tonight?");

  bob.send({ type: "react", channel: general, id: question.id, emoji: "👍", on: true });
  const reacted = await owner.waitFor((m) => m.type === "reactions");
  assert.deepEqual(reacted.reactions, [{ emoji: "👍", keys: [bob.key.pub] }]);
  bob.send({ type: "react", channel: general, id: question.id, emoji: "abc", on: true });
  assert.match(await errorOf(bob), /emoji/);

  const carol = await join(id, "carol", { invite });
  const history = await carol.waitFor((m) => m.type === "chat_history" && m.channel === general);
  assert.equal(history.messages[0].text, "who is in tonight?");
  assert.ok(history.messages[0].edited_at > 0);
  assert.equal(history.messages[0].reactions.length, 1);
  assert.equal(history.messages[1].reply.id, question.id);

  carol.send({ type: "load_older", channel: general, before: answer.id });
  const older = await carol.waitFor((m) => m.type === "older_history");
  assert.deepEqual(older.messages.map((m) => m.id), [question.id]);
  assert.equal(older.done, true);
  for (const c of [owner, bob, carol]) c.close();
});

test("leaving a server for good", async () => {
  const { id, owner, invite } = await newServer();
  owner.send({ type: "leave_server" });
  assert.match(await errorOf(owner), /own this server/);
  const key = newKey();
  const bob = await join(id, "bob", { invite, key });
  bob.send({ type: "leave_server" });
  assert.equal((await bob.waitFor((m) => m.type === "left")).type, "left");
  await owner.waitFor((m) => m.type === "user_left" && m.session_id === bob.id);
  // Coming back needs an invite again.
  assert.match(await loginError(id, "bob", { key }), /invite/);
  owner.close();
});

test("the owner renames, describes and reorders channels", async () => {
  const { id, owner, invite } = await newServer();
  const bob = await join(id, "bob", { invite });
  const general = channelId(owner, "general");
  bob.send({ type: "update_channel", channel: general, name: "x" });
  assert.match(await errorOf(bob), /owner/i);
  owner.send({ type: "update_channel", channel: general, name: "Main Chat", topic: " Say hi ", category: " Info " });
  const renamed = (await bob.waitFor((m) => m.type === "channels_updated")).channels.find((c) => c.id === general);
  assert.deepEqual(renamed, { id: general, name: "main-chat", kind: "text", topic: "Say hi", category: "Info" });
  const order = owner.welcome.channels.map((c) => c.id).reverse();
  owner.send({ type: "reorder_channels", order });
  const moved = (await bob.waitFor((m) => m.type === "channels_updated")).channels.map((c) => c.id);
  assert.deepEqual(moved, order);
  owner.close();
  bob.close();
});

test("the owner pins messages; everyone can list them", async () => {
  const { id, owner, invite } = await newServer();
  const general = channelId(owner, "general");
  const bob = await join(id, "bob", { invite });
  bob.send({ type: "send_chat", channel: general, text: "remember this" });
  const m = (await owner.waitFor((x) => x.type === "chat")).message;
  bob.send({ type: "pin", channel: general, id: m.id, on: true });
  assert.match(await errorOf(bob), /owner/i);
  owner.send({ type: "pin", channel: general, id: m.id, on: true });
  assert.equal((await bob.waitFor((x) => x.type === "pinned")).on, true);
  bob.send({ type: "get_pins", channel: general });
  const pins = await bob.waitFor((x) => x.type === "pins");
  assert.deepEqual(pins.messages.map((x) => [x.text, x.pinned]), [["remember this", true]]);
  owner.close();
  bob.close();
});

test("the owner deletes a server for everyone", async () => {
  const { id, owner, invite } = await newServer();
  const bob = await join(id, "bob", { invite });
  bob.send({ type: "delete_server" });
  assert.match(await errorOf(bob), /owner/i);
  owner.send({ type: "delete_server" });
  await bob.waitFor((m) => m.type === "server_deleted");
  await owner.waitFor((m) => m.type === "server_deleted");
  // Gone: the invite is dead and nobody can come back.
  assert.equal((await fetch(`${HTTP}/invite/${invite}`)).status, 404);
  assert.match(await loginError(id, "owner", { key: owner.key }), /exist/i);
});

test("roles: moderators moderate, admins run the server, the owner names admins", async () => {
  const { id, owner, invite } = await newServer();
  const ann = await join(id, "ann", { invite });
  const mo = await join(id, "mo", { invite });
  const pat = await join(id, "pat", { invite });
  const general = channelId(owner, "general");

  // Nobody but staff can hand out roles.
  pat.send({ type: "set_role", public_key: mo.key.pub, role: "mod" });
  assert.match(await errorOf(pat), /admins/);

  owner.send({ type: "set_role", public_key: ann.key.pub, role: "admin" });
  const annUpdate = await pat.waitFor((m) => m.type === "user_updated" && m.user.public_key === ann.key.pub);
  assert.equal(annUpdate.user.role, "admin");
  const list = await owner.waitFor((m) => m.type === "members");
  assert.equal(list.members.find((m) => m.public_key === ann.key.pub).role, "admin");
  assert.equal(list.members.find((m) => m.public_key === owner.key.pub).role, "owner");

  // An admin names a moderator but can't make admins.
  ann.send({ type: "set_role", public_key: mo.key.pub, role: "admin" });
  assert.match(await errorOf(ann), /owner/);
  ann.send({ type: "set_role", public_key: mo.key.pub, role: "mod" });
  await pat.waitFor((m) => m.type === "user_updated" && m.user.public_key === mo.key.pub && m.user.role === "mod");

  // A moderator deletes a member's message and pins, but can't manage channels or ban.
  pat.send({ type: "send_chat", channel: general, text: "spam" });
  const spam = (await mo.waitFor((m) => m.type === "chat" && m.message.text === "spam")).message;
  mo.send({ type: "delete_message", channel: general, id: spam.id });
  await pat.waitFor((m) => m.type === "message_deleted" && m.id === spam.id);
  mo.send({ type: "create_channel", name: "nope", kind: "text" });
  assert.match(await errorOf(mo), /admins/);
  mo.send({ type: "ban", session_id: pat.id });
  assert.match(await errorOf(mo), /admins/);

  // Nobody acts on someone of the same rank or above.
  ann.send({ type: "send_chat", channel: general, text: "admin talk" });
  const adminMsg = (await mo.waitFor((m) => m.type === "chat" && m.message.text === "admin talk")).message;
  mo.send({ type: "delete_message", channel: general, id: adminMsg.id });
  assert.match(await errorOf(mo), /own messages/);
  mo.send({ type: "kick", session_id: ann.id });
  assert.match(await errorOf(mo), /same role/);

  // A moderator kicks a member; an admin creates a channel.
  mo.send({ type: "kick", session_id: pat.id });
  await pat.waitFor((m) => m.type === "kicked");
  ann.send({ type: "create_channel", name: "staff", kind: "text" });
  await ann.waitFor((m) => m.type === "channels_updated" && m.channels.some((c) => c.name === "staff"));

  // Roles survive a reconnect.
  mo.close();
  const again = await join(id, "mo", { key: mo.key });
  assert.equal(again.welcome.users.find((u) => u.public_key === mo.key.pub).role, "mod");

  // Handing over the server: the old owner stays as an admin.
  owner.send({ type: "transfer_ownership", public_key: ann.key.pub });
  await again.waitFor((m) => m.type === "user_updated" && m.user.public_key === ann.key.pub && m.user.role === "owner" && m.user.owner);
  await again.waitFor((m) => m.type === "user_updated" && m.user.public_key === owner.key.pub && m.user.role === "admin" && !m.user.owner);
  owner.send({ type: "delete_server" });
  assert.match(await errorOf(owner), /owner/);
  for (const c of [owner, ann, again]) c.close();
});

test("pictures: members upload signed pictures, send them, and they go with the message", async () => {
  const { id, owner, invite } = await newServer();
  const bob = await join(id, "bob", { invite });
  const general = channelId(owner, "general");
  const HTTP = BASE.replace(/^ws/, "http");
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), crypto.randomBytes(200)]);
  const upload = (key, body = webp, { time = Date.now(), sign = key } = {}) => {
    const digest = crypto.createHash("sha256").update(body).digest("hex");
    const signature = crypto.sign(null, Buffer.from(`hopp-image-v1\0${id}\0${digest}\0${time}`), sign.privateKey).toString("hex");
    return fetch(`${HTTP}/servers/${id}/images`, {
      method: "POST",
      headers: { "content-type": "image/webp", "X-Hopp-Key": key.pub, "X-Hopp-Time": String(time), "X-Hopp-Signature": signature },
      body,
    });
  };

  assert.equal((await upload(newKey())).status, 403, "strangers can't upload");
  assert.equal((await upload(bob.key, webp, { sign: newKey() })).status, 401, "a wrong signature is refused");
  assert.equal((await upload(bob.key, webp, { time: Date.now() - 3_600_000 })).status, 401, "an old signature is refused");
  const fake = Buffer.from("<svg onload=alert(1)>");
  const res = await fetch(`${HTTP}/servers/${id}/images`, { method: "POST", headers: { "content-type": "image/webp", "X-Hopp-Key": bob.key.pub, "X-Hopp-Time": String(Date.now()), "X-Hopp-Signature": "00".repeat(64) }, body: fake });
  assert.notEqual(res.status, 200, "non-pictures are refused");

  const ok = await upload(bob.key);
  assert.equal(ok.status, 200);
  const { id: picture } = await ok.json();
  assert.match(picture, /^[0-9a-f]{32}$/);
  const got = await fetch(`${HTTP}/servers/${id}/images/${picture}`);
  assert.equal(got.headers.get("content-type"), "image/webp");
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), webp);

  // Only your own picture can be sent.
  owner.send({ type: "send_chat", channel: general, text: `hopp-image:${picture} 10x10` });
  assert.match(await errorOf(owner), /didn't upload/);
  bob.send({ type: "send_chat", channel: general, text: `hopp-image:${picture} 10x10\nnice view` });
  const sent = (await owner.waitFor((m) => m.type === "chat" && m.message.text.startsWith("hopp-image:"))).message;

  // Deleting the message deletes the picture.
  bob.send({ type: "delete_message", channel: general, id: sent.id });
  await owner.waitFor((m) => m.type === "message_deleted");
  assert.equal((await fetch(`${HTTP}/servers/${id}/images/${picture}`)).status, 404, "a deleted picture is gone");

  // The owner turns pictures off in a channel, then in the whole server.
  owner.send({ type: "update_channel", channel: general, name: "general", topic: null, category: null, no_pictures: true });
  const off = await bob.waitFor((m) => m.type === "channels_updated");
  assert.equal(off.channels.find((c) => c.id === general).no_pictures, true);
  const second = (await (await upload(bob.key)).json()).id;
  bob.send({ type: "send_chat", channel: general, text: `hopp-image:${second} 10x10` });
  assert.match(await errorOf(bob), /turned off here/);
  owner.send({ type: "update_server", name: "Test server", icon: null, pictures_off: true });
  const updated = await bob.waitFor((m) => m.type === "server_updated");
  assert.equal(updated.pictures_off, true);
  assert.equal((await upload(bob.key)).status, 403, "no uploads when pictures are off");
  const late = await join(id, "carol", { invite });
  assert.equal(late.welcome.pictures_off, true);
  late.close();
  owner.close();
  bob.close();
});

test("voice addresses can be IPv6 as well as IPv4", async () => {
  const { id, owner, invite } = await newServer();
  const bob = await join(id, "bob", { invite });
  const lobby = channelId(owner, "Lobby");
  owner.send({ type: "join_voice", channel: lobby });
  await owner.waitFor((m) => m.type === "voice_session");
  owner.send({ type: "voice_endpoint", public: "203.0.113.5:40000", local: ["192.168.1.2:40000", "[2a00:801:210:5c27::1]:40000", "[not:an:addr"] });
  bob.send({ type: "join_voice", channel: lobby });
  const session = await bob.waitFor((m) => m.type === "voice_session");
  const peer = session.peers.find((p) => p.session_id === owner.id);
  assert.deepEqual(peer.local, ["192.168.1.2:40000", "[2a00:801:210:5c27::1]:40000"]);
  owner.close();
  bob.close();
});

test("search finds words in any case across channels, newest first", async () => {
  const { owner } = await newServer();
  assert.ok(owner.welcome.features.includes("search"), "the server says it can search");
  const general = channelId(owner, "general");
  for (const text of ["Raid tonight at eight", "nothing to see here", "100% sure", "who's up for the RAID?"]) {
    owner.send({ type: "send_chat", channel: general, text });
    await owner.waitFor((x) => x.type === "chat" && x.message.text === text);
  }
  owner.send({ type: "search", query: "raid" });
  const found = await owner.waitFor((x) => x.type === "search_results");
  assert.equal(found.query, "raid");
  assert.deepEqual(found.messages.map((m) => m.text), ["who's up for the RAID?", "Raid tonight at eight"]);
  await sleep(450);
  // "%" is a letter here, not a wildcard.
  owner.send({ type: "search", query: "0%" });
  assert.deepEqual((await owner.waitFor((x) => x.type === "search_results")).messages.map((m) => m.text), ["100% sure"]);
  // Too fast in a row: told to wait.
  owner.send({ type: "search", query: "here" });
  assert.match(await errorOf(owner), /too fast/i);
  owner.close();
});

test("screen sharing: a flag for the voice channel, handshakes passed on within it only", async () => {
  const { id, owner, invite } = await newServer();
  assert.ok(owner.welcome.features.includes("screen"));
  const bob = await join(id, "bob", { invite });
  const carol = await join(id, "carol", { invite });
  const lobby = channelId(owner, "Lobby");
  const gaming = channelId(owner, "Gaming");
  owner.send({ type: "set_sharing", on: true });
  assert.match(await errorOf(owner), /voice channel/);
  for (const [c, ch] of [[owner, lobby], [bob, lobby], [carol, gaming]]) {
    c.send({ type: "join_voice", channel: ch });
    await c.waitFor((m) => m.type === "voice_session");
  }
  owner.send({ type: "set_sharing", on: true });
  const me = owner.welcome.session_id;
  await bob.waitFor((m) => m.type === "user_updated" && m.user.session_id === me && m.user.sharing === true);
  owner.send({ type: "screen_signal", to: carol.welcome.session_id, data: "wrong room" });
  owner.send({ type: "screen_signal", to: bob.welcome.session_id, data: "offer" });
  const got = await bob.waitFor((m) => m.type === "screen_signal");
  assert.deepEqual(got, { type: "screen_signal", from: me, data: "offer" });
  await sleep(200);
  assert.ok(!carol.inbox.some((m) => m.type === "screen_signal"), "nothing crosses into another channel");
  owner.send({ type: "leave_voice" });
  await bob.waitFor((m) => m.type === "user_updated" && m.user.session_id === me && m.user.sharing === false && m.user.voice_channel === null);
  for (const c of [owner, bob, carol]) c.close();
});

test("voice channels have their own chat, without unread marks for everyone", async () => {
  const { id, owner, invite } = await newServer();
  assert.ok(owner.welcome.features.includes("voice-chat"));
  const lobby = channelId(owner, "Lobby");
  owner.send({ type: "send_chat", channel: lobby, text: "anyone hear me?" });
  const got = await owner.waitFor((m) => m.type === "chat");
  assert.equal(got.message.channel, lobby);
  const bob = await join(id, "bob", { invite });
  const history = await bob.waitFor((m) => m.type === "chat_history" && m.channel === lobby);
  assert.deepEqual(history.messages.map((m) => m.text), ["anyone hear me?"]);
  owner.close();
  bob.close();
});

test("timeouts, slowmode, bans that delete history, and the audit log", async () => {
  const { id, owner, invite } = await newServer();
  assert.ok(owner.welcome.features.includes("mod-tools"));
  const general = channelId(owner, "general");
  const bob = await join(id, "bob", { invite });
  const bobId = bob.welcome.session_id;
  // A timeout: bob can't write or join voice.
  owner.send({ type: "timeout", session_id: bobId, minutes: 10 });
  const marked = await bob.waitFor((m) => m.type === "user_updated" && m.user.session_id === bobId && m.user.timed_out_until);
  assert.ok(marked.user.timed_out_until > Date.now());
  bob.send({ type: "send_chat", channel: general, text: "hello?" });
  assert.match(await errorOf(bob), /timed out/);
  bob.send({ type: "join_voice", channel: channelId(owner, "Lobby") });
  assert.match(await errorOf(bob), /timed out/);
  owner.send({ type: "timeout", session_id: bobId, minutes: 0 });
  await bob.waitFor((m) => m.type === "user_updated" && m.user.session_id === bobId && !m.user.timed_out_until);
  // Slowmode: a member waits between messages; the owner doesn't.
  owner.send({ type: "update_channel", channel: general, name: "general", slowmode: 30 });
  await bob.waitFor((m) => m.type === "channels_updated" && m.channels.find((c) => c.id === general).slowmode === 30);
  bob.send({ type: "send_chat", channel: general, text: "one" });
  await bob.waitFor((m) => m.type === "chat" && m.message.text === "one");
  bob.send({ type: "send_chat", channel: general, text: "two" });
  assert.match(await errorOf(bob), /Slowmode/);
  // A ban that deletes the last day of their messages.
  owner.send({ type: "ban", session_id: bobId, delete_hours: 24 });
  const gone = await owner.waitFor((m) => m.type === "message_deleted");
  assert.equal(gone.channel, general);
  // The audit log has it all, newest first.
  owner.send({ type: "get_audit_log" });
  const log = await owner.waitFor((m) => m.type === "audit_log");
  assert.deepEqual(log.entries.map((e) => e.action), ["ban", "update_channel", "untimeout", "timeout"]);
  assert.equal(log.entries[0].detail, "deleted 1 messages");
  assert.equal(log.entries[3].detail, "10 minutes");
  owner.close();
  bob.close();
});

test("roles: colours and levels, and private channels nobody else sees", async () => {
  const { id, owner, invite } = await newServer();
  assert.ok(owner.welcome.features.includes("roles"));
  const general = channelId(owner, "general");
  const bob = await join(id, "bob", { invite });
  const carol = await join(id, "carol", { invite });
  const bobKey = bob.key.pub;
  // A role with moderator rights.
  owner.send({ type: "create_role", name: "Crew", color: "#46a758", hoist: true, level: "mod" });
  const made = await bob.waitFor((m) => m.type === "roles_updated");
  const crew = made.roles[0];
  assert.deepEqual([crew.name, crew.color, crew.hoist, crew.level], ["Crew", "#46a758", true, "mod"]);
  // Bob can't hand out roles; the owner can.
  bob.send({ type: "assign_role", public_key: bobKey, role: crew.id, on: true });
  assert.match(await errorOf(bob), /admins/);
  owner.send({ type: "assign_role", public_key: bobKey, role: crew.id, on: true });
  const marked = await carol.waitFor((m) => m.type === "user_updated" && m.user.public_key === bobKey && m.user.roles?.includes(crew.id));
  assert.equal(marked.user.role, "mod", "the role's level counts");
  // A private channel for Crew only.
  owner.send({ type: "create_channel", name: "crew-only", kind: "text" });
  const listed = await owner.waitFor((m) => m.type === "channels_updated" && m.channels.some((c) => c.name === "crew-only"));
  const secret = listed.channels.find((c) => c.name === "crew-only").id;
  owner.send({ type: "update_channel", channel: secret, name: "crew-only", private_roles: [crew.id] });
  await carol.waitFor((m) => m.type === "channels_updated" && !m.channels.some((c) => c.id === secret));
  await bob.waitFor((m) => m.type === "chat_history" && m.channel === secret);
  bob.send({ type: "send_chat", channel: secret, text: "crew plans" });
  await bob.waitFor((m) => m.type === "chat" && m.message.text === "crew plans");
  owner.send({ type: "send_chat", channel: general, text: "public hello" });
  await carol.waitFor((m) => m.type === "chat" && m.message.text === "public hello");
  assert.ok(!carol.inbox.some((m) => m.type === "chat" && m.message.channel === secret), "carol never gets the private messages");
  carol.send({ type: "load_older", channel: secret, before: 1e9 });
  assert.match(await errorOf(carol), /doesn't exist/);
  carol.send({ type: "search", query: "crew plans" });
  assert.deepEqual((await carol.waitFor((m) => m.type === "search_results")).messages, []);
  for (const c of [owner, bob, carol]) c.close();
});

test("resync: a connection kept in the background gets its channels again", async () => {
  const { id, owner, invite } = await newServer();
  assert.ok(owner.welcome.features.includes("resync"));
  const general = channelId(owner, "general");
  const bob = await join(id, "bob", { invite });
  owner.send({ type: "send_chat", channel: general, text: "while you were away" });
  await bob.waitFor((m) => m.type === "chat" && m.message.text === "while you were away");
  bob.inbox = [];
  bob.send({ type: "resync" });
  const again = await bob.waitFor((m) => m.type === "chat_history" && m.channel === general);
  assert.ok(again.messages.some((m) => m.text === "while you were away"));
  owner.close();
  bob.close();
});

test("nicknames: your own, a moderator's for others, kept for next time, shown on new messages", async () => {
  const { id, owner, invite } = await newServer();
  assert.ok(owner.welcome.features.includes("nicknames"));
  const general = channelId(owner, "general");
  const bob = await join(id, "bob", { invite });
  const bobKey = bob.key.pub;
  // Bob names himself.
  bob.send({ type: "set_nickname", public_key: bobKey, nick: "Bobby" });
  const renamed = await owner.waitFor((m) => m.type === "user_updated" && m.user.public_key === bobKey && m.user.name === "Bobby");
  assert.equal(renamed.user.name, "Bobby");
  bob.send({ type: "send_chat", channel: general, text: "hi" });
  const msg = await owner.waitFor((m) => m.type === "chat" && m.message.text === "hi");
  assert.equal(msg.message.sender_name, "Bobby", "new messages carry the nickname");
  // Bob can't rename the owner; the owner can rename Bob.
  bob.send({ type: "set_nickname", public_key: owner.key.pub, nick: "Boss" });
  assert.match(await errorOf(bob), /moderator|admin|owner|can't/i);
  owner.send({ type: "set_nickname", public_key: bobKey, nick: "Robert" });
  await bob.waitFor((m) => m.type === "user_updated" && m.user.public_key === bobKey && m.user.name === "Robert");
  // Kept: back next time with it.
  bob.close();
  await new Promise((r) => setTimeout(r, 200));
  const again = await join(id, "bob", { key: bob.key });
  assert.equal(again.welcome.users.find((u) => u.public_key === bobKey).name, "Robert");
  // The members list shows both names; the audit log has it.
  owner.send({ type: "get_members" });
  const members = await owner.waitFor((m) => m.type === "members");
  const row = members.members.find((m) => m.public_key === bobKey);
  assert.deepEqual([row.name, row.nick, row.account_name], ["Robert", "Robert", "bob"]);
  owner.send({ type: "get_audit_log" });
  assert.equal((await owner.waitFor((m) => m.type === "audit_log")).entries[0].action, "nickname");
  // Empty resets it.
  again.send({ type: "set_nickname", public_key: bobKey, nick: null });
  await owner.waitFor((m) => m.type === "user_updated" && m.user.public_key === bobKey && m.user.name === "bob");
  owner.close();
  again.close();
});

test("floods are held back: reactions and anything else sent far too fast", async () => {
  const { owner } = await newServer();
  const general = channelId(owner, "general");
  owner.send({ type: "send_chat", channel: general, text: "react to this" });
  const posted = await owner.waitFor((m) => m.type === "chat");
  // A burst of reactions: the first ones go through, then a polite no.
  for (let i = 0; i < 20; i++) owner.send({ type: "react", channel: general, id: posted.message.id, emoji: "👍", on: i % 2 === 0 });
  assert.match(await errorOf(owner), /too fast/);
  // A flood of anything is simply dropped: far fewer answers than questions.
  let answers = 0;
  owner.ws.addEventListener("message", (e) => { if (JSON.parse(e.data).type === "pins") answers++; });
  for (let i = 0; i < 200; i++) owner.send({ type: "get_pins", channel: general });
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(answers >= 20 && answers < 120, `answers ${answers}`);
  owner.close();
});
