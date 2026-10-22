import { isDraftPr } from "../../../shared/prGrouping.ts";

// author is "all", "me", or a GitHub login; "me" matches nothing until the viewer login is known.
export function filterByAuthorAndDraft(prs, { author, hideDrafts }, viewerLogin) {
  if (author === "all" && !hideDrafts) return prs;
  const login = author === "all" ? null : (author === "me" ? viewerLogin ?? "" : author).toLowerCase();
  return prs.filter((pr) => (!hideDrafts || !isDraftPr(pr)) && (login === null || pr.author?.toLowerCase() === login));
}

export function availableAuthors(...lists) {
  return [...new Set(lists.flat().map((pr) => pr.author).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}
