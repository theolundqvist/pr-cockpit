import { describe, expect, test } from "bun:test";
import { agentPrRefs, defaultAutofixTemplate, defaultFixerTemplate, isGreen, mergeStepText, runWindowTurns, turnsFromLines } from "./agents.ts";
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
    head_sha: "sha1",
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

describe("agentPrRefs", () => {
  test("uses a tracked PR when it is in the inbox cache", () => {
    expect(agentPrRefs(pr({ base_ref: "main", head_ref: "tracked" }), null)).toEqual({
      baseRef: "main",
      headRef: "tracked",
    });
  });

  test("uses the detail cache for a PR opened directly by URL", () => {
    expect(agentPrRefs(null, JSON.stringify({ baseRefName: "staging", headRefName: "detail-only" }))).toEqual({
      baseRef: "staging",
      headRef: "detail-only",
    });
  });

  test("rejects malformed and incomplete detail cache entries", () => {
    expect(agentPrRefs(null, "{")).toBeNull();
    expect(agentPrRefs(null, JSON.stringify({ headRefName: "missing-base" }))).toBeNull();
  });
});

describe("isGreen", () => {
  test("green when CI passes, no unresolved threads, and no conflicts", () => {
    expect(isGreen(pr({}))).toBe(true);
  });

  test("not green with failing CI", () => {
    expect(isGreen(pr({ ci_status: "FAILURE" }))).toBe(false);
  });

  test("not green with unresolved review threads", () => {
    expect(isGreen(pr({ unresolved_count: 2 }))).toBe(false);
  });

  test("not green with merge conflicts", () => {
    expect(isGreen(pr({ merge_state_status: "DIRTY" }))).toBe(false);
  });

  test("not green with changes requested", () => {
    expect(isGreen(pr({ review_decision: "CHANGES_REQUESTED" }))).toBe(false);
  });

  test("not green when a required check was skipped or cancelled instead of passing", () => {
    const withRequired = (conclusion: string) => JSON.stringify({
      lastCommit: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [
        { __typename: "CheckRun", name: "trpc compat", status: "COMPLETED", conclusion, isRequired: true },
      ] } } } }] },
    });
    expect(isGreen(pr({ detail_json: withRequired("SKIPPED") }))).toBe(false);
    expect(isGreen(pr({ detail_json: withRequired("CANCELLED") }))).toBe(false);
    expect(isGreen(pr({ detail_json: withRequired("SUCCESS") }))).toBe(true);
  });
});

describe("mergeStepText", () => {
  test("emits a ready-to-merge signal step instead of a gh merge command", () => {
    const step = mergeStepText("example-org/webapp", pr({}));
    expect(step).toContain('write "ready-to-merge" to {{STATUS_FILE}}');
    expect(step).not.toContain("gh pr merge");
  });

  test("never emits a merge step when allowMerge is false, even when ready", () => {
    expect(mergeStepText("example-org/webapp", pr({}), false)).toBe("");
  });

  test("never emits a merge step when the branch is BEHIND - that's an update-branch job, not a merge gate", () => {
    expect(mergeStepText("example-org/webapp", pr({ merge_state_status: "BEHIND" }))).toBe("");
  });
});

describe("defaultFixerTemplate", () => {
  test("uses cached PR state and event-driven waiting", () => {
    const template = defaultFixerTemplate();
    expect(template).toContain("gh pr update-branch");
    expect(template).toContain("pr-cockpit {{REPO}}#{{PR_NUMBER}}");
    expect(template).toContain("pr-cockpit listen {{REPO}}#{{PR_NUMBER}}");
    expect(template).toContain("pr-cockpit {{REPO}}#{{PR_NUMBER}} --jobs");
    expect(template).toContain("pr-cockpit {{REPO}}#{{PR_NUMBER}} --logs");
    expect(template).not.toContain("gh pr view");
    expect(template).not.toContain("gh run view");
  });
});

