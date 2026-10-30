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

test("names belong to their Ström ID", async () => {
  const { id, owner, invite } = await newServer();
  (await join(id, "alice", { invite })).close();
  assert.match(await loginError(id, "ALICE", { invite }), /already taken/);
  owner.close();
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

test("reconnecting replaces a session that never closed", async () => {
  const { id, owner, invite } = await newServer();
  const key = newKey();
  const stale = await join(id, "bob", { key, invite });
  const fresh = await join(id, "bob", { key });
  assert.match(await errorOf(stale), /somewhere else/);
  await owner.waitFor((m) => m.type === "user_left" && m.session_id === stale.id);
  assert.ok(fresh.welcome.users.some((u) => u.session_id === fresh.id));
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
  assert.deepEqual(update, { type: "server_updated", name: "The Crew", icon });

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
  owner.send({ type: "send_chat", channel: channelId(owner, "Lobby"), text: "voice has no chat" });
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
  (await join(id, "bob", { key: bobKey })).close();

  owner.send({ type: "ban", session_id: carol.id });
  assert.deepEqual(await carol.waitFor((m) => m.type === "kicked"), { type: "kicked", banned: true });
  await sleep(100);
  assert.match(await loginError(id, "carol", { key: carolKey, invite }), /banned/);

  owner.send({ type: "unban", public_key: carolKey.pub });
  await owner.waitFor((m) => m.type === "bans" && m.bans.length === 0);
  (await join(id, "carol", { key: carolKey })).close();
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
  owner.send({ type: "update_channel", channel: general, name: "Main Chat", topic: " Say hi " });
  const renamed = (await bob.waitFor((m) => m.type === "channels_updated")).channels.find((c) => c.id === general);
  assert.deepEqual(renamed, { id: general, name: "main-chat", kind: "text", topic: "Say hi" });
  const order = owner.welcome.channels.map((c) => c.id).reverse();
  owner.send({ type: "reorder_channels", order });
  const moved = (await bob.waitFor((m) => m.type === "channels_updated")).channels.map((c) => c.id);
  assert.deepEqual(moved, order);
  owner.close();
  bob.close();
});
