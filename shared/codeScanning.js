export const CODE_SCANNING_DISMISSAL_REASONS = ["false positive", "won't fix", "used in tests", "mitigated"];

/** @param {unknown} value @returns {{ reason: string, comment?: string }} */
export function validateCodeScanningDismissal(value) {
  if (!value || typeof value !== "object" || !("reason" in value)
    || typeof value.reason !== "string" || !CODE_SCANNING_DISMISSAL_REASONS.includes(value.reason)) {
    throw new Error("CodeQL dismissal requires an explicit reason: false positive, won't fix, used in tests, or mitigated");
  }
  if ("comment" in value && value.comment !== undefined) {
    if (typeof value.comment !== "string" || value.comment.length > 280) {
      throw new Error("CodeQL dismissal comment must be a string of at most 280 characters");
    }
    return { reason: value.reason, comment: value.comment };
  }
  return { reason: value.reason };
}

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
