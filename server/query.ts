import type { PrRow } from "./db.ts";

export interface ParsedQuery {
  terms: string[];
  qualifiers: {
    author: string[];
    state: string[];
    is: string[];
    repo: string[];
    base: string[];
    review: string[];
  };
}

const STATE_VALUES = new Set(["open", "closed", "merged"]);
const IS_VALUES = new Set(["archived", "draft"]);
const REVIEW_VALUES = new Set(["approved", "required", "changes_requested"]);

export function parseQuery(q: string): ParsedQuery {
  const parsed: ParsedQuery = {
    terms: [],
    qualifiers: { author: [], state: [], is: [], repo: [], base: [], review: [] },
  };
  for (const token of q.trim().split(/\s+/).filter(Boolean)) {
    const match = token.match(/^([a-zA-Z]+):(.+)$/);
    const key = match?.[1]?.toLowerCase();
    const value = (match?.[2] ?? "").toLowerCase();
    switch (key) {
      case "author":
        parsed.qualifiers.author.push(value);
        continue;
      case "repo":
        parsed.qualifiers.repo.push(value);
        continue;
      case "base":
        parsed.qualifiers.base.push(value);
        continue;
      case "state":
        if (STATE_VALUES.has(value)) {
          parsed.qualifiers.state.push(value);
          continue;
        }
        break;
      case "is":
        if (IS_VALUES.has(value)) {
          parsed.qualifiers.is.push(value);
          continue;
        }
        break;
      case "review":
        if (REVIEW_VALUES.has(value)) {
          parsed.qualifiers.review.push(value);
          continue;
        }
        break;
    }
    parsed.terms.push(token.toLowerCase());
  }
  return parsed;
}

function effectiveState(pr: PrRow): string {
  return pr.state === "draft" ? "open" : pr.state.toLowerCase();
}

function matchesReview(value: string, pr: PrRow): boolean {
  switch (value) {
    case "approved":
      return pr.review_decision === "APPROVED";
    case "required":
      return pr.review_decision === "REVIEW_REQUIRED";
    case "changes_requested":
      return pr.review_decision === "CHANGES_REQUESTED";
    default:
      return false;
  }
}

function matchesIs(value: string, pr: PrRow, isArchived: boolean): boolean {
  if (value === "draft") return pr.is_draft === 1;
  return isArchived;
}

function matchesTerm(term: string, pr: PrRow): boolean {
  return (
    pr.title.toLowerCase().includes(term) ||
    pr.repo.toLowerCase().includes(term) ||
    String(pr.number).includes(term.replace(/^#/, "")) ||
    pr.head_ref.toLowerCase().includes(term) ||
    pr.base_ref.toLowerCase().includes(term)
  );
}

// an explicit state: set that excludes open can only match closed/merged history (evictStalePrs drops those from live)
export function wantsHistoricalPrs(parsed: ParsedQuery): boolean {
  return parsed.qualifiers.state.length > 0 && parsed.qualifiers.state.every((v) => v !== "open");
}

export function matchesQuery(pr: PrRow, parsed: ParsedQuery, isArchived: boolean): boolean {
  const { qualifiers } = parsed;
  if (qualifiers.author.some((v) => pr.author.toLowerCase() !== v)) return false;
  if (qualifiers.repo.some((v) => pr.repo.toLowerCase() !== v)) return false;
  if (qualifiers.base.some((v) => pr.base_ref.toLowerCase() !== v)) return false;
  if (qualifiers.state.some((v) => effectiveState(pr) !== v)) return false;
  if (qualifiers.review.some((v) => !matchesReview(v, pr))) return false;
  if (qualifiers.is.some((v) => !matchesIs(v, pr, isArchived))) return false;
  return parsed.terms.every((t) => matchesTerm(t, pr));
}
