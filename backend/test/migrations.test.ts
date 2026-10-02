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
    const before = migrations.findIndex((m) => m.includes("CREATE TABLE invite_uses"));
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

describe("migration of existing summaries", () => {
  test("finished summaries are taken to use the meeting's current speaker names", () => {
    const db = new Database(":memory:", { strict: true });
    db.exec("PRAGMA foreign_keys = ON;");
    const before = migrations.findIndex((m) => m.includes("ADD COLUMN speaker_names"));
    for (let i = 0; i < before; i++) db.exec(migrations[i]!);
    db.exec(`PRAGMA user_version = ${before}`);
    const t = Date.now();
    db.query("INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at) VALUES ('u1', 'old', 'Old', 'x', 'member', $t, $t)").run({ t });
    for (const id of ["m1", "m2"]) {
      db.query(
        `INSERT INTO meetings (id, owner_id, title, status, media_name, media_mime, media_size, media_ext, created_at, updated_at)
         VALUES ($id, 'u1', 'M', 'ready', 'a.wav', 'audio/wav', 1, 'wav', $t, $t)`,
      ).run({ id, t });
    }
    db.query("INSERT INTO speakers (meeting_id, key, name, color) VALUES ('m1', 'SPEAKER_00', 'Alice', 0), ('m1', 'SPEAKER_01', 'Speaker 1', 1)").run();
    const summary = (id: string, m: string, status: string, content: string | null) =>
      db
        .query("INSERT INTO summaries (id, meeting_id, prompt, output_language, status, content, created_at) VALUES ($id, $m, 'p', 'zh-TW', $s, $c, $t)")
        .run({ id, m, s: status, c: content, t });
    summary("done", "m1", "done", "Alice and Speaker 1");
    summary("queued", "m1", "queued", null);
    summary("nospeakers", "m2", "done", "text");

    migrate(db);

    const names = Object.fromEntries(
      db.query<{ id: string; speaker_names: string | null }, []>("SELECT id, speaker_names FROM summaries").all().map((r) => [r.id, r.speaker_names]),
    );
    expect(JSON.parse(names.done!)).toEqual({ SPEAKER_00: "Alice", SPEAKER_01: "Speaker 1" });
    expect(names.queued).toBeNull();
    expect(JSON.parse(names.nospeakers!)).toEqual({});
  });
});
