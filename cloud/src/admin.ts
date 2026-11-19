// Running Hopp Cloud: reports, and what can be done about them. Admins are Hopp IDs, not
// passwords: the owners are named in the HOPP_OWNERS secret (their Hopp IDs, separated by
// commas), and owners can make other people admins from inside the app. Everything here is
// asked for over the admin's own account connection, which has already proved who they are.

import { accountOf, directory } from "./account";
import type { Env } from "./index";

export type AdminRole = "owner" | "admin";

const KEY = /^[0-9a-f]{64}$/;
const TUNNEL_ID = /^[0-9a-f]{32}$/;

/** The owners' Hopp IDs, from the HOPP_OWNERS secret. */
export function owners(env: Env): Set<string> {
  return new Set(
    String(env.HOPP_OWNERS ?? "")
      .split(/[\s,]+/)
      .map((k) => k.trim().toLowerCase())
      .filter((k) => KEY.test(k)),
  );
}

/** What a report's server address points at on Hopp Cloud: one of its servers, or a tunnel. */
export function place(address: string): { server?: string; tunnel?: string } {
  const cloud = address.match(/^cloud:([A-Za-z0-9]{12,40})$/);
  if (cloud) return { server: cloud[1] };
  const tunnel = address.match(/tunnel:([0-9a-f]{32})/);
  if (tunnel) return { tunnel: tunnel[1] };
  return {};
}

const server = (env: Env, id: string) => env.SERVERS.get(env.SERVERS.idFromName(id));
const tunnel = (env: Env, id: string) => env.TUNNELS.get(env.TUNNELS.idFromName(id));

/** Every admin, owners included, for telling them about new reports. */
export async function adminKeys(env: Env): Promise<string[]> {
  const listed = (await directory(env).admins()).map((a) => String(a.key));
  return [...new Set([...owners(env), ...listed])];
}

/**
 * One thing an admin asks for. Answers what the app shows, or throws a message to show.
 * `who` is the admin: their Hopp ID, name and role.
 */
