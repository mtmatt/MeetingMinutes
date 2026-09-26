import { useQuery } from "@tanstack/react-query";
import { ChevronRight, RotateCcw, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { OutputLanguage, SummaryRequest, Template } from "../api/types";
import { useI18n } from "../i18n";

export function useTemplates() {
  return useQuery({ queryKey: ["templates"], queryFn: api.templates, staleTime: 60_000 });
}

export function templateName(tpl: Pick<Template, "id" | "name" | "builtin">, tMaybe: (k: string) => string | undefined) {
  return tpl.builtin ? (tMaybe(`builtin.${tpl.id}.name`) ?? tpl.name) : tpl.name;
}

export function templateDescription(tpl: Pick<Template, "id" | "description" | "builtin">, tMaybe: (k: string) => string | undefined) {
  return tpl.builtin ? (tMaybe(`builtin.${tpl.id}.description`) ?? tpl.description) : tpl.description;
}

export function defaultOutputLanguage(locale: string): OutputLanguage {
  return locale === "en" ? "en" : "zh-TW";
}

/**
 * What to send: a request keeps its templateId only when the prompt is the
 * template's own text. An edited prompt is stored as custom, so later
 * regenerations never mistake it for the (possibly updated) template.
 */
export function normalizeRequest(req: SummaryRequest, templates: Template[]): SummaryRequest {
  const tpl = templates.find((x) => x.id === req.templateId);
  if (tpl && tpl.body.trim() !== req.prompt.trim()) return { ...req, templateId: null };
  return req;
}

/** Where meeting data goes: shown wherever a summary can be started. */
export function DataFlowNote() {
  const { t } = useI18n();
  return (
    <div className="dataflow">
      <ShieldCheck />
      <div className="dataflow-body">
        <strong>{t("privacy.title")}</strong>
        <ul>
          <li>{t("privacy.asr")}</li>
          <li>{t("privacy.summary")}</li>
        </ul>
        <details>
          <summary>{t("privacy.more")}</summary>
          <p>{t("privacy.details")}</p>
        </details>
      </div>
    </div>
  );
}

/** Template chooser, optional prompt customisation, output language. Controlled. */
export function SummaryComposer({ value, onChange }: { value: SummaryRequest; onChange: (v: SummaryRequest) => void }) {
  const { t, tMaybe } = useI18n();
  const { data } = useTemplates();
  const templates = data?.templates ?? [];
  const selected = templates.find((x) => x.id === value.templateId) ?? null;
  // An empty prompt is about to be filled from the template, so it is not "modified".
  const modified = value.prompt.trim() !== "" && (selected ? selected.body.trim() !== value.prompt.trim() : true);
  // Open by default only when the prompt already differs from its template.
  const [open, setOpen] = useState(modified);

  // Fill the prompt from the chosen (or first) template once templates load.
  useEffect(() => {
    if (!value.prompt && templates.length) {
      const first = templates.find((x) => x.id === value.templateId) ?? templates[0]!;
      onChange({ ...value, templateId: first.id, prompt: first.body });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates.length]);

  const pick = (tpl: Template) => onChange({ ...value, templateId: tpl.id, prompt: tpl.body });

  return (
    <div className="composer">
      <div className="field">
        <span className="field-label">{t("upload.template")}</span>
        <div className="template-grid" role="radiogroup" aria-label={t("upload.template")}>
          {templates.map((tpl) => (
            <button
              type="button"
              key={tpl.id}
              role="radio"
              aria-checked={tpl.id === value.templateId}
              className="template-option"
              onClick={() => pick(tpl)}
            >
              <span className="template-option-name">{templateName(tpl, tMaybe)}</span>
              <span className="template-option-desc">{templateDescription(tpl, tMaybe)}</span>
              {!tpl.builtin && <span className="tag">{t("templates.mine")}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="field-label">{t("upload.outputLanguage")}</span>
        <div className="segmented" role="group">
          {(["zh-TW", "en", "auto"] as OutputLanguage[]).map((l) => (
            <button type="button" key={l} aria-pressed={value.outputLanguage === l} onClick={() => onChange({ ...value, outputLanguage: l })}>
              {t(`outLang.${l}`)}
            </button>
          ))}
        </div>
      </div>

      <div className={`disclosure ${open ? "open" : ""}`}>
        <button type="button" className="disclosure-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <ChevronRight />
          <span>{t("upload.customPrompt")}</span>
          {modified ? <span className="pill accent">{t("upload.modified")}</span> : <span className="faint disclosure-hint">{t("upload.customPromptHint")}</span>}
        </button>
        {open && (
          <div className="disclosure-body">
            <textarea
              className="textarea code composer-prompt"
              value={value.prompt}
              onChange={(e) => onChange({ ...value, prompt: e.target.value })}
              rows={10}
              spellCheck={false}
              aria-label={t("upload.prompt")}
            />
            <div className="disclosure-foot">
              <span className="field-hint">{t("upload.promptHint")}</span>
              {modified && selected && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => pick(selected)}>
                  <RotateCcw /> {t("upload.resetPrompt")}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
