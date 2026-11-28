/**
 * UI check: opens every page and dialog of the site with sample data, at
 * phone, tablet and desktop widths, light and dark, both interfaces and both
 * languages, and looks for the mistakes a person would otherwise have to
 * spot: things sticking out of the screen or their box, labels breaking onto a
 * second line, a character alone on a line, controls hidden under others,
 * text over text, untranslated keys, broken images, poor contrast and small
 * tap targets (axe-core, WCAG 2.2 AA), and errors in the browser console.
 *
 *   bun run build && bun run uicheck            # everything
 *   bun run uicheck --only meeting               # screens whose name contains "meeting"
 *   bun run uicheck --variant zh-390 --variant zh-1366
 *
 * Writes uicheck/out/index.html (screenshots with each finding outlined and
 * numbered) and uicheck/out/report.json, and exits with 1 when anything is
 * found that uicheck/allow.json does not explain. See uicheck/README.md.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { SCREENS, type Screen, type ServerInfo } from "./screens";

const ROOT = resolve(import.meta.dir, "..");
const OUT = join(ROOT, "uicheck", "out");
const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const RULES = readFileSync(join(import.meta.dir, "rules.js"), "utf8").replace(/^\s*\/\/.*$/gm, "").trim().replace(/;$/, "");

export interface Variant {
  id: string;
  ui: "new" | "old";
  locale: "zh-TW" | "en";
  theme: "light" | "dark";
  width: number;
  height: number;
  mobile: boolean;
}
const VARIANTS: Variant[] = [
  { id: "zh-390", ui: "new", locale: "zh-TW", theme: "light", width: 390, height: 844, mobile: true },
  { id: "zh-768", ui: "new", locale: "zh-TW", theme: "light", width: 768, height: 1024, mobile: true },
  { id: "zh-1366", ui: "new", locale: "zh-TW", theme: "light", width: 1366, height: 860, mobile: false },
  { id: "dark-390", ui: "new", locale: "zh-TW", theme: "dark", width: 390, height: 844, mobile: true },
  { id: "dark-1366", ui: "new", locale: "zh-TW", theme: "dark", width: 1366, height: 860, mobile: false },
  { id: "en-390", ui: "new", locale: "en", theme: "light", width: 390, height: 844, mobile: true },
  { id: "en-1366", ui: "new", locale: "en", theme: "light", width: 1366, height: 860, mobile: false },
  { id: "old-390", ui: "old", locale: "zh-TW", theme: "light", width: 390, height: 844, mobile: true },
  { id: "old-1366", ui: "old", locale: "zh-TW", theme: "light", width: 1366, height: 860, mobile: false },
];

interface Finding {
  rule: string;
  selector: string;
  text: string;
  detail: string;
  box: { x: number; y: number; w: number; h: number } | null;
}
interface Result {
  screen: string;
  variant: string;
  shot: string | null;
  findings: (Finding & { n: number })[];
  allowed: (Finding & { reason: string })[];
  error?: string;
}
interface Allow {
  rule: string;
  screen?: string;
  variant?: string;
  selector?: string;
  text?: string;
  reason: string;
}

// ------------------------------------------------------------------ options

const args = process.argv.slice(2);
const only: string[] = [];
const wantVariants: string[] = [];
let axeOn = true;
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--only") only.push(args[++i] ?? "");
  else if (a === "--variant") wantVariants.push(args[++i] ?? "");
  else if (a === "--no-axe") axeOn = false;
  else if (a === "-h" || a === "--help") {
    console.log(readFileSync(import.meta.path, "utf8").split("*/")[0]!.replace(/^\/\*\*|^ \* ?/gm, ""));
    process.exit(0);
  } else {
    console.error(`unknown option: ${a}`);
    process.exit(2);
  }
}
const variants = wantVariants.length ? VARIANTS.filter((v) => wantVariants.includes(v.id)) : VARIANTS;
const screens = only.length ? SCREENS.filter((s) => only.some((o) => s.id.includes(o))) : SCREENS;
if (!variants.length || !screens.length) {
  console.error(`Nothing to check. Variants: ${VARIANTS.map((v) => v.id).join(", ")}. Screens: ${SCREENS.map((s) => s.id).join(", ")}.`);
  process.exit(2);
}
if (!existsSync(join(ROOT, "frontend", "dist", "index.html"))) {
  console.error("Build the web interface first: bun run build");
  process.exit(2);
}

