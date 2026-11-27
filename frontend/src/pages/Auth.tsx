import { useQuery } from "@tanstack/react-query";
import { AlertCircle, ArrowRight, CheckCircle2, KeyRound, MailCheck } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { ApiError, api } from "../api/client";
import { apiErrorMessage } from "../lib/errors";
import { Seal, Wordmark } from "../components/Seal";
import { PublicAnnouncements } from "../components/Announcements";
import { useI18n } from "../i18n";
import { useAuth } from "../lib/auth";

/** A few lines of a fictional transcript, typeset on the hero panel. */
const SAMPLE = [
  { t: "00:02:14", who: "Speaker 1", c: 0, text: "所以這個 release 我們下週三前要完成 regression test。" },
  { t: "00:02:21", who: "Speaker 2", c: 1, text: "OK，我來負責 API 的部分，前端交給 Amy。" },
  { t: "00:02:30", who: "Speaker 3", c: 3, text: "Then let's lock the scope today and review on Thursday." },
];

function AuthLayout({ children }: { children: ReactNode }) {
  const { t, locale, setLocale } = useI18n();
  return (
    <div className="auth">
      <aside className="auth-hero" aria-hidden="true">
        <div className="auth-hero-top">
          <Seal size={40} />
          <span className="smallcaps auth-hero-kicker">Minutes · 會議紀錄</span>
        </div>
        <div className="auth-hero-body">
          <h1>
            <span>{t("auth.heroLine1")}</span>
            <em>{t("auth.heroLine2")}</em>
          </h1>
          <p>{t("auth.heroBody")}</p>
        </div>
        <div className="auth-hero-sample">
          {SAMPLE.map((line, i) => (
            <div className="auth-sample-line" key={i} style={{ animationDelay: `${300 + i * 450}ms` }}>
              <span className="mono auth-sample-time">{line.t}</span>
              <span className="auth-sample-who" style={{ color: `var(--spk-${line.c})` }}>
                {line.who}
              </span>
              <span className="auth-sample-text">{line.text}</span>
            </div>
          ))}
        </div>
      </aside>
      <section className="auth-main">
        <div className="auth-main-top">
          <span className="auth-mobile-brand">
            <Wordmark />
          </span>
          <div className="segmented" role="group" aria-label={t("nav.language")}>
            <button aria-pressed={locale === "zh-TW"} onClick={() => setLocale("zh-TW")}>
              中文
            </button>
            <button aria-pressed={locale === "en"} onClick={() => setLocale("en")}>
              EN
            </button>
          </div>
        </div>
        <div className="auth-form-wrap">{children}</div>
      </section>
    </div>
  );
}


/** How to reach the administrator; an email address becomes a mailto link. */
function HelpContact({ contact }: { contact: string | null }) {
  const { t } = useI18n();
  if (!contact) return <>{t("auth.helpNoContact")}</>;
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact);
  const parts = t("auth.helpWithContact", { contact: "\u0000" }).split("\u0000");
  return (
    <>
      {parts[0]}
      {isEmail ? <a href={`mailto:${contact}`}>{contact}</a> : <strong>{contact}</strong>}
      {parts[1]}
    </>
  );
}

