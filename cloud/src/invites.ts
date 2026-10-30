// The global invite register: short codes like K7P2QX9M point to the server
// they belong to, so invite links don't have to carry the long server id.
// One instance (named "global") serves every server.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

export class InviteIndex extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS invites (code TEXT PRIMARY KEY, server TEXT NOT NULL, expires_at INTEGER)");
  }

  /** Claims a code for a server. False if another server already has it. */
  register(code: string, server: string, expiresAt: number | null): boolean {
    this.sql.exec("DELETE FROM invites WHERE expires_at IS NOT NULL AND expires_at < ?", Date.now());
    const taken = this.sql.exec("SELECT server FROM invites WHERE code = ?", code).toArray()[0];
    if (taken) return false;
    this.sql.exec("INSERT INTO invites (code, server, expires_at) VALUES (?, ?, ?)", code, server, expiresAt);
    return true;
  }

  lookup(code: string): string | null {
    const row = this.sql.exec("SELECT server, expires_at FROM invites WHERE code = ?", code).toArray()[0];
    if (!row || (row.expires_at !== null && Number(row.expires_at) < Date.now())) return null;
    return String(row.server);
  }

  remove(code: string) {
    this.sql.exec("DELETE FROM invites WHERE code = ?", code);
  }
}

export function inviteIndex(env: Env) {
  return env.INVITES.get(env.INVITES.idFromName("global"));
}
