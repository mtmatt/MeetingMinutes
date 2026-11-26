import { config, normalizeHost } from "./config";

/**
 * Listeners that only send people to the site's address (PUBLIC_URL), keeping
 * the path and query: the HTTPS port the site used before (8443 after moving
 * to 443), and plain HTTP on port 80. A request for another host name (the
 * bare IP address, a scanner's guess) is refused as on the main port.
 *
 * On the old HTTPS port the worker API (/internal/) is still served, not
 * redirected: workers enrolled with the old address post their results there,
 * and a redirect would drop the body. Over plain HTTP nothing is served.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

function hostOf(req: Request): string | null {
  const raw = req.headers.get("host");
  if (!raw) return null;
  try {
    return normalizeHost(new URL(`http://${raw}`).hostname);
  } catch {
    return null;
  }
}

/** Where a request on a redirecting port is sent: PUBLIC_URL with the same path and query. */
export function redirectLocation(publicUrl: string, req: Request): string {
  const url = new URL(req.url);
  return new URL(url.pathname + url.search, publicUrl.replace(/\/+$/, "") + "/").toString();
}

export function redirectHandler(opts: {
  serveWorkerApi: boolean;
  app: { fetch: (req: Request, env: unknown) => Response | Promise<Response> };
  publicUrl?: string;
  allowedHosts?: string[];
}) {
  const publicUrl = opts.publicUrl ?? config.publicUrl;
  const allowed = opts.allowedHosts ?? config.allowedHosts;
  return (req: Request, server: unknown): Response | Promise<Response> => {
    const host = hostOf(req);
    if (allowed.length && !(host && (allowed.includes(host) || LOOPBACK.has(host)))) {
      return new Response("Misdirected request.\n", { status: 421, headers: { "Content-Type": "text/plain; charset=utf-8", Connection: "close" } });
    }
    const path = new URL(req.url).pathname;
    if (opts.serveWorkerApi && (path.startsWith("/internal/") || path === "/healthz")) return opts.app.fetch(req, { server });
    return new Response(null, {
      // Permanent, and the method and body are kept; cached for a day only, so a change of mind is not stuck in browsers.
      status: 308,
      headers: { Location: redirectLocation(publicUrl, req), "Cache-Control": "public, max-age=86400" },
    });
  };
}

/** What to tell someone whose port could not be opened. */
export function bindHelp(port: number, e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  if (port < 1024 && (code === "EACCES" || /permission|EACCES/i.test(String(e)))) {
    return [
      `Port ${port} is below 1024, which this user may not open. Allow unprivileged users to open ports from ${port} up, once, as root:`,
      `  echo 'net.ipv4.ip_unprivileged_port_start=${port}' | sudo tee /etc/sysctl.d/60-meetingminutes-ports.conf && sudo sysctl --system`,
      `(or keep the site on a port above 1024, such as 8443).`,
    ].join("\n");
  }
  if (code === "EADDRINUSE" || /in use/i.test(String(e))) return `Port ${port} is already in use by another program (see: sudo ss -ltnp 'sport = :${port}').`;
  return `Could not open port ${port}: ${e instanceof Error ? e.message : String(e)}`;
}
