import { expect, test } from "bun:test";
import { mutationAffectsPendingReview } from "./pendingReviewRefresh.js";

test("only personal review changes need the author-only pending-review read", () => {
  for (const kind of ["pending-inline-comment", "edit-pending-comment", "delete-pending-comment", "discard-pending-review", "review-verdict"]) {
    expect(mutationAffectsPendingReview(kind)).toBe(true);
  }
});

test("ordinary writes never trigger a personal pending-review refetch", () => {
  for (const kind of ["comment", "reply-to-thread", "inline-comment", "resolve-thread", "merge", "close", "edit-body", "edit-title", "assign", "request-reviewers", "add-labels", "unknown"]) {
    expect(mutationAffectsPendingReview(kind)).toBe(false);
  }
});
