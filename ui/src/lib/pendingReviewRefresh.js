const PENDING_REVIEW_MUTATIONS = new Set([
  "pending-inline-comment",
  "edit-pending-comment",
  "delete-pending-comment",
  "discard-pending-review",
  "review-verdict",
]);

// Draft reviews are visible only to their author, not the installation token.
export function mutationAffectsPendingReview(kind) {
  return PENDING_REVIEW_MUTATIONS.has(kind);
}
