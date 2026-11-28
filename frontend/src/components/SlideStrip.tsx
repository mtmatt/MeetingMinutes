import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useI18n } from "../i18n";
import { clock } from "../lib/format";
import type { CapturedSlide } from "../lib/slides";

/**
 * Slides picked in the browser, before they are uploaded: a row of thumbnails
 * with the time each appeared, and a way to leave one out.
 */
export function SlideStrip({ slides, onRemove, live = false }: { slides: CapturedSlide[]; onRemove?: (slot: string) => void; live?: boolean }) {
  const { t } = useI18n();
  const urls = useObjectUrls(slides);
  if (slides.length === 0) return null;
  // While recording the newest slide is the interesting one: show it first.
  const shown = live ? [...slides].reverse() : slides;
  return (
    <ul className="slide-strip" aria-label={t("slides.stripLabel")}>
      {shown.map((s) => (
        <li key={s.slot} className="slide-thumb">
          <img src={urls.get(s.key)} alt={t("slides.thumbAlt", { t: clock(s.at) })} width={s.width} height={s.height} loading="lazy" decoding="async" />
          <span className="slide-thumb-time mono">{clock(s.at)}</span>
          {onRemove && (
            <button type="button" className="slide-thumb-remove" onClick={() => onRemove(s.slot)} aria-label={t("slides.remove", { t: clock(s.at) })} title={t("slides.remove", { t: clock(s.at) })}>
              <X />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** One address per picture, made once and released when the picture is gone (or the strip is). */
function useObjectUrls(slides: CapturedSlide[]): Map<string, string> {
  const ref = useRef(new Map<string, string>());
  const map = ref.current;
  const live = new Set(slides.map((s) => s.key));
  for (const s of slides) if (!map.has(s.key)) map.set(s.key, URL.createObjectURL(s.blob));
  useEffect(() => {
    for (const [key, url] of map) {
      if (!live.has(key)) {
        URL.revokeObjectURL(url);
        map.delete(key);
      }
    }
  });
  // Released a moment after unmounting: development mode unmounts and mounts again at once.
  const pending = useRef<number | null>(null);
  useEffect(() => {
    if (pending.current != null) clearTimeout(pending.current);
    return () => {
      pending.current = window.setTimeout(() => {
        map.forEach((u) => URL.revokeObjectURL(u));
        map.clear();
      }, 0);
    };
  }, [map]);
  return map;
}
