import { expect, test } from "bun:test";
import { categoryForPr, normalizePrGrouping, orderQueueUnits, parsePrTitle } from "./prGrouping.ts";

test("feature scopes win over title keywords and matching respects words", () => {
  const config = normalizePrGrouping({ mode: "feature" });
  expect(categoryForPr("feat(billing)!: Add settings", config)).toBe("group:billing");
  expect(categoryForPr("Fix workspace PREFERENCES", config)).toBe("group:settings");
  expect(categoryForPr("Fix queueing", config)).toBe("other");
  expect(categoryForPr("Fix inbox", config)).toBe("group:inbox");
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
  expect(normalizePrGrouping({ groups: [null, { id: "one", name: " First " }, { id: "one", name: "Duplicate" }, { id: "bad/id", name: "Invalid" }] }).groups)
    .toEqual([{ id: "one", name: "First", keywords: "" }]);
});
