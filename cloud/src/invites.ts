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
    // Servers on people's own computers: their name and key, so a short link can show and reach them.
    const columns = new Set(this.sql.exec("PRAGMA table_info(invites)").toArray().map((c) => String(c.name)));
    if (!columns.has("name")) this.sql.exec("ALTER TABLE invites ADD COLUMN name TEXT");
    if (!columns.has("pin")) this.sql.exec("ALTER TABLE invites ADD COLUMN pin TEXT");
  }

  /** A server on someone's computer claims a code for one of its invites (reached through its tunnel). */
  registerHosted(code: string, tunnel: string, pin: string, name: string, expiresAt: number | null): boolean {
    this.sql.exec("DELETE FROM invites WHERE expires_at IS NOT NULL AND expires_at < ?", Date.now());
    const taken = this.sql.exec("SELECT server FROM invites WHERE code = ?", code).toArray()[0];
    if (taken && taken.server !== `tunnel:${tunnel}`) return false;
    this.sql.exec("INSERT OR REPLACE INTO invites (code, server, expires_at, name, pin) VALUES (?, ?, ?, ?, ?)", code, `tunnel:${tunnel}`, expiresAt, name, pin);
    return true;
  }

  /** What a code leads to: a Hopp Cloud server's id, or a server on someone's computer. */
  find(code: string): { server: string; name: string | null; pin: string | null } | null {
    const row = this.sql.exec("SELECT server, expires_at, name, pin FROM invites WHERE code = ?", code).toArray()[0];
    if (!row || (row.expires_at !== null && Number(row.expires_at) < Date.now())) return null;
    return { server: String(row.server), name: row.name == null ? null : String(row.name), pin: row.pin == null ? null : String(row.pin) };
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
