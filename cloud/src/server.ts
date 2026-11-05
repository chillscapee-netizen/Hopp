// One Hopp server: accounts, invites, bans, channels and chat in this
// Durable Object's SQLite database, with members connected over hibernatable
// WebSockets. Speaks the same JSON messages as the self-hosted Rust server.

import { DurableObject } from "cloudflare:workers";
import { troubleMessage } from "./trouble";
import type { Env } from "./index";
import { inviteIndex } from "./invites";
import { accountOf } from "./account";

const PROTOCOL_VERSION = 5;
const MAX_NAME_LEN = 32;
const MAX_SERVER_NAME_LEN = 40;
const MAX_ICON_LEN = 200_000;
const MAX_CHAT_LEN = 2000;
const MAX_CHANNELS = 50;
const MAX_MEMBERS_ONLINE = 500;
/** A search returns at most this many messages, newest first. */
const SEARCH_RESULTS = 25;
/** The least time between one person's searches. */
const SEARCH_GAP_MS = 400;
/** Apps ping every 10 seconds; a connection silent this long is gone. */
const STALE_SESSION_MS = 30_000;
/** Messages per channel replayed at login, and kept in storage. */
const CHAT_HISTORY = 100;
const CHAT_KEEP = 1000;
/** Chat flood protection: a burst of this many, then one per second. */
const CHAT_BURST = 5;
const CHAT_PER_SECOND = 1;
const TYPING_INTERVAL_MS = 2000;
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** Voice endpoints: "a.b.c.d:port", a few local addresses at most. */
// "ip:port" for IPv4, "[ip]:port" for IPv6.
const ENDPOINT = /^(?:\d{1,3}(\.\d{1,3}){3}|\[[0-9a-fA-F:.]{2,45}\]):\d{1,5}$/;
const MAX_LOCAL_ENDPOINTS = 4;
const MAX_REACTIONS = 20;
/** Peer-to-peer voice: each person sends to every other, so keep channels small. */
const MAX_VOICE_PEERS = 10;
const REPLY_PREVIEW_LEN = 120;
const OLDER_PAGE = 50;

/** An emoji (or short emoji sequence): no spaces, no plain letters or digits. */
function validEmoji(emoji: string): boolean {
  return emoji.length > 0 && new TextEncoder().encode(emoji).length <= 32 && [...emoji].every((c) => c.codePointAt(0)! > 127 && !/\s/u.test(c));
}

function replyPreview(text: string): string {
  const chars = [...text];
  return chars.length > REPLY_PREVIEW_LEN ? chars.slice(0, REPLY_PREVIEW_LEN).join("") + "…" : text;
}

/** A stored row as the message clients see. */
function rowToMessage(r: Record<string, any>): ChatMessage {
  const m: ChatMessage = {
    id: Number(r.id), channel: Number(r.channel), sender: Number(r.sender), sender_name: String(r.sender_name),
    author_key: String(r.author_key), text: String(r.text), sent_at: Number(r.sent_at),
  };
  if (r.reply_id !== null && r.reply_id !== undefined) {
    m.reply = { id: Number(r.reply_id), sender_name: String(r.reply_name), author_key: String(r.reply_key), text: String(r.reply_text) };
  }
  if (r.edited_at !== null && r.edited_at !== undefined) m.edited_at = Number(r.edited_at);
  if (r.reactions) m.reactions = JSON.parse(String(r.reactions));
  if (r.pinned) m.pinned = true;
  return m;
}
/** A mention in message text: <@hex key of their Hopp ID>. */
const MENTION = /<@([0-9a-f]{64})>/g;

type ChannelKind = "text" | "voice";
interface Channel { id: number; name: string; kind: ChannelKind; topic?: string; category?: string; no_pictures?: boolean }
const MAX_CATEGORY_LEN = 24;
const MAX_TOPIC_LEN = 200;
interface User {
  session_id: number;
  name: string;
  voice_channel: number | null;
  muted: boolean;
  deafened: boolean;
  owner: boolean;
  public_key: string;
  role?: Role;
}
/** Who may do what: the owner names admins, admins name moderators. */
type Role = "owner" | "admin" | "mod";
const RANK: Record<string, number> = { owner: 3, admin: 2, mod: 1 };
const rank = (role: Role | null | undefined) => (role ? RANK[role] : 0);
interface Member { public_key: string; name: string; role: Role | null; joined_at: number }
interface Reply { id: number; sender_name: string; author_key: string; text: string }
interface Reaction { emoji: string; keys: string[] }
interface ChatMessage {
  id: number;
  channel: number;
  sender: number;
  sender_name: string;
  author_key: string;
  text: string;
  sent_at: number;
  reply?: Reply;
  edited_at?: number;
  reactions?: Reaction[];
  pinned?: boolean;
}
interface Invite { code: string; created_at: number; expires_at: number | null; max_uses: number | null; uses: number }
interface Ban { public_key: string; name: string; banned_at: number }
/** Where someone in a voice channel can be reached directly; voice on cloud servers is peer to peer. */
interface Endpoint { public: string | null; local: string[] }

/** What we remember about each socket; survives hibernation (max 2 KB). */
interface Session {
  stage: "hello" | "auth" | "joined" | "removed";
  /** When it joined: a new session isn't mistaken for a silent one before its first ping. */
  joinedAt?: number;
  /** When it last searched, to keep searches from hogging the server. */
  searchedAt?: number;
  nonce?: string;
  key?: string;
  name?: string;
  invite?: string | null;
  create?: string | null;
  user?: User;
  tokens?: number;
  refilled?: number;
  lastTyping?: number;
  endpoint?: Endpoint;
}

type ClientMsg = { type: string; [field: string]: any };

