import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Cloud, Copy, Laptop, Plus, Server, SlidersHorizontal, Trash2, Zap } from "lucide-react";
import { useState } from "react";
import { api } from "../api/client";
import type { AsrEngine, DiarizationEngine, TranscriberSettings, WorkerKey, WorkerProfile, WorkerWake } from "../api/types";
import { Modal, useConfirm } from "../components/Modal";
import { useToast } from "../components/Toast";
import { useI18n } from "../i18n";
import { relative, until } from "../lib/format";

/**
 * Admin → System: workers on other machines (an NVIDIA box, a Mac). Each has
 * its own credential, from a one-time enrollment code shown once here, and
 * can be revoked on its own. Those machines only connect out to this server.
 */
export function WorkerKeys() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["admin", "worker-keys"], queryFn: api.adminWorkerKeys, refetchInterval: 15_000 });
  const profiles = useQuery({ queryKey: ["admin", "worker-profiles"], queryFn: api.adminWorkerProfiles });
  // Site-wide settings, and what each connected worker reports (capabilities, keys).
  const transcriber = useQuery({ queryKey: ["admin", "transcriber"], queryFn: api.adminTranscriber, refetchInterval: 20_000 });
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<{ name: string; code: string; expiresAt: number } | null>(null);

  const revoke = async (k: WorkerKey) => {
    const ok = await confirm({
      title: k.pending ? t("workers.cancelTitle", { name: k.name }) : t("workers.revokeTitle", { name: k.name }),
      body: k.pending ? t("workers.cancelBody") : t("workers.revokeBody"),
      confirmLabel: k.pending ? t("workers.cancel") : t("workers.revoke"),
      danger: !k.pending,
    });
    if (!ok) return;
    try {
      const res = await api.adminRevokeWorkerKey(k.id);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["admin", "worker-keys"] }),
        qc.invalidateQueries({ queryKey: ["admin", "worker-profiles"] }),
        qc.invalidateQueries({ queryKey: ["auth"] }),
      ]);
      toast.show(res.requeued ? t("workers.revokedRequeued", { n: res.requeued }) : t("workers.revoked"));
    } catch (e) {
      toast.error(e);
    }
  };

  const keys = data?.keys ?? [];
  const reported = transcriber.data?.workers ?? [];
  const keyIds = keys.map((k) => k.id);
  /** The connected workers of a machine: a key's own, or (local) those of no key. */
  const workersOf = (id: string) =>
    reported.filter((w) => (id === "local" ? !keyIds.some((k) => w.id === k || w.id.startsWith(`${k}-`)) : w.id === id || w.id.startsWith(`${id}-`)));
  const localOnline = workersOf("local").length > 0;
  return (
    <section className="card system-card worker-keys">
      <div className="worker-keys-head">
        <h3 className="system-h">
          <Laptop /> {t("workers.title")}
        </h3>
        <button className="btn btn-sm" onClick={() => setAdding(true)}>
          <Plus /> {t("workers.add")}
        </button>
      </div>
      <p className="muted worker-keys-lede">{t("workers.lede")}</p>
      <ul className="worker-key-list">
        <li>
          <div className="worker-key-main">
            <span className="worker-key-name">
              <Server className="worker-key-icon" /> {t("workers.local")}
            </span>
            <ProfileSummary profile={profiles.data?.profiles.local} />
          </div>
          <div className="worker-key-state">
            <span className={`pill ${localOnline ? "ok" : ""}`}>
              <span className="dot" />
              {localOnline ? t("workers.online") : t("workers.offline")}
            </span>
          </div>
          <div className="worker-key-actions">
            <button className="icon-btn" onClick={() => setEditing({ id: "local", name: t("workers.local") })} title={t("profile.edit")} aria-label={t("profile.edit")}>
              <SlidersHorizontal />
            </button>
          </div>
        </li>
      </ul>
      {keys.length === 0 ? (
        <p className="faint">{t("workers.none")}</p>
      ) : (
        <ul className="worker-key-list">
          {keys.map((k) => (
            <li key={k.id} className={k.revokedAt ? "revoked" : ""}>
              <div className="worker-key-main">
                <span className="worker-key-name">{k.name}</span>
                <span className="mono faint">{k.id}</span>
                {!k.revokedAt && <ProfileSummary profile={profiles.data?.profiles[k.id]} wake={profiles.data?.wake[k.id]} />}
              </div>
              <div className="worker-key-state">
                {k.revokedAt ? (
                  <span className="pill">{t("workers.revokedAt", { when: relative(k.revokedAt, t, locale) })}</span>
                ) : k.pending ? (
                  <span className="pill warn">
                    <span className="dot" />
                    {t("workers.pending", { left: k.enrollExpiresAt ? until(k.enrollExpiresAt, locale) : "" })}
                  </span>
                ) : !k.online && profiles.data?.wake[k.id] ? (
                  // Started on demand: not running is its normal state.
                  <span className="pill" title={t("workers.standbyHint")}>
                    <Cloud className="pill-icon" />
                    {t("workers.standby")}
                  </span>
                ) : (
                  <span className={`pill ${k.online ? "ok" : ""}`}>
                    <span className="dot" />
                    {k.online ? t("workers.online") : t("workers.offline")}
                  </span>
                )}
                {!k.revokedAt && !k.pending && k.lastUsedAt && (
                  <span className="faint worker-key-seen">
                    {t("workers.lastSeen", { when: relative(k.lastUsedAt, t, locale), ip: k.lastIp ?? "–" })}
                  </span>
                )}
              </div>
              <div className="worker-key-actions">
                {!k.revokedAt && !k.pending && (
                  <button className="icon-btn" onClick={() => setEditing({ id: k.id, name: k.name })} title={t("profile.edit")} aria-label={t("profile.edit")}>
                    <SlidersHorizontal />
                  </button>
                )}
                {!k.revokedAt && (
                  <button className="icon-btn" onClick={() => revoke(k)} title={k.pending ? t("workers.cancel") : t("workers.revoke")} aria-label={k.pending ? t("workers.cancel") : t("workers.revoke")}>
                    <Trash2 />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <AddWorker
          onClose={() => setAdding(false)}
          onCreated={async (c) => {
            setAdding(false);
            setCreated(c);
            await qc.invalidateQueries({ queryKey: ["admin", "worker-keys"] });
          }}
        />
      )}
      {created && <EnrollCode created={created} onClose={() => setCreated(null)} />}
      {editing && (
        <ProfileDialog
          id={editing.id}
          name={editing.name}
          profile={profiles.data?.profiles[editing.id]}
          wake={editing.id === "local" ? undefined : (profiles.data?.wake[editing.id] ?? null)}
          defaultFallbackSec={profiles.data?.defaultFallbackSec ?? 120}
          global={transcriber.data?.settings}
          capabilities={workersOf(editing.id)[0]?.capabilities ?? null}
          keys={(workersOf(editing.id)[0]?.keys as Record<string, boolean> | null) ?? null}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await Promise.all([qc.invalidateQueries({ queryKey: ["admin", "worker-profiles"] }), qc.invalidateQueries({ queryKey: ["auth"] })]);
          }}
        />
      )}
    </section>
  );
}

function AddWorker({ onClose, onCreated }: { onClose: () => void; onCreated: (c: { name: string; code: string; expiresAt: number }) => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await api.adminCreateWorkerKey(name.trim());
      onCreated({ name: res.name, code: res.code, expiresAt: res.expiresAt });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("workers.addTitle")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="submit" form="worker-add" className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy && <span className="spinner" />} {t("workers.create")}
          </button>
        </>
      }
    >
      <form id="worker-add" onSubmit={submit} className="worker-add-form">
        <div className="field">
          <label htmlFor="worker-name">{t("workers.name")}</label>
          <input id="worker-name" className="input" value={name} maxLength={60} placeholder={t("workers.namePlaceholder")} onChange={(e) => setName(e.target.value)} />
          <span className="field-hint">{t("workers.nameHint")}</span>
        </div>
      </form>
    </Modal>
  );
}

