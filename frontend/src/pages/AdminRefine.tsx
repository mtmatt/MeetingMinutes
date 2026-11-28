import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { RefineSettings, RefineState } from "../api/types";
import { useConfirm } from "../components/Modal";
import { useToast } from "../components/Toast";
import { useI18n } from "../i18n";
import { relative } from "../lib/format";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Admin → Summary model: correcting transcripts with a hosted model (Claude
 * Haiku by default) from the meeting's topic. It needs ANTHROPIC_API_KEY on
 * the server; people then see a switch on the upload page and an item in the
 * meeting's menu, and pay for it at the summary rates.
 */
export function RefineSettingsCard() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["admin", "refine"], queryFn: api.adminRefine });
  const [form, setForm] = useState<RefineSettings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data && !form) setForm(data.settings);
  }, [data, form]);

  if (!data || !form) return <div className="skeleton" style={{ height: 160 }} />;
  const dirty = !same(form, data.settings);
  const modelOk = form.model.trim().length > 0;

  const applied = async (next: RefineState, message: string) => {
    qc.setQueryData(["admin", "refine"], next);
    setForm(next.settings);
    // The upload page's switch follows.
    await qc.invalidateQueries({ queryKey: ["auth"] });
    toast.show(message);
  };

  const save = async () => {
    setBusy(true);
    try {
      await applied(await api.adminSaveRefine({ ...form, model: form.model.trim() }), t("common.saved"));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!(await confirm({ title: t("model.resetTitle"), body: t("refine.resetBody"), confirmLabel: t("refine.reset") }))) return;
    try {
      await applied(await api.adminResetRefine(), t("model.resetDone"));
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <section className="card system-card refine-card">
      <h3 className="system-h">
        <Wand2 /> {t("refine.adminTitle")}
      </h3>
      <p className="muted">{t("refine.adminLede")}</p>
      {!data.hasKey && <p className="callout warn">{t("refine.adminNoKey")}</p>}
      <label className="switch">
        <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
        <span className="switch-track" />
        <span className="switch-label">{t("refine.adminSwitch")}</span>
      </label>
      <div className="field refine-model">
        <label htmlFor="refine-model">{t("refine.adminModel")}</label>
        <input
          id="refine-model"
          className="input mono"
          value={form.model}
          maxLength={100}
          aria-invalid={!modelOk}
          onChange={(e) => setForm({ ...form, model: e.target.value })}
        />
        <span className="field-hint">{t("refine.adminModelHint", { model: data.defaults.model })}</span>
      </div>
      <div className="model-actions">
        <button className="btn btn-primary" onClick={save} disabled={busy || !dirty || !modelOk}>
          {busy && <span className="spinner" />} {t("common.save")}
        </button>
        {dirty && (
          <button className="btn btn-ghost" onClick={() => setForm(data.settings)}>
            {t("model.discard")}
          </button>
        )}
        {data.saved && (
          <>
            <span className="faint model-saved">
              {t("model.savedBy", { who: data.updatedBy ?? "–", when: data.updatedAt ? relative(data.updatedAt, t, locale) : "" })}
            </span>
            <button className="btn btn-sm btn-ghost" onClick={reset}>
              <RotateCcw /> {t("refine.reset")}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
