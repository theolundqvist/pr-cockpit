export type CaseFold = "unicode" | "ascii";

export const SNIPPET_CHARS = 400;
const SNIPPET_LEAD = 80;
const ELLIPSIS = "…";

export function caseSensitive(query: string): boolean {
  return /[A-Z]/.test(query);
}

export function foldedLiteral(query: string, fold: CaseFold): RegExp {
  const escaped = query.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
  if (fold === "unicode") return new RegExp(escaped, "giu");
  return new RegExp(escaped.replace(/[A-Za-z]/g, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`), "gu");
}

export function firstMatch(text: string, query: string, fold: CaseFold): { start: number; end: number } | null {
  const sensitive = caseSensitive(query);
  let first: { start: number; end: number } | null = null;
  for (const pattern of query.split("\n")) {
    const match = sensitive ? null : foldedLiteral(pattern, fold).exec(text);
    const start = sensitive ? text.indexOf(pattern) : (match?.index ?? -1);
    if (start >= 0 && (!first || start < first.start)) {
      first = { start, end: start + (sensitive ? pattern.length : match![0].length) };
    }
  }
  return first;
}

export function snippet(
  text: string,
  match: { start: number; end: number } | null,
  clippedLeft = false,
  clippedRight = false,
): string {
  let from = 0;
  let to = text.length;
  if (text.length > SNIPPET_CHARS) {
    const start = match?.start ?? 0;
    const end = match?.end ?? 0;
    from = Math.max(0, Math.min(start - SNIPPET_LEAD, text.length - SNIPPET_CHARS));
    to = Math.max(Math.min(text.length, from + SNIPPET_CHARS), end);
    const first = text.charCodeAt(from);
    const last = text.charCodeAt(to - 1);
    if (from > 0 && from < start && first >= 0xdc00 && first <= 0xdfff) from++;
    if (to < text.length && to > end && last >= 0xd800 && last <= 0xdbff) to--;
  }
  const left = from > 0 || clippedLeft ? ELLIPSIS : "";
  const right = to < text.length || clippedRight ? ELLIPSIS : "";
  return `${left}${text.slice(from, to)}${right}`;
}

// Git treats newlines as OR patterns; the byte scan handles one literal only.
export function snapshotCanAnswer(query: string): boolean {
  if (query.includes("\n") || query.includes("\0")) return false;
  return caseSensitive(query) || !/[^\x00-\x7f]/.test(query);
}
