import { existsSync, statSync } from "node:fs";
import { httpError } from "./util";

/**
 * A file as an HTTP response, with byte ranges (seeking in the player, resuming
 * a worker's download). `downloadName` makes it an attachment.
 */
export function serveFile(c: any, path: string, mime: string, downloadName?: string) {
  if (!existsSync(path)) httpError(404, "Media not available.", "not_found");
  const size = statSync(path).size;
  const headers: Record<string, string> = {
    "Content-Type": mime,
    // Media is never interpreted as anything else, even by old browsers.
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  };
  if (downloadName) {
    headers["Content-Disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  }
  const range = c.req.header("range") as string | undefined;
  const file = Bun.file(path);
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match || (!match[1] && !match[2])) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    let start: number;
    let end: number;
    if (!match[1]) {
      const suffix = Number(match[2]);
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    }
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    headers["Content-Length"] = String(end - start + 1);
    return new Response(file.slice(start, end + 1), { status: 206, headers });
  }
  headers["Content-Length"] = String(size);
  return new Response(file, { status: 200, headers });
}
