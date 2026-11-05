// Accounts: one Durable Object per Hopp ID (named by its public key) holds the
// profile, the encrypted account data every device syncs (server list, folders,
// settings), friends, and the presence friends see. Any number of devices can be
// connected at once. A global directory maps unique usernames to keys.
//
// Account objects talk to each other directly (friend requests, presence), so a
// request reaches someone even while they're offline.

import { DurableObject } from "cloudflare:workers";
import { troubleMessage } from "./trouble";
import { budgetBytes, LOGIN_TTL_S, LOGINS_PER_DAY, monthUsage, newLogin, relayConfigured, revoke, USAGE_FRESH_MS, USAGE_TRUSTED_MS, type TurnLogin } from "./relay";
import type { Env } from "./index";

const ACCOUNT_PROTOCOL = 1;
const MAX_DISPLAY_NAME = 32;
/** New servers per account per day, so a script can't fill the cloud. */
const MAX_NEW_SERVERS_PER_DAY = 10;
/** Relay logins per account per day; each lasts a day, so one is usually plenty. */
const RELAY_LOGINS_PER_DAY = 12;
const MAX_BIO = 190;
const MAX_ACTIVITY = 80;
/** Small pictures only: 128 px WebP is about 10 KB. */
const MAX_AVATAR = 40_000;
const MAX_SYNC = 262_144;
const FRIEND_REQUESTS_PER_DAY = 30;
/** A username given up stays reserved for its old owner this long, so it can't be hijacked. */
const NAME_HOLD_MS = 14 * 24 * 3_600_000;
const RESERVED = new Set(["admin", "administrator", "strom", "ström", "support", "system", "everyone", "here", "moderator", "owner", "staff", "official", "help", "root"]);
/** A sealed direct message: 2000 characters of text, encrypted and hex-encoded, fit easily. */
const MAX_SEALED = 24_000;
const DM_HISTORY = 50;
/** Direct messages kept per conversation; older ones are dropped. */
const DM_KEEP = 5000;
/** A burst of messages, then about two a second. */
const DM_BURST = 8;
const DM_PER_SECOND = 2;
/** Unread marks for server channels are forgotten after this long without activity. */
const CHANNEL_READS_DAYS = 90;
/** Group conversations: you and up to nine others. */
const GROUP_MAX = 10;
const GROUP_NAME_MAX = 40;

export interface Group { id: string; name: string; members: string[]; created_at: number }
/** Calls: what each kind of signal may carry. The key is sealed for the callee, like a direct message. */
const CALL_KINDS = new Set(["ring", "answer", "decline", "end", "busy", "endpoint"]);
// "ip:port" for IPv4, "[ip]:port" for IPv6.
const CALL_ENDPOINT = /^(?:\d{1,3}(\.\d{1,3}){3}|\[[0-9a-fA-F:.]{2,45}\]):\d{1,5}$/;
const STATUSES = new Set(["online", "idle", "dnd", "invisible"]);
const PRIVACY = new Set(["everyone", "friends_of_friends", "nobody"]);

type Msg = { type: string; [field: string]: any };

export interface PublicProfile {
  key: string;
  username: string | null;
  display_name: string;
  avatar: string | null;
  bio: string;
}

/** What a friend sees of you right now. "offline" also covers invisible. */
export interface Presence {
  status: "online" | "idle" | "dnd" | "offline";
  activity: string | null;
}

interface FriendRow {
  key: string;
  username: string | null;
  display_name: string;
  avatar: string | null;
  /** friend: both agreed; incoming/outgoing: a request waiting; blocked: by us. */
  state: "friend" | "incoming" | "outgoing" | "blocked";
  since: number;
  status: string;
  activity: string | null;
}

interface Session {
  stage: "hello" | "auth" | "joined" | "removed";
  nonce?: string;
  key?: string;
}

// Pictures in DMs: encrypted in the app with a key that only travels inside the
// (also encrypted) message, so this store only ever holds noise. Capped per account.
const MAX_DM_IMAGE_BYTES = 330_000;
const MAX_DM_IMAGE_STORE = 50_000_000;
const DM_IMAGES_PER_DAY = 40;

