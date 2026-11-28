import { useQueryClient } from "@tanstack/react-query";
import { BookA, Check, Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import { useI18n } from "../i18n";
import { addTerms, containsAll, removeTerms, splitTerms } from "../lib/terms";
import { useGlossaries } from "../pages/Glossaries";
import { Modal } from "./Modal";
import { useToast } from "./Toast";

/**
 * Above the vocabulary field: the person's saved term lists, each added (or
 * taken out again) in one click, and saving what was typed as a new list.
 */
export function GlossaryPicker({ vocabulary, onChange }: { vocabulary: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  const { data } = useGlossaries();
  const lists = data?.glossaries ?? [];
  const typed = splitTerms(vocabulary);
  // Typed terms that no saved list has yet: worth offering to keep.
  const known = new Set(lists.flatMap((g) => g.terms.map((x) => x.toLowerCase())));
  const unsaved = typed.filter((x) => !known.has(x.toLowerCase()));
  const [saving, setSaving] = useState(false);

  return (
    <div className="glossary-picker">
      {lists.length > 0 ? (
        <div className="glossary-chips" role="group" aria-label={t("glossaries.pickerLabel")}>
          {lists.map((g) => {
            const on = containsAll(vocabulary, g.terms);
            return (
              <button
                key={g.id}
                type="button"
                className={`chip ${on ? "is-on" : ""}`}
                aria-pressed={on}
                title={g.terms.join("、")}
                onClick={() => onChange(on ? removeTerms(vocabulary, g.terms) : addTerms(vocabulary, g.terms))}
              >
                {on ? <Check /> : <Plus />}
                {g.name}
                <span className="chip-count">{g.terms.length}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <span className="faint">{t("glossaries.pickerEmpty")}</span>
      )}
      <span className="glossary-picker-links">
        {unsaved.length > 0 && (
          <button type="button" className="link-btn" onClick={() => setSaving(true)}>
            {t("glossaries.saveTyped", { n: unsaved.length })}
          </button>
        )}
        <Link to="/glossaries" className="link-btn" target="_blank" rel="noopener">
          <BookA /> {t("glossaries.manage")}
        </Link>
      </span>
      {saving && <SaveListDialog terms={unsaved} onClose={() => setSaving(false)} />}
    </div>
  );
}

function SaveListDialog({ terms, onClose }: { terms: string[]; onClose: () => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.createGlossary({ name: name.trim(), terms: terms.join("\n") });
      await qc.invalidateQueries({ queryKey: ["glossaries"] });
      toast.show(t("glossaries.savedAs", { name: name.trim() }));
      onClose();
    } catch (e) {
      toast.error(e);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("glossaries.saveTitle")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn-ink" onClick={() => void save()} disabled={busy || !name.trim()}>
            {busy && <span className="spinner" />} {t("common.save")}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="gl-save-name">{t("glossaries.name")}</label>
        <input
          id="gl-save-name"
          className="input"
          value={name}
          maxLength={80}
          placeholder={t("glossaries.namePlaceholder")}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && name.trim() && void save()}
        />
        <span className="field-hint">{terms.join("、")}</span>
      </div>
    </Modal>
  );
}
