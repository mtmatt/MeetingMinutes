import { useQueryClient } from "@tanstack/react-query";
import { Users } from "lucide-react";
import { useState } from "react";
import { api } from "../api/client";
import type { MeetingDetail } from "../api/types";
import { useI18n, type TKey } from "../i18n";
import { diarizationReason } from "../lib/errors";
import { Modal } from "./Modal";
import { Stepper } from "./Stepper";
import { useToast } from "./Toast";

type Issue = { kind: "unavailable" | "failed" | "single" | "unknown"; reason?: string | null };

/**
 * Why a transcript has no (or only one) speaker, if that looks unintended:
 * - unavailable: the diarization model could not be loaded on the worker,
 * - failed: it ran into an error,
 * - single: it ran in automatic mode and found only one voice,
 * - unknown: an older transcript without speakers, from before this was recorded.
 */
export function diarizationIssue(meeting: MeetingDetail): Issue | null {
  if (!meeting.options.diarize || meeting.status !== "ready" || meeting.segments.length === 0) return null;
  const d = meeting.diarization;
  if (d?.status === "unavailable") return { kind: "unavailable", reason: d.reason };
  if (d?.status === "failed") return { kind: "failed", reason: d.reason };
  const auto = meeting.options.numSpeakers == null && meeting.options.minSpeakers == null;
  if (d?.status === "ok" && auto && meeting.speakers.length <= 1) return { kind: "single" };
  if (!d && meeting.speakers.length === 0) return { kind: "unknown" };
  return null;
}

const TITLE: Record<Issue["kind"], TKey> = {
  unavailable: "diarize.unavailableTitle",
  failed: "diarize.failedTitle",
  single: "diarize.singleTitle",
  unknown: "diarize.unknownTitle",
};
const BODY: Record<Issue["kind"], TKey> = {
  unavailable: "diarize.unavailableBody",
  failed: "diarize.failedBody",
  single: "diarize.singleBody",
  unknown: "diarize.unknownBody",
};

/** Above the transcript: says plainly that speakers were not separated, why, and offers to redo it. */
export function DiarizationNotice({ meeting }: { meeting: MeetingDetail }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const issue = diarizationIssue(meeting);
  if (!issue) return null;
  return (
    <div className={`callout ${issue.kind === "single" ? "" : "warn"} diarize-notice`} role="status">
      <Users />
      <div className="diarize-notice-main">
        <strong>{t(TITLE[issue.kind])}</strong>
        <p>{t(BODY[issue.kind])}</p>
        {issue.kind === "unavailable" && <p>{t(diarizationReason(issue.reason))}</p>}
        {issue.reason && (
          <details className="diarize-notice-detail">
            <summary>{t("diarize.technical")}</summary>
            <code>{issue.reason}</code>
          </details>
        )}
      </div>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
        {t("diarize.resplit")}
      </button>
      {open && <ResplitDialog meeting={meeting} onClose={() => setOpen(false)} />}
    </div>
  );
}

type Mode = "auto" | "exact" | "range";

/**
 * Re-transcribe with speaker separation and, ideally, a known head count.
 * A given count makes pyannote split into exactly that many voices instead of
 * deciding on its own, which is what merges similar voices into one.
 */
export function ResplitDialog({ meeting, onClose }: { meeting: MeetingDetail; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const o = meeting.options;
  const [mode, setMode] = useState<Mode>(o.numSpeakers != null ? "exact" : o.minSpeakers != null || o.maxSpeakers != null ? "range" : "exact");
  const [exact, setExact] = useState(o.numSpeakers ?? Math.max(2, meeting.speakers.length));
  const [range, setRange] = useState<[number, number]>([o.minSpeakers ?? 2, o.maxSpeakers ?? 6]);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api.retranscribe(
        meeting.id,
        {
          ...o,
          diarize: true,
          numSpeakers: mode === "exact" ? exact : null,
          minSpeakers: mode === "range" ? range[0] : null,
          maxSpeakers: mode === "range" ? range[1] : null,
        },
        true,
      );
      await qc.invalidateQueries({ queryKey: ["meeting", meeting.id] });
      onClose();
    } catch (e) {
      toast.error(e);
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("diarize.resplitTitle")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy && <span className="spinner" />} {t("diarize.resplitConfirm")}
          </button>
        </>
      }
    >
      <div className="resplit">
        <p>{t("diarize.resplitIntro")}</p>
        <div className="speaker-mode">
          <div className="segmented">
            {(["exact", "range", "auto"] as Mode[]).map((m) => (
              <button type="button" key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>
                {t(m === "auto" ? "upload.speakersAuto" : m === "exact" ? "upload.speakersExact" : "upload.speakersRange")}
              </button>
            ))}
          </div>
          {mode === "exact" && <Stepper value={exact} onChange={setExact} />}
          {mode === "range" && (
            <span className="range-inputs">
              <Stepper value={range[0]} onChange={(n) => setRange([n, Math.max(n, range[1])])} />
              <span className="faint">{t("upload.and")}</span>
              <Stepper value={range[1]} onChange={(n) => setRange([Math.min(n, range[0]), n])} />
            </span>
          )}
        </div>
        <p className="faint">{mode === "auto" ? t("diarize.autoHint") : t("diarize.countHint")}</p>
        <p className="resplit-warn">{t("diarize.resplitEffects")}</p>
      </div>
    </Modal>
  );
}
