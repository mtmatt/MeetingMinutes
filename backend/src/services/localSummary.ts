import { chat, LlmError, modelInfo, type ChatMessage, type ChatResult } from "./llm";
import type { SummaryPromptParts } from "./summarizer";
import type { LocalModelSettings } from "./summarySettings";

/**
 * Summaries written by a local model.
 *
 * A local model has a much smaller context window than Codex (64K tokens by
 * default, about three hours of Mandarin), and servers cut an over-long prompt
 * silently. So the prompt is measured first: a transcript that fits is
 * summarised in one call; a longer one is read in consecutive parts, each
 * turned into detailed notes with their timestamps, and the document is then
 * written from the notes. Nothing is ever dropped to make it fit.
 */

export interface LocalSummaryResult {
  text: string;
  model: string;
  usage: Record<string, number> | null;
}

/**
 * Tokens a text will take, erring on the high side. Qwen and most current
 * tokenizers spend about one token per Chinese character and per digit (so a
 * "[01:23:45]" timestamp is about eight), and far less per Latin letter.
 */
export function estimateTokens(text: string): number {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x30 && c <= 0x39) n += 1;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) n += 0.3;
    else if (c === 0x20 || c === 0x0a || c === 0x09) n += 0.25;
    else if (c < 0x80) n += 0.6;
    else n += 1;
  }
  return Math.ceil(n * 1.1) + 8;
}

/** How a context window is shared between the prompt and the answer. */
export function contextBudget(contextTokens: number, think: boolean): { answer: number; input: number } {
  // A quarter of the window for the answer (8K of 32K, 16K of 64K), half when
  // the model thinks first, since thinking is spent before the answer starts.
  const answer = think ? Math.min(32768, Math.floor(contextTokens * 0.5)) : Math.min(16384, Math.max(2048, Math.floor(contextTokens * 0.25)));
  return { answer, input: contextTokens - answer };
}

/** Context window to ask for: what the call needs, in steps, so the server reuses its allocation. */
function windowFor(needed: number, max: number): number {
  return Math.min(max, Math.max(8192, Math.ceil(needed / 8192) * 8192));
}

