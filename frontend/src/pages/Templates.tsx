import { useQueryClient } from "@tanstack/react-query";
import { Copy, Lock, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { Template } from "../api/types";
import { useConfirm } from "../components/Modal";
import { templateDescription, templateName, useTemplates } from "../components/SummaryComposer";
import { useToast } from "../components/Toast";
import { useI18n } from "../i18n";
import { relative } from "../lib/format";

type Draft = { id: string | null; name: string; description: string; body: string };

export function TemplatesPage() {
  const { t, tMaybe, locale } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data, isLoading } = useTemplates();
  const templates = data?.templates ?? [];
  const builtins = templates.filter((x) => x.builtin);
  const mine = templates.filter((x) => !x.builtin);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const selected = templates.find((x) => x.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId && templates.length) setSelectedId(templates[0]!.id);
  }, [templates, selectedId]);

  useEffect(() => {
    if (selected && !selected.builtin) {
      setDraft({ id: selected.id, name: selected.name, description: selected.description, body: selected.body });
    } else if (selected) {
      setDraft(null);
    }
  }, [selected?.id, selected?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty =
    draft && (draft.id === null || !selected || draft.name !== selected.name || draft.description !== selected.description || draft.body !== selected.body);

  const refresh = () => qc.invalidateQueries({ queryKey: ["templates"] });

  const duplicate = (tpl: Template) => {
    setSelectedId(null);
    setDraft({
      id: null,
      name: t("templates.copyOf", { name: templateName(tpl, tMaybe) }),
      description: templateDescription(tpl, tMaybe),
      body: tpl.body,
    });
  };

  const startNew = () => {
    setSelectedId(null);
    setDraft({ id: null, name: "", description: "", body: "" });
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const payload = { name: draft.name.trim(), description: draft.description.trim(), body: draft.body.trim() };
      const res = draft.id ? await api.updateTemplate(draft.id, payload) : await api.createTemplate(payload);
      await refresh();
      setSelectedId(res.template.id);
      toast.show(t("common.saved"));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!draft?.id) return;
    if (!(await confirm({ title: t("templates.deleteTitle"), confirmLabel: t("common.delete"), danger: true }))) return;
    try {
      await api.deleteTemplate(draft.id);
      setSelectedId(null);
      setDraft(null);
      await refresh();
    } catch (e) {
      toast.error(e);
    }
  };

  const Item = ({ tpl }: { tpl: Template }) => (
    <button className={`tpl-item ${tpl.id === selectedId ? "selected" : ""}`} onClick={() => setSelectedId(tpl.id)}>
      <span className="tpl-item-name">
        {tpl.builtin && <Lock />}
        {templateName(tpl, tMaybe)}
      </span>
      <span className="tpl-item-desc">{templateDescription(tpl, tMaybe) || "—"}</span>
    </button>
  );

  return (
    <div className="templates">
      <div className="page-head">
        <div>
          <div className="smallcaps eyebrow">{t("nav.templates")}</div>
          <h1>{t("templates.title")}</h1>
          <p className="lede">{t("templates.lede")}</p>
        </div>
        <button className="btn btn-primary" onClick={startNew}>
          <Plus /> {t("templates.new")}
        </button>
      </div>
      <hr className="rule-double" />

      <div className="tpl-layout">
        <nav className="tpl-list">
          <div className="smallcaps tpl-list-label">{t("templates.builtin")}</div>
          {isLoading && <div className="skeleton" style={{ height: 120 }} />}
          {builtins.map((tpl) => (
            <Item key={tpl.id} tpl={tpl} />
          ))}
          <div className="smallcaps tpl-list-label">{t("templates.mine")}</div>
          {mine.length === 0 && <p className="faint tpl-empty">{t("templates.empty")}</p>}
          {mine.map((tpl) => (
            <Item key={tpl.id} tpl={tpl} />
          ))}
        </nav>

        <section className="tpl-editor card">
          {draft ? (
            <>
              <div className="field">
                <label htmlFor="tpl-name">{t("templates.name")}</label>
                <input id="tpl-name" className="input input-title" value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="tpl-desc">
                  <span>
                    {t("templates.description")} <span className="faint">· {t("common.optional")}</span>
                  </span>
                </label>
                <input id="tpl-desc" className="input" value={draft.description} maxLength={300} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="tpl-body">
                  <span>{t("templates.body")}</span>
                  <span className="faint mono">{draft.body.length.toLocaleString()} / 20,000</span>
                </label>
                <textarea
                  id="tpl-body"
                  className="textarea code"
                  rows={18}
                  value={draft.body}
                  maxLength={20000}
                  spellCheck={false}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                />
                <span className="field-hint">{t("upload.promptHint")}</span>
              </div>
              <div className="tpl-actions">
                {draft.id && (
                  <button className="btn btn-danger btn-ghost" onClick={remove}>
                    <Trash2 /> {t("common.delete")}
                  </button>
                )}
                <span style={{ flex: 1 }} />
                {selected && !selected.builtin && <span className="faint" style={{ fontSize: "var(--step--1)" }}>{relative(selected.updatedAt, t, locale)}</span>}
                <button className="btn btn-ink" onClick={save} disabled={busy || !dirty || !draft.name.trim() || !draft.body.trim()}>
                  {busy && <span className="spinner" />} {t("common.save")}
                </button>
              </div>
            </>
          ) : selected ? (
            <>
              <div className="tpl-readonly-head">
                <div>
                  <span className="tag">
                    <Lock style={{ width: 11, height: 11 }} /> {t("templates.builtin")}
                  </span>
                  <h2>{templateName(selected, tMaybe)}</h2>
                  <p className="muted">{templateDescription(selected, tMaybe)}</p>
                </div>
                <button className="btn" onClick={() => duplicate(selected)}>
                  <Copy /> {t("templates.duplicate")}
                </button>
              </div>
              <pre className="tpl-body mono">{selected.body}</pre>
              <p className="faint" style={{ fontSize: "var(--step--1)" }}>{t("templates.readOnly")}</p>
            </>
          ) : (
            <div className="empty">
              <p>{t("templates.select")}</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
