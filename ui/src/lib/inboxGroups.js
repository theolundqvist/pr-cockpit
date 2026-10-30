import { categoryForPr, orderQueueUnits, PR_TYPES, TYPE_TITLES } from "../../../shared/prGrouping.ts";
import { cookingStage, isBurnt } from "../../../shared/cookingStage.js";
import { isApprovedForSafeMerge } from "./prRowActions.js";
import { prKey } from "./prKey.js";
import { sortByTime } from "./prTime.js";
import { classify, GROUP_ORDER, GROUP_TITLES } from "./whoseMove.js";

const TRUNK_MIN_BASE_COUNT = 3;

// Maps each PR to the listed PR whose head is its base. A branch that's the base of many open PRs is trunk,
// even if a release PR's head equals it.
export function prStack(prs) {
  const counts = new Map();
  for (const pr of prs) {
    const key = `${pr.repo}:${pr.baseRef}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const trunk = new Set([...counts].filter(([, n]) => n >= TRUNK_MIN_BASE_COUNT).map(([key]) => key));
  const byHead = new Map(prs.map((pr) => [`${pr.repo}:${pr.headRef}`, pr]));
  const info = new Map();
  for (const pr of prs) {
    const base = `${pr.repo}:${pr.baseRef}`;
    info.set(prKey(pr), { parent: trunk.has(base) ? null : (byHead.get(base) ?? null) });
  }
  return info;
}

// Walks up to the topmost ancestor still in the list; that PR's status places the whole stack.
export function topUnit(stack, pr) {
  let cur = pr;
  const visited = new Set();
  for (;;) {
    visited.add(prKey(cur));
    const parent = stack.get(prKey(cur))?.parent;
    if (!parent || visited.has(prKey(parent))) return cur;
    cur = parent;
  }
}

function orderGroup(stack, rows, sortUnits = (units) => units) {
  const inGroup = new Set(rows.map(prKey));
  const childrenOf = new Map();
  const topUnits = [];
  for (const pr of rows) {
    const parent = stack.get(prKey(pr)).parent;
    if (parent && inGroup.has(prKey(parent))) {
      (childrenOf.get(prKey(parent)) ?? childrenOf.set(prKey(parent), []).get(prKey(parent))).push(pr);
    } else {
      topUnits.push(pr);
    }
  }
  // A row indents only beneath its parent; one whose parent sits in another section is a root here.
  const subtree = (pr, stacked = false) => {
    const out = [{ pr, stacked }];
    for (const child of childrenOf.get(prKey(pr)) ?? []) out.push(...subtree(child, true));
    return out;
  };
  const unranked = sortUnits(topUnits.filter((pr) => pr.rank == null));
  const ranked = topUnits.filter((pr) => pr.rank != null).sort((a, b) => a.rank - b.rank);
  const items = [];
  for (const pr of unranked) items.push(...subtree(pr));
  if (ranked.length > 0) items.push({ divider: true });
  for (const pr of ranked) items.push(...subtree(pr));
  return { units: [...unranked, ...ranked], unrankedCount: unranked.length, items };
}

// The inbox's section for one PR. `options`: `stack` from prStack, `grouping` (normalized pr_grouping),
// `assignments` (manual groups by root key), `viewerLogin`, `cooking` (Kitchen sections active),
// `readyReview` (marked-ready handoffs get their own section), and `safeMergeApproval`.
// A burnt Kitchen order, active Kitchen stage, or failed merge outranks a marked-ready handoff,
// approval, pinning, and grouping; stacks never pull either under a healthy ancestor. Kitchen labels
// place only their own PR, so removing the order releases it to its remaining state.
// Pins and approvals retain their saved state; approval places only its own PR, never the stack beneath it.
export function inboxGroupId(pr, options) {
  if (options.cooking && isBurnt(pr)) return "burnt";
  if (options.cooking && cookingStage(pr)) return "cooking";
  if (options.readyReview && pr.readyForReview === true) return "ready-review";
  if (pr.mergeFailed === true) return "merge-failed";
  if (isApprovedForSafeMerge(pr, options.safeMergeApproval)) return "approved";
  if (pr.rank != null) return "pinned";
  const root = topUnit(options.stack, pr);
  return options.grouping.mode === "status" ? classify(root, options.viewerLogin).group
    : categoryForPr(root.title, options.grouping, options.assignments[prKey(root)]);
}

// The inbox's ordered sections, each `{ id, title, units, unrankedCount, items }` with `items` holding
// `{ pr, stacked }` rows and a `{ divider: true }` before pinned roots. Beyond inboxGroupId's options:
// `listOrder` re-sorts unpinned roots by time, and `reveal(id)` also shows an empty section.
export function inboxGroups(prs, options) {
  const { stack, grouping, viewerLogin, listOrder, reveal = () => false } = options;
  const burnt = [];
  const ready = [];
  const failed = [];
  const approved = [];
  const pinned = [];
  const buckets = new Map();
  for (const pr of prs) {
    const id = inboxGroupId(pr, options);
    if (id === "burnt") burnt.push(pr);
    else if (id === "ready-review") ready.push(pr);
    else if (id === "merge-failed") failed.push(pr);
    else if (id === "approved") approved.push(pr);
    else if (id === "pinned") pinned.push(pr);
    else {
      if (!buckets.has(id)) buckets.set(id, []);
      buckets.get(id).push(pr);
    }
  }
  const mode = grouping.mode;
  const categories = mode === "status" ? GROUP_ORDER.map((id) => ({ id, title: GROUP_TITLES[id] }))
    : [...(mode === "type" ? PR_TYPES.map((type) => ({ id: `type:${type}`, title: TYPE_TITLES[type] }))
      : mode === "feature" ? [...buckets.keys()].filter((id) => id.startsWith("feature:")).sort().map((id) => ({ id, title: id.slice("feature:".length) }))
      : grouping.groups.map((group) => ({ id: `group:${group.id}`, title: group.name }))),
      { id: "other", title: mode === "manual" ? "Ungrouped" : "Other" }];
  if (options.cooking) categories.push({ id: "cooking", title: "Cooking" });
  // A stack sorts by its root row; feature groups also order by status, then type. A timestamp order
  // re-sorts only unpinned roots inside each section, with queue order breaking ties.
  const statusRank = mode === "feature" ? (pr) => GROUP_ORDER.indexOf(classify(pr, viewerLogin).group) : undefined;
  const sortUnits = (units) => sortByTime(orderQueueUnits(units, statusRank), listOrder);
  const shown = (id, rows) => rows.length > 0 || reveal(id);
  const statusGroups = categories.filter(({ id }) => shown(id, buckets.get(id) ?? [])).map(({ id, title }) => {
    const rows = buckets.get(id) ?? [];
    // Kitchen stages sort independently of review categories; hide/show never changes saved ranks.
    const { units, unrankedCount, items } = id === "cooking"
      ? { units: [], unrankedCount: 0, items: [...sortUnits(rows)].sort((a, b) => cookingStage(a).rank - cookingStage(b).rank).map((pr) => ({ pr })) }
      : orderGroup(stack, rows, sortUnits);
    return { id, title, units, unrankedCount, items };
  });
  const leading = [];
  if (burnt.length) {
    const { units, unrankedCount, items } = orderGroup(stack, burnt, sortUnits);
    leading.push({ id: "burnt", title: "Burnt", units, unrankedCount, items });
  }
  if (ready.length) {
    // A handoff has no saved order of its own: pins keep their rank but draw no divider here.
    leading.push({ id: "ready-review", title: "Marked ready", units: [], unrankedCount: 0, items: [...sortUnits(ready)].map((pr) => ({ pr })) });
  }
  if (failed.length) {
    const { units, unrankedCount, items } = orderGroup(stack, failed, sortUnits);
    leading.push({ id: "merge-failed", title: "FAILED TO MERGE", units, unrankedCount, items });
  }
  if (shown("approved", approved)) {
    const { units, unrankedCount, items } = orderGroup(stack, approved, sortUnits);
    leading.push({ id: "approved", title: "Approved for safe merge", units, unrankedCount, items });
  }
  if (shown("pinned", pinned)) {
    const { units, unrankedCount, items } = orderGroup(stack, pinned);
    leading.push({ id: "pinned", title: "Pinned", units, unrankedCount, items });
  }
  return [...leading, ...statusGroups];
}