const allowList: Allow[] = JSON.parse(readFileSync(join(import.meta.dir, "allow.json"), "utf8"));
const glob = (pattern: string | undefined, value: string) =>
  !pattern || new RegExp("^" + pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$").test(value);
function allowedBy(f: Finding, screen: string, variant: string): Allow | undefined {
  return allowList.find(
    (a) =>
      glob(a.rule, f.rule) &&
      glob(a.screen, screen) &&
      glob(a.variant, variant) &&
      (!a.selector || f.selector.includes(a.selector)) &&
      (!a.text || f.text.includes(a.text)),
  );
}

// ------------------------------------------------------------------ server

/** Three slide pictures, drawn in the browser, for the meetings' slides. */
async function makeSlides(browser: Browser): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "mm-uicheck-slides-"));
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const slides = [
    ["#1b3a6b", "#fff", "產品週會", "2026 年 11 月 · 第 48 週"],
    ["#f4f1ea", "#1b1b1b", "時程與里程碑", "整合測試 12/3 · 上線 12/10 · 回顧 12/17"],
    ["#0f5132", "#fff", "預算與風險", "雲端 GPU 費用另列 · 手機播放器版面"],
  ];
  for (const [i, [bg, fg, title, sub]] of slides.entries()) {
    await page.setContent(
      `<body style="margin:0;width:1280px;height:720px;background:${bg};color:${fg};font-family:sans-serif;display:grid;place-content:center;text-align:center">
       <h1 style="font-size:88px;margin:0">${title}</h1><p style="font-size:36px;opacity:.8">${sub}</p></body>`,
    );
    await page.screenshot({ path: join(dir, `slide-${i}.jpg`), type: "jpeg", quality: 70 });
  }
  await page.close();
  return dir;
}

async function startServer(slides: string): Promise<{ info: ServerInfo; stop: () => void }> {
  const port = 8790 + Math.floor(Math.random() * 400);
  const child = spawn("bun", [join(import.meta.dir, "server.ts"), String(port), slides], {
    cwd: ROOT,
    env: { ...process.env, UICHECK_VARIANTS: JSON.stringify(variants.map((v) => v.id.replace(/[^a-z0-9]/g, ""))) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const info = await new Promise<ServerInfo>((ok, fail) => {
    let buf = "";
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      const line = buf.split("\n").find((l) => l.startsWith('{"ready"'));
      if (line) ok(JSON.parse(line) as ServerInfo);
    });
    child.on("exit", (code) => fail(new Error(`the sample server stopped (${code})`)));
    setTimeout(() => fail(new Error("the sample server did not start within 60 s")), 60_000);
  });
  child.stdout.on("data", () => {});
  return { info, stop: () => child.kill() };
}

// ------------------------------------------------------------------ pages

const STILL = `*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important;
  transition-duration: 0s !important; transition-delay: 0s !important; caret-color: transparent !important; }`;

async function context(browser: Browser, base: string, v: Variant, as: Screen["as"], info: ServerInfo): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: { width: v.width, height: v.height },
    deviceScaleFactor: 1,
    isMobile: v.mobile && v.width < 500,
    hasTouch: v.mobile,
    colorScheme: v.theme,
    locale: v.locale === "en" ? "en-US" : "zh-TW",
    timezoneId: "Asia/Taipei",
  });
  await ctx.addInitScript((css: string) => {
    document.addEventListener("DOMContentLoaded", () => {
      const s = document.createElement("style");
      s.textContent = css;
      document.head.appendChild(s);
    });
  }, STILL);
  if (as !== "anon") {
    const H = { "content-type": "application/json", "x-mm-client": "1" };
    const account = info.accounts[v.id.replace(/[^a-z0-9]/g, "")]!;
    const username = as === "admin" ? account.admin : account.member;
    const login = await ctx.request.post(base + "/api/auth/login", { headers: H, data: { username, password: info.password } });
    if (!login.ok()) throw new Error(`sign-in as ${username} failed: ${login.status()}`);
    await ctx.request.patch(base + "/api/me", { headers: H, data: { newUi: v.ui === "new", theme: v.theme, locale: v.locale } });
  }
  return ctx;
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
}

