import { expect, test } from "bun:test";
import { categoryForPr, normalizePrGrouping, orderQueueUnits, parsePrTitle, planGroupDrop, retitleForCategory } from "./prGrouping.ts";

test("feature groups come only from the title scope, ignoring keyword configuration", () => {
  const config = normalizePrGrouping({ mode: "feature", groups: [{ id: "billing", name: "Billing", keywords: "billing" }] });
  expect(categoryForPr("DRAFT feat( Billing )!: Add settings", config)).toBe("feature:billing");
  expect(categoryForPr("fix: Correct billing totals", config)).toBe("other");
  expect(categoryForPr("Fix billing", config)).toBe("other");
  expect(categoryForPr("chore(other): Tidy", config)).toBe("other");
});

test("types follow the title contract, including drafts and scoped breaking changes", () => {
  const config = normalizePrGrouping({ mode: "type" });
  expect(categoryForPr("feat(settings)!: Add shortcuts", config)).toBe("type:feat");
  expect(categoryForPr("DRAFT fix: Restore selection", config)).toBe("type:fix");
  expect(categoryForPr("FEAT(settings): Add shortcuts", config)).toBe("other");
  expect(categoryForPr("A fix for settings", config)).toBe("other");
  expect(categoryForPr("unknown: title", config)).toBe("other");
});

test("title contract parses draft prefix, type, scope, and breaking marker", () => {
  expect(parsePrTitle("DRAFT feat( Settings )!: Add shortcuts"))
    .toEqual({ draft: true, type: "feat", scope: "settings", breaking: true, summary: "Add shortcuts" });
  expect(parsePrTitle("fix: Restore selection"))
    .toEqual({ draft: false, type: "fix", scope: null, breaking: false, summary: "Restore selection" });
  // Only the exact uppercase prefix marks a draft; the rest must still match the contract.
  expect(parsePrTitle("Draft feat(x): y")).toMatchObject({ draft: false, type: null, scope: null });
  expect(parsePrTitle("DRAFT Rework everything")).toEqual({ draft: true, type: null, scope: null, breaking: false, summary: "Rework everything" });
  expect(parsePrTitle("feat(x):missing space")).toMatchObject({ type: null, scope: null });
});

test("queue order puts drafts last, then status, then type, keeping incoming order on ties", () => {
  const rows = [
    { title: "DRAFT feat(a): draft by title", status: 0 },
    { title: "chore(a): waiting chore", status: 2 },
    { title: "fix(a): ready fix", status: 0 },
    { title: "feat(a): github draft", isDraft: true, status: 0 },
    { title: "Untyped ready work", status: 0 },
    { title: "feat(a): ready feature", status: 0 },
    { title: "perf(a): your move perf", status: 1 },
    { title: "feat(a): second ready feature", status: 0 },
  ];
  expect(orderQueueUnits(rows, (row) => row.status).map((row) => row.title)).toEqual([
    "feat(a): ready feature",
    "feat(a): second ready feature",
    "fix(a): ready fix",
    "Untyped ready work",
    "perf(a): your move perf",
    "chore(a): waiting chore",
    "DRAFT feat(a): draft by title",
    "feat(a): github draft",
  ]);
  // Without a status ranking only drafts move; everything else keeps its incoming order.
  expect(orderQueueUnits(rows).map((row) => row.title)).toEqual([
    "chore(a): waiting chore",
    "fix(a): ready fix",
    "Untyped ready work",
    "feat(a): ready feature",
    "perf(a): your move perf",
    "feat(a): second ready feature",
    "DRAFT feat(a): draft by title",
    "feat(a): github draft",
  ]);
});

test("removed manual groups fall back without losing PRs", () => {
  const config = normalizePrGrouping({ mode: "manual" });
  expect(categoryForPr("Anything", config, "billing")).toBe("group:billing");
  expect(categoryForPr("Anything", { ...config, groups: [] }, "billing")).toBe("other");
});

test("missing and malformed configuration preserve the default mode", () => {
  expect(normalizePrGrouping(null).mode).toBe("status");
  expect(normalizePrGrouping({ mode: "unexpected" }).mode).toBe("status");
  // Stored keyword lists from the retired keyword grouping are dropped.
  expect(normalizePrGrouping({ groups: [null, { id: "one", name: " First ", keywords: "a, b" }, { id: "one", name: "Duplicate" }, { id: "bad/id", name: "Invalid" }] }).groups)
    .toEqual([{ id: "one", name: "First" }]);
});

