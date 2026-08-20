import { describe, expect, test } from "bun:test";
import { mergeGate, forceMergeAvailable } from "./mergeGate.js";

function pr(overrides) {
  return {
    isDraft: false,
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    ...overrides,
  };
}

describe("mergeGate", () => {
  test("null pr is inert", () => {
    expect(mergeGate(null, null)).toEqual({ action: null, reason: null });
  });

  test("draft blocks", () => {
    expect(mergeGate(pr({ isDraft: true }), "SUCCESS")).toEqual({ action: null, reason: "This pull request is still a work in progress" });
  });

  test("conflicts block on either signal", () => {
    expect(mergeGate(pr({ mergeable: "CONFLICTING" }), null).reason).toBe("This branch has conflicts that must be resolved");
    expect(mergeGate(pr({ mergeStateStatus: "DIRTY" }), null).reason).toBe("This branch has conflicts that must be resolved");
  });

  test("behind offers update", () => {
    expect(mergeGate(pr({ mergeStateStatus: "BEHIND" }), null)).toEqual({
      action: "update",
      reason: "This branch is out-of-date with the base branch",
    });
  });

  test("blocked names the review reason when the viewer can't bypass", () => {
    expect(mergeGate(pr({ mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }), null).reason).toBe(
      "Review required",
    );
    expect(mergeGate(pr({ mergeStateStatus: "BLOCKED", reviewDecision: "CHANGES_REQUESTED" }), null).reason).toBe(
      "Changes requested",
    );
    expect(mergeGate(pr({ mergeStateStatus: "BLOCKED" }), null).reason).toBe("Merging is blocked");
  });

  test("blocked with admin bypass points at force merge, not the normal action", () => {
    const gate = mergeGate(pr({ mergeStateStatus: "BLOCKED", viewerCanMergeAsAdmin: true, reviewDecision: "REVIEW_REQUIRED" }), null);
    expect(gate.action).toBe(null);
    expect(gate.reason).toBe("Review required");
    expect(gate.note).toBe("As an administrator, you may still merge this pull request");
    expect(forceMergeAvailable(pr({ mergeStateStatus: "BLOCKED", viewerCanMergeAsAdmin: true }), gate)).toBe(true);
  });

  test("unstable merges — Some checks were not successful", () => {
    expect(mergeGate(pr({ mergeStateStatus: "UNSTABLE" }), "FAILURE")).toEqual({
      action: "merge",
      reason: null,
      note: "Some checks were not successful",
    });
  });

  test("clean and has_hooks merge without re-gating on the rollup", () => {
    expect(mergeGate(pr({ mergeStateStatus: "CLEAN" }), "FAILURE")).toEqual({ action: "merge", reason: null });
    expect(mergeGate(pr({ mergeStateStatus: "CLEAN" }), "PENDING")).toEqual({ action: "merge", reason: null });
    expect(mergeGate(pr({ mergeStateStatus: "HAS_HOOKS" }), "FAILURE")).toEqual({ action: "merge", reason: null });
  });

  test("unknown status falls back to the mergeable + rollup gate", () => {
    expect(mergeGate(pr({ mergeStateStatus: "UNKNOWN" }), "SUCCESS")).toEqual({ action: "merge", reason: null });
    expect(mergeGate(pr({ mergeStateStatus: "UNKNOWN" }), "NONE")).toEqual({ action: "merge", reason: null });
    expect(mergeGate(pr({ mergeStateStatus: "UNKNOWN" }), null)).toEqual({ action: "merge", reason: null });
    expect(mergeGate(pr({ mergeStateStatus: "UNKNOWN" }), "PENDING").reason).toBe("Some checks haven't completed yet");
    expect(mergeGate(pr({ mergeStateStatus: "UNKNOWN" }), "FAILURE").reason).toBe("Some checks were not successful");
  });

  test("unknown status and unmergeable falls through", () => {
    expect(mergeGate(pr({ mergeStateStatus: "UNKNOWN", mergeable: "UNKNOWN" }), "SUCCESS").reason).toBe("Checking for ability to merge automatically…");
  });
});

describe("forceMergeAvailable", () => {
  test("false for null, draft, non-open, conflicting", () => {
    expect(forceMergeAvailable(null, { action: null })).toBe(false);
    expect(forceMergeAvailable(pr({ isDraft: true }), { action: null })).toBe(false);
    expect(forceMergeAvailable(pr({ state: "CLOSED" }), { action: null })).toBe(false);
    expect(forceMergeAvailable(pr({ mergeable: "CONFLICTING" }), { action: null })).toBe(false);
    expect(forceMergeAvailable(pr({ mergeStateStatus: "DIRTY" }), { action: null })).toBe(false);
  });

  test("false when the gate already offers a clean merge", () => {
    expect(forceMergeAvailable(pr(), { action: "merge" })).toBe(false);
  });

  test("true when open and blocked short of a clean merge", () => {
    expect(forceMergeAvailable(pr({ mergeStateStatus: "BLOCKED" }), { action: null })).toBe(true);
    expect(forceMergeAvailable(pr({ mergeStateStatus: "BEHIND" }), { action: "update" })).toBe(true);
  });
});
