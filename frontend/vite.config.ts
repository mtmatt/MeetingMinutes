import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const backend = process.env.MM_BACKEND_URL ?? "http://127.0.0.1:8787";

/**
 * The fonts every page draws with before anything else: the title face, the
 * italic wordmark and the body face (Latin; CJK text uses the system font).
 * Preloaded from the HTML, so they download alongside the script instead of
 * after the stylesheet has been fetched and parsed.
 */
const PRELOAD_FONTS = [/^fraunces-latin-full-normal-.*\.woff2$/, /^fraunces-latin-full-italic-.*\.woff2$/, /^geist-latin-wght-normal-.*\.woff2$/];

function preloadFonts(): Plugin {
  return {
    name: "mm-preload-fonts",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        const files = Object.keys(ctx.bundle ?? {}).filter((f) => f.startsWith("assets/") && PRELOAD_FONTS.some((re) => re.test(f.slice(7))));
        return files.map((f) => ({
          tag: "link",
          attrs: { rel: "preload", href: `/${f}`, as: "font", type: "font/woff2", crossorigin: "" },
          injectTo: "head" as const,
        }));
      },
    },
  };
}

/**
 * Brotli and gzip copies of the text assets next to them (app.js.br, app.js.gz),
 * made once at build time at the best compression, so the server sends them
 * as they are and spends no CPU per request. Fonts are already compressed.
 */
function precompress(): Plugin {
  let outDir = "dist";
  return {
    name: "mm-precompress",
    apply: "build",
    configResolved(c) {
      outDir = c.build.outDir;
    },
    closeBundle() {
      const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((name) => {
          const p = join(dir, name);
          return statSync(p).isDirectory() ? walk(p) : [p];
        });
      for (const file of walk(outDir)) {
        if (!/\.(js|css|html|svg|json|txt|webmanifest)$/.test(file)) continue;
        const data = readFileSync(file);
        if (data.length < 1024) continue;
        const br = brotliCompressSync(data, {
          params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length },
        });
        const gz = gzipSync(data, { level: 9 });
        if (br.length < data.length) writeFileSync(file + ".br", br);
        if (gz.length < data.length) writeFileSync(file + ".gz", gz);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), preloadFonts(), precompress()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: backend, changeOrigin: false },
    },
  },
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
