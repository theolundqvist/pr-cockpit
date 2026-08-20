import { describe, expect, test } from "bun:test";
import { matchesQuery, parseQuery } from "./query.ts";
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
    head_sha: "abc",
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
    needs_me_rank: 1,
    greptile_confidence: null,
    greptile_reviewed_sha: null,
    greptile_unresolved_count: 0,
    detail_json: "{}",
    fetched_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("parseQuery", () => {
  test("splits bare terms from qualifiers", () => {
    const parsed = parseQuery("hello author:theo state:open");
    expect(parsed.terms).toEqual(["hello"]);
    expect(parsed.qualifiers.author).toEqual(["theo"]);
    expect(parsed.qualifiers.state).toEqual(["open"]);
  });

  test("unknown qualifier key falls back to a bare term", () => {
    const parsed = parseQuery("label:bug");
    expect(parsed.terms).toEqual(["label:bug"]);
    expect(parsed.qualifiers.state).toEqual([]);
  });

  test("unknown value for a known key falls back to a bare term", () => {
    const parsed = parseQuery("state:banana");
    expect(parsed.terms).toEqual(["state:banana"]);
    expect(parsed.qualifiers.state).toEqual([]);
  });

  test("repeated is: qualifiers accumulate", () => {
    const parsed = parseQuery("is:draft is:archived");
    expect(parsed.qualifiers.is).toEqual(["draft", "archived"]);
  });

  test("qualifier keys and values are case-insensitive", () => {
    const parsed = parseQuery("Author:Theo STATE:OPEN");
    expect(parsed.qualifiers.author).toEqual(["theo"]);
    expect(parsed.qualifiers.state).toEqual(["open"]);
  });

  test("empty query yields no terms or qualifiers", () => {
    const parsed = parseQuery("   ");
    expect(parsed.terms).toEqual([]);
    expect(Object.values(parsed.qualifiers).every((v) => v.length === 0)).toBe(true);
  });
});

describe("matchesQuery", () => {
  test("bare term matches title, repo, number, or branch", () => {
    const row = pr({});
    expect(matchesQuery(row, parseQuery("thing"), false)).toBe(true);
    expect(matchesQuery(row, parseQuery("webapp"), false)).toBe(true);
    expect(matchesQuery(row, parseQuery("#1"), false)).toBe(true);
    expect(matchesQuery(row, parseQuery("staging"), false)).toBe(true);
    expect(matchesQuery(row, parseQuery("nomatch"), false)).toBe(false);
  });

  test("author: filters by exact login, case-insensitive", () => {
    const row = pr({ author: "theolundqvist" });
    expect(matchesQuery(row, parseQuery("author:theolundqvist"), false)).toBe(true);
    expect(matchesQuery(row, parseQuery("author:TheoLundqvist"), false)).toBe(true);
    expect(matchesQuery(row, parseQuery("author:someoneelse"), false)).toBe(false);
  });

  test("state:open matches drafts too (a draft is still an open PR)", () => {
    const draft = pr({ state: "draft", is_draft: 1 });
    expect(matchesQuery(draft, parseQuery("state:open"), false)).toBe(true);
    expect(matchesQuery(draft, parseQuery("state:closed"), false)).toBe(false);
  });

  test("state:merged / state:closed match the stored state", () => {
    const merged = pr({ state: "MERGED" });
    expect(matchesQuery(merged, parseQuery("state:merged"), false)).toBe(true);
    expect(matchesQuery(merged, parseQuery("state:open"), false)).toBe(false);
  });

  test("is:draft checks is_draft regardless of stored state string", () => {
    const draft = pr({ state: "draft", is_draft: 1 });
    const notDraft = pr({ is_draft: 0 });
    expect(matchesQuery(draft, parseQuery("is:draft"), false)).toBe(true);
    expect(matchesQuery(notDraft, parseQuery("is:draft"), false)).toBe(false);
  });

  test("a PR closed while still a draft matches state:closed (raw enum + is_draft, not the live 'draft' mapping)", () => {
    const closedDraft = pr({ state: "CLOSED", is_draft: 1 });
    expect(matchesQuery(closedDraft, parseQuery("state:closed"), false)).toBe(true);
    expect(matchesQuery(closedDraft, parseQuery("state:open"), false)).toBe(false);
    expect(matchesQuery(closedDraft, parseQuery("is:draft state:closed"), false)).toBe(true);
  });

  test("is:archived checks the passed-in archived flag, not a PR column", () => {
    const row = pr({});
    expect(matchesQuery(row, parseQuery("is:archived"), true)).toBe(true);
    expect(matchesQuery(row, parseQuery("is:archived"), false)).toBe(false);
  });

  test("repo: and base: filter on exact values", () => {
    const row = pr({ repo: "example-org/webapp", base_ref: "staging" });
    expect(matchesQuery(row, parseQuery("repo:example-org/webapp"), false)).toBe(true);
    expect(matchesQuery(row, parseQuery("repo:other/repo"), false)).toBe(false);
    expect(matchesQuery(row, parseQuery("base:staging"), false)).toBe(true);
    expect(matchesQuery(row, parseQuery("base:main"), false)).toBe(false);
  });

  test("review:approved / review:required / review:changes_requested map to reviewDecision", () => {
    const approved = pr({ review_decision: "APPROVED" });
    const required = pr({ review_decision: "REVIEW_REQUIRED" });
    const changesRequested = pr({ review_decision: "CHANGES_REQUESTED" });
    expect(matchesQuery(approved, parseQuery("review:approved"), false)).toBe(true);
    expect(matchesQuery(approved, parseQuery("review:required"), false)).toBe(false);
    expect(matchesQuery(required, parseQuery("review:required"), false)).toBe(true);
    expect(matchesQuery(changesRequested, parseQuery("review:changes_requested"), false)).toBe(true);
    expect(matchesQuery(changesRequested, parseQuery("review:required"), false)).toBe(false);
    expect(matchesQuery(changesRequested, parseQuery("review:approved"), false)).toBe(false);
  });

  test("qualifiers AND together, and AND with bare terms", () => {
    const row = pr({ author: "theolundqvist", state: "OPEN", title: "Fix the thing" });
    expect(matchesQuery(row, parseQuery("author:theolundqvist state:open thing"), false)).toBe(true);
    expect(matchesQuery(row, parseQuery("author:theolundqvist state:closed thing"), false)).toBe(false);
    expect(matchesQuery(row, parseQuery("author:theolundqvist nomatch"), false)).toBe(false);
  });

  test("repeated same-key qualifiers never-match (AND, not OR) since a PR can't satisfy contradictory values", () => {
    const row = pr({ author: "theolundqvist" });
    expect(matchesQuery(row, parseQuery("author:theolundqvist author:someoneelse"), false)).toBe(false);
    const draftOnly = pr({ state: "draft", is_draft: 1 });
    expect(matchesQuery(draftOnly, parseQuery("is:draft is:archived"), false)).toBe(false);
    expect(matchesQuery(draftOnly, parseQuery("is:draft is:archived"), true)).toBe(true);
  });

  test("an unknown qualifier is treated as a bare term, never errors", () => {
    const row = pr({ title: "label:bug fix" });
    expect(matchesQuery(row, parseQuery("label:bug"), false)).toBe(true);
  });
});