// Pictures in chat live in the server's own database: small (the app shrinks them
// first), signed by the uploader, and capped so the free plan's storage lasts.
const MAX_IMAGE_BYTES = 320_000;
const MAX_IMAGE_STORE = 100_000_000;
const IMAGES_PER_DAY = 40;
const UPLOAD_CLOCK_SKEW_MS = 5 * 60_000;
/** A picture message: "hopp-image:<id> <width>x<height>", then an optional caption. */
const IMAGE_TOKEN = /^hopp-image:([0-9a-f]{32}) (\d{1,5})x(\d{1,5})(?:\n|$)/;
const IMAGE_TYPES: Record<string, (b: Uint8Array) => boolean> = {
  "image/webp": (b) => b.length > 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP",
  "image/jpeg": (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
};

/** What notifications and replies show for a message: a picture reads as "Image". */
function plainText(text: string): string {
  const m = text.match(IMAGE_TOKEN);
  if (!m) return text;
  const caption = text.slice(m[0].length).trim();
  return caption ? `🖼 ${caption}` : "🖼 Image";
}

const hexToBytes = (hex: string): Uint8Array | null => {
  if (!/^([0-9a-f]{2})*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const bytesToHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** What a client signs to prove it holds its Hopp ID's private key. */
function authMessage(nonce: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode("strom-auth-v1\0");
  const msg = new Uint8Array(prefix.length + nonce.length);
  msg.set(prefix);
  msg.set(nonce, prefix.length);
  return msg;
}

/** Only small inline PNG, JPEG or WebP pictures; never remote URLs or SVG. */
function validIcon(icon: string): boolean {
  return (
    icon.length <= MAX_ICON_LEN &&
    /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(icon)
  );
}

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => INVITE_ALPHABET[b % INVITE_ALPHABET.length]).join("");
}

function inviteUsable(i: Invite, now: number): boolean {
  return (i.expires_at === null || now < i.expires_at) && (i.max_uses === null || i.uses < i.max_uses);
}

/** Text channels follow the usual chat convention: lowercase, dashes for spaces. */
function normalizeChannelName(name: string, kind: ChannelKind): string {
  const trimmed = String(name ?? "").trim();
  return kind === "voice" ? trimmed : trimmed.toLowerCase().split(/\s+/).filter(Boolean).join("-");
}

export class StromServer extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS channels (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (key TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER, max_uses INTEGER, uses INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bans (key TEXT PRIMARY KEY, name TEXT NOT NULL, banned_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, channel INTEGER NOT NULL, sender INTEGER NOT NULL,
        sender_name TEXT NOT NULL, author_key TEXT NOT NULL, text TEXT NOT NULL, sent_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_by_channel ON messages (channel, id);
      CREATE TABLE IF NOT EXISTS notified (key TEXT NOT NULL, channel INTEGER NOT NULL, PRIMARY KEY (key, channel));
      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY, uploader TEXT NOT NULL, type TEXT NOT NULL, data BLOB NOT NULL,
        size INTEGER NOT NULL, created_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
    `);
    // Channel order and topics came later too.
    const channelColumns = new Set(this.sql.exec("PRAGMA table_info(channels)").toArray().map((c) => String(c.name)));
    if (!channelColumns.has("position")) this.sql.exec("ALTER TABLE channels ADD COLUMN position INTEGER");
    if (!channelColumns.has("topic")) this.sql.exec("ALTER TABLE channels ADD COLUMN topic TEXT");
    if (!channelColumns.has("category")) this.sql.exec("ALTER TABLE channels ADD COLUMN category TEXT");
    if (!channelColumns.has("no_pictures")) this.sql.exec("ALTER TABLE channels ADD COLUMN no_pictures INTEGER");
    const accountColumns = new Set(this.sql.exec("PRAGMA table_info(accounts)").toArray().map((c) => String(c.name)));
    if (!accountColumns.has("role")) this.sql.exec("ALTER TABLE accounts ADD COLUMN role TEXT");
    const inviteColumns = new Set(this.sql.exec("PRAGMA table_info(invites)").toArray().map((c) => String(c.name)));
    if (!inviteColumns.has("inviter")) this.sql.exec("ALTER TABLE invites ADD COLUMN inviter TEXT");
    // Replies, edits and reactions came later: add their columns to older servers.
    const columns = new Set(this.sql.exec("PRAGMA table_info(messages)").toArray().map((c) => String(c.name)));
    for (const [name, type] of [["pinned", "INTEGER"], ["reply_id", "INTEGER"], ["reply_name", "TEXT"], ["reply_key", "TEXT"], ["reply_text", "TEXT"], ["edited_at", "INTEGER"], ["reactions", "TEXT"]]) {
      if (!columns.has(name)) this.sql.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
    }
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  async fetch(request: Request): Promise<Response> {
    const serverId = request.headers.get("X-Strom-Server");
    if (serverId && this.meta("server_id") === null) this.setMeta("server_id", serverId);
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

  /** What an invite shows before joining: like an invite card, nothing more. */
  async preview(code: string) {
    const name = this.meta("name");
    if (name === null || !this.invites().some((i) => i.code === code)) return null;
    const members = Number(this.sql.exec("SELECT count(*) AS n FROM accounts").one().n);
    const found = this.sql.exec("SELECT inviter FROM invites WHERE code = ?", code).toArray()[0]?.inviter;
    const inviter = typeof found === "string" ? found : null;
    return { name, icon: this.meta("icon"), members, online: this.members().length, inviter };
  }

  // ---------- pictures ----------

  private serveImage(id: string): Response {
    const row = this.sql.exec("SELECT type, data FROM images WHERE id = ?", id).toArray()[0];
    if (!row) return new Response("Gone", { status: 404 });
    return new Response(row.data as ArrayBuffer, {
      headers: { "content-type": String(row.type), "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" },
    });
  }

  /** A member uploads a picture, signed with their Hopp ID; answered with its id. */
  private async uploadImage(request: Request): Promise<Response> {
    const fail = (error: string, status = 400) => Response.json({ error }, { status });
    if (this.meta("name") === null) return fail("This server doesn't exist.", 404);
    const key = (request.headers.get("X-Hopp-Key") ?? "").toLowerCase();
    const time = Number(request.headers.get("X-Hopp-Time"));
    const signature = hexToBytes(request.headers.get("X-Hopp-Signature") ?? "");
    const type = (request.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!/^[0-9a-f]{64}$/.test(key) || signature?.length !== 64) return fail("Not signed.", 401);
    if (!Number.isFinite(time) || Math.abs(Date.now() - time) > UPLOAD_CLOCK_SKEW_MS) return fail("Your computer's clock is off. Check the time and try again.", 401);
    if (!IMAGE_TYPES[type]) return fail("Only WebP, JPEG and PNG pictures.");
    const data = new Uint8Array(await request.arrayBuffer());
    if (data.length === 0 || data.length > MAX_IMAGE_BYTES) return fail("That picture is too big.");
    if (!IMAGE_TYPES[type](data)) return fail("That file isn't the picture it says it is.");
    const digest = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
    const signed = new TextEncoder().encode(`hopp-image-v1\0${this.meta("server_id") ?? ""}\0${digest}\0${time}`);
    let valid = false;
    try {
      const pub = await crypto.subtle.importKey("raw", hexToBytes(key)!, { name: "Ed25519" }, false, ["verify"]);
      valid = await crypto.subtle.verify({ name: "Ed25519" }, pub, signature, signed);
    } catch {
      valid = false;
    }
    if (!valid) return fail("Not signed.", 401);
    const member = this.sql.exec("SELECT 1 FROM accounts WHERE key = ?", key).toArray().length > 0;
    const banned = this.sql.exec("SELECT 1 FROM bans WHERE key = ?", key).toArray().length > 0;
    if (!member || banned) return fail("You're not a member of this server.", 403);
    if (this.meta("pictures_off") === "1") return fail("Pictures are turned off in this server.", 403);
    const now = Date.now();
    const today = Number(this.sql.exec("SELECT count(*) AS n FROM images WHERE uploader = ? AND created_at > ?", key, now - 86_400_000).one().n);
    if (today >= IMAGES_PER_DAY) return fail("You've shared a lot of pictures today. Try again tomorrow.", 429);
    // Pictures picked but never sent are let go after a day.
    this.sql.exec("DELETE FROM images WHERE used = 0 AND created_at < ?", now - 86_400_000);
    const id = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
    this.sql.exec("INSERT INTO images (id, uploader, type, data, size, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, key, type, data, data.length, now);
    // Over the server's share of storage: the oldest pictures make room.
    let total = Number(this.sql.exec("SELECT coalesce(sum(size), 0) AS n FROM images").one().n);
    while (total > MAX_IMAGE_STORE) {
      const oldest = this.sql.exec("SELECT id, size FROM images ORDER BY created_at LIMIT 1").toArray()[0];
      if (!oldest) break;
      this.sql.exec("DELETE FROM images WHERE id = ?", oldest.id);
      total -= Number(oldest.size);
    }
    return Response.json({ id });
  }

  /** A message being deleted: its picture goes too. */
  private dropPicture(messageId: number) {
    const text = this.sql.exec("SELECT text FROM messages WHERE id = ?", messageId).toArray()[0]?.text;
    const picture = typeof text === "string" ? text.match(IMAGE_TOKEN) : null;
    if (picture) this.sql.exec("DELETE FROM images WHERE id = ?", picture[1]);
  }

  // ---------- storage helpers ----------

  private meta(key: string): string | null {
    const row = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row ? String(row.value) : null;
  }

  private setMeta(key: string, value: string) {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  private channels(): Channel[] {
    return this.sql
      .exec("SELECT id, name, kind, topic, category, no_pictures FROM channels ORDER BY coalesce(position, id + 100000), id")
      .toArray()
      .map((r) => {
        const c: Channel = { id: Number(r.id), name: String(r.name), kind: r.kind as ChannelKind };
        if (r.topic) c.topic = String(r.topic);
        if (r.category) c.category = String(r.category);
        if (r.no_pictures) c.no_pictures = true;
        return c;
      });
  }

  private channel(id: number): Channel | undefined {
    return this.channels().find((c) => c.id === id);
  }

  private invites(): Invite[] {
    const now = Date.now();
    const all = this.sql.exec("SELECT * FROM invites ORDER BY created_at").toArray() as unknown as Invite[];
    for (const dead of all.filter((i) => !inviteUsable(i, now))) this.sql.exec("DELETE FROM invites WHERE code = ?", dead.code);
    return all.filter((i) => inviteUsable(i, now));
  }

  /** Someone's role here; the owner is kept in meta, everyone else in accounts. */
  private roleOf(key: string): Role | null {
    if (this.meta("owner") === key) return "owner";
    const r = this.sql.exec("SELECT role FROM accounts WHERE key = ?", key).toArray()[0]?.role;
    return r === "admin" || r === "mod" ? r : null;
  }

  private memberList(): Member[] {
    const owner = this.meta("owner");
    return this.sql
      .exec("SELECT key, name, role, created_at FROM accounts ORDER BY lower(name)")
      .toArray()
      .map((r) => ({
        public_key: String(r.key),
        name: String(r.name),
        role: r.key === owner ? "owner" : r.role === "admin" || r.role === "mod" ? (r.role as Role) : null,
        joined_at: Number(r.created_at),
      }));
  }

  /** A role changed: everyone online sees it at once, and staff get the new list. */
  private rolesChanged() {
    for (const [mws, m] of this.members()) {
      const role = this.roleOf(m.key!);
      if (m.user!.role !== (role ?? undefined)) {
        this.updateUser(mws, m, (u) => {
          u.owner = role === "owner";
          if (role) u.role = role;
          else delete u.role;
        });
      }
      if (rank(role) >= RANK.admin) this.send(mws, { type: "members", members: this.memberList() });
    }
  }

  private bans(): Ban[] {
    return this.sql.exec("SELECT key AS public_key, name, banned_at FROM bans ORDER BY banned_at").toArray() as unknown as Ban[];
  }

  private history(channel: number, before = Number.MAX_SAFE_INTEGER, limit = CHAT_HISTORY): ChatMessage[] {
    return this.sql
      .exec("SELECT * FROM messages WHERE channel = ? AND id < ? ORDER BY id DESC LIMIT ?", channel, before, limit)
      .toArray()
      .map(rowToMessage)
      .reverse();
  }

  private message(channel: number, id: number): ChatMessage | null {
    const row = this.sql.exec("SELECT * FROM messages WHERE channel = ? AND id = ?", channel, id).toArray()[0];
    return row ? rowToMessage(row) : null;
  }

  // ---------- socket helpers ----------

  private session(ws: WebSocket): Session {
    return (ws.deserializeAttachment() as Session) ?? { stage: "hello" };
  }

  private send(ws: WebSocket, msg: object) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // The socket is closing; it will be cleaned up by webSocketClose.
    }
  }

  private error(ws: WebSocket, message: string) {
    this.send(ws, { type: "error", message });
  }

  /** Rejects a login: tells the client why, then hangs up. */
  private reject(ws: WebSocket, message: string) {
    this.error(ws, message);
    ws.serializeAttachment({ stage: "removed" } satisfies Session);
    ws.close(4000, "rejected");
  }

  /**
   * Tells every member's account about a new message, so their apps can show
   * the server and channel as unread (and count mentions) while they're elsewhere.
   */
  private tellAccounts(m: ChatMessage, channelName: string) {
    const serverId = this.meta("server_id");
    if (!serverId) return;
    const names = new Map<string, string>();
    const keys: string[] = [];
    for (const row of this.sql.exec("SELECT key, name FROM accounts WHERE key NOT IN (SELECT key FROM bans) LIMIT 1000")) {
      keys.push(String(row.key));
      names.set(String(row.key), String(row.name));
    }
    const mentioned = new Set([...m.text.matchAll(MENTION)].map((x) => x[1]));
    if (m.reply) mentioned.add(m.reply.author_key);
    const preview = plainText(m.text).replace(MENTION, (_, key) => `@${names.get(key) ?? "someone"}`).slice(0, 200);
    const activity = {
      server: `cloud:${serverId}`,
      server_name: this.meta("name") ?? "",
      channel: m.channel,
      channel_name: channelName,
      id: m.id,
      at: m.sent_at,
      author_key: m.author_key,
      author_name: m.sender_name,
    };
    // Each call to an account counts against Cloudflare's free daily limit, so they're few:
    // people in the server already have the message, and the author has read it. Everyone
    // else hears once that a channel has news, until they next come in; mentions always.
    const here = new Set(this.members().map(([, s]) => s.key));
    const told = new Set(this.sql.exec("SELECT key FROM notified WHERE channel = ?", m.channel).toArray().map((r) => String(r.key)));
    for (const key of keys) {
      if (key === m.author_key) continue;
      const mention = mentioned.has(key);
      if (!mention && (here.has(key) || told.has(key))) continue;
      if (!here.has(key)) this.sql.exec("INSERT OR IGNORE INTO notified (key, channel) VALUES (?, ?)", key, m.channel);
      const call = accountOf(this.env, key).channelActivity({ ...activity, mention, preview });
      this.ctx.waitUntil(call.catch(() => {}));
    }
  }

  private members(): [WebSocket, Session][] {
    return this.ctx
      .getWebSockets()
      .map((ws) => [ws, this.session(ws)] as [WebSocket, Session])
      .filter(([, s]) => s.stage === "joined" && s.user);
  }

  private voiceMembers(channel: number): [WebSocket, Session][] {
    return this.members().filter(([, s]) => s.user!.voice_channel === channel);
  }

  private broadcast(msg: object, except?: WebSocket) {
    const text = JSON.stringify(msg);
    for (const [ws] of this.members()) {
      if (ws === except) continue;
      try {
        ws.send(text);
      } catch {
        // Closing; ignore.
      }
    }
  }

  private updateUser(ws: WebSocket, s: Session, change: (u: User) => void) {
    change(s.user!);
    ws.serializeAttachment(s);
    this.broadcast({ type: "user_updated", user: s.user });
  }

  // ---------- messages ----------

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    // Room for a server picture in an update_server message.
    if (typeof data !== "string" || data.length > 262_144) return this.reject(ws, "Message too large.");
    let msg: ClientMsg;
    try {
      msg = JSON.parse(data);
    } catch {
      return this.reject(ws, "Malformed message.");
    }
    const s = this.session(ws);
    if (s.stage === "hello") return this.onHello(ws, msg);
    if (s.stage === "auth") return this.onAuth(ws, s, msg);
    try {
      if (s.stage === "joined") return await this.onMember(ws, s, msg);
    } catch (err) {
      this.error(ws, troubleMessage(err));
    }
  }

  private onHello(ws: WebSocket, msg: ClientMsg) {
    if (msg.type !== "hello") return this.reject(ws, "Expected hello.");
    if (msg.protocol_version !== PROTOCOL_VERSION) {
      return this.reject(ws, `The server speaks protocol ${PROTOCOL_VERSION}, the app speaks ${msg.protocol_version}.`);
    }
    const name = String(msg.name ?? "").trim();
    if (!name || [...name].length > MAX_NAME_LEN) return this.reject(ws, `Names must be 1–${MAX_NAME_LEN} characters.`);
    const key = String(msg.public_key ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(key)) return this.reject(ws, "Invalid Hopp ID.");

    const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const session: Session = {
      stage: "auth",
      nonce,
      key,
      name,
      invite: msg.invite ? String(msg.invite).toUpperCase() : null,
      create: msg.create ? String(msg.create).trim() : null,
    };
    ws.serializeAttachment(session);
    this.send(ws, { type: "challenge", nonce });
  }

  private async onAuth(ws: WebSocket, s: Session, msg: ClientMsg) {
    if (msg.type !== "auth") return this.reject(ws, "Expected auth.");
    const signature = hexToBytes(String(msg.signature ?? ""));
    const keyBytes = hexToBytes(s.key!);
    let valid = false;
    if (signature?.length === 64 && keyBytes) {
      try {
        const key = await crypto.subtle.importKey("raw", keyBytes, { name: "Ed25519" }, false, ["verify"]);
        valid = await crypto.subtle.verify({ name: "Ed25519" }, key, signature, authMessage(hexToBytes(s.nonce!)!));
      } catch {
        valid = false;
      }
    }
    if (!valid) return this.reject(ws, "Login failed: invalid signature.");

    const now = Date.now();
    const key = s.key!;
    const name = s.name!;

    // A brand-new server is created by whoever asks for it first; they own it.
    if (this.meta("name") === null) {
      const serverName = (s.create ?? "").trim();
      if (!serverName) return this.reject(ws, "This server doesn't exist.");
      if ([...serverName].length > MAX_SERVER_NAME_LEN) {
        return this.reject(ws, `Server names must be 1–${MAX_SERVER_NAME_LEN} characters.`);
      }
      if (this.env.PAUSE_NEW === "1") return this.reject(ws, "New servers are paused right now. Try again in a while.");
      if (!(await accountOf(this.env, key).allowNewServer())) return this.reject(ws, "You've created a lot of servers today. Try again tomorrow.");
      this.setMeta("name", serverName);
      this.setMeta("owner", key);
      this.setMeta("created_at", String(now));
      for (const [n, kind] of [["general", "text"], ["Lobby", "voice"], ["Gaming", "voice"]]) {
        this.sql.exec("INSERT INTO channels (name, kind) VALUES (?, ?)", n, kind);
      }
    } else if (s.create) {
      return this.reject(ws, "That server already exists.");
    }

    if (this.sql.exec("SELECT 1 FROM bans WHERE key = ?", key).toArray().length) {
      return this.reject(ws, "You are banned from this server.");
    }
    // The same Hopp ID on another computer stays connected too. A connection that has
    // stopped pinging (a crashed app, a dropped network) is let go, so it doesn't linger.
    for (const [oldWs, old] of this.members().filter(([, m]) => m.key === key)) {
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(oldWs)?.getTime() ?? 0;
      if (Date.now() - Math.max(pinged, old.joinedAt ?? 0) < STALE_SESSION_MS) continue;
      oldWs.serializeAttachment({ stage: "removed" } satisfies Session);
      try {
        oldWs.close(4002, "replaced");
      } catch {
        // Already gone.
      }
      this.broadcast({ type: "user_left", session_id: old.user!.session_id });
    }
    if (this.members().length >= MAX_MEMBERS_ONLINE) return this.reject(ws, "The server is full.");
    // Display names needn't be unique (two friends can both be "Alex"); the Hopp ID tells them apart.

    const isOwner = this.meta("owner") === key;
    const known = this.sql.exec("SELECT 1 FROM accounts WHERE key = ?", key).toArray().length > 0;
    if (!known && !isOwner) {
      if (!s.invite) return this.reject(ws, "This server is invite-only. Ask the owner for an invite link.");
      const invite = this.invites().find((i) => i.code === s.invite);
      if (!invite) return this.reject(ws, "This invite is invalid or has expired.");
      this.sql.exec("UPDATE invites SET uses = uses + 1 WHERE code = ?", invite.code);
    }
    this.sql.exec(
      "INSERT INTO accounts (key, name, created_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET name = excluded.name",
      key, name, now,
    );

    // Back in the server: the next news in each channel reaches their account again.
    this.sql.exec("DELETE FROM notified WHERE key = ?", key);
    const user: User = {
      session_id: crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff,
      name,
      voice_channel: null,
      muted: false,
      deafened: false,
      owner: isOwner,
      public_key: key,
    };
    const role = this.roleOf(key);
    if (role) user.role = role;
    const joined: Session = { stage: "joined", key, name, user, tokens: CHAT_BURST, refilled: now, joinedAt: now };
    this.broadcast({ type: "user_joined", user });
    ws.serializeAttachment(joined);
    const channels = this.channels();
    this.send(ws, {
      type: "welcome",
      server_name: this.meta("name"),
      server_icon: this.meta("icon"),
      pictures_off: this.meta("pictures_off") === "1",
      session_id: user.session_id,
      // Cloud servers carry no UDP voice relay; voice between members is peer-to-peer.
      udp_token: 0,
      udp_port: 0,
      channels,
      users: this.members().map(([, m]) => m.user),
      features: ["search"],
    });
    for (const ch of channels.filter((c) => c.kind === "text")) {
      this.send(ws, { type: "chat_history", channel: ch.id, messages: this.history(ch.id) });
    }
  }

  private async onMember(ws: WebSocket, s: Session, msg: ClientMsg) {
    const user = s.user!;
    const owner = user.owner;
    const myRole = this.roleOf(s.key!);
    const myRank = rank(myRole);
    const ownerOnly = () => {
      if (!owner) this.error(ws, "Only the server owner can do that.");
      return owner;
    };
    /** At least this role, or a polite no. */
    const allowed = (min: Role) => {
      if (myRank >= RANK[min]) return true;
      this.error(ws, min === "admin" ? "Only admins and the owner can do that." : "Only moderators, admins and the owner can do that.");
      return false;
    };

    switch (msg.type) {
      case "join_voice": {
        const ch = this.channel(Number(msg.channel));
        if (ch?.kind !== "voice") return this.error(ws, "That voice channel doesn't exist.");
        const others = this.voiceMembers(ch.id).filter(([other]) => other !== ws);
        // Everyone sends to everyone directly, so a channel can only hold so many.
        if (others.length >= MAX_VOICE_PEERS) return this.error(ws, `${ch.name} is full (${MAX_VOICE_PEERS} people). Try another voice channel.`);
        // A fresh key whenever a channel fills up again, so people who left can't listen in later.
        let key = this.meta(`voice_key:${ch.id}`);
        if (!key || others.length === 0) {
          key = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
          this.setMeta(`voice_key:${ch.id}`, key);
        }
        delete s.endpoint;
        this.updateUser(ws, s, (u) => (u.voice_channel = ch.id));
        const peers = others
          .filter(([, o]) => o.endpoint)
          .map(([, o]) => ({ session_id: o.user!.session_id, ...o.endpoint }));
        return this.send(ws, { type: "voice_session", channel: ch.id, key, peers });
      }
      case "leave_voice":
        delete s.endpoint;
        return this.updateUser(ws, s, (u) => (u.voice_channel = null));
      case "voice_endpoint": {
        const channel = user.voice_channel;
        if (channel === null) return;
        const pub = typeof msg.public === "string" && ENDPOINT.test(msg.public) ? msg.public : null;
        const local = (Array.isArray(msg.local) ? msg.local : [])
          .filter((a: unknown) => typeof a === "string" && ENDPOINT.test(a))
          .slice(0, MAX_LOCAL_ENDPOINTS);
        s.endpoint = { public: pub, local };
        ws.serializeAttachment(s);
        const peer = { session_id: user.session_id, ...s.endpoint };
        for (const [other] of this.voiceMembers(channel)) {
          if (other !== ws) this.send(other, { type: "voice_peer", peer });
        }
        return;
      }
      case "set_state":
        return this.updateUser(ws, s, (u) => {
          u.muted = !!msg.muted;
          u.deafened = !!msg.deafened;
        });
      case "send_chat": {
        const ch = this.channel(Number(msg.channel));
        const text = String(msg.text ?? "").trim();
        if (ch?.kind !== "text") return this.error(ws, "That text channel doesn't exist.");
        if (!text || [...text].length > MAX_CHAT_LEN) return this.error(ws, `Messages must be 1–${MAX_CHAT_LEN} characters.`);
        const now = Date.now();
        s.tokens = Math.min(CHAT_BURST, (s.tokens ?? CHAT_BURST) + ((now - (s.refilled ?? now)) / 1000) * CHAT_PER_SECOND);
        s.refilled = now;
        if (s.tokens < 1) {
          ws.serializeAttachment(s);
          return this.error(ws, "You're sending messages too fast. Slow down a little.");
        }
        s.tokens -= 1;
        ws.serializeAttachment(s);
        const picture = text.match(IMAGE_TOKEN);
        if (picture && (this.meta("pictures_off") === "1" || ch.no_pictures)) {
          this.sql.exec("DELETE FROM images WHERE id = ?", picture[1]);
          return this.error(ws, "Pictures are turned off here.");
        }
        if (picture) {
          const owned = this.sql.exec("SELECT 1 FROM images WHERE id = ? AND uploader = ?", picture[1], s.key!).toArray().length > 0;
          if (!owned) return this.error(ws, "That picture didn't upload. Try again.");
          this.sql.exec("UPDATE images SET used = 1 WHERE id = ?", picture[1]);
        }
        const answered = msg.reply_to != null ? this.message(ch.id, Number(msg.reply_to)) : null;
        const reply: Reply | undefined = answered
          ? { id: answered.id, sender_name: answered.sender_name, author_key: answered.author_key, text: replyPreview(answered.text) }
          : undefined;
        const row = this.sql
          .exec(
            `INSERT INTO messages (channel, sender, sender_name, author_key, text, sent_at, reply_id, reply_name, reply_key, reply_text)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            ch.id, user.session_id, user.name, s.key!, text, now,
            reply?.id ?? null, reply?.sender_name ?? null, reply?.author_key ?? null, reply?.text ?? null,
          )
          .one();
        this.sql.exec(
          "DELETE FROM messages WHERE channel = ? AND id <= (SELECT id FROM messages WHERE channel = ? ORDER BY id DESC LIMIT 1 OFFSET ?)",
          ch.id, ch.id, CHAT_KEEP,
        );
        const message: ChatMessage = {
          id: Number(row.id), channel: ch.id, sender: user.session_id, sender_name: user.name,
          author_key: s.key!, text, sent_at: now,
        };
        if (reply) message.reply = reply;
        this.broadcast({ type: "chat", message });
        return this.tellAccounts(message, ch.name);
      }
      case "edit_message": {
        const channel = Number(msg.channel);
        const id = Number(msg.id);
        const text = String(msg.text ?? "").trim();
        if (!text || [...text].length > MAX_CHAT_LEN) return this.error(ws, `Messages must be 1–${MAX_CHAT_LEN} characters.`);
        const m = this.message(channel, id);
        if (!m) return this.error(ws, "That message no longer exists.");
        if (m.author_key !== s.key) return this.error(ws, "You can only edit your own messages.");
        const at = Date.now();
        this.sql.exec("UPDATE messages SET text = ?, edited_at = ? WHERE id = ?", text, at, id);
        return this.broadcast({ type: "message_edited", channel, id, text, edited_at: at });
      }
      case "react": {
        const channel = Number(msg.channel);
        const id = Number(msg.id);
        const emoji = String(msg.emoji ?? "");
        if (!validEmoji(emoji)) return this.error(ws, "That isn't an emoji.");
        const m = this.message(channel, id);
        if (!m) return this.error(ws, "That message no longer exists.");
        const reactions = m.reactions ?? [];
        const on = !!msg.on;
        const i = reactions.findIndex((r) => r.emoji === emoji);
        if (i >= 0) {
          reactions[i].keys = reactions[i].keys.filter((k) => k !== s.key);
          if (on) reactions[i].keys.push(s.key!);
          else if (reactions[i].keys.length === 0) reactions.splice(i, 1);
        } else if (on) {
          if (reactions.length >= MAX_REACTIONS) return this.error(ws, "That message has too many different reactions.");
          reactions.push({ emoji, keys: [s.key!] });
        }
        this.sql.exec("UPDATE messages SET reactions = ? WHERE id = ?", reactions.length ? JSON.stringify(reactions) : null, id);
        return this.broadcast({ type: "reactions", channel, id, reactions });
      }
      case "pin": {
        if (!allowed("mod")) return;
        const channel = Number(msg.channel);
        const id = Number(msg.id);
        if (!this.message(channel, id)) return this.error(ws, "That message no longer exists.");
        this.sql.exec("UPDATE messages SET pinned = ? WHERE id = ?", msg.on ? 1 : null, id);
        return this.broadcast({ type: "pinned", channel, id, on: !!msg.on });
      }
      case "get_pins": {
        const channel = Number(msg.channel);
        const messages = this.sql.exec("SELECT * FROM messages WHERE channel = ? AND pinned = 1 ORDER BY id DESC LIMIT 50", channel).toArray().map(rowToMessage);
        return this.send(ws, { type: "pins", channel, messages });
      }
      case "search": {
        const query = String(msg.query ?? "");
        const needle = query.trim();
        // One search at a time, a few a second at most: each one reads the whole history.
        const now = Date.now();
        if (now - (s.searchedAt ?? 0) < SEARCH_GAP_MS) return this.error(ws, "Searching too fast. Try again in a moment.");
        s.searchedAt = now;
        ws.serializeAttachment(s);
        if (needle.length < 2 || needle.length > 100) return this.send(ws, { type: "search_results", query, messages: [] });
        const pattern = "%" + needle.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
        const messages = this.sql
          .exec("SELECT * FROM messages WHERE text LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?", pattern, SEARCH_RESULTS)
          .toArray()
          .map(rowToMessage);
        return this.send(ws, { type: "search_results", query, messages });
      }
      case "load_older": {
        const channel = Number(msg.channel);
        const messages = this.history(channel, Number(msg.before), OLDER_PAGE + 1);
        const done = messages.length <= OLDER_PAGE;
        if (!done) messages.shift();
        return this.send(ws, { type: "older_history", channel, messages, done });
      }
      case "leave_server": {
        if (owner) return this.error(ws, "You own this server, so you can't leave it.");
        this.sql.exec("DELETE FROM accounts WHERE key = ?", s.key!);
        this.sql.exec("DELETE FROM notified WHERE key = ?", s.key!);
        for (const [lws, ls] of this.members().filter(([, m]) => m.key === s.key)) {
          this.send(lws, { type: "left" });
          lws.serializeAttachment({ stage: "removed" } satisfies Session);
          this.broadcast({ type: "user_left", session_id: ls.user!.session_id }, lws);
          lws.close(1000, "left");
        }
        return;
      }
      case "delete_message": {
        const channel = Number(msg.channel);
        const id = Number(msg.id);
        const row = this.sql.exec("SELECT author_key FROM messages WHERE channel = ? AND id = ?", channel, id).toArray()[0];
        if (!row) return this.error(ws, "That message no longer exists.");
        if (row.author_key !== s.key && (myRank < RANK.mod || (!owner && rank(this.roleOf(String(row.author_key))) >= myRank))) {
          return this.error(ws, "You can only delete your own messages.");
        }
        this.dropPicture(id);
        this.sql.exec("DELETE FROM messages WHERE id = ?", id);
        return this.broadcast({ type: "message_deleted", channel, id });
      }
      case "typing": {
        const now = Date.now();
        if (now - (s.lastTyping ?? 0) < TYPING_INTERVAL_MS) return;
        s.lastTyping = now;
        ws.serializeAttachment(s);
        return this.broadcast({ type: "typing", channel: Number(msg.channel), session_id: user.session_id }, ws);
      }
      case "create_channel": {
        if (!allowed("admin")) return;
        const kind: ChannelKind = msg.kind === "voice" ? "voice" : "text";
        const name = normalizeChannelName(msg.name, kind);
        if (!name || [...name].length > MAX_NAME_LEN) return this.error(ws, `Channel names must be 1–${MAX_NAME_LEN} characters.`);
        if (this.channels().length >= MAX_CHANNELS) return this.error(ws, `A server can have at most ${MAX_CHANNELS} channels.`);
        this.sql.exec("INSERT INTO channels (name, kind) VALUES (?, ?)", name, kind);
        return this.broadcast({ type: "channels_updated", channels: this.channels() });
      }
      case "update_channel": {
        if (!allowed("admin")) return;
        const ch = this.channel(Number(msg.channel));
        if (!ch) return this.error(ws, "That channel doesn't exist.");
        const name = normalizeChannelName(msg.name, ch.kind);
        if (!name || [...name].length > MAX_NAME_LEN) return this.error(ws, `Channel names must be 1–${MAX_NAME_LEN} characters.`);
        const topic = String(msg.topic ?? "").trim();
        if ([...topic].length > MAX_TOPIC_LEN) return this.error(ws, `Keep the topic under ${MAX_TOPIC_LEN} characters.`);
        const category = String(msg.category ?? "").trim();
        if ([...category].length > MAX_CATEGORY_LEN) return this.error(ws, `Category names are at most ${MAX_CATEGORY_LEN} characters.`);
        this.sql.exec("UPDATE channels SET name = ?, topic = ?, category = ? WHERE id = ?", name, topic || null, category || null, ch.id);
        if (msg.no_pictures != null) this.sql.exec("UPDATE channels SET no_pictures = ? WHERE id = ?", msg.no_pictures ? 1 : null, ch.id);
        return this.broadcast({ type: "channels_updated", channels: this.channels() });
      }
      case "reorder_channels": {
        if (!allowed("admin")) return;
        const order = Array.isArray(msg.order) ? msg.order.map(Number) : [];
        const ids = this.channels().map((c) => c.id);
        if (order.length !== ids.length || [...order].sort((a, b) => a - b).join() !== [...ids].sort((a, b) => a - b).join()) {
          return this.error(ws, "The channels changed meanwhile. Try again.");
        }
        order.forEach((id: number, i: number) => this.sql.exec("UPDATE channels SET position = ? WHERE id = ?", i, id));
        return this.broadcast({ type: "channels_updated", channels: this.channels() });
      }
      case "delete_channel": {
        if (!allowed("admin")) return;
        const id = Number(msg.channel);
        if (!this.channel(id)) return this.error(ws, "That channel doesn't exist.");
        this.sql.exec("DELETE FROM channels WHERE id = ?", id);
        this.sql.exec("DELETE FROM images WHERE id IN (SELECT substr(text, 12, 32) FROM messages WHERE channel = ? AND text LIKE 'hopp-image:%')", id);
        this.sql.exec("DELETE FROM messages WHERE channel = ?", id);
        for (const [mws, m] of this.members()) {
          if (m.user!.voice_channel === id) this.updateUser(mws, m, (u) => (u.voice_channel = null));
        }
        return this.broadcast({ type: "channels_updated", channels: this.channels() });
      }
      case "kick":
      case "ban": {
        const banned = msg.type === "ban";
        if (!allowed(banned ? "admin" : "mod")) return;
        const target = Number(msg.session_id);
        if (target === user.session_id) return this.error(ws, "You can't remove yourself.");
        const victim = this.members().find(([, m]) => m.user!.session_id === target);
        if (!victim) return this.error(ws, "That person isn't connected anymore.");
        const [vws, vs] = victim;
        if (rank(this.roleOf(vs.key!)) >= myRank) return this.error(ws, `You can't ${banned ? "ban" : "kick"} someone with the same role as you or higher.`);
        if (banned) {
          this.sql.exec(
            "INSERT INTO bans (key, name, banned_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING",
            vs.key!, vs.user!.name, Date.now(),
          );
          this.send(ws, { type: "bans", bans: this.bans() });
        }
        // Every device of theirs goes.
        for (const [ows, os] of this.members().filter(([, m]) => m.key === vs.key)) {
          this.send(ows, { type: "kicked", banned });
          ows.serializeAttachment({ stage: "removed" } satisfies Session);
          ows.close(4001, banned ? "banned" : "kicked");
          this.broadcast({ type: "user_left", session_id: os.user!.session_id });
        }
        return;
      }
      case "unban":
        if (!allowed("admin")) return;
        this.sql.exec("DELETE FROM bans WHERE key = ?", String(msg.public_key ?? ""));
        return this.send(ws, { type: "bans", bans: this.bans() });
      case "create_invite": {
        if (!allowed("admin")) return;
        const now = Date.now();
        const hours = msg.expires_in_hours == null ? null : Math.max(1, Number(msg.expires_in_hours));
        const maxUses = msg.max_uses == null ? null : Math.max(1, Number(msg.max_uses));
        const expiresAt = hours === null ? null : now + hours * 3_600_000;
        // Codes are short, so claim one in the global register; retry on the rare clash.
        const serverId = this.meta("server_id");
        let code = newCode();
        for (let attempt = 0; serverId && attempt < 5; attempt++, code = newCode()) {
          if (await inviteIndex(this.env).register(code, serverId, expiresAt)) break;
          if (attempt === 4) return this.error(ws, "Couldn't create an invite right now. Try again.");
        }
        const invite: Invite = { code, created_at: now, expires_at: expiresAt, max_uses: maxUses, uses: 0 };
        this.sql.exec(
          "INSERT INTO invites (code, created_at, expires_at, max_uses, uses, inviter) VALUES (?, ?, ?, ?, 0, ?)",
          invite.code, invite.created_at, invite.expires_at, invite.max_uses, user.name,
        );
        this.send(ws, { type: "invite_created", invite });
        return this.send(ws, { type: "invites", invites: this.invites() });
      }
      case "delete_server": {
        if (!ownerOnly()) return;
        // Invite links stop working everywhere.
        for (const invite of this.invites()) await inviteIndex(this.env).remove(invite.code);
        // Everyone connected is told, then let go.
        for (const other of this.ctx.getWebSockets()) {
          this.send(other, { type: "server_deleted" });
          other.serializeAttachment({ stage: "removed" } satisfies Session);
          try {
            other.close(1000, "deleted");
          } catch {
            // Already closing.
          }
        }
        // Without a name the server no longer exists: nobody can join it again.
        for (const table of ["messages", "channels", "accounts", "invites", "bans", "notified", "images", "meta"]) this.sql.exec(`DELETE FROM ${table}`);
        return;
      }
      case "revoke_invite": {
        if (!allowed("admin")) return;
        const code = String(msg.code ?? "");
        this.sql.exec("DELETE FROM invites WHERE code = ?", code);
        await inviteIndex(this.env).remove(code);
        return this.send(ws, { type: "invites", invites: this.invites() });
      }
      case "update_server": {
        if (!allowed("admin")) return;
        const name = String(msg.name ?? "").trim();
        const icon = msg.icon == null ? null : String(msg.icon);
        if (!name || [...name].length > MAX_SERVER_NAME_LEN) {
          return this.error(ws, `Server names must be 1–${MAX_SERVER_NAME_LEN} characters.`);
        }
        if (icon !== null && !validIcon(icon)) return this.error(ws, "That picture can't be used. Try a PNG or JPEG image.");
        this.setMeta("name", name);
        if (icon === null) this.sql.exec("DELETE FROM meta WHERE key = 'icon'");
        else this.setMeta("icon", icon);
        if (msg.pictures_off != null) this.setMeta("pictures_off", msg.pictures_off ? "1" : "0");
        return this.broadcast({ type: "server_updated", name, icon, pictures_off: this.meta("pictures_off") === "1" });
      }
      case "get_server_settings":
        if (!allowed("admin")) return;
        this.send(ws, { type: "invites", invites: this.invites() });
        this.send(ws, { type: "members", members: this.memberList() });
        return this.send(ws, { type: "bans", bans: this.bans() });
      case "get_members":
        if (!allowed("admin")) return;
        return this.send(ws, { type: "members", members: this.memberList() });
      case "set_role": {
        if (!allowed("admin")) return;
        const key = String(msg.public_key ?? "");
        const role: Role | null = msg.role === "admin" || msg.role === "mod" ? msg.role : null;
        if (msg.role != null && role === null) return this.error(ws, "Unknown role.");
        if (key === s.key) return this.error(ws, "You can't change your own role.");
        const target = this.memberList().find((m) => m.public_key === key);
        if (!target) return this.error(ws, "They're not a member of this server anymore.");
        if (target.role === "owner") return this.error(ws, "The owner's role can't be changed.");
        // Admins handle moderators; only the owner names or removes admins.
        if (!owner && (role === "admin" || rank(target.role) >= myRank)) return this.error(ws, "Only the owner can name or remove admins.");
        this.sql.exec("UPDATE accounts SET role = ? WHERE key = ?", role, key);
        this.rolesChanged();
        return;
      }
      case "transfer_ownership": {
        if (!ownerOnly()) return;
        const key = String(msg.public_key ?? "");
        if (key === s.key) return this.error(ws, "You already own this server.");
        const target = this.memberList().find((m) => m.public_key === key);
        if (!target) return this.error(ws, "They're not a member of this server anymore.");
        if (this.sql.exec("SELECT 1 FROM bans WHERE key = ?", key).toArray().length) return this.error(ws, "That person is banned.");
        this.setMeta("owner", key);
        // The old owner stays on as an admin.
        this.sql.exec("UPDATE accounts SET role = 'admin' WHERE key = ?", s.key!);
        this.sql.exec("UPDATE accounts SET role = NULL WHERE key = ?", key);
        this.rolesChanged();
        return;
      }
      case "ping":
        return this.send(ws, { type: "pong" });
      case "set_loopback":
        // Loopback belongs to the UDP relay of self-hosted servers.
        return;
      default:
        return this.error(ws, `Unknown message type "${msg.type}".`);
    }
  }

  async webSocketClose(ws: WebSocket) {
    this.leave(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.leave(ws);
  }

  private leave(ws: WebSocket) {
    const s = this.session(ws);
    try {
      ws.serializeAttachment({ stage: "removed" } satisfies Session);
    } catch {
      // Already gone.
    }
    if (s.stage === "joined" && s.user) this.broadcast({ type: "user_left", session_id: s.user.session_id }, ws);
  }
}
