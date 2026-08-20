function reviewBlockReason(pr) {
  if (pr.reviewDecision === "REVIEW_REQUIRED") return "Review required";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "Changes requested";
  return "Merging is blocked";
}

export function mergeGate(pr, rollupState) {
  if (!pr) return { action: null, reason: null };
  if (pr.isDraft) return { action: null, reason: "This pull request is still a work in progress" };
  const mss = pr.mergeStateStatus;
  if (pr.mergeable === "CONFLICTING" || mss === "DIRTY") return { action: null, reason: "This branch has conflicts that must be resolved" };
  if (mss === "BEHIND") return { action: "update", reason: "This branch is out-of-date with the base branch" };
  if (mss === "BLOCKED") {
    if (pr.viewerCanMergeAsAdmin)
      return { action: null, reason: reviewBlockReason(pr), note: "As an administrator, you may still merge this pull request" };
    return { action: null, reason: reviewBlockReason(pr) };
  }
  if (mss === "UNSTABLE") return { action: "merge", reason: null, note: "Some checks were not successful" };
  if (mss === "CLEAN" || mss === "HAS_HOOKS") return { action: "merge", reason: null };
  if (pr.mergeable === "MERGEABLE") {
    const s = rollupState ?? "NONE";
    if (s === "SUCCESS" || s === "NONE") return { action: "merge", reason: null };
    if (s === "PENDING") return { action: null, reason: "Some checks haven't completed yet" };
    return { action: null, reason: "Some checks were not successful" };
  }
  return { action: null, reason: "Checking for ability to merge automatically…" };
}

export function forceMergeAvailable(pr, gate) {
  if (!pr || pr.isDraft) return false;
  if (pr.state.toUpperCase() !== "OPEN") return false;
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") return false;
  return gate.action !== "merge";
}
