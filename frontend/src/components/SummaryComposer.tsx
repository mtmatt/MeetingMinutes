import { useQuery } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { useEffect } from "react";
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

/** Template chooser + editable prompt + output language. Controlled component. */
export function SummaryComposer({ value, onChange }: { value: SummaryRequest; onChange: (v: SummaryRequest) => void }) {
  const { t, tMaybe } = useI18n();
  const { data } = useTemplates();
  const templates = data?.templates ?? [];
  const selected = templates.find((x) => x.id === value.templateId) ?? null;
  const modified = selected ? selected.body.trim() !== value.prompt.trim() : false;

  // Fill the prompt from the default template once templates load.
  useEffect(() => {
    if (!value.prompt && templates.length) {
      const first = templates.find((x) => x.id === value.templateId) ?? templates[0]!;
      onChange({ ...value, templateId: first.id, prompt: first.body });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates.length]);

  const pick = (tpl: Template) => {
    onChange({ ...value, templateId: tpl.id, prompt: tpl.body });
  };

  return (
    <div className="composer">
      <div className="field">
        <span className="field-label">{t("upload.template")}</span>
        <div className="template-grid" role="radiogroup">
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
        <div className="field-label">
          <span>
            {t("upload.prompt")} {modified && <span className="pill accent" style={{ height: 20, marginLeft: 6 }}>{t("upload.modified")}</span>}
          </span>
          {modified && selected && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => pick(selected)}>
              <RotateCcw /> {t("upload.resetPrompt")}
            </button>
          )}
        </div>
        <textarea
          className="textarea code composer-prompt"
          value={value.prompt}
          onChange={(e) => onChange({ ...value, prompt: e.target.value })}
          rows={10}
          spellCheck={false}
        />
        <span className="field-hint">{t("upload.promptHint")}</span>
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
    </div>
  );
}
