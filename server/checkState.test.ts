import { describe, expect, test } from "bun:test";
import { checkState, currentChecks, unsatisfiedRequiredChecks, type CheckState, type PrCheck } from "./checkState.ts";

function checkRun(conclusion: string | null, status = "COMPLETED", isRequired = false): PrCheck {
  return { __typename: "CheckRun", name: "job", status, conclusion, detailsUrl: null, startedAt: null, completedAt: null, isRequired, checkSuite: null } as unknown as PrCheck;
}

function statusContext(state: string, isRequired = false): PrCheck {
  return { __typename: "StatusContext", context: "ctx", state, targetUrl: null, createdAt: "2026-08-07T00:00:00Z", isRequired } as unknown as PrCheck;
}

describe("checkState", () => {
  const conclusions: Array<[string, CheckState]> = [
    ["SUCCESS", "passed"],
    ["SKIPPED", "skipped"],
    ["NEUTRAL", "skipped"],
    ["STALE", "skipped"],
    ["CANCELLED", "cancelled"],
    ["FAILURE", "failed"],
    ["TIMED_OUT", "failed"],
    ["ACTION_REQUIRED", "failed"],
    ["STARTUP_FAILURE", "failed"],
  ];

  for (const [conclusion, expected] of conclusions) {
    test(`${conclusion.toLowerCase()} is ${expected}`, () => {
      expect(checkState(checkRun(conclusion))).toBe(expected);
    });
  }

  test("a skipped check is not passed: it never ran, so it proves nothing", () => {
    expect(checkState(checkRun("SKIPPED"))).not.toBe("passed");
  });

  test("a cancelled check is not failed: nothing ran to fail", () => {
    expect(checkState(checkRun("CANCELLED"))).not.toBe("failed");
  });

  test("a check without a conclusion is running until its status completes", () => {
    expect(checkState(checkRun(null, "QUEUED"))).toBe("running");
    expect(checkState(checkRun(null, "IN_PROGRESS"))).toBe("running");
    expect(checkState(checkRun(null, "WAITING"))).toBe("running");
  });

  test("status contexts map by state", () => {
    expect(checkState(statusContext("SUCCESS"))).toBe("passed");
    expect(checkState(statusContext("PENDING"))).toBe("running");
    expect(checkState(statusContext("EXPECTED"))).toBe("running");
    expect(checkState(statusContext("FAILURE"))).toBe("failed");
    expect(checkState(statusContext("ERROR"))).toBe("failed");
  });

  test("an unrecognised result reads as failing rather than better than it is", () => {
    expect(checkState(checkRun("SOME_NEW_CONCLUSION"))).toBe("failed");
  });
});

test("current checks isolate workflow identities and order retry jobs independently of response order", () => {
  const native = (workflowId: number, runId: number, jobId: number, conclusion: string): PrCheck => ({
    __typename: "CheckRun", databaseId: jobId, name: "gate", status: "COMPLETED", conclusion,
    detailsUrl: null, startedAt: null, completedAt: null, isRequired: true,
    checkSuite: { workflowRun: { databaseId: runId, workflow: { databaseId: workflowId, name: "CI" } } },
  });
  const replacement = native(1, 20, 200, "SUCCESS");
  const independentFailure = native(2, 15, 150, "FAILURE");
  const history = [
    replacement, native(1, 10, 100, "CANCELLED"),
    independentFailure, native(1, 20, 190, "FAILURE"),
  ];
  expect(currentChecks(history)).toEqual([replacement, independentFailure]);
  expect(history.map(checkState)).toEqual(["passed", "cancelled", "failed", "failed"]);
});

describe("unsatisfiedRequiredChecks", () => {
  function detailJson(nodes: PrCheck[]): string {
    return JSON.stringify({ lastCommit: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { nodes } } } }] } });
  }

  test("a required check that only passed satisfies the requirement", () => {
    expect(unsatisfiedRequiredChecks(detailJson([checkRun("SUCCESS", "COMPLETED", true)]))).toEqual([]);
  });

  test("a skipped or cancelled required check is unsatisfied", () => {
    const nodes = [checkRun("SKIPPED", "COMPLETED", true), checkRun("CANCELLED", "COMPLETED", true), checkRun("SUCCESS", "COMPLETED", true)];
    expect(unsatisfiedRequiredChecks(detailJson(nodes))).toEqual(["job", "job"]);
  });

  test("optional checks in any state are ignored", () => {
    expect(unsatisfiedRequiredChecks(detailJson([checkRun("SKIPPED"), checkRun("FAILURE"), statusContext("PENDING")]))).toEqual([]);
  });

  test("a PR with no cached checks reports nothing unsatisfied", () => {
    expect(unsatisfiedRequiredChecks("{}")).toEqual([]);
    expect(unsatisfiedRequiredChecks("")).toEqual([]);
  });
});
