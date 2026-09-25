import { AudioLines, FileAudio, FileVideo, Minus, Plus, Upload as UploadIcon, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { ApiError, api, uploadFile } from "../api/client";
import type { Script, SummaryRequest, TranscribeOptions } from "../api/types";
import { SummaryComposer, defaultOutputLanguage } from "../components/SummaryComposer";
import { useToast } from "../components/Toast";
import { useI18n } from "../i18n";
import { bytes, clock, fromLocalInput, toLocalInput } from "../lib/format";
import { takePendingFile } from "../lib/pendingFile";

const MAX_BYTES = 4096 * 1024 * 1024;
const AUDIO = ["mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus", "wma", "amr", "aiff", "aif", "caf", "weba"];
const VIDEO = ["mp4", "mov", "mkv", "webm", "avi", "m4v", "wmv", "flv", "ts", "mts", "m2ts", "3gp", "mpeg", "mpg"];
const ACCEPT = [...AUDIO, ...VIDEO].map((e) => "." + e).join(",") + ",audio/*,video/*";
const LANGUAGES = ["auto", "Chinese", "English", "Cantonese", "Japanese", "Korean"] as const;

type SpeakerMode = "auto" | "exact" | "range" | "off";

function extOf(name: string) {
  return (name.split(".").pop() ?? "").toLowerCase();
}

function titleFromFile(name: string) {
  return name
    .replace(/\.[^.]+$/, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function Step({ n, title, children, aside }: { n: string; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="form-step">
      <header className="form-step-head">
        <span className="form-step-n mono">{n}</span>
        <h2>{title}</h2>
        {aside && <div className="form-step-aside">{aside}</div>}
      </header>
      <div className="form-step-body">{children}</div>
    </section>
  );
}

function Stepper({ value, onChange, min = 1, max = 20 }: { value: number; onChange: (n: number) => void; min?: number; max?: number }) {
  return (
    <div className="stepper">
      <button type="button" className="icon-btn sm" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label="-">
        <Minus />
      </button>
      <span className="mono">{value}</span>
      <button type="button" className="icon-btn sm" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} aria-label="+">
        <Plus />
      </button>
    </div>
  );
}

export function UploadPage() {
  const { t, tMaybe, locale } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();

  const [file, setFile] = useState<File | null>(null);
  const [mediaDuration, setMediaDuration] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [occurredAt, setOccurredAt] = useState<string>(toLocalInput(Date.now()));
  const [language, setLanguage] = useState<string>("auto");
  const [speakerMode, setSpeakerMode] = useState<SpeakerMode>("auto");
  const [exact, setExact] = useState(3);
  const [range, setRange] = useState<[number, number]>([2, 6]);
  const [vocabulary, setVocabulary] = useState("");
  const [script, setScript] = useState<Script>("zh-TW");
  const [autoSummary, setAutoSummary] = useState(true);
  const [summary, setSummary] = useState<SummaryRequest>({
    templateId: "builtin-minutes",
    prompt: "",
    outputLanguage: defaultOutputLanguage(locale),
  });
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [upload, setUpload] = useState<{ sent: number; total: number; startedAt: number; finishing: boolean } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const meetingIdRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const accept = (f: File) => {
    const ext = extOf(f.name);
    if (!AUDIO.includes(ext) && !VIDEO.includes(ext)) {
      setError(t("upload.unsupported"));
      return;
    }
    if (f.size > MAX_BYTES) {
      setError(t("upload.tooLarge", { size: bytes(MAX_BYTES) }));
      return;
    }
    setError(null);
    setFile(f);
    if (!titleTouched) setTitle(titleFromFile(f.name));
    if (f.lastModified) setOccurredAt(toLocalInput(f.lastModified));
  };

  useEffect(() => {
    const pending = takePendingFile();
    if (pending) accept(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Read the duration locally so the user sees it before uploading.
  useEffect(() => {
    setMediaDuration(null);
    if (!file) return;
    const url = URL.createObjectURL(file);
    const el = document.createElement(VIDEO.includes(extOf(file.name)) ? "video" : "audio");
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      if (Number.isFinite(el.duration)) setMediaDuration(el.duration);
      URL.revokeObjectURL(url);
    };
    el.onerror = () => URL.revokeObjectURL(url);
    el.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (!upload) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [upload]);

  const options: TranscribeOptions = useMemo(
    () => ({
      language,
      diarize: speakerMode !== "off",
      numSpeakers: speakerMode === "exact" ? exact : null,
      minSpeakers: speakerMode === "range" ? range[0] : null,
      maxSpeakers: speakerMode === "range" ? range[1] : null,
      vocabulary: vocabulary.trim(),
      script,
    }),
    [language, speakerMode, exact, range, vocabulary, script],
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return setError(t("upload.needFile"));
    if (!title.trim()) return setError(t("upload.needTitle"));
    setError(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setUpload({ sent: 0, total: file.size, startedAt: performance.now(), finishing: false });
    try {
      const { meeting, chunkSize } = await api.createMeeting({
        title: title.trim(),
        occurredAt: fromLocalInput(occurredAt),
        file: { name: file.name, size: file.size, type: file.type },
        options,
        summary: autoSummary && summary.prompt.trim() ? summary : null,
      });
      meetingIdRef.current = meeting.id;
      await uploadFile(meeting.id, file, chunkSize, (sent, total) => setUpload((u) => (u ? { ...u, sent, total } : u)), ctrl.signal);
      setUpload((u) => (u ? { ...u, finishing: true } : u));
      await api.completeUpload(meeting.id);
      navigate(`/m/${meeting.id}`, { replace: true });
    } catch (err) {
      setUpload(null);
      if (err instanceof ApiError && err.code === "aborted") return;
      toast.error(err);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const cancelUpload = async () => {
    abortRef.current?.abort();
    setUpload(null);
    if (meetingIdRef.current) await api.deleteMeeting(meetingIdRef.current).catch(() => undefined);
    meetingIdRef.current = null;
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) accept(f);
  };

  const isVideo = file ? VIDEO.includes(extOf(file.name)) : false;

  return (
    <div className="upload">
      <div className="page-head">
        <div>
          <div className="smallcaps eyebrow">{t("nav.new")}</div>
          <h1>{t("upload.title")}</h1>
          <p className="lede">{t("upload.lede")}</p>
        </div>
      </div>
      <hr className="rule-double" />

      <form className="upload-form" onSubmit={submit}>
        <Step n="01" title={t("upload.step1")}>
          {!file ? (
            <label
              className={`dropzone ${dragging ? "dragging" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <input ref={inputRef} type="file" accept={ACCEPT} className="visually-hidden" onChange={(e) => e.target.files?.[0] && accept(e.target.files[0])} />
              <span className="dropzone-icon">
                <AudioLines />
              </span>
              <span className="dropzone-title">{t("upload.drop")}</span>
              <span className="dropzone-sub">
                <u>{t("upload.browse")}</u>
              </span>
              <span className="dropzone-formats">{t("upload.formats", { size: bytes(MAX_BYTES) })}</span>
            </label>
          ) : (
            <div className="file-card">
              <span className="file-card-icon">{isVideo ? <FileVideo /> : <FileAudio />}</span>
              <div className="file-card-main">
                <div className="file-card-name">{file.name}</div>
                <div className="file-card-meta mono">
                  {bytes(file.size)}
                  {mediaDuration != null && <> · {clock(mediaDuration)}</>}
                  {" · "}
                  {extOf(file.name).toUpperCase()}
                </div>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => inputRef.current?.click()}>
                {t("upload.replace")}
              </button>
              <button type="button" className="icon-btn" onClick={() => setFile(null)} aria-label={t("common.delete")}>
                <X />
              </button>
              <input ref={inputRef} type="file" accept={ACCEPT} className="visually-hidden" onChange={(e) => e.target.files?.[0] && accept(e.target.files[0])} />
            </div>
          )}
        </Step>

        <Step n="02" title={t("upload.step2")}>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="title">{t("upload.meetingTitle")}</label>
              <input
                id="title"
                className="input input-title"
                value={title}
                placeholder={t("upload.titlePlaceholder")}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setTitleTouched(true);
                }}
                maxLength={200}
              />
            </div>
            <div className="field">
              <label htmlFor="date">{t("upload.date")}</label>
              <input id="date" className="input" type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
            </div>
          </div>
        </Step>

        <Step n="03" title={t("upload.step3")}>
          <div className="field">
            <span className="field-label">{t("upload.language")}</span>
            <div className="segmented">
              {LANGUAGES.map((l) => (
                <button type="button" key={l} aria-pressed={language === l} onClick={() => setLanguage(l)}>
                  {tMaybe(`lang.${l}`) ?? l}
                </button>
              ))}
            </div>
            <span className="field-hint">{t("upload.languageHint")}</span>
          </div>

          <div className="field">
            <span className="field-label">{t("upload.speakers")}</span>
            <div className="speaker-mode">
              <div className="segmented">
                {(["auto", "exact", "range", "off"] as SpeakerMode[]).map((m) => (
                  <button type="button" key={m} aria-pressed={speakerMode === m} onClick={() => setSpeakerMode(m)}>
                    {t(m === "auto" ? "upload.speakersAuto" : m === "exact" ? "upload.speakersExact" : m === "range" ? "upload.speakersRange" : "upload.speakersOff")}
                  </button>
                ))}
              </div>
              {speakerMode === "exact" && <Stepper value={exact} onChange={setExact} />}
              {speakerMode === "range" && (
                <span className="range-inputs">
                  <Stepper value={range[0]} onChange={(n) => setRange([n, Math.max(n, range[1])])} />
                  <span className="faint">{t("upload.and")}</span>
                  <Stepper value={range[1]} onChange={(n) => setRange([Math.min(n, range[0]), n])} />
                </span>
              )}
            </div>
          </div>

          <div className="field">
            <label htmlFor="vocab">
              <span>
                {t("upload.vocabulary")} <span className="faint">· {t("common.optional")}</span>
              </span>
            </label>
            <textarea
              id="vocab"
              className="textarea"
              rows={2}
              value={vocabulary}
              onChange={(e) => setVocabulary(e.target.value)}
              placeholder={t("upload.vocabularyPlaceholder")}
              maxLength={2000}
              style={{ minHeight: 64 }}
            />
            <span className="field-hint">{t("upload.vocabularyHint")}</span>
          </div>

          <div className="field">
            <span className="field-label">{t("upload.script")}</span>
            <div className="segmented">
              {(["zh-TW", "zh-CN", "none"] as Script[]).map((s) => (
                <button type="button" key={s} aria-pressed={script === s} onClick={() => setScript(s)}>
                  {t(s === "zh-TW" ? "upload.scriptTW" : s === "zh-CN" ? "upload.scriptCN" : "upload.scriptNone")}
                </button>
              ))}
            </div>
          </div>
        </Step>

        <Step
          n="04"
          title={t("upload.step4")}
          aside={
            <label className="switch">
              <input type="checkbox" checked={autoSummary} onChange={(e) => setAutoSummary(e.target.checked)} />
              <span className="switch-track" />
              <span className="switch-label">{t("upload.autoSummary")}</span>
            </label>
          }
        >
          <div className={autoSummary ? "" : "disabled-block"} aria-disabled={!autoSummary}>
            <SummaryComposer value={summary} onChange={setSummary} />
          </div>
        </Step>

        <div className="upload-submit">
          {error && (
            <div className="field-error" role="alert">
              {error}
            </div>
          )}
          <button className="btn btn-primary btn-lg" disabled={!file || !!upload}>
            <UploadIcon /> {t("upload.submit")}
          </button>
        </div>
      </form>

      {upload && <UploadProgress upload={upload} fileName={file?.name ?? ""} onCancel={cancelUpload} />}
    </div>
  );
}

function UploadProgress({
  upload,
  fileName,
  onCancel,
}: {
  upload: { sent: number; total: number; startedAt: number; finishing: boolean };
  fileName: string;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const pct = upload.total ? Math.floor((upload.sent / upload.total) * 100) : 0;
  const elapsed = (performance.now() - upload.startedAt) / 1000;
  const rate = elapsed > 0.5 ? upload.sent / elapsed : 0;
  const eta = rate > 0 ? (upload.total - upload.sent) / rate : 0;
  return (
    <div className="scrim">
      <div className="upload-progress" role="dialog" aria-modal="true" aria-live="polite">
        <div className="upload-progress-num">
          <span className="mono">{upload.finishing ? 100 : pct}</span>
          <span className="pct">%</span>
        </div>
        <div className="upload-progress-name">{fileName}</div>
        <div className="progress" style={{ height: 6 }}>
          <span style={{ width: `${upload.finishing ? 100 : pct}%` }} />
        </div>
        <div className="upload-progress-detail mono">
          {upload.finishing
            ? t("upload.finishing")
            : t("upload.uploadingDetail", {
                sent: bytes(upload.sent),
                total: bytes(upload.total),
                rate: bytes(rate),
                eta: rate ? clock(eta) : "–",
              })}
        </div>
        {!upload.finishing && (
          <button className="btn btn-ghost" onClick={onCancel}>
            {t("upload.cancelUpload")}
          </button>
        )}
      </div>
    </div>
  );
}
