import { describe, expect, test } from "bun:test";
import { greptileScoreStatus } from "./http.ts";
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
    head_sha: "headsha",
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
    greptile_confidence: null,
    greptile_reviewed_sha: null,
    greptile_unresolved_count: 0,
    detail_json: "{}",
    fetched_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("greptileScoreStatus", () => {
  test("no score yet is null", () => {
    expect(greptileScoreStatus(pr({}))).toBeNull();
  });

  test("scored but never had a reviewed sha is null (nothing to compare against)", () => {
    expect(greptileScoreStatus(pr({ greptile_confidence: 3 }))).toBeNull();
  });

  test("reviewed sha matches head is live, not stale", () => {
    expect(greptileScoreStatus(pr({ greptile_confidence: 3, greptile_reviewed_sha: "headsha" }))).toBeNull();
  });

  test("commits landed since the review is stale", () => {
    expect(greptileScoreStatus(pr({ greptile_confidence: 3, greptile_reviewed_sha: "oldsha", greptile_unresolved_count: 2 }))).toBe("stale");
  });

  test("stale but every one of that reviewer's threads is resolved is addressed", () => {
    expect(greptileScoreStatus(pr({ greptile_confidence: 3, greptile_reviewed_sha: "oldsha", greptile_unresolved_count: 0 }))).toBe("addressed");
  });
});
