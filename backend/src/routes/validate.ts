import type { Context } from "hono";
import type { z } from "zod";
import { httpError } from "../lib/util";

/** Parse and validate a JSON body, answering 422 with a readable message on failure. */
export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
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
