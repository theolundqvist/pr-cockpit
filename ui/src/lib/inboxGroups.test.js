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
  safeMergeApproval: true,
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
    ["ready-review", "Marked ready", [5]],
    ["pinned", "Pinned", [6]],
    ["type:feat", "Features", [3]],
    ["type:fix", "Fixes", [1]],
    ["cooking", "Cooking", [2, 7]],
  ]);
});

test("Kitchen takes precedence over marked-ready, approval, and pinning", () => {
  const ordered = pr(8, "feat: ordered handoff", {
    readyForReview: true,
    approvedForSafeMerge: true,
    rank: 0,
    labels: [{ name: "kitchen: chef" }],
  });
  expect(groupsOf([ordered])).toEqual([["cooking", "Cooking", [8]]]);
  expect(groupsOf([{ ...ordered, labels: [] }])).toEqual([["ready-review", "Marked ready", [8]]]);
  expect(groupsOf([{ ...ordered, labels: [], readyForReview: false }])).toEqual([["approved", "Approved for safe merge", [8]]]);
  expect(groupsOf([{ ...ordered, labels: [], readyForReview: false, approvedForSafeMerge: false }])).toEqual([["pinned", "Pinned", [8]]]);
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

test("feature scopes nest on slashes, with ancestors heading their subtree and counting it", () => {
  const prs = [
    pr(1, "feat(outlook/send): retry"),
    pr(2, "fix(outlook-x): typo"),
    pr(3, "feat(outlook/send/queue): drain"),
    pr(4, "feat(outlook): sync"),
    pr(5, "feat(gmail/labels): map"),
  ];
  const groups = inboxGroups(prs, {
    stack: prStack(prs),
    grouping: normalizePrGrouping({ mode: "feature" }),
    assignments: {},
    viewerLogin: "me",
    listOrder: "queue",
  });
  expect(groups.map((group) => [group.id, group.label, group.depth, group.total, group.items.map((item) => item.pr.number)])).toEqual([
    ["feature:gmail", "gmail", 0, 1, []],
    ["feature:gmail/labels", "labels", 1, 1, [5]],
    ["feature:outlook", "outlook", 0, 3, [4]],
    ["feature:outlook/send", "send", 1, 2, [1]],
    ["feature:outlook/send/queue", "queue", 2, 1, [3]],
    ["feature:outlook-x", "outlook-x", 0, 1, [2]],
  ]);
  expect(groups.find((group) => group.id === "feature:outlook/send/queue").ancestors).toEqual(["feature:outlook", "feature:outlook/send"]);
});
