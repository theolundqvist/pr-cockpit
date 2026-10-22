const PR_REF_PART_RE = /^[A-Za-z0-9_.-]+$/;
const PR_NUMBER_RE = /^[1-9][0-9]*$/;
// The renderer's comment-link grammar (ui/src/lib/commentTarget.js): `?comment=` names one comment.
const COMMENT_QUERY_RE = /^\?comment=(?:discussion_r|issuecomment-|pullrequestreview-)[1-9][0-9]*$/;

function protocolAction(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "prcockpit:"
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.hash
  ) {
    return null;
  }
  if (parsed.hostname === "main") return parsed.pathname === "" && !parsed.search ? { type: "focus-main" } : null;
  if (parsed.hostname !== "pr" || (parsed.search && !COMMENT_QUERY_RE.test(parsed.search))) return null;
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  const [, owner, repo, number] = match;
  return PR_REF_PART_RE.test(owner) && PR_REF_PART_RE.test(repo) && PR_NUMBER_RE.test(number)
    ? { type: "open-pr", owner, repo, number, comment: parsed.search ? parsed.search.slice("?comment=".length) : null }
    : null;
}

function deepLinkHash(url) {
  const action = protocolAction(url);
  if (action?.type !== "open-pr") return null;
  return `#/pr/${action.owner}/${action.repo}/${action.number}${action.comment ? `?comment=${action.comment}` : ""}`;
}

function protocolArgFromArgv(argv) {
  return argv.find((arg) => typeof arg === "string" && arg.toLowerCase().startsWith("prcockpit:")) || null;
}

module.exports = { deepLinkHash, protocolAction, protocolArgFromArgv };
