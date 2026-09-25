import { db, now } from "../db";
import type { TemplateRow } from "../types";

const SHARED_RULES = `Rules:
- Base everything strictly on the transcript. Never invent names, numbers, dates or commitments.
- Speaker labels such as "Speaker 1" are automatic. Use the given speaker names; only substitute a real name when the transcript makes it unambiguous.
- The transcript comes from automatic speech recognition and can contain mis-recognised words. When the intended term is obvious from context (product names, jargon, acronyms), use the correct term; otherwise keep the original wording.
- Cite the timestamp, as [hh:mm:ss], for every decision, date, number and commitment, so readers can check it against the recording.
- If people said conflicting things (different dates, owners or figures), do not choose one. State both with their timestamps and list the conflict as an open question.
- Skip small talk, filler and repetition.`;

interface BuiltinTemplate {
  id: string;
  name: string;
  description: string;
  body: string;
}

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    id: "builtin-minutes",
    name: "Meeting minutes",
    description: "Formal minutes: summary, discussion by topic, decisions, action items and open questions.",
    body: `Produce formal meeting minutes from the transcript.

Use this structure:

# <A concise, specific title for the meeting>
One line with date, duration and participants (from the metadata).

## Summary
Three to five sentences on the purpose of the meeting and its most important outcomes.

## Discussion
One subsection per topic, in the order discussed. For each topic give the key points, who raised which argument, and the conclusion reached. Use bullets and keep them factual.

## Decisions
A numbered list of decisions that were explicitly agreed. If there were none, write "None recorded."

## Action items
A table with the columns Owner | Task | Due | Notes. Only include commitments that were actually made. Use "-" where an owner or due date was not stated.

## Open questions and risks
Bullets for unresolved issues, blockers and follow-ups.

${SHARED_RULES}`,
  },
  {
    id: "builtin-actions",
    name: "Action items",
    description: "Only the commitments: who does what by when, grouped by owner.",
    body: `Extract every action item, commitment and follow-up from the transcript.

Group them by owner with a "## <Owner>" heading per person (use "Unassigned" when nobody took ownership). Under each owner, write a checklist:
- [ ] <Task, phrased as a verb-first instruction> (due: <date or "-">) [hh:mm:ss]

The timestamp is where the commitment was made in the transcript.

After the checklist, add a short "## Dependencies" section only if some tasks block others.

${SHARED_RULES}`,
  },
  {
    id: "builtin-brief",
    name: "Executive brief",
    description: "A short read for people who missed the meeting: TL;DR, decisions, risks, asks.",
    body: `Write an executive brief for a busy stakeholder who did not attend. Keep it under 250 words.

## TL;DR
At most five bullets with the outcomes that matter.

## Decisions
Bullets, or "None."

## Risks and concerns
Bullets, or "None raised."

## Asks
What the team needs from leadership or other teams, or "None."

Prefer concrete facts (numbers, dates, names) over general statements.

${SHARED_RULES}`,
  },
  {
    id: "builtin-detailed",
    name: "Detailed notes",
    description: "Thorough topic-by-topic notes with timestamps and notable quotes.",
    body: `Write detailed notes that let someone reconstruct the whole discussion without listening to the recording.

For each topic, in chronological order:
### [hh:mm:ss] <Topic title>
- The substance of the discussion, attributed to speakers ("Alice: ...").
- Data, figures and examples that were mentioned.
- Notable direct quotes in quotation marks, when they capture a position well.
- **Outcome:** what was concluded, or "No conclusion."

Finish with "## Follow-ups", a bullet list of next steps.

${SHARED_RULES}`,
  },
  {
    id: "builtin-decisions",
    name: "Decision log",
    description: "Each decision with its context, options considered, rationale and owner.",
    body: `Build a decision log from the transcript. For every decision that was made (or explicitly deferred), write:

### D<n>. <Decision in one sentence>
- **When:** [hh:mm:ss]
- **Context:** why the decision was needed.
- **Options considered:** the alternatives discussed, with their pros and cons as stated.
- **Rationale:** why this option was chosen.
- **Owner:** who is accountable for carrying it out.
- **Status:** Decided / Deferred / Needs approval.

If no decisions were made, say so and list the questions that are still waiting for a decision.

${SHARED_RULES}`,
  },
  {
    id: "builtin-lecture",
    name: "Lecture / study notes",
    description: "For talks, trainings and lectures: concepts, definitions, examples and review questions.",
    body: `Turn this talk or lecture into study notes.

## Overview
Two or three sentences on what the session covered.

## Key concepts
For each concept: a clear definition, how it was explained, and any examples, formulas or code mentioned.

## Q&A
Questions from the audience and the answers given.

## Review questions
Five questions, with short answers, that test understanding of the material.

${SHARED_RULES}`,
  },
];

/** Insert or refresh built-in templates. Idempotent; runs on every start. */
export function seedBuiltinTemplates() {
  const t = now();
  const upsert = db.query(
    `INSERT INTO templates (id, owner_id, builtin, name, description, body, sort, created_at, updated_at)
     VALUES ($id, NULL, 1, $name, $description, $body, $sort, $t, $t)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
       body = excluded.body, sort = excluded.sort, updated_at = excluded.updated_at
     WHERE templates.body != excluded.body OR templates.name != excluded.name
       OR templates.description != excluded.description OR templates.sort != excluded.sort`,
  );
  db.transaction(() => {
    BUILTIN_TEMPLATES.forEach((tpl, i) => upsert.run({ ...tpl, sort: i, t }));
    const ids = BUILTIN_TEMPLATES.map((b) => b.id);
    const placeholders = ids.map((_, i) => `$p${i}`).join(",");
    const params = Object.fromEntries(ids.map((id, i) => [`p${i}`, id]));
    db.query(`DELETE FROM templates WHERE builtin = 1 AND id NOT IN (${placeholders})`).run(params);
  })();
}

export function listTemplatesFor(userId: string): TemplateRow[] {
  return db
    .query<TemplateRow, { u: string }>(
      "SELECT * FROM templates WHERE builtin = 1 OR owner_id = $u ORDER BY builtin DESC, sort ASC, updated_at DESC",
    )
    .all({ u: userId });
}

export function getTemplateFor(userId: string, id: string): TemplateRow | null {
  return db
    .query<TemplateRow, { u: string; id: string }>(
      "SELECT * FROM templates WHERE id = $id AND (builtin = 1 OR owner_id = $u)",
    )
    .get({ u: userId, id });
}

export function publicTemplate(t: TemplateRow) {
  return {
    id: t.id,
    builtin: !!t.builtin,
    name: t.name,
    description: t.description,
    body: t.body,
    updatedAt: t.updated_at,
  };
}
