// One Hopp server: accounts, invites, bans, channels and chat in this
// Durable Object's SQLite database, with members connected over hibernatable
// WebSockets. Speaks the same JSON messages as the self-hosted Rust server.

import { DurableObject } from "cloudflare:workers";
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
/** Messages per channel replayed at login, and kept in storage. */
const CHAT_HISTORY = 100;
const CHAT_KEEP = 1000;
/** Chat flood protection: a burst of this many, then one per second. */
const CHAT_BURST = 5;
const CHAT_PER_SECOND = 1;
const TYPING_INTERVAL_MS = 2000;
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** Voice endpoints: "a.b.c.d:port", a few local addresses at most. */
const ENDPOINT = /^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/;
const MAX_LOCAL_ENDPOINTS = 4;
const MAX_REACTIONS = 20;
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
  return m;
}
/** A mention in message text: <@hex key of their Hopp ID>. */
const MENTION = /<@([0-9a-f]{64})>/g;

type ChannelKind = "text" | "voice";
interface Channel { id: number; name: string; kind: ChannelKind }
interface User {
  session_id: number;
  name: string;
  voice_channel: number | null;
  muted: boolean;
  deafened: boolean;
  owner: boolean;
  public_key: string;
}
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
}
interface Invite { code: string; created_at: number; expires_at: number | null; max_uses: number | null; uses: number }
interface Ban { public_key: string; name: string; banned_at: number }
/** Where someone in a voice channel can be reached directly; voice on cloud servers is peer to peer. */
interface Endpoint { public: string | null; local: string[] }

