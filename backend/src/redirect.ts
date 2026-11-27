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
  // One leading slash: "//evil.example/x" resolved as a URL would name another site.
  const path = "/" + url.pathname.replace(/^[/\\]+/, "");
  return new URL(publicUrl).origin + path + url.search;
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

// ------------------------------------------------------------------ handoff

/**
 * The old port while the site moves (REDIRECT_PORT_MODE=handoff). A page
 * request gets a tiny page instead of the site: its script looks for
 * recordings this browser still holds at this address (they live in its
 * IndexedDB, which the new address cannot read). None, the usual case: it goes
 * to the same page at the new address at once, without loading the site here.
 * Some: it sets a session cookie and reloads, and with that cookie the old port
 * serves the site, whose banner asks for them to be uploaded first. The cookie
 * is cleared when the page finally moves. Everything else (the API, assets,
 * the worker API) is served as on the main port.
 */
export const HANDOFF_COOKIE = "mm_handoff";

/** A navigation to a page of the app (not the API, an asset or a file). */
function isPageRequest(req: Request, path: string): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (/^\/(api|internal|assets)\//.test(path) || path === "/healthz") return false;
  // Files (favicon.svg, robots.txt) are served as they are.
  if (/\.[a-z0-9]{1,8}$/i.test(path)) return false;
  return (req.headers.get("accept") ?? "").includes("text/html") || req.headers.get("sec-fetch-dest") === "document";
}

function staying(req: Request): boolean {
  return (req.headers.get("cookie") ?? "").split(/;\s*/).some((c) => c === `${HANDOFF_COOKIE}=stay`);
}

export function handoffScript(target: string): string {
  // Plain ES5, no app code: it runs before anything else loads.
  return `(function () {
  var target = ${JSON.stringify(target)};
  var done = false;
  function go() {
    if (done) return; done = true;
    location.replace(target + location.pathname + location.search + location.hash);
  }
  function stay() {
    if (done) return; done = true;
    document.cookie = "${HANDOFF_COOKIE}=stay; Path=/; Secure; SameSite=Lax";
    location.reload();
  }
  // Storage that does not answer: let the site itself look.
  setTimeout(stay, 4000);
  try {
    var req = indexedDB.open("mm-recordings");
    // No recordings were ever kept here: do not create the database (an empty one would lack its stores).
    req.onupgradeneeded = function () { req.transaction.abort(); };
    req.onerror = function () { go(); };
    req.onblocked = function () { stay(); };
    req.onsuccess = function () {
      var db = req.result;
      if (!db.objectStoreNames.contains("meta")) { db.close(); return go(); }
      var count = db.transaction("meta", "readonly").objectStore("meta").count();
      count.onsuccess = function () { db.close(); count.result > 0 ? stay() : go(); };
      count.onerror = function () { db.close(); stay(); };
    };
  } catch (e) {
    go();
  }
})();
`;
}

/** The page, with its script inline (one round trip less than fetching it), allowed by its hash alone. */
function handoffPage(target: string, script: string): string {
  const href = target.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Minutes</title>
<script>${script}</script></head>
<body style="font-family: system-ui, sans-serif; margin: 2rem; color: #888">
<p>Minutes &rarr; <a href="${href}">${href.replace(/^https:\/\//, "")}</a></p>
</body></html>
`;
}

export function handoffHandler(opts: {
  app: { fetch: (req: Request, env: unknown) => Response | Promise<Response> };
  publicUrl?: string;
  allowedHosts?: string[];
}) {
  const target = new URL(opts.publicUrl ?? config.publicUrl).origin;
  const allowed = opts.allowedHosts ?? config.allowedHosts;
  const script = handoffScript(target);
  const page = handoffPage(target, script);
  const scriptHash = new Bun.CryptoHasher("sha256").update(script).digest("base64");
  return (req: Request, server: unknown): Response | Promise<Response> => {
    const url = new URL(req.url);
    const host = hostOf(req);
    const known = !allowed.length || (host && (allowed.includes(host) || LOOPBACK.has(host)));
    if (known && isPageRequest(req, url.pathname) && !staying(req)) {
      return new Response(req.method === "HEAD" ? null : page, {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'`,
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "same-origin",
        },
      });
    }
    // The site itself (its own host check refuses other names).
    return opts.app.fetch(req, { server });
  };
}
