export function needsMeRank(args: {
  ciStatus: string;
  reviewDecision: string | null;
  unresolvedCount: number;
  mergeable: string;
  isDraft: boolean;
}): number {
  if (args.ciStatus === "FAILURE" || args.ciStatus === "ERROR") return 0;
  if (args.unresolvedCount > 0 || args.reviewDecision === "CHANGES_REQUESTED") return 1;
  if (args.isDraft) return 3;
  const ciPassing = args.ciStatus === "SUCCESS" || args.ciStatus === "NONE";
  const reviewClear =
    args.reviewDecision === "APPROVED" || args.reviewDecision === null;
  if (ciPassing && reviewClear && args.mergeable === "MERGEABLE") return 2;
  return 3;
}
