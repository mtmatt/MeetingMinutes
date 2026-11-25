# Minutes

A self-hosted meeting-minutes service. Upload a recording (audio or video). It is transcribed **locally on your own GPUs** (or, if an administrator chooses, through a **transcription API** such as OpenRouter), with speaker separation and Taiwan Traditional Chinese output, and then summarised with a prompt you choose: by default by a **local model on your GPU** (Qwen3.8 27B through Ollama), so nothing leaves the server, or by **Codex**, billed to your ChatGPT plan. Administrators choose which on the admin page.

Planned changes, including where transcription will run, are in [docs/ROADMAP.md](docs/ROADMAP.md).

- **Backend**: TypeScript on Bun, with Hono and SQLite (`bun:sqlite`).
- **Frontend**: React and Vite with a custom design system, in English and 繁體中文, with light and dark themes.
- **GPU worker**: Python, running Qwen3-ASR-1.7B for recognition and pyannote community-1 for speaker diarization. Recognition can instead go to a transcription API (OpenRouter, or any OpenAI-compatible server).
- **Summary model**: Ollama with Qwen3.8 27B (3-bit) by default, any OpenAI-compatible server (vLLM, llama.cpp, LM Studio), or Codex.
- **No root required** anywhere: install, run, and update all happen as a normal user.

```
 browser ──HTTPS──▶ Caddy/nginx ──▶ backend (Bun, :8787) ──── SQLite + media files (data/)
                                     │         ▲        │
               summaries (one of):   │         │ pull   │
                                     ▼         │ jobs   ▼
     Ollama on 127.0.0.1:11434 (Qwen3.8 27B)   GPU worker supervisor (no CUDA while idle)
     or codex exec → ChatGPT (read-only, tools off)     │ spawns on demand
                                                        ▼
                                                  GPU session: Qwen3-ASR + pyannote → exits, VRAM freed
                                                  (or pyannote only, with speech segments sent to
                                                   OpenRouter / an OpenAI-compatible API for recognition)
```

## Features

- **Upload** audio or video up to 4 GB. Uploads are chunked and resumable, so they survive flaky connections and proxy body limits.
- **Record in the browser**:
  - **Online meeting** (Google Meet, Teams and other meetings in a browser tab): captures the meeting tab's audio and your microphone, mixed into one track. The tab alone would miss your own voice, because a meeting tab never plays it back.
  - **Microphone**: for in-room meetings.
  - The recording is saved to the browser's IndexedDB every 5 seconds, so a closed tab or crash loses at most a few seconds; interrupted recordings can be restored and uploaded later.
