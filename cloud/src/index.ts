// Hopp cloud: routes each server's WebSocket to its own Durable Object, and
// answers invite previews (server name, picture and member counts).

export { StromServer } from "./server";
export { InviteIndex } from "./invites";
export { StromAccount, UserDirectory } from "./account";
export { HoppTunnel } from "./tunnel";

import { inviteIndex, type InviteIndex } from "./invites";
import type { StromServer } from "./server";
import { accountOf, directory, type StromAccount, type UserDirectory } from "./account";

export interface Env {
  SERVERS: DurableObjectNamespace<StromServer>;
  INVITES: DurableObjectNamespace<InviteIndex>;
  ACCOUNTS: DurableObjectNamespace<StromAccount>;
  DIRECTORY: DurableObjectNamespace<UserDirectory>;
  TUNNELS: DurableObjectNamespace<import("./tunnel").HoppTunnel>;
  /** KLIPY API key for GIF search (`npx wrangler secret put KLIPY_KEY`); GIFs are off without it. */
  KLIPY_KEY?: string;
  /**
   * The emergency brake: "1" stops new accounts and new servers (everyone else carries on).
   * Set it under the Worker's Settings → Variables in the Cloudflare dashboard.
   */
  PAUSE_NEW?: string;
  /**
   * The voice relay (Cloudflare Realtime TURN), for people whose networks block direct voice.
   * Create a TURN key in the dashboard (Realtime → TURN), then:
   *   npx wrangler secret put TURN_KEY_ID      (the key's id)
   *   npx wrangler secret put TURN_KEY_TOKEN   (its API token)
   * Without them voice still works directly; only blocked pairs can't hear each other.
   */
  TURN_KEY_ID?: string;
  TURN_KEY_TOKEN?: string;
  /**
   * The relay's spending guard reads real usage from Cloudflare (both needed, or no relay):
   *   npx wrangler secret put CF_ACCOUNT_ID         (the account id, from the dashboard)
   *   npx wrangler secret put CF_ANALYTICS_TOKEN    (an API token with "Account Analytics: Read")
   */
  /**
   * The Hopp IDs of whoever runs Hopp Cloud, separated by commas (`npx wrangler secret put
   * HOPP_OWNERS`). Owners see reports in the app and can make other people admins there.
   */
  HOPP_OWNERS?: string;
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
  /** Stop handing out relay logins at this many GB a month (default 800; the free amount is 1,000). */
  RELAY_BUDGET_GB?: string;
  /** Pictures across all of Hopp Cloud stop at this many GB (default 3.5 of the free 5), so
   *  messages and accounts always have room. */
  PICTURE_BUDGET_GB?: string;
}

