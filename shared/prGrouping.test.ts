import { expect, test } from "bun:test";
import { categoryForPr, normalizePrGrouping } from "./prGrouping.ts";

test("feature scopes win over title keywords and matching respects words", () => {
  const config = normalizePrGrouping({ mode: "feature" });
  expect(categoryForPr("feat(billing)!: Add settings", config)).toBe("group:billing");
  expect(categoryForPr("Fix workspace PREFERENCES", config)).toBe("group:settings");
  expect(categoryForPr("Fix queueing", config)).toBe("other");
  expect(categoryForPr("Fix inbox", config)).toBe("group:inbox");
});

test("types require a conventional title prefix, including scoped breaking changes", () => {
  const config = normalizePrGrouping({ mode: "type" });
  expect(categoryForPr("FEAT(settings)!: Add shortcuts", config)).toBe("type:feat");
  expect(categoryForPr("fix: Restore selection", config)).toBe("type:fix");
  expect(categoryForPr("A fix for settings", config)).toBe("other");
  expect(categoryForPr("unknown: title", config)).toBe("other");
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
