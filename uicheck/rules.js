// The UI check's rules, run inside the page (uicheck/run.ts evaluates this
// file). Each finding names a rule, the element (a short CSS path and its
// text), and where it is on the page, for the outline in the screenshot.
//
// Rules:
//   page-scroll-x  the page scrolls sideways (and which elements stick out)
//   scroll-x       an element scrolls sideways without being meant to (wide
//                  tables, tab strips and code are; mark another with
//                  data-scroll-x)
//   clipped        a control, heading or cell is cut off by a container that
//                  hides its overflow
//   offscreen      a control, heading or cell is partly outside the window
//   text-cut       text cut off without an ellipsis
//   label-wrap     a short label (button, tab, pill, table heading) breaks
//                  onto a second line
//   orphan         a single CJK character alone on the last line
//   covered        a control is hidden under another element
//   text-overlap   two pieces of text overlap
//   i18n           a translation key, an unfilled {placeholder}, or
//                  undefined / NaN / [object Object] on screen
//   broken-image   an image that did not load
// The file is one function: (mode) => findings. mode "covered" runs only the
// "covered" rule, for the part of the page now in the window (run.ts scrolls).
(mode = "all") => {
  const findings = [];
  const vw = document.documentElement.clientWidth;

  const cssPath = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 4 && e !== document.body; e = e.parentElement) {
      let p = e.tagName.toLowerCase();
      if (e.id) {
        parts.unshift(`${p}#${e.id}`);
        break;
      }
      const cls = [...e.classList].filter((c) => !/^(active|open|on|off|is-|has-)/.test(c)).slice(0, 2);
      if (cls.length) p += "." + cls.join(".");
      parts.unshift(p);
    }
    return parts.join(" > ");
  };
  const textOf = (el) =>
    (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("alt") || "").trim().replace(/\s+/g, " ").slice(0, 80);
  const boxOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height };
  };
  const seen = new Set();
  const add = (rule, el, detail) => {
    const key = rule + "|" + cssPath(el) + "|" + textOf(el);
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ rule, selector: cssPath(el), text: textOf(el), detail: detail || "", box: boxOf(el) });
  };

  const hidden = (el) => {
    if (el.closest("[inert], [aria-hidden='true'], [data-uicheck-ignore], svg")) return true;
    // The body of a closed <details> is not shown.
    const closed = el.closest("details:not([open])");
    if (closed && !el.closest("summary")) return true;
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return true;
      // Inside a box clipped to nothing: text for screen readers only (.visually-hidden).
      if (e !== el && (cs.overflow === "hidden" || cs.clipPath !== "none" || cs.clip !== "auto")) {
        const b = e.getBoundingClientRect();
        if (b.width <= 2 || b.height <= 2) return true;
      }
      if (cs.display === "contents") continue;
    }
    const r = el.getBoundingClientRect();
    return r.width < 3 || r.height < 3;
  };
  const all = [...document.body.querySelectorAll("*")].filter((el) => el instanceof HTMLElement && !["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(el.tagName));
  // With a dialog or menu open, only it is checked: the page under it is a screen of its own.
  const layer = document.querySelector("[role=dialog]") || document.querySelector("[role=menu]");
  const shown = all.filter((el) => !hidden(el) && (!layer || layer.contains(el)));
  const scrollsX = (cs) => cs.overflowX === "auto" || cs.overflowX === "scroll";
  /** Meant to scroll sideways: wide tables, tab strips, code. */
  const INTENDED = ".table-wrap, [role=tablist], .tabs, pre, [data-scroll-x]";
  const clipsX = (cs) => cs.overflowX === "hidden" || cs.overflowX === "clip";
  const clipsY = (cs) => cs.overflowY === "hidden" || cs.overflowY === "clip";
  /** Inside a container that may scroll sideways on purpose. */
  const inScroller = (el) => {
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (scrollsX(cs)) return true;
      if (cs.position === "fixed") return false;
    }
    return false;
  };

  const only = (rule) => mode === "all" || mode === rule;

  // ------------------------------------------------------------ overflow

  if (only("page-scroll-x") && document.scrollingElement.scrollWidth > vw + 1) {
    const out = shown.filter((el) => el.getBoundingClientRect().right > vw + 1 && !inScroller(el) && getComputedStyle(el).position !== "fixed");
    // The innermost ones: those with no offending child.
    const leaves = out.filter((el) => !out.some((o) => o !== el && el.contains(o))).slice(0, 5);
    if (!leaves.length) findings.push({ rule: "page-scroll-x", selector: "html", text: "", detail: `${document.scrollingElement.scrollWidth}px > ${vw}px`, box: null });
    for (const el of leaves) add("page-scroll-x", el, `reaches ${Math.round(el.getBoundingClientRect().right)}px of ${vw}px`);
  }

  if (mode === "all") for (const el of shown) {
    const cs = getComputedStyle(el);
    if (scrollsX(cs) && el.scrollWidth > el.clientWidth + 1 && !el.matches(INTENDED)) {
      add("scroll-x", el, `content ${el.scrollWidth}px in ${el.clientWidth}px`);
    }
  }

  const TARGETS = "a[href], button, input, select, textarea, [role=button], [role=tab], [role=menuitem], label, h1, h2, h3, h4, th, td, img, .pill";
  if (mode === "all") for (const el of shown) {
    if (!el.matches(TARGETS)) continue;
    const r = el.getBoundingClientRect();
    const interactive = el.matches("a[href], button, input, select, textarea, [role=button], [role=tab], [role=menuitem]");
    let reported = false;
    let scrolled = false;
    for (let e = el.parentElement; e && e !== document.body && !reported; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (scrollsX(cs)) {
        scrolled = true;
        break;
      }
      const a = e.getBoundingClientRect();
      const bl = parseFloat(cs.borderLeftWidth) || 0;
      const br = parseFloat(cs.borderRightWidth) || 0;
      if (clipsX(cs) && (r.right > a.right - br + 1 || r.left < a.left + bl - 1)) {
        add("clipped", el, `cut by ${cssPath(e)}`);
        reported = true;
      } else if (interactive && clipsY(cs) && !scrollsX(cs) && cs.overflowY !== "auto" && (r.bottom > a.bottom + 1 || r.top < a.top - 1)) {
        add("clipped", el, `cut by ${cssPath(e)} (height)`);
        reported = true;
      }
      if (cs.position === "fixed") break;
    }
    if (!reported && !scrolled && (r.right > vw + 1 || r.left < -1)) add("offscreen", el, `${Math.round(r.left)}–${Math.round(r.right)}px of ${vw}px`);
  }

  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  if (mode === "all") for (const el of shown) {
    const cs = getComputedStyle(el);
    if (clipsX(cs) && ownText(el) && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== "ellipsis") {
      add("text-cut", el, `text ${el.scrollWidth}px in ${el.clientWidth}px`);
    }
  }

  // ------------------------------------------------------------ line breaks

  const textNodes = (el) => {
    const out = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.textContent.trim()) out.push(n);
    return out;
  };
  /** Top of each line the element's text occupies. */
  const lineTops = (el) => {
    const tops = [];
    for (const n of textNodes(el)) {
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const rect of range.getClientRects()) {
        if (rect.width < 1) continue;
        if (!tops.some((t) => Math.abs(t - rect.top) < rect.height / 2)) tops.push(rect.top);
      }
    }
    return tops.sort((a, b) => a - b);
  };
  // Pipeline steps are laid out to wrap (balanced); a lone character there is still an orphan.
  const LABELS = "button, [role=tab], [role=menuitem], th, .pill, .badge, .chip, .tag, .btn, label, legend, dt, .stat-label";
  if (mode === "all") for (const el of shown) {
    if (!el.matches(LABELS)) continue;
    const text = el.innerText.replace(/\s+/g, "");
    // Only a label of a few words: longer buttons (with a description) may wrap.
    if (!text || text.length > 14 || el.querySelector("p, div, br")) continue;
    if (lineTops(el).length > 1) add("label-wrap", el, `${lineTops(el).length} lines`);
  }

  const CJK = /[㐀-鿿豈-﫿぀-ヿ가-힯]/;
  const PUNCT = /[\s\p{P}\p{S}]/u;
  /** Characters on the element's last line, with their top. */
  const lastLine = (el) => {
    const nodes = textNodes(el);
    const chars = [];
    let top = null;
    const range = document.createRange();
    for (let k = nodes.length - 1; k >= 0; k--) {
      const s = nodes[k].textContent;
      for (let i = s.length - 1; i >= 0; i--) {
        if (/\s/.test(s[i])) continue;
        range.setStart(nodes[k], i);
        range.setEnd(nodes[k], i + 1);
        const rect = range.getBoundingClientRect();
        if (!rect.height) continue;
        if (top === null) top = rect.top;
        if (Math.abs(rect.top - top) > rect.height / 2) return chars;
        chars.unshift(s[i]);
      }
    }
    return chars;
  };
  if (mode === "all") for (const el of shown) {
    if (!ownText(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.display.startsWith("inline") && cs.display !== "inline-block") continue;
    const text = el.innerText.trim();
    if (text.length < 4 || text.length > 600 || !CJK.test(text)) continue;
    if (lineTops(el).length < 2) continue;
    const last = lastLine(el).filter((ch) => !PUNCT.test(ch));
    if (last.length === 1 && CJK.test(last[0])) add("orphan", el, `"${last[0]}" alone on the last line`);
  }

  // ------------------------------------------------------------ layering

  const LAYERS = "[role=dialog], [role=menu], .menu, .toast, .modal-backdrop, [popover]";
  const CONTROLS = "a[href], button, input, select, textarea, [role=button], [role=tab], [role=menuitem]";
  const vh = window.innerHeight;
  /** Inside something that stays put while the page scrolls (header, player, bottom bar). */
  const pinned = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const p = getComputedStyle(e).position;
      if (p === "fixed" || p === "sticky") return e;
    }
    return null;
  };
  const start = [window.scrollX, window.scrollY];
  // Each control in the middle of the window, where nothing pinned should cover it.
  if (only("covered")) for (const el of shown) {
    if (!el.matches(CONTROLS)) continue;
    // Pinned (a menu, a bar): scroll only inside it, as a person would to reach a lower item.
    el.scrollIntoView(pinned(el) ? { block: "nearest", inline: "nearest" } : { block: "center", inline: "nearest" });
    const r = el.getBoundingClientRect();
    const x = r.left + Math.min(r.width / 2, 12);
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x >= vw || y >= vh) continue;
    const top = document.elementFromPoint(x, y);
    if (!top || top === el || el.contains(top) || top.contains(el)) continue;
    if (top.closest(LAYERS) && !el.closest(LAYERS)) continue;
    // Its own label, or a sibling sharing a decoration layer, is fine.
    if (el.labels && [...el.labels].some((l) => l.contains(top))) continue;
    if (getComputedStyle(top).pointerEvents === "none") continue;
    add("covered", el, `under ${cssPath(top)}`);
  }
  window.scrollTo(start[0], start[1]);

  const leaves = mode === "all" ? shown.filter(ownText) : [];
  const rects = leaves.map((el) => ({ el, r: el.getBoundingClientRect() })).sort((a, b) => a.r.top - b.r.top);
  for (let i = 0; i < rects.length; i++) {
    const a = rects[i];
    for (let j = i + 1; j < rects.length && rects[j].r.top < a.r.bottom; j++) {
      const b = rects[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      // Pinned bars lie over the page as it scrolls; only text in the same layer counts.
      if (pinned(a.el) !== pinned(b.el)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w <= 2 || h <= 2) continue;
      const smaller = Math.min(a.r.width * a.r.height, b.r.width * b.r.height);
      if ((w * h) / smaller < 0.25) continue;
      // Only where text actually lies under text, not empty parts of the boxes.
      const ta = textNodes(a.el).flatMap((n) => { const g = document.createRange(); g.selectNodeContents(n); return [...g.getClientRects()]; });
      const tb = textNodes(b.el).flatMap((n) => { const g = document.createRange(); g.selectNodeContents(n); return [...g.getClientRects()]; });
      const hit = ta.some((p) => tb.some((q) => Math.min(p.right, q.right) - Math.max(p.left, q.left) > 2 && Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top) > 2));
      if (hit) add("text-overlap", a.el, `with ${cssPath(b.el)} "${textOf(b.el).slice(0, 30)}"`);
    }
  }

  // ------------------------------------------------------------ content

  const KEY = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/;
  const NOT_KEY = /\.(com|org|net|io|tw|edu|dev|app|wav|mp3|m4a|mp4|jpg|png|pdf|json|ts|js|sh|md|txt|env|service|py|toml)$/;
  if (mode === "all") for (const el of shown) {
    for (const n of el.childNodes) {
      if (n.nodeType !== 3) continue;
      const s = n.textContent.trim();
      if (!s) continue;
      if (KEY.test(s) && !NOT_KEY.test(s)) add("i18n", el, `translation key "${s}"`);
      else if (/\{[a-zA-Z]+\}/.test(s)) add("i18n", el, `unfilled placeholder in "${s.slice(0, 60)}"`);
      else if (/(^|[^\w])(undefined|NaN|\[object Object\])([^\w]|$)/.test(s)) add("i18n", el, `"${s.slice(0, 60)}"`);
    }
    for (const attr of ["placeholder", "aria-label", "title", "alt"]) {
      const v = el.getAttribute(attr);
      if (v && ((KEY.test(v) && !NOT_KEY.test(v)) || /\{[a-zA-Z]+\}/.test(v) || /\bundefined\b|\bNaN\b/.test(v))) add("i18n", el, `${attr}="${v}"`);
    }
  }

  if (mode === "all") for (const img of document.images) {
    if (!hidden(img) && img.complete && img.naturalWidth === 0) add("broken-image", img, img.currentSrc || img.src);
  }

  return findings;
};
