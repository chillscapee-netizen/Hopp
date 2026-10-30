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
const INVITE_PAGE = /^\/i\/([A-Za-z0-9]{6,16})\/?$/;

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

    // An invite link anyone can click: the server, "Open in Hopp" and a download.
    const page = url.pathname.match(INVITE_PAGE);
    if (page && request.method === "GET") {
      const code = page[1].toUpperCase();
      const serverId = await inviteIndex(env).lookup(code);
      const preview = serverId ? await env.SERVERS.get(env.SERVERS.idFromName(serverId)).preview(code) : null;
      return new Response(invitePage(code, preview), { status: preview ? 200 : 404, headers: { "content-type": "text/html; charset=utf-8" } });
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

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The page an invite link opens in a browser. */
function invitePage(code: string, p: { name: string | null; icon: string | null; members: number; online: number; inviter: string | null } | null): string {
  const name = p?.name ? escapeHtml(p.name) : "";
  const icon = p?.icon && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(p.icon) ? `<img class="icon" src="${p.icon}" alt="">` : `<div class="icon letter">${name.slice(0, 1) || "?"}</div>`;
  const body = p
    ? `<p class="kicker">${p.inviter ? `${escapeHtml(p.inviter)} invited you to join` : "You've been invited to join"}</p>
       ${icon}<h1>${name}</h1>
       <p class="counts"><span class="dot on"></span>${p.online} Online <span class="dot"></span>${p.members} ${p.members === 1 ? "Member" : "Members"}</p>
       <a class="btn primary" href="hopp://${code}">Open in Hopp</a>
       <p class="small">Don't have Hopp yet?</p>
       <a class="btn" href="/download/Hopp-setup.exe">Download Hopp for Windows</a>
       <p class="hint">After installing, come back and press <b>Open in Hopp</b>. Windows may say it doesn't recognise the app: choose <b>More info</b>, then <b>Run anyway</b>.</p>`
    : `<h1>This invite is invalid or has expired</h1><p class="small">Ask for a new one.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name ? `Join ${name} on Hopp` : "Hopp invite"}</title>
<meta property="og:title" content="${name ? `Join ${name} on Hopp` : "Hopp invite"}"><meta property="og:description" content="Voice and chat for friends.">
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:#1c1c1f;color:#e9e9ec;font:15px/1.5 system-ui,"Segoe UI",sans-serif}
main{width:min(420px,100%);padding:32px;text-align:center;background:#2a2a2e;border:1px solid #3f3f45;border-radius:16px;box-shadow:0 30px 80px rgb(0 0 0/.5)}
.kicker{margin:0 0 16px;color:#a3a3ab;font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
.icon{width:80px;height:80px;margin:0 auto 12px;border-radius:24px;object-fit:cover}.letter{display:grid;place-items:center;background:#46564c;font-size:32px;font-weight:700}
h1{margin:0 0 6px;font-size:24px}.counts{margin:0 0 24px;color:#a3a3ab;font-size:14px}.dot{display:inline-block;width:8px;height:8px;margin:0 6px 0 10px;border-radius:50%;background:#7b7b84}.dot.on{background:#3ccf8e}
.btn{display:block;padding:12px;border-radius:8px;background:#3b3b40;color:#e9e9ec;font-weight:600;text-decoration:none}.btn:hover{background:#46464c}.btn.primary{background:#e9e9ec;color:#1c1c1f}.btn.primary:hover{background:#fff}
.small{margin:20px 0 8px;color:#a3a3ab;font-size:14px}.hint{margin:14px 0 0;color:#7b7b84;font-size:12.5px}
</style></head><body><main>${body}</main></body></html>`;
}
