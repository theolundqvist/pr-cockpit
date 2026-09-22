import { expect, test } from "bun:test";
import { reportStorageFailure, retrySystemIssue, systemIssues } from "./systemIssues.ts";

test("a full SQLite volume becomes an actionable system issue", () => {
  expect(reportStorageFailure(new Error("SQLiteError: database or disk is full"))).toBe(true);
  expect(systemIssues().find((issue) => issue.id === "disk-space")).toMatchObject({
    kind: "disk-space",
    title: "Cockpit cannot write to storage",
  });
  retrySystemIssue("disk-space");
  expect(systemIssues().some((issue) => issue.id === "disk-space")).toBe(false);
});
