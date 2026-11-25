import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, Save } from "lucide-react";
import { useState } from "react";
import { api, ApiError } from "../api/client";
import type { Preset, PresetInput, SummaryRequest, TranscribeOptions } from "../api/types";
import { useI18n } from "../i18n";
import { Modal, useConfirm } from "./Modal";
import { templateName, useTemplates } from "./SummaryComposer";
import { useToast } from "./Toast";

/** What a preset holds, as compared with the upload form: the transcription options and the automatic summary. */
export interface PresetValue {
  options: TranscribeOptions;
  summary: SummaryRequest | null;
}

/** Same settings, whatever the key order or the spacing of the vocabulary. */
export function samePresetValue(a: PresetValue, b: PresetValue): boolean {
  const norm = (v: PresetValue) =>
    JSON.stringify({
      o: { ...v.options, vocabulary: v.options.vocabulary.trim() },
      s: v.summary && { templateId: v.summary.templateId, prompt: v.summary.prompt.trim(), outputLanguage: v.summary.outputLanguage },
    });
  return norm(a) === norm(b);
}

export function usePresets() {
  return useQuery({ queryKey: ["presets"], queryFn: api.presets, staleTime: 60_000 });
}

/** One line describing a preset: "Mandarin · 2–6 speakers · 3 terms · summary: Meeting minutes". */
export function usePresetLine(): (v: PresetValue) => string {
  const { t, tMaybe } = useI18n();
  const { data } = useTemplates();
  return (v) => {
    const o = v.options;
    const speakers = !o.diarize
      ? t("upload.speakersOff")
      : o.numSpeakers
        ? t("upload.speakersExactShort", { n: o.numSpeakers })
        : o.minSpeakers && o.maxSpeakers
          ? t("upload.speakersRangeShort", { a: o.minSpeakers, b: o.maxSpeakers })
          : t("upload.speakersAutoShort");
    const terms = o.vocabulary.split(/[,，、\n]+/).filter((w) => w.trim()).length;
    const tpl = v.summary?.templateId ? data?.templates.find((x) => x.id === v.summary!.templateId) : undefined;
    const summary = v.summary ? t("presets.lineSummary", { name: tpl ? templateName(tpl, tMaybe) : t("summary.custom") }) : t("presets.lineNoSummary");
    return [tMaybe(`lang.${o.language}`) ?? o.language, speakers, terms ? t("upload.vocabularyCount", { n: terms }) : null, summary].filter(Boolean).join(" · ");
  };
}

/**
 * On the upload page: choose a preset to fill in the settings, update the one
 * in use after changing them, or keep the current settings as a new one.
 */
export function PresetBar({
  current,
  appliedId,
  onApply,
  onSaved,
}: {
  current: PresetValue;
  appliedId: string | null;
  onApply: (p: Preset | null) => void;
  onSaved: (p: Preset) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const presets = usePresets().data?.presets ?? [];
  const line = usePresetLine();
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const applied = presets.find((p) => p.id === appliedId) ?? null;
  const changed = !!applied && !samePresetValue(applied, current);

  const update = async () => {
    if (!applied) return;
    setBusy(true);
    try {
      const { preset, presets: all } = await api.updatePreset(applied.id, { name: applied.name, isDefault: applied.isDefault, ...current });
      qc.setQueryData(["presets"], { presets: all });
      onSaved(preset);
      toast.show(t("presets.updated", { name: preset.name }));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="preset-bar">
      <div className="preset-bar-row">
        <label className="preset-bar-label" htmlFor="preset-select">
          <Bookmark /> {t("presets.label")}
        </label>
        <select
          id="preset-select"
          className="select preset-select"
          value={appliedId ?? ""}
          onChange={(e) => onApply(presets.find((p) => p.id === e.target.value) ?? null)}
        >
          <option value="">{presets.length ? t("presets.none") : t("presets.noneYet")}</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.isDefault ? t("presets.optionDefault", { name: p.name }) : p.name}
            </option>
          ))}
        </select>
        <span className="preset-bar-actions">
          {changed && (
            <button type="button" className="btn btn-sm btn-ink" onClick={update} disabled={busy}>
              {busy ? <span className="spinner" /> : <Save />} {t("presets.update", { name: applied!.name })}
            </button>
          )}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setSaving(true)}>
            <Save /> {t("presets.saveAs")}
          </button>
        </span>
      </div>
      <p className="field-hint preset-bar-hint">
        {applied ? (changed ? t("presets.changedHint", { name: applied.name }) : line(applied)) : presets.length ? t("presets.pickHint") : t("presets.firstHint")}
      </p>
      {saving && (
        <SavePresetDialog
          value={current}
          firstOne={presets.length === 0}
          onClose={() => setSaving(false)}
          onSaved={(p, all) => {
            qc.setQueryData(["presets"], { presets: all });
            onSaved(p);
            setSaving(false);
            toast.show(t("presets.saved", { name: p.name }));
          }}
        />
      )}
    </div>
  );
}