export async function adminRequest(env: Env, who: { key: string; name: string; role: AdminRole }, msg: Record<string, unknown>): Promise<object> {
  const dir = directory(env);
  const str = (v: unknown, n = 300) => String(v ?? "").slice(0, n);
  const reportId = Number(msg.id);
  const log = (action: string, subject: string, detail = "") => dir.logAdmin(action, subject, `${who.name}${detail ? ": " + detail : ""}`);
  const ownerOnly = (what: string) => {
    if (who.role !== "owner") throw new Error(`Only an owner of Hopp Cloud can ${what}.`);
  };

  switch (msg.op) {
    case "overview":
      return { stats: await dir.stats(), role: who.role };

    case "reports": {
      const view = ["open", "done", "all"].includes(String(msg.view)) ? String(msg.view) : "open";
      const user = KEY.test(str(msg.user)) ? str(msg.user) : undefined;
      const found = await dir.reports({ view, reason: str(msg.reason, 20) || undefined, user, server: str(msg.server) || undefined, q: str(msg.q, 80).trim() || undefined });
      // What each Hopp Cloud server is now: its name, owner and size, or gone.
      const ids = [...new Set(found.rows.map((r) => place(String(r.server)).server).filter((x): x is string => !!x))].slice(0, 30);
      const servers = Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await server(env, id).adminInfo().catch(() => null)])));
      return { ...found, servers, stats: await dir.stats() };
    }

    case "settle": {
      if (!Number.isFinite(reportId)) throw new Error("Which report?");
      await dir.settleReport(reportId, {
        done: msg.done === undefined ? undefined : !!msg.done,
        action: msg.done ? `Handled by ${who.name}` : msg.done === false ? "" : undefined,
        note: msg.note === undefined ? undefined : str(msg.note, 1000),
      });
      if (msg.done !== undefined) await log(msg.done ? "handled" : "reopened", `report #${reportId}`);
      return { ok: true };
    }

    case "delete_report": {
      ownerOnly("delete reports");
      if (!Number.isFinite(reportId)) throw new Error("Which report?");
      await dir.deleteReport(reportId);
      await log("deleted report", `report #${reportId}`);
      return { ok: true };
    }

    case "delete_handled": {
      ownerOnly("delete reports");
      const gone = await dir.deleteHandledReports();
      await log("deleted handled reports", `${gone} report${gone === 1 ? "" : "s"}`);
      return { ok: true, gone };
    }

    case "ban":
    case "unban": {
      const on = msg.op === "ban";
      if (!on) ownerOnly("lift a ban");
      let key = str(msg.key).toLowerCase();
      // Straight by username, without a report: an owner's call.
      if (!KEY.test(key) && msg.username) {
        ownerOnly("ban someone without a report");
        key = (await dir.lookup(str(msg.username, 40).trim().replace(/^@/, "").toLowerCase())) || "";
        if (!key) throw new Error("Nobody has that username.");
      }
      if (!KEY.test(key)) throw new Error("That isn't a Hopp ID.");
      if (on && owners(env).has(key)) throw new Error("An owner of Hopp Cloud can't be banned.");
      if (on && key === who.key) throw new Error("You can't ban yourself.");
      const card = await accountOf(env, key).adminCard();
      const name = str(msg.name, 64) || card.username || card.display_name || "someone";
      await accountOf(env, key).setCloudBanned(on);
      await dir.setCloudBan(key, on, name, str(msg.reason, 200));
      if (on) {
        await dir.setAdmin(key, false);
        await accountOf(env, key).setAdminFlag(false);
        await dir.settleAllAbout("user_key", key, `${name} banned by ${who.name}`);
      }
      await log(on ? "banned" : "unbanned", `${name} (${key.slice(0, 12)}…)`, str(msg.reason, 200));
      return { ok: true };
    }

    case "delete_message": {
      const at = place(str(msg.server));
      const [channel, id] = str(msg.message_id, 40).split("/").map(Number);
      if (!at.server || !Number.isFinite(channel) || !Number.isFinite(id)) throw new Error("Only messages in servers on Hopp Cloud can be removed from here.");
      const gone = await server(env, at.server).adminDeleteMessage(channel, id);
      if (Number.isFinite(reportId)) await dir.settleReport(reportId, { done: true, action: `Message removed by ${who.name}` });
      await log("removed message", `${str(msg.server_name, 100) || at.server} #${channel}/${id}`, gone ? "" : "it was already gone");
      return { ok: true, gone };
    }

    case "take_down": {
      const at = place(str(msg.server));
      if (!at.server) throw new Error("Only servers on Hopp Cloud can be taken down.");
      const info = await server(env, at.server).adminInfo();
      await server(env, at.server).adminTakeDown();
      await dir.settleAllAbout("server", str(msg.server), `Server taken down by ${who.name}`);
      await log("took down server", `${info?.name ?? (str(msg.server_name, 100) || at.server)}`, str(msg.reason, 200));
      return { ok: true };
    }

    case "block_tunnel":
    case "unblock_tunnel": {
      const at = place(str(msg.server));
      const id = at.tunnel ?? (TUNNEL_ID.test(str(msg.tunnel)) ? str(msg.tunnel) : "");
      if (!id) throw new Error("That isn't a server reached through Hopp's tunnel.");
      const on = msg.op === "block_tunnel";
      if (!on) ownerOnly("unblock a server");
      await tunnel(env, id).setBlocked(on);
      await dir.setTunnelBlocked(id, on, str(msg.server_name, 100));
      if (on) await dir.settleAllAbout("server", str(msg.server), `Tunnel blocked by ${who.name}`);
      await log(on ? "blocked tunnel" : "unblocked tunnel", str(msg.server_name, 100) || id);
      return { ok: true };
    }

    case "bans":
      return { bans: await dir.cloudBans(), tunnels: await dir.blockedTunnels() };

    case "log":
      return { log: await dir.adminLog() };

    case "admins": {
      const listed = await dir.admins();
      const ownerRows = await Promise.all([...owners(env)].map(async (key) => ({ key, ...(await accountOf(env, key).adminCard()), role: "owner" })));
      return { admins: [...ownerRows, ...listed.filter((a) => !owners(env).has(String(a.key))).map((a) => ({ ...a, role: "admin" }))] };
    }

    case "add_admin":
    case "remove_admin": {
      if (who.role !== "owner") throw new Error("Only an owner of Hopp Cloud can change who's an admin.");
      const on = msg.op === "add_admin";
      let key = str(msg.key).toLowerCase();
      if (!KEY.test(key)) {
        const name = str(msg.username, 40).trim().replace(/^@/, "").toLowerCase();
        key = (name && (await dir.lookup(name))) || "";
        if (!key) throw new Error("Nobody has that username.");
      }
      if (owners(env).has(key)) throw new Error("Owners are set in Hopp Cloud's settings, not here.");
      const card = await accountOf(env, key).adminCard();
      const name = card.username || card.display_name || "someone";
      await dir.setAdmin(key, on, name, who.name);
      await accountOf(env, key).setAdminFlag(on);
      await log(on ? "made admin" : "removed admin", name);
      return { ok: true };
    }
  }
  throw new Error("Unknown admin request.");
}
