import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gzipSync } from "node:zlib";
import { staticFile } from "../src/app";
import { adminClient } from "./helpers";

describe("built files", () => {
  const dir = mkdtempSync(join(tmpdir(), "mm-static-"));
  const js = join(dir, "app.js");
  const source = "export const x = 1;\n".repeat(200);
  writeFileSync(js, source);
  writeFileSync(js + ".br", brotliCompressSync(source));
  writeFileSync(js + ".gz", gzipSync(source));
  const plain = join(dir, "only.css");
  writeFileSync(plain, "body{}".repeat(300));

  test("the brotli copy goes to a browser that takes it", async () => {
    const res = staticFile(js, "gzip, deflate, br, zstd", "no-cache");
    expect(res.headers.get("content-encoding")).toBe("br");
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(brotliDecompressSync(Buffer.from(await res.arrayBuffer())).toString()).toBe(source);
  });

  test("gzip when brotli is not taken, refused or missing", async () => {
    expect(staticFile(js, "gzip", "no-cache").headers.get("content-encoding")).toBe("gzip");
    expect(staticFile(js, "br;q=0, gzip", "no-cache").headers.get("content-encoding")).toBe("gzip");
    expect(staticFile(js, "BR ; q=0.0 , GZIP", "no-cache").headers.get("content-encoding")).toBe("gzip");
  });

  test("the file as it is otherwise", async () => {
    for (const accept of [undefined, "", "identity", "br;q=0, gzip;q=0"]) {
      const res = staticFile(js, accept, "no-cache");
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(await res.text()).toBe(source);
    }
    // No compressed copy on disk (a build made without them).
    const res = staticFile(plain, "br, gzip", "no-cache", "text/css; charset=utf-8");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
  });
});

describe("API responses", () => {
  test("JSON is gzipped for a browser that takes it, plain otherwise", async () => {
    const admin = await adminClient();
    const zipped = await admin.req("GET", "/api/templates", { headers: { "accept-encoding": "gzip, deflate, br" } });
    expect(zipped.status).toBe(200);
    expect(zipped.headers.get("content-encoding")).toBe("gzip");
    expect(zipped.headers.get("vary")).toContain("Accept-Encoding");
    const body = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(await zipped.arrayBuffer()))));
    const plain = await admin.get("/api/templates");
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(body).toEqual(await plain.json());
  });

  test("the live event stream is never compressed (it would be held back)", async () => {
    const admin = await adminClient();
    const res = await admin.req("GET", "/api/events", { headers: { "accept-encoding": "gzip" } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("content-encoding")).toBeNull();
    await res.body?.cancel();
  });
});
