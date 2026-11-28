import { useState } from "react";
import { useI18n } from "../i18n";
import { useAuth } from "../lib/auth";
import { slidesSupported } from "../lib/slides";
import { VENDOR_NAMES } from "../lib/summaryEngine";

const STORAGE_KEY = "mm.slides";

/** Whether slides are picked, remembered in this browser (a convenience: off until turned on once). */
export function useSlidesChoice(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const set = (v: boolean) => {
    setOn(v);
    try {
      localStorage.setItem(STORAGE_KEY, v ? "1" : "0");
    } catch {
      /* private mode: only for this page */
    }
  };
  return [on && slidesSupported(), set];
}

/**
 * "Capture slides" for a video file (`video`) or a recording of a shared tab
 * (`record`), with what happens to the pictures: where they are looked at,
 * and whether summaries read them (and are paid for that).
 */
export function SlideOption({ checked, onChange, kind }: { checked: boolean; onChange: (on: boolean) => void; kind: "video" | "record" }) {
  const { t, locale } = useI18n();
  const { summarizer } = useAuth();
  if (!slidesSupported()) return null;
  const vision = !!summarizer?.vision;
  const vendor = summarizer?.provider === "api" && summarizer.vendor ? VENDOR_NAMES[summarizer.vendor] : null;
  return (
    <div className="field slide-option">
      <label className="switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="switch-track" />
        <span className="switch-label">{t("slides.option")}</span>
      </label>
      <span className="field-hint">
        {t(kind === "video" ? "slides.hintVideo" : "slides.hintRecord")}
        {locale === "zh-TW" ? "" : " "}
        {vision ? (vendor ? t("slides.summaryUses", { vendor }) : t("slides.summaryUsesLocal")) : t("slides.summaryNoVision")}
      </span>
    </div>
  );
}
