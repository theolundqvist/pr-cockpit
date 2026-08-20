import { describe, expect, test } from "bun:test";
import { effectiveRescoreScore, greptileFindings, isValidRescoreResult, needsRescoreCandidate, rescorePrompt, shouldAutoRescore } from "./rescorer.ts";
import type { PrRow } from "./db.ts";

function pr(overrides: Partial<PrRow>): PrRow {
  return {
    repo: "example-org/webapp",
    number: 1,
    state: "OPEN",
    is_draft: 0,
    title: "Fix the thing",
    author: "theolundqvist",
    base_ref: "staging",
    head_ref: "fix-thing",
    head_sha: "sha2",
    updated_at: "2026-01-01T00:00:00Z",
    additions: 1,
    deletions: 1,
    changed_files: 1,
    commit_count: 1,
    mergeable: "MERGEABLE",
    merge_state_status: "CLEAN",
    auto_merge_enabled: 0,
    viewer_is_author: 1,
    viewer_review_requested: 0,
    viewer_review_state: null,
    ci_status: "SUCCESS",
    review_decision: null,
    unresolved_count: 0,
    needs_me_rank: 0,
    greptile_confidence: 3,
    greptile_reviewed_sha: "sha1",
    greptile_unresolved_count: 0,
    detail_json: "{}",
    fetched_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function thread(login: string, isResolved: boolean, body = "concern") {
  return { isResolved, path: "src/foo.ts", line: 12, comments: { nodes: [{ author: { login }, body }] } };
}

describe("needsRescoreCandidate", () => {
  test("candidate once greptile has scored and commits landed since its reviewed sha", () => {
    expect(needsRescoreCandidate(pr({}))).toBe(true);
  });

  test("not a candidate without a greptile confidence score", () => {
    expect(needsRescoreCandidate(pr({ greptile_confidence: null }))).toBe(false);
  });

  test("not a candidate when the reviewed sha still matches head (nothing landed since)", () => {
    expect(needsRescoreCandidate(pr({ greptile_reviewed_sha: "sha2" }))).toBe(false);
  });

  test("not a candidate without a reviewed sha at all", () => {
    expect(needsRescoreCandidate(pr({ greptile_reviewed_sha: null }))).toBe(false);
  });
});

describe("greptileFindings", () => {
  test("extracts findings only from greptile-authored threads", () => {
    const detail = {
      reviewThreads: {
        nodes: [thread("greptile-apps", false, "missing null check"), thread("theolundqvist", false, "human note")],
      },
    };
    expect(greptileFindings(detail)).toEqual([
      { path: "src/foo.ts", line: 12, body: "missing null check", resolved: false },
    ]);
  });

  test("no findings when there are no greptile threads", () => {
    const detail = { reviewThreads: { nodes: [thread("theolundqvist", false)] } };
    expect(greptileFindings(detail)).toEqual([]);
  });
});

describe("isValidRescoreResult", () => {
  test("accepts a well-formed result, halves included", () => {
    expect(isValidRescoreResult({ score: 4.5, verdicts: [{ finding: "a", verdict: "addressed" }] })).toBe(true);
  });

  test("rejects a non-half score", () => {
    expect(isValidRescoreResult({ score: 4.3, verdicts: [] })).toBe(false);
  });

  test("rejects a score out of range", () => {
    expect(isValidRescoreResult({ score: 6, verdicts: [] })).toBe(false);
  });

  test("rejects a malformed verdicts entry", () => {
    expect(isValidRescoreResult({ score: 3, verdicts: [{ finding: "a" }] })).toBe(false);
  });
});

describe("effectiveRescoreScore", () => {
  test("keeps Greptile's comment score when an old rescore used zero for no fixes", () => {
    expect(effectiveRescoreScore(4, 0)).toBe(4);
  });

  test("allows a rescore to raise the original confidence", () => {
    expect(effectiveRescoreScore(4, 4.5)).toBe(4.5);
  });
});

describe("rescorePrompt", () => {
  test("defines missing evidence as the original confidence, never zero", () => {
    const prompt = rescorePrompt("example-org/webapp", 6008, 4, [
      { path: "src/foo.ts", line: 12, body: "concern", resolved: false },
    ], "");
    expect(prompt).toContain("original confidence was 4/5");
    expect(prompt).toContain("return 4; never use 0 as an unavailable-score fallback");
  });
});

describe("shouldAutoRescore", () => {
  test("re-scores an own PR that has commits since greptile's review", () => {
    expect(shouldAutoRescore(pr({}))).toBe(true);
  });

  test("never re-scores a PR authored by someone else", () => {
    expect(shouldAutoRescore(pr({ viewer_is_author: 0 }))).toBe(false);
  });

  test("own PR still skipped when it isn't a rescore candidate", () => {
    expect(shouldAutoRescore(pr({ viewer_is_author: 1, greptile_reviewed_sha: "sha2" }))).toBe(false);
  });
});
