import type { MeetingDetail } from "../api/types";
import { useI18n } from "../i18n";
import { useAuth } from "../lib/auth";

/**
 * "Correct the transcript with AI" for a transcription that is starting
 * (upload, transcribing again, re-splitting speakers). Nothing when the site
 * does not offer it.
 */
export function RefineOption({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  const { t } = useI18n();
  const { refine } = useAuth();
  if (!refine?.available) return null;
  return (
    <div className="field upload-refine">
      <label className="switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="switch-track" />
        <span className="switch-label">{t("refine.uploadSwitch")}</span>
      </label>
      <span className="field-hint">{t("refine.againHint", { vendor: refine.vendor, host: refine.host })}</span>
    </div>
  );
}

/** Ticked when the meeting asked for it before, or was corrected: transcribing again would otherwise lose the corrections. */
export function refineByDefault(meeting: MeetingDetail): boolean {
  return !!meeting.options.refine || meeting.refinement?.status === "done";
}
