import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, HardDrive, KeyRound, Link2, MoreHorizontal, Plus, ShieldCheck, Sparkles, Trash2, UserCheck, UserMinus, UserX } from "lucide-react";
import { useState } from "react";
import { api } from "../api/client";
import type { AdminUser, Role, WorkerInfo } from "../api/types";
import { Menu } from "../components/Menu";
import { Modal, useConfirm } from "../components/Modal";
import { useToast } from "../components/Toast";
import { useI18n } from "../i18n";
import { useAuth } from "../lib/auth";
import { diarizationReason } from "../lib/errors";
import { bytes, initials, relative, until } from "../lib/format";

function CopyLink({ url }: { url: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      <code>{url}</code>
      <button
        className="btn btn-sm btn-ink"
        onClick={async () => {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? t("common.copied") : t("common.copy")}
      </button>
    </div>
  );
}

function Users() {
  const { t, locale } = useI18n();
  const { user: me } = useAuth();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["admin", "users"], queryFn: api.adminUsers });
  const [resetFor, setResetFor] = useState<{ name: string; url: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["admin", "users"] });

  const update = async (u: AdminUser, b: { role?: Role; disabled?: boolean }) => {
    try {
      await api.adminUpdateUser(u.id, b);
      await refresh();
    } catch (e) {
      toast.error(e);
    }
  };
  const resetLink = async (u: AdminUser) => {
    try {
      const { url } = await api.adminResetLink(u.id);
      setResetFor({ name: u.displayName, url });
    } catch (e) {
      toast.error(e);
    }
  };
  const remove = async (u: AdminUser) => {
    const ok = await confirm({
      title: t("admin.deleteUserTitle", { name: u.displayName }),
      body: t("admin.deleteUserBody"),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.adminDeleteUser(u.id);
      await refresh();
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <>
      <p className="admin-hint">{t("admin.resetHint")}</p>
      <div className="table-wrap card">
        <table className="table">
          <thead>
            <tr>
              <th>{t("auth.displayName")}</th>
              <th>{t("admin.role")}</th>
              <th>{t("admin.status")}</th>
              <th style={{ textAlign: "right" }}>{t("admin.meetings")}</th>
              <th>{t("admin.lastLogin")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.users.map((u) => (
              <tr key={u.id} className={u.disabled ? "row-disabled" : ""}>
                <td>
                  <div className="user-cell">
                    <span className="avatar">{initials(u.displayName)}</span>
                    <div>
                      <div style={{ fontWeight: 600 }}>
                        {u.displayName} {u.id === me?.id && <span className="faint">({t("common.you")})</span>}
                      </div>
                      <div className="faint mono" style={{ fontSize: "var(--step--2)" }}>
                        @{u.username}
                      </div>
                    </div>
                  </div>
                </td>
                <td>
                  <span className={`pill ${u.role === "admin" ? "accent" : ""}`}>
                    {u.role === "admin" && <ShieldCheck style={{ width: 12, height: 12 }} />}
                    {u.role === "admin" ? t("admin.admin") : t("admin.member")}
                  </span>
                </td>
                <td>
                  <span className={`pill ${u.disabled ? "danger" : "ok"}`}>
                    <span className="dot" />
                    {u.disabled ? t("admin.disabled") : t("admin.active")}
                  </span>
                </td>
                <td className="mono" style={{ textAlign: "right" }}>
                  {u.meetings}
                </td>
                <td className="faint">{u.lastLoginAt ? relative(u.lastLoginAt, t, locale) : t("common.never")}</td>
                <td style={{ textAlign: "right" }}>
                  <Menu
                    trigger={({ toggle }) => (
                      <button className="icon-btn" onClick={toggle} aria-label="More">
                        <MoreHorizontal />
                      </button>
                    )}
                  >
                    {(close) => {
                      const act = (fn: () => void) => () => {
                        close();
                        fn();
                      };
                      return (
                        <>
                          {u.role === "member" ? (
                            <button className="menu-item" onClick={act(() => update(u, { role: "admin" }))}>
                              <ShieldCheck /> {t("admin.makeAdmin")}
                            </button>
                          ) : (
                            <button className="menu-item" onClick={act(() => update(u, { role: "member" }))}>
                              <UserMinus /> {t("admin.makeMember")}
                            </button>
                          )}
                          <button className="menu-item" onClick={act(() => resetLink(u))}>
                            <KeyRound /> {t("admin.resetLink")}
                          </button>
                          {u.id !== me?.id && (
                            <button className="menu-item" onClick={act(() => update(u, { disabled: !u.disabled }))}>
                              {u.disabled ? <UserCheck /> : <UserX />} {u.disabled ? t("admin.enable") : t("admin.disable")}
                            </button>
                          )}
                          {u.id !== me?.id && (
                            <>
                              <div className="menu-sep" />
                              <button className="menu-item danger" onClick={act(() => remove(u))}>
                                <Trash2 /> {t("admin.deleteUser")}
                              </button>
                            </>
                          )}
                        </>
                      );
                    }}
                  </Menu>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {resetFor && (
        <Modal title={t("admin.resetLink")} onClose={() => setResetFor(null)}>
          <p>{t("admin.resetLinkBody", { name: resetFor.name })}</p>
          <CopyLink url={resetFor.url} />
        </Modal>
      )}
    </>
  );
}

function Invites() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["admin", "invites"], queryFn: api.adminInvites });
  const [role, setRole] = useState<Role>("member");
  const [note, setNote] = useState("");
  const [ttl, setTtl] = useState(72);
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const { url } = await api.adminCreateInvite({ role, note: note.trim() || null, ttlHours: ttl });
      setCreated(url);
      setNote("");
      await qc.invalidateQueries({ queryKey: ["admin", "invites"] });
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    await api.adminDeleteInvite(id).catch(toast.error);
    await qc.invalidateQueries({ queryKey: ["admin", "invites"] });
  };

  return (
    <div className="invites">
      <div className="card invite-form">
        <h3>{t("admin.invite")}</h3>
        <div className="invite-grid">
          <div className="field">
            <label htmlFor="inv-note">{t("admin.inviteNote")}</label>
            <input id="inv-note" className="input" placeholder={t("admin.inviteNotePlaceholder")} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
          </div>
          <div className="field">
            <span className="field-label">{t("admin.role")}</span>
            <div className="segmented">
              <button aria-pressed={role === "member"} onClick={() => setRole("member")}>
                {t("admin.member")}
              </button>
              <button aria-pressed={role === "admin"} onClick={() => setRole("admin")}>
                {t("admin.admin")}
              </button>
            </div>
          </div>
          <div className="field">
            <label htmlFor="inv-ttl">{t("admin.inviteExpires")}</label>
            <select id="inv-ttl" className="select" value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
              <option value={24}>{t("admin.hours", { n: 24 })}</option>
              <option value={72}>{t("admin.days", { n: 3 })}</option>
              <option value={168}>{t("admin.days", { n: 7 })}</option>
              <option value={720}>{t("admin.days", { n: 30 })}</option>
            </select>
          </div>
          <button className="btn btn-primary" onClick={create} disabled={busy}>
            <Link2 /> {t("common.create")}
          </button>
        </div>
        {created && (
          <div className="invite-created">
            <div className="field-label">{t("admin.inviteCreated")}</div>
            <CopyLink url={created} />
            <span className="field-hint">{t("admin.inviteCreatedBody")}</span>
          </div>
        )}
      </div>

      <ul className="invite-list">
        {data?.invites.length === 0 && <li className="faint">{t("admin.noInvites")}</li>}
        {data?.invites.map((i) => (
          <li key={i.id}>
            <span className={`pill ${i.usedAt ? "ok" : "info"}`}>{i.usedAt ? t("admin.used", { name: i.usedBy ?? "?" }) : t("admin.pending")}</span>
            <span className="invite-note">{i.note || <span className="faint">—</span>}</span>
            <span className="faint">{i.role === "admin" ? t("admin.admin") : t("admin.member")}</span>
            <span className="faint">{i.usedAt ? relative(i.usedAt, t, locale) : t("admin.expires", { when: until(i.expiresAt, locale) })}</span>
            {!i.usedAt && (
              <button className="btn btn-sm btn-ghost" onClick={() => revoke(i.id)}>
                {t("admin.revoke")}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function System() {
  const { t, locale } = useI18n();
  const { data, isLoading } = useQuery({ queryKey: ["admin", "system"], queryFn: api.adminSystem, refetchInterval: 10_000 });
  if (isLoading || !data) return <div className="skeleton" style={{ height: 240 }} />;
  const diskUsed = data.disk ? 1 - data.disk.freeBytes / data.disk.totalBytes : 0;
  // Online workers first, in name order (gpu0, gpu1, …); workers gone for more
  // than a day (renamed, retired machines) are counted but not listed.
  const DAY = 24 * 60 * 60 * 1000;
  const recent = data.workers.filter((w) => w.online || Date.now() - w.lastSeenAt < DAY);
  const shownWorkers = [...recent].sort(
    (a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
  const hiddenWorkers = data.workers.length - recent.length;
  return (
    <div className="system">
      <section>
        <h3 className="system-h">
          <Cpu /> {t("admin.workers")}
        </h3>
        {data.workers.length === 0 ? (
          <div className="callout">{t("admin.noWorkers")}</div>
        ) : (
          <>
          <div className="worker-grid">
            {shownWorkers.map((w) => (
              <div key={w.id} className={`card worker ${w.online ? "" : "offline"}`}>
                <div className="worker-top">
                  <span className={`pill ${w.online ? (w.info.state === "busy" ? "accent live" : "ok") : ""}`}>
                    <span className="dot" />
                    {w.online ? (w.info.state === "busy" ? t("admin.busy") : t("admin.idle")) : t("admin.offline")}
                  </span>
                  <span className="faint" style={{ fontSize: "var(--step--2)" }}>
                    {relative(w.lastSeenAt, t, locale)}
                  </span>
                </div>
                <div className="worker-gpu">{w.info.gpu ?? (w.info.cuda === false ? "CPU" : "GPU")}</div>
                <div className="worker-name mono faint">{w.name}</div>
                {w.info.vramTotalGb != null && <VramBar info={w.info} />}
                <div className="worker-model mono">
                  {w.info.asrModel} · {w.info.asrBackend}
                </div>
                {w.online && w.info.modelsLoaded !== undefined && (
                  <div className="worker-load faint">
                    <span className="speaker-dot" style={{ ["--spk" as string]: w.info.modelsLoaded ? "var(--accent)" : "var(--ok)" }} />
                    {w.info.modelsLoaded ? t("admin.modelsLoaded") : t("admin.modelsUnloaded")}
                  </div>
                )}
                {/* Only when loading actually failed; nothing is known before a GPU session has run. */}
                {w.info.diarization === "unavailable" && (
                  <div className="worker-warn" title={w.info.diarizationError ?? undefined}>
                    <span className="pill warn">{t("admin.diarizationOff")}</span>
                    <span className="faint">{t(diarizationReason(w.info.diarizationError))}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
          {hiddenWorkers > 0 && <p className="faint system-help">{t("admin.staleWorkersHidden", { n: hiddenWorkers })}</p>}
          </>
        )}
      </section>

      <div className="system-row">
        <section className="card system-card">
          <h3 className="system-h">{t("admin.queue")}</h3>
          <dl className="kv">
            <dt>{t("admin.transcriptionJobs")}</dt>
            <dd className="mono">{t("admin.runningQueued", { running: data.jobs.running, queued: data.jobs.queued })}</dd>
            <dt>{t("admin.summaryJobs")}</dt>
            <dd className="mono">{t("admin.runningQueued", { running: data.summaries.running, queued: data.summaries.queued })}</dd>
          </dl>
        </section>
        <section className="card system-card">
          <h3 className="system-h">
            <Sparkles /> {t("admin.codex")}
          </h3>
          <span className={`pill ${data.codex.loggedIn ? "ok" : data.codex.available ? "warn" : "danger"}`}>
            <span className="dot" />
            {data.codex.loggedIn ? t("admin.codexReady") : data.codex.available ? t("admin.codexNotLoggedIn") : t("admin.codexMissing")}
          </span>
          <p className="faint mono system-detail">
            {data.codex.version} {data.codex.detail && `· ${/logged in using chatgpt/i.test(data.codex.detail) ? t("admin.codexViaChatgpt") : data.codex.detail}`}
          </p>
          {!data.codex.loggedIn && <p className="muted system-help">{t("admin.codexHelp")}</p>}
        </section>
        <section className="card system-card">
          <h3 className="system-h">
            <HardDrive /> {t("admin.storage")}
          </h3>
          {data.disk && (
            <>
              <div className="progress" style={{ height: 6 }}>
                <span style={{ width: `${diskUsed * 100}%`, background: diskUsed > 0.9 ? "var(--danger)" : undefined }} />
              </div>
              <p className="mono faint system-detail">{t("admin.free", { free: bytes(data.disk.freeBytes), total: bytes(data.disk.totalBytes) })}</p>
            </>
          )}
          <p className="muted system-help">
            {t("admin.totalsBody", { users: data.stats.users, meetings: data.stats.meetings, hours: data.stats.audioHours.toFixed(1) })}
          </p>
        </section>
      </div>
    </div>
  );
}

export function AdminPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<"users" | "invites" | "system">("users");
  return (
    <div className="admin">
      <div className="page-head">
        <div>
          <div className="smallcaps eyebrow">{t("nav.admin")}</div>
          <h1>{t("admin.title")}</h1>
        </div>
        {tab !== "invites" && (
          <button className="btn btn-primary" onClick={() => setTab("invites")}>
            <Plus /> {t("admin.invite")}
          </button>
        )}
      </div>
      <div className="tabs admin-tabs" role="tablist">
        {(["users", "invites", "system"] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {t(`admin.${k}`)}
          </button>
        ))}
      </div>
      <div className="admin-body">
        {tab === "users" && <Users />}
        {tab === "invites" && <Invites />}
        {tab === "system" && <System />}
      </div>
    </div>
  );
}

/** GPU memory in use. While this worker holds no models, all of it belongs to other programs. */
function VramBar({ info }: { info: WorkerInfo["info"] }) {
  const { t } = useI18n();
  const total = info.vramTotalGb ?? 0;
  const used = total - (info.vramFreeGb ?? 0);
  const others = !info.modelsLoaded;
  return (
    <div className={`worker-vram ${others ? "others" : ""}`}>
      <div className="progress">
        <span style={{ width: `${total ? (used / total) * 100 : 0}%` }} />
      </div>
      <span className="mono faint">
        {used.toFixed(1)} / {total} GB
        {others && used >= 0.5 && <> · {t("admin.vramOthers")}</>}
      </span>
    </div>
  );
}