export function LoginPage() {
  const { t, locale } = useI18n();
  const { setUser, helpContact, registration, passwordReset } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  // An account that signed up and has not confirmed its address: where the link went.
  const [unverified, setUnverified] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  const resend = async () => {
    if (!unverified) return;
    try {
      await api.resendVerification(unverified, locale);
      setResent(true);
    } catch (err) {
      setError(apiErrorMessage(err, t));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError(t("auth.missingFields"));
      return;
    }
    setBusy(true);
    setError(null);
    setUnverified(null);
    try {
      const { user } = await api.login(username.trim(), password);
      setUser(user);
      const next = params.get("next");
      navigate(next && next.startsWith("/") && !next.startsWith("//") ? next : "/", { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === "email_unverified") {
        setUnverified(typeof err.body.email === "string" ? err.body.email : "");
        setResent(false);
      } else setError(err instanceof ApiError && err.code === "bad_credentials" ? t("auth.badCredentials") : apiErrorMessage(err, t));
      setBusy(false);
    }
  };

  const toggleHelp = () => setShowHelp((v) => !v);

  return (
    <AuthLayout>
      <form className="auth-form" onSubmit={submit} noValidate>
        <PublicAnnouncements />
        <div>
          <h2>{t("auth.welcomeBack")}</h2>
          {registration ? (
            <p className="auth-lede">
              {t("auth.noAccountYet")} <Link to="/register">{t("auth.createOne")}</Link>
            </p>
          ) : (
            <p className="auth-lede">
              {t("auth.invitedOnlyShort")}{" "}
              <button type="button" className="link-btn" onClick={toggleHelp} aria-expanded={showHelp} aria-controls="auth-help">
                {t("auth.getHelp")}
              </button>
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor="username">{t("auth.username")}</label>
          <input
            id="username"
            className="input"
            autoComplete="username"
            autoFocus
            value={username}
            aria-invalid={!!error}
            onChange={(e) => {
              setUsername(e.target.value);
              setError(null);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="password">
            <span>{t("auth.password")}</span>
            {passwordReset ? (
              <Link to="/forgot" className="link-btn">
                {t("auth.forgot")}
              </Link>
            ) : (
              <button type="button" className="link-btn" onClick={toggleHelp} aria-expanded={showHelp} aria-controls="auth-help">
                {t("auth.forgot")}
              </button>
            )}
          </label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            aria-invalid={!!error}
            onChange={(e) => {
              setPassword(e.target.value);
              setError(null);
            }}
          />
        </div>
        {error && (
          <div className="field-error" role="alert">
            <AlertCircle /> {error}
          </div>
        )}
        {unverified != null && (
          <div className="auth-help" role="alert">
            <strong>{t("auth.unverifiedTitle")}</strong>
            <p>{unverified ? t("auth.unverifiedBody", { email: unverified }) : t("auth.unverifiedBodyNoEmail")}</p>
            {unverified &&
              (resent ? (
                <p className="auth-ok">
                  <CheckCircle2 /> {t("auth.resent")}
                </p>
              ) : (
                <button type="button" className="btn btn-sm" onClick={resend}>
                  <MailCheck /> {t("auth.resend")}
                </button>
              ))}
          </div>
        )}
        <button className="btn btn-ink btn-lg btn-block" disabled={busy}>
          {busy ? <span className="spinner" /> : null}
          {busy ? t("auth.signingIn") : t("auth.signIn")}
          {!busy && <ArrowRight />}
        </button>
        {showHelp && (
          <div className="auth-help" id="auth-help" role="note">
            <strong>{t("auth.helpTitle")}</strong>
            <p>
              <HelpContact contact={helpContact} />
            </p>
          </div>
        )}
      </form>
    </AuthLayout>
  );
}

function NewAccountFields({
  username,
  setUsername,
  displayName,
  setDisplayName,
  password,
  setPassword,
  confirm,
  setConfirm,
  showIdentity = true,
}: {
  username: string;
  setUsername: (v: string) => void;
  displayName: string;
  setDisplayName: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  confirm: string;
  setConfirm: (v: string) => void;
  showIdentity?: boolean;
}) {
  const { t } = useI18n();
  // The rule is shown only once a too-short password has been left (or confirmed).
  const [leftPassword, setLeftPassword] = useState(false);
  const tooShort = password.length > 0 && password.length < 10 && (leftPassword || confirm.length > 0);
  return (
    <>
      {showIdentity && (
        <div className="auth-row">
          <div className="field">
            <label htmlFor="username">{t("auth.username")}</label>
            <input
              id="username"
              className="input"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              pattern="[A-Za-z0-9][A-Za-z0-9._\-]{1,31}"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="displayName">{t("auth.displayName")}</label>
            <input id="displayName" className="input" autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
          </div>
        </div>
      )}
      <div className="field">
        <label htmlFor="password">{t("auth.password")}</label>
        <input
          id="password"
          className="input"
          type="password"
          autoComplete="new-password"
          minLength={10}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onBlur={() => setLeftPassword(true)}
          aria-invalid={tooShort || undefined}
          aria-describedby={tooShort ? "password-rule" : undefined}
          required
        />
        {tooShort && (
          <span id="password-rule" className="field-error">
            {t("apiError.weakPassword")}
          </span>
        )}
      </div>
      <div className="field">
        <label htmlFor="confirm">{t("auth.confirmPassword")}</label>
        <input
          id="confirm"
          className="input"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
        {confirm && confirm !== password && <span className="field-error">{t("auth.mismatch")}</span>}
      </div>
    </>
  );
}

export function SetupPage() {
  const { t } = useI18n();
  const { setUser, needsSetup, loading } = useAuth();
  const navigate = useNavigate();
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("admin");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError(t("auth.mismatch"));
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.setup({ setupToken: token.trim(), username: username.trim(), displayName: displayName.trim(), password });
      setUser(user);
      navigate("/", { replace: true });
    } catch (err) {
      setError(apiErrorMessage(err, t));
      setBusy(false);
    }
  };

  if (!loading && !needsSetup) return <Navigate to="/login" replace />;

  return (
    <AuthLayout>
      <form className="auth-form" onSubmit={submit}>
        <div>
          <span className="pill accent" style={{ marginBottom: 14 }}>
            <KeyRound style={{ width: 12, height: 12 }} /> {t("auth.firstRun")}
          </span>
          <h2>{t("auth.setupTitle")}</h2>
          <p className="muted">{t("auth.setupLede")}</p>
        </div>
        <div className="field">
          <label htmlFor="token">{t("auth.setupToken")}</label>
          <input id="token" className="input mono" value={token} onChange={(e) => setToken(e.target.value)} autoFocus required spellCheck={false} />
        </div>
        <NewAccountFields {...{ username, setUsername, displayName, setDisplayName, password, setPassword, confirm, setConfirm }} />
        {error && (
          <div className="field-error" role="alert">
            <AlertCircle /> {error}
          </div>
        )}
        <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
          {busy && <span className="spinner" />}
          {t("auth.createAdmin")}
        </button>
      </form>
    </AuthLayout>
  );
}

export function InvitePage() {
  const { t } = useI18n();
  const { token = "" } = useParams();
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const info = useQuery({ queryKey: ["invite", token], queryFn: () => api.inviteInfo(token), retry: false });
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isReset = info.data?.kind === "reset";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError(t("auth.mismatch"));
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.acceptInvite(
        token,
        isReset ? { password } : { username: username.trim(), displayName: displayName.trim(), password },
      );
      setUser(user);
      navigate("/", { replace: true });
    } catch (err) {
      setError(apiErrorMessage(err, t));
      setBusy(false);
    }
  };

  return (
    <AuthLayout>
      {info.isLoading ? (
        <div className="auth-form">
          <div className="skeleton" style={{ height: 36, width: "60%" }} />
          <div className="skeleton" style={{ height: 18, width: "80%" }} />
        </div>
      ) : info.isError ? (
        <div className="auth-form">
          <h2>{t("auth.invalidLink")}</h2>
          <Link to="/login" className="btn btn-ink btn-lg">
            {t("auth.goToSignIn")} <ArrowRight />
          </Link>
        </div>
      ) : (
        <form className="auth-form" onSubmit={submit}>
          <div>
            <h2>{isReset ? t("auth.resetTitle") : t("auth.inviteTitle")}</h2>
            <p className="muted">{isReset ? t("auth.resetLede", { username: info.data?.username ?? "" }) : t("auth.inviteLede")}</p>
          </div>
          <NewAccountFields
            {...{ username, setUsername, displayName, setDisplayName, password, setPassword, confirm, setConfirm }}
            showIdentity={!isReset}
          />
          {error && (
          <div className="field-error" role="alert">
            <AlertCircle /> {error}
          </div>
        )}
          <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
            {busy && <span className="spinner" />}
            {isReset ? t("auth.setPassword") : t("auth.createAccount")}
          </button>
        </form>
      )}
    </AuthLayout>
  );
}

/** Creating an account with an email address (when the administrator opened sign-up). */
export function RegisterPage() {
  const { t, locale } = useI18n();
  const { registration, loading, termsUrl } = useAuth();
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError(t("auth.mismatch"));
    setBusy(true);
    setError(null);
    try {
      const res = await api.register({ username: username.trim(), displayName: displayName.trim(), email: email.trim(), password, locale });
      setSentTo(res.email);
    } catch (err) {
      setError(apiErrorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (!sentTo) return;
    try {
      await api.resendVerification(sentTo, locale);
      setResent(true);
    } catch (err) {
      setError(apiErrorMessage(err, t));
    }
  };

  if (!loading && !registration) return <Navigate to="/login" replace />;

  return (
    <AuthLayout>
      {sentTo ? (
        <div className="auth-form">
          <div>
            <span className="auth-badge">
              <MailCheck />
            </span>
            <h2>{t("auth.checkInbox")}</h2>
            <p className="muted">{t("auth.checkInboxBody", { email: sentTo })}</p>
          </div>
          <p className="faint">{t("auth.checkInboxHint")}</p>
          {error && (
            <div className="field-error" role="alert">
              <AlertCircle /> {error}
            </div>
          )}
          {resent ? (
            <p className="auth-ok">
              <CheckCircle2 /> {t("auth.resent")}
            </p>
          ) : (
            <button type="button" className="btn btn-lg btn-block" onClick={resend}>
              {t("auth.resend")}
            </button>
          )}
          <Link to="/login" className="btn btn-ink btn-lg btn-block">
            {t("auth.goToSignIn")} <ArrowRight />
          </Link>
        </div>
      ) : (
        <form className="auth-form" onSubmit={submit}>
          <div>
            <h2>{t("auth.registerTitle")}</h2>
            <p className="muted">{t("auth.registerLede")}</p>
          </div>
          <div className="field">
            <label htmlFor="email">{t("auth.email")}</label>
            <input id="email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </div>
          <NewAccountFields {...{ username, setUsername, displayName, setDisplayName, password, setPassword, confirm, setConfirm }} />
          {error && (
            <div className="field-error" role="alert">
              <AlertCircle /> {error}
            </div>
          )}
          <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
            {busy && <span className="spinner" />}
            {t("auth.createAccount")}
          </button>
          {termsUrl && (
            <p className="faint auth-foot">
              {t("auth.termsNote")}{" "}
              <a href={termsUrl} target="_blank" rel="noopener noreferrer">
                {t("billing.terms")}
              </a>
            </p>
          )}
          <p className="faint auth-foot">
            {t("auth.haveAccount")} <Link to="/login">{t("auth.signIn")}</Link>
          </p>
        </form>
      )}
    </AuthLayout>
  );
}

/** The link from the confirmation email. */
export function VerifyEmailPage() {
  const { t } = useI18n();
  const { token = "" } = useParams();
  const { user } = useAuth();
  const [state, setState] = useState<{ kind: "busy" } | { kind: "ok"; username: string } | { kind: "error"; message: string }>({ kind: "busy" });
  const sent = useRef(false);

  useEffect(() => {
    // Once, even under React's double effects in development: the link works one time.
    if (sent.current) return;
    sent.current = true;
    api.verifyEmail(token).then(
      (r) => setState({ kind: "ok", username: r.username }),
      (err) => setState({ kind: "error", message: apiErrorMessage(err, t) }),
    );
  }, [token, t]);

  return (
    <AuthLayout>
      <div className="auth-form">
        {state.kind === "busy" ? (
          <>
            <div className="skeleton" style={{ height: 36, width: "60%" }} />
            <div className="skeleton" style={{ height: 18, width: "80%" }} />
          </>
        ) : state.kind === "ok" ? (
          <>
            <div>
              <span className="auth-badge ok">
                <CheckCircle2 />
              </span>
              <h2>{t("auth.verifiedTitle")}</h2>
              <p className="muted">{user ? t("auth.verifiedBodySignedIn") : t("auth.verifiedBody", { username: state.username })}</p>
            </div>
            <Link to={user ? "/settings" : "/login"} className="btn btn-ink btn-lg btn-block">
              {user ? t("auth.backToSettings") : t("auth.goToSignIn")} <ArrowRight />
            </Link>
          </>
        ) : (
          <>
            <div>
              <h2>{t("auth.verifyFailedTitle")}</h2>
              <p className="muted">{state.message}</p>
            </div>
            <Link to="/login" className="btn btn-ink btn-lg btn-block">
              {t("auth.goToSignIn")} <ArrowRight />
            </Link>
          </>
        )}
      </div>
    </AuthLayout>
  );
}

/** "Forgot password": a reset link is emailed to the account's confirmed address. */
export function ForgotPasswordPage() {
  const { t, locale } = useI18n();
  const { passwordReset, helpContact, loading } = useAuth();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.forgotPassword(email.trim(), locale);
      setSent(true);
    } catch (err) {
      setError(apiErrorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  if (!loading && !passwordReset) return <Navigate to="/login" replace />;

  return (
    <AuthLayout>
      {sent ? (
        <div className="auth-form">
          <div>
            <span className="auth-badge">
              <MailCheck />
            </span>
            <h2>{t("auth.checkInbox")}</h2>
            <p className="muted">{t("auth.resetSentBody", { email: email.trim() })}</p>
          </div>
          <Link to="/login" className="btn btn-ink btn-lg btn-block">
            {t("auth.goToSignIn")} <ArrowRight />
          </Link>
        </div>
      ) : (
        <form className="auth-form" onSubmit={submit}>
          <div>
            <h2>{t("auth.forgotTitle")}</h2>
            <p className="muted">{t("auth.forgotLede")}</p>
          </div>
          <div className="field">
            <label htmlFor="email">{t("auth.email")}</label>
            <input id="email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </div>
          {error && (
            <div className="field-error" role="alert">
              <AlertCircle /> {error}
            </div>
          )}
          <button className="btn btn-primary btn-lg btn-block" disabled={busy || !email.trim()}>
            {busy && <span className="spinner" />}
            {t("auth.sendResetLink")}
          </button>
          <p className="faint auth-foot">
            {t("auth.noEmailOnAccount")} <HelpContact contact={helpContact} />
          </p>
          <p className="faint auth-foot">
            <Link to="/login">{t("auth.backToSignIn")}</Link>
          </p>
        </form>
      )}
    </AuthLayout>
  );
}
