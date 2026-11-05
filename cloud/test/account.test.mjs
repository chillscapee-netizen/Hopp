// Accounts, usernames, sync across devices and friends, against a running Worker
// (`npx wrangler dev`), with real Ed25519 keys like the app.
//
//   STROM_CLOUD_URL=ws://127.0.0.1:8787 node test/account.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const BASE = process.env.STROM_CLOUD_URL ?? "ws://127.0.0.1:8787";
const HTTP = BASE.replace(/^ws/, "http");
const WAIT_MS = 3000;

function newKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  return { pub, privateKey };
}

const authMessage = (nonceHex) => Buffer.concat([Buffer.from("strom-auth-v1\0"), Buffer.from(nonceHex, "hex")]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unique = (prefix) => `${prefix}${crypto.randomBytes(4).toString("hex")}`;

class Device {
  constructor(ws) {
    this.ws = ws;
    this.inbox = [];
    this.waiters = [];
    // Everything received, for checks that don't care about order.
    this.log = [];
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      this.log.push(msg);
      const waiter = this.waiters.shift();
      if (waiter) waiter(msg);
      else this.inbox.push(msg);
    });
  }

  static async open(key, displayName = "Tester") {
    const ws = new WebSocket(`${BASE}/account/ws?key=${key.pub}`);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("could not connect; is `npx wrangler dev` running?")), { once: true });
    });
    const d = new Device(ws);
    d.send({ type: "hello", public_key: key.pub, protocol: 1 });
    const challenge = await d.next();
    assert.equal(challenge.type, "challenge", JSON.stringify(challenge));
    const signature = crypto.sign(null, authMessage(challenge.nonce), key.privateKey).toString("hex");
    d.send({ type: "auth", signature, display_name: displayName });
    d.welcome = await d.next();
    assert.equal(d.welcome.type, "welcome", JSON.stringify(d.welcome));
    return d;
  }

  next() {
    if (this.inbox.length) return Promise.resolve(this.inbox.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(done), 1);
        reject(new Error("timed out waiting for a message"));
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

  /** Received at any point, earlier or still to come. */
  async saw(pred) {
    if (this.log.some(pred)) return this.log.find(pred);
    return this.waitFor(pred);
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.ws.close();
  }
}

async function userWithName(prefix) {
  const key = newKey();
  const d = await Device.open(key, prefix);
  const name = unique(prefix);
  d.send({ type: "claim_username", name });
  await d.waitFor((m) => m.type === "profile" && m.me.username === name);
  return { key, d, name };
}

test("a new account starts empty and picks a unique username", async () => {
  const key = newKey();
  const d = await Device.open(key, "Bingu");
  assert.equal(d.welcome.me.key, key.pub);
  assert.equal(d.welcome.me.display_name, "Bingu");
  assert.equal(d.welcome.me.username, null);
  assert.deepEqual(d.welcome.sync, { data: null, version: 0 });
  assert.deepEqual(d.welcome.friends, []);

  d.send({ type: "claim_username", name: "Bad Name" });
  assert.match((await d.waitFor((m) => m.type === "error")).message, /lowercase/);
  d.send({ type: "claim_username", name: "admin" });
  assert.match((await d.waitFor((m) => m.type === "error")).message, /reserved/);

  const name = unique("bingu");
  d.send({ type: "check_username", name });
  assert.equal((await d.waitFor((m) => m.type === "username_check")).ok, true);
  d.send({ type: "claim_username", name });
  assert.equal((await d.waitFor((m) => m.type === "profile")).me.username, name);

  const other = await Device.open(newKey());
  other.send({ type: "claim_username", name });
  assert.match((await other.waitFor((m) => m.type === "error")).message, /taken/);

  const profile = await (await fetch(`${HTTP}/users/${name}`)).json();
  assert.equal(profile.key, key.pub);
  assert.equal(profile.display_name, "Bingu");
  assert.equal((await fetch(`${HTTP}/users/${unique("nobody")}`)).status, 404);
  d.close();
  other.close();
});

