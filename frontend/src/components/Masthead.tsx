import { ChevronDown, FileText, Languages, Library, LogOut, Monitor, Moon, Plus, Settings, Shield, Sun } from "lucide-react";
import { NavLink, useNavigate } from "react-router";
import { api } from "../api/client";
import { useI18n } from "../i18n";
import { useAuth } from "../lib/auth";
import { initials } from "../lib/format";
import { useTheme, type ThemePref } from "../lib/theme";
import { Menu } from "./Menu";
import { Wordmark } from "./Seal";

export function Masthead() {
  const { t, locale, setLocale } = useI18n();
  const { user, setUser } = useAuth();
  const [theme, setTheme] = useTheme();
  const navigate = useNavigate();

  const switchLocale = async (l: "en" | "zh-TW") => {
    setLocale(l);
    try {
      const { user: u } = await api.updateMe({ locale: l });
      setUser(u);
    } catch {
      /* local preference still applies */
    }
  };

  const signOut = async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
    navigate("/login");
  };

  const themes: { id: ThemePref; icon: typeof Sun; label: string }[] = [
    { id: "system", icon: Monitor, label: t("theme.system") },
    { id: "light", icon: Sun, label: t("theme.light") },
    { id: "dark", icon: Moon, label: t("theme.dark") },
  ];

  return (
    <header className="masthead">
      <div className="masthead-inner">
        <NavLink to="/" className="masthead-brand" aria-label="Minutes">
          <Wordmark />
        </NavLink>
        <nav className="masthead-nav">
          <NavLink to="/" end>
            {t("nav.library")}
          </NavLink>
          <NavLink to="/templates">{t("nav.templates")}</NavLink>
          {user?.role === "admin" && <NavLink to="/admin">{t("nav.admin")}</NavLink>}
        </nav>
        <div className="masthead-actions">
          <NavLink to="/new" className="btn btn-primary btn-sm masthead-new">
            <Plus />
            <span>{t("nav.new")}</span>
          </NavLink>
          <Menu
            trigger={({ toggle, open }) => (
              <button className="user-chip" onClick={toggle} aria-expanded={open} aria-haspopup="menu">
                <span className="avatar" style={{ ["--size" as string]: "28px" }}>
                  {initials(user?.displayName ?? "?")}
                </span>
                <span className="user-chip-name">{user?.displayName}</span>
                <ChevronDown className="chev" />
              </button>
            )}
          >
            {(close) => (
              <>
                <div className="menu-label">
                  <div style={{ fontWeight: 600 }}>{user?.displayName}</div>
                  <div className="faint mono" style={{ fontSize: "var(--step--2)" }}>
                    @{user?.username}
                  </div>
                </div>
                <div className="menu-sep" />
                <div className="mobile-only">
                  <NavLink className="menu-item" to="/" end onClick={close}>
                    <Library /> {t("nav.library")}
                  </NavLink>
                  <NavLink className="menu-item" to="/templates" onClick={close}>
                    <FileText /> {t("nav.templates")}
                  </NavLink>
                  <div className="menu-sep" />
                </div>
                <div className="menu-label smallcaps">{t("nav.theme")}</div>
                <div className="menu-row">
                  {themes.map(({ id, icon: Icon, label }) => (
                    <button key={id} className="menu-chip" aria-pressed={theme === id} onClick={() => setTheme(id)} title={label}>
                      <Icon />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
                <div className="menu-label smallcaps">
                  <Languages style={{ width: 12, height: 12, display: "inline", verticalAlign: "-1px" }} /> {t("nav.language")}
                </div>
                <div className="menu-row">
                  <button className="menu-chip" aria-pressed={locale === "zh-TW"} onClick={() => switchLocale("zh-TW")}>
                    繁體中文
                  </button>
                  <button className="menu-chip" aria-pressed={locale === "en"} onClick={() => switchLocale("en")}>
                    English
                  </button>
                </div>
                <div className="menu-sep" />
                <NavLink className="menu-item" to="/settings" onClick={close}>
                  <Settings /> {t("nav.settings")}
                </NavLink>
                {user?.role === "admin" && (
                  <NavLink className="menu-item" to="/admin" onClick={close}>
                    <Shield /> {t("nav.admin")}
                  </NavLink>
                )}
                <button className="menu-item" onClick={signOut}>
                  <LogOut /> {t("nav.signOut")}
                </button>
              </>
            )}
          </Menu>
        </div>
      </div>
    </header>
  );
}