describe("defaultAutofixTemplate", () => {
  test("uses cached PR state and event-driven waiting while preserving update-branch handling", () => {
    const template = defaultAutofixTemplate();
    expect(template).toContain("BEHIND");
    expect(template).toContain("gh pr update-branch");
    expect(template).toContain("pr-cockpit {{REPO}}#{{PR_NUMBER}}");
    expect(template).toContain("pr-cockpit listen {{REPO}}#{{PR_NUMBER}}");
    expect(template).toContain("pr-cockpit {{REPO}}#{{PR_NUMBER}} --jobs");
    expect(template).toContain("pr-cockpit {{REPO}}#{{PR_NUMBER}} --logs");
    expect(template).not.toContain("gh pr view");
    expect(template).not.toContain("gh run view");
  });
});

describe("turnsFromLines", () => {
  test("renders assistant text and tool_use blocks as separate turns", () => {
    const lines = [
      JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:00:01Z", message: { content: [{ type: "text", text: "looking at the failing check" }] } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-01-01T00:00:02Z", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "gh pr view 1" } }] } }),
      JSON.stringify({ type: "result", timestamp: "2026-01-01T00:00:03Z", result: "fixed the lint error", is_error: false }),
    ];
    expect(turnsFromLines(lines)).toEqual([
      { ts: "2026-01-01T00:00:01Z", kind: "text", text: "looking at the failing check" },
      { ts: "2026-01-01T00:00:02Z", kind: "tool", toolName: "Bash", toolInput: { command: "gh pr view 1" } },
      { ts: "2026-01-01T00:00:03Z", kind: "result", text: "fixed the lint error", isError: false },
    ]);
  });

  test("skips malformed lines instead of throwing", () => {
    expect(turnsFromLines(["not json", "{}"])).toEqual([]);
  });

  test("reads omp's message_end / agent_end events, dropping the duplicated message_start and non-assistant roles", () => {
    const assistant = {
      role: "assistant",
      timestamp: 1786256590941,
      content: [
        { type: "thinking", thinking: "" },
        { type: "text", text: "running the check" },
        { type: "toolCall", id: "t1", name: "bash", arguments: { command: "bun test", i: "Run tests" } },
      ],
    };
    const lines = [
      JSON.stringify({ type: "message_start", message: assistant }),
      JSON.stringify({ type: "message_end", message: assistant }),
      JSON.stringify({ type: "message_end", message: { role: "toolResult", timestamp: 1786256591000, content: [{ type: "text", text: "ok" }] } }),
      JSON.stringify({ type: "agent_end", messages: [assistant, { role: "assistant", content: [{ type: "text", text: "tests pass" }] }] }),
    ];
    const ts = new Date(1786256590941).toISOString();
    expect(turnsFromLines(lines)).toEqual([
      { ts, kind: "text", text: "running the check" },
      { ts, kind: "tool", toolName: "bash", toolInput: { command: "bun test", i: "Run tests" } },
      { ts: new Date(1786256591000).toISOString(), kind: "result", text: "tests pass", isError: false },
    ]);
  });
});

describe("runWindowTurns", () => {
  const turn = (ts: string) => ({ ts, kind: "text" as const, text: ts });

  test("keeps only the turns inside a finished run's window, so a log shared with the next run isn't mixed in", () => {
    const early = turn("2026-01-01T00:00:01Z");
    const late = turn("2026-01-01T00:00:05Z");
    const nextRun = turn("2026-01-02T00:00:00Z");
    expect(runWindowTurns([early, late, nextRun], { started_at: "2026-01-01T00:00:00Z", ended_at: "2026-01-01T00:00:10Z" })).toEqual([early, late]);
  });

  test("a running run keeps everything after its start, and undated turns always survive", () => {
    const previousRun = turn("2025-12-31T23:59:59Z");
    const undated = turn("");
    const mine = turn("2026-01-02T00:00:00Z");
    expect(runWindowTurns([previousRun, undated, mine], { started_at: "2026-01-01T00:00:00Z", ended_at: null })).toEqual([undated, mine]);
  });
});