test("every device sees the same account data, and stale writes are refused", async () => {
  const key = newKey();
  const a = await Device.open(key);
  const b = await Device.open(key);
  a.send({ type: "set_sync", data: "sealed-1", base_version: 0 });
  assert.equal((await a.waitFor((m) => m.type === "sync_saved")).version, 1);
  const seen = await b.waitFor((m) => m.type === "sync");
  assert.deepEqual([seen.data, seen.version], ["sealed-1", 1]);

  // b hasn't merged a newer copy: it's told about the newer one instead of overwriting it.
  b.send({ type: "set_sync", data: "sealed-old", base_version: 0 });
  const conflict = await b.waitFor((m) => m.type === "sync" && m.conflict);
  assert.deepEqual([conflict.data, conflict.version], ["sealed-1", 1]);

  const c = await Device.open(key);
  assert.deepEqual(c.welcome.sync, { data: "sealed-1", version: 1 });
  for (const d of [a, b, c]) d.close();
});

test("friend requests, accepting, presence and removing", async () => {
  const alice = await userWithName("alice");
  const bob = await userWithName("bob");

  alice.d.send({ type: "friend_request", username: bob.name });
  const out = await alice.d.waitFor((m) => m.type === "friend");
  assert.equal(out.friend.state, "outgoing");
  const incoming = await bob.d.waitFor((m) => m.type === "friend");
  assert.deepEqual([incoming.friend.state, incoming.friend.username, incoming.request], ["incoming", alice.name, true]);

  bob.d.send({ type: "friend_accept", key: alice.key.pub });
  assert.equal((await bob.d.waitFor((m) => m.type === "friend")).friend.state, "friend");
  const accepted = await alice.d.waitFor((m) => m.type === "friend" && m.friend.state === "friend");
  assert.equal(accepted.accepted, true);
  // Both see each other online.
  await alice.d.saw((m) => m.type === "presence" && m.key === bob.key.pub && m.status === "online");
  await bob.d.saw((m) => m.type === "presence" && m.key === alice.key.pub && m.status === "online");

  // Status and activity reach friends; invisible looks offline.
  alice.d.send({ type: "set_activity", activity: "In voice: Lobby" });
  const act = await bob.d.waitFor((m) => m.type === "presence" && m.activity);
  assert.equal(act.activity, "In voice: Lobby");
  alice.d.send({ type: "set_status", status: "invisible" });
  await bob.d.waitFor((m) => m.type === "presence" && m.key === alice.key.pub && m.status === "offline");
  alice.d.send({ type: "set_status", status: "dnd" });
  await bob.d.waitFor((m) => m.type === "presence" && m.status === "dnd");

  // Leaving takes you offline for friends.
  alice.d.close();
  await bob.d.waitFor((m) => m.type === "presence" && m.key === alice.key.pub && m.status === "offline");

  // Friends survive reconnecting, and removing is mutual.
  const again = await Device.open(alice.key);
  assert.equal(again.welcome.friends.find((f) => f.key === bob.key.pub).state, "friend");
  bob.d.send({ type: "friend_remove", key: alice.key.pub });
  await again.waitFor((m) => m.type === "friend_removed" && m.key === bob.key.pub);
  again.close();
  bob.d.close();
});

test("asking each other at the same time makes you friends at once", async () => {
  const a = await userWithName("ann");
  const b = await userWithName("ben");
  a.d.send({ type: "friend_request", username: b.name });
  await b.d.waitFor((m) => m.type === "friend" && m.friend.state === "incoming");
  b.d.send({ type: "friend_request", username: a.name });
  assert.equal((await b.d.waitFor((m) => m.type === "friend" && m.friend.key === a.key.pub)).friend.state, "friend");
  assert.equal((await a.d.waitFor((m) => m.type === "friend" && m.friend.state === "friend")).friend.key, b.key.pub);
  a.d.close();
  b.d.close();
});

