import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useConfirm } from "../components/Modal";
import { useToast } from "../components/Toast";
import { useI18n } from "../i18n";
import { relative } from "../lib/format";
import { splitTerms } from "../lib/terms";

type Draft = { id: string | null; name: string; terms: string };

export function useGlossaries() {
  return useQuery({ queryKey: ["glossaries"], queryFn: api.glossaries, staleTime: 60_000 });
}

/** The 2,000-character budget of a recording's vocabulary, as the terms would fill it. */
const budgetOf = (terms: string[]) => terms.join(", ").length;

/**
 * Lists of terms (names, products, acronyms) kept for adding a recording:
 * the upload page adds a list to the recording's vocabulary in one click.
 */
export function GlossariesPage() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data, isLoading } = useGlossaries();
  const lists = data?.glossaries ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const selected = lists.find((g) => g.id === selectedId) ?? null;
  const writingNew = draft !== null && draft.id === null;

  useEffect(() => {
    if (!selectedId && !writingNew && lists.length) setSelectedId(lists[0]!.id);
  }, [lists, selectedId, writingNew]);

  useEffect(() => {
    if (selected) setDraft({ id: selected.id, name: selected.name, terms: selected.terms.join("\n") });
  }, [selected?.id, selected?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (writingNew) nameRef.current?.focus();
  }, [writingNew]);

  const terms = draft ? splitTerms(draft.terms) : [];
  const used = budgetOf(terms);
  const tooLong = used > 2000;
  const dirty = !!draft && (draft.id === null || !selected || draft.name !== selected.name || terms.join("\n") !== selected.terms.join("\n"));

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const payload = { name: draft.name.trim(), terms: terms.join("\n") };
      const res = draft.id ? await api.updateGlossary(draft.id, payload) : await api.createGlossary(payload);
      await qc.invalidateQueries({ queryKey: ["glossaries"] });
      setSelectedId(res.glossary.id);
      toast.show(t("common.saved"));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!draft?.id) return;
    if (!(await confirm({ title: t("glossaries.deleteTitle", { name: draft.name }), body: t("glossaries.deleteBody"), confirmLabel: t("common.delete"), danger: true }))) return;
    try {
      await api.deleteGlossary(draft.id);
      setSelectedId(null);
      setDraft(null);
      await qc.invalidateQueries({ queryKey: ["glossaries"] });
    } catch (e) {
      toast.error(e);
    }
  };

  const startNew = () => {
    setSelectedId(null);
    setDraft({ id: null, name: "", terms: "" });
  };

  return (
    <div className="templates glossaries">
      <div className="page-head">
        <div>
          <h1>{t("glossaries.title")}</h1>
          <p className="lede">{t("glossaries.lede")}</p>
        </div>
        <button className="btn btn-primary" onClick={startNew}>
          <Plus /> {t("glossaries.new")}
        </button>
      </div>
      <hr className="rule-double" />

      <div className="tpl-layout">
        <nav className="tpl-list">
          <div className="smallcaps tpl-list-label">{t("glossaries.mine")}</div>
          {isLoading && <div className="skeleton" style={{ height: 120 }} />}
          {!isLoading && lists.length === 0 && !writingNew && <p className="faint tpl-empty">{t("glossaries.empty")}</p>}
          {lists.map((g) => (
            <button key={g.id} className={`tpl-item ${g.id === selectedId ? "selected" : ""}`} onClick={() => setSelectedId(g.id)}>
              <span className="tpl-item-name">{g.name}</span>
              <span className="tpl-item-desc">{g.terms.slice(0, 6).join("、") + (g.terms.length > 6 ? "…" : "")}</span>
            </button>
          ))}
        </nav>

        <section className="tpl-editor card">
          {draft ? (
            <>
              <div className="field">
                <label htmlFor="gl-name">{t("glossaries.name")}</label>
                <input
                  ref={nameRef}
                  id="gl-name"
                  className="input input-title"
                  value={draft.name}
                  maxLength={80}
                  placeholder={t("glossaries.namePlaceholder")}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </div>
              <div className="field">
                <label htmlFor="gl-terms">
                  <span>{t("glossaries.terms")}</span>
                  <span className={`mono ${tooLong ? "field-error" : "faint"}`}>
                    {t("glossaries.count", { n: terms.length })} · {used.toLocaleString()} / 2,000
                  </span>
                </label>
                <textarea
                  id="gl-terms"
                  className="textarea"
                  rows={14}
                  value={draft.terms}
                  placeholder={t("glossaries.termsPlaceholder")}
                  onChange={(e) => setDraft({ ...draft, terms: e.target.value })}
                />
                <span className="field-hint">{t("glossaries.termsHint")}</span>
              </div>
              <div className="tpl-actions">
                {draft.id && (
                  <button className="btn btn-danger btn-ghost" onClick={remove}>
                    <Trash2 /> {t("common.delete")}
                  </button>
                )}
                <span style={{ flex: 1 }} />
                {selected && <span className="faint" style={{ fontSize: "var(--step--1)" }}>{relative(selected.updatedAt, t, locale)}</span>}
                <button className="btn btn-ink" onClick={save} disabled={busy || !dirty || !draft.name.trim() || terms.length === 0 || tooLong}>
                  {busy && <span className="spinner" />} {t("common.save")}
                </button>
              </div>
            </>
          ) : (
            <div className="empty">
              <p>{lists.length ? t("glossaries.select") : t("glossaries.emptyEditor")}</p>
              {!lists.length && !isLoading && (
                <button className="btn" onClick={startNew}>
                  <Plus /> {t("glossaries.new")}
                </button>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
