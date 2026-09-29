import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPrRefs, isGreen, mergeStepText, readyToMerge, runWindowTurns, turnsFromLines } from "./agents.ts";
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

describe("readyToMerge", () => {
  test("unfinished checks never pass the server merge gate", () => {
    expect(readyToMerge(pr({ ci_status: "PENDING" }))).toBe(false);
    expect(readyToMerge(pr({ ci_status: "EXPECTED" }))).toBe(false);
    expect(readyToMerge(pr({ ci_status: "NONE" }))).toBe(true);
  });

  test("a force-merge BLOCKED state needs every check finished and passing", () => {
    expect(readyToMerge(pr({ merge_state_status: "BLOCKED", ci_status: "PENDING" }))).toBe(false);
    expect(readyToMerge(pr({ merge_state_status: "BLOCKED", ci_status: "NONE" }))).toBe(false);
    expect(readyToMerge(pr({ merge_state_status: "BLOCKED", ci_status: "SUCCESS" }))).toBe(true);
  });
});

test("a one-shot prompt run interrupted by a restart is marked died, never resumed as the merging fixer", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-agent-resume-"));
  const workdir = join(dataDir, "agents", "fixture-cockpit-101");
  mkdirSync(workdir, { recursive: true });
  // db.ts touches its database at import, so the restart runs in a child with an isolated data dir;
  // the state is read synchronously, before any resumed supervisor could reach a harness
  const scenario = `
    const { db } = await import(${JSON.stringify(new URL("./db.ts", import.meta.url).href)});
    const agents = await import(${JSON.stringify(new URL("./agents.ts", import.meta.url).href)});
    const { seedMockDatabase } = await import(${JSON.stringify(new URL("./mockGithub.ts", import.meta.url).href)});
    seedMockDatabase(db, ${JSON.stringify(dataDir)});
    db.run("INSERT INTO fixer_agents (repo, number, pid, pid_started, state, started_at, workdir, log_path, kind, agent_id) VALUES ('fixture/cockpit', 101, 0, '', 'running', '2026-01-01T00:00:00Z', ?, ?, 'prompt', '')", [${JSON.stringify(workdir)}, ${JSON.stringify(`${workdir}.log`)}]);
    agents.startFixerSupervision();
    console.log(JSON.stringify(agents.getFixerAgent("fixture/cockpit", 101)));
    process.exit(0);
  `;
  try {
    const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", scenario], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr);
    expect(JSON.parse(stdout)).toMatchObject({ kind: "prompt", state: "died" });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

describe("mergeStepText", () => {
  test("only an agent with merge permission is told to signal ready-to-merge", () => {
    expect(mergeStepText("example-org/webapp")).toContain('"ready-to-merge"');
    expect(mergeStepText("example-org/webapp", false)).toBe("");
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

  test("reads Codex command, final-message, and failure events", () => {
    const command = { id: "item_1", type: "command_execution", command: "bun test", status: "in_progress" };
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({ type: "item.started", item: command }),
      JSON.stringify({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "tests pass" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }),
      JSON.stringify({ type: "error", message: "connection failed" }),
      JSON.stringify({ type: "turn.failed", error: { message: "authentication failed" } }),
    ];
    expect(turnsFromLines(lines)).toEqual([
      { ts: "", kind: "tool", toolName: "command_execution", toolInput: command },
      { ts: "", kind: "text", text: "tests pass" },
      { ts: "", kind: "result", text: "connection failed", isError: true },
      { ts: "", kind: "result", text: "authentication failed", isError: true },
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
