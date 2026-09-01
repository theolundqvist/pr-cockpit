const PR_REF_PART_RE = /^[A-Za-z0-9_.-]+$/;
const PR_NUMBER_RE = /^[1-9][0-9]*$/;

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
    || parsed.search
    || parsed.hash
  ) {
    return null;
  }
  if (parsed.hostname === "main") return parsed.pathname === "" ? { type: "focus-main" } : null;
  if (parsed.hostname !== "pr") return null;
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  const [, owner, repo, number] = match;
  return PR_REF_PART_RE.test(owner) && PR_REF_PART_RE.test(repo) && PR_NUMBER_RE.test(number)
    ? { type: "open-pr", owner, repo, number }
    : null;
}

function deepLinkHash(url) {
  const action = protocolAction(url);
  return action?.type === "open-pr" ? `#/pr/${action.owner}/${action.repo}/${action.number}` : null;
}

function protocolArgFromArgv(argv) {
  return argv.find((arg) => typeof arg === "string" && arg.toLowerCase().startsWith("prcockpit:")) || null;
}

module.exports = { deepLinkHash, protocolAction, protocolArgFromArgv };
