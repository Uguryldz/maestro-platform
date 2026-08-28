/** Knowledge refs are one file per line (or comma-separated), trimmed and deduped. */
export function parseKnowledge(raw: string): string[] {
  const seen = new Set<string>();
  for (const token of raw.split(/[\n,]/)) {
    const trimmed = token.trim();
    if (trimmed !== "") seen.add(trimmed);
  }
  return [...seen];
}
