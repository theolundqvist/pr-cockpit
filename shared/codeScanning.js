// Only GitHub's security bot can turn a review comment into an alert action.
export function isCodeScanningThread(thread) {
  return /^(github-advanced-security|codeql)(\[bot\])?$/.test(thread?.comments?.nodes?.[0]?.author?.login ?? "");
}

export function codeScanningAlertNumber(thread, repo) {
  const comment = thread?.comments?.nodes?.[0];
  if (!isCodeScanningThread(thread)) return null;
  for (const match of (comment.body ?? "").matchAll(/https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/security\/code-scanning\/(\d+)\b/g)) {
    if (match[1].toLowerCase() === repo?.toLowerCase() && Number.isSafeInteger(Number(match[2])) && Number(match[2]) > 0) return Number(match[2]);
  }
  return null;
}
