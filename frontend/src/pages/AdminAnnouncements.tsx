import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Megaphone, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "../api/client";
import type { AdminAnnouncement, AnnouncementAudience, AnnouncementInput, AnnouncementLevel } from "../api/types";
import { AnnouncementMarkdown } from "../components/Announcements";
import { Modal, useConfirm } from "../components/Modal";
import { useToast } from "../components/Toast";
import { useI18n, type TKey } from "../i18n";
import { dateTime } from "../lib/format";

const LEVELS: AnnouncementLevel[] = ["info", "warning", "critical"];
const AUDIENCES: AnnouncementAudience[] = ["users", "everyone", "prepaid", "exempt", "admins"];
const STATUS_PILL = { scheduled: "", active: "ok", ended: "" } as const;
const TITLE_MAX = 120;
const BODY_MAX = 10_000;

/** "2026-11-27T21:30" in this browser's time zone, for <input type="datetime-local">. */
function toLocalInput(ms: number | null): string {
  if (ms == null) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fromLocalInput(v: string): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Admin → Announcements: write, schedule and remove what people see at the top of the site. */
export function AdminAnnouncements() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["admin", "announcements"], queryFn: api.adminAnnouncements, refetchInterval: 30_000 });
  const [editing, setEditing] = useState<AdminAnnouncement | "new" | null>(null);

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["admin", "announcements"] }), qc.invalidateQueries({ queryKey: ["announcements"] })]);

  const remove = async (a: AdminAnnouncement) => {
    const ok = await confirm({ title: t("announce.deleteTitle", { title: a.title }), body: t("announce.deleteBody"), confirmLabel: t("common.delete"), danger: true });
    if (!ok) return;
    try {
      await api.adminDeleteAnnouncement(a.id);
      await refresh();
      toast.show(t("announce.deleted"));
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <section className="card system-card admin-announce">
      <div className="admin-announce-head">
        <h3 className="system-h">
          <Megaphone /> {t("announce.adminTitle")}
        </h3>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing("new")}>
          <Plus /> {t("announce.add")}
        </button>
      </div>
      <p className="muted admin-announce-lede">{t("announce.adminLede")}</p>
      {!data ? (
        <div className="skeleton" style={{ height: 120 }} />
      ) : data.announcements.length === 0 ? (
        <p className="faint">{t("announce.adminNone")}</p>
      ) : (
        <ul className="admin-announce-list">
          {data.announcements.map((a) => (
            <li key={a.id} className={a.status === "ended" ? "is-ended" : ""}>
              <div className="admin-announce-main">
                <span className="admin-announce-title">
                  <span className={`announce-dot announce-dot-${a.level}`} aria-hidden="true" />
                  {a.title}
                </span>
                <span className="faint admin-announce-meta">
                  {t(`announce.audience_${a.audience}` as TKey)} · {t(`announce.level_${a.level}` as TKey)}
                  {!a.dismissible && ` · ${t("announce.pinned")}`}
                  {" · "}
                  {a.startsAt ? t("announce.fromWhen", { when: dateTime(a.startsAt, locale) }) : t("announce.fromCreated", { when: dateTime(a.createdAt, locale) })}
                  {a.endsAt ? ` – ${dateTime(a.endsAt, locale)}` : ""}
                </span>
              </div>
              <div className="admin-announce-state">
                <span className={`pill ${STATUS_PILL[a.status]}`}>
                  <span className="dot" />
                  {t(`announce.status_${a.status}` as TKey)}
                </span>
                {a.audience !== "everyone" && a.status !== "scheduled" && (
                  <span className="faint admin-announce-seen">{t("announce.seenBy", { n: a.seenBy, of: a.audienceSize })}</span>
                )}
              </div>
              <div className="admin-announce-actions">
                <button type="button" className="icon-btn" onClick={() => setEditing(a)} aria-label={t("announce.edit")} title={t("announce.edit")}>
                  <Pencil />
                </button>
                <button type="button" className="icon-btn" onClick={() => remove(a)} aria-label={t("common.delete")} title={t("common.delete")}>
                  <Trash2 />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <Editor
          existing={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (created) => {
            setEditing(null);
            await refresh();
            toast.show(created ? t("announce.published") : t("common.saved"));
          }}
        />
      )}
    </section>
  );
}

function Editor({ existing, onClose, onSaved }: { existing: AdminAnnouncement | null; onClose: () => void; onSaved: (created: boolean) => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [form, setForm] = useState<AnnouncementInput>(
    existing
      ? {
          title: existing.title,
          body: existing.body,
          level: existing.level,
          audience: existing.audience,
          startsAt: existing.startsAt,
          endsAt: existing.endsAt,
          dismissible: existing.dismissible,
        }
      : { title: "", body: "", level: "info", audience: "users", startsAt: null, endsAt: null, dismissible: true },
  );
  const [notifyAgain, setNotifyAgain] = useState(false);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const rangeOk = form.startsAt == null || form.endsAt == null || form.endsAt > form.startsAt;
  const ok = form.title.trim().length > 0 && rangeOk;

  const save = async () => {
    setBusy(true);
    try {
      if (existing) await api.adminUpdateAnnouncement(existing.id, { ...form, notifyAgain });
      else await api.adminCreateAnnouncement(form);
      onSaved(!existing);
    } catch (e) {
      toast.error(e);
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title={existing ? t("announce.editTitle") : t("announce.addTitle")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy || !ok}>
            {busy && <span className="spinner" />} {existing ? t("common.save") : t("announce.publish")}
          </button>
        </>
      }
    >
      <div className="announce-form">
        <div className="field">
          <label htmlFor="ann-title">{t("announce.fieldTitle")}</label>
          <input id="ann-title" className="input" value={form.title} maxLength={TITLE_MAX} autoFocus onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </div>
        <div className="field">
          <div className="announce-body-head">
            <label htmlFor="ann-body">{t("announce.fieldBody")}</label>
            <div className="segmented" role="group">
              <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>
                {t("announce.write")}
              </button>
              <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
                {t("announce.preview")}
              </button>
            </div>
          </div>
          {preview ? (
            <div className="announce-preview">
              <div className={`announce announce-${form.level}`}>
                <div className="announce-text">
                  <strong className="announce-title">{form.title || t("announce.fieldTitle")}</strong>
                  {form.body.trim() && <AnnouncementMarkdown body={form.body} />}
                </div>
              </div>
            </div>
          ) : (
            <textarea
              id="ann-body"
              className="textarea"
              rows={7}
              maxLength={BODY_MAX}
              value={form.body}
              placeholder={t("announce.bodyPlaceholder")}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
            />
          )}
          <span className="field-hint">{t("announce.bodyHint")}</span>
        </div>
        <div className="announce-form-row">
          <div className="field">
            <span className="field-label">{t("announce.fieldLevel")}</span>
            <div className="segmented" role="group">
              {LEVELS.map((l) => (
                <button key={l} type="button" aria-pressed={form.level === l} onClick={() => setForm({ ...form, level: l })}>
                  {t(`announce.level_${l}` as TKey)}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label htmlFor="ann-audience">{t("announce.fieldAudience")}</label>
            <select id="ann-audience" className="select" value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value as AnnouncementAudience })}>
              {AUDIENCES.map((a) => (
                <option key={a} value={a}>
                  {t(`announce.audience_${a}` as TKey)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="announce-form-row">
          <div className="field">
            <label htmlFor="ann-start">{t("announce.fieldStart")}</label>
            <input id="ann-start" className="input" type="datetime-local" value={toLocalInput(form.startsAt)} onChange={(e) => setForm({ ...form, startsAt: fromLocalInput(e.target.value) })} />
            <span className="field-hint">{t("announce.startHint")}</span>
          </div>
          <div className="field">
            <label htmlFor="ann-end">{t("announce.fieldEnd")}</label>
            <input
              id="ann-end"
              className="input"
              type="datetime-local"
              value={toLocalInput(form.endsAt)}
              aria-invalid={!rangeOk}
              onChange={(e) => setForm({ ...form, endsAt: fromLocalInput(e.target.value) })}
            />
            <span className={rangeOk ? "field-hint" : "field-error"}>{rangeOk ? t("announce.endHint") : t("announce.endBeforeStart")}</span>
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={!form.dismissible} onChange={(e) => setForm({ ...form, dismissible: !e.target.checked })} />
          <span>{t("announce.pinnedLabel")}</span>
        </label>
        {existing && (
          <label className="check">
            <input type="checkbox" checked={notifyAgain} onChange={(e) => setNotifyAgain(e.target.checked)} />
            <span>{t("announce.notifyAgain")}</span>
          </label>
        )}
      </div>
    </Modal>
  );
}
