const PR_REF_PART_RE = /^[A-Za-z0-9_.-]+$/;
const PR_NUMBER_RE = /^[1-9][0-9]*$/;

function deepLinkParts(url) {
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "prcockpit:" ||
      parsed.hostname !== "pr" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/([^/]+)$/);
    if (!match) return null;
    const [, owner, repo, number] = match;
    return PR_REF_PART_RE.test(owner) && PR_REF_PART_RE.test(repo) && PR_NUMBER_RE.test(number)
      ? [owner, repo, number]
      : null;
  } catch {
    return null;
  }
}

function deepLinkHash(url) {
  const parts = deepLinkParts(url);
  return parts ? `#/pr/${parts[0]}/${parts[1]}/${parts[2]}` : null;
}

function protocolArgFromArgv(argv) {
  return argv.find((arg) => typeof arg === "string" && arg.toLowerCase().startsWith("prcockpit:")) || null;
}

function protocolUrlFromArgv(argv) {
  const arg = protocolArgFromArgv(argv);
  return arg && deepLinkHash(arg) ? arg : null;
}

module.exports = { deepLinkHash, deepLinkParts, protocolArgFromArgv, protocolUrlFromArgv };
