// Hopp cloud: routes each server's WebSocket to its own Durable Object, and
// answers invite previews (server name, picture and member counts).

export { StromServer } from "./server";
export { InviteIndex } from "./invites";
export { StromAccount, UserDirectory } from "./account";

import { inviteIndex, type InviteIndex } from "./invites";
import type { StromServer } from "./server";
import { accountOf, directory, type StromAccount, type UserDirectory } from "./account";

export interface Env {
  SERVERS: DurableObjectNamespace<StromServer>;
  INVITES: DurableObjectNamespace<InviteIndex>;
  ACCOUNTS: DurableObjectNamespace<StromAccount>;
  DIRECTORY: DurableObjectNamespace<UserDirectory>;
  /** KLIPY API key for GIF search (`npx wrangler secret put KLIPY_KEY`); GIFs are off without it. */
  KLIPY_KEY?: string;
}

/** Server ids are long and random, so they can't be guessed. */
const SERVER_PATH = /^\/servers\/([A-Za-z0-9]{12,40})\/ws$/;
const INVITE_PATH = /^\/invite\/([A-Za-z0-9]{6,16})$/;
const USER_PATH = /^\/users\/([a-z0-9_.]{2,32})$/;
const PROFILE_PATH = /^\/profiles\/([0-9a-f]{64})$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
  });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // GIFs for the picker: search, or what's popular. The key stays here, and answers are cached.
    if (url.pathname === "/gifs" && request.method === "GET") return gifs(url, env, ctx);

    const server = url.pathname.match(SERVER_PATH);
    if (server) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected a WebSocket", { status: 426 });
      }
      const stub = env.SERVERS.get(env.SERVERS.idFromName(server[1]));
      // The object can't know the name it was created from; tell it, for registering invites.
      const forwarded = new Request(request);
      forwarded.headers.set("X-Strom-Server", server[1]);
      return stub.fetch(forwarded);
    }

    // An account: every device of one Hopp ID connects to the same object.
    if (url.pathname === "/account/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
      const key = (url.searchParams.get("key") ?? "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(key)) return new Response("Bad key", { status: 400 });
      return accountOf(env, key).fetch(request);
    }

    // Someone's public profile by username, for "Add friend" and profile cards.
    const user = url.pathname.match(USER_PATH);
    if (user && request.method === "GET") {
      const key = await directory(env).lookup(user[1]);
      if (!key) return json({ error: "Nobody has that username." }, 404);
      return json(await accountOf(env, key).publicProfile());
    }

    // Someone's public profile by Hopp ID: the names and pictures of people in servers and chat.
    const profile = url.pathname.match(PROFILE_PATH);
    if (profile && request.method === "GET") {
      const p = await accountOf(env, profile[1]).publicProfile();
      if (!p.key) return json({ error: "No such account." }, 404);
      return json(p);
    }

    const invite = url.pathname.match(INVITE_PATH);
    if (invite && request.method === "GET") {
      const code = invite[1].toUpperCase();
      const serverId = await inviteIndex(env).lookup(code);
      if (!serverId) return json({ error: "This invite is invalid or has expired." }, 404);
      const preview = await env.SERVERS.get(env.SERVERS.idFromName(serverId)).preview(code);
      if (!preview) return json({ error: "This invite is invalid or has expired." }, 404);
      return json({ ...preview, server_id: serverId, code });
    }

    if (url.pathname === "/") {
      return new Response("Hopp cloud is running.\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

interface Gif { id: string; url: string; preview: string; width: number; height: number; title: string }

async function gifs(url: URL, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.KLIPY_KEY) return json({ error: "GIFs aren't set up yet." }, 503);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 60);
  const pos = (url.searchParams.get("pos") ?? "").slice(0, 40);
  const cacheKey = new Request(`https://gifs.cache/?q=${encodeURIComponent(q.toLowerCase())}&pos=${encodeURIComponent(pos)}`);
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;

  const api = new URL(`https://api.klipy.com/v2/${q ? "search" : "featured"}`);
  api.searchParams.set("key", env.KLIPY_KEY);
  if (q) api.searchParams.set("q", q);
  if (pos) api.searchParams.set("pos", pos);
  api.searchParams.set("limit", "30");
  api.searchParams.set("media_filter", "gif,tinygif");
  api.searchParams.set("contentfilter", "medium");
  const upstream = await fetch(api);
  if (!upstream.ok) return json({ error: "Couldn't load GIFs right now." }, 502);
  const data = (await upstream.json()) as { results?: any[]; next?: string };
  const list: Gif[] = (data.results ?? [])
    .map((r) => {
      const full = r.media_formats?.gif;
      const small = r.media_formats?.tinygif ?? full;
      return {
        id: String(r.id ?? ""),
        url: String(full?.url ?? ""),
        preview: String(small?.url ?? ""),
        width: Number(small?.dims?.[0] ?? full?.dims?.[0] ?? 0),
        height: Number(small?.dims?.[1] ?? full?.dims?.[1] ?? 0),
        title: String(r.content_description ?? r.title ?? ""),
      };
    })
    .filter((g) => g.url.startsWith("https://") && g.preview.startsWith("https://"));
  const res = json({ gifs: list, next: data.next ?? null });
  res.headers.set("cache-control", `public, max-age=${q ? 3600 : 900}`);
  ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
  return res;
}
