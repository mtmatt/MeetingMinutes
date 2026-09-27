import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { migrate } from "../src/db";
import { migrations } from "../src/db/migrations";

// Upgrades of an existing database, on a separate in-memory database.
describe("migration of existing invitations", () => {
  test("links used before the upgrade count as used once, by the same person", () => {
    const db = new Database(":memory:", { strict: true });
    db.exec("PRAGMA foreign_keys = ON;");
    // Schema as it was before invitation limits.
    const before = migrations.length - 1;
    for (let i = 0; i < before; i++) db.exec(migrations[i]!);
    db.exec(`PRAGMA user_version = ${before}`);
    const t = Date.now();
    db.query("INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at) VALUES ('u1', 'old', 'Old', 'x', 'member', $t, $t)").run({ t });
    db.query("INSERT INTO invites (id, token_hash, kind, role, created_at, expires_at, used_at, used_by) VALUES ('used', 'h1', 'invite', 'member', $t, $e, $t, 'u1')").run({ t, e: t + 1000 });
    db.query("INSERT INTO invites (id, token_hash, kind, role, created_at, expires_at) VALUES ('open', 'h2', 'invite', 'member', $t, $e)").run({ t, e: t + 1000 });

    migrate(db);

    const rows = db.query<any, []>("SELECT id, max_uses, use_count, revoked_at FROM invites ORDER BY id").all();
    expect(rows).toEqual([
      { id: "open", max_uses: 1, use_count: 0, revoked_at: null },
      { id: "used", max_uses: 1, use_count: 1, revoked_at: null },
    ]);
    expect(db.query<any, []>("SELECT invite_id, user_id, used_at FROM invite_uses").all()).toEqual([{ invite_id: "used", user_id: "u1", used_at: t }]);
  });
});
