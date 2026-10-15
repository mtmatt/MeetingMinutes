import type { CSSProperties, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TFn } from "../i18n";
import { dateTime, duration } from "./format";
import { linkTimestamps, nameColon, stamp, transcriptRuns, type SummaryExport } from "./summaryExport";

/*
 * Export to Google Docs.
 *
 * With GOOGLE_CLIENT_ID configured, the browser asks Google for a token that
 * can only touch files this site creates (drive.file), and uploads the summary
 * as HTML, which Drive converts into a Google Doc. The token stays in this
 * tab's memory; the server never sees it. Without a client ID, the formatted
 * summary is copied instead, ready to paste into a new Google Doc.
 */

const DRIVE_FILE = "https://www.googleapis.com/auth/drive.file";
const GOOGLE_SIGN_IN_SCRIPT = "https://accounts.google.com/gsi/client";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink";
const GOOGLE_DOC = "application/vnd.google-apps.document";
/** Opens a new, empty Google Doc. */
export const NEW_GOOGLE_DOC = "https://docs.new";

export type GoogleDocsFailure =
  /** The person closed the sign-in window: not an error worth reporting. */
  | "canceled"
  | "popup_blocked"
  | "denied"
  | "unreachable"
  | "expired"
  | "drive_api_off"
  | "drive";

export class GoogleDocsError extends Error {
  constructor(
    readonly reason: GoogleDocsFailure,
    message: string = reason,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------ the document

const cell: CSSProperties = { border: "1px solid #b7b7b7", padding: "4px 8px", verticalAlign: "top" };

/** The summary as Google Docs should show it: a title, the meeting details, the summary, and optionally the transcript. */
function SummaryDocument({ x, t }: { x: SummaryExport; t: TFn }) {
  const { meeting, summary, locale } = x;
  const page = `${window.location.origin}/m/${encodeURIComponent(meeting.id)}`;
  // Timestamps open the recording at that moment (the meeting page reads ?t=).
  const at = (sec: number) => `${page}?t=${Math.floor(sec)}`;
  const listSep = locale === "zh-TW" ? "、" : ", ";
  const colon = nameColon(locale);
  const details: [string, ReactNode][] = [[t("summary.docDate"), dateTime(meeting.occurredAt ?? meeting.createdAt, locale)]];
  if (meeting.durationSec != null) details.push([t("summary.docLength"), duration(meeting.durationSec, locale)]);
  if (meeting.speakers.length) details.push([t("summary.docSpeakers"), meeting.speakers.map((s) => s.name).join(listSep)]);
  details.push(
    [
      t("summary.docSummary"),
      t("summary.docSummaryOf", {
        template: x.templateLabel,
        n: x.version,
        when: dateTime(summary.finishedAt ?? summary.createdAt, locale),
      }),
    ],
    [t("summary.docRecording"), <a href={page}>{t("summary.docOpenRecording")}</a>],
  );
  return (
    <>
      <h1>{meeting.title}</h1>
      <p>
        {details.map(([label, value], i) => (
          <span key={i}>
            {i > 0 && <br />}
            <b>
              {label}
              {colon}
            </b>
            {value}
          </span>
        ))}
      </p>
      <hr />
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            return <a href={href?.startsWith("#t=") ? at(Number(href.slice(3))) : href}>{children}</a>;
          },
          table({ children }) {
            return <table style={{ borderCollapse: "collapse" }}>{children}</table>;
          },
          th({ children }) {
            return <th style={{ ...cell, textAlign: "left" }}>{children}</th>;
          },
          td({ children }) {
            return <td style={cell}>{children}</td>;
          },
        }}
      >
        {linkTimestamps(summary.content ?? "", meeting.durationSec ?? 0)}
      </ReactMarkdown>
      {x.withTranscript && meeting.segments.length > 0 && (
        <>
          <hr />
          <h2>{x.transcriptHeading}</h2>
          {transcriptRuns(meeting).map((r, i) => (
            <p key={i}>
              <b>
                <a href={at(r.start)}>[{stamp(r.start)}]</a>
                {r.who ? ` ${r.who}` : ""}
                {colon}
              </b>
              {r.text}
            </p>
          ))}
        </>
      )}
    </>
  );
}

