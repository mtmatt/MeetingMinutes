import { describe, expect, test } from "bun:test";
import { adminClient, memberClient } from "./helpers";

const options = { language: "Chinese", diarize: true, numSpeakers: null, minSpeakers: 2, maxSpeakers: 6, vocabulary: "NTU COOL、資工系、群組", script: "zh-TW" };
const summary = { templateId: "builtin-minutes", prompt: "Write minutes.", outputLanguage: "zh-TW" };

describe("presets for adding a recording", () => {
  test("a person keeps named presets; one at most is the default", async () => {
    const c = await memberClient("preset-owner");
    expect(((await (await c.get("/api/presets")).json()) as any).presets).toEqual([]);

    const first = await c.post("/api/presets", { name: "課程專題", options, summary, isDefault: true });
    expect(first.status).toBe(201);
    const a = ((await first.json()) as any).preset;
    expect(a).toMatchObject({ name: "課程專題", isDefault: true, summary, options: { vocabulary: "NTU COOL、資工系、群組", language: "Chinese", minSpeakers: 2 } });

    // No automatic summary in this one; options left out fall back to the defaults.
    const second = ((await (await c.post("/api/presets", { name: "週會", options: { vocabulary: "OKR" }, summary: null })).json()) as any);
    expect(second.preset).toMatchObject({ isDefault: false, summary: null, options: { language: "auto", diarize: true, script: "zh-TW", vocabulary: "OKR" } });
    // The default comes first.
    expect(second.presets.map((p: any) => p.name)).toEqual(["課程專題", "週會"]);

    // Making another the default takes it from the first.
    const moved = ((await (await c.req("PUT", `/api/presets/${second.preset.id}`, { json: { ...second.preset, isDefault: true } })).json()) as any);
    expect(moved.presets.map((p: any) => [p.name, p.isDefault])).toEqual([["週會", true], ["課程專題", false]]);

    // Names are unique per person, and checked.
    expect((await c.post("/api/presets", { name: "週會", options, summary: null })).status).toBe(409);
    expect((await c.req("PUT", `/api/presets/${a.id}`, { json: { name: "週會", options, summary } })).status).toBe(409);
    expect((await c.post("/api/presets", { name: "  ", options, summary: null })).status).toBe(422);
    expect((await c.post("/api/presets", { name: "x", options: { ...options, numSpeakers: 99 }, summary: null })).status).toBe(422);
    expect((await c.post("/api/presets", { name: "y", options: { ...options, script: "klingon" }, summary: null })).status).toBe(422);

    // Someone else neither sees nor changes them.
    const other = await adminClient();
    expect(((await (await other.get("/api/presets")).json()) as any).presets.map((p: any) => p.id)).not.toContain(a.id);
    expect((await other.req("PUT", `/api/presets/${a.id}`, { json: { name: "mine", options, summary: null } })).status).toBe(404);
    expect((await other.del(`/api/presets/${a.id}`)).status).toBe(404);

    const left = ((await (await c.del(`/api/presets/${a.id}`)).json()) as any).presets;
    expect(left.map((p: any) => p.name)).toEqual(["週會"]);
  });

  test("a person may keep up to 30", async () => {
    const c = await memberClient("preset-hoarder");
    for (let i = 0; i < 30; i++) expect((await c.post("/api/presets", { name: `p${i}`, options: {}, summary: null })).status).toBe(201);
    const full = await c.post("/api/presets", { name: "one more", options: {}, summary: null });
    expect(full.status).toBe(409);
    expect(((await full.json()) as any).code).toBe("limit");
  });
});