async function check(page: Page): Promise<Finding[]> {
  const findings: Finding[] = await page.evaluate(`(${RULES})("all")`);
  if (axeOn) {
    // Evaluated, not added as a <script>: the site's CSP (kept on, as in production) blocks inline scripts.
    await page.evaluate(AXE);
    const violations = (await page.evaluate(async () => {
      // With a dialog or menu open, only it (the page under it is a screen of its own).
      const layer = document.querySelector("[role=dialog]") ? "[role=dialog]" : document.querySelector("[role=menu]") ? "[role=menu]" : null;
      const r = await (window as unknown as { axe: { run: (ctx: unknown, o: unknown) => Promise<{ violations: unknown[] }> } }).axe.run(
        { include: layer ? [[layer]] : [["html"]], exclude: [["[data-uicheck-ignore]"]] },
        { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] },
      );
      return r.violations;
    })) as { id: string; help: string; nodes: { target: string[]; failureSummary: string; html: string }[] }[];
    for (const v of violations) {
      for (const n of v.nodes) {
        const sel = n.target.join(" ");
        const info = await page.evaluate((s) => {
          const el = document.querySelector(s);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const text = ((el as HTMLElement).innerText || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 80);
          return { text, box: { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height } };
        }, sel).catch(() => null);
        const detail = (n.failureSummary || v.help).split("\n").filter((l) => l.trim() && !/^Fix (any|all)/.test(l.trim()))[0]?.trim() ?? v.help;
        findings.push({ rule: `axe:${v.id}`, selector: sel.slice(0, 160), text: info?.text ?? "", detail, box: info?.box ?? null });
      }
    }
  }
  return findings;
}

/** Outline each finding and number it, for the screenshot. */
async function outline(page: Page, findings: (Finding & { n: number })[]) {
  await page.evaluate((fs) => {
    const layer = document.createElement("div");
    layer.id = "uicheck-outline";
    layer.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none";
    for (const f of fs) {
      if (!f.box) continue;
      const b = document.createElement("div");
      b.style.cssText = `position:absolute;left:${f.box.x - 2}px;top:${f.box.y - 2}px;width:${f.box.w + 4}px;height:${f.box.h + 4}px;outline:2px solid #e500a4;outline-offset:0`;
      const tag = document.createElement("span");
      tag.textContent = String(f.n);
      tag.style.cssText = "position:absolute;left:-2px;top:-18px;font:600 11px/16px system-ui;background:#e500a4;color:#fff;padding:0 4px;border-radius:3px";
      b.appendChild(tag);
      layer.appendChild(b);
    }
    document.body.appendChild(layer);
  }, findings);
}

