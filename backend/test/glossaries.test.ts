import { describe, expect, test } from "bun:test";
import { normalizeTerms } from "../src/routes/glossaries";
import { memberClient } from "./helpers";

describe("term lists", () => {
  test("terms are kept one to a line, whatever they were typed with, without repeats", () => {
    expect(normalizeTerms("NTU COOL, IR，multimodel、多模態\n明希;  信件 ; ntu cool\n\n")).toBe("NTU COOL\nIR\nmultimodel\n多模態\n明希\n信件");
  });

  test("a person creates, lists, edits and deletes their own lists; others cannot see them", async () => {
    const c = await memberClient("glossary-owner");
    let res = await c.post("/api/glossaries", { name: "課程", terms: "NTU COOL, IR, 多模態" });
    expect(res.status).toBe(201);
    const { glossary } = (await res.json()) as any;
    expect(glossary).toMatchObject({ name: "課程", terms: ["NTU COOL", "IR", "多模態"] });

    expect((await c.post("/api/glossaries", { name: "空的", terms: " , \n" })).status).toBe(422);
    expect((await c.post("/api/glossaries", { name: "太長", terms: "字".repeat(2001) })).status).toBe(422);

    res = await c.req("PUT", `/api/glossaries/${glossary.id}`, { json: { name: "課程名詞", terms: "NTU COOL\n明希" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).glossary).toMatchObject({ name: "課程名詞", terms: ["NTU COOL", "明希"] });

    const other = await memberClient("glossary-other");
    expect(((await (await other.get("/api/glossaries")).json()) as any).glossaries).toEqual([]);
    expect((await other.req("PUT", `/api/glossaries/${glossary.id}`, { json: { name: "x", terms: "y" } })).status).toBe(404);
    expect((await other.del(`/api/glossaries/${glossary.id}`)).status).toBe(404);

    const list = ((await (await c.get("/api/glossaries")).json()) as any).glossaries;
    expect(list.map((g: any) => g.name)).toEqual(["課程名詞"]);
    expect((await c.del(`/api/glossaries/${glossary.id}`)).status).toBe(200);
    expect(((await (await c.get("/api/glossaries")).json()) as any).glossaries).toEqual([]);
  });
});