- **Transcription options**: language (auto-detect handles Mandarin–English code-switching), speaker count (auto, exact, or range), a vocabulary list fed to the recogniser as context, and Chinese script (Taiwan Traditional via OpenCC `s2twp`, Simplified, or as recognised).
- **Summaries**: pick a template, edit the prompt for this upload, and choose the output language. Summaries can run automatically when the transcript is ready, and you can re-run them any time with a different prompt; every run is kept as a version. Summaries in Chinese come out in Taiwan Traditional Chinese, even when the model slips into Simplified (see [Choosing the summary model](#choosing-the-summary-model)).
- **Meeting view**:
  - a waveform with one lane per speaker;
  - a transcript that highlights and follows playback;
  - click any line or any `[hh:mm:ss]` in a summary to jump there;
  - rename speakers, reassign paragraphs, edit text;
  - **listen to a speaker** before naming them: their turns play one short clip at a time, starting with the first one long enough to recognise the voice, with what is said in it;
  - speakers you have named before are **recognised by voice** in new recordings (and, on request, in older ones);
  - talk-time per speaker;
  - search inside the transcript;
  - optional video pane.
- **Exports**: TXT, Markdown, SRT, WebVTT, JSON, the original media, and summaries as `.md` or straight into **Google Docs** (see [Exporting to Google Docs](#exporting-to-google-docs)).
- **Templates**: six built-ins (minutes, action items, executive brief, detailed notes, decision log, lecture notes) plus your own.
- **Accounts**:
  - first-run admin setup protected by a one-time token;
  - invitation links, each for a set number of people (1 to 100, until it expires), with a record of who joined through each; an invitation for an administrator is always single-use;
  - password reset links;
  - roles, disabling users, and a per-user session list with remote sign-out.
- **Admin system page**: GPU workers (model state, VRAM), queue, Codex login status, and disk usage.
- **Admin transcription page**: transcribe on the worker's GPU, or through a transcription API (OpenRouter first; any OpenAI-compatible server too), with the model, and which workers have an API key.
- **Admin summary model page**: choose the local model or Codex, the model server and model, its context window and thinking; see whether the server is up and the model downloaded, and download it from there.
- **Live updates** over Server-Sent Events: progress, stages, and summaries appear without reloading.

## Choosing the ASR model (RTX 4090)

The target is Mandarin–English code-switched meetings, with Traditional Chinese output, on one or two RTX 4090s (24 GB each).

| Option                               | Chinese                      | English                 | Code-switching                | Notes                                                                                                                         |
| ------------------------------------ | ---------------------------- | ----------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Qwen3-ASR-1.7B** (chosen)          | AISHELL-2 WER **2.71**       | LibriSpeech 1.63 / 3.38 | strong; language ID per chunk | Apache-2.0 (2026). Accepts a text _context_ for names and jargon. Transformers and vLLM backends. About 5 GB of VRAM in bf16. |
| Whisper large-v3 / turbo             | AISHELL-2 WER 5.06           | 1.51 / 3.97             | good                          | Tends to output Simplified. Known hallucination loops on silence.                                                             |
| Breeze-ASR-25 (Whisper-v2 fine-tune) | tuned for Taiwanese Mandarin | good                    | good                          | Worth trying as an alternative; still has Whisper's failure modes.                                                            |
| SenseVoice / Paraformer              | very fast, strong Mandarin   | weaker English          | weak                          | Better suited to Mandarin-only audio.                                                                                         |
| Parakeet / Canary                    | –                            | best-in-class           | –                             | English only.                                                                                                                 |

Qwen3-ASR-1.7B roughly halves Whisper-large-v3's Chinese error rate, keeps English at parity, and takes a vocabulary prompt, which matters for product names in meetings. The 0.6B variant exists if throughput matters more than accuracy.

Speaker diarization uses **pyannote `speaker-diarization-community-1`**. It improves on 3.1 for speaker counting (for example AliMeeting DER 20.3 vs 24.5). The worker takes each speaker turn, merges short same-speaker turns, splits long ones at quiet points (≤ 30 s), and transcribes those segments in batches. Segment boundaries become the transcript timestamps.

On a 4090, both models together use roughly 6–8 GB. Each GPU runs one GPU session at a time, so two GPUs process two meetings in parallel. `ASR_BACKEND=vllm` (install with `--vllm`) gives higher throughput on long recordings.

Sources: [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR), [Qwen3-ASR technical report](https://arxiv.org/abs/2601.21337), [pyannote community-1 benchmarks](https://github.com/pyannote/pyannote-audio).

### Recognising speakers by voice

Naming speakers is the slowest part of tidying a transcript, so it only has to be done once per person:

1. **Name a speaker** in any transcript (click the name above the transcript). While you type, a panel below the name plays their turns, one clip of up to 15 seconds at a time: it opens on their first turn long enough to recognise the voice (the very first one is often just "OK"), and the arrows step through the others in order, with the words of each clip shown. Playing a clip keeps the cursor in the name field and the page where it is; the time stamp shows the clip in the transcript. The headphones beside a name (and the **by voice** / suggestion menu) open the same panel without renaming. Their voice is remembered under that name: the toast says so and offers _Undo_.
2. **In later recordings**, each speaker who still has a default name ("Speaker 2") is compared with the voices you have named:
   - a close match is named for you and marked **by voice** (依聲紋), with a menu to confirm it or to say it is someone else, which puts the previous name back;
   - a weaker resemblance is only **suggested** ("王小明?"), and the name changes only if you accept;
   - each person is given to at most one speaker per meeting, never under a name already used in that meeting, and two similar voices that are nearly tied are only suggested.
     Recognition runs before the automatic summary, so the summary is written with the recognised names; finished summaries are updated the same way as for a manual rename.
3. **Past recordings**: **Voices → Find voices in past recordings** remembers everyone you have already named in earlier transcripts and recognises the people still called "Speaker N" there. Recordings transcribed before this feature first get voice fingerprints from a background job (the meeting stays readable; nothing is transcribed again).

Only names you give or confirm become part of a voice: a guess you have not confirmed never changes what a person sounds like, so one wrong match cannot snowball. The **Voices** page lists each person with the recordings their voice was learned from. There you can remove a recording that was someone else, rename or merge people (for one person named two ways), forget a person, or turn recognition off. A person whose recordings sound like different people (for example a name like "Guest" used for several people) is flagged, because recognition with that name is unreliable.

How it works: the voice fingerprint is a speaker embedding from the model that the pyannote diarization pipeline already uses to tell speakers apart, so there is no extra model to download. For each speaker the worker embeds up to 48 windows of their speech (1–10 s each, longest first) and keeps the length-weighted mean direction. A new speaker's score against a person is the cosine similarity to the closest of that person's 20 most recent recordings, or to their average voice. The thresholds are `VOICE_MATCH_THRESHOLD` (default 0.6) and `VOICE_SUGGEST_THRESHOLD` (0.45). Speakers with less than `VOICE_MIN_SPEECH_SEC` (5 s) of speech are neither remembered nor compared. Fingerprints from a different embedding model are never compared, so changing `DIARIZATION_MODEL` starts the voices afresh.

Privacy: voices are per account and never compared across accounts. A voice fingerprint is a few hundred numbers derived from the recording, and it cannot be played back. It is kept with the person's profile even if the recording it came from is deleted, until you remove it or forget the person.

### GPU policy: models are loaded only when there is work

The worker supervisor that runs all the time never imports PyTorch or creates a CUDA context, so **an idle worker uses no GPU memory**. When the backend has a job, the supervisor starts a separate GPU process. That process:

1. loads the models (shown as _Loading models_ in the UI);
2. processes the job, and any other jobs already waiting, back to back;
3. exits.

Process exit is what guarantees all VRAM is returned, including the CUDA context that `torch.cuda.empty_cache()` cannot release. The cost is model-loading latency at the start of each busy period (typically tens of seconds from a warm disk cache). `MODEL_KEEPALIVE_SEC` (default `0`) can keep a session warm for a few seconds if you ever want to trade that off. GPU status on the admin page comes from `nvidia-smi`, which does not allocate VRAM.

One supervisor serves all the GPUs in `WORKER_GPUS`, and the admin page still lists each GPU as a worker. Before it claims a job, it asks `nvidia-smi` how much memory each idle GPU has free, including memory used by other programs, and starts the session on the GPU with the most. A GPU with less than `MIN_FREE_VRAM_GB` (default `8`, enough for both models) free is skipped; if every idle GPU is short of memory, jobs stay queued until one has room. When transcription goes through an API, only pyannote is loaded, and `MIN_FREE_VRAM_API_GB` (default `3`) applies instead.

## Transcribing through an API (OpenRouter)

Speech recognition can run on a hosted model instead of the worker's GPU. **Admin → Transcription** chooses, for everyone:

- **This server's GPU** (the default): Qwen3-ASR on the worker, as described above. Recordings never leave the server.
- **Transcription API**: the worker still decodes the recording, separates the speakers with pyannote and plans the segments exactly as before, then sends each segment (at most `MAX_SEGMENT_SEC`, 30 s, as a 16 kHz mono WAV) to the API, four at a time (`ASR_API_CONCURRENCY`). The recording is never sent as a whole, and speaker separation and voice recognition stay on the worker. Text comes back through the same Taiwan Traditional conversion, so Whisper's Simplified output is converted too.

Two kinds of service work, both through the OpenAI-style `POST …/audio/transcriptions` endpoint:

| Service                  | Address                                       | Models (examples)                                                                 | Key on the worker                       |
| ------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------- |
| **OpenRouter** (default) | `https://openrouter.ai/api/v1` (fixed)        | `qwen/qwen3-asr-1.7b` (the same model as on the GPU), `qwen/qwen3-asr-0.6b`, `openai/whisper-large-v3` | `OPENROUTER_API_KEY` (or `ASR_API_KEY`) |
| **OpenAI-compatible**    | any, ending in `/v1`; empty means OpenAI      | OpenAI `whisper-1`, `gpt-4o-transcribe`; Groq `whisper-large-v3`; a vLLM serving `Qwen/Qwen3-ASR-1.7B` on your own machine | `ASR_API_KEY` (or `OPENAI_API_KEY`)     |

To set it up:

1. Create a key at [openrouter.ai](https://openrouter.ai) and add it to the `.env` of every machine that runs a worker:
   ```
   OPENROUTER_API_KEY=sk-or-v1-...
   ```
2. Restart the worker (`scripts/restart.sh worker`).
3. In **Admin → Transcription**, choose **Transcription API**, OpenRouter, and a model, then save. The page shows, for each connected worker, whether it has a key; recordings already waiting are transcribed the new way.

Things to know:

- **Where the audio goes**: OpenRouter passes each segment to a company that runs the chosen model (for `qwen/qwen3-asr-1.7b`, providers such as DeepInfra), under OpenRouter's and that company's terms. The upload page tells people this before they upload; with the GPU option it says the recording stays on the server.
- **Price**: OpenRouter bills per second of audio. Its model pages listed `qwen/qwen3-asr-1.7b` at US$0.000008 per second (about US$0.03 per hour of recording) and `qwen/qwen3-asr-0.6b` at US$0.000003 per second, as found on 2026-11-22; check the model page before relying on it. Only speech is sent, so silence costs nothing.
- **Vocabulary**: the upload page's vocabulary list is sent as the request's `prompt`. Whisper uses it; whether another model's provider forwards it varies, so names and jargon may help less than with the local model.
- **Language**: the upload page's language becomes an ISO code (`zh`, `en`, `yue`, `ja`, `ko`); "auto" lets the service detect it. The detected language is shown when the service reports it (`verbose_json`); a service that refuses `verbose_json` is asked for plain `json`.
- **Failures**: a rejected key (401), no credit (402) or an unknown model (404) fails the recording at once with the reason, without retrying; rate limits (429, honouring `Retry-After`), server errors and network errors are retried up to five times per segment, and then the whole job is retried later like any other failure. A worker without a key for the chosen service fails the recording with which variable to set.
- **No GPU at all**: separate speakers on the CPU, or with pyannoteAI (next sections); the worker then needs no GPU, CUDA or torch.
- The key is read by the worker from its own environment and never passes through the web server, the database or a browser; workers report only whether they have one.

### Speaker separation on the CPU, and a worker without a GPU

**Admin → Transcription → Who separates speakers** offers three choices: pyannote on the worker's **GPU** (the default), the worker's **CPU**, or **pyannoteAI** (below). The CPU option is free and uploads nothing, and with the transcription API a worker needs no GPU, CUDA or torch:

```
scripts/install.sh --no-gpu        # Python packages without torch, Qwen3-ASR or pyannote
scripts/worker.sh check            # downloads the two CPU models (about 45 MB) into data/models/
```

- It runs [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) (onnxruntime): pyannote's segmentation-3.0 model (ONNX, MIT licence) finds who speaks when in short windows, and a Mandarin-trained 3D-Speaker ERes2Net model embeds each piece. The pieces are then clustered into speakers. The same ERes2Net model makes the voice fingerprints. Both files come from sherpa-onnx's GitHub releases and are checked against pinned SHA-256 sums.
- Speed: on a 4-core test machine (Xeon 2.1 GHz), about 8 minutes per hour of audio with 4 threads and 16 pinned to a single core. Measure your machine with `scripts/worker.sh bench` (one thread; `--threads 1,2,4` compares counts, and `taskset -c 0 scripts/worker.sh bench` pins it to one core). Pass a file to time your own recording and see how many speakers it finds. `DIARIZATION_CPU_THREADS` sets the threads; the default is the number of cores, at most 8.
- Accuracy: lower than pyannote community-1 on a GPU or pyannoteAI precision-2. On sherpa-onnx's 4-speaker Mandarin sample it found the 4 speakers. With an automatic count it can split one person into two (on that sample repeated five times it found 6), so the speaker count or a range on the upload page helps most here. With a range, a count outside it is redone at the nearest allowed count. `DIARIZATION_CPU_THRESHOLD` (default 0.5; larger means fewer speakers) tunes automatic counting.

### Speaker separation by pyannoteAI

Speaker separation can also go to [pyannoteAI](https://www.pyannote.ai), the hosted service of the team behind pyannote (model `precision-2`). It is more accurate than the CPU option, but it is a paid subscription and the whole recording is uploaded. A worker set up for it needs, in its `.env`:

```
OPENROUTER_API_KEY=sk-or-v1-...
PYANNOTEAI_API_KEY=...             # from dashboard.pyannote.ai
```

How it works:

- The worker uploads the whole recording, as 48 kbit/s mono Opus, to pyannoteAI's temporary storage (its documentation says files are deleted within 48 hours, and results kept for 24), starts a diarization job with the speaker count from the upload page, and polls it. The answer is who spoke when; the worker then cuts the speech segments and transcribes them as before.
- Voice fingerprints, for recognising people across meetings, are computed on the worker's CPU with the same ERes2Net model as the CPU option, so switching between the two keeps everyone's voices. Nothing extra is uploaded for them. On a 4-speaker Mandarin sample, fingerprints of the same person scored 0.42 to 0.76 cosine similarity on 2 to 4 second clips and of different people at most 0.26, so the usual thresholds apply.
- Fingerprints from different models are never compared. After switching, **Voices → Find voices in past recordings** redoes the fingerprints of earlier meetings with the new model and relearns the people you named.
- Each worker reports what it can run. A worker installed with `--no-gpu` is handed transcriptions only while recognition is set to the API and speaker separation to the CPU or pyannoteAI. The admin page warns if no connected worker can run the chosen combination.
- The upload page tells people that the whole recording goes to pyannoteAI.
- Errors: a rejected key (401) or no credit (402) fails the recording with the reason; rate limits, server errors and network errors are retried, then the whole job is retried later rather than keeping a transcript without speakers.
- Price: third-party comparisons list precision-2 at about €0.10 per hour of audio; check pyannoteAI's pricing page.
- `scripts/worker.sh check` on such a worker prints what it can run, whether its keys are set, and downloads the voice model.

## Choosing the summary model

Summaries are written by a **local model** unless an administrator chooses Codex. **Admin → Summary model** sets, for everyone:

- **who writes summaries**: the local model, or Codex (ChatGPT plan);
- for the local model: the server (Ollama, or an OpenAI-compatible server such as vLLM, llama.cpp, LM Studio or SGLang), its address, the model, the context window, thinking on or off, and how long the model stays in GPU memory afterwards;
- for Codex: the model and reasoning effort (empty: Codex's defaults).

The page checks the server as you type: whether it answers, whether the model is downloaded (with a **Download** button for Ollama and a progress bar), the model's longest context, and whether it is in GPU memory now. Saved settings apply to every summary started afterwards, including those already queued; `.env` gives the defaults (`SUMMARY_PROVIDER`, `LLM_*`), and **Use .env defaults** goes back to them.

### The default: Qwen3.8 27B, 3-bit

The default model is `batiai/qwen3.8-27b:q3`: Qwen3.8 27B quantised to 3 bits (Q3_K_M), about 13 GB on disk. It is a hybrid model: only 16 of its 64 layers use full attention and keep a KV cache that grows with the context (4 KV heads of 256 dimensions each); the other 48 are Gated DeltaNet layers with a fixed-size state. So the default 64K-token context window costs only about 2 GB with the 8-bit KV cache `scripts/llm.sh serve` turns on (4 GB at 16 bits, 4.3 GB for 128K), and the model with its context fits one 24 GB RTX 4090 with room to spare. It is not in Ollama's own library, which offers Qwen3.8 27B only at 4 bits (`qwen3.8:27b`, about 18 GB); that one is a good choice when memory allows. Any other model can be entered by name, for example a smaller `qwen3:14b`.

Memory: the model is loaded only while a summary is being written and released right after (`LLM_KEEP_ALIVE_SEC=0`), the same policy as the transcription models. A transcription session needs `MIN_FREE_VRAM_GB` (8 GB) free, so while a summary runs on a GPU, transcription uses the other GPU or waits for the summary to finish. With two GPUs you can also keep them apart: `LLM_GPUS=1` for Ollama and `WORKER_GPUS=0` for transcription.

### Long meetings

A local model's context window is much smaller than Codex's, and servers cut an over-long prompt silently. So the prompt is measured first (erring on the high side: one token per Chinese character and per digit). A transcript that fits is summarised in one call. A longer one is read in consecutive parts: the model writes detailed notes on each part (topics, who said what, decisions, numbers, dates, commitments, each with its `[hh:mm:ss]`), and then writes the document from the notes, following your template. No line of the transcript is dropped; the summary records how many calls it took. A larger context window means fewer parts and more GPU memory.

### Traditional Chinese

The prompt asks for Taiwan Traditional Chinese in English and in Chinese, but models, Qwen among them, still slip into Simplified, sometimes for whole paragraphs. So the finished summary is checked: every clause that contains a character used only in Simplified Chinese (们, 软, 发…) is converted with OpenCC's Taiwan phrasing (`s2twp`, as for transcripts: 软件 → 軟體), and everything else is left exactly as written. Converting the whole text instead would damage what is already right (OpenCC turns 干擾 into 幹擾 and 發佈 into 釋出). Speaker names, code and links are never changed, so renaming a speaker still finds them. This applies to summaries in 繁體中文, and to "auto" summaries of transcripts kept in Taiwan Traditional.

### Thinking

Qwen3 and Qwen3.8 can think before they answer. It is off by default: summaries take several times longer, and the gain on meeting notes is small. Turn it on for difficult material. Models that cannot think ignore the setting.

### Running the model server

`scripts/install.sh` installs Ollama into `~/.local/ollama` (no root; `--no-llm` skips it). Then:

```bash
scripts/llm.sh serve            # Ollama on 127.0.0.1:11434 (keep it running, or use deploy/systemd/meetingminutes-llm.service)
scripts/llm.sh pull             # download LLM_MODEL once (or use Download in Admin → Summary model)
scripts/llm.sh check            # confirm the server, the model, and a one-sentence answer
```

**Ollama is reachable from this machine only.** It has no authentication, so `scripts/llm.sh` always binds it to `127.0.0.1` (the port from `LLM_BASE_URL`, default 11434) and refuses to start if `OLLAMA_HOST` names any other address, such as `0.0.0.0`. Browsers never talk to it either: only the web server does, so the web server's port stays the only one to open in the firewall. `scripts/llm.sh check` confirms the listening socket is loopback only, and warns if an Ollama started some other way is open to the network.

Ollama goes in `~/.local/ollama` and the models in `~/.ollama/models` unless `.env` says otherwise: `OLLAMA_PREFIX` and `OLLAMA_MODELS` move them, for example off a home directory with a disk quota (`scripts/llm.sh where` shows where they are).

`serve` turns on flash attention and an 8-bit KV cache (half the memory for long transcripts) and keeps one model loaded at a time. An Ollama you installed another way is used if it is on `PATH`. For vLLM or another OpenAI-compatible server, choose **OpenAI-compatible** and give its address (with or without `/v1`) and the model name it serves; an API key, if it needs one, goes in `LLM_API_KEY` and is never shown in the browser.

## Requirements

- Linux x86-64 with an NVIDIA driver recent enough for CUDA 12.8 PyTorch wheels (R570 or newer is safest). No CUDA toolkit is needed; PyTorch wheels bundle the runtime.
- Around 15 GB of disk for Python packages and models, plus space for recordings.
- Outbound HTTPS for installation, model downloads (Hugging Face), and Codex.
- For summaries, either about 13 GB of disk and a GPU with room for the local model (see [Choosing the summary model](#choosing-the-summary-model)), or a ChatGPT plan that includes Codex.
- A Hugging Face account, for diarization. Accept the conditions of [pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) and create a read token. Without it, transcripts are produced without speaker labels.

Nothing needs root. The installer puts Bun in `~/.bun` and uv in `~/.local/bin`. ffmpeg comes from the `imageio-ffmpeg` wheel, and Python comes from uv.

## Installation

```bash
git clone <this repo> ~/MeetingMinutes && cd ~/MeetingMinutes
scripts/install.sh              # add --vllm for the faster ASR backend, --no-gpu on a web-only host
$EDITOR .env                    # PUBLIC_URL, TRUST_PROXY, HF_TOKEN
scripts/llm.sh pull             # download the summary model (Qwen3.8 27B, about 13 GB)
bun run codex:login             # only to use Codex instead: device-code login with the ChatGPT account that pays
scripts/worker.sh check         # optional: download both speech models now and confirm the GPU works
```

Run it:

```bash
scripts/llm.sh serve            # the summary model
scripts/start.sh                # web server; prints the one-time setup token on first start
scripts/worker.sh               # a worker for every GPU (or WORKER_GPUS=0,1)
```

Open the site, enter the setup token (also saved in `data/setup.token`), and create the administrator. Invite everyone else from **Admin → Invitations**. You can also create an admin from the shell with `bun run admin create-admin <username>`.

To keep the processes running as systemd user services, see `deploy/systemd/`. The unit files explain the `loginctl enable-linger` caveat.

### Exposing it on a public IP

People need HTTPS: it protects passwords on the way in, and browsers only allow recording on HTTPS pages. There are two ways to get it.

#### Option A: serve HTTPS directly on a port (no reverse proxy)

The web server can serve HTTPS itself on any unprivileged port, so this needs no sudo.

1. Create a certificate for the server's address:

   ```bash
   scripts/make-cert.sh 203.0.113.10          # the public IP; add host names if you have them
   ```

   This creates `data/tls/ca.crt` (a private CA for your team, created once) and `data/tls/server.crt` / `server.key`, then prints the lines for `.env`.

2. Put them in `.env`:

   ```
   HOST=0.0.0.0
   PORT=8443
   TLS_CERT_FILE=data/tls/server.crt
   TLS_KEY_FILE=data/tls/server.key
   PUBLIC_URL=https://203.0.113.10:8443
   ```

3. Restart `scripts/start.sh` and `scripts/worker.sh`. People open `https://203.0.113.10:8443`. Plain `http://` on that port does not work.

GPU workers on the same machine connect to a separate plain-HTTP port, `INTERNAL_PORT` (default 8788). It listens on 127.0.0.1 only, serves nothing but the token-protected worker API, and workers pick it up automatically when `TLS_CERT_FILE` is set. A worker on another machine needs `MM_SERVER_URL` pointed at a reachable address, for example through an SSH tunnel.

**Certificate warning.** Browsers do not know your team CA, so they show a warning. There are two ways to handle it:

- **Trust the CA on each computer (recommended).** Import `data/tls/ca.crt` once:
  - Windows: double-click it, then _Install Certificate → Current User → Place all certificates in: Trusted Root Certification Authorities_. This needs no admin rights and covers Chrome and Edge.
  - macOS: open it in Keychain Access, then set _Trust → Always Trust_.
  - Chrome on Linux: _Settings → Privacy and security → Security → Manage certificates → Authorities → Import_.
  - Firefox (all systems): _Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import_.

  Afterwards there is no warning, and re-issuing the server certificate (for example after an IP change) needs nothing new on clients.

- **Accept the warning.** Each person clicks through the warning once, after checking that the SHA-256 fingerprint shown by the browser matches the one `make-cert.sh` printed. Recording works either way.

**Publicly trusted certificate instead.** If the server has a domain name, a public certificate avoids the warning altogether. [acme.sh](https://github.com/acmesh-official/acme.sh) can issue one without root, using a DNS challenge (`--dns`), so no port 80 is needed. Issue it, then install it with `scripts/install-cert.sh`. That puts it in `data/tls/` and has every renewal restart the web server:

  ```bash
  ~/.acme.sh/acme.sh --issue --dns dns_cf -d minutes.example.com   # Cloudflare; other DNS providers have their own dns_* name
  scripts/install-cert.sh minutes.example.com
  ```

  Then set `PUBLIC_URL=https://minutes.example.com:8443` (the `TLS_*` lines stay as above). acme.sh renews the certificate from its daily cron job and runs `scripts/restart.sh web` afterwards. `scripts/restart.sh` restarts the server in tmux sessions (`mm-web`, `mm-worker`); `web` or `worker` restarts one of them. Let's Encrypt also issues certificates for bare IP addresses, but they last only about six days and must be validated on port 80 or 443, which normally needs privileges.

If the machine runs a firewall, the chosen port (8443 above) has to be open.

#### Option B: behind a reverse proxy

Keep `HOST=127.0.0.1` and put a TLS-terminating proxy in front: `deploy/Caddyfile` (automatic HTTPS) or `deploy/nginx.conf`. Then set:

```
PUBLIC_URL=https://minutes.example.com
TRUST_PROXY=true
```

The proxy must accept request bodies larger than `UPLOAD_CHUNK_MB` (32 MB by default).

With either option, HTTPS turns on `Secure`, `__Host-` session cookies and HSTS. The server prints a warning at startup if it would serve plain HTTP on a network address.

#### Answering only to the domain name

When the site has a domain name (say `PUBLIC_URL=https://minutes.example.com:8443`), the server answers only requests addressed to that name. A browser or scanner that opens `https://203.0.113.10:8443` gets `421 Misdirected Request` and nothing else: no sign-in page, no cookies, no API. Programs on the server itself (GPU workers, health checks, the dev server) may still use `localhost` / `127.0.0.1`. The names come from `PUBLIC_URL`. To allow more, list them all in `ALLOWED_HOSTS` (comma-separated, e.g. `ALLOWED_HOSTS=minutes.example.com,minutes.lab.local`). A worker on another machine must then use one of those names in `MM_SERVER_URL`.

Two more steps keep the IP address from revealing the site:

- **Use a certificate for the name only.** With Option A, issue the certificate for the domain, not the IP (`scripts/make-cert.sh minutes.example.com`, or better a public certificate as described above). Then anyone opening the IP also gets a certificate warning.
- **Know what this does not do.** The check keeps out casual and automated visitors, but it is not access control. The domain name is in the certificate the server presents, and in public certificate-transparency logs. Anyone who knows the name can send it while connecting to the IP. The sign-in is what protects the data. To limit who can connect at all, allow only your networks in the machine's firewall, or put the site behind a VPN.

### Running as a normal user

Nothing here needs root: the site listens on a port above 1024 (8443 in the examples, and 8788 on loopback for the workers on the same machine), so no capabilities, `setcap` or `authbind` are involved. Run it as a user of its own. The web server parses requests from the internet and the worker decodes uploaded files with ffmpeg; as root, a flaw in either is a flaw in the whole machine, while a dedicated user reaches only this project and its data. `scripts/start.sh`, `scripts/worker.sh` and `scripts/restart.sh` print a warning when they are run as root (and still run).

On a server that was set up as root, `scripts/setup-user.sh` makes the change. Run it once, as root:

```bash
sudo scripts/setup-user.sh              # creates the system user "minutes"
sudo scripts/setup-user.sh meetings     # or another name (also MM_USER=meetings)
sudo scripts/setup-user.sh --dry-run    # only show what would be done
```

It creates the user if it does not exist (with a home directory and no password), gives it the project directory and the data directory, keeps the data directory at mode `700` and `.env` at `600`, and prints the steps below with your paths filled in. It deletes nothing and stops nothing, and it is safe to run again, for instance after an update done as root left files owned by root. A project under `/root` cannot be reached by another user: the script says so and changes nothing, and you move the project first (for example to `/opt/MeetingMinutes`).

Afterwards, as root:

1. Stop the services that still run as root: `tmux kill-session -t mm-web; tmux kill-session -t mm-worker`.
2. Run `sudo -u minutes -H scripts/install.sh` once more, with the options you used before (`--no-gpu` for a server without a GPU). Bun and uv are installed in the home directory of whoever ran it, and the worker's Python environment points there. Things kept in root's home directory do not move: the Codex login (`bun run codex:login` again as the new user), Ollama and its models, and Hugging Face downloads. Recordings, the database, the worker's CPU models and its enrollment are in the data directory and stay as they are.
3. Start the services as that user: `sudo -u minutes -H scripts/restart.sh`. Look at them with `sudo -u minutes -H tmux attach -t mm-web` (or `mm-worker`).
4. Start them at boot, one of:
   - cron: `crontab -u minutes -e`, with the line `@reboot /opt/MeetingMinutes/scripts/restart.sh`;
   - systemd system units with `User=minutes`: the script prints one for the web server (`ExecStart=…/scripts/start.sh`) and says what differs for the worker. The units in `deploy/systemd/` are user units for an ordinary login account (`systemctl --user`), which is the other way to do it.

   Use tmux or systemd, not both.
5. Update as that user from now on: `sudo -u minutes -H git -C /opt/MeetingMinutes pull`, then `sudo -u minutes -H scripts/restart.sh`.

**Certificate renewal.** `scripts/install-cert.sh` gives acme.sh a reload command (`scripts/restart.sh web`), and acme.sh renews from the crontab of the account it was installed for. If that was root, renewals would write `data/tls` as root, in files the new user cannot read, and restart the web server as root. Move it: as the new user, install acme.sh, issue the certificate again and run `scripts/install-cert.sh <domain>`; then, as root, `~/.acme.sh/acme.sh --remove -d <domain>`. Whichever account runs acme.sh must be able to write `data/tls`.

## Workers on other machines (NVIDIA, Mac)

GPUs elsewhere (a workstation with an NVIDIA card, a Mac with Apple silicon) can transcribe for the server **without being reachable from anywhere**: a worker only ever connects out to the site over HTTPS, asks for work, downloads that one recording, and sends back the transcript. Nothing connects to it, so it can sit behind NAT or a firewall with no open port.

To add one:

1. **Admin → System → Workers on other machines → Add**, and give it a name. The page shows a one-time enrollment code (valid for an hour) as a command.
2. On that machine, in a clone of this repository:
   ```
   scripts/install.sh --worker-only       # the worker only: no web server, no Ollama
   scripts/worker.sh enroll https://minutes.example.com:8443 mme_...
   scripts/worker.sh check                # downloads the models, shows what this machine can run
   scripts/restart.sh worker              # needs tmux (on a Mac: brew install tmux)
   ```
3. It appears in the list as **Connected**. Speaker separation on its GPU needs `HF_TOKEN` in its `.env`, as on the server.

How it works, and what it protects:

- **Its own credential.** Enrolling trades the code (single use) for a token that only this machine holds, in `data/worker-credential.json`, readable by its user only. The server keeps only a hash of it. **Revoke** stops it at once and puts any recording it was working on back in the queue. The shared `WORKER_TOKEN` stays for workers on the server itself.
- **Only its own jobs.** A remote worker can use only worker IDs under its own key, and can download only the recording of a job it is running at that moment. It gets URLs, never paths on the server. Compacting originals, which rewrites files on the server's disk, is left to the server's own worker.
- **Only the sound travels.** The worker downloads a small audio-only copy (mono Opus, 48 kbit/s: about 21 MB per hour), not the file as uploaded, which may be a video or an uncompressed WAV many times larger. The server makes it when the job is claimed, with the ffmpeg in the worker's Python environment on the server (or `FFMPEG_BIN`, or one on the PATH), one at a time and at low priority, and removes it once the job is done. Whether the original has video is found on the server, so the video pane still works. Recordings under 8 MB, already compacted ones, or a server without ffmpeg send the original as before. The meeting page shows the download as the first tenth of the progress bar ("Sending the recording").
- **In transit and afterwards.** Everything goes over the site's HTTPS, with the certificate verified (`MM_CA_FILE` for a self-signed one). Downloads resume after a dropped connection; the playback copy and waveform go back in chunks and are put in place only when the job completes. The worker works in a private temporary folder that is deleted after each job, so no recording stays on that machine.
- **People are told.** While any machine is enrolled, the upload page says recordings may be processed on other computers the administrator connected.

Platforms:

| Machine | Speech recognition | Speaker separation | Notes |
| --- | --- | --- | --- |
| Linux + NVIDIA | Qwen3-ASR on CUDA | pyannote on CUDA | The same as the server's own worker; GPU memory is checked with `nvidia-smi`. |
| Mac (Apple silicon) | Qwen3-ASR on the GPU (`mps`) | pyannote on `mps` | Chosen automatically on an arm64 Mac (`MM_DEVICE=mps`). Operations the Apple GPU lacks fall back to the CPU (`PYTORCH_ENABLE_MPS_FALLBACK=1`). The model runs in bfloat16; if it fails on yours, try `ASR_DTYPE=float16` or `float32`. Unified memory is shared with the system, so no free-memory check is made. **Not yet tested on real hardware**: run `scripts/worker.sh check`, then transcribe one short recording. |
| Any, without GPU packages | Transcription API | CPU (sherpa-onnx) or pyannoteAI | `scripts/install.sh --worker-only --no-gpu`. |

Each worker reports what it can run and which API keys it has, and the server hands it only work it can do: a worker without the key a setting needs is never handed that job (it would only fail).

**Settings per machine.** Admin → Transcription is the site-wide default. In Admin → System → Workers on other machines, each machine (and "Workers on this server") has its own **Settings**: speech recognition (its GPU or the transcription API) and speaker separation (its GPU, its CPU or pyannoteAI), each either its own or the site-wide one. A typical setup: the Mac and the NVIDIA box on their own GPUs, the server through the API with CPU separation.

**Fallback machines.** A machine marked as a fallback takes a recording only after it has waited a while (2 minutes by default) **while another worker is connected**; when every other worker is offline it takes work at once. With the server as a fallback, the GPU machines do the work while they are on, and the server picks it up when they are off. The upload page describes every path a recording may take ("depending on which worker takes it…") when machines are set differently.

## Recording meetings in the browser

**New recording → Record a meeting** offers two sources:

| Source         | Captures                                                                                                                         | Browsers                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Online meeting | The shared meeting tab (other participants) plus your microphone, or the tab alone when the microphone is set to _No microphone_ | Desktop Chrome, Edge and other Chromium browsers |
| Microphone     | Only the microphone                                                                                                              | Any modern browser                               |

To record Google Meet:

1. Start the recording.
2. Pick the Meet tab in the share dialog.
3. Turn on **Also share tab audio**.

With _No microphone_, the browser never asks for the microphone, and your own voice is not recorded, since the meeting tab does not play it back. You can still add the microphone during the recording.

Wear headphones, so the meeting audio from your speakers is not picked up a second time by the microphone. Echo cancellation is on, but headphones are more reliable.

A few limits to know about:

- **HTTPS is required.** Browsers only allow audio capture on HTTPS pages, or on `localhost`.
- **Firefox and Safari** cannot capture tab audio, so they only offer microphone recording.
- **Recording continues in the background.** You can switch tabs, but if you close the Minutes tab, recording stops. What was already recorded is kept locally and can be restored.
- **Tell participants** before you record.

## Configuration

All settings are environment variables. Put them in `.env` at the repository root; `.env.example` documents each one. The most relevant:

| Variable                                            | Default                                | Purpose                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_URL`                                        | –                                      | External URL. Controls secure cookies and invite links.                                                                                                                                                                                                                                                                            |
| `ADMIN_CONTACT`                                     | –                                      | Contact shown on the sign-in page for people without an account or who forgot their password (an email becomes a mailto link).                                                                                                                                                                                                     |
| `GOOGLE_CLIENT_ID`                                  | –                                      | Google OAuth client ID that lets people create Google Docs from summaries (see "Exporting to Google Docs").                                                                                                                                                                                                                        |
| `TRUST_PROXY`                                       | `false`                                | Trust `X-Forwarded-*` headers from your proxy.                                                                                                                                                                                                                                                                                     |
| `ALLOWED_HOSTS`                                     | host of `PUBLIC_URL`                   | Host names the site answers to; requests for any other host (such as the bare IP) get 421. Empty with no `PUBLIC_URL`: any host.                                                                                                                                                                                                   |
| `DATA_DIR`                                          | `data`                                 | SQLite database, media, and tokens. Back this directory up.                                                                                                                                                                                                                                                                        |
| `TLS_CERT_FILE` / `TLS_KEY_FILE`                    | empty                                  | Serve HTTPS directly (see "Option A").                                                                                                                                                                                                                                                                                             |
| `INTERNAL_PORT`                                     | `8788`                                 | Loopback-only worker API port, used when `TLS_CERT_FILE` is set.                                                                                                                                                                                                                                                                   |
| `MAX_UPLOAD_MB` / `UPLOAD_CHUNK_MB`                 | `4096` / `32`                          | Largest accepted file, and the size of each upload request. The upload page shows `MAX_UPLOAD_MB` and rejects larger files before sending. A reverse proxy must allow request bodies larger than `UPLOAD_CHUNK_MB` (for example nginx `client_max_body_size 64m`); otherwise users see "the server refused the upload (HTTP 413)". |
| `MAX_AUDIO_HOURS`                                   | `8`                                    | Longest recording a worker decodes. Longer (or crafted) files fail with a clear message instead of exhausting memory. The decoded audio is held in memory, about 230 MB per hour of recording, so on a server with little memory set this to what fits.                                                                                                                                                                                                              |
| `HF_TOKEN`                                          | –                                      | Enables speaker diarization (and with it, recognising speakers by voice).                                                                                                                                                                                                                                                          |
| `VOICE_MATCH_THRESHOLD` / `VOICE_SUGGEST_THRESHOLD` | `0.6` / `0.45`                         | Voice similarity at which a speaker is named after a known voice, or only suggested.                                                                                                                                                                                                                                               |
| `ASR_MODEL` / `ASR_BACKEND`                         | `Qwen/Qwen3-ASR-1.7B` / `transformers` | Recognition model and engine (`vllm` for speed).                                                                                                                                                                                                                                                                                   |
| `WORKER_GPUS`                                       | all                                    | GPUs to run workers on, as `nvidia-smi` numbers them, e.g. `0,1`.                                                                                                                                                                                                                                                                  |
| `WORKER_NICE`                                       | `10`                                   | CPU priority of the worker: `scripts/worker.sh` runs it under `nice -n 10`, so the web server on the same machine stays responsive while a recording is decoded or its speakers are separated on the CPU. `19` is the lowest priority; `0` runs it without `nice`.                                                           |
| `MIN_FREE_VRAM_GB`                                  | `8`                                    | Free GPU memory a GPU needs before a GPU session starts on it. Raise it if sessions run out of memory with a larger `ASR_BATCH_SIZE`.                                                                                                                                                                                              |
| `MEDIA_COMPACT` / `MEDIA_COMPACT_AFTER_DAYS` / `MEDIA_COMPACT_KBPS` | `false` / `7` / `32` | Replace originals with mono Opus audio this many days after transcription, dropping any video (see Operations, "Disk space"). The first two are defaults: Admin → System overrides them. |
| `ASR_ENGINE` / `ASR_API_PROVIDER` / `ASR_API_MODEL` | `local` / `openrouter` / `qwen/qwen3-asr-1.7b` | Where speech is recognised: `local` (the GPU) or `api`, and with `api` the service (`openrouter` or `openai`) and model. Defaults: Admin → Transcription overrides them. `ASR_API_BASE_URL` is the address of an OpenAI-compatible server (empty: OpenAI). |
| `DIARIZATION_ENGINE` / `PYANNOTEAI_API_KEY`         | `local` / –                            | Who separates speakers: `local` (pyannote on the GPU), `cpu` (sherpa-onnx) or `pyannoteai`. This is a default that Admin → Transcription overrides. The key is read by workers only. `DIARIZATION_CPU_THREADS` / `DIARIZATION_CPU_THRESHOLD` tune the CPU option. |
| `OPENROUTER_API_KEY` / `ASR_API_KEY`                | –                                      | Worker only: the key for OpenRouter, or for an OpenAI-compatible server (`ASR_API_KEY` also serves OpenRouter; `OPENAI_API_KEY` also serves OpenAI). Never sent to the web server or browsers.                                                                                                                                   |
| `MIN_FREE_VRAM_API_GB` / `ASR_API_CONCURRENCY`      | `3` / `4`                              | With an API: free GPU memory a session needs (pyannote only), and segments sent at the same time. `ASR_API_TIMEOUT_SEC` (120) limits one request.                                                                                                                                                                                |
| `MODEL_KEEPALIVE_SEC`                               | `0`                                    | Seconds a GPU session waits for more work before releasing the GPU.                                                                                                                                                                                                                                                                |
| `SUMMARY_PROVIDER`                                  | `local`                                | Who writes summaries: `local` or `codex`. A default: Admin → Summary model overrides it.                                                                                                                                                                                                                                           |
| `LLM_API` / `LLM_BASE_URL` / `LLM_MODEL`            | `ollama` / `http://127.0.0.1:11434` / `batiai/qwen3.8-27b:q3` | The local model server and model (`openai` for vLLM, llama.cpp, LM Studio).                                                                                                                                                                                                                                       |
| `LLM_CONTEXT_TOKENS` / `LLM_THINK`                  | `65536` / `false`                      | Context window (longer transcripts are read in parts) and thinking.                                                                                                                                                                                                                                                                |
| `LLM_KEEP_ALIVE_SEC` / `LLM_GPUS`                   | `0` / all                              | Seconds the model stays in GPU memory after a summary; GPUs Ollama may use (`scripts/llm.sh`).                                                                                                                                                                                                                                     |
| `LLM_TIMEOUT_SEC` / `LLM_CONCURRENCY` / `LLM_API_KEY` | `3600` / `1` / –                     | Longest summary, summaries at once, and a key for an OpenAI-compatible server (never sent to browsers).                                                                                                                                                                                                                            |
| `CODEX_MODEL` / `CODEX_REASONING_EFFORT`            | Codex defaults                         | Codex model settings (also on the admin page).                                                                                                                                                                                                                                                                                     |
| `CODEX_CONCURRENCY`                                 | `1`                                    | Parallel Codex summaries (each uses quota). Each person can have at most 3 summaries queued or running.                                                                                                                                                                                                                                  |

## How summaries use Codex

With Codex chosen, for each summary the backend runs:

```
codex exec --ephemeral --sandbox read-only --ignore-user-config --skip-git-repo-check \
           --disable shell_tool --disable unified_exec … -c web_search="disabled" --json -o <file> -
```

It runs in an empty temporary directory, with the prompt (instructions, meeting metadata, and the speaker-labelled transcript) on stdin. The prompt tells the model to treat the transcript as untrusted data, but the safeguards below do not rely on the model obeying it:

- **Tools off, verified**: before the first run, the backend reads `codex features list` and checks that every tool that could act on the machine (`shell_tool`, `unified_exec`, `view_image`) is known and will be disabled. If the listing cannot be read, or a newer Codex renames one of them, summaries are paused (fail closed) and the admin page says why, instead of running with a tool left on. Unknown flags are a hard error in Codex, so only features the installed version reports are passed.
- **Tripwire**: the run is watched through `--json`. Any event other than text, reasoning, or a plan (for example a command or file access) kills Codex immediately and discards the result.
- **No secrets in reach**: Codex gets only an allowlisted environment (what it needs to run and sign in: `PATH`, `HOME`, `CODEX_HOME`, its own API key if you use one, locale, CA and proxy settings), never the worker token, `HF_TOKEN`, or the data directory path. The read-only sandbox prevents writes.
- **Output check**: a summary that contains a server credential (the worker token, API keys, or the Codex login) is discarded.

The admin page shows whether Codex is signed in, and whether summaries are paused.

A local model gets the same prompt as a plain chat request (system and user messages) with no tools offered, so a prompt injection in a transcript has nothing to act with. Its output goes through the same credential check, and `LLM_API_KEY` is neither passed to Codex nor shown on any page.

## Exporting to Google Docs

Every summary's **Export** menu has a **Google Docs** section, for the summary alone or with the transcript appended. The document keeps the summary's headings, lists, tables and links, starts with the meeting details (date, length, speakers, which summary version), and every `[hh:mm:ss]` links back to that moment of the recording here (only its owner can open it).

How it works depends on whether `GOOGLE_CLIENT_ID` is set:

- **Set**: the document is created directly in the person's own Google Drive. The first time, Google asks them to sign in and allow access. They get a link to open the document.
- **Not set** (the default): the formatted summary is copied, and a button opens a new Google Doc to paste it into. This needs no setup and works on any address, including a bare IP.

### Setting up direct export

You need a Google Cloud project (free) and a domain name for the site: Google does not accept a bare IP address as a sign-in origin, so with "Option A" on an IP address, keep the copy-and-paste mode.

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project or pick one, open **APIs & Services → Library**, and enable the **Google Drive API**.
2. Open **Google Auth Platform** (formerly _OAuth consent screen_) and fill in the app name and support email.
   - **Audience**: _Internal_ if everyone uses one Google Workspace organisation. Otherwise _External_: either publish the app (**In production**), or keep it in _Testing_ and add each person as a test user.
   - **Data access**: add the scope `https://www.googleapis.com/auth/drive.file`. It is a non-sensitive scope, so Google does not need to review the app.
3. Under **Clients**, create an OAuth client of type **Web application**. Under **Authorised JavaScript origins**, add the site's address exactly as people open it, for example `https://minutes.example.com` (no path, no trailing slash). No redirect URI is needed.
4. Put the client ID in `.env` and restart the server:

   ```
   GOOGLE_CLIENT_ID=1234567890-abc123.apps.googleusercontent.com
   ```

Only the client ID is needed. There is no client secret to keep, because the server never talks to Google.

What this changes, and what it does not:

- **The summary goes from the browser straight to Google**, under the person's own Google account. The server never receives a Google token, and Google never receives anything from the server.
- **The `drive.file` permission only reaches files this site creates.** It cannot list, read or change anything else in the person's Drive. The token is kept in the open tab's memory for up to an hour and is never stored. People can withdraw the access at any time in their [Google account](https://myaccount.google.com/connections).
- **Headers**: with a client ID set, the Content-Security-Policy also allows Google's sign-in script and pop-up (`https://accounts.google.com/gsi/`) and Drive uploads (`https://www.googleapis.com`). `Cross-Origin-Opener-Policy` becomes `same-origin-allow-popups`, so the sign-in pop-up can hand the token back to the page. Google's script is loaded only when someone opens an Export menu, not on every page.

## Security model

- **Passwords**: argon2id (Bun's native implementation), 10 characters minimum.
- **Sessions**: random 256-bit tokens; only their SHA-256 hash is stored. Cookies are `HttpOnly` and `SameSite=Lax`, and `Secure` with the `__Host-` prefix when served over HTTPS. Sessions slide over 30 days, and changing your password signs out your other devices.
- **CSRF**: every state-changing API call must carry a custom `X-MM-Client` header, which cross-site forms cannot send and cross-origin scripts cannot send without a CORS preflight that is never granted. A foreign `Origin` header is also rejected.
- **Brute force**: failed sign-ins are limited per IP (20 per 15 minutes) and per username (8 per 15 minutes). Setup and invite tokens are rate-limited too, and unknown usernames take the same time to fail as wrong passwords. An invitation link admits at most the number of people it was created for, even when they sign up at the same moment, and one for an administrator admits only one.
- **Bootstrap**: the first admin needs the setup token from the server log or data directory, so a fresh public instance cannot be claimed by a stranger.
- **Isolation**: every meeting, media file, export, and summary query is scoped to its owner; someone else's meeting or summary is answered with 404, not 403, so IDs cannot be probed. The live-update stream closes when its session is signed out or the account is disabled.
- **Uploaded files**: stored under random IDs, served with a media type derived from the checked file extension (never the type the browser declared), `X-Content-Type-Options: nosniff`, and the site CSP, so an uploaded HTML or SVG file cannot run as a page. ffmpeg reads them with `-protocol_whitelist file`, so a crafted playlist cannot fetch URLs or other files, and decoding stops at `MAX_AUDIO_HOURS`.
- **Browser recordings**: unsent recordings kept in the browser (IndexedDB) are tagged with the account that made them and are shown only to that account on a shared computer.
- **Quotas**: at most 3 summaries queued or running per person, so one account cannot drain the shared Codex plan or occupy the summary GPU.
- **Local model server**: Ollama listens on `127.0.0.1` only (`scripts/llm.sh` refuses anything else), so other machines cannot use it; the web server is its only client, and the web server's port is the only one that needs to be open.
- **pyannoteAI**: only administrators can choose it. The whole recording is uploaded under a random name to pyannoteAI's temporary storage, and the upload page says so. Voice fingerprints stay on the worker. The key lives in each worker's environment only.
- **Transcription API**: only administrators can choose it. Its key lives in each worker's environment and is never sent to the web server, stored in the database, or shown in the browser; workers report only whether they have one. Only speech segments are sent, never the whole recording, and the upload page says where they go before anything is uploaded.
- **Summary model settings**: only administrators can see or change them. The server address must be `http(s)://` without credentials, and model names are checked before they reach a command line or a request. People starting a summary are told where it goes: on this server, to the model server's host, or to OpenAI.
- **Files on disk**: the server and worker create everything with mode `0600`/`0700` (`umask 077`), and the data directory is restricted to its owner at every start. The scripts make `.env` readable by its owner only.
- **Headers**: a strict Content-Security-Policy (no third-party origins, except Google's sign-in and Drive when Google Docs export is set up; fonts are self-hosted), `frame-ancestors 'none'`, HSTS over HTTPS, and a Permissions-Policy that allows only the microphone and tab capture (for recording) and only on this site.
- **Request sizes**: JSON bodies are limited before they are parsed: 64 KB for requests anyone can send (signing in, setup, accepting an invitation, enrolling a worker) and for the workers' status messages, 4 MB for a signed-in person. Only upload chunks (`UPLOAD_CHUNK_MB`) and a worker's finished result may be larger, and both require a session or a worker token first.
- **Workers** on this machine authenticate with a shared bearer token (`WORKER_TOKEN` or `data/worker.token`), compared in constant time; with built-in HTTPS they use a loopback-only port (`INTERNAL_PORT`). Workers on other machines each have their own revocable token from a single-use, hour-long enrollment code (stored as a hash, rate-limited), and may only download the recording of a job they are running (see "Workers on other machines"). Such a worker in turn trusts the server only as far as its jobs go: it connects over HTTPS only (plain HTTP is accepted for loopback addresses alone), uploads nothing but the playback copy and waveform it made, and sends its OpenRouter key to OpenRouter's own address whatever a job says.

Recommended for a deployment:

- Run the server and worker as a dedicated OS user that owns only this checkout, the data directory, and its Codex login; nothing else of value should be readable by that user. `scripts/setup-user.sh` sets one up on a server that was installed as root (see "Running as a normal user").
- Open only the HTTPS port in the firewall (not 11434: Ollama is for this machine only). Keep `TRUST_PROXY=false` unless a reverse proxy is in front; with built-in HTTPS, trusting `X-Forwarded-For` would let clients choose the address used for sign-in rate limits (the server warns about this at startup).
- Dependencies: `bun audit` is clean. `pip-audit` on the worker reports advisories in `transformers`, `accelerate`, `torch`, and `vllm`. They concern loading untrusted model checkpoints, the vLLM HTTP server, or local attackers, none of which this worker does or exposes: it loads only the configured Hugging Face models, and vLLM (optional) is used in-process. Upgrade when `qwen-asr` allows newer pins.

## Development

```bash
bun install
bun run dev:backend             # API on :8787 (auto-reload)
bun run dev:frontend            # Vite on :5173, proxies /api
cd worker && uv sync            # the pipeline without GPU packages
ASR_BACKEND=fake uv run python -m mm_worker run   # stand-in models, no GPU or torch needed
```

Tests:

```bash
bun run test                    # backend: auth, CSRF, uploads, worker protocol, Codex runner (fake codex)
bun run typecheck               # backend + frontend
cd worker && uv run pytest      # segmentation, text normalisation, ffmpeg, pipeline, voice fingerprints, GPU-session lifecycle
```

Project layout:

```
backend/   Bun + Hono API, SQLite schema/migrations, Codex runner, local model client, job queue, SSE
frontend/  React app: pages/, components/, i18n/ (en, zh-TW), styles/ (design tokens)
worker/    mm_worker: supervisor, GPU session, audio (ffmpeg), segmenter, ASR, diarization, voice fingerprints
scripts/   install.sh, start.sh, worker.sh, restart.sh, setup-user.sh, llm.sh (summary model), codex-login.sh
deploy/    Caddyfile, nginx.conf, systemd user units
```

## Operations

- **Updating**: `git pull`, then restart `scripts/start.sh` and `scripts/worker.sh` (or the systemd services). `scripts/llm.sh install` updates Ollama. `start.sh` reinstalls JavaScript dependencies when `bun.lock` changed and rebuilds the web interface when its sources changed, so browsers get the new UI after a reload. If `worker/uv.lock` changed, run `scripts/install.sh` once (repeat `--vllm` if you use it).
- **Speaker diarization status**: the admin page shows a warning on a worker only after loading the diarization model actually failed, with the reason. Each meeting also records whether diarization ran; a transcript without speakers says why and offers **Separate speakers again**.
- **Everyone appears as one speaker**: usually pyannote is not running. To enable it:
  1. With a Hugging Face account, accept the conditions of [pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1).
  2. Create a _read_ token, and put it in `.env` as `HF_TOKEN=hf_…`. A token saved with `huggingface-cli login` as the worker's user also works.
  3. Restart `scripts/worker.sh`, then run `scripts/worker.sh check`: it must print `Diarization: ready`.
  4. On affected meetings, choose **Separate speakers again** (the meeting's ⋯ menu).

  If pyannote runs but still merges people, give the number of speakers: automatic detection can merge similar voices into one, while a given count (or range) splits into exactly that many.

- **Disk space: keeping only compact audio**: **Admin → System → Keeping recordings** can replace each original, some days after it was transcribed (`MEDIA_COMPACT_AFTER_DAYS`, default 7), with a mono Opus copy at `MEDIA_COMPACT_KBPS` (default 32 kbit/s, about 14 MB per hour), dropping any video. A one-hour 1080p meeting recording of 0.5 to 2 GB becomes about 14 MB, next to the 29 MB playback copy that every meeting already has. Off by default.
  - Transcribing again, **Separate speakers again** and voice fingerprints read only the audio, so they keep working on the copy. The video pane and downloading the file as uploaded are given up; **Export → Audio (compacted)** downloads the copy.
  - It applies to meetings already on the server as well as new ones. Only originals that shrink are touched (any video, or audio above 1.5 times the target bitrate: WAV, FLAC, 128 kbit/s MP3 or M4A). Already small audio, such as recordings made in the browser, is left alone.
  - A worker does the work with ffmpeg on the CPU, one recording at a time, outside GPU sessions (`MM_MEDIA_JOBS=0` turns this off on a worker). The backend swaps the copy in only if its length matches the recording, and keeps the original if the meeting is being transcribed again meanwhile. A copy that fails is reported on the admin page and not retried; its original stays as it was.
  - The upload page tells people who choose a video that the picture will not be kept. Compacting cannot be undone, so the admin page asks before it starts on meetings that are already due.
- **Backups**: copy `data/`. SQLite runs in WAL mode; use `sqlite3 data/meetingminutes.sqlite ".backup backup.sqlite"` for a consistent snapshot while the server is running.
- **Workers after an update**: a worker from before voice recognition still runs transcriptions; it is never given the background voice-fingerprint jobs, which wait until an updated worker claims them. Restart `scripts/worker.sh` after `git pull` to process them.
- **Stuck jobs**: if a worker dies mid-job, the backend notices the missing heartbeat within 3 minutes and requeues the job (up to 3 attempts).
- **Summaries paused**: if the admin page says summaries are paused, the installed Codex could not prove that its tools are off (usually after a Codex upgrade renamed a feature). Check `backend/node_modules/.bin/codex features list`, and update this project or pin the previous Codex version.
- **Summaries fail with "Cannot reach the local model server"**: start `scripts/llm.sh serve` (or `systemctl --user start meetingminutes-llm`), then `scripts/llm.sh check`. "Not available" means the model is not downloaded: `scripts/llm.sh pull`, or **Download** in Admin → Summary model. To keep using Codex instead, choose it there.
- **Admin CLI**: `bun run admin list-users | reset-password <user> | create-admin <user> | setup-token | worker-token`.