test("privacy settings and blocking stop requests without telling why", async () => {
  const quiet = await userWithName("quiet");
  const asker = await userWithName("asker");
  quiet.d.send({ type: "set_privacy", requests: "nobody" });
  await quiet.d.waitFor((m) => m.type === "privacy");
  asker.d.send({ type: "friend_request", username: quiet.name });
  assert.match((await asker.d.waitFor((m) => m.type === "error")).message, /aren't accepting/);

  quiet.d.send({ type: "set_privacy", requests: "everyone" });
  await quiet.d.waitFor((m) => m.type === "privacy");
  quiet.d.send({ type: "block", key: asker.key.pub });
  assert.equal((await quiet.d.waitFor((m) => m.type === "friend")).friend.state, "blocked");
  asker.d.send({ type: "friend_request", username: quiet.name });
  assert.match((await asker.d.waitFor((m) => m.type === "error")).message, /aren't accepting/);

  // A username is needed to ask anyone.
  const anon = await Device.open(newKey());
  anon.send({ type: "friend_request", username: quiet.name });
  assert.match((await anon.waitFor((m) => m.type === "error")).message, /username first/);
  for (const d of [quiet.d, asker.d, anon]) d.close();
});

test("profiles: name, bio and picture reach friends", async () => {
  const a = await userWithName("pic");
  const b = await userWithName("viewer");
  a.d.send({ type: "friend_request", username: b.name });
  await b.d.waitFor((m) => m.type === "friend");
  b.d.send({ type: "friend_accept", key: a.key.pub });
  await a.d.waitFor((m) => m.type === "friend" && m.friend.state === "friend");

  const avatar = "data:image/png;base64,iVBORw0KGgo=";
  a.d.send({ type: "set_profile", display_name: "Picture Person", bio: "hi", avatar });
  await a.d.waitFor((m) => m.type === "profile" && m.me.avatar === avatar);
  const seen = await b.d.waitFor((m) => m.type === "friend" && m.friend.display_name === "Picture Person");
  assert.equal(seen.friend.avatar, avatar);
  a.d.send({ type: "set_profile", avatar: "data:image/svg+xml;base64,PHN2Zz4=" });
  assert.match((await a.d.waitFor((m) => m.type === "error")).message, /picture/);
  a.d.close();
  b.d.close();
});

test("direct messages between friends: delivered to every device, kept, read state", async () => {
  const a = await userWithName("dma");
  const b = await userWithName("dmb");
  const stranger = await userWithName("dmc");
  a.d.send({ type: "friend_request", username: b.name });
  await b.d.waitFor((m) => m.type === "friend");
  b.d.send({ type: "friend_accept", key: a.key.pub });
  await a.d.saw((m) => m.type === "friend" && m.friend.state === "friend");
  const a2 = await Device.open(a.key);

  a.d.send({ type: "dm_send", to: b.key.pub, sealed: "abcd01", nonce: "n1" });
  const mine = await a.d.waitFor((m) => m.type === "dm");
  assert.equal(mine.nonce, "n1");
  assert.equal(mine.message.from_key, a.key.pub);
  const other = await a2.waitFor((m) => m.type === "dm");
  assert.equal(other.message.id, mine.message.id);
  const theirs = await b.d.waitFor((m) => m.type === "dm");
  assert.deepEqual([theirs.with, theirs.message.sealed], [a.key.pub, "abcd01"]);

  b.d.send({ type: "dm_history", with: a.key.pub });
  const history = await b.d.waitFor((m) => m.type === "dm_history");
  assert.equal(history.messages.length, 1);
  const again = await Device.open(b.key);
  const conv = again.welcome.conversations.find((c) => c.peer === a.key.pub);
  assert.ok(conv.last_at > conv.last_read, "unread until read");
  b.d.send({ type: "dm_read", with: a.key.pub, at: conv.last_at });
  await again.waitFor((m) => m.type === "dm_read");

  stranger.d.send({ type: "dm_send", to: b.key.pub, sealed: "beef", nonce: "x" });
  assert.match((await stranger.d.waitFor((m) => m.type === "error")).message, /friends/);
  a.d.send({ type: "dm_send", to: b.key.pub, sealed: "not hex!" });
  assert.match((await a.d.waitFor((m) => m.type === "error")).message, /can't be sent/);
  for (const d of [a.d, a2, b.d, again, stranger.d]) d.close();
});

// ---------- server channels: unread and mentions ----------

/** Joins a cloud server (creating it with `create`), over the server protocol. */
async function joinServer(serverId, name, key, { invite, create } = {}) {
  const ws = new WebSocket(`${BASE}/servers/${serverId}/ws`);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  const c = new Device(ws);
  c.send({ type: "hello", name, protocol_version: 5, public_key: key.pub, invite, create });
  const challenge = await c.next();
  c.send({ type: "auth", signature: crypto.sign(null, authMessage(challenge.nonce), key.privateKey).toString("hex") });
  c.welcome = await c.next();
  assert.equal(c.welcome.type, "welcome", JSON.stringify(c.welcome));
  return c;
}

test("server messages mark channels unread on every member's account, and mentions count", async () => {
  const serverId = crypto.randomBytes(12).toString("hex");
  const alice = newKey();
  const bob = newKey();
  const owner = await joinServer(serverId, "alice", alice, { create: "Unread test" });
  assert.equal(owner.welcome.users[0].public_key, alice.pub);
  owner.send({ type: "create_invite", max_uses: null, expires_in_hours: null });
  const { invite } = await owner.waitFor((m) => m.type === "invite_created");
  const member = await joinServer(serverId, "bob", bob, { invite: invite.code });
  const general = owner.welcome.channels.find((c) => c.name === "general").id;
  const server = `cloud:${serverId}`;

  // Alice is elsewhere in the app now (not in the server), with her account connected.
  owner.close();
  await sleep(200);
  const account = await Device.open(alice, "Alice");
  member.send({ type: "send_chat", channel: general, text: "plain message" });
  const plain = await account.waitFor((m) => m.type === "channel_activity");
  assert.equal(plain.server, server);
  assert.equal(plain.channel, general);
  assert.equal(plain.mention, false);
  assert.equal(plain.mentions, 0);
  assert.ok(plain.last_id > plain.read_id);

  member.send({ type: "send_chat", channel: general, text: `hey <@${alice.pub}> look` });
  const mention = await account.waitFor((m) => m.type === "channel_activity" && m.mention);
  assert.equal(mention.mentions, 1);
  assert.equal(mention.preview, "hey @alice look");
  assert.equal(mention.author_name, "bob");
  assert.equal(mention.server_name, "Unread test");

  // It's there on the next login too, and reading clears it on every device.
  const again = await Device.open(alice, "Alice");
  const row = again.welcome.channels.find((c) => c.server === server && c.channel === general);
  assert.equal(row.mentions, 1);
  again.send({ type: "channel_read", server, channel: general, id: mention.last_id });
  const read = await account.waitFor((m) => m.type === "channel_read");
  assert.equal(read.read_id, mention.last_id);
  assert.equal(read.mentions, 0);

  // Further news in that channel costs nothing until Alice has been back in the server.
  member.send({ type: "send_chat", channel: general, text: "more chatter" });
  await sleep(400);
  account.inbox = account.inbox.filter((m) => m.type !== "channel_activity");
  member.send({ type: "send_chat", channel: general, text: "and more" });
  await sleep(400);
  assert.ok(!account.inbox.some((m) => m.type === "channel_activity"), "no second notice before Alice comes back");
  const back = await joinServer(serverId, "alice", alice);
  back.close();
  await sleep(200);
  member.send({ type: "send_chat", channel: general, text: "after your visit" });
  const fresh = await account.waitFor((m) => m.type === "channel_activity");
  assert.equal(fresh.mention, false);

  // Pictures for people in servers: anyone's public profile by Hopp ID.
  const profile = await (await fetch(`${HTTP}/profiles/${alice.pub}`)).json();
  assert.equal(profile.key, alice.pub);
  assert.equal(profile.display_name, "Alice");
  for (const d of [member, account, again]) d.close();
});

test("people in the server aren't sent unread marks, only mentions", async () => {
  const serverId = crypto.randomBytes(12).toString("hex");
  const alice = newKey();
  const bob = newKey();
  const owner = await joinServer(serverId, "alice", alice, { create: "Busy server" });
  owner.send({ type: "create_invite", max_uses: null, expires_in_hours: null });
  const { invite } = await owner.waitFor((m) => m.type === "invite_created");
  const member = await joinServer(serverId, "bob", bob, { invite: invite.code });
  const general = owner.welcome.channels.find((c) => c.name === "general").id;
  const account = await Device.open(alice, "Alice");
  member.send({ type: "send_chat", channel: general, text: "you see this live" });
  await owner.waitFor((m) => m.type === "chat");
  member.send({ type: "send_chat", channel: general, text: `but <@${alice.pub}> pings reach your account` });
  const first = await account.waitFor((m) => m.type === "channel_activity");
  assert.equal(first.mention, true);
  for (const d of [owner, member, account]) d.close();
});

test("calls between friends: ring, answer, endpoints, end; strangers and offline friends", async () => {
  const a = await userWithName("caller");
  const b = await userWithName("callee");
  const id = "0f1e2d3c-4b5a";
  a.d.send({ type: "call", to: b.key.pub, call_id: id, kind: "ring", sealed: "ab".repeat(30) });
  assert.match((await a.d.waitFor((m) => m.type === "error")).message, /only call friends/);

  a.d.send({ type: "friend_request", username: b.name });
  await b.d.waitFor((m) => m.type === "friend");
  b.d.send({ type: "friend_accept", key: a.key.pub });
  await a.d.waitFor((m) => m.type === "friend" && m.friend.state === "friend");

  const b2 = await Device.open(b.key, "Callee");
  a.d.send({ type: "call", to: b.key.pub, call_id: id, kind: "ring", sealed: "ab".repeat(30) });
  const ring = await b.d.waitFor((m) => m.type === "call");
  assert.deepEqual(ring, { type: "call", from: a.key.pub, kind: "ring", call_id: id, sealed: "ab".repeat(30) });
  await b2.waitFor((m) => m.type === "call" && m.kind === "ring");

  b.d.send({ type: "call", to: a.key.pub, call_id: id, kind: "answer" });
  assert.equal((await a.d.waitFor((m) => m.type === "call")).kind, "answer");
  // The other device stops ringing.
  assert.equal((await b2.waitFor((m) => m.type === "call_self")).kind, "answer");

  b.d.send({ type: "call", to: a.key.pub, call_id: id, kind: "endpoint", public: "1.2.3.4:5000", local: ["192.168.1.2:5000", "evil"] });
  const ep = await a.d.waitFor((m) => m.type === "call" && m.kind === "endpoint");
  assert.equal(ep.public, "1.2.3.4:5000");
  assert.deepEqual(ep.local, ["192.168.1.2:5000"]);

  a.d.send({ type: "call", to: b.key.pub, call_id: id, kind: "end" });
  assert.equal((await b.d.waitFor((m) => m.type === "call" && m.kind === "end")).call_id, id);

  // Nobody home: the caller hears so at once.
  b.d.close();
  b2.close();
  await sleep(200);
  a.d.send({ type: "call", to: b.key.pub, call_id: "aaaabbbbcccc", kind: "ring", sealed: "cd".repeat(30) });
  assert.equal((await a.d.waitFor((m) => m.type === "call")).kind, "offline");
  a.d.close();
});

test("group conversations: create, send to everyone, rename, leave", async () => {
  const a = await userWithName("ga");
  const b = await userWithName("gb");
  const c = await userWithName("gc");
  for (const x of [b, c]) {
    a.d.send({ type: "friend_request", username: x.name });
    await x.d.waitFor((m) => m.type === "friend");
    x.d.send({ type: "friend_accept", key: a.key.pub });
    await a.d.waitFor((m) => m.type === "friend" && m.friend.key === x.key.pub && m.friend.state === "friend");
  }
  a.d.send({ type: "group_create", members: [b.key.pub, c.key.pub], name: "Raid crew" });
  const { group } = await a.d.waitFor((m) => m.type === "group");
  assert.equal(group.name, "Raid crew");
  assert.deepEqual(group.members, [a.key.pub, b.key.pub, c.key.pub]);
  // b and c aren't friends with each other, but they're in the group together.
  assert.equal((await c.d.waitFor((m) => m.type === "group")).group.id, group.id);

  const sealed = { [a.key.pub]: "aa", [b.key.pub]: "bb", [c.key.pub]: "cc" };
  a.d.send({ type: "group_send", group: group.id, sealed, nonce: "n1" });
  assert.equal((await b.d.waitFor((m) => m.type === "dm" && m.with === group.id)).message.sealed, "bb");
  assert.equal((await c.d.waitFor((m) => m.type === "dm" && m.with === group.id)).message.sealed, "cc");
  const mine = await a.d.waitFor((m) => m.type === "dm" && m.with === group.id);
  assert.equal(mine.message.sealed, "aa");
  assert.equal(mine.nonce, "n1");

  // c (not b's friend) can write to the group too.
  c.d.send({ type: "group_send", group: group.id, sealed: { ...sealed, [c.key.pub]: "c2" }, nonce: "n2" });
  assert.equal((await b.d.waitFor((m) => m.type === "dm" && m.with === group.id)).message.from_key, c.key.pub);

  b.d.send({ type: "group_update", group: group.id, name: "Night crew" });
  assert.equal((await a.d.waitFor((m) => m.type === "group" && m.group.name === "Night crew")).group.id, group.id);

  c.d.send({ type: "group_leave", group: group.id });
  await c.d.waitFor((m) => m.type === "group_removed");
  const after = await a.d.waitFor((m) => m.type === "group" && m.group.members.length === 2);
  assert.deepEqual(after.group.members, [a.key.pub, b.key.pub]);

  const again = await Device.open(a.key, "A");
  assert.equal(again.welcome.groups[0].id, group.id);
  for (const d of [a.d, b.d, c.d, again]) d.close();
});

test("an account creates at most ten servers a day", async () => {
  const key = newKey();
  for (let i = 0; i < 10; i++) (await joinServer(crypto.randomBytes(12).toString("hex"), "maker", key, { create: "S" + i })).close();
  const ws = new WebSocket(`${BASE}/servers/${crypto.randomBytes(12).toString("hex")}/ws`);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  const c = new Device(ws);
  c.send({ type: "hello", name: "maker", protocol_version: 5, public_key: key.pub, create: "one too many" });
  const challenge = await c.next();
  c.send({ type: "auth", signature: crypto.sign(null, authMessage(challenge.nonce), key.privateKey).toString("hex") });
  const reply = await c.next();
  c.close();
  assert.equal(reply.type, "error");
  assert.match(reply.message, /lot of servers today/);
});

test("DM pictures: only the account's owner stores them, and they come back as stored", async () => {
  const me = newKey();
  const device = await Device.open(me, "Pic");
  const HTTP = BASE.replace(/^ws/, "http");
  const noise = crypto.randomBytes(500);
  const upload = (key, sign = key, time = Date.now()) => {
    const digest = crypto.createHash("sha256").update(noise).digest("hex");
    const signature = crypto.sign(null, Buffer.from(`hopp-image-v1\0account:${me.pub}\0${digest}\0${time}`), sign.privateKey).toString("hex");
    return fetch(`${HTTP}/accounts/${me.pub}/images`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "X-Hopp-Key": key.pub, "X-Hopp-Time": String(time), "X-Hopp-Signature": signature },
      body: noise,
    });
  };
  assert.equal((await upload(newKey())).status, 401, "someone else can't store pictures in my account");
  assert.equal((await upload(me, newKey())).status, 401, "a wrong signature is refused");
  const ok = await upload(me);
  assert.equal(ok.status, 200);
  const { id } = await ok.json();
  const back = await fetch(`${HTTP}/accounts/${me.pub}/images/${id}`);
  assert.deepEqual(Buffer.from(await back.arrayBuffer()), noise);
  assert.equal((await fetch(`${HTTP}/accounts/${me.pub}/images/${"0".repeat(32)}`)).status, 404);
  device.close();
});
