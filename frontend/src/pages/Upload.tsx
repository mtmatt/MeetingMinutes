import { AlertCircle, AlertTriangle, AudioLines, ChevronRight, Coins, Download, FileAudio, FileVideo, LogIn, Mic, Minus, Pause, Play, Plus, RefreshCw, FolderOpen, Square, Upload as UploadIcon, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { useBlocker, useNavigate, useSearchParams } from "react-router";
import { ApiError, api, uploadFile } from "../api/client";
import type { Preset, Script, SummaryRequest, TranscribeOptions } from "../api/types";
import { PresetBar, usePresets, type PresetValue } from "../components/Presets";
import { DataFlowNote, SummaryComposer, defaultOutputLanguage, normalizeRequest, useTemplates } from "../components/SummaryComposer";
import { useI18n, type TFn } from "../i18n";
import { bytes, clock, fromLocalInput, monthDay, time, toLocalInput } from "../lib/format";
import { Recorder, revealSource, sourceAlert, sourceScope } from "../components/Recorder";
import { Stepper } from "../components/Stepper";
import { useRecording, type RecordedFile, type RecordingController } from "../lib/useRecording";
import { useConfirm } from "../components/Modal";
import { useToast } from "../components/Toast";
import { deleteRecording } from "../lib/recordingStore";
import { takePendingFile } from "../lib/pendingFile";
import { classifyUploadError, type UploadFailure } from "../lib/errors";
import { useAuth } from "../lib/auth";
import { downloadBlob } from "../lib/download";
import { useBilling } from "../lib/billing";
import { pointsText, transcriptionCost } from "../lib/format";
import { SlideOption, useSlidesChoice } from "../components/SlideOption";
import { SlideStrip } from "../components/SlideStrip";
import { scanVideo, type CapturedSlide } from "../lib/slides";

/** Slides picked from the chosen video, as the page shows them. */
interface SlideScan {
  status: "scanning" | "done" | "failed";
  /** 0..1 of the video looked at. */
  done: number;
  slides: CapturedSlide[];
}

interface UploadProgress {
  sent: number;
  total: number;
  startedAt: number;
  finishing: boolean;
  /** Sending the slides, after the recording (waiting: the video is still being looked through). */
  slides?: { waiting: boolean; sent: number; total: number } | null;
}

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

function Step({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <section className="form-step">
      <header className="form-step-head">
        <span className="form-step-n">{n}</span>
        <h2>{title}</h2>
      </header>
      <div className="form-step-body">{children}</div>
    </section>
  );
}


export function UploadPage() {
  const { t, tMaybe, locale } = useI18n();
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const { uploadLimitBytes: limit, helpContact, mediaPolicy, refine: refineInfo } = useAuth();

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
  // Correct the transcript with a hosted model once it is transcribed (offered only when the site has it on).
  const [refine, setRefine] = useState(false);
  const [summary, setSummary] = useState<SummaryRequest>({
    templateId: "builtin-minutes",
    prompt: "",
    outputLanguage: defaultOutputLanguage(locale),
  });
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // The preset whose settings fill the form (null: none chosen).
  const [presetId, setPresetId] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const mode: "file" | "record" = params.get("mode") === "record" ? "record" : "file";
  const setMode = (m: "file" | "record") => setParams(m === "record" ? { mode: "record" } : {}, { replace: true });
  const rec = useRecording();
  const recordingBusy = rec.active;
  const [recording, setRecording] = useState<{ id: string; durationMs: number } | null>(null);
  const { data: templates } = useTemplates();
  const [dragging, setDragging] = useState(false);
  const [upload, setUpload] = useState<UploadProgress | null>(null);
  /** Why the last upload attempt failed; decides what the page offers next. */
  const [failure, setFailure] = useState<UploadFailure | null>(null);
  /** The uploader is retrying on its own after a dropped connection. */
  const [autoRetry, setAutoRetry] = useState<{ attempt: number; max: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** The meeting created for this file; a retry resumes it instead of starting over. */
  const target = useRef<{ meetingId: string; chunkSize: number; file: File } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Slides: picked from a video file here, or from the shared tab while recording.
  const [captureSlides, setCaptureSlides] = useSlidesChoice();
  const [scan, setScan] = useState<SlideScan | null>(null);
  /** The finished scan's slides (empty when it failed). */
  const scanDone = useRef<Promise<CapturedSlide[]> | null>(null);
  const [recordedSlides, setRecordedSlides] = useState<CapturedSlide[]>([]);
  /** Slides the person left out (by slot). */
  const [removedSlides, setRemovedSlides] = useState<Set<string>>(new Set());
  /** Slides already sent for the meeting being uploaded, so a retry does not send them again. */
  const sentSlides = useRef<{ meetingId: string; keys: Set<string> } | null>(null);

  const accept = (f: File) => {
    const ext = extOf(f.name);
    if (!AUDIO.includes(ext) && !VIDEO.includes(ext)) {
      setError(t("upload.unsupported"));
      return;
    }
    if (limit != null && f.size > limit) {
      setError(t("upload.fileTooLarge", { size: bytes(f.size), limit: bytes(limit) }));
      return;
    }
    setError(null);
    setFailure(null);
    target.current = null;
    setFile(f);
    setRecording(null);
    setRecordedSlides([]);
    setRemovedSlides(new Set());
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
    if (recording) {
      // Browser recordings carry no duration header; we know it exactly.
      setMediaDuration(recording.durationMs / 1000);
      return;
    }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  // A failure belongs to the file it happened with.
  useEffect(() => {
    if (!file) setFailure(null);
  }, [file]);

  // Object URL for listening to the file before uploading.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file || VIDEO.includes(extOf(file.name))) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Go through a chosen video for its slides, in the background, while the rest of the form is filled in.
  const scanTarget = file && !recording && captureSlides && VIDEO.includes(extOf(file.name)) ? file : null;
  useEffect(() => {
    setScan(null);
    scanDone.current = null;
    if (!scanTarget) return;
    const ctrl = new AbortController();
    setScan({ status: "scanning", done: 0, slides: [] });
    scanDone.current = scanVideo(scanTarget, {
      signal: ctrl.signal,
      onProgress: (p) => {
        if (!ctrl.signal.aborted) setScan({ status: "scanning", done: p.done, slides: p.slides });
      },
    }).then(
      (slides) => {
        if (!ctrl.signal.aborted) setScan({ status: "done", done: 1, slides });
        return slides;
      },
      () => {
        if (!ctrl.signal.aborted) setScan((s) => ({ status: "failed", done: s?.done ?? 0, slides: [] }));
        return [];
      },
    );
    return () => ctrl.abort();
  }, [scanTarget]);

  /** The slides that go with the recording. */
  const slides = (recording ? recordedSlides : captureSlides ? (scan?.slides ?? []) : []).filter((s) => !removedSlides.has(s.slot));
  const removeSlide = (slot: string) => setRemovedSlides((r) => new Set(r).add(slot));
  // The upload reads these after waiting for the scan to finish, outside React's render.
  const slideRefs = useRef({ recordedSlides, removedSlides });
  slideRefs.current = { recordedSlides, removedSlides };

  const guard = !!upload || recordingBusy;
  useEffect(() => {
    if (!guard) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [guard]);

  // In-app navigation away from an active recording or upload asks first.
  const allowLeave = useRef(false);
  const blocker = useBlocker(
    // Includes same-page changes such as /new?mode=record -> /new from the "New recording" menu.
    ({ currentLocation, nextLocation }) =>
      guard && !allowLeave.current && currentLocation.pathname + currentLocation.search !== nextLocation.pathname + nextLocation.search,
  );
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    void confirm({
      title: recordingBusy ? t("recorder.leaveTitle") : t("upload.leaveWarning"),
      body: recordingBusy ? t("recorder.leaveBody") : undefined,
      confirmLabel: t("recorder.leave"),
      danger: true,
    }).then((ok) => (ok ? blocker.proceed() : blocker.reset()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocker.state]);

  const onRecorded = useCallback(
    (r: RecordedFile) => {
      setError(null);
      target.current = null;
      // Known before sending anything: say so now rather than after a failed upload.
      setFailure(limit != null && r.file.size > limit ? { kind: "too-large", size: r.file.size, limit } : null);
      setRecording({ id: r.recordingId, durationMs: r.durationMs });
      setRecordedSlides(r.slides);
      setRemovedSlides(new Set());
      setFile(r.file);
      if (!titleTouched) {
        const when = `${monthDay(r.startedAt, locale)} ${time(r.startedAt, locale)}`;
        setTitle(r.source === "meeting" ? t("recorder.defaultTitleMeeting", { when }) : t("recorder.defaultTitleMic", { when }));
      }
      setOccurredAt(toLocalInput(r.startedAt));
    },
    [titleTouched, locale, t, limit],
  );

  const options: TranscribeOptions = useMemo(
    () => ({
      language,
      diarize: speakerMode !== "off",
      numSpeakers: speakerMode === "exact" ? exact : null,
      minSpeakers: speakerMode === "range" ? range[0] : null,
      maxSpeakers: speakerMode === "range" ? range[1] : null,
      vocabulary: vocabulary.trim(),
      script,
      refine: refine && !!refineInfo?.available,
    }),
    [language, speakerMode, exact, range, vocabulary, script, refine, refineInfo?.available],
  );

  const presetValue: PresetValue = useMemo(() => ({ options, summary: autoSummary ? summary : null }), [options, autoSummary, summary]);

  /** Fill the form from a preset (null: keep the settings, stop following a preset). */
  const applyPreset = useCallback((p: Preset | null) => {
    setPresetId(p?.id ?? null);
    if (!p) return;
    const o = p.options;
    setLanguage(o.language);
    if (!o.diarize) setSpeakerMode("off");
    else if (o.numSpeakers) {
      setSpeakerMode("exact");
      setExact(o.numSpeakers);
    } else if (o.minSpeakers && o.maxSpeakers) {
      setSpeakerMode("range");
      setRange([o.minSpeakers, o.maxSpeakers]);
    } else setSpeakerMode("auto");
    setVocabulary(o.vocabulary);
    setScript(o.script);
    setRefine(!!o.refine);
    setAutoSummary(!!p.summary);
    if (p.summary) setSummary(p.summary);
  }, []);

  // The default preset fills the form when the page opens.
  const presets = usePresets();
  const defaultApplied = useRef(false);
  useEffect(() => {
    if (defaultApplied.current || !presets.data) return;
    defaultApplied.current = true;
    const d = presets.data.presets.find((p) => p.isDefault);
    if (d) applyPreset(d);
  }, [presets.data, applyPreset]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return setError(t("upload.needFile"));
    if (!title.trim()) return setError(t("upload.needTitle"));
    setError(null);
    setFailure(null);
    setAutoRetry(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setUpload({ sent: 0, total: file.size, startedAt: performance.now(), finishing: false });
    try {
      // Resume the meeting created by an earlier attempt for the same file.
      if (!target.current || target.current.file !== file) {
        const { meeting, chunkSize } = await api.createMeeting({
          title: title.trim(),
          occurredAt: fromLocalInput(occurredAt),
          file: { name: file.name, size: file.size, type: file.type },
          options,
          summary: autoSummary && summary.prompt.trim() ? normalizeRequest(summary, templates?.templates ?? []) : null,
          // So a prepaid account's minutes are checked before anything is sent.
          durationSec: mediaDuration != null && mediaDuration > 0 ? mediaDuration : null,
        });
        target.current = { meetingId: meeting.id, chunkSize, file };
      } else {
        await api.updateMeeting(target.current.meetingId, { title: title.trim(), occurredAt: fromLocalInput(occurredAt) });
      }
      const { meetingId, chunkSize } = target.current;
      await uploadFile(
        meetingId,
        file,
        chunkSize,
        (sent, total) => {
          setAutoRetry(null);
          setUpload((u) => (u ? { ...u, sent, total } : u));
        },
        ctrl.signal,
        (attempt, max) => setAutoRetry({ attempt, max }),
      );
      await sendSlides(meetingId, ctrl.signal);
      setUpload((u) => (u ? { ...u, slides: null, finishing: true } : u));
      await api.completeUpload(meetingId);
      // The server has the recording now; drop the browser's copy.
      if (recording) await deleteRecording(recording.id).catch(() => undefined);
      allowLeave.current = true; // our own redirect to the new meeting is not "leaving"
      navigate(`/m/${meetingId}`, { replace: true });
    } catch (err) {
      setUpload(null);
      setAutoRetry(null);
      if (err instanceof ApiError && err.code === "aborted") return;
      const id = target.current?.meetingId;
      if (id && err instanceof ApiError && (err.code === "not_uploading" || err.status === 404)) {
        // The earlier attempt may have finished on the server (only its reply was lost),
        // or the meeting was deleted elsewhere. Go to it, or start a fresh one on retry.
        const done = await api.meeting(id).catch(() => null);
        if (done && done.meeting.status !== "uploading") {
          if (recording) await deleteRecording(recording.id).catch(() => undefined);
          allowLeave.current = true;
          navigate(`/m/${id}`, { replace: true });
          return;
        }
        target.current = null;
      }
      // Keep the file (and any browser recording) whatever happened.
      setFailure(classifyUploadError(err, file.size, limit, t));
    }
  };

  /**
   * The slides go up before the recording is marked complete (the summary is
   * written after transcription, with them). A slide that cannot be sent after
   * a few tries is skipped: the recording matters more.
   */
  const sendSlides = async (meetingId: string, signal: AbortSignal) => {
    let picked: CapturedSlide[] = [];
    if (recording) picked = slideRefs.current.recordedSlides;
    else if (captureSlides && scanDone.current) {
      setUpload((u) => (u ? { ...u, slides: { waiting: true, sent: 0, total: 0 } } : u));
      picked = await scanDone.current;
    }
    // Read after waiting: what the person left out meanwhile stays out.
    const list = picked.filter((s) => !slideRefs.current.removedSlides.has(s.slot));
    if (!list.length) return;
    if (sentSlides.current?.meetingId !== meetingId) sentSlides.current = { meetingId, keys: new Set() };
    const sent = sentSlides.current.keys;
    let failed = 0;
    for (const [i, s] of list.entries()) {
      setUpload((u) => (u ? { ...u, slides: { waiting: false, sent: i, total: list.length } } : u));
      if (sent.has(s.key)) continue;
      for (let attempt = 0; ; attempt++) {
        try {
          await api.uploadSlide(meetingId, s, signal);
          sent.add(s.key);
          break;
        } catch (e) {
          if (signal.aborted) throw new ApiError(0, "Canceled.", "aborted");
          // Refused for good (too many, not a picture), or the server is not taking them: move on.
          const refused = e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
          if (refused || attempt >= 2) {
            failed++;
            break;
          }
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }
    if (failed) toast.show(t("slides.uploadSomeFailed", { n: failed }));
  };

  const cancelUpload = async () => {
    abortRef.current?.abort();
    setUpload(null);
    if (target.current) await api.deleteMeeting(target.current.meetingId).catch(() => undefined);
    target.current = null;
  };

  const saveRecording = () => file && downloadBlob(file.name, file);
  const pickAnother = () => inputRef.current?.click();

  const stopRecording = async () => {
    const r = await rec.finish();
    if (r) onRecorded(r);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) accept(f);
  };

  const isVideo = file ? VIDEO.includes(extOf(file.name)) : false;

  // One-line description of the current transcription settings, shown while collapsed.
  const settingsSummary = [
    tMaybe(`lang.${language}`) ?? language,
    speakerMode === "auto"
      ? t("upload.speakersAutoShort")
      : speakerMode === "exact"
        ? t("upload.speakersExactShort", { n: exact })
        : speakerMode === "range"
          ? t("upload.speakersRangeShort", { a: range[0], b: range[1] })
          : t("upload.speakersOff"),
    t(script === "zh-TW" ? "upload.scriptTW" : script === "zh-CN" ? "upload.scriptCN" : "upload.scriptNone"),
    vocabulary.trim() ? t("upload.vocabularyCount", { n: vocabulary.split(/[,，、\n]+/).filter((w) => w.trim()).length }) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="upload">
      <div className="page-head">
        <div>
          <h1>{t("upload.title")}</h1>
          <p className="lede">{t("upload.lede")}</p>
        </div>
      </div>
      <hr className="rule-double" />

      <form className="upload-form" onSubmit={submit} id="upload-form">
        <PresetBar current={presetValue} appliedId={presetId} onApply={applyPreset} onSaved={(p) => setPresetId(p.id)} />
        <Step n="1" title={t("upload.step1")}>
          {!file && (
            <div className="mode-tabs" role="tablist" aria-label={t("upload.step1")}>
              <button type="button" role="tab" aria-selected={mode === "file"} onClick={() => setMode("file")} disabled={recordingBusy}>
                <UploadIcon /> {t("upload.modeFile")}
              </button>
              <button type="button" role="tab" aria-selected={mode === "record"} onClick={() => setMode("record")}>
                <Mic /> {t("upload.modeRecord")}
              </button>
            </div>
          )}
          {!file && mode === "record" ? (
            <Recorder rec={rec} onRecorded={onRecorded} />
          ) : !file ? (
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
              <span className="dropzone-formats">
                {limit != null ? t("upload.formats", { size: bytes(limit) }) : t("upload.formatsNoLimit")}
              </span>
            </label>
          ) : (
            <div className="file-card">
              <span className="file-card-icon">{recording ? <Mic /> : isVideo ? <FileVideo /> : <FileAudio />}</span>
              <div className="file-card-main">
                <div className="file-card-name">{recording ? t("upload.recordedFile") : file.name}</div>
                <div className="file-card-meta">
                  {bytes(file.size)}
                  {mediaDuration != null && <> · {clock(mediaDuration)}</>}
                  {" · "}
                  {recording ? t("upload.recordedFormat") : extOf(file.name).toUpperCase()}
                </div>
                <CreditsLine durationSec={mediaDuration} />
              </div>
              {recording ? (
                <>
                  <button type="button" className="btn btn-sm" onClick={saveRecording} title={t("upload.downloadRecordingHint")}>
                    <Download /> {t("upload.downloadRecording")}
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setFile(null)}>
                    {t("upload.recordAgain")}
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-sm" onClick={() => inputRef.current?.click()}>
                  {t("upload.replace")}
                </button>
              )}
              <button
                type="button"
                className="icon-btn"
                onClick={() => {
                  setFile(null);
                  setRecording(null);
                  setFailure(null);
                  target.current = null;
                }}
                aria-label={t("upload.removeFile")}
                title={t("upload.removeFile")}
              >
                <X />
              </button>
              <input ref={inputRef} type="file" accept={ACCEPT} className="visually-hidden" onChange={(e) => e.target.files?.[0] && accept(e.target.files[0])} />
              {failure && failure.kind !== "retry" && (
                <FailureDetail failure={failure} isRecording={!!recording} helpContact={helpContact} />
              )}
              {previewUrl && (
                <div className="file-card-preview">
                  <span className="faint">{recording ? t("upload.previewRecording") : t("upload.preview")}</span>
                  <audio controls preload="metadata" src={previewUrl} />
                </div>
              )}
            </div>
          )}
          {/* The video picture is not kept: say so before it is uploaded. */}
          {file && isVideo && !recording && (mediaPolicy?.videoAudioOnly || mediaPolicy?.compact) && (
            <p className="field-hint upload-compact-note">
              {mediaPolicy.videoAudioOnly || mediaPolicy.afterDays === 0 ? t("upload.compactVideoNow") : t("upload.compactVideo", { n: mediaPolicy.afterDays })}
            </p>
          )}
          {file && isVideo && !recording && <SlideOption kind="video" checked={captureSlides} onChange={setCaptureSlides} />}
          {file && (scan || (recording && recordedSlides.length > 0)) && (
            <SlidesFound scan={recording ? null : scan} slides={slides} onRemove={upload ? undefined : removeSlide} />
          )}
        </Step>

        <Step n="2" title={t("upload.step2")}>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="title">{t("upload.meetingTitle")}</label>
              <input
                id="title"
                className="input"
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

        <Step n="3" title={t("upload.step4")}>
          {refineInfo?.available && (
            <div className="field upload-refine">
              <label className="switch">
                <input type="checkbox" checked={refine} onChange={(e) => setRefine(e.target.checked)} />
                <span className="switch-track" />
                <span className="switch-label">{t("refine.uploadSwitch")}</span>
              </label>
              <span className="field-hint">{t("refine.uploadHint", { vendor: refineInfo.vendor, host: refineInfo.host })}</span>
            </div>
          )}
          <label className="switch">
            <input type="checkbox" checked={autoSummary} onChange={(e) => setAutoSummary(e.target.checked)} />
            <span className="switch-track" />
            <span className="switch-label">{t("upload.autoSummary")}</span>
          </label>
          {autoSummary ? <SummaryComposer value={summary} onChange={setSummary} /> : <p className="muted">{t("upload.noAutoSummary")}</p>}
          {/* Also without a summary: a transcription API receives the speech either way. */}
          <DataFlowNote />
        </Step>

        <section className="advanced">
          <button type="button" className="advanced-toggle" aria-expanded={showAdvanced} onClick={() => setShowAdvanced((v) => !v)}>
            <span className="advanced-title">
              <ChevronRight />
              {t("upload.step3")}
            </span>
            <span className="advanced-summary">{showAdvanced ? t("upload.advancedHint") : settingsSummary}</span>
          </button>
          {showAdvanced && (
            <div className="advanced-body">
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
                <span className="field-hint">{t("upload.speakersHint")}</span>
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
                  {(["zh-TW", "zh-CN", "none"] as Script[]).map((sc) => (
                    <button type="button" key={sc} aria-pressed={script === sc} onClick={() => setScript(sc)}>
                      {t(sc === "zh-TW" ? "upload.scriptTW" : sc === "zh-CN" ? "upload.scriptCN" : "upload.scriptNone")}
                    </button>
                  ))}
                </div>
                <span className="field-hint">{t("upload.scriptHint")}</span>
              </div>
            </div>
          )}
        </section>
      </form>

      <SubmitBar
        stage={
          upload
            ? "uploading"
            : rec.phase === "starting"
              ? "rec-starting"
              : recordingBusy
                ? "recording"
                : file
                  ? "ready"
                  : mode === "record"
                    ? "rec-idle"
                    : "empty"
        }
        upload={upload}
        rec={rec}
        error={error}
        failure={failure}
        autoRetry={autoRetry}
        isRecording={!!recording}
        onSaveRecording={saveRecording}
        onPickAnother={pickAnother}
        onSignIn={() => {
          allowLeave.current = true;
          navigate("/login");
        }}
        summary={
          file ? (
            <>
              <strong>{title.trim() || file.name}</strong>
              <span className="faint">
                {bytes(file.size)}
                {mediaDuration != null && <> · {clock(mediaDuration)}</>}
                {slides.length > 0 && <> · {t("slides.countShort", { n: slides.length })}</>}
                {autoSummary && <> · {t("upload.willSummarize")}</>}
              </span>
            </>
          ) : null
        }
        onStop={stopRecording}
        onCancelUpload={cancelUpload}
      />
    </div>
  );
}
type BarStage = "empty" | "rec-idle" | "rec-starting" | "recording" | "ready" | "uploading";

/**
 * The fixed bottom bar follows the flow: what can be done next is always
 * here, whether the page is scrolled to the recorder or to the form.
 */
function SubmitBar({
  stage,
  upload,
  rec,
  error,
  failure,
  autoRetry,
  isRecording,
  summary,
  onStop,
  onCancelUpload,
  onSaveRecording,
  onPickAnother,
  onSignIn,
}: {
  stage: BarStage;
  upload: UploadProgress | null;
  rec: RecordingController;
  error: string | null;
  failure: UploadFailure | null;
  autoRetry: { attempt: number; max: number } | null;
  isRecording: boolean;
  summary: ReactNode;
  onStop: () => void;
  onCancelUpload: () => void;
  onSaveRecording: () => void;
  onPickAnother: () => void;
  onSignIn: () => void;
}) {
  const { t } = useI18n();

  let info: ReactNode;
  let actions: ReactNode;
  if (stage === "uploading" && upload) {
    const pct = upload.total ? Math.floor((upload.sent / upload.total) * 100) : 0;
    const elapsed = (performance.now() - upload.startedAt) / 1000;
    const rate = elapsed > 0.5 ? upload.sent / elapsed : 0;
    const eta = rate > 0 ? (upload.total - upload.sent) / rate : 0;
    info = (
      <div className="bar-upload" aria-live="polite">
        <div className="bar-upload-line">
          <strong>
            {upload.finishing
              ? t("upload.finishing")
              : upload.slides?.waiting
                ? t("slides.uploadWaiting")
                : upload.slides
                  ? t("slides.uploading", { n: upload.slides.sent + 1, total: upload.slides.total })
                  : t("upload.uploading", { pct })}
          </strong>
          {autoRetry ? (
            <span className="bar-warn">
              <RefreshCw className="spin" /> {t("upload.autoRetry", { n: autoRetry.attempt, max: autoRetry.max })}
            </span>
          ) : (
            !upload.finishing && (
              <span className="faint">
                {t("upload.uploadingDetail", { sent: bytes(upload.sent), total: bytes(upload.total), rate: bytes(rate), eta: rate ? clock(eta) : "–" })}
              </span>
            )
          )}
        </div>
        <div className="progress" style={{ height: 5 }}>
          <span style={{ width: `${upload.finishing ? 100 : pct}%` }} />
        </div>
      </div>
    );
    actions = !upload.finishing && (
      <button type="button" className="btn" onClick={onCancelUpload}>
        {t("upload.cancelUpload")}
      </button>
    );
  } else if (stage === "recording" || stage === "rec-starting") {
    const paused = rec.phase === "paused";
    const finishing = rec.phase === "finishing";
    // The source panel may be scrolled out of view: the bar carries its state too.
    const scope = stage === "recording" ? sourceScope(rec.health, t) : null;
    const alert = stage === "recording" && !finishing ? sourceAlert(rec.health, t) : null;
    const startingLabel =
      rec.awaiting === "meeting" ? t("recorder.awaitShareShort") : rec.awaiting === "mic" ? t("recorder.awaitMicShort") : t("recorder.starting");
    info = (
      <div className="bar-rec">
        <span className={`rec-status ${paused ? "paused" : ""}`}>
          <span className="rec-dot" />
          {stage === "rec-starting" ? startingLabel : finishing ? t("recorder.finishing") : paused ? t("recorder.paused") : t("recorder.recording")}
          {scope && <span className="rec-scope">{scope}</span>}
        </span>
        {stage === "recording" && <span className="bar-rec-time mono">{clock(rec.elapsedMs / 1000, true)}</span>}
        {alert && (
          <span className={`bar-rec-alert ${alert.kind}`} role={alert.kind === "warn" ? "alert" : "status"}>
            <AlertTriangle /> {alert.text}
            {alert.kind === "warn" && (
              <button type="button" className="btn btn-sm" onClick={() => revealSource(alert.target)}>
                {t("recorder.handle")}
              </button>
            )}
          </span>
        )}
      </div>
    );
    actions = stage === "recording" && (
      <>
        {paused ? (
          <button type="button" className="btn btn-lg" onClick={rec.resume} disabled={finishing}>
            <Play /> {t("recorder.resume")}
          </button>
        ) : (
          <button type="button" className="btn btn-lg" onClick={rec.pause} disabled={finishing}>
            <Pause /> {t("recorder.pause")}
          </button>
        )}
        <button type="button" className="btn btn-primary btn-lg" onClick={onStop} disabled={finishing}>
          {finishing ? <span className="spinner" /> : <Square />} {t("recorder.stop")}
        </button>
      </>
    );
  } else if (stage === "ready" && failure) {
    const submitLabel =
      failure.kind === "retry" ? (
        <>
          <RefreshCw /> {t("upload.retry")}
        </>
      ) : null;
    info = (
      <span className="field-error" role="alert">
        <AlertCircle /> {failureHeadline(failure, t)}
      </span>
    );
    // Only a retryable failure offers "retry"; the others offer what can actually fix them.
    actions =
      failure.kind === "retry" ? (
        <button className="btn btn-primary btn-lg" form="upload-form">
          {submitLabel}
        </button>
      ) : failure.kind === "credits" ? (
        <>
          {/* A new tab: this page keeps the file, to send it once minutes are bought. */}
          <a className="btn btn-lg" href="/billing" target="_blank" rel="noopener">
            <Coins /> {t("upload.buyMinutes")}
          </a>
          <button className="btn btn-primary btn-lg" form="upload-form">
            <RefreshCw /> {t("upload.retry")}
          </button>
        </>
      ) : failure.kind === "session" ? (
        <button type="button" className="btn btn-primary btn-lg" onClick={onSignIn}>
          <LogIn /> {t("upload.signInAgain")}
        </button>
      ) : isRecording ? (
        <button type="button" className="btn btn-primary btn-lg" onClick={onSaveRecording}>
          <Download /> {t("upload.downloadRecording")}
        </button>
      ) : failure.kind === "server-limit" ? null : (
        <button type="button" className="btn btn-primary btn-lg" onClick={onPickAnother}>
          <FolderOpen /> {t("upload.pickAnother")}
        </button>
      );
  } else {
    info = error ? (
      <span className="field-error" role="alert">
        <AlertCircle /> {error}
      </span>
    ) : stage === "ready" ? (
      summary
    ) : (
      <span className="faint">{stage === "rec-idle" ? t("recorder.submitIdle") : t("upload.needFile")}</span>
    );
    actions = (
      <button className="btn btn-primary btn-lg" form="upload-form" disabled={stage !== "ready"}>
        <UploadIcon /> {t("upload.submit")}
      </button>
    );
  }

  return (
    <div className={`submit-bar stage-${stage}`}>
      <div className="submit-bar-inner">
        <div className="submit-bar-info">{info}</div>
        {/* Keyed by stage: a new stage gets new buttons instead of one button morphing into another. */}
        <div className="submit-bar-actions" key={`${stage}-${failure?.kind ?? ""}`}>
          {actions}
        </div>
      </div>
    </div>
  );
}

/** The slides found in the video (or the recording), while looking and after, with a way to leave some out. */
function SlidesFound({ scan, slides, onRemove }: { scan: SlideScan | null; slides: CapturedSlide[]; onRemove?: (slot: string) => void }) {
  const { t } = useI18n();
  const scanning = scan?.status === "scanning";
  const pct = Math.floor((scan?.done ?? 1) * 100);
  let head: string;
  if (scanning) head = t("slides.scanning", { pct, n: slides.length });
  else if (scan?.status === "failed") head = t("slides.scanFailed");
  else if (slides.length) head = t("slides.found", { n: slides.length });
  else head = t("slides.none");
  return (
    <div className={`slides-found ${scan?.status === "failed" ? "is-failed" : ""}`} aria-live="polite">
      <p className="slides-found-head">
        {scanning && <span className="spinner" />}
        <span>{head}</span>
        {slides.length > 0 && onRemove && !scanning && <span className="faint">{t("slides.removeHint")}</span>}
      </p>
      {scanning && (
        <div className="progress" style={{ height: 4 }}>
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
      <SlideStrip slides={slides} onRemove={onRemove} />
    </div>
  );
}

/** Prepaid accounts: what this recording will cost against what is left. */
function CreditsLine({ durationSec }: { durationSec: number | null }) {
  const { t, locale } = useI18n();
  const { user } = useAuth();
  const billing = useBilling(user?.billing === "prepaid");
  if (user?.billing !== "prepaid" || !billing.data) return null;
  const perMinute = billing.data.rates.perMinute;
  // Free transcription: nothing to weigh.
  if (perMinute <= 0) return null;
  const available = billing.data.available ?? 0;
  const need = durationSec != null ? transcriptionCost(durationSec, perMinute) : null;
  const short = need != null && need > available;
  return (
    <div className={`file-card-credits ${short ? "is-short" : ""}`}>
      <Coins />
      {need != null
        ? t("upload.creditsLine", { need: pointsText(need, locale), have: pointsText(available, locale) })
        : t("upload.creditsLineUnknown", { have: pointsText(available, locale) })}
    </div>
  );
}

/** One line for the bottom bar: what went wrong, with the numbers that matter. */
function failureHeadline(f: UploadFailure, t: TFn): string {
  switch (f.kind) {
    case "retry":
      return t(f.reason === "network" ? "upload.failNetwork" : f.reason === "server" ? "upload.failServer" : "upload.failTransfer");
    case "too-large":
      return f.limit != null ? t("upload.fileTooLarge", { size: bytes(f.size), limit: bytes(f.limit) }) : t("apiError.tooLarge");
    case "server-limit":
      return t("upload.failServerLimit");
    case "rejected":
      return f.message;
    case "session":
      return t("upload.failSession");
    case "credits":
      return t("upload.failCredits");
  }
}

/** Under the file: why it cannot be uploaded as-is, and what the options are. */
function FailureDetail({ failure, isRecording, helpContact }: { failure: UploadFailure; isRecording: boolean; helpContact: string | null }) {
  const { t, locale } = useI18n();
  let body: string;
  switch (failure.kind) {
    case "too-large":
      body = isRecording
        ? t("upload.tooLargeRecordingHelp", { limit: failure.limit != null ? bytes(failure.limit) : "–" })
        : t("upload.tooLargeFileHelp", { limit: failure.limit != null ? bytes(failure.limit) : "–" });
      break;
    case "server-limit":
      body = t("upload.serverLimitHelp");
      break;
    case "session":
      body = isRecording ? t("upload.sessionRecordingHelp") : t("upload.sessionFileHelp");
      break;
    case "credits":
      body = t("upload.creditsHelp", {
        need: pointsText(failure.needed, locale),
        have: pointsText(failure.available, locale),
      });
      break;
    default:
      body = isRecording ? t("upload.rejectedRecordingHelp") : t("upload.rejectedFileHelp");
  }
  return (
    <div className="file-card-problem callout warn" role="note">
      <AlertTriangle />
      <div>
        <p>{body}</p>
        {isRecording && failure.kind !== "session" && <p className="faint">{t("upload.recordingKept")}</p>}
        {helpContact && (failure.kind === "too-large" || failure.kind === "server-limit") && (
          <p className="faint">{t("upload.adminContact", { contact: helpContact })}</p>
        )}
      </div>
    </div>
  );
}
