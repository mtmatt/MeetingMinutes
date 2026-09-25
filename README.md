# Minutes

A self-hosted meeting-minutes service. Upload a recording (audio or video). It is transcribed **locally on your own GPUs**, with speaker separation and Taiwan Traditional Chinese output, and then summarised by **Codex**, billed to your ChatGPT plan, using a prompt you choose.

- **Backend**: TypeScript on Bun, with Hono and SQLite (`bun:sqlite`).
- **Frontend**: React and Vite with a custom design system, in English and 繁體中文, with light and dark themes.
- **GPU worker**: Python, running Qwen3-ASR-1.7B for recognition and pyannote community-1 for speaker diarization.
- **No root required** anywhere: install, run, and update all happen as a normal user.

```
 browser ──HTTPS──▶ Caddy/nginx ──▶ backend (Bun, :8787) ──── SQLite + media files (data/)
                                     │    ▲         │
                     spawns per job  │    │ pull    │ codex exec (read-only, tools off)
                                     ▼    │ jobs    ▼
                                  ChatGPT/Codex   GPU worker supervisor (no CUDA while idle)
                                                        │ spawns on demand
                                                        ▼
                                                  GPU session: Qwen3-ASR + pyannote → exits, VRAM freed
```

## Features

- **Upload** audio or video up to 4 GB. Uploads are chunked and resumable, so they survive flaky connections and proxy body limits.
- **Transcription options**: language (auto-detect handles Mandarin–English code-switching), speaker count (auto, exact, or range), a vocabulary list fed to the recogniser as context, and Chinese script (Taiwan Traditional via OpenCC `s2twp`, Simplified, or as recognised).
- **Summaries**: pick a template, edit the prompt for this upload, and choose the output language. Summaries can run automatically when the transcript is ready, and you can re-run them any time with a different prompt; every run is kept as a version.
- **Meeting view**:
  - a waveform with one lane per speaker;
  - a transcript that highlights and follows playback;
  - click any line or any `[hh:mm:ss]` in a summary to jump there;
  - rename speakers, reassign paragraphs, edit text;
  - talk-time per speaker;
  - search inside the transcript;
  - optional video pane.
- **Exports**: TXT, Markdown, SRT, WebVTT, JSON, the original media, and summaries as `.md`.
- **Templates**: six built-ins (minutes, action items, executive brief, detailed notes, decision log, lecture notes) plus your own.
- **Accounts**:
  - first-run admin setup protected by a one-time token;
  - invitation links;
  - password reset links;
  - roles, disabling users, and a per-user session list with remote sign-out.
- **Admin system page**: GPU workers (model state, VRAM), queue, Codex login status, and disk usage.
- **Live updates** over Server-Sent Events: progress, stages, and summaries appear without reloading.

## Choosing the ASR model (RTX 4090)

The target is Mandarin–English code-switched meetings, with Traditional Chinese output, on one or two RTX 4090s (24 GB each).

| Option | Chinese | English | Code-switching | Notes |
| --- | --- | --- | --- | --- |
| **Qwen3-ASR-1.7B** (chosen) | AISHELL-2 WER **2.71** | LibriSpeech 1.63 / 3.38 | strong; language ID per chunk | Apache-2.0 (2026). Accepts a text *context* for names and jargon. Transformers and vLLM backends. About 5 GB of VRAM in bf16. |
| Whisper large-v3 / turbo | AISHELL-2 WER 5.06 | 1.51 / 3.97 | good | Tends to output Simplified. Known hallucination loops on silence. |
| Breeze-ASR-25 (Whisper-v2 fine-tune) | tuned for Taiwanese Mandarin | good | good | Worth trying as an alternative; still has Whisper's failure modes. |
| SenseVoice / Paraformer | very fast, strong Mandarin | weaker English | weak | Better suited to Mandarin-only audio. |
| Parakeet / Canary | – | best-in-class | – | English only. |

Qwen3-ASR-1.7B roughly halves Whisper-large-v3's Chinese error rate, keeps English at parity, and takes a vocabulary prompt, which matters for product names in meetings. The 0.6B variant exists if throughput matters more than accuracy.