/** Split transcript lines into consecutive parts of at most `budget` tokens each. */
export function chunkTranscript(lines: string[], budget: number): string[][] {
  const pieces: string[] = [];
  for (const line of lines) {
    if (estimateTokens(line) <= budget) {
      pieces.push(line);
      continue;
    }
    // One speaker turn longer than a whole part: split it, repeating its "[time] Name:" label.
    const label = line.match(/^\[[^\]]+\] (?:[^:]{1,80}: )?/)?.[0] ?? "";
    let cur = "";
    for (const ch of line.slice(label.length)) {
      if (estimateTokens(label + cur + ch) > budget * 0.9) {
        pieces.push(label + cur);
        cur = "";
      }
      cur += ch;
    }
    if (cur) pieces.push(label + cur);
  }
  const chunks: string[][] = [];
  let cur: string[] = [];
  let used = 0;
  for (const p of pieces) {
    const t = estimateTokens(p) + 1;
    if (cur.length && used + t > budget) {
      chunks.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(p);
    used += t;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** The answer without a reasoning model's thinking, or a code fence around the whole document. */
export function cleanModelOutput(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  // The opening tag was part of the prompt (some chat templates): drop what precedes the close.
  const close = out.lastIndexOf("</think>");
  if (close >= 0) out = out.slice(close + "</think>".length);
  out = out.trim();
  const fenced = out.match(/^```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```$/i);
  if (fenced) out = fenced[1]!.trim();
  return out;
}

function timeOf(line: string | undefined): string {
  return line?.match(/^\[([^\]]+)\]/)?.[1] ?? "?";
}

const NOTES_TASK = (part: number, of: number, from: string, to: string) => `The transcript of this meeting is too long to read at once, so it is read in parts. This is part ${part} of ${of}, from [${from}] to [${to}].

Write detailed working notes on this part only. They will be combined with the notes on the other parts to write the final document, which must follow the instructions below, so keep everything those instructions need:
- each topic discussed, in order, with its key points and who made them;
- every decision, number, date, name and commitment (owner, task, due date), each followed by the [hh:mm:ss] timestamp of the transcript line that states it;
- disagreements, conflicting statements and open questions.
Use the speaker names exactly as the transcript writes them. Write notes, not the final document: no title, introduction or conclusion, and nothing about parts you have not seen.`;

const CONDENSE_TASK = `Below are working notes taken from consecutive parts of one long meeting, in order. Merge them into a single, shorter set of working notes for the final document described by the instructions. Keep every decision, number, date, name and commitment with its [hh:mm:ss] timestamp, and keep the order of topics; drop only repetition. Write notes, not the final document.`;

export interface LocalSummaryOptions {
  signal?: AbortSignal;
  /** Seconds the model stays loaded after the last call (Ollama). */
  keepAliveSec: number;
  /** Called as parts are read, for logs. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Models found to think although asked not to (some hosted models ignore every
 * switch), by server and name. They get the thinking budget from then on.
 */
const thinksAnyway = new Set<string>();
const modelKey = (s: LocalModelSettings) => `${s.api} ${s.baseUrl} ${s.model}`;

/** The answer budget went to thinking that was not asked for: worth one more try with the thinking budget. */
class ThinksAnyway extends Error {}

export async function summarizeLocally(p: SummaryPromptParts, s: LocalModelSettings, opts: LocalSummaryOptions): Promise<LocalSummaryResult> {
  const key = modelKey(s);
  try {
    return await summarizeWith(p, s, opts, s.think || thinksAnyway.has(key));
  } catch (e) {
    if (!(e instanceof ThinksAnyway)) throw e;
    thinksAnyway.add(key);
    console.warn(`[summarizer] ${s.model} thinks although thinking is off; giving it the thinking budget from now on`);
    return summarizeWith(p, s, opts, true);
  }
}

async function summarizeWith(p: SummaryPromptParts, s: LocalModelSettings, opts: LocalSummaryOptions, thinkingBudget: boolean): Promise<LocalSummaryResult> {
  const info = await modelInfo(s);
  // The model's own limit wins over the configured window.
  const ctx = Math.min(s.contextTokens, info.contextLength ?? Number.POSITIVE_INFINITY);
  const { answer, input } = contextBudget(ctx, thinkingBudget);
  const sendThink = info.thinking === true || (info.thinking === null && s.think);

  let promptTokens = 0;
  let outputTokens = 0;
  let calls = 0;
  let model = s.model;
  // Between the calls of one summary the model stays loaded; after the last, as configured.
  const call = async (messages: ChatMessage[], last: boolean): Promise<ChatResult> => {
    const needed = messages.reduce((n, m) => n + estimateTokens(m.content), 16) + answer;
    const r = await chat(s, messages, {
      signal: opts.signal,
      numCtx: windowFor(needed, ctx),
      maxTokens: answer,
      keepAliveSec: last ? opts.keepAliveSec : Math.max(opts.keepAliveSec, 120),
      sendThink,
    });
    calls++;
    promptTokens += r.promptTokens ?? 0;
    outputTokens += r.outputTokens ?? 0;
    model = r.model || model;
    // Cut off while (mostly) thinking: the notes or the summary would be missing.
    if (r.truncated && (r.stoppedInReasoning || r.reasoningChars > r.text.length)) {
      if (!thinkingBudget) throw new ThinksAnyway();
      const limit = `${answer.toLocaleString("en-US")} tokens`;
      throw new LlmError(
        s.think
          ? `The model used its whole answer budget (${limit}) mostly on thinking, before finishing. Turn thinking off in Admin → Summary model, or raise the context window (the answer gets half of it).`
          : `The model (${model}) thinks even with thinking off, and used up even the larger answer budget (${limit}) doing so. Raise the context window in Admin → Summary model (the answer gets half of it for this model), or choose a model that can answer without thinking.`,
      );
    }
    return r;
  };
  const sys: ChatMessage = { role: "system", content: p.system };
  const transcript = p.transcript.join("\n");

  const single = `${p.instructions}\n\n${p.metadata}\n\n<transcript>\n${transcript}\n</transcript>`;
  let finalUser: string;
  if (estimateTokens(p.system) + estimateTokens(single) + 16 <= input) {
    finalUser = single;
  } else {
    const overhead = estimateTokens(p.system) + estimateTokens(NOTES_TASK(99, 99, "00:00:00", "00:00:00")) + estimateTokens(p.instructions) + estimateTokens(p.metadata) + 64;
    const partBudget = input - overhead;
    if (partBudget < 1024) {
      throw new LlmError(
        `The context window (${ctx.toLocaleString("en-US")} tokens) is too small for this prompt. Raise it in Admin → Summary model, or shorten the prompt.`,
      );
    }
    const chunks = chunkTranscript(p.transcript, partBudget);
    let notes: string[] = [];
    for (const [i, lines] of chunks.entries()) {
      const head = NOTES_TASK(i + 1, chunks.length, timeOf(lines[0]), timeOf(lines[lines.length - 1]));
      const r = await call(
        [sys, { role: "user", content: `${head}\n\n${p.instructions}\n\n${p.metadata}\n\n<transcript_part>\n${lines.join("\n")}\n</transcript_part>` }],
        false,
      );
      const text = cleanModelOutput(r.text);
      notes.push(`### Part ${i + 1} of ${chunks.length} ([${timeOf(lines[0])}]–[${timeOf(lines[lines.length - 1])}])\n\n${text}`);
      opts.onProgress?.(i + 1, chunks.length);
    }

    const wrap = (n: string[]) =>
      `${p.instructions}\n\n${p.metadata}\n\n<notes>\nThe transcript was too long to read at once. These are detailed notes taken from its consecutive parts, in order, with the timestamps of the original transcript lines. Treat them as the transcript, and cite their timestamps.\n\n${n.join("\n\n")}\n</notes>`;
    // Notes on a very long meeting may themselves be too long: merge neighbours until they fit.
    const tooLong = () =>
      new LlmError(
        `This meeting is too long for a ${ctx.toLocaleString("en-US")}-token context window, even read in parts. Raise the context window in Admin → Summary model.`,
      );
    for (let round = 0; estimateTokens(p.system) + estimateTokens(wrap(notes)) + 16 > input; round++) {
      if (round >= 3) throw tooLong();
      // Neighbouring notes that fit in one call together.
      const groups: string[][] = [];
      for (const n of notes) {
        const last = groups[groups.length - 1];
        if (last && estimateTokens([...last, n].join("\n\n")) <= partBudget) last.push(n);
        else groups.push([n]);
      }
      // Each part's notes alone fill a window: merging cannot shorten them.
      if (groups.every((g) => g.length === 1)) throw tooLong();
      const merged: string[] = [];
      for (const g of groups) {
        if (g.length === 1) {
          merged.push(g[0]!);
          continue;
        }
        const r = await call([sys, { role: "user", content: `${CONDENSE_TASK}\n\n${p.instructions}\n\n<notes>\n${g.join("\n\n")}\n</notes>` }], false);
        merged.push(cleanModelOutput(r.text));
      }
      notes = merged;
    }
    finalUser = wrap(notes);
  }

  const r = await call([sys, { role: "user", content: finalUser }], true);
  const text = cleanModelOutput(r.text);
  if (r.truncated) {
    throw new LlmError(
      `The model stopped before finishing: the summary reached its length limit (${answer.toLocaleString("en-US")} tokens), which usually means it started repeating itself. Try again, or raise the context window in Admin → Summary model (the answer gets ${thinkingBudget ? "half" : "a quarter"} of it).`,
    );
  }
  if (!text) throw new LlmError("The local model returned an empty answer.");
  const usage: Record<string, number> = {};
  if (promptTokens) usage.input_tokens = promptTokens;
  if (outputTokens) usage.output_tokens = outputTokens;
  if (calls > 1) usage.calls = calls;
  return { text, model, usage: Object.keys(usage).length ? usage : null };
}
