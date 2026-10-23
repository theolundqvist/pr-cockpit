// GitHub names one comment on a pull request page by its URL fragment. The PR route carries the same
// token as `?comment=`, so permalinks, prcockpit:// deep links, and in-app links share one grammar.
const TARGET_RE = /^(discussion_r|issuecomment-|pullrequestreview-)([1-9][0-9]*)$/;
const KINDS = { "discussion_r": "review-comment", "issuecomment-": "issue-comment", "pullrequestreview-": "review" };
const GITHUB_PR_RE = /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/pull\/(\d+)(\/(?:files|changes))?(?:\?[^#]*)?(?:#(.*))?$/;

/** @returns {{ kind: "review-comment" | "issue-comment" | "review", id: number, token: string } | null} */
export function parseCommentTarget(token) {
  const match = typeof token === "string" ? token.match(TARGET_RE) : null;
  return match ? { kind: KINDS[match[1]], id: Number(match[2]), token } : null;
}

export function prHash(repo, number, target = null) {
  return `#/pr/${repo}/${number}${target ? `?comment=${target.token}` : ""}`;
}

// In-app route for a github.com pull request link, keeping a comment fragment as its target. The
// Files view names a review comment `#r<id>`; a Files link without one stays a GitHub link.
export function prLinkHash(href) {
  const match = href.match(GITHUB_PR_RE);
  if (!match) return null;
  const [, owner, repo, number, filesPath, fragment = ""] = match;
  const target = parseCommentTarget(fragment.replace(/^r(?=\d)/, "discussion_r"));
  if (filesPath && !target) return null;
  return prHash(`${owner}/${repo}`, number, target);
}

// The review thread holding a review comment, or the issue comment or review a target names, in a
// loaded detail. Null when the detail does not carry it: deleted, not yet fetched, or still pending.
export function locateCommentTarget(detail, threads, target) {
  if (target.kind === "review-comment") {
    const thread = threads.find((item) => item.comments.nodes.some((comment) => comment.databaseId === target.id));
    return thread ? { thread } : null;
  }
  const nodes = target.kind === "issue-comment" ? detail.comments.nodes : detail.reviews.nodes;
  const node = nodes.find((item) => item.databaseId === target.id);
  return node ? { node } : null;
}

// Files shows a thread inline only on a current right-side line; the loaded diff has the final say.
export function threadOpensInFiles(thread) {
  return !thread.isOutdated && thread.line !== null && thread.diffSide === "RIGHT";
}

export function commentTargetSelector(target) {
  const attribute = { "review-comment": "data-comment-id", "issue-comment": "data-issue-comment-id", review: "data-review-id" }[target.kind];
  return `[${attribute}="${target.id}"]`;
}