/** Server ids are long and random, so they can't be guessed. */
const SERVER_PATH = /^\/servers\/([A-Za-z0-9]{12,40})\/ws$/;
/** A server hosted on someone's computer, reached without its address: by its host, or a friend. */
const TUNNEL_PATH = /^\/tunnels\/([0-9a-f]{32})\/(host|join)$/;
const ACCOUNT_IMAGE_PATH = /^\/accounts\/([0-9a-f]{64})\/images(?:\/([0-9a-f]{32}))?$/;
const IMAGE_PATH = /^\/servers\/([A-Za-z0-9]{12,40})\/images(?:\/([0-9a-f]{32}))?$/;
const INVITE_PATH = /^\/invite\/([A-Za-z0-9]{6,16})$/;
const USER_PATH = /^\/users\/([a-z0-9_.]{2,32})$/;
const PROFILE_PATH = /^\/profiles\/([0-9a-f]{64})$/;
const INVITE_PAGE = /^\/i\/([A-Za-z0-9]{6,16})\/?$/;
/** A server on someone's computer registers a short link for one of its invites. */
const TUNNEL_INVITE = /^\/tunnels\/([0-9a-f]{32})\/invite$/;

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

    // Encrypted pictures in DMs, kept by the sender's account.
    const accountImage = url.pathname.match(ACCOUNT_IMAGE_PATH);
    if (accountImage) return accountOf(env, accountImage[1]).fetch(request);

    // Pictures in a server's chat: uploads (signed by a member) and the pictures themselves.
    const image = url.pathname.match(IMAGE_PATH);
    if (image) {
      const stub = env.SERVERS.get(env.SERVERS.idFromName(image[1]));
      const forwarded = new Request(request);
      forwarded.headers.set("X-Strom-Server", image[1]);
      // Not kept in Cloudflare's cache: a deleted picture must be gone at once. The app keeps
      // its own copy, so each person fetches a picture only once.
      return stub.fetch(forwarded);
    }

    // A short link for an invite to a server on someone's computer, as Hopp Cloud's servers have:
    // only its host can make one (it proves it with the tunnel's secret).
    const hostedInvite = url.pathname.match(TUNNEL_INVITE);
    if (hostedInvite && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const code = String(body.code ?? "").toUpperCase();
      const pin = String(body.pin ?? "").toLowerCase();
      const name = String(body.name ?? "").trim().slice(0, 40) || "A server";
      const expires = body.expires_at == null ? null : Number(body.expires_at);
      if (!/^[A-Z0-9]{6,16}$/.test(code) || !/^[0-9a-f]{32,64}$/.test(pin) || (expires !== null && !Number.isFinite(expires))) return json({ error: "Bad invite." }, 400);
      const owner = await env.TUNNELS.get(env.TUNNELS.idFromName(hostedInvite[1])).ownedBy(String(body.secret ?? ""));
      if (!owner) return json({ error: "Not this server's tunnel." }, 403);
      if (!(await inviteIndex(env).registerHosted(code, hostedInvite[1], pin, name, expires))) return json({ error: "That code is taken." }, 409);
      return json({ ok: true });
    }

    const tunnel = url.pathname.match(TUNNEL_PATH);
    if (tunnel) return env.TUNNELS.get(env.TUNNELS.idFromName(tunnel[1])).fetch(request);

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

    // An account saved to Hopp Cloud: save, fetch (on a new computer) or remove it.
    if (url.pathname === "/backup" && request.method === "POST") {
      let body: Record<string, unknown>;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Bad request." }, 400);
      }
      // (Typed by hand: an RPC answer with an open body reads as never.)
      const out = (await directory(env).backup(body, request.headers.get("CF-Connecting-IP") ?? undefined)) as unknown as { status: number; body: unknown };
      return json(out.body, out.status);
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
      const found = await inviteIndex(env).find(code);
      const serverId = found?.server.startsWith("tunnel:") ? null : found?.server;
      const preview = found?.server.startsWith("tunnel:")
        ? { name: found.name, icon: null, members: null, online: null, inviter: null }
        : serverId ? await env.SERVERS.get(env.SERVERS.idFromName(serverId)).preview(code) : null;
      return new Response(invitePage(code, preview), { status: preview ? 200 : 404, headers: { "content-type": "text/html; charset=utf-8" } });
    }

    const invite = url.pathname.match(INVITE_PATH);
    if (invite && request.method === "GET") {
      const code = invite[1].toUpperCase();
      const found = await inviteIndex(env).find(code);
      if (!found) return json({ error: "This invite is invalid or has expired." }, 404);
      // A server on someone's computer: where to reach it and its key (it says itself who's in it).
      if (found.server.startsWith("tunnel:")) return json({ name: found.name, icon: null, address: found.server, pin: found.pin, code, hosted: true });
      const serverId = found.server;
      const preview = await env.SERVERS.get(env.SERVERS.idFromName(serverId)).preview(code);
      if (!preview) return json({ error: "This invite is invalid or has expired." }, 404);
      return json({ ...preview, server_id: serverId, code });
    }

    // Hopp's home page: what it is and where to get it.
    if (url.pathname === "/") {
      return new Response(landingPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
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
  api.searchParams.set("media_filter", "gif,tinygif,mp4");
  api.searchParams.set("contentfilter", "medium");
  const upstream = await fetch(api);
  if (!upstream.ok) return json({ error: "Couldn't load GIFs right now." }, 502);
  const data = (await upstream.json()) as { results?: any[]; next?: string };
  const list: Gif[] = (data.results ?? [])
    .map((r) => {
      const full = r.media_formats?.gif;
      const small = r.media_formats?.tinygif ?? full;
      // What goes in a message: the video when there is one, else the GIF.
      const video = r.media_formats?.mp4;
      return {
        id: String(r.id ?? ""),
        url: String(video?.url ?? full?.url ?? ""),
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
function invitePage(code: string, p: { name: string | null; icon: string | null; members: number | null; online: number | null; inviter: string | null } | null): string {
  const name = p?.name ? escapeHtml(p.name) : "";
  const icon = p?.icon && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(p.icon) ? `<img class="icon" src="${p.icon}" alt="">` : `<div class="icon letter">${name.slice(0, 1) || "?"}</div>`;
  const body = p
    ? `<img class="brand" src="/site/logo.svg" alt="Hopp"><p class="kicker">${p.inviter ? `${escapeHtml(p.inviter)} invited you to join` : "You've been invited to join"}</p>
       ${icon}<h1>${name}</h1>
       ${p.members === null ? `<p class="counts">A server on someone's own computer</p>` : `<p class="counts"><span class="dot on"></span>${p.online} Online <span class="dot"></span>${p.members} ${p.members === 1 ? "Member" : "Members"}</p>`}
       <a class="btn primary" href="hopp://${code}">Open in Hopp</a>
       <p class="small">Don't have Hopp yet?</p>
       <a class="btn" href="${STORE_URL}">Get it from the Microsoft Store</a>
       <p class="hint">Free, for Windows 10 and 11. Once it's installed, press <b>Open in Hopp</b> again: you'll land in the server as soon as you've made your account. Or <a href="/download/Hopp-setup.exe">download the installer</a> (Windows may warn about it, as it isn't signed yet).</p>`
    : `<h1>This invite is invalid or has expired</h1><p class="small">Ask for a new one.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="/site/logo.svg">
<title>${name ? `Join ${name} on Hopp` : "Hopp invite"}</title>
<meta property="og:title" content="${name ? `Join ${name} on Hopp` : "Hopp invite"}"><meta property="og:description" content="Voice and chat for friends.">
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:#1c1c1f;color:#e9e9ec;font:15px/1.5 system-ui,"Segoe UI",sans-serif}
main{width:min(420px,100%);padding:32px;text-align:center;background:#2a2a2e;border:1px solid #3f3f45;border-radius:16px;box-shadow:0 30px 80px rgb(0 0 0/.5)}
.kicker{margin:0 0 16px;color:#a3a3ab;font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}
.icon{width:80px;height:80px;margin:0 auto 12px;border-radius:24px;object-fit:cover}.letter{display:grid;place-items:center;background:#46564c;font-size:32px;font-weight:700}
h1{margin:0 0 6px;font-size:24px}.counts{margin:0 0 24px;color:#a3a3ab;font-size:14px}.dot{display:inline-block;width:8px;height:8px;margin:0 6px 0 10px;border-radius:50%;background:#7b7b84}.dot.on{background:#3ccf8e}
.btn{display:block;padding:12px;border-radius:8px;background:#3b3b40;color:#e9e9ec;font-weight:600;text-decoration:none}.btn:hover{background:#46464c}.btn.primary{background:linear-gradient(135deg,#e3263f,#9b1f6e 55%,#2346c8);color:#fff;box-shadow:0 6px 22px rgb(227 38 63/.25)}.btn.primary:hover{background:linear-gradient(135deg,#e3263f,#9b1f6e 55%,#2346c8);filter:brightness(1.12)}.brand{display:block;width:32px;height:32px;margin:0 auto 18px}
.small{margin:20px 0 8px;color:#a3a3ab;font-size:14px}.hint{margin:14px 0 0;color:#7b7b84;font-size:12.5px}.hint a{color:#a3a3ab}
</style></head><body><main>${body}</main></body></html>`;
}

/** The page anyone gets at Hopp's address. */
function landingPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="/site/logo.svg">
<title>Hopp: voice and chat for friends</title>
<meta property="og:title" content="Hopp"><meta property="og:description" content="Voice and chat for friends. Free, private, light.">
<!-- Hopp cloud is running. -->
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:#1c1c1f;color:#e9e9ec;font:15px/1.5 system-ui,"Segoe UI",sans-serif}
main{width:min(560px,100%);text-align:center}
.logo{display:block;width:96px;height:96px;margin:0 auto 18px}
h1{margin:0 0 8px;font-size:40px;letter-spacing:-.02em}.lead{margin:0 0 28px;color:#a3a3ab;font-size:17px}
.btn{display:inline-block;padding:13px 26px;border-radius:10px;background:#e9e9ec;color:#1c1c1f;font-weight:700;text-decoration:none}.btn:hover{background:#fff}
.small{margin:12px 0 36px;color:#7b7b84;font-size:13px}
.points{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;text-align:left}
.point{padding:16px;background:#2a2a2e;border:1px solid #323236;border-radius:12px}.point b{display:block;margin-bottom:4px}.point span{color:#a3a3ab;font-size:14px}
</style></head><body><main>
<img class="logo" src="/site/logo.svg" alt="">
<h1>Hopp</h1>
<p class="lead">Voice and chat for you and your friends.</p>
<a class="btn" href="${STORE_URL}">Get it from the Microsoft Store</a>
<p class="small">Free, for Windows 10 and 11. Or <a href="/download/Hopp-setup.exe" style="color:inherit">download the installer</a> (Windows may warn about it, as it isn't signed yet).</p>
<div class="points">
<div class="point"><b>Clear voice</b><span>Low delay, noise removed, straight between friends.</span></div>
<div class="point"><b>Private</b><span>Direct messages and calls are end-to-end encrypted.</span></div>
<div class="point"><b>Free</b><span>No ads, no paid extras. Light on your computer.</span></div>
</div>
</main></body></html>`;
}

/** Hopp in the Microsoft Store: signed, so Windows trusts it without a warning. */
const STORE_URL = "https://apps.microsoft.com/detail/9MW46LXNB9X6";