const hexToBytes = (hex: string): Uint8Array | null => {
  if (!/^([0-9a-f]{2})*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const bytesToHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

function authMessage(nonce: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode("strom-auth-v1\0");
  const msg = new Uint8Array(prefix.length + nonce.length);
  msg.set(prefix);
  msg.set(nonce, prefix.length);
  return msg;
}

/** Lowercase letters, digits, underscore and dot; 2–32 long; no dots at the ends or twice in a row. */
export function validUsername(name: string): string | null {
  if (!/^[a-z0-9_.]{2,32}$/.test(name)) return "Usernames are 2–32 characters: lowercase letters, numbers, _ and .";
  if (name.startsWith(".") || name.endsWith(".") || name.includes("..")) return "A username can't start or end with a dot, or have two in a row.";
  if (RESERVED.has(name)) return "That username is reserved.";
  return null;
}

function validAvatar(avatar: string): boolean {
  return avatar.length <= MAX_AVATAR && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar);
}

export function accountOf(env: Env, key: string) {
  return env.ACCOUNTS.get(env.ACCOUNTS.idFromName(key));
}

export function directory(env: Env) {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
}

// ---------- the username directory ----------

export class UserDirectory extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS names (name TEXT PRIMARY KEY, key TEXT NOT NULL, released_at INTEGER)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS names_by_key ON names (key)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS relay (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS relay_logins (username TEXT PRIMARY KEY, until INTEGER NOT NULL)");
  }

  // ---------- the voice relay, for all of Hopp ----------

  private relayGet(key: string): string | null {
    const row = this.sql.exec("SELECT value FROM relay WHERE key = ?", key).toArray()[0];
    return row ? String(row.value) : null;
  }

  private relaySet(key: string, value: string) {
    this.sql.exec("INSERT INTO relay (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  /** This month's relay usage: read from Cloudflare when stale, else what we read last. Null if unknown. */
  private async relayUsage(): Promise<number | null> {
    const now = Date.now();
    const month = new Date().toISOString().slice(0, 7);
    const kept = JSON.parse(this.relayGet("usage") ?? "null") as { bytes: number; at: number; month: string } | null;
    if (kept && kept.month === month && now - kept.at < USAGE_FRESH_MS) return kept.bytes;
    try {
      const bytes = await monthUsage(this.env);
      this.relaySet("usage", JSON.stringify({ bytes, at: now, month }));
      return bytes;
    } catch (err) {
      console.error("relay usage unreadable:", String(err));
      return kept && kept.month === month && now - kept.at < USAGE_TRUSTED_MS ? kept.bytes : null;
    }
  }

  /** Over budget: every login still live is cut off, once. */
  private async stopRelay() {
    const now = Date.now();
    for (const row of this.sql.exec("SELECT username FROM relay_logins WHERE until > ?", now).toArray()) await revoke(this.env, String(row.username));
    this.sql.exec("DELETE FROM relay_logins");
  }

  /** A relay login for someone who can't be reached directly, if the month's budget allows. */
  async relayLogin(): Promise<{ login?: TurnLogin; error?: string }> {
    if (!relayConfigured(this.env)) return { error: "The voice relay isn't set up on this Hopp Cloud." };
    const used = await this.relayUsage();
    if (used === null) return { error: "The voice relay is resting for a moment. Try again soon." };
    if (used >= budgetBytes(this.env)) {
      await this.stopRelay();
      return { error: "The voice relay has used this month's free amount. It's back next month." };
    }
    const day = new Date().toISOString().slice(0, 10);
    const [d, n] = (this.relayGet("today") ?? "").split(" ");
    const count = d === day ? Number(n) : 0;
    if (count >= LOGINS_PER_DAY) return { error: "The voice relay is busy today. Try again tomorrow." };
    const login = await newLogin(this.env);
    if (!login) return { error: "The voice relay didn't answer. Try again in a moment." };
    this.relaySet("today", `${day} ${count + 1}`);
    const now = Date.now();
    this.sql.exec("DELETE FROM relay_logins WHERE until < ?", now);
    this.sql.exec("INSERT OR REPLACE INTO relay_logins (username, until) VALUES (?, ?)", login.username, now + LOGIN_TTL_S * 1000);
    // While logins are live, the budget is checked again every 15 minutes.
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + USAGE_FRESH_MS);
    return { login };
  }

  async alarm() {
    const now = Date.now();
    this.sql.exec("DELETE FROM relay_logins WHERE until < ?", now);
    const live = this.sql.exec("SELECT count(*) AS n FROM relay_logins").one().n as number;
    if (!live) return;
    const used = await this.relayUsage();
    // Unknown usage while logins are live: stop rather than guess.
    if (used === null || used >= budgetBytes(this.env)) return this.stopRelay();
    await this.ctx.storage.setAlarm(now + USAGE_FRESH_MS);
  }

  /** Gives `name` to `key`, releasing the key's previous name. Null on success, else why not. */
  claim(name: string, key: string): string | null {
    const invalid = validUsername(name);
    if (invalid) return invalid;
    const now = Date.now();
    const row = this.sql.exec("SELECT key, released_at FROM names WHERE name = ?", name).toArray()[0];
    if (row && row.key !== key) {
      const held = row.released_at === null || now - Number(row.released_at) < NAME_HOLD_MS;
      if (held) return "That username is taken.";
    }
    this.sql.exec("UPDATE names SET released_at = ? WHERE key = ? AND released_at IS NULL AND name != ?", now, key, name);
    this.sql.exec(
      "INSERT INTO names (name, key, released_at) VALUES (?, ?, NULL) ON CONFLICT(name) DO UPDATE SET key = excluded.key, released_at = NULL",
      name,
      key,
    );
    return null;
  }

  lookup(name: string): string | null {
    const row = this.sql.exec("SELECT key FROM names WHERE name = ? AND released_at IS NULL", name).toArray()[0];
    return row ? String(row.key) : null;
  }

  available(name: string, key: string): string | null {
    const invalid = validUsername(name);
    if (invalid) return invalid;
    const row = this.sql.exec("SELECT key, released_at FROM names WHERE name = ?", name).toArray()[0];
    if (row && row.key !== key && (row.released_at === null || Date.now() - Number(row.released_at) < NAME_HOLD_MS)) {
      return "That username is taken.";
    }
    return null;
  }
}

// ---------- one account ----------

export class StromAccount extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS friends (
        key TEXT PRIMARY KEY, username TEXT, display_name TEXT NOT NULL, avatar TEXT,
        state TEXT NOT NULL, since INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'offline', activity TEXT);
      CREATE TABLE IF NOT EXISTS dms (
        id TEXT PRIMARY KEY, peer TEXT NOT NULL, from_key TEXT NOT NULL, sealed TEXT NOT NULL, sent_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS dms_by_peer ON dms (peer, sent_at);
      CREATE TABLE IF NOT EXISTS images (id TEXT PRIMARY KEY, data BLOB NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations (peer TEXT PRIMARY KEY, last_at INTEGER NOT NULL, last_read INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', members TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_reads (
        server TEXT NOT NULL, channel INTEGER NOT NULL, read_id INTEGER NOT NULL DEFAULT 0, last_id INTEGER NOT NULL DEFAULT 0,
        last_at INTEGER NOT NULL DEFAULT 0, mentions INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (server, channel));
    `);
    const dmColumns = new Set(this.sql.exec("PRAGMA table_info(dms)").toArray().map((c) => String(c.name)));
    if (!dmColumns.has("edited_at")) this.sql.exec("ALTER TABLE dms ADD COLUMN edited_at INTEGER");
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  // ---------- storage ----------

  private meta(key: string): string | null {
    const row = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row ? String(row.value) : null;
  }

  private setMeta(key: string, value: string | null) {
    if (value === null) this.sql.exec("DELETE FROM meta WHERE key = ?", key);
    else this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  private friendRows(): FriendRow[] {
    return this.sql.exec("SELECT * FROM friends ORDER BY since").toArray() as unknown as FriendRow[];
  }

  private friend(key: string): FriendRow | undefined {
    return this.sql.exec("SELECT * FROM friends WHERE key = ?", key).toArray()[0] as unknown as FriendRow | undefined;
  }

  private upsertFriend(row: Omit<FriendRow, "status" | "activity"> & Partial<Pick<FriendRow, "status" | "activity">>) {
    this.sql.exec(
      `INSERT INTO friends (key, username, display_name, avatar, state, since, status, activity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET username = excluded.username, display_name = excluded.display_name,
         avatar = excluded.avatar, state = excluded.state, since = excluded.since`,
      row.key, row.username, row.display_name, row.avatar, row.state, row.since, row.status ?? "offline", row.activity ?? null,
    );
  }

  private profile(): PublicProfile {
    return {
      key: this.meta("key") ?? "",
      username: this.meta("username"),
      display_name: this.meta("display_name") ?? "",
      avatar: this.meta("avatar"),
      bio: this.meta("bio") ?? "",
    };
  }

  /** What friends see: invisible and no devices both look offline. */
  private presence(): Presence {
    const status = this.meta("status") ?? "online";
    if (this.devices().length === 0 || status === "invisible") return { status: "offline", activity: null };
    return { status: status as Presence["status"], activity: this.meta("activity") };
  }

  // ---------- sockets ----------

  private session(ws: WebSocket): Session {
    return (ws.deserializeAttachment() as Session) ?? { stage: "hello" };
  }

  private devices(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => this.session(ws).stage === "joined");
  }

  private send(ws: WebSocket, msg: object) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // Closing.
    }
  }

  /** To every device of this account (except one, if given). */
  private toDevices(msg: object, except?: WebSocket) {
    for (const ws of this.devices()) if (ws !== except) this.send(ws, msg);
  }

  private reject(ws: WebSocket, message: string) {
    this.send(ws, { type: "error", message });
    ws.serializeAttachment({ stage: "removed" } satisfies Session);
    ws.close(4000, "rejected");
  }

  async fetch(request: Request): Promise<Response> {
    const image = new URL(request.url).pathname.match(/\/images(?:\/([0-9a-f]{32}))?$/);
    if (image) {
      try {
        if (image[1] && request.method === "GET") return this.serveImage(image[1]);
        if (!image[1] && request.method === "POST") return await this.uploadImage(request);
        return new Response("Not allowed", { status: 405 });
      } catch (err) {
        return Response.json({ error: troubleMessage(err) }, { status: 503 });
      }
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ stage: "hello" } satisfies Session);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** An encrypted picture; only those with the key in the message can see it. */
  private serveImage(id: string): Response {
    const row = this.sql.exec("SELECT data FROM images WHERE id = ?", id).toArray()[0];
    if (!row) return new Response("Gone", { status: 404 });
    return new Response(row.data as ArrayBuffer, {
      headers: { "content-type": "application/octet-stream", "cache-control": "private, max-age=31536000, immutable", "access-control-allow-origin": "*" },
    });
  }

  /** The account's owner stores an encrypted picture for a DM, signed with their Hopp ID. */
  private async uploadImage(request: Request): Promise<Response> {
    const fail = (error: string, status = 400) => Response.json({ error }, { status });
    const owner = this.meta("key");
    const key = (request.headers.get("X-Hopp-Key") ?? "").toLowerCase();
    const time = Number(request.headers.get("X-Hopp-Time"));
    const signature = hexToBytes(request.headers.get("X-Hopp-Signature") ?? "");
    if (!owner || key !== owner || signature?.length !== 64) return fail("Not signed.", 401);
    if (!Number.isFinite(time) || Math.abs(Date.now() - time) > 5 * 60_000) return fail("Your computer's clock is off. Check the time and try again.", 401);
    const data = new Uint8Array(await request.arrayBuffer());
    if (data.length < 29 || data.length > MAX_DM_IMAGE_BYTES) return fail("That picture is too big.");
    const digest = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
    const signed = new TextEncoder().encode(`hopp-image-v1\0account:${owner}\0${digest}\0${time}`);
    let valid = false;
    try {
      const pub = await crypto.subtle.importKey("raw", hexToBytes(owner)!, { name: "Ed25519" }, false, ["verify"]);
      valid = await crypto.subtle.verify({ name: "Ed25519" }, pub, signature, signed);
    } catch {
      valid = false;
    }
    if (!valid) return fail("Not signed.", 401);
    const now = Date.now();
    const today = Number(this.sql.exec("SELECT count(*) AS n FROM images WHERE created_at > ?", now - 86_400_000).one().n);
    if (today >= DM_IMAGES_PER_DAY) return fail("You've shared a lot of pictures today. Try again tomorrow.", 429);
    const id = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    this.sql.exec("INSERT INTO images (id, data, size, created_at) VALUES (?, ?, ?, ?)", id, data, data.length, now);
    // Past the account's share of storage, the oldest pictures make room.
    let total = Number(this.sql.exec("SELECT coalesce(sum(size), 0) AS n FROM images").one().n);
    while (total > MAX_DM_IMAGE_STORE) {
      const oldest = this.sql.exec("SELECT id, size FROM images ORDER BY created_at LIMIT 1").toArray()[0];
      if (!oldest) break;
      this.sql.exec("DELETE FROM images WHERE id = ?", oldest.id);
      total -= Number(oldest.size);
    }
    return Response.json({ id });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    if (typeof data !== "string" || data.length > MAX_SYNC + 4096) return this.reject(ws, "Message too large.");
    let msg: Msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return this.reject(ws, "Malformed message.");
    }
    const s = this.session(ws);
    if (s.stage === "hello") return this.onHello(ws, msg);
    if (s.stage === "auth") return this.onAuth(ws, s, msg);
    try {
      if (s.stage === "joined") return await this.onMessage(ws, msg);
    } catch (err) {
      this.send(ws, { type: "error", message: troubleMessage(err), for: msg.type });
    }
  }

  private onHello(ws: WebSocket, msg: Msg) {
    if (msg.type !== "hello") return this.reject(ws, "Expected hello.");
    if (msg.protocol !== ACCOUNT_PROTOCOL) return this.reject(ws, "Update Hopp to keep using your account.");
    const key = String(msg.public_key ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(key)) return this.reject(ws, "Invalid Hopp ID.");
    const owner = this.meta("key");
    if (owner && owner !== key) return this.reject(ws, "Wrong account.");
    const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    ws.serializeAttachment({ stage: "auth", nonce, key } satisfies Session);
    this.send(ws, { type: "challenge", nonce });
  }

  private async onAuth(ws: WebSocket, s: Session, msg: Msg) {
    if (msg.type !== "auth") return this.reject(ws, "Expected auth.");
    const signature = hexToBytes(String(msg.signature ?? ""));
    let valid = false;
    if (signature?.length === 64) {
      try {
        const key = await crypto.subtle.importKey("raw", hexToBytes(s.key!)!, { name: "Ed25519" }, false, ["verify"]);
        valid = await crypto.subtle.verify({ name: "Ed25519" }, key, signature, authMessage(hexToBytes(s.nonce!)!));
      } catch {
        valid = false;
      }
    }
    if (!valid) return this.reject(ws, "Login failed: invalid signature.");

    const wasOffline = this.devices().length === 0;
    if (!this.meta("key")) {
      if (this.env.PAUSE_NEW === "1") return this.reject(ws, "Hopp isn't taking new accounts right now. Try again in a while.");
      this.setMeta("key", s.key!);
      this.setMeta("created_at", String(Date.now()));
    }
    const name = String(msg.display_name ?? "").trim();
    if (name && [...name].length <= MAX_DISPLAY_NAME && !this.meta("display_name")) this.setMeta("display_name", name);
    ws.serializeAttachment({ stage: "joined", key: s.key } satisfies Session);

    this.send(ws, {
      type: "welcome",
      me: { ...this.profile(), status: this.meta("status") ?? "online", privacy: this.meta("privacy") ?? "everyone" },
      sync: { data: this.meta("sync_data"), version: Number(this.meta("sync_version") ?? 0) },
      friends: this.friendRows(),
      conversations: this.conversations(),
      channels: this.channelReads(),
      groups: this.groups(),
    });
    if (wasOffline) await this.announcePresence();
  }

  private async onMessage(ws: WebSocket, msg: Msg) {
    const myKey = this.meta("key")!;
    const error = (message: string) => this.send(ws, { type: "error", message, for: msg.type });
    switch (msg.type) {
      case "set_profile": {
        if (msg.display_name !== undefined) {
          const name = String(msg.display_name).trim();
          if (!name || [...name].length > MAX_DISPLAY_NAME) return error(`Display names are 1–${MAX_DISPLAY_NAME} characters.`);
          this.setMeta("display_name", name);
        }
        if (msg.bio !== undefined) {
          const bio = String(msg.bio).trim();
          if ([...bio].length > MAX_BIO) return error(`Keep it under ${MAX_BIO} characters.`);
          this.setMeta("bio", bio);
        }
        if (msg.avatar !== undefined) {
          if (msg.avatar === null) this.setMeta("avatar", null);
          else if (typeof msg.avatar === "string" && validAvatar(msg.avatar)) this.setMeta("avatar", msg.avatar);
          else return error("That picture can't be used. Try a smaller PNG, JPEG or WebP.");
        }
        this.toDevices({ type: "profile", me: this.profile() });
        await this.tellFriends((f) => f.profileChanged(myKey, this.profile()));
        return;
      }
      case "check_username": {
        const name = String(msg.name ?? "").toLowerCase();
        const problem = await directory(this.env).available(name, myKey);
        return this.send(ws, { type: "username_check", name, ok: problem === null, message: problem });
      }
      case "claim_username": {
        const name = String(msg.name ?? "").toLowerCase();
        const last = Number(this.meta("username_changed_at") ?? 0);
        if (this.meta("username") && Date.now() - last < 24 * 3_600_000) {
          return error("You can change your username once a day.");
        }
        const problem = await directory(this.env).claim(name, myKey);
        if (problem) return error(problem);
        this.setMeta("username", name);
        this.setMeta("username_changed_at", String(Date.now()));
        this.toDevices({ type: "profile", me: this.profile() });
        await this.tellFriends((f) => f.profileChanged(myKey, this.profile()));
        return;
      }
      case "set_status": {
        const status = String(msg.status);
        if (!STATUSES.has(status)) return error("Unknown status.");
        this.setMeta("status", status);
        this.toDevices({ type: "status", status });
        return this.announcePresence();
      }
      case "set_activity": {
        const activity = msg.activity == null ? null : String(msg.activity).slice(0, MAX_ACTIVITY);
        if (activity === this.meta("activity")) return;
        this.setMeta("activity", activity);
        return this.announcePresence();
      }
      case "set_privacy": {
        const privacy = String(msg.requests);
        if (!PRIVACY.has(privacy)) return error("Unknown setting.");
        this.setMeta("privacy", privacy);
        return this.toDevices({ type: "privacy", requests: privacy });
      }
      case "set_sync": {
        // Opaque to us: the account data is encrypted on the device.
        const data = String(msg.data ?? "");
        if (data.length > MAX_SYNC) return error("Too much account data.");
        const version = Number(this.meta("sync_version") ?? 0);
        if (Number(msg.base_version) !== version) {
          // Another device changed it first: hand over the newer copy to merge with.
          return this.send(ws, { type: "sync", data: this.meta("sync_data"), version, conflict: true });
        }
        this.setMeta("sync_data", data);
        this.setMeta("sync_version", String(version + 1));
        this.send(ws, { type: "sync_saved", version: version + 1 });
        return this.toDevices({ type: "sync", data, version: version + 1 }, ws);
      }
      case "friend_request":
        return this.sendFriendRequest(ws, msg);
      case "friend_accept": {
        const row = this.friend(String(msg.key));
        if (row?.state !== "incoming") return error("That request is gone.");
        // Friends first, so their presence (sent while they accept) isn't ignored.
        this.upsertFriend({ ...row, state: "friend", since: Date.now() });
        const them = accountOf(this.env, row.key);
        const answer = await them.friendAccepted(this.snapshot());
        if (answer !== "ok") {
          this.sql.exec("DELETE FROM friends WHERE key = ?", row.key);
          this.toDevices({ type: "friend_removed", key: row.key });
          return error("That request is gone.");
        }
        await this.learnPresence(row.key);
        this.toDevices({ type: "friend", friend: this.friend(row.key) });
        return;
      }
      case "friend_decline":
      case "friend_remove": {
        const key = String(msg.key);
        const row = this.friend(key);
        if (!row || row.state === "blocked") return;
        this.sql.exec("DELETE FROM friends WHERE key = ?", key);
        this.toDevices({ type: "friend_removed", key });
        await accountOf(this.env, key).friendRemoved(myKey);
        return;
      }
      case "block": {
        const key = String(msg.key ?? "").toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(key) || key === myKey) return error("Can't block that.");
        const known = this.friend(key);
        const profile = known ?? (await accountOf(this.env, key).publicProfile());
        this.upsertFriend({
          key,
          username: profile.username ?? null,
          display_name: profile.display_name || "Unknown",
          avatar: profile.avatar ?? null,
          state: "blocked",
          since: Date.now(),
        });
        this.toDevices({ type: "friend", friend: this.friend(key) });
        await accountOf(this.env, key).friendRemoved(myKey);
        return;
      }
      case "unblock": {
        const key = String(msg.key);
        if (this.friend(key)?.state !== "blocked") return;
        this.sql.exec("DELETE FROM friends WHERE key = ?", key);
        return this.toDevices({ type: "friend_removed", key });
      }
      case "dm_send":
        return this.sendDm(ws, msg);
      case "group_create": {
        const others = [...new Set((Array.isArray(msg.members) ? msg.members : []).map((k: unknown) => String(k).toLowerCase()))].filter((k) => k !== myKey);
        if (others.length < 1 || others.length > GROUP_MAX - 1) return error(`A group has 2–${GROUP_MAX} people.`);
        if (others.some((k) => this.friend(k)?.state !== "friend")) return error("You can only add your friends.");
        const name = String(msg.name ?? "").trim().slice(0, GROUP_NAME_MAX);
        const group: Group = { id: `g:${bytesToHex(crypto.getRandomValues(new Uint8Array(8)))}`, name, members: [myKey, ...others], created_at: Date.now() };
        await this.shareGroup(group, group.members);
        return this.send(ws, { type: "group_created", id: group.id, nonce: msg.nonce });
      }
      case "group_update": {
        const group = this.group(String(msg.group ?? ""));
        if (!group || !group.members.includes(myKey)) return error("That group doesn't exist.");
        const added = [...new Set((Array.isArray(msg.add) ? msg.add : []).map((k: unknown) => String(k).toLowerCase()))].filter((k) => !group.members.includes(k));
        if (added.some((k) => this.friend(k)?.state !== "friend")) return error("You can only add your friends.");
        if (group.members.length + added.length > GROUP_MAX) return error(`A group has at most ${GROUP_MAX} people.`);
        if (msg.name !== undefined) group.name = String(msg.name).trim().slice(0, GROUP_NAME_MAX);
        group.members.push(...added);
        return this.shareGroup(group, group.members);
      }
      case "group_leave": {
        const group = this.group(String(msg.group ?? ""));
        if (!group) return;
        this.sql.exec("DELETE FROM groups WHERE id = ?", group.id);
        this.toDevices({ type: "group_removed", id: group.id });
        group.members = group.members.filter((k) => k !== myKey);
        for (const k of group.members) this.ctx.waitUntil(accountOf(this.env, k).groupUpdated(myKey, group).catch(() => {}));
        return;
      }
      case "group_send":
        return this.sendGroupDm(ws, msg);
      case "dm_edit":
      case "dm_delete":
        return this.changeDm(ws, msg);
      case "dm_history": {
        const peer = String(msg.with ?? "");
        const before = Number(msg.before ?? Number.MAX_SAFE_INTEGER);
        const rows = this.sql
          .exec("SELECT id, from_key, sealed, sent_at, edited_at FROM dms WHERE peer = ? AND sent_at < ? ORDER BY sent_at DESC LIMIT ?", peer, before, DM_HISTORY)
          .toArray()
          .reverse();
        return this.send(ws, { type: "dm_history", with: peer, messages: rows, complete: rows.length < DM_HISTORY });
      }
      case "dm_read": {
        const peer = String(msg.with ?? "");
        const at = Number(msg.at ?? Date.now());
        this.sql.exec("UPDATE conversations SET last_read = MAX(last_read, ?) WHERE peer = ?", at, peer);
        return this.toDevices({ type: "dm_read", with: peer, at });
      }
      case "call": {
        const to = String(msg.to ?? "").toLowerCase();
        const kind = String(msg.kind ?? "");
        const callId = String(msg.call_id ?? "");
        if (!CALL_KINDS.has(kind) || !/^[0-9a-f-]{8,40}$/.test(callId)) return error("Bad call signal.");
        if (this.friend(to)?.state !== "friend") return error("You can only call friends.");
        const signal: Record<string, unknown> = { kind, call_id: callId };
        if (kind === "ring") {
          const sealed = String(msg.sealed ?? "");
          if (!/^[0-9a-f]{40,400}$/.test(sealed)) return error("Bad call signal.");
          signal.sealed = sealed;
        }
        if (kind === "endpoint") {
          signal.public = typeof msg.public === "string" && CALL_ENDPOINT.test(msg.public) ? msg.public : null;
          signal.local = (Array.isArray(msg.local) ? msg.local : []).filter((a: unknown) => typeof a === "string" && CALL_ENDPOINT.test(a)).slice(0, 4);
        }
        const reached = await accountOf(this.env, to).callSignal(myKey, signal);
        // Your other devices stop ringing once one of them answers or declines.
        this.toDevices({ type: "call_self", with: to, kind, call_id: callId }, ws);
        if (kind === "ring" && !reached) this.send(ws, { type: "call", from: to, kind: "offline", call_id: callId });
        return;
      }
      case "turn_login":
        return this.relayLogin(ws);
      case "file_signal": {
        // Files go straight between friends' computers; this only passes their handshake
        // (sealed like a DM, so the cloud can't read it).
        const to = String(msg.to ?? "").toLowerCase();
        const transfer = String(msg.transfer ?? "");
        const sealed = String(msg.sealed ?? "");
        if (!/^[0-9a-f]{32}$/.test(transfer) || !/^[0-9a-f]{2,24000}$/.test(sealed)) return error("Bad file signal.");
        if (this.friend(to)?.state !== "friend") return error("You can only send files to friends.");
        const reached = await accountOf(this.env, to).fileSignal(myKey, transfer, sealed);
        if (!reached) this.send(ws, { type: "file_signal", from: to, transfer, offline: true });
        return;
      }
      case "channel_read": {
        const server = String(msg.server ?? "");
        const channel = Number(msg.channel);
        const id = Number(msg.id);
        if (!server || server.length > 300 || !Number.isSafeInteger(channel) || !Number.isSafeInteger(id) || id < 0) return error("Bad channel.");
        if (msg.unread) return this.markUnread(server, channel, id);
        return this.markRead(server, channel, id);
      }
      case "ping":
        return this.send(ws, { type: "pong" });
      default:
        return error(`Unknown message type "${msg.type}".`);
    }
  }

  private conversations() {
    return this.sql.exec("SELECT peer, last_at, last_read FROM conversations ORDER BY last_at DESC").toArray();
  }

  /** Keeps a message (ours or theirs) in the conversation with `peer`. */
  private storeDm(peer: string, message: { id: string; from_key: string; sealed: string; sent_at: number }) {
    this.sql.exec("INSERT OR IGNORE INTO dms (id, peer, from_key, sealed, sent_at) VALUES (?, ?, ?, ?, ?)", message.id, peer, message.from_key, message.sealed, message.sent_at);
    const mine = message.from_key === this.meta("key");
    this.sql.exec(
      `INSERT INTO conversations (peer, last_at, last_read) VALUES (?, ?, ?)
       ON CONFLICT(peer) DO UPDATE SET last_at = MAX(last_at, excluded.last_at),
         last_read = CASE WHEN ? THEN MAX(last_read, excluded.last_at) ELSE last_read END`,
      peer, message.sent_at, mine ? message.sent_at : 0, mine ? 1 : 0,
    );
    this.sql.exec(
      "DELETE FROM dms WHERE peer = ? AND sent_at < (SELECT sent_at FROM dms WHERE peer = ? ORDER BY sent_at DESC LIMIT 1 OFFSET ?)",
      peer, peer, DM_KEEP,
    );
  }

  private async sendDm(ws: WebSocket, msg: Msg) {
    const myKey = this.meta("key")!;
    const error = (message: string) => this.send(ws, { type: "error", message, for: "dm_send", with: msg.to, nonce: msg.nonce });
    const to = String(msg.to ?? "").toLowerCase();
    const sealed = String(msg.sealed ?? "");
    if (!/^[0-9a-f]+$/.test(sealed) || sealed.length > MAX_SEALED) return error("That message can't be sent.");
    if (this.friend(to)?.state !== "friend") return error("You can only message your friends.");

    const now = Date.now();
    const bucket = (this.meta("dm_bucket") ?? `${DM_BURST}:${now}`).split(":").map(Number);
    const tokens = Math.min(DM_BURST, bucket[0] + ((now - bucket[1]) / 1000) * DM_PER_SECOND);
    if (tokens < 1) return error("You're sending messages too fast. Slow down a little.");
    this.setMeta("dm_bucket", `${tokens - 1}:${now}`);

    const message = { id: `${now.toString(36)}-${bytesToHex(crypto.getRandomValues(new Uint8Array(6)))}`, from_key: myKey, sealed, sent_at: now };
    const delivered = await accountOf(this.env, to).receiveDm(myKey, message);
    if (!delivered) return error("They can't receive your messages.");
    this.storeDm(to, message);
    this.toDevices({ type: "dm", with: to, message, nonce: msg.nonce });
  }

  // ---------- groups ----------

  private groups(): Group[] {
    return this.sql.exec("SELECT * FROM groups ORDER BY created_at").toArray().map((r) => ({
      id: String(r.id), name: String(r.name), members: JSON.parse(String(r.members)), created_at: Number(r.created_at),
    }));
  }

  private group(id: string): Group | undefined {
    return this.groups().find((g) => g.id === id);
  }

  private saveGroup(group: Group) {
    this.sql.exec(
      "INSERT INTO groups (id, name, members, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, members = excluded.members",
      group.id, group.name, JSON.stringify(group.members), group.created_at,
    );
    this.toDevices({ type: "group", group });
  }

  /** Stores the group here and with everyone in it. */
  private async shareGroup(group: Group, members: string[]) {
    const myKey = this.meta("key")!;
    this.saveGroup(group);
    await Promise.all(members.filter((k) => k !== myKey).map((k) => accountOf(this.env, k).groupUpdated(myKey, group).catch(() => {})));
  }

  /** Someone in a group changed it (or made it with us in it). */
  async groupUpdated(fromKey: string, group: Group): Promise<void> {
    const myKey = this.meta("key");
    const known = this.group(group.id);
    // Only members may change a group; a new group must come from a friend.
    if (known ? !known.members.includes(fromKey) : this.friend(fromKey)?.state !== "friend") return;
    if (!myKey || !group.members.includes(myKey)) return;
    this.saveGroup({ ...group, members: group.members.slice(0, GROUP_MAX) });
  }

  async receiveGroupDm(groupId: string, message: { id: string; from_key: string; sealed: string; sent_at: number }): Promise<boolean> {
    const group = this.group(groupId);
    if (!group || !group.members.includes(message.from_key)) return false;
    if (this.friend(message.from_key)?.state === "blocked") return true;
    this.storeDm(groupId, message);
    this.toDevices({ type: "dm", with: groupId, message });
    return true;
  }

  private async sendGroupDm(ws: WebSocket, msg: Msg) {
    const myKey = this.meta("key")!;
    const error = (message: string) => this.send(ws, { type: "error", message, for: "dm_send", with: msg.group, nonce: msg.nonce });
    const group = this.group(String(msg.group ?? ""));
    if (!group || !group.members.includes(myKey)) return error("You're not in that group anymore.");
    const sealed = msg.sealed && typeof msg.sealed === "object" ? (msg.sealed as Record<string, unknown>) : {};
    for (const k of group.members) {
      const one = sealed[k];
      if (typeof one !== "string" || !/^[0-9a-f]+$/.test(one) || one.length > MAX_SEALED) return error("That message can't be sent.");
    }
    const now = Date.now();
    const bucket = (this.meta("dm_bucket") ?? `${DM_BURST}:${now}`).split(":").map(Number);
    const tokens = Math.min(DM_BURST, bucket[0] + ((now - bucket[1]) / 1000) * DM_PER_SECOND);
    if (tokens < 1) return error("You're sending messages too fast. Slow down a little.");
    this.setMeta("dm_bucket", `${tokens - 1}:${now}`);

    const id = `${now.toString(36)}-${bytesToHex(crypto.getRandomValues(new Uint8Array(6)))}`;
    await Promise.all(
      group.members
        .filter((k) => k !== myKey)
        .map((k) => accountOf(this.env, k).receiveGroupDm(group.id, { id, from_key: myKey, sealed: String(sealed[k]), sent_at: now }).catch(() => false)),
    );
    const mine = { id, from_key: myKey, sealed: String(sealed[myKey]), sent_at: now };
    this.storeDm(group.id, mine);
    this.toDevices({ type: "dm", with: group.id, message: mine, nonce: msg.nonce });
  }

  /**
   * Editing or deleting one of your own DMs (or group messages). An edit carries a new
   * sealed text for each person (one string for a DM, a map by key for a group).
   */
  private async changeDm(ws: WebSocket, msg: Msg) {
    const myKey = this.meta("key")!;
    const error = (message: string) => this.send(ws, { type: "error", message, for: msg.type });
    const peer = String(msg.with ?? "");
    const id = String(msg.id ?? "");
    const row = this.sql.exec("SELECT from_key FROM dms WHERE peer = ? AND id = ?", peer, id).toArray()[0];
    if (!row) return error("That message is gone.");
    if (row.from_key !== myKey) return error("You can only change your own messages.");
    // Edits and deletes share the sending speed limit (each reaches everyone in the conversation).
    const now = Date.now();
    const bucket = (this.meta("dm_bucket") ?? `${DM_BURST}:${now}`).split(":").map(Number);
    const tokens = Math.min(DM_BURST, bucket[0] + ((now - bucket[1]) / 1000) * DM_PER_SECOND);
    if (tokens < 1) return error("You're changing messages too fast. Slow down a little.");
    this.setMeta("dm_bucket", `${tokens - 1}:${now}`);
    const group = this.group(peer);
    const others = group ? group.members.filter((k) => k !== myKey) : [peer];
    if (msg.type === "dm_delete") {
      this.sql.exec("DELETE FROM dms WHERE peer = ? AND id = ?", peer, id);
      await Promise.all(others.map((k) => accountOf(this.env, k).dmChanged(myKey, peer, id, null, 0).catch(() => false)));
      return this.toDevices({ type: "dm_deleted", with: peer, id });
    }
    const sealedFor = (k: string) => (group ? (msg.sealed as Record<string, unknown> | undefined)?.[k] : k === myKey ? msg.sealed_self ?? msg.sealed : msg.sealed);
    for (const k of [myKey, ...others]) {
      const one = sealedFor(k);
      if (typeof one !== "string" || !/^[0-9a-f]+$/.test(one) || one.length > MAX_SEALED) return error("That message can't be saved.");
    }
    const at = Date.now();
    this.sql.exec("UPDATE dms SET sealed = ?, edited_at = ? WHERE peer = ? AND id = ?", String(sealedFor(myKey)), at, peer, id);
    await Promise.all(others.map((k) => accountOf(this.env, k).dmChanged(myKey, peer, id, String(sealedFor(k)), at).catch(() => false)));
    this.toDevices({ type: "dm_edited", with: peer, id, sealed: String(sealedFor(myKey)), edited_at: at });
  }

  /** Someone edited (sealed) or deleted (null) a message they sent us. */
  async dmChanged(fromKey: string, conversation: string, id: string, sealed: string | null, at: number): Promise<boolean> {
    // A DM is stored under the sender's key here; a group message under the group.
    const peer = this.group(conversation) ? conversation : fromKey;
    const row = this.sql.exec("SELECT from_key FROM dms WHERE peer = ? AND id = ?", peer, id).toArray()[0];
    if (!row || row.from_key !== fromKey) return false;
    if (sealed === null) {
      this.sql.exec("DELETE FROM dms WHERE peer = ? AND id = ?", peer, id);
      this.toDevices({ type: "dm_deleted", with: peer, id });
    } else {
      this.sql.exec("UPDATE dms SET sealed = ?, edited_at = ? WHERE peer = ? AND id = ?", sealed, at, peer, id);
      this.toDevices({ type: "dm_edited", with: peer, id, sealed, edited_at: at });
    }
    return true;
  }

  private snapshot(): PublicProfile {
    return this.profile();
  }

  private async sendFriendRequest(ws: WebSocket, msg: Msg) {
    const myKey = this.meta("key")!;
    const error = (message: string) => this.send(ws, { type: "error", message, for: "friend_request" });
    if (!this.meta("username")) return error("Pick a username first, so people know who's asking.");
    let key = typeof msg.key === "string" ? msg.key.toLowerCase() : null;
    if (!key) {
      const name = String(msg.username ?? "").toLowerCase().replace(/^@/, "");
      key = await directory(this.env).lookup(name);
      if (!key) return error("Nobody has that username. Check the spelling.");
    }
    if (key === myKey) return error("That's you.");
    const existing = this.friend(key);
    if (existing?.state === "friend") return error("You're already friends.");
    if (existing?.state === "blocked") return error("You've blocked them. Unblock them first.");
    if (existing?.state === "outgoing") return error("You've already sent them a request.");

    // Rate limit: a few dozen requests a day stops spam without bothering anyone.
    const day = new Date().toISOString().slice(0, 10);
    const [countDay, count] = (this.meta("requests_today") ?? `${day}:0`).split(":");
    const sent = countDay === day ? Number(count) : 0;
    if (sent >= FRIEND_REQUESTS_PER_DAY) return error("You've sent a lot of friend requests today. Try again tomorrow.");
    this.setMeta("requests_today", `${day}:${sent + 1}`);

    const them = accountOf(this.env, key);
    const answer = await them.receiveFriendRequest(this.snapshot(), this.friendKeys());
    if (answer === "closed" || answer === "blocked") {
      // Never reveal a block; it just doesn't go through.
      return error("They aren't accepting friend requests.");
    }
    if (answer === "missing") return error("Nobody has that username. Check the spelling.");
    const profile = await them.publicProfile();
    this.upsertFriend({
      key,
      username: profile.username,
      display_name: profile.display_name,
      avatar: profile.avatar,
      state: answer === "accepted" ? "friend" : "outgoing",
      since: Date.now(),
    });
    if (answer === "accepted") {
      await them.presenceChanged(myKey, this.presence());
      await this.learnPresence(key);
    }
    this.toDevices({ type: "friend", friend: this.friend(key) });
  }

  /** Asks a new friend how they are right now, and shows it. */
  private async learnPresence(key: string) {
    const p = await accountOf(this.env, key).currentPresence(this.meta("key")!);
    if (!p) return;
    this.sql.exec("UPDATE friends SET status = ?, activity = ? WHERE key = ?", p.status, p.activity, key);
    this.toDevices({ type: "presence", key, ...p });
  }

  private friendKeys(): string[] {
    return this.friendRows().filter((f) => f.state === "friend").map((f) => f.key);
  }

  /** Runs `call` on every friend's account object. */
  private async tellFriends(call: (account: DurableObjectStub<StromAccount>) => Promise<unknown>) {
    await Promise.allSettled(this.friendKeys().map((k) => call(accountOf(this.env, k))));
  }

  private async announcePresence() {
    const myKey = this.meta("key")!;
    const presence = this.presence();
    const last = this.meta("last_presence");
    const now = JSON.stringify(presence);
    if (last === now) return;
    this.setMeta("last_presence", now);
    await this.tellFriends((f) => f.presenceChanged(myKey, presence));
  }

  async webSocketClose(ws: WebSocket) {
    await this.leave(ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.leave(ws);
  }

  private async leave(ws: WebSocket) {
    const was = this.session(ws).stage;
    try {
      ws.serializeAttachment({ stage: "removed" } satisfies Session);
    } catch {
      // Gone.
    }
    if (was === "joined" && this.devices().length === 0) {
      this.setMeta("activity", null);
      await this.announcePresence();
    }
  }

  // ---------- called by other accounts ----------

  async publicProfile(): Promise<PublicProfile> {
    return this.profile();
  }

  /** Someone asks to be friends. "accepted" when we had asked them too. */
  async receiveFriendRequest(from: PublicProfile, theirFriends: string[]): Promise<"sent" | "accepted" | "closed" | "blocked" | "missing"> {
    if (!this.meta("key")) return "missing";
    const existing = this.friend(from.key);
    if (existing?.state === "blocked") return "blocked";
    if (existing?.state === "friend") return "accepted";
    const privacy = this.meta("privacy") ?? "everyone";
    if (existing?.state !== "outgoing") {
      if (privacy === "nobody") return "closed";
      if (privacy === "friends_of_friends" && !theirFriends.some((k) => this.friend(k)?.state === "friend")) return "closed";
    }
    const mutual = existing?.state === "outgoing";
    this.upsertFriend({
      key: from.key,
      username: from.username,
      display_name: from.display_name,
      avatar: from.avatar,
      state: mutual ? "friend" : "incoming",
      since: Date.now(),
    });
    this.toDevices({ type: "friend", friend: this.friend(from.key), request: !mutual });
    return mutual ? "accepted" : "sent";
  }

  /** Our presence, for a friend who just became one. Nothing for anyone else. */
  async currentPresence(askerKey: string): Promise<Presence | null> {
    return this.friend(askerKey)?.state === "friend" ? this.presence() : null;
  }

  async friendAccepted(from: PublicProfile): Promise<"ok" | "gone"> {
    const row = this.friend(from.key);
    if (row?.state !== "outgoing") return "gone";
    this.upsertFriend({ ...row, username: from.username, display_name: from.display_name, avatar: from.avatar, state: "friend", since: Date.now() });
    this.toDevices({ type: "friend", friend: this.friend(from.key), accepted: true });
    await accountOf(this.env, from.key).presenceChanged(this.meta("key")!, this.presence());
    await this.learnPresence(from.key);
    return "ok";
  }

  async friendRemoved(fromKey: string): Promise<void> {
    const row = this.friend(fromKey);
    if (!row || row.state === "blocked") return;
    this.sql.exec("DELETE FROM friends WHERE key = ?", fromKey);
    this.toDevices({ type: "friend_removed", key: fromKey });
  }

  async presenceChanged(fromKey: string, presence: Presence): Promise<void> {
    if (this.friend(fromKey)?.state !== "friend") return;
    this.sql.exec("UPDATE friends SET status = ?, activity = ? WHERE key = ?", presence.status, presence.activity, fromKey);
    this.toDevices({ type: "presence", key: fromKey, ...presence });
  }

  /** A direct message from a friend. False if they aren't one (or are blocked). */
  async receiveDm(fromKey: string, message: { id: string; from_key: string; sealed: string; sent_at: number }): Promise<boolean> {
    if (this.friend(fromKey)?.state !== "friend") return false;
    this.storeDm(fromKey, message);
    this.toDevices({ type: "dm", with: fromKey, message });
    return true;
  }

  // ---------- server channels: unread and mentions ----------

  private channelReads() {
    const since = Date.now() - CHANNEL_READS_DAYS * 86_400_000;
    return this.sql
      .exec("SELECT server, channel, read_id, last_id, last_at, mentions FROM channel_reads WHERE last_at > ? ORDER BY last_at DESC LIMIT 2000", since)
      .toArray();
  }

  private channelRead(server: string, channel: number) {
    return this.sql.exec("SELECT server, channel, read_id, last_id, last_at, mentions FROM channel_reads WHERE server = ? AND channel = ?", server, channel).one();
  }

  /** Read up to message `id`; every device clears its unread marks. */
  private markRead(server: string, channel: number, id: number) {
    this.sql.exec(
      `INSERT INTO channel_reads (server, channel, read_id, last_id, last_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(server, channel) DO UPDATE SET
         read_id = max(read_id, excluded.read_id),
         last_id = max(last_id, excluded.last_id),
         mentions = CASE WHEN excluded.read_id >= last_id THEN 0 ELSE mentions END`,
      server, channel, id, id, Date.now(),
    );
    this.toDevices({ type: "channel_read", ...this.channelRead(server, channel) });
  }

  /** "Mark unread": everything after message `id` counts as new again, on every device. */
  private markUnread(server: string, channel: number, id: number) {
    this.sql.exec(
      `INSERT INTO channel_reads (server, channel, read_id, last_id, last_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(server, channel) DO UPDATE SET read_id = excluded.read_id, last_id = max(last_id, excluded.read_id + 1)`,
      server, channel, id, id + 1, Date.now(),
    );
    this.toDevices({ type: "channel_read", ...this.channelRead(server, channel) });
  }

  /** Counts a server this account creates; false once it has made too many today. */
  async allowNewServer(): Promise<boolean> {
    const day = new Date().toISOString().slice(0, 10);
    const [d, n] = (this.meta("servers_today") ?? "").split(" ");
    const count = d === day ? Number(n) : 0;
    if (count >= MAX_NEW_SERVERS_PER_DAY) return false;
    this.setMeta("servers_today", `${day} ${count + 1}`);
    return true;
  }

  async channelActivity(m: {
    server: string; server_name: string; channel: number; channel_name: string; id: number; at: number;
    author_key: string; author_name: string; mention: boolean; preview: string | null;
  }): Promise<void> {
    if (m.author_key === this.meta("key")) return this.markRead(m.server, m.channel, m.id);
    if (this.friend(m.author_key)?.state === "blocked") return;
    this.sql.exec(
      `INSERT INTO channel_reads (server, channel, read_id, last_id, last_at, mentions) VALUES (?, ?, 0, ?, ?, ?)
       ON CONFLICT(server, channel) DO UPDATE SET
         mentions = mentions + CASE WHEN ? AND excluded.last_id > last_id AND excluded.last_id > read_id THEN 1 ELSE 0 END,
         last_id = max(last_id, excluded.last_id),
         last_at = max(last_at, excluded.last_at)`,
      m.server, m.channel, m.id, m.at, m.mention ? 1 : 0, m.mention ? 1 : 0,
    );
    this.toDevices({
      type: "channel_activity",
      ...this.channelRead(m.server, m.channel),
      id: m.id,
      server_name: m.server_name,
      channel_name: m.channel_name,
      author_key: m.author_key,
      author_name: m.author_name,
      mention: m.mention,
      preview: m.preview,
    });
  }

  /**
   * A login for the voice relay (Cloudflare TURN), for when a direct path fails. Kept and
   * reused for half its life, so the relay's API is asked rarely.
   */
  private async relayLogin(ws: WebSocket) {
    const fail = (message: string) => this.send(ws, { type: "error", message, for: "turn_login" });
    if (!relayConfigured(this.env)) return fail("The voice relay isn't set up on this Hopp Cloud.");
    const now = Date.now();
    const kept = this.meta("turn_login");
    if (kept) {
      const { login, until } = JSON.parse(kept);
      if (until > now) return this.send(ws, { type: "turn_login", login });
    }
    const day = new Date().toISOString().slice(0, 10);
    const [d, n] = (this.meta("turn_today") ?? "").split(" ");
    const count = d === day ? Number(n) : 0;
    if (count >= RELAY_LOGINS_PER_DAY) return fail("The voice relay is busy for you today. Try again tomorrow.");
    this.setMeta("turn_today", `${day} ${count + 1}`);
    const got = await directory(this.env).relayLogin();
    if (!got.login) return fail(got.error ?? "The voice relay isn't available.");
    // Kept for half its life, so a rejoin doesn't fetch a new one.
    this.setMeta("turn_login", JSON.stringify({ login: got.login, until: now + (LOGIN_TTL_S / 2) * 1000 }));
    return this.send(ws, { type: "turn_login", login: got.login });

  }

  /** A file handshake from a friend. False when none of our devices is online. */
  async fileSignal(fromKey: string, transfer: string, sealed: string): Promise<boolean> {
    if (this.friend(fromKey)?.state !== "friend") return false;
    if (this.devices().length === 0) return false;
    this.toDevices({ type: "file_signal", from: fromKey, transfer, sealed });
    return true;
  }

  /** A call signal from a friend. False when none of our devices is online to hear it. */
  async callSignal(fromKey: string, signal: Record<string, unknown>): Promise<boolean> {
    if (this.friend(fromKey)?.state !== "friend") return false;
    if (this.devices().length === 0) return false;
    this.toDevices({ ...signal, type: "call", from: fromKey });
    return true;
  }

  async profileChanged(fromKey: string, profile: PublicProfile): Promise<void> {
    const row = this.friend(fromKey);
    if (!row || row.state === "blocked") return;
    this.sql.exec("UPDATE friends SET username = ?, display_name = ?, avatar = ? WHERE key = ?", profile.username, profile.display_name, profile.avatar, fromKey);
    this.toDevices({ type: "friend", friend: this.friend(fromKey) });
  }
}
