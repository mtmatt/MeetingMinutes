import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Laptop, LogOut, Monitor, Moon, Smartphone, Sun } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "../api/client";
import { useToast } from "../components/Toast";
import { useI18n } from "../i18n";
import { useAuth } from "../lib/auth";
import { relative } from "../lib/format";
import { useTheme, type ThemePref } from "../lib/theme";

function deviceLabel(ua: string | null): { label: string; mobile: boolean } {
  if (!ua) return { label: "Unknown device", mobile: false };
  const mobile = /iPhone|Android|Mobile|iPad/i.test(ua);
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? (mobile ? "iOS" : "macOS") : /Android/.test(ua) ? "Android" : /Linux/.test(ua) ? "Linux" : /iPhone|iPad/.test(ua) ? "iOS" : "";
  return { label: `${browser}${os ? ` · ${os}` : ""}`, mobile };
}

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

export function SettingsPage() {
  const { t, locale, setLocale } = useI18n();
  const { user, setUser } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [theme, setTheme] = useTheme();
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: api.sessions });

  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const { user: u } = await api.updateMe({ displayName: displayName.trim() });
      setUser(u);
      toast.show(t("common.saved"));
    } catch (err) {
      toast.error(err);
    }
  };

  const changeLocale = async (l: "en" | "zh-TW") => {
    setLocale(l);
    const { user: u } = await api.updateMe({ locale: l });
    setUser(u);
  };

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setCurrent("");
      setNext("");
      toast.show(t("settings.passwordChanged"));
      await qc.invalidateQueries({ queryKey: ["sessions"] });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    await api.revokeSession(id).catch(toast.error);
    await qc.invalidateQueries({ queryKey: ["sessions"] });
  };
  const revokeOthers = async () => {
    await api.revokeOtherSessions().catch(toast.error);
    await qc.invalidateQueries({ queryKey: ["sessions"] });
  };

  const themes: { id: ThemePref; icon: typeof Sun; label: string }[] = [
    { id: "system", icon: Monitor, label: t("theme.system") },
    { id: "light", icon: Sun, label: t("theme.light") },
    { id: "dark", icon: Moon, label: t("theme.dark") },
  ];

  return (
    <div className="settings">
      <div className="page-head">
        <div>
          <div className="smallcaps eyebrow">@{user?.username}</div>
          <h1>{t("settings.title")}</h1>
        </div>
      </div>
      <hr className="rule-double" />

      <Section title={t("settings.profile")}>
        <form className="settings-form" onSubmit={saveProfile}>
          <div className="field">
            <label htmlFor="dn">{t("auth.displayName")}</label>
            <input id="dn" className="input" value={displayName} maxLength={80} onChange={(e) => setDisplayName(e.target.value)} />
          </div>
          <div>
            <button className="btn btn-ink" disabled={!displayName.trim() || displayName.trim() === user?.displayName}>
              {t("common.save")}
            </button>
          </div>
        </form>
      </Section>

      <Section title={t("settings.preferences")}>
        <div className="settings-form">
          <div className="field">
            <span className="field-label">{t("nav.language")}</span>
            <div className="segmented">
              <button aria-pressed={locale === "zh-TW"} onClick={() => changeLocale("zh-TW")}>
                繁體中文
              </button>
              <button aria-pressed={locale === "en"} onClick={() => changeLocale("en")}>
                English
              </button>
            </div>
          </div>
          <div className="field">
            <span className="field-label">{t("nav.theme")}</span>
            <div className="theme-cards">
              {themes.map(({ id, icon: Icon, label }) => (
                <button key={id} className={`theme-card theme-${id}`} aria-pressed={theme === id} onClick={() => setTheme(id)}>
                  <span className="theme-card-preview" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </span>
                  <span className="theme-card-label">
                    <Icon /> {label}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </Section>

      <Section title={t("settings.security")}>
        <form className="settings-form" onSubmit={changePassword}>
          <input type="text" autoComplete="username" value={user?.username ?? ""} readOnly hidden />
          <div className="grid-2 even">
            <div className="field">
              <label htmlFor="cur">{t("settings.currentPassword")}</label>
              <input id="cur" className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="new">{t("settings.newPassword")}</label>
              <input id="new" className="input" type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} />
              <span className="field-hint">{t("auth.passwordHint")}</span>
            </div>
          </div>
          <div>
            <button className="btn btn-ink" disabled={busy || !current || next.length < 10}>
              {busy && <span className="spinner" />} {t("settings.changePassword")}
            </button>
          </div>
        </form>
      </Section>

      <Section title={t("settings.sessions")} lede={t("settings.sessionsLede")}>
        <ul className="session-list">
          {sessions.data?.sessions.map((s) => {
            const d = deviceLabel(s.userAgent);
            const Icon = d.mobile ? Smartphone : Laptop;
            return (
              <li key={s.id}>
                <span className="session-icon">
                  <Icon />
                </span>
                <div className="session-main">
                  <div className="session-name">
                    {d.label} {s.current && <span className="pill ok">{t("settings.thisDevice")}</span>}
                  </div>
                  <div className="faint mono" style={{ fontSize: "var(--step--2)" }}>
                    {s.ip ?? "–"} · {t("settings.lastActive", { when: relative(s.lastSeenAt, t, locale) })}
                  </div>
                </div>
                {!s.current && (
                  <button className="btn btn-sm btn-ghost" onClick={() => revoke(s.id)}>
                    <LogOut /> {t("settings.revoke")}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {(sessions.data?.sessions.length ?? 0) > 1 && (
          <button className="btn btn-sm" onClick={revokeOthers} style={{ marginTop: 12 }}>
            {t("settings.revokeOthers")}
          </button>
        )}
      </Section>
    </div>
  );
}
