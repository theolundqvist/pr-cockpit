export type GroupingMode = "status" | "manual" | "feature" | "type";
export type PrGrouping = { mode: GroupingMode; groups: { id: string; name: string }[] };

export function normalizePrGrouping(value: unknown): PrGrouping {
  const raw = value as Partial<PrGrouping> | null;
  const mode = raw && ["manual", "feature", "type"].includes(raw.mode ?? "") ? raw.mode! : "status";
  const seen = new Set<string>();
  const groups = Array.isArray(raw?.groups) ? raw.groups.slice(0, 50).flatMap((group) => {
    if (!group || typeof group.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(group.id)
      || seen.has(group.id) || typeof group.name !== "string" || !group.name.trim()) return [];
    seen.add(group.id);
    return [{ id: group.id, name: group.name.trim().slice(0, 80) }];
  }) : [
    { id: "settings", name: "Settings" },
    { id: "billing", name: "Billing" },
    { id: "inbox", name: "Inbox" },
  ];
  return { mode, groups };
}

export const PR_TYPES = ["feat", "fix", "refactor", "perf", "docs", "test", "build", "ci", "chore", "style", "revert"];
export const TYPE_TITLES = { feat: "Features", fix: "Fixes", refactor: "Refactoring", perf: "Performance", docs: "Documentation", test: "Tests", build: "Build", ci: "CI", chore: "Chores", style: "Style", revert: "Reverts" };

// The PR title contract shared with title linting: `DRAFT ` marks work that is not ready for review yet.
const TITLE_RE = /^(DRAFT )?(?<type>[a-z]+)(\((?<scope>[^)]+)\))?(?<breaking>!)?: (?<summary>.+)$/;
export const DRAFT_PREFIX = "DRAFT ";

export type PrTitle = { draft: boolean; type: string | null; scope: string | null; breaking: boolean; summary: string };

export function parsePrTitle(title: string): PrTitle {
  const draft = title.startsWith(DRAFT_PREFIX);
  const groups = TITLE_RE.exec(title)?.groups;
  if (!groups) return { draft, type: null, scope: null, breaking: false, summary: draft ? title.slice(DRAFT_PREFIX.length) : title };
  return { draft, type: groups.type!, scope: groups.scope?.trim().toLowerCase() || null, breaking: groups.breaking === "!", summary: groups.summary! };
}

export function isDraftPr(pr: { title: string; isDraft?: boolean }): boolean {
  return pr.isDraft === true || pr.title.startsWith(DRAFT_PREFIX);
}

const TYPE_ORDER = ["feat", "fix", "perf", "refactor", "test", "ci", "build", "docs", "chore"];

function typeRank(type: string | null): number {
  const index = TYPE_ORDER.indexOf(type ?? "");
  return index < 0 ? TYPE_ORDER.length : index;
}

// Drafts sink to the bottom; with `statusRank`, status then type order each partition. The sort is
// stable, so rows that tie keep their incoming order.
export function orderQueueUnits<T extends { title: string; isDraft?: boolean }>(units: T[], statusRank?: (unit: T) => number): T[] {
  return units
    .map((unit) => ({
      unit,
      draft: isDraftPr(unit) ? 1 : 0,
      status: statusRank ? statusRank(unit) : 0,
      type: statusRank ? typeRank(parsePrTitle(unit.title).type) : 0,
    }))
    .sort((a, b) => a.draft - b.draft || a.status - b.status || a.type - b.type)
    .map(({ unit }) => unit);
}

// Feature groups key on the lowercased title scope; titles without one fall into "other".
export function categoryForPr(title: string, config: PrGrouping, assignment?: string): string {
  if (config.mode === "manual") return config.groups.some((group) => group.id === assignment) ? `group:${assignment}` : "other";
  const parsed = parsePrTitle(title);
  if (config.mode === "type") return parsed.type && PR_TYPES.includes(parsed.type) ? `type:${parsed.type}` : "other";
  return parsed.scope && parsed.scope !== "other" ? `feature:${parsed.scope}` : "other";
}

// Rewrites only the part of the title that places it in `category`, keeping the draft prefix, `!`,
// summary, and any untouched scope as written. Returns null when the title cannot join that group.
export function retitleForCategory(title: string, mode: GroupingMode, category: string): string | null {
  const parsed = parsePrTitle(title);
  const parts = TITLE_RE.exec(title)?.groups;
  const draft = parsed.draft ? DRAFT_PREFIX : "";
  const build = (type: string, scope: string | undefined) => `${draft}${type}${scope === undefined ? "" : `(${scope})`}${parsed.breaking ? "!" : ""}: ${parsed.summary}`;
  if (mode === "type") {
    const type = category.startsWith("type:") ? category.slice("type:".length) : "";
    if (!PR_TYPES.includes(type)) return null;
    if (parsed.type === type) return title;
    return build(type, parts?.scope);
  }
  if (mode !== "feature") return null;
  if (category === "other") return parsed.scope ? build(parsed.type!, undefined) : title;
  if (!parsed.type) return null;
  const scope = category.startsWith("feature:") ? category.slice("feature:".length) : "";
  if (!scope || scope === "other") return null;
  return parsed.scope === scope ? title : build(parsed.type, scope);
}

export type GroupDropPlan = { approve?: boolean; pin?: boolean; title?: string; assignment?: string | null };

// A drop between inbox sections changes only what the destination stands for. Failed merges and
// computed status groups reflect state that a drag must never fake, so they accept and release nothing.
export function planGroupDrop(input: {
  from: string;
  to: string;
  title: string;
  mode: GroupingMode;
  pinned: boolean;
  approved: boolean;
  approvalEnabled: boolean;
}): GroupDropPlan | null {
  const { from, to } = input;
  if (from === to || from === "merge-failed" || to === "merge-failed") return null;
  if (to === "approved") return input.approvalEnabled && !input.approved ? { approve: true } : null;
  const leave: GroupDropPlan = input.approved ? { approve: false } : {};
  if (to === "pinned") return { ...leave, pin: true };
  if (input.pinned) leave.pin = false;
  if (input.mode === "manual") {
    if (to !== "other" && !to.startsWith("group:")) return null;
    return { ...leave, assignment: to === "other" ? null : to.slice("group:".length) };
  }
  if (input.mode === "status") return null;
  const title = retitleForCategory(input.title, input.mode, to);
  if (title === null) return null;
  if (title !== input.title) return { ...leave, title };
  return Object.keys(leave).length ? leave : null;
}
