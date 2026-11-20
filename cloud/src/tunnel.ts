// A tunnel to a server someone hosts on their own computer, so nobody ever connects to that
// computer (its address stays private) and no port has to be opened on the router.
//
// The hosting app connects out to /tunnels/<id>/host; friends' apps connect to
// /tunnels/<id>/join. This only passes bytes between them: the app and the server speak TLS
// end to end inside, so what goes through here can't be read, and nothing is kept.
//
// Frames between this object and the host: [kind (1 byte)][connection (4 bytes)][bytes]:
//   1 open (a friend connected), 2 data, 3 close. Friends get and send plain bytes.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

const OPEN = 1;
const DATA = 2;
const CLOSE = 3;
/** Friends connected at once through one tunnel. */
const MAX_GUESTS = 60;
/** The largest frame passed on (TLS records are at most ~16 KB). */
const MAX_FRAME = 64 * 1024;

interface Guest {
  conn: number;
}

function frame(kind: number, conn: number, bytes?: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + (bytes?.length ?? 0));
  out[0] = kind;
  new DataView(out.buffer).setUint32(1, conn);
  if (bytes) out.set(bytes, 5);
  return out;
}

async function sha256hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class HoppTunnel extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The host says "hopp-ping" now and then to know the tunnel is still there: answered here
    // without waking this object (so it costs nothing).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("hopp-ping", "hopp-pong"));
  }

  private host(): WebSocket | undefined {
    return this.ctx.getWebSockets("host")[0];
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const url = new URL(request.url);
    if (await this.ctx.storage.get<boolean>("blocked")) return new Response("This server has been blocked from Hopp's tunnel for breaking Hopp's rules.", { status: 403 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (url.pathname.endsWith("/host")) {
      // The tunnel belongs to whoever opened it first: the host proves it with its secret.
      const secret = url.searchParams.get("secret") ?? "";
      if (!/^[0-9a-f]{64}$/.test(secret)) return new Response("Bad secret", { status: 400 });
      const hash = await sha256hex(secret);
      const kept = await this.ctx.storage.get<string>("host");
      if (kept && kept !== hash) return new Response("This tunnel belongs to another server", { status: 403 });
      if (!kept) await this.ctx.storage.put("host", hash);
      // One host at a time: a reconnect replaces the old one (its friends reconnect too).
      for (const old of this.ctx.getWebSockets()) old.close(1012, "The server reconnected.");
      this.ctx.acceptWebSocket(server, ["host"]);
      return new Response(null, { status: 101, webSocket: client });
    }

    const host = this.host();
    if (!host) return new Response("This server is offline right now (its computer isn't running Hopp).", { status: 503 });
    if (this.ctx.getWebSockets().length - 1 >= MAX_GUESTS) return new Response("This server is full.", { status: 503 });
    const conn = ((await this.ctx.storage.get<number>("next")) ?? 1) % 0xffffffff || 1;
    await this.ctx.storage.put("next", conn + 1);
    this.ctx.acceptWebSocket(server, ["c:" + conn]);
    server.serializeAttachment({ conn } satisfies Guest);
    host.send(frame(OPEN, conn));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Whether `secret` is this tunnel's host's (the server it belongs to). */
  async ownedBy(secret: string): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(secret)) return false;
    const kept = await this.ctx.storage.get<string>("host");
    return !!kept && kept === (await sha256hex(secret)) && !(await this.ctx.storage.get<boolean>("blocked"));
  }

  /** Blocked by Hopp for breaking its rules: nobody gets through, the host neither. */
  async setBlocked(on: boolean) {
    if (!on) return void (await this.ctx.storage.delete("blocked"));
    await this.ctx.storage.put("blocked", true);
    for (const ws of this.ctx.getWebSockets()) ws.close(1008, "Blocked by Hopp.");
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    if (typeof data === "string" || data.byteLength > MAX_FRAME + 5) return;
    const bytes = new Uint8Array(data);
    const guest = ws.deserializeAttachment() as Guest | null;
    if (guest?.conn) {
      // A friend's bytes, on to the host.
      const host = this.host();
      if (!host) return ws.close(1012, "The server went offline.");
      host.send(frame(DATA, guest.conn, bytes));
      return;
    }
    // From the host: to one friend.
    if (bytes.length < 5) return;
    const kind = bytes[0];
    const conn = new DataView(bytes.buffer, bytes.byteOffset).getUint32(1);
    const to = this.ctx.getWebSockets("c:" + conn)[0];
    if (!to) {
      if (kind === DATA) ws.send(frame(CLOSE, conn));
      return;
    }
    if (kind === DATA) to.send(bytes.subarray(5));
    else if (kind === CLOSE) to.close(1000, "Closed by the server.");
  }

  async webSocketClose(ws: WebSocket) {
    const guest = ws.deserializeAttachment() as Guest | null;
    if (guest?.conn) {
      this.host()?.send(frame(CLOSE, guest.conn));
      return;
    }
    // The host left: everyone's connection ends.
    for (const other of this.ctx.getWebSockets()) if (other !== ws) other.close(1012, "The server went offline.");
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }
}
