import { describe, expect, test } from "bun:test";
import { classify } from "./whoseMove.js";

function pr(overrides) {
  return {
    state: "OPEN",
    isDraft: false,
    mergeStateStatus: "BLOCKED",
    mergeable: "MERGEABLE",
    viewerReviewRequested: false,
    viewerIsAuthor: false,
    author: "someone-else",
    ciStatus: "SUCCESS",
    reviewDecision: null,
    unresolvedCount: 0,
    autoMergeEnabled: false,
    fixerAgentState: null,
    fixerAgentExitReason: null,
    ...overrides,
  };
}

describe("classify", () => {
  test("surfaces auto-fix green regardless of underlying status", () => {
    const result = classify(pr({ fixerAgentExitReason: "green", ciStatus: "PENDING" }), "viewer");
    expect(result.label).toBe("auto-fix green");
    expect(result.tone).toBe("ready");
  });

  test("auto-fix green takes priority over auto-merge armed", () => {
    const result = classify(pr({ fixerAgentExitReason: "green", autoMergeEnabled: true }), "viewer");
    expect(result.label).toBe("auto-fix green");
  });

  test("falls through to normal classification without a green exit", () => {
    const result = classify(pr({}), "viewer");
    expect(result.label).not.toBe("auto-fix green");
  });

  test("CI green with zero unresolved threads is ready even when BLOCKED", () => {
    const result = classify(pr({}), "viewer");
    expect(result).toEqual({ group: "ready", tone: "ready", label: "ready" });
  });

  test("behind base stays ready with a behind label", () => {
    const result = classify(pr({ mergeStateStatus: "BEHIND" }), "viewer");
    expect(result).toEqual({ group: "ready", tone: "ready", label: "ready · behind" });
  });

  test("merge conflicts stay ready with a conflicts label", () => {
    const result = classify(pr({ mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" }), "viewer");
    expect(result).toEqual({ group: "ready", tone: "ready", label: "ready · conflicts" });
  });

  test("CI pending is not ready", () => {
    const result = classify(pr({ ciStatus: "PENDING" }), "viewer");
    expect(result.group).not.toBe("ready");
  });

  test("unresolved threads block ready", () => {
    const result = classify(pr({ unresolvedCount: 2 }), "viewer");
    expect(result.group).not.toBe("ready");
  });

  test("drafts are never ready", () => {
    const result = classify(pr({ isDraft: true }), "viewer");
    expect(result.group).not.toBe("ready");
  });

  test("green CI does not swallow a requested review", () => {
    const result = classify(pr({ viewerReviewRequested: true }), "viewer");
    expect(result).toEqual({ group: "yours", tone: "review", label: "your review" });
  });

  test("green CI does not swallow changes requested on own PR", () => {
    const result = classify(pr({ viewerIsAuthor: true, reviewDecision: "CHANGES_REQUESTED" }), "viewer");
    expect(result.group).not.toBe("ready");
  });
});
