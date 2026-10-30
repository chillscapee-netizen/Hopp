// Ström cloud: routes each server's WebSocket to its own Durable Object, and
// answers invite previews (server name, picture and member counts).

export { StromServer } from "./server";
export { InviteIndex } from "./invites";

import { inviteIndex, type InviteIndex } from "./invites";
import type { StromServer } from "./server";

export interface Env {
  SERVERS: DurableObjectNamespace<StromServer>;
  INVITES: DurableObjectNamespace<InviteIndex>;
}

/** Server ids are long and random, so they can't be guessed. */
const SERVER_PATH = /^\/servers\/([A-Za-z0-9]{12,40})\/ws$/;
const INVITE_PATH = /^\/invite\/([A-Za-z0-9]{6,16})$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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
      return new Response("Ström cloud is running.\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