function SavePresetDialog({
  value,
  firstOne,
  onClose,
  onSaved,
}: {
  value: PresetValue;
  firstOne: boolean;
  onClose: () => void;
  onSaved: (p: Preset, all: Preset[]) => void;
}) {
  const { t } = useI18n();
  const line = usePresetLine();
  const [name, setName] = useState("");
  // The first preset becomes the default unless unticked: that is usually why it is made.
  const [isDefault, setIsDefault] = useState(firstOne);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim()) return setError(t("presets.needName"));
    setBusy(true);
    setError(null);
    try {
      const input: PresetInput = { name: name.trim(), isDefault, ...value };
      const { preset, presets } = await api.createPreset(input);
      onSaved(preset, presets);
    } catch (e) {
      setError(e instanceof ApiError && e.code === "name_taken" ? t("presets.nameTaken") : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t("presets.saveTitle")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn-ink" onClick={save} disabled={busy}>
            {busy && <span className="spinner" />} {t("common.save")}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="preset-name">{t("presets.name")}</label>
        <input
          id="preset-name"
          className="input"
          value={name}
          maxLength={60}
          autoFocus
          placeholder={t("presets.namePlaceholder")}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
          }}
          aria-invalid={!!error}
        />
        {error ? <span className="field-error">{error}</span> : <span className="field-hint">{line(value)}</span>}
      </div>
      <label className="switch">
        <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        <span className="switch-track" />
        <span className="switch-label">{t("presets.makeDefault")}</span>
      </label>
    </Modal>
  );
}

/** Settings: the presets, to make one the default, rename or delete; their contents are changed on the upload page. */
export function PresetManager() {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data, isLoading } = usePresets();
  const line = usePresetLine();
  const [renaming, setRenaming] = useState<Preset | null>(null);
  const presets = data?.presets ?? [];

  const put = async (p: Preset, patch: Partial<PresetInput>, message: string) => {
    try {
      const { presets: all } = await api.updatePreset(p.id, { name: p.name, options: p.options, summary: p.summary, isDefault: p.isDefault, ...patch });
      qc.setQueryData(["presets"], { presets: all });
      toast.show(message);
      return true;
    } catch (e) {
      toast.error(e);
      return false;
    }
  };

  const remove = async (p: Preset) => {
    const ok = await confirm({ title: t("presets.deleteTitle", { name: p.name }), body: t("presets.deleteBody"), confirmLabel: t("common.delete"), danger: true });
    if (!ok) return;
    try {
      const { presets: all } = await api.deletePreset(p.id);
      qc.setQueryData(["presets"], { presets: all });
      toast.show(t("presets.deleted", { name: p.name }));
    } catch (e) {
      toast.error(e);
    }
  };

  if (isLoading) return <div className="skeleton" style={{ height: 64 }} />;
  if (!presets.length) return <p className="muted">{t("presets.emptyManager")}</p>;
  return (
    <>
      <ul className="preset-list">
        {presets.map((p) => (
          <li key={p.id} className="preset-item">
            <div className="preset-item-main">
              <span className="preset-item-name">
                {p.name}
                {p.isDefault && <span className="pill ok preset-default">{t("presets.default")}</span>}
              </span>
              <span className="faint preset-item-line">{line(p)}</span>
            </div>
            <div className="preset-item-actions">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => put(p, { isDefault: !p.isDefault }, p.isDefault ? t("presets.unsetDefaultDone", { name: p.name }) : t("presets.setDefaultDone", { name: p.name }))}
              >
                {p.isDefault ? t("presets.unsetDefault") : t("presets.setDefault")}
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRenaming(p)}>
                {t("presets.rename")}
              </button>
              <button type="button" className="btn btn-sm btn-ghost btn-danger" onClick={() => remove(p)}>
                {t("common.delete")}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {renaming && <RenamePresetDialog preset={renaming} onClose={() => setRenaming(null)} onRename={(name) => put(renaming, { name }, t("presets.renamed", { name }))} />}
    </>
  );
}

function RenamePresetDialog({ preset, onClose, onRename }: { preset: Preset; onClose: () => void; onRename: (name: string) => Promise<boolean> }) {
  const { t } = useI18n();
  const [name, setName] = useState(preset.name);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim() || name.trim() === preset.name) return onClose();
    setBusy(true);
    if (await onRename(name.trim())) onClose();
    setBusy(false);
  };
  return (
    <Modal
      title={t("presets.renameTitle")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn-ink" onClick={submit} disabled={busy || !name.trim()}>
            {t("common.save")}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="preset-rename">{t("presets.name")}</label>
        <input
          id="preset-rename"
          className="input"
          value={name}
          maxLength={60}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </div>
    </Modal>
  );
}
