import { parseQuery, matchesQuery, wantsHistoricalPrs, constrainsDrafts } from "../../../server/query.ts";
import { isDraftPr } from "../../../shared/prGrouping.ts";

function toMatchable(pr) {
  return {
    author: pr.author,
    repo: pr.repo,
    title: pr.title,
    number: pr.number,
    state: pr.state,
    base_ref: pr.baseRef,
    head_ref: pr.headRef,
    review_decision: pr.reviewDecision,
    // Same draft test as the Drafts hidden toggle, so `is:draft` shows exactly what the toggle hides.
    is_draft: isDraftPr(pr) ? 1 : 0,
    labels: (pr.labels ?? []).map((label) => label.name),
  };
}

export function wantsHistory(query) {
  return wantsHistoricalPrs(parseQuery(query));
}

export function queryDecidesDrafts(query) {
  return constrainsDrafts(parseQuery(query));
}

export function filterPrs(prs, query, { archived = false, viewer = null } = {}) {
  const q = query.trim();
  if (!q) return prs;
  const parsed = parseQuery(q);
  return prs.filter((pr) => matchesQuery(toMatchable(pr), parsed, { archived, viewer }));
}

export function countMatches(prs, query, context) {
  return filterPrs(prs, query, context).length;
}
