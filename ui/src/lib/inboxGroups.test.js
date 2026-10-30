import { expect, test } from "bun:test";
import { normalizePrGrouping } from "../../../shared/prGrouping.ts";
import { inboxGroups, prStack } from "./inboxGroups.js";

const pr = (number, title, extra = {}) => ({
  repo: "owner/repo",
  number,
  title,
  state: "OPEN",
  baseRef: "main",
  headRef: `branch-${number}`,
  labels: [],
  rank: null,
  ...extra,
});

const groupsOf = (prs, options = {}) => inboxGroups(prs, {
  stack: prStack(prs),
  grouping: normalizePrGrouping({ mode: "type" }),
  assignments: {},
  viewerLogin: "me",
  cooking: true,
  readyReview: true,
  safeMergeApproval: false,
  listOrder: "queue",
  ...options,
}).map((group) => [group.id, group.title, group.items.filter((item) => item.pr).map((item) => item.pr.number)]);

test("Kitchen and handoff sections lead the user's type sections, with Cooking last", () => {
  const prs = [
    pr(1, "fix: crash"),
    pr(2, "feat: overlay", { labels: [{ name: "kitchen: oven" }] }),
    pr(3, "feat: grouping"),
    pr(4, "chore: bump", { labels: [{ name: "kitchen: burnt" }] }),
    pr(5, "feat: handoff", { readyForReview: true }),
    pr(6, "feat: pinned", { rank: 0 }),
    pr(7, "untyped title", { labels: [{ name: "order" }] }),
  ];
  expect(groupsOf(prs)).toEqual([
    ["burnt", "Burnt", [4]],
    ["ready-review", "Ready for review", [5]],
    ["pinned", "Pinned", [6]],
    ["type:feat", "Features", [3]],
    ["type:fix", "Fixes", [1]],
    ["cooking", "Cooking", [2, 7]],
  ]);
});

test("without the Kitchen section, labelled PRs fall back to their grouping", () => {
  const prs = [pr(2, "feat: overlay", { labels: [{ name: "kitchen: oven" }] }), pr(4, "chore: bump", { labels: [{ name: "kitchen: burnt" }] })];
  expect(groupsOf(prs, { cooking: false })).toEqual([
    ["type:feat", "Features", [2]],
    ["type:chore", "Chores", [4]],
  ]);
});

test("a stacked child follows its root's section", () => {
  const prs = [pr(1, "feat: base"), pr(2, "fix: on top", { baseRef: "branch-1" })];
  expect(groupsOf(prs)).toEqual([["type:feat", "Features", [1, 2]]]);
});
