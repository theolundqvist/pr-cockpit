import type { PrRow } from "./db.ts";

// The fields a filter reads. The inbox UI maps its camelCase rows onto the same shape.
export type QueryTarget = Pick<PrRow, "author" | "repo" | "title" | "number" | "state" | "is_draft" | "base_ref" | "head_ref" | "review_decision"> & {
  readonly labels: readonly string[];
};

export interface QueryContext {
  archived: boolean;
  // Resolves `author:@me`; while unknown, `@me` matches nobody.
  viewer?: string | null;
}

type ClauseKey = "text" | "author" | "repo" | "base" | "head" | "state" | "draft" | "archived" | "review" | "label" | "no-label";

export interface QueryClause {
  key: ClauseKey;
  // Alternatives, any of which satisfies the clause: `label:a,b` matches either label.
  values: string[];
  negated: boolean;
}

export interface ParsedQuery {
  clauses: QueryClause[];
}

const STATES = ["open", "closed", "merged"];
const REVIEW_VALUES = new Set(["approved", "required", "changes_requested", "none"]);
const VALUE_KEYS = new Set(["author", "repo", "base", "head", "state", "is", "draft", "review", "label", "no"]);
// An optional `-`, an optional `key:`, then a "quoted phrase" (closing quote optional while typing) or a word.
const TOKEN = /(-?)(?:([A-Za-z][\w-]*):)?(?:"([^"]*)"?|(\S*))/g;

// GitHub search syntax: qualifiers and words AND together, `-` negates any of them, and quotes keep a phrase whole.
export function parseQuery(q: string): ParsedQuery {
  const clauses: QueryClause[] = [];
  for (const match of q.matchAll(TOKEN)) {
    if (!match[0]) continue;
    const negated = match[1] === "-";
    const key = match[2]?.toLowerCase() ?? null;
    const value = (match[3] ?? match[4] ?? "").toLowerCase();
    const clause = toClause(key, value, negated);
    if (clause) clauses.push(clause);
  }
  return { clauses };
}

function toClause(key: string | null, value: string, negated: boolean): QueryClause | null {
  // A qualifier still being typed (`label:`) or a lone `-` filters nothing yet.
  if (!value && (key === null || VALUE_KEYS.has(key))) return null;
  const clause = (k: ClauseKey, values = [value]): QueryClause => ({ key: k, values, negated });
  switch (key) {
    case "author":
      return clause("author", [value.replace(/^app\//, "")]);
    case "repo":
    case "base":
    case "head":
      return clause(key);
    case "label": {
      const labels = value.split(",").map((label) => label.trim()).filter(Boolean);
      return labels.length ? clause("label", labels) : null;
    }
    case "state":
      if (STATES.includes(value)) return clause("state");
      break;
    case "draft":
      if (value === "true" || value === "false") return { key: "draft", values: ["true"], negated: negated !== (value === "false") };
      break;
    case "review":
      if (REVIEW_VALUES.has(value)) return clause("review");
      break;
    case "no":
      if (value === "label") return clause("no-label");
      break;
    case "is":
      if (STATES.includes(value)) return clause("state");
      if (value === "draft") return clause("draft", ["true"]);
      if (value === "archived") return clause("archived");
      // Every row is a pull request.
      if (value === "pr" || value === "pull-request") return null;
      // Any other `is:` value names a label, so `is:agent-owned` reads like `label:agent-owned`.
      return clause("label");
  }
  return clause("text", [key === null ? value : `${key}:${value}`]);
}

function effectiveState(pr: QueryTarget): string {
  return pr.state === "draft" ? "open" : pr.state.toLowerCase();
}

function matchesReview(value: string, pr: QueryTarget): boolean {
  switch (value) {
    case "approved":
      return pr.review_decision === "APPROVED";
    case "required":
      return pr.review_decision === "REVIEW_REQUIRED";
    case "changes_requested":
      return pr.review_decision === "CHANGES_REQUESTED";
    default:
      return !pr.review_decision;
  }
}

function matchesText(text: string, pr: QueryTarget): boolean {
  return (
    pr.title.toLowerCase().includes(text) ||
    pr.repo.toLowerCase().includes(text) ||
    String(pr.number).includes(text.replace(/^#/, "")) ||
    pr.head_ref.toLowerCase().includes(text) ||
    pr.base_ref.toLowerCase().includes(text) ||
    pr.labels.some((label) => label.toLowerCase().includes(text))
  );
}

function matchesValue(clause: QueryClause, value: string, pr: QueryTarget, context: QueryContext): boolean {
  switch (clause.key) {
    case "text":
      return matchesText(value, pr);
    case "author":
      return pr.author.toLowerCase() === (value === "@me" ? context.viewer?.toLowerCase() : value);
    case "repo": {
      const repo = pr.repo.toLowerCase();
      return repo === value || repo.slice(repo.indexOf("/") + 1) === value;
    }
    case "base":
      return pr.base_ref.toLowerCase() === value;
    case "head":
      return pr.head_ref.toLowerCase() === value;
    case "state":
      return effectiveState(pr) === value;
    case "draft":
      return pr.is_draft === 1;
    case "archived":
      return context.archived;
    case "review":
      return matchesReview(value, pr);
    case "label":
      return pr.labels.some((label) => label.toLowerCase() === value);
    case "no-label":
      return pr.labels.length === 0;
  }
}

export function matchesQuery(pr: QueryTarget, parsed: ParsedQuery, context: QueryContext): boolean {
  return parsed.clauses.every((clause) => clause.values.some((value) => matchesValue(clause, value, pr, context)) !== clause.negated);
}

// A state filter that rules out open PRs can only match closed/merged history (evictStalePrs drops those from live).
export function wantsHistoricalPrs(parsed: ParsedQuery): boolean {
  const states = STATES.filter((state) => parsed.clauses.every((c) => c.key !== "state" || c.values.includes(state) !== c.negated));
  return states.length < STATES.length && !states.includes("open");
}

// Whether the query itself says which drafts to show, overriding a hide-drafts toggle.
export function constrainsDrafts(parsed: ParsedQuery): boolean {
  return parsed.clauses.some((clause) => clause.key === "draft");
}