/** What we remember about each socket; survives hibernation (max 2 KB). */
interface Session {
  stage: "hello" | "auth" | "joined" | "removed";
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
    `);
    // Replies, edits and reactions came later: add their columns to older servers.
    const columns = new Set(this.sql.exec("PRAGMA table_info(messages)").toArray().map((c) => String(c.name)));
    for (const [name, type] of [["reply_id", "INTEGER"], ["reply_name", "TEXT"], ["reply_key", "TEXT"], ["reply_text", "TEXT"], ["edited_at", "INTEGER"], ["reactions", "TEXT"]]) {
      if (!columns.has(name)) this.sql.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
    }
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  async fetch(request: Request): Promise<Response> {
    const serverId = request.headers.get("X-Strom-Server");
    if (serverId && this.meta("server_id") === null) this.setMeta("server_id", serverId);
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
    return { name, icon: this.meta("icon"), members, online: this.members().length };
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
    return this.sql.exec("SELECT id, name, kind FROM channels ORDER BY id").toArray() as unknown as Channel[];
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
    const preview = m.text.replace(MENTION, (_, key) => `@${names.get(key) ?? "someone"}`).slice(0, 200);
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
    for (const key of keys) {
      const mention = mentioned.has(key) && key !== m.author_key;
      const call = accountOf(this.env, key).channelActivity({ ...activity, mention, preview: mention ? preview : null });
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
    if (s.stage === "joined") return await this.onMember(ws, s, msg);
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
    // The newest connection wins: an old one may be a crashed app or a dropped network
    // whose socket never closed properly.
    const previous = this.members().find(([, m]) => m.key === key);
    if (previous) {
      const [oldWs, old] = previous;
      this.error(oldWs, "You connected to this server from somewhere else.");
      oldWs.serializeAttachment({ stage: "removed" } satisfies Session);
      try {
        oldWs.close(4002, "replaced");
      } catch {
        // Already gone.
      }
      this.broadcast({ type: "user_left", session_id: old.user!.session_id });
    }
    if (this.members().length >= MAX_MEMBERS_ONLINE) return this.reject(ws, "The server is full.");
    const taken = this.sql
      .exec("SELECT 1 FROM accounts WHERE key != ? AND lower(name) = lower(?)", key, name)
      .toArray().length;
    if (taken) return this.reject(ws, `The name "${name}" is already taken on this server.`);

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

    const user: User = {
      session_id: crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff,
      name,
      voice_channel: null,
      muted: false,
      deafened: false,
      owner: isOwner,
      public_key: key,
    };
    const joined: Session = { stage: "joined", key, name, user, tokens: CHAT_BURST, refilled: now };
    this.broadcast({ type: "user_joined", user });
    ws.serializeAttachment(joined);
    const channels = this.channels();
    this.send(ws, {
      type: "welcome",
      server_name: this.meta("name"),
      server_icon: this.meta("icon"),
      session_id: user.session_id,
      // Cloud servers carry no UDP voice relay; voice between members is peer-to-peer.
      udp_token: 0,
      udp_port: 0,
      channels,
      users: this.members().map(([, m]) => m.user),
    });
    for (const ch of channels.filter((c) => c.kind === "text")) {
      this.send(ws, { type: "chat_history", channel: ch.id, messages: this.history(ch.id) });
    }
  }

  private async onMember(ws: WebSocket, s: Session, msg: ClientMsg) {
    const user = s.user!;
    const owner = user.owner;
    const ownerOnly = () => {
      if (!owner) this.error(ws, "Only the server owner can do that.");
      return owner;
    };

    switch (msg.type) {
      case "join_voice": {
        const ch = this.channel(Number(msg.channel));
        if (ch?.kind !== "voice") return this.error(ws, "That voice channel doesn't exist.");
        const others = this.voiceMembers(ch.id).filter(([other]) => other !== ws);
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
      case "load_older": {
        const channel = Number(msg.channel);
        const messages = this.history(channel, Number(msg.before), OLDER_PAGE + 1);
        const done = messages.length <= OLDER_PAGE;
        if (!done) messages.shift();
        return this.send(ws, { type: "older_history", channel, messages, done });
      }
      case "delete_message": {
        const channel = Number(msg.channel);
        const id = Number(msg.id);
        const row = this.sql.exec("SELECT author_key FROM messages WHERE channel = ? AND id = ?", channel, id).toArray()[0];
        if (!row) return this.error(ws, "That message no longer exists.");
        if (row.author_key !== s.key && !owner) return this.error(ws, "You can only delete your own messages.");
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
        if (!ownerOnly()) return;
        const kind: ChannelKind = msg.kind === "voice" ? "voice" : "text";
        const name = normalizeChannelName(msg.name, kind);
        if (!name || [...name].length > MAX_NAME_LEN) return this.error(ws, `Channel names must be 1–${MAX_NAME_LEN} characters.`);
        if (this.channels().length >= MAX_CHANNELS) return this.error(ws, `A server can have at most ${MAX_CHANNELS} channels.`);
        this.sql.exec("INSERT INTO channels (name, kind) VALUES (?, ?)", name, kind);
        return this.broadcast({ type: "channels_updated", channels: this.channels() });
      }
      case "delete_channel": {
        if (!ownerOnly()) return;
        const id = Number(msg.channel);
        if (!this.channel(id)) return this.error(ws, "That channel doesn't exist.");
        this.sql.exec("DELETE FROM channels WHERE id = ?", id);
        this.sql.exec("DELETE FROM messages WHERE channel = ?", id);
        for (const [mws, m] of this.members()) {
          if (m.user!.voice_channel === id) this.updateUser(mws, m, (u) => (u.voice_channel = null));
        }
        return this.broadcast({ type: "channels_updated", channels: this.channels() });
      }
      case "kick":
      case "ban": {
        if (!ownerOnly()) return;
        const target = Number(msg.session_id);
        if (target === user.session_id) return this.error(ws, "You can't remove yourself.");
        const victim = this.members().find(([, m]) => m.user!.session_id === target);
        if (!victim) return this.error(ws, "That person isn't connected anymore.");
        const [vws, vs] = victim;
        const banned = msg.type === "ban";
        if (banned) {
          this.sql.exec(
            "INSERT INTO bans (key, name, banned_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING",
            vs.key!, vs.user!.name, Date.now(),
          );
          this.send(ws, { type: "bans", bans: this.bans() });
        }
        this.send(vws, { type: "kicked", banned });
        vws.serializeAttachment({ stage: "removed" } satisfies Session);
        vws.close(4001, banned ? "banned" : "kicked");
        return this.broadcast({ type: "user_left", session_id: target });
      }
      case "unban":
        if (!ownerOnly()) return;
        this.sql.exec("DELETE FROM bans WHERE key = ?", String(msg.public_key ?? ""));
        return this.send(ws, { type: "bans", bans: this.bans() });
      case "create_invite": {
        if (!ownerOnly()) return;
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
          "INSERT INTO invites (code, created_at, expires_at, max_uses, uses) VALUES (?, ?, ?, ?, 0)",
          invite.code, invite.created_at, invite.expires_at, invite.max_uses,
        );
        this.send(ws, { type: "invite_created", invite });
        return this.send(ws, { type: "invites", invites: this.invites() });
      }
      case "revoke_invite": {
        if (!ownerOnly()) return;
        const code = String(msg.code ?? "");
        this.sql.exec("DELETE FROM invites WHERE code = ?", code);
        await inviteIndex(this.env).remove(code);
        return this.send(ws, { type: "invites", invites: this.invites() });
      }
      case "update_server": {
        if (!ownerOnly()) return;
        const name = String(msg.name ?? "").trim();
        const icon = msg.icon == null ? null : String(msg.icon);
        if (!name || [...name].length > MAX_SERVER_NAME_LEN) {
          return this.error(ws, `Server names must be 1–${MAX_SERVER_NAME_LEN} characters.`);
        }
        if (icon !== null && !validIcon(icon)) return this.error(ws, "That picture can't be used. Try a PNG or JPEG image.");
        this.setMeta("name", name);
        if (icon === null) this.sql.exec("DELETE FROM meta WHERE key = 'icon'");
        else this.setMeta("icon", icon);
        return this.broadcast({ type: "server_updated", name, icon });
      }
      case "get_server_settings":
        if (!ownerOnly()) return;
        this.send(ws, { type: "invites", invites: this.invites() });
        return this.send(ws, { type: "bans", bans: this.bans() });
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
