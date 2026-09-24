export type GroupingMode = "status" | "manual" | "feature" | "type";
export type PrGrouping = { mode: GroupingMode; groups: { id: string; name: string; keywords: string }[] };

export function normalizePrGrouping(value: unknown): PrGrouping {
  const raw = value as Partial<PrGrouping> | null;
  const mode = raw && ["manual", "feature", "type"].includes(raw.mode ?? "") ? raw.mode! : "status";
  const seen = new Set<string>();
  const groups = Array.isArray(raw?.groups) ? raw.groups.slice(0, 50).flatMap((group) => {
    if (!group || typeof group.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(group.id)
      || seen.has(group.id) || typeof group.name !== "string" || !group.name.trim()) return [];
    seen.add(group.id);
    return [{ id: group.id, name: group.name.trim().slice(0, 80), keywords: typeof group.keywords === "string" ? group.keywords.slice(0, 1000) : "" }];
  }) : [
    { id: "settings", name: "Settings", keywords: "settings, preferences" },
    { id: "billing", name: "Billing", keywords: "billing, payment, subscription" },
    { id: "inbox", name: "Inbox", keywords: "inbox, queue" },
  ];
  return { mode, groups };
}

export const PR_TYPES = ["feat", "fix", "refactor", "perf", "docs", "test", "build", "ci", "chore", "style", "revert"];
export const TYPE_TITLES = { feat: "Features", fix: "Fixes", refactor: "Refactoring", perf: "Performance", docs: "Documentation", test: "Tests", build: "Build", ci: "CI", chore: "Chores", style: "Style", revert: "Reverts" };

const words = (text: string) => text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "";
export function categoryForPr(title: string, config: PrGrouping, assignment?: string): string {
  if (config.mode === "manual") return config.groups.some((group) => group.id === assignment) ? `group:${assignment}` : "other";
  const conventional = title.match(/^([a-z]+)(?:\(([^)]+)\))?!?:\s*/i);
  if (config.mode === "type") {
    const type = conventional?.[1]?.toLowerCase();
    return type && PR_TYPES.includes(type) ? `type:${type}` : "other";
  }
  // Prefer an explicit scope to incidental title words. First configured match wins.
  for (const source of [conventional?.[2] ?? "", title]) {
    const text = ` ${words(source)} `;
    const match = config.groups.find((group) => [group.name, ...group.keywords.split(",")].some((term) => {
      const normalized = words(term);
      return normalized && text.includes(` ${normalized} `);
    }));
    if (match) return `group:${match.id}`;
  }
  return "other";
}