test("type moves replace only the type, and supply one to titles without it", () => {
  expect(retitleForCategory("DRAFT feat( Billing )!: Add settings", "type", "type:fix")).toBe("DRAFT fix( Billing )!: Add settings");
  expect(retitleForCategory("unknown: title", "type", "type:docs")).toBe("docs: title");
  expect(retitleForCategory("DRAFT Rework everything", "type", "type:refactor")).toBe("DRAFT refactor: Rework everything");
  expect(retitleForCategory("FEAT(settings): Add", "type", "type:feat")).toBe("feat: FEAT(settings): Add");
  expect(retitleForCategory("fix(Settings): Keep casing", "type", "type:fix")).toBe("fix(Settings): Keep casing");
  // Other is where unrecognized titles land, not a type a title can be given.
  expect(retitleForCategory("fix: Anything", "type", "other")).toBeNull();
  expect(retitleForCategory("fix: Anything", "type", "type:unknown")).toBeNull();
});

test("feature moves replace only the scope and never invent a type", () => {
  expect(retitleForCategory("DRAFT feat!: Add settings", "feature", "feature:billing")).toBe("DRAFT feat(billing)!: Add settings");
  expect(retitleForCategory("fix( Settings )!: Keep", "feature", "feature:billing")).toBe("fix(billing)!: Keep");
  expect(retitleForCategory("fix(Settings): Keep casing", "feature", "feature:settings")).toBe("fix(Settings): Keep casing");
  expect(retitleForCategory("DRAFT fix(Settings)!: Leave", "feature", "other")).toBe("DRAFT fix!: Leave");
  expect(retitleForCategory("chore(other): Tidy", "feature", "other")).toBe("chore: Tidy");
  expect(retitleForCategory("Rework everything", "feature", "feature:billing")).toBeNull();
  expect(retitleForCategory("DRAFT Rework everything", "feature", "other")).toBe("DRAFT Rework everything");
});

test("every retitled drop lands in the group it was dropped on", () => {
  const titles = ["DRAFT feat( Billing )!: Add settings", "Rework everything", "unknown(x): y", "docs!: Explain"];
  for (const mode of ["type", "feature"] as const) {
    const config = normalizePrGrouping({ mode });
    const targets = mode === "type" ? ["type:fix", "type:docs"] : ["feature:billing", "feature:search", "other"];
    for (const title of titles) for (const target of targets) {
      const next = retitleForCategory(title, mode, target);
      if (next !== null) expect(categoryForPr(next, config)).toBe(target);
    }
  }
});

const base = { title: "feat(billing): Add totals", mode: "type" as const, pinned: false, approved: false, approvalEnabled: true };

test("drops never move a PR into or out of a failed merge, or between computed statuses", () => {
  expect(planGroupDrop({ ...base, from: "merge-failed", to: "pinned" })).toBeNull();
  expect(planGroupDrop({ ...base, from: "type:feat", to: "merge-failed" })).toBeNull();
  expect(planGroupDrop({ ...base, mode: "status", from: "pinned", to: "ready", pinned: true })).toBeNull();
  expect(planGroupDrop({ ...base, from: "type:feat", to: "other" })).toBeNull();
  expect(planGroupDrop({ ...base, from: "type:feat", to: "type:feat" })).toBeNull();
});

test("approval is granted only by its own section, only while the feature is on", () => {
  expect(planGroupDrop({ ...base, from: "pinned", to: "approved", pinned: true })).toEqual({ approve: true });
  expect(planGroupDrop({ ...base, from: "type:feat", to: "approved", approvalEnabled: false })).toBeNull();
  expect(planGroupDrop({ ...base, mode: "status", from: "ready", to: "approved" })).toEqual({ approve: true });
  expect(planGroupDrop({ ...base, from: "type:feat", to: "pinned" })).toEqual({ pin: true });
});

test("leaving approval or a pin clears it so the destination shows the PR", () => {
  expect(planGroupDrop({ ...base, from: "approved", to: "pinned", approved: true, pinned: true })).toEqual({ approve: false, pin: true });
  expect(planGroupDrop({ ...base, from: "approved", to: "type:fix", approved: true, pinned: true }))
    .toEqual({ approve: false, pin: false, title: "fix(billing): Add totals" });
  // Returning to the group the title already names only releases the pin.
  expect(planGroupDrop({ ...base, from: "pinned", to: "type:feat", pinned: true })).toEqual({ pin: false });
  expect(planGroupDrop({ ...base, mode: "feature", from: "pinned", to: "other", pinned: true, title: "Untyped" })).toEqual({ pin: false });
  expect(planGroupDrop({ ...base, mode: "feature", from: "other", to: "feature:billing", title: "Untyped" })).toBeNull();
  expect(planGroupDrop({ ...base, mode: "manual", from: "pinned", to: "other", pinned: true })).toEqual({ pin: false, assignment: null });
  expect(planGroupDrop({ ...base, mode: "manual", from: "other", to: "group:billing" })).toEqual({ assignment: "billing" });
});