async function runScreen(browser: Browser, base: string, info: ServerInfo, v: Variant, s: Screen): Promise<Result> {
  const result: Result = { screen: s.id, variant: v.id, shot: null, findings: [], allowed: [] };
  if (s.variants && !s.variants.includes(v.id)) return result;
  const ctx = await context(browser, base, v, s.as, info);
  const page = await ctx.newPage();
  const problems: Finding[] = [];
  page.on("pageerror", (e) => problems.push({ rule: "console", selector: "", text: "", detail: `page error: ${e.message.slice(0, 200)}`, box: null }));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) {
      problems.push({ rule: "console", selector: "", text: "", detail: m.text().slice(0, 200), box: null });
    }
  });
  page.on("response", (r) => {
    const status = r.status();
    const url = new URL(r.url());
    if (status >= 500 || (status >= 400 && !(s.expectStatus ?? []).includes(status) && url.pathname.startsWith("/api/"))) {
      problems.push({ rule: "http", selector: "", text: "", detail: `${status} ${r.request().method()} ${url.pathname}`, box: null });
    }
  });
  try {
    const account = info.accounts[v.id.replace(/[^a-z0-9]/g, "")]!;
    await page.goto(base + s.path(info, account), { waitUntil: "domcontentloaded" });
    await settle(page);
    if (s.ready) await page.locator(s.ready).first().waitFor({ timeout: 10_000 });
    if (s.act) {
      await s.act(page, v);
      await settle(page);
    }
    const found = [...(await check(page)), ...problems];
    let n = 0;
    for (const f of found) {
      const a = allowedBy(f, s.id, v.id);
      if (a) result.allowed.push({ ...f, reason: a.reason });
      else result.findings.push({ ...f, n: ++n });
    }
    await outline(page, result.findings);
    mkdirSync(join(OUT, v.id), { recursive: true });
    result.shot = `${v.id}/${s.id}.png`;
    await page.screenshot({ path: join(OUT, result.shot), fullPage: true });
  } catch (e) {
    result.error = (e as Error).message.split("\n")[0]!;
    result.findings.push({ rule: "check-failed", selector: "", text: "", detail: result.error, box: null, n: 1 });
    mkdirSync(join(OUT, v.id), { recursive: true });
    result.shot = `${v.id}/${s.id}.png`;
    await page.screenshot({ path: join(OUT, result.shot), fullPage: true }).catch(() => (result.shot = null));
  } finally {
    await ctx.close();
  }
  return result;
}

