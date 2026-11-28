/** Terms as typed (commas, 、, semicolons or new lines between them), trimmed, repeats dropped. */
export function splitTerms(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,，、;；\n]+/)) {
    const term = part.trim().replace(/\s+/g, " ");
    if (!term || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    out.push(term);
  }
  return out;
}

const has = (list: string[], term: string) => list.some((x) => x.toLowerCase() === term.toLowerCase());

/** Whether every one of `terms` is already in the vocabulary. */
export function containsAll(vocabulary: string, terms: string[]): boolean {
  const current = splitTerms(vocabulary);
  return terms.length > 0 && terms.every((t) => has(current, t));
}

/** The vocabulary with `terms` added (those not there yet), written as the field writes it. */
export function addTerms(vocabulary: string, terms: string[]): string {
  const current = splitTerms(vocabulary);
  for (const t of terms) if (!has(current, t)) current.push(t);
  return current.join(", ");
}

/** The vocabulary without `terms`. */
export function removeTerms(vocabulary: string, terms: string[]): string {
  return splitTerms(vocabulary)
    .filter((t) => !has(terms, t))
    .join(", ");
}
