import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, Laptop, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "../api/client";
import type { WorkerKey } from "../api/types";
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
      await Promise.all([qc.invalidateQueries({ queryKey: ["admin", "worker-keys"] }), qc.invalidateQueries({ queryKey: ["auth"] })]);
      toast.show(res.requeued ? t("workers.revokedRequeued", { n: res.requeued }) : t("workers.revoked"));
    } catch (e) {
      toast.error(e);
    }
  };

  const keys = data?.keys ?? [];
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
      {keys.length === 0 ? (
        <p className="faint">{t("workers.none")}</p>
      ) : (
        <ul className="worker-key-list">
          {keys.map((k) => (
            <li key={k.id} className={k.revokedAt ? "revoked" : ""}>
              <div className="worker-key-main">
                <span className="worker-key-name">{k.name}</span>
                <span className="mono faint">{k.id}</span>
              </div>
              <div className="worker-key-state">
                {k.revokedAt ? (
                  <span className="pill">{t("workers.revokedAt", { when: relative(k.revokedAt, t, locale) })}</span>
                ) : k.pending ? (
                  <span className="pill warn">
                    <span className="dot" />
                    {t("workers.pending", { left: k.enrollExpiresAt ? until(k.enrollExpiresAt, locale) : "" })}
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
              {!k.revokedAt && (
                <button className="icon-btn" onClick={() => revoke(k)} title={k.pending ? t("workers.cancel") : t("workers.revoke")} aria-label={k.pending ? t("workers.cancel") : t("workers.revoke")}>
                  <Trash2 />
                </button>
              )}
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
        <p className="field-hint">{t("workers.codeOnce", { left: until(created.expiresAt, locale) })}</p>
      </div>
    </Modal>
  );
}