// ------------------------------------------------------------------ report

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function writeReport(results: Result[]) {
  writeFileSync(join(OUT, "report.json"), JSON.stringify(results, null, 2));
  const byScreen = new Map<string, Result[]>();
  for (const r of results) if (r.shot || r.findings.length) byScreen.set(r.screen, [...(byScreen.get(r.screen) ?? []), r]);
  const total = results.reduce((a, r) => a + r.findings.length, 0);
  const sections = [...byScreen.entries()]
    .map(([screen, rs]) => {
      const count = rs.reduce((a, r) => a + r.findings.length, 0);
      const cards = rs
        .map(
          (r) => `<figure class="${r.findings.length ? "bad" : ""}">
  <figcaption><b>${esc(r.variant)}</b> ${r.findings.length ? `${r.findings.length} found` : "ok"}${r.allowed.length ? ` · ${r.allowed.length} allowed` : ""}</figcaption>
  ${r.shot ? `<a href="${r.shot}"><img loading="lazy" src="${r.shot}" alt="${esc(screen)} at ${esc(r.variant)}"></a>` : ""}
  ${r.findings.length ? `<ol>${r.findings.map((f) => `<li value="${f.n}"><code>${esc(f.rule)}</code> ${esc(f.detail)}${f.text ? ` · “${esc(f.text)}”` : ""}<br><small>${esc(f.selector)}</small></li>`).join("")}</ol>` : ""}
</figure>`,
        )
        .join("\n");
      return `<section id="${esc(screen)}"><h2>${esc(screen)} <span>${count ? `${count} found` : "ok"}</span></h2><div class="grid">${cards}</div></section>`;
    })
    .join("\n");
  writeFileSync(
    join(OUT, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>UI check</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:24px;background:#f6f5f2;color:#1b1b1b}
h1{font-size:20px}h2{font-size:16px;margin:32px 0 8px}h2 span{font-weight:400;color:#666}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;align-items:start}
figure{margin:0;background:#fff;border:1px solid #ddd;border-radius:6px;padding:8px;min-width:0}
figure.bad{border-color:#e500a4}figcaption{margin-bottom:6px}
img{width:100%;max-height:420px;object-fit:cover;object-position:top;border:1px solid #eee}
ol{padding-left:20px;margin:8px 0 0}li{margin:4px 0;overflow-wrap:anywhere}small{color:#666}code{background:#f0eee8;padding:0 3px}
</style>
<h1>UI check: ${total ? `${total} found` : "nothing found"}</h1>
<p>${results.length} pages: ${[...byScreen.keys()].length} screens × ${variants.length} variants. Outlined and numbered in each screenshot.</p>
${sections}`,
  );
}

// ------------------------------------------------------------------ main

const started = Date.now();
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const slides = await makeSlides(browser);
const server = await startServer(slides);
const base = `http://127.0.0.1:${server.info.port}`;
const jobs = variants.flatMap((v) => screens.map((s) => ({ v, s })));
const results: Result[] = [];
let next = 0;
const PARALLEL = Number(process.env.UICHECK_PARALLEL ?? 4);
try {
  await Promise.all(
    Array.from({ length: PARALLEL }, async () => {
      while (next < jobs.length) {
        const { v, s } = jobs[next++]!;
        const r = await runScreen(browser, base, server.info, v, s);
        results.push(r);
        if (r.shot || r.findings.length) {
          process.stdout.write(r.findings.length ? `  ${s.id} @ ${v.id}: ${r.findings.length} found\n` : "");
        }
      }
    }),
  );
} finally {
  await browser.close();
  server.stop();
  rmSync(slides, { recursive: true, force: true });
}

results.sort((a, b) => SCREENS.findIndex((s) => s.id === a.screen) - SCREENS.findIndex((s) => s.id === b.screen) || VARIANTS.findIndex((v) => v.id === a.variant) - VARIANTS.findIndex((v) => v.id === b.variant));
writeReport(results);
const checked = results.filter((r) => r.shot || r.error);
const found = results.flatMap((r) => r.findings.map((f) => ({ ...f, screen: r.screen, variant: r.variant })));
const byRule = new Map<string, number>();
for (const f of found) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);
console.log(`\nChecked ${checked.length} pages (${screens.length} screens × ${variants.length} variants) in ${Math.round((Date.now() - started) / 1000)} s.`);
if (!found.length) {
  console.log("Nothing found. Screenshots: uicheck/out/index.html");
  process.exit(0);
}
console.log(`${found.length} found: ${[...byRule.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(", ")}`);
// The same problem usually shows in several variants: list each once.
const unique = new Map<string, { f: (typeof found)[number]; where: string[] }>();
for (const f of found) {
  // Rows of a table repeat one problem: group by the element's kind, not its position.
  const key = `${f.screen}|${f.rule}|${f.selector.replace(/:nth-(child|of-type)\(\d+\)/g, "")}|${f.rule.startsWith("axe:") ? f.detail.replace(/[\d.]+:1|[\d.]+ \(/g, "") : f.text}`;
  const u = unique.get(key) ?? { f, where: [] };
  u.where.push(f.variant);
  unique.set(key, u);
}
for (const { f, where } of [...unique.values()].slice(0, 80)) {
  const variantsSeen = [...new Set(where)];
  const times = where.length > variantsSeen.length ? ` ×${where.length}` : "";
  console.log(`\n  ${f.rule}  ${f.screen} [${variantsSeen.join(", ")}]${times}\n    ${f.detail}${f.text ? `  “${f.text}”` : ""}\n    ${f.selector}`);
}
if (unique.size > 80) console.log(`\n  … and ${unique.size - 80} more in uicheck/out/report.json`);
console.log("\nScreenshots with each finding outlined: uicheck/out/index.html");
console.log("A finding that is intended goes in uicheck/allow.json, with the reason.");
process.exit(1);
