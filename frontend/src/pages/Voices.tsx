import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, AudioLines, ChevronDown, Merge, MoreHorizontal, Pencil, ScanSearch, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { ApiError, api } from "../api/client";
import type { VoiceProfile, VoicesState } from "../api/types";
import { Menu } from "../components/Menu";
import { Modal, useConfirm } from "../components/Modal";
import { useToast } from "../components/Toast";
import { useI18n } from "../i18n";
import { duration, initials, monthDay } from "../lib/format";

function Section({ title, lede, children }: { title: string; lede?: string; children: React.ReactNode }) {
  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h2>{title}</h2>
        {lede && <p className="muted">{lede}</p>}
      </div>
      <div className="settings-section-body">{children}</div>
    </section>
  );
}

function Person({
  profile,
  others,
  onChange,
}: {
  profile: VoiceProfile;
  others: VoiceProfile[];
  onChange: (state: VoicesState) => void;
}) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(profile.name);
  const [nameTaken, setNameTaken] = useState(false);
  const [merging, setMerging] = useState(false);
  const [into, setInto] = useState("");
  const [busy, setBusy] = useState(false);

  const n = profile.samples.length;
  const expandable = n > 0 || profile.awaiting.length > 0;
  const facts = [
    n === 0 ? t("voices.noRecordings") : n === 1 ? t("voices.oneRecording") : t("voices.recordings", { n }),
    ...(n ? [t("voices.speech", { t: duration(profile.speechSec, locale) })] : []),
    ...(profile.suggested ? [t("voices.suggestedFor", { n: profile.suggested })] : []),
  ];

  const act = async (fn: () => Promise<VoicesState>, done?: string) => {
    setBusy(true);
    try {
      onChange(await fn());
      if (done) toast.show(done);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === "name_taken") setNameTaken(true);
      else toast.error(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    const next = name.trim();
    if (!next || next === profile.name) return setRenaming(false);
    if (await act(() => api.renameVoice(profile.id, next), t("common.saved"))) setRenaming(false);
  };
  const merge = async () => {
    if (into && (await act(() => api.mergeVoice(profile.id, into)))) setMerging(false);
  };
  const forget = async () => {
    const ok = await confirm({
      title: t("voices.deleteTitle", { name: profile.name }),
      body: t("voices.deleteBody"),
      confirmLabel: t("voices.delete"),
      danger: true,
    });
    if (ok) await act(() => api.deleteVoice(profile.id), t("voices.deleted"));
  };

  return (
    <li className="voice-person">
      <div className="voice-person-head">
        <span className="avatar" style={{ ["--size" as string]: "36px" }} aria-hidden="true">
          {initials(profile.name)}
        </span>
        <button className="voice-person-main" onClick={() => setOpen((v) => !v)} aria-expanded={open} disabled={!expandable}>
          <span className="voice-person-name">
            {profile.name}
            {profile.recognised > 0 && <span className="pill accent">{t("voices.awaiting", { n: profile.recognised })}</span>}
            {!profile.consistent && <AlertTriangle className="voice-person-warn" aria-label={t("voices.inconsistent")} />}
          </span>
          <span className="voice-person-facts faint">{facts.join(" · ")}</span>
        </button>
        {expandable && (
          <button className={`icon-btn sm voice-person-toggle ${open ? "open" : ""}`} onClick={() => setOpen((v) => !v)} aria-label={t("voices.recordings", { n })}>
            <ChevronDown />
          </button>
        )}
        <Menu
          trigger={({ toggle, open: menuOpen }) => (
            <button className="icon-btn sm" onClick={toggle} aria-expanded={menuOpen} aria-haspopup="menu" aria-label={profile.name}>
              <MoreHorizontal />
            </button>
          )}
        >
          {(close) => (
            <>
              <button
                className="menu-item"
                onClick={() => {
                  close();
                  setName(profile.name);
                  setNameTaken(false);
                  setRenaming(true);
                }}
              >
                <Pencil /> {t("voices.rename")}
              </button>
              {others.length > 0 && (
                <button
                  className="menu-item"
                  onClick={() => {
                    close();
                    setInto(others[0]!.id);
                    setMerging(true);
                  }}
                >
                  <Merge /> {t("voices.merge")}
                </button>
              )}
              <div className="menu-sep" />
              <button
                className="menu-item danger"
                onClick={() => {
                  close();
                  void forget();
                }}
              >
                <Trash2 /> {t("voices.delete")}
              </button>
            </>
          )}
        </Menu>
      </div>

      {!profile.consistent && (
        <div className="callout warn voice-person-callout">
          <AlertTriangle />
          <span>{t("voices.inconsistent")}</span>
        </div>
      )}

      {open && expandable && (
        <ul className="voice-samples">
          {profile.awaiting.map((a) => (
            <li key={`${a.meetingId}:${a.speakerKey}`} className="is-awaiting">
              <AudioLines className="voice-sample-icon" />
              <div className="voice-sample-main">
                <Link to={`/m/${a.meetingId}`} title={t("voices.openRecording")}>
                  {a.meetingTitle}
                </Link>
                <span className="pill accent">{t("voices.awaitingOne")}</span>
              </div>
              {a.score != null && <span className="mono faint voice-sample-meta">{Math.round(a.score * 100)}%</span>}
            </li>
          ))}
          {profile.samples.map((s) => (
            <li key={s.id}>
              <AudioLines className="voice-sample-icon" />
              <div className="voice-sample-main">
                {s.meetingId ? (
                  <Link to={`/m/${s.meetingId}`} title={t("voices.openRecording")}>
                    {s.meetingTitle}
                  </Link>
                ) : (
                  <span className="faint">{t("voices.deletedRecording")}</span>
                )}
                <span className="faint">
                  {s.speakerName ? t("voices.asSpeaker", { name: s.speakerName }) : s.meetingId ? t("voices.detached") : ""}
                </span>
              </div>
              <span className="mono faint voice-sample-meta">
                {duration(s.speechSec, locale)} · {monthDay(s.createdAt, locale)}
              </span>
              <button
                className="icon-btn sm"
                title={t("voices.removeSample")}
                aria-label={t("voices.removeSample")}
                disabled={busy}
                onClick={() => void act(() => api.deleteVoiceSample(profile.id, s.id))}
              >
                <X />
              </button>
            </li>
          ))}
        </ul>
      )}

      {renaming && (
        <Modal
          title={t("voices.rename")}
          onClose={() => setRenaming(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setRenaming(false)}>
                {t("common.cancel")}
              </button>
              <button className="btn btn-ink" onClick={rename} disabled={busy || !name.trim()}>
                {t("common.save")}
              </button>
            </>
          }
        >
          <div className="field">
            <label htmlFor={`voice-name-${profile.id}`}>{t("voices.renamePrompt")}</label>
            <input
              id={`voice-name-${profile.id}`}
              className="input"
              value={name}
              maxLength={80}
              onChange={(e) => {
                setName(e.target.value);
                setNameTaken(false);
              }}
              onKeyDown={(e) => e.key === "Enter" && rename()}
            />
            <span className={nameTaken ? "field-error" : "field-hint"}>{nameTaken ? t("voices.nameTaken") : t("voices.renameNote")}</span>
          </div>
        </Modal>
      )}

      {merging && (
        <Modal
          title={t("voices.mergeTitle", { name: profile.name })}
          onClose={() => setMerging(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setMerging(false)}>
                {t("common.cancel")}
              </button>
              <button className="btn btn-ink" onClick={merge} disabled={busy || !into}>
                {t("voices.mergeDo")}
              </button>
            </>
          }
        >
          <p className="muted" style={{ marginBottom: 16 }}>
            {t("voices.mergeBody", { name: profile.name })}
          </p>
          <div className="field">
            <label htmlFor={`voice-into-${profile.id}`}>{t("voices.mergeInto")}</label>
            <select id={`voice-into-${profile.id}`} className="select" value={into} onChange={(e) => setInto(e.target.value)}>
              {others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
        </Modal>
      )}
    </li>
  );
}

export function VoicesPage() {
  const { t } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["voices"], queryFn: api.voices });
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const update = (state: VoicesState) => {
    qc.setQueryData(["voices"], state);
    // Speaker names in open meetings may have changed.
    void qc.invalidateQueries({ queryKey: ["meeting"] });
  };

  const toggle = async (enabled: boolean) => {
    try {
      update(await api.voiceSettings(enabled));
    } catch (e) {
      toast.error(e);
    }
  };

  const scan = async () => {
    setBusy(true);
    setResult(null);
    try {
      const { outcome, ...state } = await api.scanVoices();
      update(state);
      const parts: string[] = [];
      if (outcome.remembered || outcome.recognised) parts.push(t("voices.scanResult", outcome));
      if (outcome.queued) parts.push(t("voices.scanQueued", { n: outcome.queued }));
      setResult(parts.join(" ") || t("voices.scanNothing"));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const pending = (data?.scan.queued ?? 0) + (data?.scan.running ?? 0);
  const profiles = data?.profiles ?? [];

  return (
    <div className="settings voices-page">
      <div className="page-head">
        <div>
          <div className="smallcaps eyebrow">{t("voices.eyebrow")}</div>
          <h1>{t("voices.title")}</h1>
          <p className="lede">{t("voices.lede")}</p>
        </div>
      </div>
      <hr className="rule-double" />

      <Section title={t("voices.recognition")} lede={t("voices.recognitionLede")}>
        <div className="settings-form">
          <label className="switch">
            <input type="checkbox" checked={data?.enabled ?? false} disabled={!data} onChange={(e) => void toggle(e.target.checked)} />
            <span className="switch-track" />
            <span className="switch-label">{t("voices.enabled")}</span>
          </label>
          <p className="field-hint">{t("voices.enabledHint")}</p>
          <div className="voices-how">
            <div className="smallcaps">{t("voices.howTitle")}</div>
            <ol>
              <li>{t("voices.how1")}</li>
              <li>{t("voices.how2")}</li>
              <li>{t("voices.how3")}</li>
            </ol>
          </div>
        </div>
      </Section>

      <Section title={t("voices.pastTitle")} lede={t("voices.pastLede")}>
        <div className="settings-form">
          <div className="voices-scan">
            <button className="btn btn-ink" onClick={scan} disabled={busy || !data?.enabled}>
              {busy ? <span className="spinner" /> : <ScanSearch />} {t("voices.scan")}
            </button>
            {pending > 0 && (
              <span className="pill info">
                <span className="dot" /> {t("voices.scanning", { n: pending })}
              </span>
            )}
          </div>
          {data && !data.enabled && <p className="field-hint">{t("voices.scanOff")}</p>}
          {data && data.scan.failed > 0 && pending === 0 && (
            <div className="callout warn">
              <AlertTriangle />
              <span>
                {t("voices.scanFailed", { n: data.scan.failed })}
                {data.scan.error && <span className="voices-scan-error mono">{data.scan.error}</span>}
              </span>
            </div>
          )}
          {result && <p className="muted">{result}</p>}
        </div>
      </Section>

      <Section title={t("voices.people")} lede={profiles.length ? t("voices.peopleLede") : undefined}>
        {isLoading ? (
          <div className="skeleton" style={{ height: 64, maxWidth: 640 }} />
        ) : profiles.length === 0 ? (
          <div className="empty voices-empty">
            <AudioLines />
            <h3>{t("voices.emptyTitle")}</h3>
            <p>{t("voices.emptyBody")}</p>
          </div>
        ) : (
          <ul className="voice-people">
            {profiles.map((p) => (
              <Person key={p.id} profile={p} others={profiles.filter((o) => o.id !== p.id)} onChange={update} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
