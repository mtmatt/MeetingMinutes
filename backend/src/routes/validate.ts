import type { Context } from "hono";
import type { z } from "zod";
import { httpError } from "../lib/util";

/** Most JSON a signed-in person sends at once: an edited summary (500,000 characters) fits several times over. */
export const JSON_LIMIT_BYTES = 4 * 1024 * 1024;
/**
 * For requests that anyone can send (signing in, first-run setup, accepting an
 * invitation, enrolling a worker) and for the workers' small messages: a few
 * short fields. Without it each such request could make the server buffer and
 * parse as much as one upload chunk (UPLOAD_CHUNK_MB) before it is even looked at.
 */
export const SMALL_JSON_LIMIT_BYTES = 64 * 1024;

/** The request body as text, refusing (413) as soon as it is known to be longer than `maxBytes`. */
async function readText(c: Context, maxBytes: number): Promise<string> {
  const tooLarge = () => httpError(413, "The request is too large.", "too_large");
  const declared = Number(c.req.header("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) tooLarge();
  const stream = c.req.raw.body;
  if (!stream) return "";
  // The length a client declares is its own claim (and absent with chunked encoding): count what arrives.
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      tooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Parse and validate a JSON body, answering 422 with a readable message on
 * failure, and 413 when it is longer than `maxBytes`.
 */
export async function body<T extends z.ZodType>(c: Context, schema: T, maxBytes: number = JSON_LIMIT_BYTES): Promise<z.infer<T>> {
  const text = await readText(c, maxBytes);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    httpError(400, "Request body must be JSON.", "bad_json");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    httpError(422, `${where}${issue?.message ?? "Invalid input."}`, "invalid_input");
  }
  return parsed.data;
}