/** The document body as HTML, rendered with the same Markdown reader as the app. */
function documentBody(x: SummaryExport, t: TFn): string {
  const el = document.createElement("div");
  const root = createRoot(el);
  flushSync(() => root.render(<SummaryDocument x={x} t={t} />));
  const html = el.innerHTML;
  root.unmount();
  return html;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** A complete HTML page for Drive to convert, and the bare body for the clipboard. */
export function summaryDocument(x: SummaryExport, t: TFn): { page: string; body: string } {
  const body = documentBody(x, t);
  const lang = x.locale === "zh-TW" ? "zh-Hant-TW" : "en";
  const page =
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${escapeHtml(x.meeting.title)}</title></head>` +
    `<body>${body}</body></html>`;
  return { page, body };
}

// ------------------------------------------------- Google sign-in and Drive

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
}

interface GoogleOAuth {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    callback: (r: TokenResponse) => void;
    error_callback?: (e: { type: string }) => void;
  }): { requestAccessToken(overrides?: { prompt?: string }): void };
  hasGrantedAllScopes(r: TokenResponse, scope: string): boolean;
}

declare global {
  interface Window {
    google?: { accounts?: { oauth2?: GoogleOAuth } };
  }
}

const oauth = () => window.google?.accounts?.oauth2;

let loading: Promise<void> | null = null;

/**
 * Load Google's sign-in script. Called when an export menu opens, so the
 * script is ready by the time an item is clicked: the sign-in window must open
 * straight from the click, or the browser blocks it.
 */
export function loadGoogleSignIn(): Promise<void> {
  if (oauth()) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GOOGLE_SIGN_IN_SCRIPT;
    script.async = true;
    script.onload = () => (oauth() ? resolve() : reject(new GoogleDocsError("unreachable")));
    script.onerror = () => reject(new GoogleDocsError("unreachable"));
    document.head.appendChild(script);
  }).catch((e) => {
    // Let a later attempt try again (the network may be back).
    loading = null;
    throw e;
  });
  return loading;
}

/** The token from the last sign-in, reused until shortly before it expires. */
let cached: { clientId: string; token: string; expiresAt: number } | null = null;

/**
 * A Drive token for files this site creates. Opens Google's sign-in window
 * unless a token from earlier in this tab is still valid; call it directly
 * from a click.
 */
function driveToken(clientId: string): Promise<string> {
  if (cached && cached.clientId === clientId && cached.expiresAt > Date.now() + 60_000) return Promise.resolve(cached.token);
  const google = oauth();
  if (!google) return Promise.reject(new GoogleDocsError("unreachable"));
  return new Promise<string>((resolve, reject) => {
    const client = google.initTokenClient({
      client_id: clientId,
      scope: DRIVE_FILE,
      callback: (r) => {
        if (r.error || !r.access_token) {
          reject(new GoogleDocsError(r.error === "access_denied" ? "denied" : "drive", r.error_description || r.error || "no token"));
        } else if (!google.hasGrantedAllScopes(r, DRIVE_FILE)) {
          // The consent screen lets people untick the Drive permission.
          reject(new GoogleDocsError("denied"));
        } else {
          cached = { clientId, token: r.access_token, expiresAt: Date.now() + Number(r.expires_in ?? 3600) * 1000 };
          resolve(r.access_token);
        }
      },
      error_callback: (e) =>
        reject(new GoogleDocsError(e.type === "popup_closed" ? "canceled" : e.type === "popup_failed_to_open" ? "popup_blocked" : "unreachable")),
    });
    client.requestAccessToken();
  });
}

/** Upload HTML that Drive converts into a new Google Doc; returns the document's address. */
async function createDoc(token: string, name: string, html: string): Promise<string> {
  const boundary = `minutes-${crypto.randomUUID()}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify({ name, mimeType: GOOGLE_DOC }),
    `\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n`,
    html,
    `\r\n--${boundary}--\r\n`,
  ]);
  let res: Response;
  try {
    res = await fetch(UPLOAD, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
  } catch {
    throw new GoogleDocsError("unreachable");
  }
  if (res.status === 401) {
    // Revoked or expired early: the next export signs in again.
    cached = null;
    throw new GoogleDocsError("expired");
  }
  const data = (await res.json().catch(() => ({}))) as {
    id?: string;
    webViewLink?: string;
    error?: { message?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] };
  };
  if (!res.ok || !data.id) {
    const reasons = [...(data.error?.errors ?? []), ...(data.error?.details ?? [])].map((e) => e.reason);
    if (reasons.includes("accessNotConfigured") || reasons.includes("SERVICE_DISABLED")) throw new GoogleDocsError("drive_api_off");
    throw new GoogleDocsError("drive", data.error?.message || `HTTP ${res.status}`);
  }
  return data.webViewLink ?? `https://docs.google.com/document/d/${data.id}/edit`;
}

/**
 * Create a Google Doc in the person's Drive. Must be called from a click
 * (before any await), because it may open Google's sign-in window.
 */
export async function exportToGoogleDocs(clientId: string, name: string, html: string, onSignedIn?: () => void): Promise<string> {
  let token: Promise<string>;
  if (oauth()) token = driveToken(clientId);
  else {
    // Not loaded yet (the menu was clicked very quickly): the browser may block
    // the sign-in window now, in which case a second click works.
    await loadGoogleSignIn();
    token = driveToken(clientId);
  }
  const signedIn = await token;
  onSignedIn?.();
  return createDoc(signedIn, name, html);
}

// --------------------------------------------------------------- clipboard

/** Copy rich text (pasted with headings, lists and links) with a plain-text fallback. */
export async function copyRichText(html: string, text: string): Promise<void> {
  try {
    if (typeof ClipboardItem === "undefined") throw new Error("ClipboardItem unsupported");
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([text], { type: "text/plain" }),
      }),
    ]);
  } catch {
    // Older browsers: copy a selection of the rendered HTML instead.
    const holder = document.createElement("div");
    holder.innerHTML = html;
    holder.setAttribute("aria-hidden", "true");
    Object.assign(holder.style, { position: "fixed", left: "-10000px", top: "0", whiteSpace: "pre-wrap" });
    document.body.appendChild(holder);
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(holder);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const ok = document.execCommand("copy");
    selection?.removeAllRanges();
    holder.remove();
    if (!ok) throw new Error("copy failed");
  }
}
