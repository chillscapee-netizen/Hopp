// The voice relay's budget: Cloudflare's TURN relay is free up to 1,000 GB a month.
// Hopp reads the real month-to-date usage from Cloudflare's analytics, hands out no
// more relay logins well before the free amount is used up, and revokes the ones still
// active when it gets there. If the usage can't be read, nothing is handed out: better
// a pair that can't hear each other than a bill.

import type { Env } from "./index";

export interface TurnLogin {
  server: string;
  username: string;
  credential: string;
}

/** Stop at this much (relay traffic both ways), unless RELAY_BUDGET_GB says otherwise. */
const DEFAULT_BUDGET_GB = 800;
/** Logins last 4 hours, so what's handed out can't run on long past a stop. */
export const LOGIN_TTL_S = 4 * 3600;
/** New relay logins per day for all of Hopp. */
export const LOGINS_PER_DAY = 500;
/** Usage is read from Cloudflare at most this often… */
export const USAGE_FRESH_MS = 15 * 60_000;
/** …and an older reading than this isn't trusted to hand out logins. */
export const USAGE_TRUSTED_MS = 60 * 60_000;

/** A secret as pasted, without stray spaces or line breaks around it. */
function secret(value: string | undefined): string {
  return (value ?? "").trim();
}

export function budgetBytes(env: Env): number {
  const gb = Number(env.RELAY_BUDGET_GB ?? DEFAULT_BUDGET_GB);
  return (Number.isFinite(gb) && gb > 0 ? Math.min(gb, 950) : DEFAULT_BUDGET_GB) * 1e9;
}

export function relayConfigured(env: Env): boolean {
  return !!(env.TURN_KEY_ID && env.TURN_KEY_TOKEN && env.CF_ACCOUNT_ID && env.CF_ANALYTICS_TOKEN);
}

/** This month's relay traffic so far (bytes sent and received), from Cloudflare's analytics. */
export async function monthUsage(env: Env, now = new Date()): Promise<number> {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const from = day(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const query = `query relayUsage($accountId: string!, $from: Date!, $to: Date!) {
    viewer { accounts(filter: { accountTag: $accountId }) {
      callsTurnUsageAdaptiveGroups(limit: 1, filter: { date_geq: $from, date_leq: $to }) { sum { egressBytes ingressBytes } }
    } }
  }`;
  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${secret(env.CF_ANALYTICS_TOKEN)}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { accountId: secret(env.CF_ACCOUNT_ID), from, to: day(now) } }),
  });
  if (!res.ok) throw new Error(`analytics answered ${res.status}`);
  const body = (await res.json()) as {
    errors?: { message: string }[] | null;
    data?: { viewer?: { accounts?: { callsTurnUsageAdaptiveGroups?: { sum?: { egressBytes?: number; ingressBytes?: number } }[] }[] } };
  };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join("; "));
  const groups = body.data?.viewer?.accounts?.[0]?.callsTurnUsageAdaptiveGroups;
  if (!Array.isArray(groups)) throw new Error("analytics sent no usage");
  // Count both directions, to stay on the safe side of what's billed.
  return groups.reduce((n, g) => n + Number(g.sum?.egressBytes ?? 0) + Number(g.sum?.ingressBytes ?? 0), 0);
}

/** A login for the relay from Cloudflare (UDP), or null. */
export async function newLogin(env: Env): Promise<TurnLogin | null> {
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${secret(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret(env.TURN_KEY_TOKEN)}`, "content-type": "application/json" },
    body: JSON.stringify({ ttl: LOGIN_TTL_S }),
  });
  if (!res.ok) {
    console.error("relay login refused by Cloudflare:", res.status, (await res.text()).slice(0, 200));
    return null;
  }
  const body = (await res.json()) as { iceServers?: unknown };
  const servers = (Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers]) as { urls?: string | string[]; username?: string; credential?: string }[];
  for (const s of servers) {
    const urls = Array.isArray(s?.urls) ? s.urls : s?.urls ? [s.urls] : [];
    // Voice goes over UDP: "turn:host:port?transport=udp".
    const url = urls.find((u) => /^turn:/.test(u) && /transport=udp/.test(u)) ?? urls.find((u) => /^turn:[^?]+$/.test(u));
    const server = url?.replace(/^turn:/, "").replace(/\?.*$/, "");
    if (server && s.username && s.credential) return { server, username: s.username, credential: s.credential };
  }
  return null;
}

export async function revoke(env: Env, username: string): Promise<void> {
  await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${secret(env.TURN_KEY_ID)}/credentials/${encodeURIComponent(username)}/revoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret(env.TURN_KEY_TOKEN)}` },
  }).catch(() => {});
}
