const CI_FAIL = new Set(["FAILURE", "ERROR"]);

export function classify(pr, viewerLogin) {
  if (pr.state === "MERGED") return { group: "waiting", tone: "merged", label: "merged" };
  if (pr.state === "CLOSED") return { group: "waiting", tone: "closed", label: "closed" };
  const base = baseClassify(pr, viewerLogin);
  if (pr.fixerAgentExitReason === "green") return { group: base.group, tone: "ready", label: "auto-fix green" };
  if (pr.autoMergeEnabled) {
    if (pr.fixerAgentState === "died") return { group: base.group, tone: "fail", label: "agent died" };
    return { group: base.group, tone: "ready", label: "auto merging" };
  }
  return base;
}

function baseClassify(pr, viewerLogin) {
  const isAuthor = pr.viewerIsAuthor || (viewerLogin != null && pr.author === viewerLogin);

  const greenNoThreads = pr.ciStatus === "SUCCESS" && pr.unresolvedCount === 0
    && pr.reviewDecision !== "CHANGES_REQUESTED" && !(pr.viewerReviewRequested && !isAuthor);
  if (!pr.isDraft && (pr.mergeStateStatus === "CLEAN" || greenNoThreads)) {
    if (pr.mergeable === "CONFLICTING") return { group: "ready", tone: "ready", label: "ready · conflicts" };
    if (pr.mergeStateStatus === "BEHIND") return { group: "ready", tone: "ready", label: "ready · behind" };
    return { group: "ready", tone: "ready", label: "ready" };
  }

  if (pr.viewerReviewRequested && !isAuthor) {
    return { group: "yours", tone: "review", label: "your review" };
  }
  if (isAuthor) {
    if (CI_FAIL.has(pr.ciStatus)) return { group: "yours", tone: "fail", label: "checks failing" };
    if (pr.mergeable === "CONFLICTING") return { group: "yours", tone: "fail", label: "conflicts" };
    if (pr.reviewDecision === "CHANGES_REQUESTED") return { group: "yours", tone: "review", label: "changes requested" };
    if (pr.unresolvedCount > 0) return { group: "yours", tone: "review", label: `${pr.unresolvedCount} thread${pr.unresolvedCount > 1 ? "s" : ""}` };
  }

  if (!isAuthor && CI_FAIL.has(pr.ciStatus)) return { group: "waiting", tone: "wait", label: "checks failing" };
  if (pr.ciStatus === "PENDING") return { group: "waiting", tone: "wait", label: "checks running" };
  if (isAuthor && pr.reviewDecision === "REVIEW_REQUIRED") return { group: "waiting", tone: "wait", label: "waiting on review" };
  if (pr.isDraft) return { group: "waiting", tone: "wait", label: "draft" };
  return { group: "waiting", tone: "wait", label: "in review" };
}

export const GROUP_ORDER = ["ready", "yours", "waiting"];

export const GROUP_TITLES = {
  ready: "Ready to merge",
  yours: "Your move",
  waiting: "Waiting",
};
