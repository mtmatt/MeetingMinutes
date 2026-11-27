import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { MediaPolicy, MediaState } from "../api/types";
import { useConfirm } from "../components/Modal";
import { useToast } from "../components/Toast";
import { useI18n } from "../i18n";
import { bytes, relative } from "../lib/format";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Admin → System: whether originals are replaced by an audio-only Opus copy
 * some days after transcription, and how much that has saved and would save.
 */
export function StoragePolicy({ compactions }: { compactions?: { queued: number; running: number } }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["admin", "media"], queryFn: api.adminMedia, refetchInterval: 30_000 });
  const [form, setForm] = useState<MediaPolicy | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data && !form) setForm(data.settings);
  }, [data, form]);

  if (!data || !form) return <div className="skeleton" style={{ height: 200 }} />;
  const dirty = !same(form, data.settings);
  const daysOk = Number.isInteger(form.afterDays) && form.afterDays >= 0 && form.afterDays <= 3650;
  const s = data.stats;

  const applied = async (next: MediaState, message: string) => {
    qc.setQueryData(["admin", "media"], next);
    setForm(next.settings);
    // The upload page's note and the queue counts follow.
    await Promise.all([qc.invalidateQueries({ queryKey: ["auth"] }), qc.invalidateQueries({ queryKey: ["admin", "system"] })]);
    toast.show(message);
  };

  const save = async () => {
    // Deleting recordings cannot be undone: a shorter (or a first) period deletes what is past it at once.
    const keep = (d: number | undefined) => (d ? d : Number.POSITIVE_INFINITY);
    if (keep(form.retentionDays) < keep(data.settings.retentionDays)) {
      const ok = await confirm({
        title: t("retention.confirmTitle"),
        body: t("retention.confirmBody", { n: form.retentionDays ?? 0 }),
        confirmLabel: t("retention.confirm"),
        danger: true,
      });
      if (!ok) return;
    }
    // Compacting cannot be undone: say what will happen to what is due now.
    const startsNow = form.compact && (!data.settings.compact || form.afterDays < data.settings.afterDays);
    if (startsNow) {
      const ok = await confirm({
        title: t("storage.confirmTitle"),
        body: t("storage.confirmBody", { days: form.afterDays }),
        confirmLabel: t("storage.confirm"),
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      await applied(await api.adminSaveMedia(form), t("common.saved"));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    const ok = await confirm({ title: t("model.resetTitle"), body: t("storage.resetBody"), confirmLabel: t("model.reset") });
    if (!ok) return;
    try {
      await applied(await api.adminResetMedia(), t("model.resetDone"));
    } catch (e) {
      toast.error(e);
    }
  };

  const working = (compactions?.queued ?? 0) + (compactions?.running ?? 0);
  return (
    <section className="card system-card storage-card">
      <h3 className="system-h">
        <Archive /> {t("storage.title")}
      </h3>
      <p className="muted storage-lede">{t("storage.lede", { kbps: s.bitrateKbps, mb: Math.round((s.bitrateKbps * 3600) / 8 / 1000) })}</p>

      <div className="storage-form">
        <label className="switch">
          <input type="checkbox" checked={form.compact} onChange={(e) => setForm({ ...form, compact: e.target.checked })} />
          <span className="switch-track" />
          <span className="switch-label">{t("storage.compact")}</span>
        </label>
        <div className="field storage-days">
          <label htmlFor="compact-days">{t("storage.afterDays")}</label>
          <input
            id="compact-days"
            className="input mono"
            type="number"
            min={0}
            max={3650}
            step={1}
            value={Number.isFinite(form.afterDays) ? form.afterDays : ""}
            disabled={!form.compact}
            aria-invalid={!daysOk}
            onChange={(e) => setForm({ ...form, afterDays: e.target.value === "" ? Number.NaN : Math.round(Number(e.target.value)) })}
          />
          <span className="field-hint">{t("storage.afterDaysHint")}</span>
        </div>
        <div className="field storage-retention">
          <span className="field-label">{t("retention.adminLabel")}</span>
          <div className="segmented" role="group" aria-label={t("retention.adminLabel")}>
            {([0, 30, 7] as const).map((d) => (
              <button key={d} aria-pressed={(form.retentionDays ?? 0) === d} onClick={() => setForm({ ...form, retentionDays: d })}>
                {d === 0 ? t("retention.keep") : t("retention.days", { n: d })}
              </button>
            ))}
          </div>
          <span className="field-hint">{t("retention.adminHint")}</span>
        </div>
      </div>

      <dl className="kv storage-stats">
        <dt>{t("storage.done")}</dt>
        <dd>{s.compacted ? t("storage.doneValue", { n: s.compacted, saved: bytes(s.savedBytes) }) : t("storage.none")}</dd>
        <dt>{t("storage.left")}</dt>
        <dd>
          {s.candidates
            ? t(data.settings.compact ? "storage.leftValueDue" : "storage.leftValue", {
                n: s.candidates,
                saving: bytes(s.candidateSavingBytes),
                due: s.due,
              })
            : t("storage.none")}
        </dd>
        {data.retention && (
          <>
            <dt>{t("retention.statDeleted")}</dt>
            <dd>{data.retention.deleted ? t("retention.statDeletedValue", { n: data.retention.deleted }) : t("storage.none")}</dd>
            {data.retention.dueWithinWeek > 0 && (
              <>
                <dt>{t("retention.statSoon")}</dt>
                <dd>{t("retention.statSoonValue", { n: data.retention.dueWithinWeek, size: bytes(data.retention.dueWithinWeekBytes) })}</dd>
              </>
            )}
          </>
        )}
        {working > 0 && (
          <>
            <dt>{t("storage.working")}</dt>
            <dd className="mono">{t("admin.runningQueued", { running: compactions?.running ?? 0, queued: compactions?.queued ?? 0 })}</dd>
          </>
        )}
        {s.failed > 0 && (
          <>
            <dt>{t("storage.failed")}</dt>
            <dd>{t("storage.failedValue", { n: s.failed })}</dd>
          </>
        )}
      </dl>

      <div className="model-actions">
        <button className="btn btn-primary" onClick={save} disabled={busy || !dirty || !daysOk}>
          {busy && <span className="spinner" />} {t("common.save")}
        </button>
        {dirty && (
          <button className="btn btn-ghost" onClick={() => setForm(data.settings)}>
            {t("model.discard")}
          </button>
        )}
        <span className="faint model-saved">
          {data.saved
            ? t("model.savedBy", { who: data.updatedBy ?? "–", when: data.updatedAt ? relative(data.updatedAt, t, locale) : "" })
            : t("model.usingEnv")}
        </span>
        {data.saved && (
          <button className="btn btn-sm btn-ghost" onClick={reset}>
            <RotateCcw /> {t("model.reset")}
          </button>
        )}
      </div>
    </section>
  );
}
