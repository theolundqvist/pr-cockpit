import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentPrRefs, isGreen, parseFixerStatus, runWindowTurns, turnsFromLines } from "./agents.ts";
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

  test("unfinished checks never count as green", () => {
    expect(isGreen(pr({ ci_status: "PENDING" }))).toBe(false);
    expect(isGreen(pr({ ci_status: "EXPECTED" }))).toBe(false);
    expect(isGreen(pr({ ci_status: "NONE" }))).toBe(true);
  });

  test("a mergeable but not CLEAN state is never green", () => {
    expect(isGreen(pr({ merge_state_status: "UNSTABLE" }))).toBe(false);
    expect(isGreen(pr({ merge_state_status: "BLOCKED" }))).toBe(false);
  });
});

const VERIFIED = "0123456789abcdef0123456789abcdef01234567";

describe("parseFixerStatus", () => {
  test("a ready signal names the verified head and needs a clean harness exit", () => {
    expect(parseFixerStatus(`ready-to-merge ${VERIFIED}\n`, 0)).toEqual({ status: "ready-to-merge", sha: VERIFIED, refusal: null });
    const crashed = parseFixerStatus(`ready-to-merge ${VERIFIED}`, 1);
    expect(crashed).toMatchObject({ status: "continue", sha: null });
    expect(crashed.refusal).toBeTruthy();
  });

  test("a bare or malformed ready signal is refused back to the agent, never merged", () => {
    for (const text of ["ready-to-merge", `ready-to-merge ${VERIFIED.slice(0, 7)}`, `ready-to-merge ${VERIFIED.toUpperCase()}`, `ready-to-merge ${VERIFIED} extra`]) {
      const parsed = parseFixerStatus(text, 0);
      expect(parsed).toMatchObject({ status: "continue", sha: null });
      expect(parsed.refusal).toBeTruthy();
    }
  });

  test("other statuses pass through, and unknown or missing ones mean continue without a refusal", () => {
    expect(parseFixerStatus("waiting-review\n", 0)).toEqual({ status: "waiting-review", sha: null, refusal: null });
    expect(parseFixerStatus("gave-up", 1)).toEqual({ status: "gave-up", sha: null, refusal: null });
    expect(parseFixerStatus("done", 0)).toEqual({ status: "continue", sha: null, refusal: null });
    expect(parseFixerStatus(null, 0)).toEqual({ status: "continue", sha: null, refusal: null });
  });
});

test("the fixer merge gate trusts local verification over remote CI but never GitHub's own merge blockers", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-fixer-gate-"));
  const repo = "example-org/webapp";
  const cases = {
    pendingCi: pr({ head_sha: VERIFIED, ci_status: "PENDING" }),
    nonRequiredFailure: pr({ head_sha: VERIFIED, ci_status: "FAILURE", merge_state_status: "UNSTABLE" }),
    headDrift: pr({ head_sha: "f".repeat(40) }),
    closed: pr({ head_sha: VERIFIED, state: "CLOSED" }),
    draft: pr({ head_sha: VERIFIED, is_draft: 1, merge_state_status: "DRAFT" }),
    conflicting: pr({ head_sha: VERIFIED, mergeable: "CONFLICTING", merge_state_status: "DIRTY" }),
    mergeabilityUnknown: pr({ head_sha: VERIFIED, mergeable: "UNKNOWN", merge_state_status: "BLOCKED" }),
    behind: pr({ head_sha: VERIFIED, merge_state_status: "BEHIND" }),
    changesRequested: pr({ head_sha: VERIFIED, review_decision: "CHANGES_REQUESTED" }),
    unresolved: pr({ head_sha: VERIFIED, unresolved_count: 1 }),
    blocked: pr({ head_sha: VERIFIED, merge_state_status: "BLOCKED", ci_status: "PENDING" }),
    unknownState: pr({ head_sha: VERIFIED, merge_state_status: "UNKNOWN" }),
  };
  // force_merge_repos lives in the database db.ts opens at import, so the opt-in flips in a child with an isolated data dir
  const scenario = `
    const { setSetting } = await import(${JSON.stringify(new URL("./db.ts", import.meta.url).href)});
    const { fixerMergeRefusal } = await import(${JSON.stringify(new URL("./agents.ts", import.meta.url).href)});
    const cases = ${JSON.stringify(cases)};
    const gate = () => Object.fromEntries(Object.entries(cases).map(([name, row]) => [name, fixerMergeRefusal(${JSON.stringify(repo)}, row, ${JSON.stringify(VERIFIED)})]));
    setSetting("force_merge_repos", "");
    const plain = gate();
    setSetting("force_merge_repos", ${JSON.stringify(repo)});
    console.log(JSON.stringify({ plain, forced: gate() }));
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
    const { plain, forced } = JSON.parse(stdout) as Record<"plain" | "forced", Record<keyof typeof cases, string | null>>;
    expect(plain.pendingCi).toBeNull();
    expect(plain.nonRequiredFailure).toBeNull();
    for (const name of ["headDrift", "closed", "draft", "conflicting", "mergeabilityUnknown", "behind", "changesRequested", "unresolved", "blocked", "unknownState"] as const) {
      expect(plain[name]).not.toBeNull();
    }
    // the opt-in lets BLOCKED through and nothing else
    expect(forced.blocked).toBeNull();
    expect({ ...forced, blocked: plain.blocked }).toEqual(plain);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
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
