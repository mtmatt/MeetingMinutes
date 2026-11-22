import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AudioLines, Cloud, Cpu, KeyRound, MemoryStick, RotateCcw, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { ApiKeyName, AsrProvider, TranscriberSettings, TranscriberState } from "../api/types";
import { useConfirm } from "../components/Modal";
import { useToast } from "../components/Toast";
import { type TKey, useI18n } from "../i18n";
import { relative } from "../lib/format";

/** Models offered per provider; the first is the default. Any other model name can be typed. */
const SUGGESTED: Record<AsrProvider, { model: string; note: TKey }[]> = {
  openrouter: [
    { model: "qwen/qwen3-asr-1.7b", note: "asr.noteQwen" },
    { model: "qwen/qwen3-asr-0.6b", note: "asr.noteQwenSmall" },
    { model: "openai/whisper-large-v3", note: "asr.noteWhisper" },
  ],
  openai: [
    { model: "whisper-1", note: "asr.noteOpenAI" },
    { model: "gpt-4o-transcribe", note: "asr.noteOpenAI" },
    { model: "whisper-large-v3", note: "asr.noteGroq" },
  ],
};

const MODEL_NAME = /^[\w][\w.:/@+-]{0,199}$/;

function validUrl(s: string): boolean {
  if (s.trim() === "") return true;
  try {
    const u = new URL(s.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function isLoopback(s: string): boolean {
  try {
    const host = new URL(s.trim()).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Admin → Transcription: speech recognition on the worker's GPU, or through a transcription API. */
export function Transcription() {
  const { t, locale } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const qc = useQueryClient();
  // Workers report their keys in heartbeats (every 20 s); follow them while the page is open.
  const { data } = useQuery({ queryKey: ["admin", "transcriber"], queryFn: api.adminTranscriber, refetchInterval: 20_000 });
  const [form, setForm] = useState<TranscriberSettings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data && !form) setForm(data.settings);
  }, [data, form]);

  if (!data || !form) return <div className="skeleton" style={{ height: 320 }} />;
  const dirty = !same(form, data.settings);
  const setApi = (patch: Partial<TranscriberSettings["api"]>) => setForm({ ...form, api: { ...form.api, ...patch } });
  const modelOk = MODEL_NAME.test(form.api.model.trim());
  const urlOk = form.api.provider === "openrouter" || validUrl(form.api.baseUrl);

  const applied = async (next: TranscriberState, message: string) => {
    qc.setQueryData(["admin", "transcriber"], next);
    setForm(next.settings);
    // Everyone's privacy note follows the new choice.
    await Promise.all([qc.invalidateQueries({ queryKey: ["auth"] }), qc.invalidateQueries({ queryKey: ["admin", "system"] })]);
    toast.show(message);
  };

  const save = async () => {
    setBusy(true);
    try {
      const body: TranscriberSettings = {
        engine: form.engine,
        diarization: form.diarization,
        api: {
          provider: form.api.provider,
          baseUrl: form.api.provider === "openrouter" ? "" : form.api.baseUrl.trim(),
          model: form.api.model.trim(),
        },
      };
      await applied(await api.adminSaveTranscriber(body), t("common.saved"));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    const ok = await confirm({ title: t("model.resetTitle"), body: t("asr.resetBody"), confirmLabel: t("model.reset") });
    if (!ok) return;
    try {
      await applied(await api.adminResetTranscriber(), t("model.resetDone"));
    } catch (e) {
      toast.error(e);
    }
  };

  const chooseProvider = (provider: AsrProvider) => {
    if (provider === form.api.provider) return;
    // A model name means something only to its own provider: start from that provider's first suggestion.
    setApi({ provider, model: SUGGESTED[provider][0]!.model, baseUrl: provider === "openrouter" ? "" : form.api.baseUrl });
  };

  const address = form.api.provider === "openrouter" ? data.addresses.openrouter : form.api.baseUrl.trim() || data.addresses.openai;
  const remote = validUrl(address) && !isLoopback(address);
  const canSave = dirty && !busy && (form.engine === "local" || (modelOk && urlOk));
  // Online workers that can run what is chosen; one without GPU packages runs only the APIs.
  const online = data.workers;
  const capable = online.filter((w) => {
    const c = w.capabilities ?? { asr: ["local", "api"], diarization: ["local"] };
    return c.asr.includes(form.engine) && c.diarization.includes(form.diarization);
  });
  // Nothing on the GPU: a worker installed without GPU packages can run it.
  const noGpu = form.engine === "api" && form.diarization !== "local";

  return (
    <div className="model-admin">
      <section className="model-section">
        <div className="model-section-head">
          <h3 className="system-h">
            <AudioLines /> {t("asr.engine")}
          </h3>
          <p className="muted">{t("asr.engineLede")}</p>
        </div>
        <div className="source-grid" role="radiogroup" aria-label={t("asr.engine")}>
          <button type="button" role="radio" aria-checked={form.engine === "local"} className="source-option" onClick={() => setForm({ ...form, engine: "local" })}>
            <Cpu />
            <span className="source-option-name">{t("asr.local")}</span>
            <span className="source-option-desc">{t("asr.localDesc")}</span>
          </button>
          <button type="button" role="radio" aria-checked={form.engine === "api"} className="source-option" onClick={() => setForm({ ...form, engine: "api" })}>
            <Cloud />
            <span className="source-option-name">{t("asr.api")}</span>
            <span className="source-option-desc">{t("asr.apiDesc")}</span>
          </button>
        </div>
      </section>

      {form.engine === "api" && (
        <section className="model-section card model-card">
          <h3 className="system-h">
            <Cloud /> {t("asr.api")}
          </h3>
          <div className="model-grid asr-grid">
            <div className="field">
              <span className="field-label">{t("asr.provider")}</span>
              <div className="segmented">
                <button type="button" aria-pressed={form.api.provider === "openrouter"} onClick={() => chooseProvider("openrouter")}>
                  OpenRouter
                </button>
                <button type="button" aria-pressed={form.api.provider === "openai"} onClick={() => chooseProvider("openai")}>
                  {t("model.openai")}
                </button>
              </div>
              <span className="field-hint">{form.api.provider === "openrouter" ? t("asr.openrouterHint") : t("asr.openaiHint")}</span>
            </div>
            {form.api.provider === "openai" && (
              <div className="field">
                <label htmlFor="asr-url">{t("model.baseUrl")}</label>
                <input
                  id="asr-url"
                  className="input mono"
                  value={form.api.baseUrl}
                  placeholder={data.addresses.openai}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={!urlOk}
                  onChange={(e) => setApi({ baseUrl: e.target.value })}
                />
                <span className="field-hint">{t("asr.baseUrlHint")}</span>
                {/\/audio\/transcriptions\/?$/i.test(form.api.baseUrl.trim()) && <span className="field-hint">{t("model.endpointStripped")}</span>}
              </div>
            )}
            <div className="field">
              <label htmlFor="asr-model">{t("model.model")}</label>
              <input
                id="asr-model"
                className="input mono"
                value={form.api.model}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={!modelOk}
                onChange={(e) => setApi({ model: e.target.value })}
              />
              <div className="asr-suggestions">
                {SUGGESTED[form.api.provider].map((s) => (
                  <button
                    type="button"
                    key={s.model}
                    className="asr-suggestion"
                    aria-pressed={form.api.model.trim() === s.model}
                    onClick={() => setApi({ model: s.model })}
                  >
                    <span className="mono">{s.model}</span>
                    <span className="faint">{t(s.note)}</span>
                  </button>
                ))}
              </div>
              <span className="field-hint">{form.api.provider === "openrouter" ? t("asr.modelHintOpenRouter") : t("asr.modelHint")}</span>
            </div>
          </div>

          <KeyStatus data={data} provider={form.api.provider} />

          <p className="field-hint asr-flow">{remote ? t("asr.flowRemote", { host: new URL(address).host }) : t("asr.flowLocal")}</p>
          <p className="field-hint asr-flow">{t("asr.gpuNote")}</p>
        </section>
      )}

      <section className="model-section">
        <div className="model-section-head">
          <h3 className="system-h">
            <Users /> {t("asr.diarization")}
          </h3>
          <p className="muted">{t("asr.diarizationLede")}</p>
        </div>
        <div className="source-grid source-grid-3" role="radiogroup" aria-label={t("asr.diarization")}>
          <button
            type="button"
            role="radio"
            aria-checked={form.diarization === "local"}
            className="source-option"
            onClick={() => setForm({ ...form, diarization: "local" })}
          >
            <Cpu />
            <span className="source-option-name">{t("asr.diarizationLocal")}</span>
            <span className="source-option-desc">{t("asr.diarizationLocalDesc")}</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={form.diarization === "cpu"}
            className="source-option"
            onClick={() => setForm({ ...form, diarization: "cpu" })}
          >
            <MemoryStick />
            <span className="source-option-name">{t("asr.diarizationCpu")}</span>
            <span className="source-option-desc">{t("asr.diarizationCpuDesc")}</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={form.diarization === "pyannoteai"}
            className="source-option"
            onClick={() => setForm({ ...form, diarization: "pyannoteai" })}
          >
            <Cloud />
            <span className="source-option-name">pyannoteAI</span>
            <span className="source-option-desc">{t("asr.diarizationCloudDesc")}</span>
          </button>
        </div>
        {form.diarization === "cpu" && <p className="field-hint asr-flow">{t("asr.diarizationCpuFlow")}</p>}
        {form.diarization === "pyannoteai" && (
          <div className="model-section card model-card asr-key-card">
            <KeyStatus data={data} provider="pyannoteai" />
            <p className="field-hint asr-flow">{t("asr.diarizationFlow")}</p>
          </div>
        )}
      </section>

      {noGpu && <p className="callout asr-callout">{t("asr.noGpuNeeded")}</p>}
      {online.length > 0 && capable.length === 0 && (
        <div className="callout warn asr-callout" role="alert">
          <div>
            <strong>{t("asr.noCapableTitle")}</strong>
            <p>{t("asr.noCapableBody")}</p>
          </div>
        </div>
      )}

      <div className="model-actions">
        <button className="btn btn-primary" onClick={save} disabled={!canSave}>
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
      {dirty && <p className="field-hint model-switch-note">{t("asr.switchNote")}</p>}
    </div>
  );
}

/** Whether the workers that will send the audio have a key for this service (they report it; the key never leaves them). */
function KeyStatus({ data, provider }: { data: TranscriberState; provider: ApiKeyName }) {
  const { t } = useI18n();
  const variables = data.keyVariables[provider];
  const missing = data.workers.filter((w) => !w.keys?.[provider]);
  return (
    <div className="model-status" aria-live="polite">
      <div className="model-status-head">
        <span className="field-label">
          <KeyRound /> {t("asr.keys")}
        </span>
      </div>
      {data.workers.length === 0 ? (
        <p className="faint">{t("asr.noWorkers")}</p>
      ) : (
        <dl className="kv">
          {data.workers.map((w) => (
            <div key={w.id} style={{ display: "contents" }}>
              <dt className="mono">{w.name}</dt>
              <dd>
                {w.keys === null ? (
                  <span className="pill warn">
                    <span className="dot" />
                    {t("asr.workerTooOld")}
                  </span>
                ) : w.keys[provider] ? (
                  <span className="pill ok">
                    <span className="dot" />
                    {t("asr.keySet")}
                  </span>
                ) : (
                  <span className="pill warn">
                    <span className="dot" />
                    {t("asr.keyMissing")}
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {(missing.length > 0 || data.workers.length === 0) && (
        <div className="asr-key-help">
          <p className="muted">{t("asr.keyHelp", { names: variables.join(" / ") })}</p>
          <pre className="mono asr-env">{`${variables[0]}=${provider === "openrouter" ? "sk-or-v1-…" : provider === "pyannoteai" ? "sk_…" : "sk-…"}`}</pre>
          <p className="faint">{t("asr.keyRestart")}</p>
        </div>
      )}
    </div>
  );
}
