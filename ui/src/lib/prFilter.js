import { parseQuery, matchesQuery, wantsHistoricalPrs } from "../../../server/query.ts";

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
    is_draft: pr.isDraft ? 1 : 0,
  };
}

export function wantsHistory(query) {
  return wantsHistoricalPrs(parseQuery(query));
}

export function filterPrs(prs, query, isArchived = false) {
  const q = query.trim();
  if (!q) return prs;
  const parsed = parseQuery(q);
  return prs.filter((pr) => matchesQuery(toMatchable(pr), parsed, isArchived));
}

export function countMatches(prs, query, isArchived = false) {
  return filterPrs(prs, query, isArchived).length;
}
