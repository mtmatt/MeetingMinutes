import type { MeetingSummary } from "../api/types";
import { useI18n, type TKey } from "../i18n";

/** Status pill for a meeting, folding in the latest summary state. */
export function MeetingStatus({ m }: { m: Pick<MeetingSummary, "status" | "stage" | "progress" | "latestSummary"> }) {
  const { t } = useI18n();
  if (m.status === "processing") {
    const stage = m.stage ? (`stage.${m.stage}` as TKey) : "status.processing";
    return (
      <span className="pill info live">
        <span className="ring" style={{ ["--p" as string]: String(m.progress), ["--size" as string]: "12px" }} />
        {t(stage)} · {Math.round(m.progress * 100)}%
      </span>
    );
  }
  if (m.status === "queued")
    return (
      <span className="pill live">
        <span className="dot" />
        {t("status.queued")}
      </span>
    );
  if (m.status === "uploading")
    return (
      <span className="pill warn">
        <span className="dot" />
        {t("status.uploading")}
      </span>
    );
  if (m.status === "failed")
    return (
      <span className="pill danger">
        <span className="dot" />
        {t("status.failed")}
      </span>
    );
  const s = m.latestSummary?.status;
  if (s === "running")
    return (
      <span className="pill accent live">
        <span className="dot" />
        {t("status.summarizing")}
      </span>
    );
  if (s === "queued")
    return (
      <span className="pill accent live">
        <span className="dot" />
        {t("status.summaryQueued")}
      </span>
    );
  if (s === "done")
    return (
      <span className="pill ok">
        <span className="dot" />
        {t("status.summarized")}
      </span>
    );
  if (s === "failed")
    return (
      <span className="pill warn">
        <span className="dot" />
        {t("status.summaryFailed")}
      </span>
    );
  return (
    <span className="pill neutral">
      <span className="dot" />
      {t("status.ready")}
    </span>
  );
}