/** The one-time code, as the command to run on that machine. Shown once. */
function EnrollCode({ created, onClose }: { created: { name: string; code: string; expiresAt: number }; onClose: () => void }) {
  const { t, locale } = useI18n();
  const [copied, setCopied] = useState(false);
  const server = window.location.origin;
  const command = `scripts/worker.sh enroll ${server} ${created.code}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Modal
      wide
      title={t("workers.codeTitle", { name: created.name })}
      onClose={onClose}
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          {t("workers.done")}
        </button>
      }
    >
      <div className="worker-enroll">
        <p>{t("workers.codeIntro")}</p>
        <ol className="worker-enroll-steps">
          <li>
            {t("workers.step1")}
            <pre className="mono asr-env">scripts/install.sh --worker-only</pre>
          </li>
          <li>
            {t("workers.step2")}
            <div className="worker-enroll-command">
              <pre className="mono asr-env">{command}</pre>
              <button className="btn btn-sm" onClick={copy}>
                {copied ? <Check /> : <Copy />} {copied ? t("workers.copied") : t("workers.copy")}
              </button>
            </div>
          </li>
          <li>
            {t("workers.step3")}
            <pre className="mono asr-env">{"scripts/worker.sh check\nscripts/restart.sh worker"}</pre>
          </li>
        </ol>
        <details className="worker-enroll-modal">
          <summary>{t("workers.modalAlt")}</summary>
          <p className="field-hint">{t("workers.modalAltIntro")}</p>
          <pre className="mono asr-env">{`modal secret create meetingminutes-worker HF_TOKEN=hf_... OPENROUTER_API_KEY=sk-or-...\nmodal run deploy/modal/app.py::enroll --server-url ${server} --code ${created.code}\nmodal deploy deploy/modal/app.py\nmodal run deploy/modal/app.py::prepare`}</pre>
          <p className="field-hint">{t("workers.modalAltNext")}</p>
        </details>
        <p className="field-hint">{t("workers.codeOnce", { left: until(created.expiresAt, locale) })}</p>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- settings per machine

/** One line on what a machine does: its own choices, or "site-wide". */
export function ProfileSummary({ profile, wake }: { profile: WorkerProfile | undefined; wake?: WorkerWake }) {
  const { t } = useI18n();
  const p = profile ?? { engine: null, diarization: null, fallbackSec: null };
  const parts: string[] = [];
  parts.push(p.engine ? t("profile.asrIs", { v: t(`profile.asr_${p.engine}`) }) : t("profile.asrDefault"));
  parts.push(p.diarization ? t("profile.diarIs", { v: t(`profile.diar_${p.diarization}`) }) : t("profile.diarDefault"));
  if (p.fallbackSec) parts.push(t("profile.fallbackShort", { n: Math.round(p.fallbackSec / 60) }));
  if (wake) parts.push(t("profile.wakeShort"));
  return <span className="faint worker-profile-summary">{parts.join(" · ")}</span>;
}

export function ProfileDialog({
  id,
  name,
  profile,
  wake,
  defaultFallbackSec,
  global,
  capabilities,
  keys,
  onClose,
  onSaved,
}: {
  id: string;
  name: string;
  profile: WorkerProfile | undefined;
  /** A remote worker's wake-up address (null: none); undefined for this server's workers, which run on their own. */
  wake?: WorkerWake | null;
  defaultFallbackSec: number;
  global: TranscriberSettings | undefined;
  /** What the machine's connected workers can run; null when none is connected (or too old to say). */
  capabilities: { asr: string[]; diarization: string[] } | null;
  keys: Record<string, boolean> | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [form, setForm] = useState<WorkerProfile>(profile ?? { engine: null, diarization: null, fallbackSec: null });
  const [minutes, setMinutes] = useState(Math.max(1, Math.round((profile?.fallbackSec ?? defaultFallbackSec) / 60)));
  const [busy, setBusy] = useState(false);
  const [wakeUrl, setWakeUrl] = useState(wake?.url ?? "");
  const [testing, setTesting] = useState(false);
  const wakeChanged = wake !== undefined && wakeUrl.trim() !== (wake?.url ?? "");
  // The server checks it fully (not this machine, no metadata service); this catches typing mistakes.
  const wakeOk = !wakeUrl.trim() || /^https:\/\/[^\s/@]+(\/\S*)?$/.test(wakeUrl.trim());

  const engine = form.engine ?? global?.engine;
  const diarization = form.diarization ?? global?.diarization;
  const problems: string[] = [];
  if (capabilities) {
    if (engine && !capabilities.asr.includes(engine)) problems.push(t("profile.cannotAsr"));
    if (diarization && !capabilities.diarization.includes(diarization)) problems.push(t("profile.cannotDiar"));
  }
  if (keys) {
    if (engine === "api" && global && !keys[global.api.provider]) problems.push(t("profile.noAsrKey"));
    if (diarization === "pyannoteai" && !keys.pyannoteai) problems.push(t("profile.noPyannoteKey"));
  }

  const save = async () => {
    setBusy(true);
    try {
      await api.adminSaveWorkerProfile(id, { ...form, fallbackSec: form.fallbackSec ? Math.max(1, minutes) * 60 : null });
      if (wakeChanged) await api.adminSaveWorkerWake(id, wakeUrl.trim() || null);
      toast.show(t("common.saved"));
      onSaved();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const asrOptions: (AsrEngine | null)[] = [null, "local", "api"];
  const diarOptions: (DiarizationEngine | null)[] = [null, "local", "cpu", "pyannoteai"];
  return (
    <Modal
      wide
      title={t("profile.title", { name })}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !wakeOk}>
            {busy && <span className="spinner" />} {t("common.save")}
          </button>
        </>
      }
    >
      <div className="profile-form">
        <p className="muted">{t("profile.lede")}</p>
        <div className="field">
          <span className="field-label">{t("profile.asr")}</span>
          <div className="segmented wrap">
            {asrOptions.map((o) => (
              <button key={o ?? "default"} type="button" aria-pressed={form.engine === o} onClick={() => setForm({ ...form, engine: o })}>
                {o ? t(`profile.asr_${o}`) : t("profile.followSite", { what: global ? t(`profile.asr_${global.engine}`) : "" })}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="field-label">{t("profile.diar")}</span>
          <div className="segmented wrap">
            {diarOptions.map((o) => (
              <button key={o ?? "default"} type="button" aria-pressed={form.diarization === o} onClick={() => setForm({ ...form, diarization: o })}>
                {o ? t(`profile.diar_${o}`) : t("profile.followSite", { what: global ? t(`profile.diar_${global.diarization}`) : "" })}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label className="switch">
            <input type="checkbox" checked={!!form.fallbackSec} onChange={(e) => setForm({ ...form, fallbackSec: e.target.checked ? minutes * 60 : null })} />
            <span className="switch-track" />
            <span className="switch-label">{t("profile.fallback")}</span>
          </label>
          {!!form.fallbackSec && (
            <div className="profile-fallback">
              <input
                className="input mono"
                type="number"
                min={1}
                max={1440}
                value={minutes}
                aria-label={t("profile.fallbackMinutes")}
                onChange={(e) => setMinutes(Math.max(1, Math.min(1440, Math.round(Number(e.target.value) || 1))))}
              />
              <span>{t("profile.fallbackMinutes")}</span>
            </div>
          )}
          <span className="field-hint">{t("profile.fallbackHint")}</span>
        </div>
        {wake !== undefined && (
          <div className="field">
            <label htmlFor="wake-url">{t("profile.wake")}</label>
            <div className="profile-wake">
              <input
                id="wake-url"
                className="input mono"
                type="url"
                placeholder="https://…modal.run"
                value={wakeUrl}
                aria-invalid={!wakeOk}
                onChange={(e) => setWakeUrl(e.target.value)}
              />
              <button
                type="button"
                className="btn"
                disabled={testing || !wake || wakeChanged}
                title={wakeChanged ? t("profile.wakeSaveFirst") : undefined}
                onClick={async () => {
                  setTesting(true);
                  try {
                    const r = await api.adminTestWorkerWake(id);
                    if (r.ok) toast.show(t("profile.wakeOk", { status: r.status ?? "" }));
                    else toast.error(new Error(t("profile.wakeFailed", { error: r.error ?? "" })));
                  } catch (e) {
                    toast.error(e);
                  } finally {
                    setTesting(false);
                  }
                }}
              >
                {testing ? <span className="spinner" /> : <Zap />} {t("profile.wakeTest")}
              </button>
            </div>
            <span className="field-hint">{t("profile.wakeHint")}</span>
            {wake?.at && (
              <span className={`field-hint ${wake.ok ? "" : "field-error"}`}>
                {t("profile.wakeLast", {
                  when: relative(wake.at, t, locale),
                  result: wake.ok ? t("profile.wakeLastOk") : t("profile.wakeFailed", { error: wake.error ?? "" }),
                })}
              </span>
            )}
          </div>
        )}
        {problems.length > 0 && (
          <div className="callout warn" role="alert">
            <div>
              {problems.map((p) => (
                <p key={p} style={{ margin: 0 }}>
                  {p}
                </p>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
