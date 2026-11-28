import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cloud, Cpu, Download, KeyRound, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { ApiModelSettings, ApiProvider, LocalModelSettings, SummarizerState, SummarySettings } from "../api/types";
import { useConfirm } from "../components/Modal";
import { useToast } from "../components/Toast";
import { useI18n } from "../i18n";
import { bytes, relative } from "../lib/format";
import { modelDisplayName } from "../lib/summaryEngine";

/** Models that suit one or two 24 GB GPUs, offered for Ollama next to what is installed. The first is the default. */
const SUGGESTED_OLLAMA = ["batiai/qwen3.8-27b:q3", "qwen3.8:27b", "qwen3:14b", "qwen3:30b"];

/** Models offered per hosted provider (any other name can be typed). The provider's suggested model comes first. */
const SUGGESTED_API: Record<ApiProvider, string[]> = {
  anthropic: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5"],
  openai: ["gpt-5-mini", "gpt-5", "gpt-5-nano"],
  openrouter: ["anthropic/claude-haiku-4.5", "google/gemini-2.5-flash", "qwen/qwen3-235b-a22b-2507"],
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"],
};
const API_ORDER: ApiProvider[] = ["anthropic", "openai", "openrouter", "gemini"];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** The address is this machine, so transcripts stay on the server. */
function isLoopback(s: string): boolean {
  try {
    const host = new URL(s.trim()).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

function validUrl(s: string): boolean {
  try {
    const u = new URL(s.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Admin → Summary model: which model writes summaries, and the state of the local model server. */
export function SummaryModel() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["admin", "summarizer"], queryFn: api.adminSummarizer });
  const [form, setForm] = useState<SummarySettings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data && !form) setForm(data.settings);
  }, [data, form]);

  if (!data || !form) return <div className="skeleton" style={{ height: 320 }} />;
  const dirty = !same(form, data.settings);
  const setLocal = (patch: Partial<LocalModelSettings>) => setForm({ ...form, local: { ...form.local, ...patch } });
  const setApi = (patch: Partial<ApiModelSettings>) => setForm({ ...form, api: { ...form.api, ...patch } });

  const applied = async (next: Awaited<ReturnType<typeof api.adminSummarizer>>, message: string) => {
    qc.setQueryData(["admin", "summarizer"], next);
    setForm(next.settings);
    // Everyone's privacy note and "{engine} is writing" follow the new choice.
    await Promise.all([qc.invalidateQueries({ queryKey: ["auth"] }), qc.invalidateQueries({ queryKey: ["admin", "system"] })]);
    toast.show(message);
  };

  const save = async () => {
    setBusy(true);
    try {
      const body: SummarySettings = {
        ...form,
        local: { ...form.local, baseUrl: form.local.baseUrl.trim(), model: form.local.model.trim() },
        api: { ...form.api, model: form.api.model.trim() },
      };
      await applied(await api.adminSaveSummarizer(body), t("common.saved"));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    const ok = await confirm({ title: t("model.resetTitle"), body: t("model.resetBody"), confirmLabel: t("model.reset") });
    if (!ok) return;
    try {
      await applied(await api.adminResetSummarizer(), t("model.resetDone"));
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="model-admin">
      <section className="model-section">
        <div className="model-section-head">
          <h3 className="system-h">{t("model.engine")}</h3>
          <p className="muted">{t("model.engineLede")}</p>
        </div>
        <div className="source-grid" role="radiogroup" aria-label={t("model.engine")}>
          <button type="button" role="radio" aria-checked={form.provider === "local"} className="source-option" onClick={() => setForm({ ...form, provider: "local" })}>
            <Cpu />
            <span className="source-option-name">{t("model.local")}</span>
            <span className="source-option-desc">{t("model.localDesc")}</span>
          </button>
          <button type="button" role="radio" aria-checked={form.provider === "api"} className="source-option" onClick={() => setForm({ ...form, provider: "api" })}>
            <Cloud />
            <span className="source-option-name">{t("model.api")}</span>
            <span className="source-option-desc">{t("model.apiDesc")}</span>
          </button>
        </div>
      </section>

      {form.provider === "local" ? (
        <LocalModelForm value={form.local} onChange={setLocal} apiKeyConfigured={data.apiKeyConfigured} />
      ) : (
        <ApiModelForm value={form.api} onChange={setApi} state={data} />
      )}

      <div className="model-actions">
        <button className="btn btn-primary" onClick={save} disabled={busy || !dirty}>
          {busy && <span className="spinner" />} {t("common.save")}
        </button>
        {dirty && (
          <button className="btn btn-ghost" onClick={() => setForm(data.settings)}>
            {t("model.discard")}
          </button>
        )}
        <span className="faint model-saved">
          {data.saved
            ? t("model.savedBy", { who: data.updatedBy ?? "–", when: data.updatedAt ? relative(data.updatedAt, t, locale) : "" })
            : t("model.usingEnv")}
        </span>
        {data.saved && (
          <button className="btn btn-sm btn-ghost" onClick={reset}>
            <RotateCcw /> {t("model.reset")}
          </button>
        )}
      </div>
      {data.settings.provider !== form.provider && <p className="field-hint model-switch-note">{t("model.switchNote")}</p>}
    </div>
  );
}

function LocalModelForm({
  value,
  onChange,
  apiKeyConfigured,
}: {
  value: LocalModelSettings;
  onChange: (patch: Partial<LocalModelSettings>) => void;
  apiKeyConfigured: boolean;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const target = useDebounced({ api: value.api, baseUrl: value.baseUrl.trim(), model: value.model.trim() }, 600);
  const canProbe = validUrl(target.baseUrl) && target.model.length > 0;
  const probe = useQuery({
    queryKey: ["admin", "model-probe", target],
    queryFn: () => api.adminProbeModel(target),
    enabled: canProbe,
    // Follow a download while it runs.
    refetchInterval: (q) => (q.state.data?.pull && !q.state.data.pull.done ? 1000 : false),
  });
  const status = probe.data?.status;
  const pull = probe.data?.pull && probe.data.pull.model === target.model ? probe.data.pull : null;
  const [pullSeen, setPullSeen] = useState<number | null>(null);

  // Tell the admin once when a download they started finishes.
  useEffect(() => {
    if (!pull?.done || pullSeen !== pull.startedAt) return;
    setPullSeen(null);
    if (pull.error) toast.error(new Error(pull.error));
    else toast.show(t("model.pullDone", { model: pull.model }));
  }, [pull, pullSeen, toast, t]);

  const startPull = async () => {
    try {
      const { pull: p } = await api.adminPullModel(target);
      setPullSeen(p.startedAt);
      await probe.refetch();
    } catch (e) {
      toast.error(e);
    }
  };

  const suggestions = useMemo(() => {
    const installed = status?.models.map((m) => m.name) ?? [];
    const extra = value.api === "ollama" ? SUGGESTED_OLLAMA.filter((m) => !installed.includes(m)) : [];
    return [...installed.map((name) => ({ name, installed: true })), ...extra.map((name) => ({ name, installed: false }))];
  }, [status, value.api]);

  const pullPct = pull?.total ? Math.min(100, ((pull.completed ?? 0) / pull.total) * 100) : null;
  const tooBig = status?.contextLength != null && value.contextTokens > status.contextLength;
  // "qwen3" is installed as "qwen3:latest".
  const installedDetails = status?.models.find((m) => m.name === target.model || m.name === `${target.model}:latest`)?.details ?? null;

  return (
    <section className="model-section card model-card">
      <h3 className="system-h">
        <Cpu /> {t("model.local")}
      </h3>
      <div className="model-grid">
        <div className="field">
          <span className="field-label">{t("model.server")}</span>
          <div className="segmented">
            <button
              type="button"
              aria-pressed={value.api === "ollama"}
              onClick={() => onChange({ api: "ollama", baseUrl: value.api === "ollama" ? value.baseUrl : "http://127.0.0.1:11434" })}
            >
              Ollama
            </button>
            <button
              type="button"
              aria-pressed={value.api === "openai"}
              onClick={() => onChange({ api: "openai", baseUrl: value.api === "openai" ? value.baseUrl : "http://127.0.0.1:8000/v1" })}
            >
              {t("model.openai")}
            </button>
          </div>
          <span className="field-hint">
            {value.api === "ollama"
              ? t("model.ollamaHint")
              : `${t("model.openaiHint")} ${apiKeyConfigured ? t("model.apiKeySet") : t("model.apiKeyUnset")}`}
          </span>
        </div>
        <div className="field">
          <label htmlFor="llm-url">{t("model.baseUrl")}</label>
          <input
            id="llm-url"
            className="input mono"
            value={value.baseUrl}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={!validUrl(value.baseUrl)}
            onChange={(e) => onChange({ baseUrl: e.target.value })}
          />
          <span className="field-hint">
            {validUrl(value.baseUrl) && !isLoopback(value.baseUrl) ? t("model.baseUrlRemote", { host: new URL(value.baseUrl.trim()).host }) : t("model.baseUrlHint")}
          </span>
          {/* A cloud API entered while "Ollama" is selected: the usual mix-up. */}
          {value.api === "ollama" && /^https:/i.test(value.baseUrl.trim()) && !isLoopback(value.baseUrl) && (
            <span className="field-error">{t("model.looksOpenAI")}</span>
          )}
          {/\/(chat\/completions|api\/chat)\/?$/i.test(value.baseUrl.trim()) && <span className="field-hint">{t("model.endpointStripped")}</span>}
        </div>
        <div className="field">
          <label htmlFor="llm-model">{t("model.model")}</label>
          <input
            id="llm-model"
            className="input mono"
            list="llm-models"
            value={value.model}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => onChange({ model: e.target.value })}
          />
          <datalist id="llm-models">
            {suggestions.map((m) => (
              <option key={m.name} value={m.name}>
                {m.installed ? t("model.installed") : t("model.notInstalled")}
              </option>
            ))}
          </datalist>
          <span className="field-hint">{t("model.modelHint")}</span>
        </div>
        <div className="field">
          <label htmlFor="llm-ctx">{t("model.context")}</label>
          <input
            id="llm-ctx"
            className="input mono"
            type="number"
            min={4096}
            max={1048576}
            step={1024}
            value={value.contextTokens}
            onChange={(e) => onChange({ contextTokens: Math.round(Number(e.target.value) || 0) })}
          />
          <span className="field-hint">
            {tooBig ? t("model.contextCapped", { n: status!.contextLength!.toLocaleString() }) : t("model.contextHint")}
          </span>
        </div>
        <div className="field">
          <span className="field-label">{t("model.think")}</span>
          <label className="switch">
            <input type="checkbox" checked={value.think} onChange={(e) => onChange({ think: e.target.checked })} />
            <span className="switch-track" />
            <span className={`switch-state ${value.think ? "on" : ""}`}>{value.think ? t("model.on") : t("model.off")}</span>
          </label>
          <span className="field-hint">{t("model.thinkHint")}</span>
        </div>
        <div className="field">
          <span className="field-label">{t("slides.adminVision")}</span>
          <label className="switch">
            <input type="checkbox" checked={!!value.vision} onChange={(e) => onChange({ vision: e.target.checked })} />
            <span className="switch-track" />
            <span className={`switch-state ${value.vision ? "on" : ""}`}>{value.vision ? t("model.on") : t("model.off")}</span>
          </label>
          <span className="field-hint">{t("slides.adminVisionHint")}</span>
        </div>
        {value.api === "ollama" && (
          <div className="field">
            <label htmlFor="llm-keep">{t("model.keepAlive")}</label>
            <input
              id="llm-keep"
              className="input mono"
              type="number"
              min={0}
              max={86400}
              step={30}
              value={value.keepAliveSec}
              onChange={(e) => onChange({ keepAliveSec: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
            />
            <span className="field-hint">{t("model.keepAliveHint")}</span>
          </div>
        )}
      </div>

      <div className="model-status" aria-live="polite">
        <div className="model-status-head">
          <span className="field-label">{t("model.status")}</span>
          <button className="btn btn-sm btn-ghost" onClick={() => probe.refetch()} disabled={!canProbe || probe.isFetching}>
            {probe.isFetching ? <span className="spinner" /> : <RefreshCw />} {t("model.check")}
          </button>
        </div>
        {!canProbe ? (
          <p className="faint">{t("model.enterAddress")}</p>
        ) : !status ? (
          <div className="skeleton" style={{ height: 48 }} />
        ) : !status.reachable ? (
          <div className="callout warn">
            <div>
              <strong>{t("model.unreachable")}</strong>
              <p className="mono model-error">{status.error}</p>
              {value.api === "ollama" && <p className="muted">{t("model.unreachableHelp")}</p>}
            </div>
          </div>
        ) : (
          <dl className="kv">
            <dt>{t("model.serverLabel")}</dt>
            <dd>
              <span className="pill ok">
                <span className="dot" />
                {status.server}
              </span>
            </dd>
            <dt>{modelDisplayName(target.model)}</dt>
            <dd className="model-installed">
              {status.installed ? (
                <span className="pill ok">
                  <span className="dot" />
                  {t("model.ready")}
                  {installedDetails && ` · ${installedDetails}`}
                </span>
              ) : (
                <span className="pill warn">
                  <span className="dot" />
                  {value.api === "ollama" ? t("model.notDownloaded") : t("model.notServed")}
                </span>
              )}
              {!status.installed && value.api === "ollama" && !(pull && !pull.done) && (
                <button className="btn btn-sm btn-ink" onClick={startPull}>
                  <Download /> {t("model.download")}
                </button>
              )}
            </dd>
            {pull && !pull.done && (
              <>
                <dt>{t("model.downloading")}</dt>
                <dd className="model-pull">
                  <div className={`progress ${pullPct == null ? "indeterminate" : ""}`}>
                    <span style={pullPct == null ? undefined : { width: `${pullPct}%` }} />
                  </div>
                  <span className="mono faint">
                    {pull.total ? `${bytes(pull.completed ?? 0)} / ${bytes(pull.total)}` : pull.status}
                  </span>
                </dd>
              </>
            )}
            {status.installed && status.contextLength != null && (
              <>
                <dt>{t("model.maxContext")}</dt>
                <dd className="mono">{t("model.tokens", { n: status.contextLength.toLocaleString() })}</dd>
              </>
            )}
            {status.installed && status.thinking != null && (
              <>
                <dt>{t("model.think")}</dt>
                <dd>{status.thinking ? t("model.canThink") : t("model.cannotThink")}</dd>
              </>
            )}
            {value.api === "ollama" && status.installed && (
              <>
                <dt>{t("model.memory")}</dt>
                <dd>
                  {status.loaded
                    ? t("model.loaded", { vram: bytes(status.loaded.vramBytes), total: bytes(status.loaded.sizeBytes) })
                    : t("model.unloaded")}
                </dd>
              </>
            )}
          </dl>
        )}
      </div>
    </section>
  );
}

/** A hosted model: the provider (its key comes from the server's .env), the model, and a check before saving. */
function ApiModelForm({ value, onChange, state }: { value: ApiModelSettings; onChange: (patch: Partial<ApiModelSettings>) => void; state: SummarizerState }) {
  const { t } = useI18n();
  const info = state.apiProviders[value.provider];
  const hasKey = state.apiKeys[value.provider];
  const target = useDebounced({ provider: value.provider, model: value.model.trim() }, 600);
  const probe = useQuery({
    queryKey: ["admin", "api-model-probe", target],
    queryFn: () => api.adminProbeApiModel(target),
    enabled: target.model.length > 0,
    staleTime: 60_000,
  });
  const result = probe.data;
  const suggestions = [...new Set([info.defaultModel, ...SUGGESTED_API[value.provider]])];

  return (
    <section className="model-section card model-card">
      <h3 className="system-h">
        <Cloud /> {t("model.api")}
      </h3>
      <div className="model-grid">
        <div className="field">
          <span className="field-label">{t("model.apiProvider")}</span>
          <div className="segmented">
            {API_ORDER.map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={value.provider === p}
                onClick={() => onChange({ provider: p, model: p === value.provider ? value.model : state.apiProviders[p].defaultModel })}
              >
                {state.apiProviders[p].label}
              </button>
            ))}
          </div>
          <span className="field-hint">{t("model.apiProviderHint", { host: info.host })}</span>
        </div>
        <div className="field">
          <label htmlFor="api-model">{t("model.model")}</label>
          <input
            id="api-model"
            className="input mono"
            list="api-models"
            value={value.model}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => onChange({ model: e.target.value })}
          />
          <datalist id="api-models">
            {suggestions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <span className="field-hint">{t("model.apiModelHint")}</span>
        </div>
        <div className="field">
          <span className="field-label">{t("model.apiKey")}</span>
          <span className={`pill ${hasKey ? "ok" : "warn"}`}>
            <KeyRound />
            {hasKey ? t("model.apiKeyFound", { name: info.keyVariables[0]! }) : t("model.apiKeyMissing")}
          </span>
          <span className="field-hint">{hasKey ? t("model.apiKeyFoundHint") : t("model.apiKeyMissingHint", { names: info.keyVariables.join(" / ") })}</span>
        </div>
        {value.provider !== "anthropic" && (
          <div className="field">
            <label htmlFor="api-ctx">{t("model.context")}</label>
            <input
              id="api-ctx"
              className="input mono"
              type="number"
              min={8192}
              max={2000000}
              step={1024}
              value={value.contextTokens}
              onChange={(e) => onChange({ contextTokens: Math.round(Number(e.target.value) || 0) })}
            />
            <span className="field-hint">{t("model.apiContextHint")}</span>
          </div>
        )}
      </div>

      <div className="model-status" aria-live="polite">
        <div className="model-status-head">
          <span className="field-label">{t("model.status")}</span>
          <button className="btn btn-sm btn-ghost" onClick={() => probe.refetch()} disabled={!target.model || probe.isFetching}>
            {probe.isFetching ? <span className="spinner" /> : <RefreshCw />} {t("model.check")}
          </button>
        </div>
        {!target.model ? (
          <p className="faint">{t("model.apiEnterModel")}</p>
        ) : !result ? (
          <div className="skeleton" style={{ height: 48 }} />
        ) : !result.ok ? (
          <div className="callout warn">
            <div>
              <strong>{result.keyConfigured ? t("model.apiNotUsable") : t("model.apiKeyMissing")}</strong>
              <p className="mono model-error">{result.error}</p>
            </div>
          </div>
        ) : (
          <dl className="kv">
            <dt>{target.model}</dt>
            <dd>
              <span className="pill ok">
                <span className="dot" />
                {t("model.apiReady", { provider: info.label })}
              </span>
            </dd>
            {result.contextLength != null && (
              <>
                <dt>{t("model.maxContext")}</dt>
                <dd className="mono">{t("model.tokens", { n: result.contextLength.toLocaleString() })}</dd>
              </>
            )}
            {result.maxOutputTokens != null && (
              <>
                <dt>{t("model.maxOutput")}</dt>
                <dd className="mono">{t("model.tokens", { n: result.maxOutputTokens.toLocaleString() })}</dd>
              </>
            )}
          </dl>
        )}
        <p className="field-hint">{t("model.apiPrivacy", { provider: info.label, host: info.host })}</p>
      </div>
    </section>
  );
}