Speaker diarization uses **pyannote `speaker-diarization-community-1`**. It improves on 3.1 for speaker counting (for example AliMeeting DER 20.3 vs 24.5). The worker takes each speaker turn, merges short same-speaker turns, splits long ones at quiet points (≤ 30 s), and transcribes those segments in batches. Segment boundaries become the transcript timestamps.

On a 4090, both models together use roughly 6–8 GB. Each GPU runs its own worker, so two GPUs process two meetings in parallel. `ASR_BACKEND=vllm` (install with `--vllm`) gives higher throughput on long recordings.

Sources: [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR), [Qwen3-ASR technical report](https://arxiv.org/abs/2601.21337), [pyannote community-1 benchmarks](https://github.com/pyannote/pyannote-audio).

### GPU policy: models are loaded only when there is work

The worker supervisor that runs all the time never imports PyTorch or creates a CUDA context, so **an idle worker uses no GPU memory**. When the backend has a job, the supervisor starts a separate GPU process. That process:

1. loads the models (shown as *Loading models* in the UI);
2. processes the job, and any other jobs already waiting, back to back;
3. exits.

Process exit is what guarantees all VRAM is returned, including the CUDA context that `torch.cuda.empty_cache()` cannot release. The cost is model-loading latency at the start of each busy period (typically tens of seconds from a warm disk cache). `MODEL_KEEPALIVE_SEC` (default `0`) can keep a session warm for a few seconds if you ever want to trade that off. GPU status on the admin page comes from `nvidia-smi`, which does not allocate VRAM.

## Requirements

- Linux x86-64 with an NVIDIA driver recent enough for CUDA 12.8 PyTorch wheels (R570 or newer is safest). No CUDA toolkit is needed; PyTorch wheels bundle the runtime.
- Around 15 GB of disk for Python packages and models, plus space for recordings.
- Outbound HTTPS for installation, model downloads (Hugging Face), and Codex.
- A ChatGPT plan that includes Codex, for summaries.
- A Hugging Face account, for diarization. Accept the conditions of [pyannote/speaker-diarization-community-1](https://huggingface.co/pyannote/speaker-diarization-community-1) and create a read token. Without it, transcripts are produced without speaker labels.

Nothing needs root. The installer puts Bun in `~/.bun` and uv in `~/.local/bin`. ffmpeg comes from the `imageio-ffmpeg` wheel, and Python comes from uv.

## Installation

```bash
git clone <this repo> ~/MeetingMinutes && cd ~/MeetingMinutes
scripts/install.sh              # add --vllm for the faster ASR backend, --no-gpu on a web-only host
$EDITOR .env                    # PUBLIC_URL, TRUST_PROXY, HF_TOKEN
bun run codex:login             # device-code login with the ChatGPT account that pays for summaries
scripts/worker.sh check         # optional: download both models now and confirm the GPU works
```

Run it:

```bash
scripts/start.sh                # web server; prints the one-time setup token on first start
scripts/worker.sh               # one worker per GPU (WORKER_GPUS=0,1 or all GPUs by default)
```

Open the site, enter the setup token (also saved in `data/setup.token`), and create the administrator. Invite everyone else from **Admin → Invitations**. You can also create an admin from the shell with `bun run admin create-admin <username>`.

To keep both processes running as systemd user services, see `deploy/systemd/`. The unit files explain the `loginctl enable-linger` caveat.

### Exposing it on a public IP

Keep `HOST=127.0.0.1` and put a TLS-terminating reverse proxy in front: `deploy/Caddyfile` (automatic HTTPS) or `deploy/nginx.conf`. Then set:

```
PUBLIC_URL=https://minutes.example.com
TRUST_PROXY=true
```

This turns on `Secure`, `__Host-` session cookies and HSTS, and makes rate limiting use the real client IP. Binding ports 80/443 normally needs privileges; if you cannot get them, run Caddy on a high port or ask for a port redirect.

## Configuration

All settings are environment variables. Put them in `.env` at the repository root; `.env.example` documents each one. The most relevant:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_URL` | – | External URL. Controls secure cookies and invite links. |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-*` headers from your proxy. |
| `DATA_DIR` | `data` | SQLite database, media, and tokens. Back this directory up. |
| `MAX_UPLOAD_MB` / `UPLOAD_CHUNK_MB` | `4096` / `32` | Upload limits. |
| `HF_TOKEN` | – | Enables speaker diarization. |
| `ASR_MODEL` / `ASR_BACKEND` | `Qwen/Qwen3-ASR-1.7B` / `transformers` | Recognition model and engine (`vllm` for speed). |
| `WORKER_GPUS` | all | GPUs to run workers on, e.g. `0,1`. |
| `MODEL_KEEPALIVE_SEC` | `0` | Seconds a GPU session waits for more work before releasing the GPU. |
| `CODEX_MODEL` / `CODEX_REASONING_EFFORT` | Codex defaults | Summary model settings. |
| `CODEX_CONCURRENCY` | `1` | Parallel summaries (each uses quota). |

## How summaries use Codex

For each summary, the backend runs:

```
codex exec --ephemeral --sandbox read-only --ignore-user-config --skip-git-repo-check \
           --disable shell_tool --disable unified_exec … -c web_search="disabled" --json -o <file> -
```

It runs in an empty temporary directory, with the prompt (instructions, meeting metadata, and the speaker-labelled transcript) on stdin. Codex has no tools and no writable disk. The prompt tells the model to treat the transcript as untrusted data. The backend only disables feature flags that the installed Codex version actually reports, because unknown flags are a hard error. The admin page shows whether Codex is signed in.

## Security model

- **Passwords**: argon2id (Bun's native implementation), 10 characters minimum.
- **Sessions**: random 256-bit tokens; only their SHA-256 hash is stored. Cookies are `HttpOnly` and `SameSite=Lax`, and `Secure` with the `__Host-` prefix when served over HTTPS. Sessions slide over 30 days, and changing your password signs out your other devices.
- **CSRF**: every state-changing API call must carry a custom `X-MM-Client` header, which cross-site forms cannot send and cross-origin scripts cannot send without a CORS preflight that is never granted. A foreign `Origin` header is also rejected.
- **Brute force**: failed sign-ins are limited per IP (20 per 15 minutes) and per username (8 per 15 minutes). Setup and invite tokens are rate-limited too, and unknown usernames take the same time to fail as wrong passwords.
- **Bootstrap**: the first admin needs the setup token from the server log or data directory, so a fresh public instance cannot be claimed by a stranger.
- **Isolation**: every meeting, media file, export, and summary query is scoped to its owner.
- **Headers**: a strict Content-Security-Policy (no third-party origins; fonts are self-hosted), `frame-ancestors 'none'`, and HSTS over HTTPS.
- **Workers** authenticate with a shared bearer token (`WORKER_TOKEN` or `data/worker.token`), compared in constant time.

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
cd worker && uv run pytest      # segmentation, text normalisation, ffmpeg, pipeline, GPU-session lifecycle
```

Project layout:

```
backend/   Bun + Hono API, SQLite schema/migrations, Codex runner, job queue, SSE
frontend/  React app: pages/, components/, i18n/ (en, zh-TW), styles/ (design tokens)
worker/    mm_worker: supervisor, GPU session, audio (ffmpeg), segmenter, ASR, diarization
scripts/   install.sh, start.sh, worker.sh, codex-login.sh
deploy/    Caddyfile, nginx.conf, systemd user units
```

## Operations

- **Backups**: copy `data/`. SQLite runs in WAL mode; use `sqlite3 data/meetingminutes.sqlite ".backup backup.sqlite"` for a consistent snapshot while the server is running.
- **Stuck jobs**: if a worker dies mid-job, the backend notices the missing heartbeat within 3 minutes and requeues the job (up to 3 attempts).
- **Admin CLI**: `bun run admin list-users | reset-password <user> | create-admin <user> | setup-token | worker-token`.
