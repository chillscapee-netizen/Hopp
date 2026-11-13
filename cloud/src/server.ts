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
/** Threads a server keeps; past this, starting one lets the quietest old one go. */
const MAX_THREADS = 300;
const MAX_MEMBERS_ONLINE = 500;
/** A screen-sharing handshake message is never bigger than this. */
const MAX_SCREEN_SIGNAL = 65_536;

/** "10 minutes", "1 hour", "1 week". */
function durationText(minutes: number): string {
  if (minutes % 10080 === 0) return `${minutes / 10080} week${minutes === 10080 ? "" : "s"}`;
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
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
/** Everything a member sends: a burst, then this many a second. Floods are dropped. */
const ANY_BURST = 60;
const ANY_PER_SECOND = 15;
/** Reactions, edits and "is typing": things everyone in the channel is told about. */
const ACT_BURST = 10;
const ACT_PER_SECOND = 2;
/** Video handshakes come in bursts (network addresses), a lot more of them. */
const SIGNAL_BURST = 300;
const SIGNAL_PER_SECOND = 60;
/** Accounts told about a message straight away; the rest follow moments later, in turns. */
const TELL_AT_ONCE = 40;
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
/** A server's own emoji in text: <:name:id> (id 0: one of Hopp's own, built into the app). */
const CUSTOM_EMOJI = /^<:[a-z0-9_]{2,32}:\d{1,9}>$/;
const EMOJI_NAME = /^[a-z0-9_]{2,32}$/;
const MAX_EMOJIS = 100;

function validEmoji(emoji: string): boolean {
  if (CUSTOM_EMOJI.test(emoji)) return true;
  return emoji.length > 0 && new TextEncoder().encode(emoji).length <= 32 && [...emoji].every((c) => c.codePointAt(0)! > 127 && !/\s/u.test(c));
}

function replyPreview(text: string): string {
  const chars = [...text];
  return chars.length > REPLY_PREVIEW_LEN ? chars.slice(0, REPLY_PREVIEW_LEN).join("") + "…" : text;
}

/** A stored row as the message clients see. */
/** "from:elin in:general has:link gg" → the filters (lowercase) and the words left to find.
 *  Names with spaces go in quotes: from:"Big Sam". A leading @ or # is allowed. */
function parseSearch(query: string): { words: string; from: string[]; in: string[]; has: string[] } {
  const out = { words: "", from: [] as string[], in: [] as string[], has: [] as string[] };
  const rest = query.replace(/(^|\s)(from|in|has):(?:"([^"]{1,64})"|(\S{1,64}))/gi, (_, space, key, quoted, word) => {
    out[key.toLowerCase() as "from" | "in" | "has"].push(String(quoted ?? word).toLowerCase().replace(/^[@#]/, ""));
    return space;
  });
  out.words = rest.replace(/\s+/g, " ").trim();
  return out;
}

/** A poll's message: hopp-poll:<base64url {"q": question, "a": [answers], "end": ms, "multi": bool}>. */
function parsePoll(text: string): { answers: number; end: number; multi: boolean } | null {
  const m = text.match(/^hopp-poll:([A-Za-z0-9_-]{4,2600})$/);
  if (!m) return null;
  try {
    const bin = atob(m[1].replace(/-/g, "+").replace(/_/g, "/"));
    const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    const answers = Array.isArray(p.a) ? Math.min(p.a.length, 10) : 0;
    if (answers < 2 || !Number.isFinite(p.end)) return null;
    return { answers, end: Number(p.end), multi: !!p.multi };
  } catch {
    return null;
  }
}

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
interface Channel { id: number; name: string; kind: ChannelKind; topic?: string; category?: string; no_pictures?: boolean; user_limit?: number; afk_after?: number; slowmode?: number; private_roles?: number[]; parent?: number; starter?: number; last_at?: number; creator?: string }
interface RoleInfo { id: number; name: string; color: string | null; hoist: boolean; level: "admin" | "mod" | null; position: number; mentionable: boolean }
/** @everyone and @here as words of their own. */
const CROWD = /(^|[^\p{L}\p{N}_@])@(everyone|here)(?![\p{L}\p{N}_])/gu;
const ROLE_MENTION = /<@&(\d+)>/g;
const MAX_ROLES = 50;
const ROLE_COLOR = /^#[0-9a-f]{6}$/i;
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
  /** Sharing their screen with their voice channel. */
  sharing?: boolean;
  /** Muted or deafened by a moderator. */
  server_muted?: boolean;
  server_deafened?: boolean;
  /** Timed out until then (ms). */
  timed_out_until?: number;
  /** The server's own roles they have. */
  roles?: number[];
}
/** Who may do what: the owner names admins, admins name moderators. */
type Role = "owner" | "admin" | "mod";
const RANK: Record<string, number> = { owner: 3, admin: 2, mod: 1 };
const rank = (role: Role | null | undefined) => (role ? RANK[role] : 0);
interface Member { public_key: string; name: string; role: Role | null; joined_at: number; roles: number[]; nick?: string | null; account_name?: string }
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
  /** When it last wrote in each slowmode channel. */
  lastSent?: Record<number, number>;
  nonce?: string;
  key?: string;
  name?: string;
  invite?: string | null;
  create?: string | null;
  user?: User;
  tokens?: number;
  refilled?: number;
  /** Flood limits: what's left of each allowance, and when they were last topped up. */
  any?: number;
  act?: number;
  sig?: number;
  topped?: number;
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
/** A voice message: hopp-voice:<stored id> <length in ms>. */
const VOICE_TOKEN = /^hopp-voice:([0-9a-f]{32}) (\d{1,6})$/;
/** Anything kept in the server's store (a picture or a voice message): its id. */
function storedId(text: string): string | null {
  return (text.match(IMAGE_TOKEN) ?? text.match(VOICE_TOKEN))?.[1] ?? null;
}
const IMAGE_TYPES: Record<string, (b: Uint8Array) => boolean> = {
  "image/webp": (b) => b.length > 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP",
  "image/jpeg": (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  // Voice messages: Opus in WebM, as the app records them.
  "audio/webm": (b) => b.length > 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3,
};

/** What notifications and replies show for a message: a picture reads as "Image". */
function plainText(text: string): string {
  if (VOICE_TOKEN.test(text)) return "🎤 Voice message";
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
      CREATE TABLE IF NOT EXISTS timeouts (key TEXT PRIMARY KEY, until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS roles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, color TEXT, hoist INTEGER, level TEXT, position INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS member_roles (key TEXT NOT NULL, role INTEGER NOT NULL, PRIMARY KEY (key, role));
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT);
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, channel INTEGER NOT NULL, sender INTEGER NOT NULL,
        sender_name TEXT NOT NULL, author_key TEXT NOT NULL, text TEXT NOT NULL, sent_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_by_channel ON messages (channel, id);
      CREATE TABLE IF NOT EXISTS notified (key TEXT NOT NULL, channel INTEGER NOT NULL, PRIMARY KEY (key, channel));
      CREATE TABLE IF NOT EXISTS emojis (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, image TEXT NOT NULL, creator TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, payload TEXT NOT NULL);
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
    if (!channelColumns.has("user_limit")) this.sql.exec("ALTER TABLE channels ADD COLUMN user_limit INTEGER");
    if (!channelColumns.has("afk_after")) this.sql.exec("ALTER TABLE channels ADD COLUMN afk_after INTEGER");
    if (!channelColumns.has("slowmode")) this.sql.exec("ALTER TABLE channels ADD COLUMN slowmode INTEGER");
    if (!channelColumns.has("private_roles")) this.sql.exec("ALTER TABLE channels ADD COLUMN private_roles TEXT");
    // Threads: text channels started in another text channel, often from one of its messages.
    if (!channelColumns.has("parent")) this.sql.exec("ALTER TABLE channels ADD COLUMN parent INTEGER");
    if (!channelColumns.has("starter")) this.sql.exec("ALTER TABLE channels ADD COLUMN starter INTEGER");
    if (!channelColumns.has("creator")) this.sql.exec("ALTER TABLE channels ADD COLUMN creator TEXT");
    const roleColumns = new Set(this.sql.exec("PRAGMA table_info(roles)").toArray().map((c) => String(c.name)));
    if (!roleColumns.has("mentionable")) this.sql.exec("ALTER TABLE roles ADD COLUMN mentionable INTEGER");
    const accountColumns = new Set(this.sql.exec("PRAGMA table_info(accounts)").toArray().map((c) => String(c.name)));
    if (!accountColumns.has("role")) this.sql.exec("ALTER TABLE accounts ADD COLUMN role TEXT");
    if (!accountColumns.has("nick")) this.sql.exec("ALTER TABLE accounts ADD COLUMN nick TEXT");
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
    if (!IMAGE_TYPES[type]) return fail("Only WebP, JPEG and PNG pictures, and voice messages.");
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
    if (this.meta("pictures_off") === "1" && type.startsWith("image/")) return fail("Pictures are turned off in this server.", 403);
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
      const oldest = this.sql.exec("SELECT id, size FROM images WHERE id NOT IN (SELECT image FROM emojis) ORDER BY created_at LIMIT 1").toArray()[0];
      if (!oldest) break;
      this.sql.exec("DELETE FROM images WHERE id = ?", oldest.id);
      total -= Number(oldest.size);
    }
    return Response.json({ id });
  }

  /** A message being deleted: its picture goes too. */
  private dropPicture(messageId: number) {
    const text = this.sql.exec("SELECT text FROM messages WHERE id = ?", messageId).toArray()[0]?.text;
    const stored = typeof text === "string" ? storedId(text) : null;
    if (stored) this.sql.exec("DELETE FROM images WHERE id = ?", stored);
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
      .exec(
        `SELECT id, name, kind, topic, category, no_pictures, user_limit, afk_after, slowmode, private_roles, parent, starter, creator,
           CASE WHEN parent IS NULL THEN NULL ELSE (SELECT max(sent_at) FROM messages m WHERE m.channel = channels.id) END AS last_at
         FROM channels ORDER BY coalesce(position, id + 100000), id`,
      )
      .toArray()
      .map((r) => {
        const c: Channel = { id: Number(r.id), name: String(r.name), kind: r.kind as ChannelKind };
        if (r.topic) c.topic = String(r.topic);
        if (r.category) c.category = String(r.category);
        if (r.no_pictures) c.no_pictures = true;
        if (r.user_limit) c.user_limit = Number(r.user_limit);
        if (r.afk_after) c.afk_after = Number(r.afk_after);
        if (r.slowmode) c.slowmode = Number(r.slowmode);
        if (r.private_roles) c.private_roles = JSON.parse(String(r.private_roles));
        if (r.parent !== null && r.parent !== undefined) {
          c.parent = Number(r.parent);
          if (r.starter !== null && r.starter !== undefined) c.starter = Number(r.starter);
          if (r.last_at) c.last_at = Number(r.last_at);
          if (r.creator) c.creator = String(r.creator);
        }
        return c;
      })
      // A thread's people are its channel's: it takes the channel's privacy along.
      .map((c, _, all) => (c.parent === undefined ? c : { ...c, private_roles: all.find((p) => p.id === c.parent)?.private_roles })) as Channel[];
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
    // The server's own roles can carry moderator or admin rights too: the highest counts.
    const levels = this.sql.exec("SELECT r.level FROM roles r JOIN member_roles m ON m.role = r.id WHERE m.key = ? AND r.level IS NOT NULL", key).toArray().map((x) => String(x.level));
    if (r === "admin" || levels.includes("admin")) return "admin";
    if (r === "mod" || levels.includes("mod")) return "mod";
    return null;
  }

  private memberList(): Member[] {
    const owner = this.meta("owner");
    // Everyone's roles in one read, not one per member.
    const roles = new Map<string, number[]>();
    for (const r of this.sql.exec("SELECT key, role FROM member_roles")) {
      const list = roles.get(String(r.key)) ?? [];
      list.push(Number(r.role));
      roles.set(String(r.key), list);
    }
    return this.sql
      .exec("SELECT key, name, nick, role, created_at FROM accounts WHERE key NOT IN (SELECT key FROM bans) ORDER BY lower(coalesce(nick, name)) LIMIT 1000")
      .toArray()
      .map((r) => ({
        public_key: String(r.key),
        name: String(r.nick ?? r.name),
        nick: r.nick === null ? null : String(r.nick),
        account_name: String(r.name),
        role: r.key === owner ? "owner" : r.role === "admin" || r.role === "mod" ? (r.role as Role) : null,
        joined_at: Number(r.created_at),
        roles: roles.get(String(r.key)) ?? [],
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
    // A plain message (nobody pinged) only concerns people who haven't heard about this
    // channel yet: in a lively channel that's nobody, and nothing more is read.
    const pings = MENTION.test(m.text) || ROLE_MENTION.test(m.text) || CROWD.test(m.text) || !!m.reply;
    MENTION.lastIndex = ROLE_MENTION.lastIndex = CROWD.lastIndex = 0;
    const rows = pings
      ? this.sql.exec("SELECT key, name FROM accounts WHERE key NOT IN (SELECT key FROM bans) LIMIT 1000")
      : this.sql.exec("SELECT key, name FROM accounts WHERE key NOT IN (SELECT key FROM bans) AND key NOT IN (SELECT key FROM notified WHERE channel = ?) LIMIT 1000", m.channel);
    const ch = this.channels().find((c) => c.id === m.channel);
    const allowed = this.whoCanSee(ch);
    for (const row of rows) {
      const key = String(row.key);
      if (allowed && !allowed.has(key)) continue;
      keys.push(key);
      names.set(key, String(row.name));
    }
    const here = new Set(this.members().map(([, s]) => s.key));
    const mentioned = new Set([...m.text.matchAll(MENTION)].map((x) => x[1]));
    if (m.reply) mentioned.add(m.reply.author_key);
    const roleIds = new Set([...m.text.matchAll(ROLE_MENTION)].map((x) => Number(x[1])));
    if (roleIds.size) for (const r of this.sql.exec("SELECT key, role FROM member_roles").toArray()) if (roleIds.has(Number(r.role))) mentioned.add(String(r.key));
    // Many at once: everyone who can see it, or everyone who's here right now.
    const crowd = new Set<string>();
    for (const [, , word] of m.text.matchAll(CROWD)) for (const key of word === "everyone" ? keys : keys.filter((k) => here.has(k))) crowd.add(key);
    const roleNames = new Map(this.customRoles().map((r) => [r.id, r.name]));
    const preview = plainText(m.text)
      .replace(MENTION, (_, key) => `@${names.get(key) ?? "someone"}`)
      .replace(ROLE_MENTION, (_, id) => `@${roleNames.get(Number(id)) ?? "deleted-role"}`)
      .slice(0, 200);
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
    const told = pings ? new Set(this.sql.exec("SELECT key FROM notified WHERE channel = ?", m.channel).toArray().map((r) => String(r.key))) : new Set<string>();
    let sent = 0;
    let waiting = false;
    for (const key of keys) {
      if (key === m.author_key) continue;
      const mention = mentioned.has(key) || crowd.has(key);
      if (!mention && (here.has(key) || told.has(key))) continue;
      if (!here.has(key)) this.sql.exec("INSERT OR IGNORE INTO notified (key, channel) VALUES (?, ?)", key, m.channel);
      // "Only by @everyone/@here", so people who turned those off can skip them.
      const payload = { ...activity, mention, crowd: !mentioned.has(key) && crowd.has(key), preview };
      // Only so many calls fit in one go: the first ones leave now, the rest in turns right after.
      if (sent < TELL_AT_ONCE) {
        sent++;
        this.ctx.waitUntil(accountOf(this.env, key).channelActivity(payload).catch(() => {}));
      } else {
        this.sql.exec("INSERT INTO outbox (key, payload) VALUES (?, ?)", key, JSON.stringify(payload));
        waiting = true;
      }
    }
    if (waiting) this.ctx.waitUntil(this.wakeForOutbox());
  }

  /** Sees to it that the accounts still waiting to be told get their turn very soon. */
  private async wakeForOutbox() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 200);
  }

  /** The next accounts in line are told about their message; then the ones after, until none wait. */
  async alarm() {
    const rows = this.sql.exec("SELECT id, key, payload FROM outbox ORDER BY id LIMIT ?", TELL_AT_ONCE).toArray();
    if (!rows.length) return;
    this.sql.exec("DELETE FROM outbox WHERE id <= ?", Number(rows[rows.length - 1].id));
    await Promise.allSettled(
      rows.map((r) => {
        try {
          return accountOf(this.env, String(r.key)).channelActivity(JSON.parse(String(r.payload)));
        } catch (err) {
          return Promise.reject(err);
        }
      }),
    );
    if (this.sql.exec("SELECT 1 FROM outbox LIMIT 1").toArray().length) await this.ctx.storage.setAlarm(Date.now() + 200);
  }

  private members(): [WebSocket, Session][] {
    return this.ctx
      .getWebSockets()
      .map((ws) => [ws, this.session(ws)] as [WebSocket, Session])
      .filter(([, s]) => s.stage === "joined" && s.user);
  }

  /**
   * Puts someone in a voice channel (they joined, or a moderator moved them): their client
   * gets the channel's key and who to reach. A message instead when the channel is full.
   */
  private enterVoice(ws: WebSocket, s: Session, ch: { id: number; name: string }): string | null {
    const others = this.voiceMembers(ch.id).filter(([other]) => other !== ws);
    // Everyone sends to everyone directly, so a channel can only hold so many.
    if (others.length >= MAX_VOICE_PEERS) return `${ch.name} is full (${MAX_VOICE_PEERS} people).`;
    // A fresh key whenever a channel fills up again, so people who left can't listen in later.
    let key = this.meta(`voice_key:${ch.id}`);
    if (!key || others.length === 0) {
      key = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
      this.setMeta(`voice_key:${ch.id}`, key);
    }
    delete s.endpoint;
    this.updateUser(ws, s, (u) => {
      u.voice_channel = ch.id;
      u.sharing = false;
    });
    const peers = others.filter(([, o]) => o.endpoint).map(([, o]) => ({ session_id: o.user!.session_id, ...o.endpoint }));
    this.send(ws, { type: "voice_session", channel: ch.id, key, peers });
    return null;
  }

  /** Timed out right now? (An old timeout that ran out is cleared on the way.) */
  private timedOut(s: Session): boolean {
    const until = s.user?.timed_out_until ?? 0;
    if (until > Date.now()) return true;
    if (until) delete s.user!.timed_out_until;
    return false;
  }

  /** A line in the audit log; the newest 500 are kept. */
  private audit(actor: string, action: string, target: string | null, detail: string | null) {
    this.sql.exec("INSERT INTO audit (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)", Date.now(), actor, action, target, detail);
    this.sql.exec("DELETE FROM audit WHERE id <= (SELECT id FROM audit ORDER BY id DESC LIMIT 1 OFFSET 500)");
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
    const accountName = s.name!;
    const nick = this.sql.exec("SELECT nick FROM accounts WHERE key = ?", key).toArray()[0]?.nick;
    const name = nick == null ? accountName : String(nick);

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
      key, accountName, now,
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
    const custom = this.rolesOf(key);
    if (custom.length) user.roles = custom;
    const joined: Session = { stage: "joined", key, name, user, tokens: CHAT_BURST, refilled: now, joinedAt: now };
    this.broadcast({ type: "user_joined", user });
    ws.serializeAttachment(joined);
    const channels = this.channelsFor(key);
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
      features: ["search", "screen", "voice-chat", "voice-mod", "voice-settings", "mod-tools", "roles", "pings", "resync", "nicknames", "members", "emojis", "search-filters", "polls", "voice-messages", "threads"],
      roles: this.customRoles(),
      emojis: this.emojis(),
    });
    for (const ch of channels) {
      this.send(ws, { type: "chat_history", channel: ch.id, messages: this.history(ch.id) });
    }
  }

  // ---------- the server's own emojis ----------

  private emojis(): { id: number; name: string; image: string }[] {
    return this.sql.exec("SELECT id, name, image FROM emojis ORDER BY name").toArray().map((r) => ({ id: Number(r.id), name: String(r.name), image: String(r.image) }));
  }

  // ---------- roles and private channels ----------

  /** The server's own roles, highest first. */
  private customRoles(): RoleInfo[] {
    return this.sql.exec("SELECT id, name, color, hoist, level, position, mentionable FROM roles ORDER BY position DESC, id").toArray().map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      color: r.color === null ? null : String(r.color),
      hoist: !!r.hoist,
      level: r.level === "admin" || r.level === "mod" ? (r.level as "admin" | "mod") : null,
      position: Number(r.position),
      mentionable: !!r.mentionable,
    }));
  }

  /**
   * Who may ping many at once: moderators may use @everyone, @here and any role; others only
   * roles that allow it. Anything else stays in the text as plain words that ping nobody.
   */
  private allowPings(text: string, myRank: number): string {
    if (myRank >= RANK.mod) return text;
    const roles = new Map(this.customRoles().map((r) => [r.id, r]));
    return text
      .replace(CROWD, (_, before, word) => `${before}@\u200b${word}`)
      .replace(ROLE_MENTION, (all, id) => {
        const r = roles.get(Number(id));
        return r?.mentionable ? all : `@${r?.name ?? "deleted-role"}`;
      });
  }

  private rolesOf(key: string): number[] {
    return this.sql.exec("SELECT role FROM member_roles WHERE key = ?", key).toArray().map((r) => Number(r.role));
  }

  /** Whether someone may see a channel: everyone, unless it's private to some roles (admins always). */
  private canSee(key: string | undefined, ch: Channel | undefined): boolean {
    if (!ch?.private_roles?.length || !key) return true;
    if (rank(this.roleOf(key)) >= RANK.admin) return true;
    const mine = new Set(this.rolesOf(key));
    return ch.private_roles.some((r) => mine.has(r));
  }

  /**
   * Everyone who may see a channel, or `null` when that's everyone. Worked out for the
   * whole server at once, not person by person: a busy private channel stays cheap.
   */
  private whoCanSee(ch: Channel | undefined): Set<string> | null {
    if (!ch?.private_roles?.length) return null;
    const keys = new Set<string>();
    const owner = this.meta("owner");
    if (owner) keys.add(owner);
    for (const r of this.sql.exec("SELECT key FROM accounts WHERE role = 'admin'")) keys.add(String(r.key));
    const wanted = new Set(ch.private_roles);
    const adminRoles = new Set(this.customRoles().filter((r) => r.level === "admin").map((r) => r.id));
    for (const r of this.sql.exec("SELECT key, role FROM member_roles")) {
      if (wanted.has(Number(r.role)) || adminRoles.has(Number(r.role))) keys.add(String(r.key));
    }
    return keys;
  }

  private channelsFor(key: string | undefined): Channel[] {
    return this.channels().filter((c) => this.canSee(key, c));
  }

  /** Something about a channel's people changed: each person gets the channels they may see (and their history, if asked). */
  private channelsChanged(withHistory = false) {
    for (const [ws, s] of this.members()) {
      const mine = this.channelsFor(s.key);
      this.send(ws, { type: "channels_updated", channels: mine });
      if (withHistory) for (const ch of mine) this.send(ws, { type: "chat_history", channel: ch.id, messages: this.history(ch.id) });
    }
  }

  /** Sent only to the people who may see the channel. */
  private broadcastChannel(channel: number, msg: object, except?: WebSocket) {
    const ch = this.channels().find((c) => c.id === channel);
    const allowed = this.whoCanSee(ch);
    const text = JSON.stringify(msg);
    for (const [ws, s] of this.members()) {
      if (ws === except || (allowed && !(s.key && allowed.has(s.key)))) continue;
      try {
        ws.send(text);
      } catch {
        // Closing; ignore.
      }
    }
  }

  /** Someone's roles changed: their name card follows, everywhere. */
  private memberRolesChanged(key: string) {
    const roles = this.rolesOf(key);
    const role = this.roleOf(key);
    for (const [ws, s] of this.members().filter(([, m]) => m.key === key)) {
      // The roles and what they allow, in one update.
      this.updateUser(ws, s, (u) => {
        if (roles.length) u.roles = roles;
        else delete u.roles;
        u.owner = role === "owner";
        if (role) u.role = role;
        else delete u.role;
      });
    }
    this.rolesChanged();
  }

  /** Role handling: create, change, delete, order, give. Admins only; admin-level roles are the owner's. */
  private onRoles(ws: WebSocket, s: Session, msg: ClientMsg, owner: boolean, myRank: number): boolean {
    const user = s.user!;
    const fail = (text: string) => (this.error(ws, text), true);
    const level = (v: unknown) => (v === "admin" || v === "mod" ? v : null);
    const color = (v: unknown) => (typeof v === "string" && ROLE_COLOR.test(v) ? v.toLowerCase() : null);
    const name = (v: unknown) => String(v ?? "").trim().slice(0, 32);
    const changed = () => this.broadcast({ type: "roles_updated", roles: this.customRoles() });
    switch (msg.type) {
      case "create_role": {
        if (myRank < RANK.admin) return fail("Only admins and the owner can manage roles.");
        if (this.customRoles().length >= MAX_ROLES) return fail(`A server has at most ${MAX_ROLES} roles.`);
        const lv = level(msg.level);
        if (lv === "admin" && !owner) return fail("Only the owner can make admin roles.");
        const n = name(msg.name) || "new role";
        const top = Number(this.sql.exec("SELECT max(position) AS p FROM roles").toArray()[0]?.p ?? 0);
        this.sql.exec("INSERT INTO roles (name, color, hoist, level, position, mentionable) VALUES (?, ?, ?, ?, ?, ?)", n, color(msg.color), msg.hoist ? 1 : null, lv, top + 1, msg.mentionable ? 1 : null);
        this.audit(user.name, "create_role", n, null);
        changed();
        return true;
      }
      case "update_role": {
        if (myRank < RANK.admin) return fail("Only admins and the owner can manage roles.");
        const role = this.customRoles().find((r) => r.id === Number(msg.id));
        if (!role) return fail("That role doesn't exist anymore.");
        const lv = level(msg.level);
        if ((lv === "admin" || role.level === "admin") && !owner) return fail("Only the owner can change admin roles.");
        const n = name(msg.name) || role.name;
        this.sql.exec("UPDATE roles SET name = ?, color = ?, hoist = ?, level = ?, mentionable = ? WHERE id = ?", n, color(msg.color), msg.hoist ? 1 : null, lv, msg.mentionable ? 1 : null, role.id);
        this.audit(user.name, "update_role", n, null);
        changed();
        // Its level decides what its people may do.
        this.rolesChanged();
        return true;
      }
      case "create_emoji": {
        if (myRank < RANK.admin) return fail("Only admins and the owner can add emojis.");
        const name = String(msg.name ?? "").trim().toLowerCase();
        const image = String(msg.image ?? "");
        if (!EMOJI_NAME.test(name)) return fail("Emoji names are 2–32 characters: lowercase letters, numbers and _.");
        if (this.sql.exec("SELECT 1 FROM emojis WHERE name = ?", name).toArray().length) return fail(`There's already an emoji called :${name}:.`);
        if (Number(this.sql.exec("SELECT count(*) AS n FROM emojis").one().n) >= MAX_EMOJIS) return fail(`A server can have up to ${MAX_EMOJIS} emojis.`);
        const owned = this.sql.exec("SELECT 1 FROM images WHERE id = ? AND uploader = ?", image, s.key!).toArray().length > 0;
        if (!owned) return fail("That picture didn't upload. Try again.");
        this.sql.exec("UPDATE images SET used = 1 WHERE id = ?", image);
        this.sql.exec("INSERT INTO emojis (name, image, creator, created_at) VALUES (?, ?, ?, ?)", name, image, s.key!, Date.now());
        this.audit(user.name, "create_emoji", ":" + name + ":", null);
        this.broadcast({ type: "emojis_updated", emojis: this.emojis() });
        return true;
      }
      case "delete_emoji": {
        if (myRank < RANK.admin) return fail("Only admins and the owner can remove emojis.");
        const row = this.sql.exec("SELECT name, image FROM emojis WHERE id = ?", Number(msg.id)).toArray()[0];
        if (!row) return true;
        this.sql.exec("DELETE FROM emojis WHERE id = ?", Number(msg.id));
        this.sql.exec("DELETE FROM images WHERE id = ?", String(row.image));
        this.audit(user.name, "delete_emoji", ":" + String(row.name) + ":", null);
        this.broadcast({ type: "emojis_updated", emojis: this.emojis() });
        return true;
      }
      case "delete_role": {
        if (myRank < RANK.admin) return fail("Only admins and the owner can manage roles.");
        const role = this.customRoles().find((r) => r.id === Number(msg.id));
        if (!role) return true;
        if (role.level === "admin" && !owner) return fail("Only the owner can delete admin roles.");
        const holders = this.sql.exec("SELECT key FROM member_roles WHERE role = ?", role.id).toArray().map((r) => String(r.key));
        this.sql.exec("DELETE FROM roles WHERE id = ?", role.id);
        this.sql.exec("DELETE FROM member_roles WHERE role = ?", role.id);
        this.audit(user.name, "delete_role", role.name, null);
        changed();
        for (const k of holders) this.memberRolesChanged(k);
        this.channelsChanged();
        return true;
      }
      case "reorder_roles": {
        if (myRank < RANK.admin) return fail("Only admins and the owner can manage roles.");
        const order = Array.isArray(msg.order) ? msg.order.map(Number) : [];
        const ids = this.customRoles().map((r) => r.id);
        if (order.length !== ids.length || [...order].sort((a, b) => a - b).join() !== [...ids].sort((a, b) => a - b).join()) return fail("The roles changed meanwhile. Try again.");
        order.forEach((id: number, i: number) => this.sql.exec("UPDATE roles SET position = ? WHERE id = ?", order.length - i, id));
        changed();
        return true;
      }
      case "assign_role": {
        if (myRank < RANK.admin) return fail("Only admins and the owner can give roles.");
        const key = String(msg.public_key ?? "");
        const role = this.customRoles().find((r) => r.id === Number(msg.role));
        if (!role) return fail("That role doesn't exist anymore.");
        if (role.level === "admin" && !owner) return fail("Only the owner can give admin roles.");
        const target = this.memberList().find((m) => m.public_key === key);
        if (!target) return fail("They're not a member of this server anymore.");
        if (key !== s.key && rank(target.role) >= myRank && !owner) return fail("You can't change the roles of someone at your level or above.");
        if (msg.on) this.sql.exec("INSERT INTO member_roles (key, role) VALUES (?, ?) ON CONFLICT DO NOTHING", key, role.id);
        else this.sql.exec("DELETE FROM member_roles WHERE key = ? AND role = ?", key, role.id);
        this.audit(user.name, msg.on ? "give_role" : "take_role", target.name, role.name);
        this.memberRolesChanged(key);
        // A role can open private channels: those people get them (with their history).
        this.channelsChanged(true);
        return true;
      }
    }
    return false;
  }

  /** Takes one from an allowance that fills up again over time. False when it's used up. */
  private spend(ws: WebSocket, s: Session, which: "any" | "act" | "sig"): boolean {
    const now = Date.now();
    const gone = (now - (s.topped ?? now)) / 1000;
    s.topped = now;
    s.any = Math.min(ANY_BURST, (s.any ?? ANY_BURST) + gone * ANY_PER_SECOND);
    s.act = Math.min(ACT_BURST, (s.act ?? ACT_BURST) + gone * ACT_PER_SECOND);
    s.sig = Math.min(SIGNAL_BURST, (s.sig ?? SIGNAL_BURST) + gone * SIGNAL_PER_SECOND);
    const ok = s[which]! >= 1;
    if (ok) s[which]! -= 1;
    ws.serializeAttachment(s);
    return ok;
  }

  private async onMember(ws: WebSocket, s: Session, msg: ClientMsg) {
    // Nobody gets to flood the server (or everyone in it) with anything.
    if (msg.type === "screen_signal") {
      if (!this.spend(ws, s, "sig")) return;
    } else if (!this.spend(ws, s, "any")) {
      return;
    } else if ((msg.type === "react" || msg.type === "edit_message" || msg.type === "typing") && !this.spend(ws, s, "act")) {
      if (msg.type === "typing") return;
      return this.error(ws, "You're doing that too fast. Slow down a little.");
    }
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

    // A private channel someone may not see doesn't exist for them.
    if (msg.channel !== undefined && msg.type !== "update_channel" && msg.type !== "delete_channel") {
      const ch = this.channels().find((c) => c.id === Number(msg.channel));
      if (ch && !this.canSee(s.key, ch)) return this.error(ws, "That channel doesn't exist.");
    }
    if (this.onRoles(ws, s, msg, owner, myRank)) return;
    switch (msg.type) {
      case "join_voice": {
        const ch = this.channel(Number(msg.channel));
        if (ch?.kind !== "voice") return this.error(ws, "That voice channel doesn't exist.");
        if (this.timedOut(s)) return this.error(ws, "You're timed out, so you can't join voice right now.");
        // The channel's own limit (moderators moving someone in aren't held to it).
        const limit = Number(this.channels().find((c) => c.id === ch.id)?.user_limit ?? 0);
        if (limit && this.voiceMembers(ch.id).filter(([o]) => o !== ws).length >= limit) return this.error(ws, `${ch.name} is full (${limit} people).`);
        const full = this.enterVoice(ws, s, ch);
        if (full) return this.error(ws, full + " Try another voice channel.");
        return;
      }
      case "disconnect_voice":
      case "move_voice":
      case "server_mute": {
        if (!allowed("mod")) return;
        const target = Number(msg.session_id);
        const found = this.members().find(([, m]) => m.user!.session_id === target);
        if (!found) return this.error(ws, "That person isn't connected anymore.");
        const [tws, ts] = found;
        if (target !== user.session_id && rank(this.roleOf(ts.key!)) >= myRank) return this.error(ws, "You can't do that to someone with the same role as you or higher.");
        if (msg.type === "server_mute") {
          if (!!msg.muted !== !!ts.user!.server_muted) this.audit(user.name, msg.muted ? "server_mute" : "server_unmute", ts.user!.name, null);
          if (!!msg.deafened !== !!ts.user!.server_deafened) this.audit(user.name, msg.deafened ? "server_deafen" : "server_undeafen", ts.user!.name, null);
          return this.updateUser(tws, ts, (u) => {
            u.server_muted = !!msg.muted;
            u.server_deafened = !!msg.deafened;
          });
        }
        if (ts.user!.voice_channel === null) return this.error(ws, `${ts.user!.name} isn't in a voice channel.`);
        if (msg.type === "disconnect_voice") {
          this.audit(user.name, "voice_disconnect", ts.user!.name, null);
          delete ts.endpoint;
          return this.updateUser(tws, ts, (u) => {
            u.voice_channel = null;
            u.sharing = false;
          });
        }
        const ch = this.channel(Number(msg.channel));
        if (ch?.kind !== "voice") return this.error(ws, "That voice channel doesn't exist.");
        if (ch.id === ts.user!.voice_channel) return;
        const full = this.enterVoice(tws, ts, ch);
        if (full) return this.error(ws, full);
        this.audit(user.name, "voice_move", ts.user!.name, "to " + ch.name);
        return;
      }
      case "leave_voice":
        delete s.endpoint;
        return this.updateUser(ws, s, (u) => {
          u.voice_channel = null;
          u.sharing = false;
        });
      case "set_sharing":
        if (msg.on && user.voice_channel === null) return this.error(ws, "Join a voice channel to share your screen.");
        return this.updateUser(ws, s, (u) => (u.sharing = !!msg.on));
      case "screen_signal": {
        // Passed on between people in the same voice channel; the video itself goes between them.
        const data = String(msg.data ?? "");
        const to = Number(msg.to);
        if (user.voice_channel === null || data.length > MAX_SCREEN_SIGNAL || to === user.session_id) return;
        const target = this.members().find(([, m]) => m.user!.session_id === to && m.user!.voice_channel === user.voice_channel);
        if (target) this.send(target[0], { type: "screen_signal", from: user.session_id, data });
        return;
      }
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
        const text = this.allowPings(String(msg.text ?? "").trim(), myRank);
        // Voice channels have a chat too, for the people in them.
        if (ch?.kind !== "text" && ch?.kind !== "voice") return this.error(ws, "That channel doesn't exist.");
        if (!text || [...text].length > MAX_CHAT_LEN) return this.error(ws, `Messages must be 1–${MAX_CHAT_LEN} characters.`);
        const now = Date.now();
        if (this.timedOut(s)) return this.error(ws, "You're timed out, so you can't write right now.");
        // Slowmode: a pause between each person's messages here (moderators are free).
        const slow = Number(this.channels().find((c) => c.id === ch.id)?.slowmode ?? 0);
        if (slow && myRank < RANK.mod) {
          const last = s.lastSent?.[ch.id] ?? 0;
          const wait = Math.ceil((last + slow * 1000 - now) / 1000);
          if (wait > 0) return this.error(ws, `Slowmode is on here. Wait ${wait} s.`);
          s.lastSent = { ...(s.lastSent ?? {}), [ch.id]: now };
        }
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
        const stored = storedId(text);
        if (stored) {
          const owned = this.sql.exec("SELECT 1 FROM images WHERE id = ? AND uploader = ?", stored, s.key!).toArray().length > 0;
          if (!owned) return this.error(ws, picture ? "That picture didn't upload. Try again." : "That voice message didn't upload. Try again.");
          this.sql.exec("UPDATE images SET used = 1 WHERE id = ?", stored);
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
        // The oldest make room; a picture among them goes too.
        const trimmed = this.sql.exec(
          "DELETE FROM messages WHERE channel = ? AND id <= (SELECT id FROM messages WHERE channel = ? ORDER BY id DESC LIMIT 1 OFFSET ?) RETURNING text",
          ch.id, ch.id, CHAT_KEEP,
        );
        for (const old of trimmed) {
          const gone = storedId(String(old.text));
          if (gone) this.sql.exec("DELETE FROM images WHERE id = ?", gone);
        }
        const message: ChatMessage = {
          id: Number(row.id), channel: ch.id, sender: user.session_id, sender_name: user.name,
          author_key: s.key!, text, sent_at: now,
        };
        if (reply) message.reply = reply;
        this.broadcastChannel(ch.id, { type: "chat", message });
        // Voice chat is for the people in the channel: no unread marks for everyone else.
        if (ch.kind === "voice") return;
        return this.tellAccounts(message, ch.name);
      }
      case "edit_message": {
        const channel = Number(msg.channel);
        const id = Number(msg.id);
        const text = this.allowPings(String(msg.text ?? "").trim(), myRank);
        if (!text || [...text].length > MAX_CHAT_LEN) return this.error(ws, `Messages must be 1–${MAX_CHAT_LEN} characters.`);
        const m = this.message(channel, id);
        if (!m) return this.error(ws, "That message no longer exists.");
        if (m.author_key !== s.key) return this.error(ws, "You can only edit your own messages.");
        const at = Date.now();
        this.sql.exec("UPDATE messages SET text = ?, edited_at = ? WHERE id = ?", text, at, id);
        return this.broadcastChannel(channel, { type: "message_edited", channel, id, text, edited_at: at });
      }
      case "react": {
        if (this.timedOut(s)) return this.error(ws, "You're timed out, so you can't react right now.");
        const channel = Number(msg.channel);
        const id = Number(msg.id);
        const emoji = String(msg.emoji ?? "");
        const vote = emoji.match(/^poll:(\d)$/);
        if (!vote && !validEmoji(emoji)) return this.error(ws, "That isn't an emoji.");
        const m = this.message(channel, id);
        if (!m) return this.error(ws, "That message no longer exists.");
        let reactions = m.reactions ?? [];
        const on = !!msg.on;
        if (vote) {
          // A vote in a poll: an answer it has, while it's open; one answer unless it allows more.
          const poll = parsePoll(m.text);
          if (!poll || Number(vote[1]) >= poll.answers) return this.error(ws, "That isn't an answer in this poll.");
          if (Date.now() > poll.end) return this.error(ws, "This poll has closed.");
          if (on && !poll.multi) {
            for (const r of reactions) if (r.emoji.startsWith("poll:") && r.emoji !== emoji) r.keys = r.keys.filter((k) => k !== s.key);
            reactions = reactions.filter((r) => r.keys.length || r.emoji === emoji);
          }
        }
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
        return this.broadcastChannel(channel, { type: "reactions", channel, id, reactions });
      }
      case "pin": {
        if (!allowed("mod")) return;
        const channel = Number(msg.channel);
        const id = Number(msg.id);
        if (!this.message(channel, id)) return this.error(ws, "That message no longer exists.");
        this.sql.exec("UPDATE messages SET pinned = ? WHERE id = ?", msg.on ? 1 : null, id);
        return this.broadcastChannel(channel, { type: "pinned", channel, id, on: !!msg.on });
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
        const none = () => this.send(ws, { type: "search_results", query, messages: [] });
        if (needle.length > 200) return none();
        const f = parseSearch(needle);
        const filtered = f.from.length || f.in.length || f.has.length;
        if ((!filtered && f.words.length < 2) || f.words.length > 100) return none();
        // Only in channels you can see, so hidden ones never use up the results.
        let mine = this.channelsFor(s.key);
        if (f.in.length) mine = mine.filter((c) => f.in.includes(c.name.toLowerCase()));
        if (!mine.length) return none();
        const where = [`channel IN (${mine.map(() => "?").join(",")})`];
        const args: (string | number)[] = mine.map((c) => c.id);
        if (f.words) {
          where.push("text LIKE ? ESCAPE '\\'");
          args.push("%" + f.words.replace(/[\\%_]/g, (c) => "\\" + c) + "%");
        }
        if (f.from.length) {
          // By name, nickname, or the name they had when they wrote it.
          const marks = f.from.map(() => "?").join(",");
          where.push(`(author_key IN (SELECT key FROM accounts WHERE lower(name) IN (${marks}) OR lower(coalesce(nick, '')) IN (${marks})) OR lower(sender_name) IN (${marks}))`);
          args.push(...f.from, ...f.from, ...f.from);
        }
        for (const has of f.has) {
          if (/^links?$/.test(has)) where.push("(text LIKE '%http://%' OR text LIKE '%https://%')");
          else if (/^(images?|pictures?)$/.test(has)) where.push("text LIKE 'hopp-image:%'");
          else return none();
        }
        const messages = this.sql
          .exec(`SELECT * FROM messages WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`, ...args, SEARCH_RESULTS)
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
        if (row.author_key !== s.key) {
          const author = this.sql.exec("SELECT name FROM accounts WHERE key = ?", String(row.author_key)).toArray()[0];
          this.audit(user.name, "delete_message", author ? String(author.name) : "someone", null);
        }
        this.dropPicture(id);
        this.sql.exec("DELETE FROM messages WHERE id = ?", id);
        return this.broadcastChannel(channel, { type: "message_deleted", channel, id });
      }
      case "typing": {
        const now = Date.now();
        if (now - (s.lastTyping ?? 0) < TYPING_INTERVAL_MS) return;
        s.lastTyping = now;
        ws.serializeAttachment(s);
        return this.broadcastChannel(Number(msg.channel), { type: "typing", channel: Number(msg.channel), session_id: user.session_id }, ws);
      }
      case "create_channel": {
        if (!allowed("admin")) return;
        const kind: ChannelKind = msg.kind === "voice" ? "voice" : "text";
        const name = normalizeChannelName(msg.name, kind);
        if (!name || [...name].length > MAX_NAME_LEN) return this.error(ws, `Channel names must be 1–${MAX_NAME_LEN} characters.`);
        if (this.channels().filter((c) => c.parent === undefined).length >= MAX_CHANNELS) return this.error(ws, `A server can have at most ${MAX_CHANNELS} channels.`);
        this.sql.exec("INSERT INTO channels (name, kind) VALUES (?, ?)", name, kind);
        this.audit(user.name, "create_channel", name, null);
        return this.channelsChanged();
      }
      case "create_thread": {
        if (this.timedOut(s)) return this.error(ws, "You're timed out, so you can't start a thread right now.");
        const parent = this.channel(Number(msg.channel));
        if (!parent || parent.kind !== "text" || parent.parent !== undefined || !this.canSee(s.key, parent)) return this.error(ws, "Threads start in a text channel.");
        const fromId = msg.message === null || msg.message === undefined ? null : Number(msg.message);
        const from = fromId === null ? null : this.message(parent.id, fromId);
        if (fromId !== null && !from) return this.error(ws, "That message no longer exists.");
        // One thread per message: asking again just leads to it.
        if (from && this.channels().some((c) => c.parent === parent.id && c.starter === from.id)) return this.channelsChanged();
        const name = String(msg.name ?? "").replace(/\s+/g, " ").trim().slice(0, 100) || (from ? plainText(from.text).replace(/\s+/g, " ").trim().slice(0, 40) : "");
        if (!name) return this.error(ws, "Give the thread a name.");
        const threads = this.channels().filter((c) => c.parent !== undefined);
        if (threads.length >= MAX_THREADS) {
          const quietest = threads.sort((a, b) => (a.last_at ?? 0) - (b.last_at ?? 0))[0];
          this.sql.exec("DELETE FROM channels WHERE id = ?", quietest.id);
          this.sql.exec("DELETE FROM messages WHERE channel = ?", quietest.id);
        }
        this.sql.exec("INSERT INTO channels (name, kind, parent, starter, creator) VALUES (?, 'text', ?, ?, ?)", name, parent.id, from?.id ?? null, s.key!);
        return this.channelsChanged();
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
        this.audit(user.name, "update_channel", name, null);
        if (msg.no_pictures != null) this.sql.exec("UPDATE channels SET no_pictures = ? WHERE id = ?", msg.no_pictures ? 1 : null, ch.id);
        if (ch.kind === "voice" && msg.user_limit != null) {
          const limit = Math.max(0, Math.min(MAX_VOICE_PEERS, Math.floor(Number(msg.user_limit)) || 0));
          this.sql.exec("UPDATE channels SET user_limit = ? WHERE id = ?", limit || null, ch.id);
        }
        if (msg.private_roles != null) {
          const known = new Set(this.customRoles().map((r) => r.id));
          const roles = (Array.isArray(msg.private_roles) ? msg.private_roles : []).map(Number).filter((r: number) => known.has(r));
          this.sql.exec("UPDATE channels SET private_roles = ? WHERE id = ?", roles.length ? JSON.stringify(roles) : null, ch.id);
          // Who sees it changed: everyone gets their list, and newcomers its history.
          this.audit(user.name, "update_channel", name, roles.length ? "private" : "public");
          this.channelsChanged(true);
          return;
        }
        if (msg.slowmode != null) {
          const allowedSteps = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600];
          const seconds = allowedSteps.reduce((best, x) => (Math.abs(x - Number(msg.slowmode)) < Math.abs(best - Number(msg.slowmode)) ? x : best), 0);
          this.sql.exec("UPDATE channels SET slowmode = ? WHERE id = ?", seconds || null, ch.id);
        }
        if (ch.kind === "voice" && msg.afk_after != null) {
          // One AFK channel at most.
          const minutes = Math.max(0, Math.min(240, Math.floor(Number(msg.afk_after)) || 0));
          if (minutes) this.sql.exec("UPDATE channels SET afk_after = NULL");
          this.sql.exec("UPDATE channels SET afk_after = ? WHERE id = ?", minutes || null, ch.id);
        }
        return this.channelsChanged();
      }
      case "reorder_channels": {
        if (!allowed("admin")) return;
        const order = Array.isArray(msg.order) ? msg.order.map(Number) : [];
        const ids = this.channels().map((c) => c.id);
        if (order.length !== ids.length || [...order].sort((a, b) => a - b).join() !== [...ids].sort((a, b) => a - b).join()) {
          return this.error(ws, "The channels changed meanwhile. Try again.");
        }
        order.forEach((id: number, i: number) => this.sql.exec("UPDATE channels SET position = ? WHERE id = ?", i, id));
        return this.channelsChanged();
      }
      case "delete_channel": {
        const id = Number(msg.channel);
        const target = this.channel(id);
        // A thread: moderators, or whoever started it; a channel: admins.
        if (!(target?.parent !== undefined && (myRank >= RANK.mod || target.creator === s.key)) && !allowed("admin")) return;
        if (!target) return this.error(ws, "That channel doesn't exist.");
        // Its threads go with it.
        for (const t of this.channels().filter((c) => c.parent === id)) {
          this.sql.exec("DELETE FROM channels WHERE id = ?", t.id);
          this.sql.exec("DELETE FROM messages WHERE channel = ?", t.id);
        }
        this.audit(user.name, "delete_channel", this.channel(id)!.name, null);
        this.sql.exec("DELETE FROM channels WHERE id = ?", id);
        this.sql.exec("DELETE FROM images WHERE id IN (SELECT substr(text, 12, 32) FROM messages WHERE channel = ? AND text LIKE 'hopp-image:%')", id);
        this.sql.exec("DELETE FROM messages WHERE channel = ?", id);
        for (const [mws, m] of this.members()) {
          if (m.user!.voice_channel === id) this.updateUser(mws, m, (u) => (u.voice_channel = null));
        }
        return this.channelsChanged();
      }
      case "kick":
      case "ban": {
        const banned = msg.type === "ban";
        if (!allowed(banned ? "admin" : "mod")) return;
        // Someone who's here (by their session), or a member who isn't right now (by Hopp ID).
        const byKey = typeof msg.public_key === "string" && /^[0-9a-f]{64}$/.test(msg.public_key) ? msg.public_key : null;
        const here = byKey ? this.members().find(([, m]) => m.key === byKey) : this.members().find(([, m]) => m.user!.session_id === Number(msg.session_id));
        const key = here ? here[1].key! : byKey;
        const row = key ? this.sql.exec("SELECT name, nick FROM accounts WHERE key = ?", key).toArray()[0] : undefined;
        if (!key || (!here && !row)) return this.error(ws, byKey ? "That person isn't a member anymore." : "That person isn't connected anymore.");
        if (key === s.key) return this.error(ws, "You can't remove yourself.");
        if (rank(this.roleOf(key)) >= myRank) return this.error(ws, `You can't ${banned ? "ban" : "kick"} someone with the same role as you or higher.`);
        const name = here ? here[1].user!.name : String(row!.nick ?? row!.name);
        let removed = 0;
        if (banned) {
          this.sql.exec("INSERT INTO bans (key, name, banned_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING", key, name, Date.now());
          this.send(ws, { type: "bans", bans: this.bans() });
          // Their messages from the last hours go too, if asked.
          const hours = [1, 24, 168].includes(Number(msg.delete_hours)) ? Number(msg.delete_hours) : 0;
          if (hours) {
            const rows = this.sql.exec("SELECT id, channel FROM messages WHERE author_key = ? AND sent_at > ? LIMIT 1000", key, Date.now() - hours * 3_600_000).toArray();
            for (const r of rows) {
              this.dropPicture(Number(r.id));
              this.sql.exec("DELETE FROM messages WHERE id = ?", Number(r.id));
              this.broadcastChannel(Number(r.channel), { type: "message_deleted", channel: Number(r.channel), id: Number(r.id) });
            }
            removed = rows.length;
          }
        }
        // Out of the server for real: they're no longer a member, so coming back takes a new invite.
        this.sql.exec("DELETE FROM accounts WHERE key = ?", key);
        this.sql.exec("DELETE FROM member_roles WHERE key = ?", key);
        this.sql.exec("DELETE FROM notified WHERE key = ?", key);
        this.sql.exec("DELETE FROM timeouts WHERE key = ?", key);
        this.audit(user.name, banned ? "ban" : "kick", name, removed ? `deleted ${removed} messages` : null);
        // Every device of theirs goes.
        for (const [ows, os] of this.members().filter(([, m]) => m.key === key)) {
          this.send(ows, { type: "kicked", banned });
          ows.serializeAttachment({ stage: "removed" } satisfies Session);
          ows.close(4001, banned ? "banned" : "kicked");
          this.broadcast({ type: "user_left", session_id: os.user!.session_id });
        }
        // Everyone's list of members follows.
        const list = this.memberList();
        for (const [mws] of this.members()) this.send(mws, { type: "members", members: list });
        return;
      }
      case "set_nickname": {
        // Your own: anyone. Someone else's: moderators, for people below them.
        const key = String(msg.public_key ?? "");
        const nick = msg.nick == null ? "" : String(msg.nick).trim();
        if ([...nick].length > 32) return this.error(ws, "Nicknames are up to 32 characters.");
        const row = this.sql.exec("SELECT name, nick FROM accounts WHERE key = ?", key).toArray()[0];
        if (!row) return this.error(ws, "They're not a member of this server anymore.");
        const self = key === s.key;
        if (!self) {
          if (!allowed("mod")) return;
          if (rank(this.roleOf(key)) >= myRank) return this.error(ws, "You can't change the nickname of someone with the same role as you or higher.");
        }
        this.sql.exec("UPDATE accounts SET nick = ? WHERE key = ?", nick || null, key);
        const shown = nick || String(row.name);
        if (!self) this.audit(user.name, "nickname", String(row.nick ?? row.name), nick ? "to " + nick : "reset");
        for (const [tws, ts] of this.members().filter(([, m]) => m.key === key)) {
          ts.name = shown;
          this.updateUser(tws, ts, (u) => (u.name = shown));
        }
        return;
      }
      case "timeout": {
        if (!allowed("mod")) return;
        const target = Number(msg.session_id);
        const found = this.members().find(([, m]) => m.user!.session_id === target);
        if (!found) return this.error(ws, "That person isn't connected anymore.");
        const [, ts] = found;
        if (target === user.session_id) return this.error(ws, "You can't time yourself out.");
        if (rank(this.roleOf(ts.key!)) >= myRank) return this.error(ws, "You can't time out someone with the same role as you or higher.");
        const minutes = Math.max(0, Math.min(10080, Math.floor(Number(msg.minutes)) || 0));
        const until = minutes ? Date.now() + minutes * 60_000 : 0;
        if (until) this.sql.exec("INSERT INTO timeouts (key, until) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET until = excluded.until", ts.key!, until);
        else this.sql.exec("DELETE FROM timeouts WHERE key = ?", ts.key!);
        // Every device of theirs: marked, and out of voice.
        for (const [ows, os] of this.members().filter(([, m]) => m.key === ts.key)) {
          if (until) delete os.endpoint;
          this.updateUser(ows, os, (u) => {
            if (until) {
              u.timed_out_until = until;
              u.voice_channel = null;
              u.sharing = false;
            } else delete u.timed_out_until;
          });
        }
        this.audit(user.name, until ? "timeout" : "untimeout", ts.user!.name, until ? durationText(minutes) : null);
        return;
      }
      case "resync": {
        // A connection kept open in the background comes back into view: its channels' news.
        for (const ch of this.channelsFor(s.key)) this.send(ws, { type: "chat_history", channel: ch.id, messages: this.history(ch.id) });
        return;
      }
      case "get_audit_log": {
        if (!allowed("admin")) return;
        const entries = this.sql.exec("SELECT at, actor, action, target, detail FROM audit ORDER BY id DESC LIMIT 200").toArray()
          .map((r) => ({ at: Number(r.at), actor: String(r.actor), action: String(r.action), target: r.target === null ? null : String(r.target), detail: r.detail === null ? null : String(r.detail) }));
        return this.send(ws, { type: "audit_log", entries });
      }
      case "unban":
        if (!allowed("admin")) return;
        this.audit(user.name, "unban", String(this.sql.exec("SELECT name FROM bans WHERE key = ?", String(msg.public_key ?? "")).toArray()[0]?.name ?? "someone"), null);
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
        // Who's a member is no secret among members: it's how people who are offline show in the list.
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
        this.audit(user.name, "role", target.name, role ?? "member");
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
        this.audit(user.name, "transfer", target.name, null);
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
