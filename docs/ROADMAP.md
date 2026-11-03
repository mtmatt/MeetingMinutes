# Roadmap

Plans that are decided but not built yet. For what the service does today, see the [README](../README.md).

## Where transcription runs

Decided 2026-11-03.

1. **Now: an RTX 4090 at school**, a Linux machine with an NVIDIA GPU. This is the setup the worker already supports, so nothing needs to be built. Running on a Mac was considered and dropped.
2. **Later, as an option: in the cloud on [Modal](https://modal.com/pricing), billed per second.** We will not rent a GPU machine that runs around the clock.

### When to move to Modal

Move when either of these holds:

- the school 4090 is no longer available to us;
- or results are needed while it is off, busy, or unreachable.

Volume alone is unlikely to force the move: one 4090 processes a recording much faster than real time. Measure this pipeline's speed on it before setting a volume threshold.

A rough cost, from two inputs:

- **Price**: [Modal's pricing page](https://modal.com/pricing) listed an L4 GPU at US$0.000222 per second, about US$0.80 per hour, on 2026-11-03. Research on 2026-11-02 had about US$1.2 per hour; check the page before relying on either.
- **Speed**: an unverified estimate from that research, with no recorded benchmark source: faster-whisper running **Whisper large-v3** at about 15.5× real time on an L4, taken as about 6 minutes of GPU per hour of recording (speed alone gives 3.9 minutes; 6 leaves room for overhead). This project runs Qwen3-ASR-1.7B and pyannote instead, so treat it only as an order of magnitude.

So the GPU cost is about 6 minutes × US$0.80 per hour, or US$0.08 per hour of recording:

| Recordings per month | GPU cost per month |
| -------------------- | ------------------ |
| 10 hours             | about US$0.80      |
| 50 hours             | about US$4         |
| 200 hours            | about US$16        |

This counts GPU time only. It leaves out Modal's CPU, memory and storage charges, and the time containers spend starting: Modal containers start cold, which adds a delay before the first job of a busy period.

### Work needed before moving to Modal

- A way to start a worker per job (for example, the backend calls a Modal function). Today the worker is a long-running supervisor that polls the backend for jobs over HTTP, which per-second billing does not suit.
- Deployment code for Modal: an image with the GPU dependencies, model downloads and caching, and passing the worker token and `HF_TOKEN` as Modal secrets.
- Measure Qwen3-ASR and pyannote speed and cold-start time on Modal, then revisit the cost figures above.
