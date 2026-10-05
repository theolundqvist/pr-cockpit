import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("agent conversations union live agents and run history, running first then latest activity, from caches only", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-agent-conversations-"));
  // db.ts opens its database at import, so the listing runs in a child with an isolated data dir
  const scenario = `
    const { db } = await import(${JSON.stringify(new URL("./db.ts", import.meta.url).href)});
    const agents = await import(${JSON.stringify(new URL("./agents.ts", import.meta.url).href)});
    const agent = db.prepare("INSERT INTO fixer_agents (repo, number, pid, pid_started, state, started_at, workdir, log_path, kind, agent_id) VALUES (?, ?, 0, '', ?, ?, '/w', '/w.log', 'prompt', '')");
    const run = db.prepare("INSERT INTO agent_runs (repo, number, kind, agent_id, state, started_at, ended_at, workdir, log_path, brief) VALUES (?, ?, 'fixer', '', ?, ?, ?, '/w', '/w.log', 'brief')");
    // an idle agent with no recorded runs, titled only by the PR detail cache
    agent.run("fixture/idle", 1, "exited", "2026-01-03T00:00:00.000Z");
    db.run("INSERT INTO pr_detail_cache (repo, number, head_sha, detail_json, fetched_at) VALUES ('fixture/idle', 1, 'a', ?, '2026-01-03T00:00:00.000Z')", [JSON.stringify({ title: "Detail-only title" })]);
    // the oldest start, but running now; its unreadable detail cache leaves it untitled
    agent.run("fixture/live", 2, "running", "2026-01-01T00:00:00.000Z");
    run.run("fixture/live", 2, "running", "2026-01-01T00:00:00.000Z", null);
    db.run("INSERT INTO pr_detail_cache (repo, number, head_sha, detail_json, fetched_at) VALUES ('fixture/live', 2, 'b', '{', '2026-01-01T00:00:00.000Z')");
    // a closed PR whose agent row is gone: history alone lists it, ranked by its latest end
    run.run("fixture/closed", 3, "exited", "2026-01-01T00:00:00.000Z", "2026-01-01T01:00:00.000Z");
    run.run("fixture/closed", 3, "merged", "2026-01-02T00:00:00.000Z", "2026-01-05T00:00:00.000Z");
    db.run("INSERT INTO pr_index (repo, number, title, state, is_draft, author, updated_at) VALUES ('fixture/closed', 3, 'Closed history', 'CLOSED', 0, 'octocat', '2026-01-05T00:00:00.000Z')");
    console.log(JSON.stringify(agents.listAgentConversations()));
    process.exit(0);
  `;
  try {
    const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", scenario], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr);
    const conversations = JSON.parse(stdout) as Array<{ repo: string; number: number; title: string | null; agent: { state: string } | null; runs: Array<{ state: string; started_at: string }> }>;
    expect(conversations.map(({ repo, number, title }) => ({ repo, number, title }))).toEqual([
      { repo: "fixture/live", number: 2, title: null },
      { repo: "fixture/closed", number: 3, title: "Closed history" },
      { repo: "fixture/idle", number: 1, title: "Detail-only title" },
    ]);
    expect(conversations[0]!.agent).toMatchObject({ state: "running" });
    expect(conversations[0]!.runs.map((r) => r.state)).toEqual(["running"]);
    expect(conversations[1]!.agent).toBeNull();
    expect(conversations[1]!.runs.map((r) => r.state)).toEqual(["merged", "exited"]);
    expect(conversations[2]!.agent).toMatchObject({ state: "exited" });
    expect(conversations[2]!.runs).toEqual([]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

const FIXTURE_HEAD = "0000000000000000000000000000000000002774";

// db.ts opens its database at import, so one child seeds the screenshot fixture and a second runs live (non-mock)
// Cockpit code against it. Every GitHub API request is recorded and answered "quota exhausted"; gh and the harness
// are stubs first on PATH, and https://github.com/ clones resolve to a local bare repository.
async function liveAgentScenario(scenario: string): Promise<{ result: unknown; ghCalls: string[]; clones: Array<{ exitCode: number | null; stderr: string; branch: string | null }> }> {
  const dir = mkdtempSync(join(tmpdir(), "pr-cockpit-agent-live-"));
  const dataDir = join(dir, "data");
  const bin = join(dir, "bin");
  const out = join(dir, "out");
  for (const path of [dataDir, bin, out]) mkdirSync(path);
  const git = (...args: string[]) => {
    const proc = Bun.spawnSync(["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.com", ...args], { stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  };
  const remote = join(dir, "remote", "fixture", "cockpit.git");
  git("init", "--bare", "--quiet", remote);
  const work = join(dir, "work");
  git("init", "--quiet", work);
  git("-C", work, "commit", "--quiet", "--allow-empty", "-m", "fixture");
  git("-C", work, "push", "--quiet", remote, "HEAD:refs/heads/main", "HEAD:refs/heads/fixture/pr-101", "HEAD:refs/pull/101/head");
  writeFileSync(join(bin, "gh"), `#!/bin/sh
printf '%s\\n' "$*" >> "$STUB_OUT/gh-calls"
case "$1 $2" in
  "auth token") echo stub-token ;;
  *) echo "stub gh spends no API quota: $*" >&2; exit 1 ;;
esac
`);
  // runs the clone the prompt names while the workdir is still empty, then reports the configured status
  writeFileSync(join(bin, "omp"), `#!/usr/bin/env bun
import { readdirSync, writeFileSync } from "node:fs";
const prompt = process.argv.at(-1);
const out = process.env.STUB_OUT;
const n = readdirSync(out).filter((name) => name.startsWith("prompt-")).length;
writeFileSync(out + "/prompt-" + n + ".txt", prompt);
const clone = /if it is empty then, run \`([^\`]+)\`/.exec(prompt)?.[1];
if (clone && readdirSync(".").length === 0) {
  const proc = Bun.spawnSync(["sh", "-c", clone], { stdout: "pipe", stderr: "pipe" });
  const head = Bun.spawnSync(["git", "symbolic-ref", "-q", "--short", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  writeFileSync(out + "/clone-" + n + ".json", JSON.stringify({ exitCode: proc.exitCode, stderr: proc.stderr.toString(), branch: head.exitCode === 0 ? head.stdout.toString().trim() : null }));
}
for (const file of [".prompt-status", ".autofix-status", ".custom-status"]) writeFileSync(file, process.env.STUB_STATUS ?? "done");
process.exit(Number(process.env.STUB_EXIT ?? 0));
`);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "omp"), 0o755);
  const module = (name: string) => JSON.stringify(new URL(`./${name}`, import.meta.url).href);
  const seed = `
    const { db } = await import(${module("db.ts")});
    await import(${module("agents.ts")});
    const { seedMockDatabase } = await import(${module("mockGithub.ts")});
    seedMockDatabase(db, ${JSON.stringify(dataDir)});
    process.exit(0);
  `;
  const live = `
    const githubCalls = [];
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      githubCalls.push((init?.method ?? "GET") + " " + url);
      return Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: {
        "x-ratelimit-resource": url.endsWith("/graphql") ? "graphql" : "core",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
      } });
    };
    const { db, setSetting } = await import(${module("db.ts")});
    setSetting("agent_harness", "omp");
    const agents = await import(${module("agents.ts")});
    // launches return before their real harness process exits, and only the agent row records the outcome
    const waitForExit = async (repo, number) => {
      for (let i = 0; i < 500 && agents.getFixerAgent(repo, number)?.state === "running"; i++) await Bun.sleep(20);
      return agents.getFixerAgent(repo, number);
    };
    ${scenario}
    process.exit(0);
  `;
  const run = async (code: string, env: Record<string, string>) => {
    const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", code], { env, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr);
    return stdout;
  };
  try {
    await run(seed, { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "1" });
    const { COCKPIT_MOCK: _mock, ...env } = Bun.env;
    const stdout = await run(live, {
      ...env,
      COCKPIT_DATA_DIR: dataDir,
      COCKPIT_GH_BIN: join(bin, "gh"),
      PATH: `${bin}:${Bun.env.PATH}`,
      STUB_OUT: out,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.file://${join(dir, "remote")}/.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/",
    });
    const read = (name: string) => { try { return readFileSync(join(out, name), "utf8"); } catch { return null; } };
    const clones = [];
    for (let n = 0; read(`prompt-${n}.txt`) !== null; n++) {
      const clone = read(`clone-${n}.json`);
      if (clone) clones.push(JSON.parse(clone));
    }
    return { result: JSON.parse(stdout.trim().split("\n").at(-1)!), ghCalls: (read("gh-calls") ?? "").split("\n").filter(Boolean), clones };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("cached PRs launch prompt, auto-fix, and custom agents while GitHub's API quota is exhausted", async () => {
  const { result, ghCalls, clones } = await liveAgentScenario(`
    const { getViewerLogin } = await import(${JSON.stringify(new URL("./github.ts", import.meta.url).href)});
    const { buildFetchHandler } = await import(${JSON.stringify(new URL("./http.ts", import.meta.url).href)});
    // the screenshot's state: the first 403 records core as exhausted, and later core reads fail fast on that record
    await getViewerLogin().catch(() => {});
    const blocked = await getViewerLogin().then(() => null, (err) => String(err));
    githubCalls.length = 0;
    db.run("UPDATE prs SET detail_json = json_set(detail_json, '$.headRepository', json('{\\"nameWithOwner\\":\\"fixture/cockpit\\"}')) WHERE number = 101");
    setSetting("agents", JSON.stringify([{ id: "custom-tidy", name: "Tidy", enabled: true, trigger: "keybind", keybind: null, model: "opus", prompt_template: "Tidy {{REPO}}#{{PR_NUMBER}}" }]));
    db.run("UPDATE prs SET ci_status = 'FAILURE' WHERE number = 101");
    const handler = buildFetchHandler(4820, { cacheGithubActionsForCommit: async () => {} });
    const launches = [];
    for (const [path, body, status] of [
      ["prompt", { instruction: "Fix the P1 and P2 review comments" }, "done"],
      ["autofix", {}, "gave-up"],
      ["custom", { agentId: "custom-tidy" }, "done"],
    ]) {
      process.env.STUB_STATUS = status;
      const response = await handler(new Request("http://127.0.0.1:4820/api/agents/" + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: "fixture/cockpit", number: 101, ...body }),
      }));
      const launchCalls = [...githubCalls];
      const agent = await waitForExit("fixture/cockpit", 101);
      launches.push({ path, status: response.status, body: await response.json(), launchCalls, state: agent?.state, exitReason: agent?.exit_reason });
    }
    console.log(JSON.stringify({ blocked, launches, githubCalls }));
  `);
  const { blocked, launches, githubCalls } = result as { blocked: string; launches: unknown[]; githubCalls: string[] };
  expect(blocked).toContain("GitHub core quota exhausted until");
  expect(launches).toEqual([
    { path: "prompt", status: 200, body: { ok: true }, launchCalls: [], state: "exited", exitReason: "done" },
    { path: "autofix", status: 200, body: { ok: true }, launchCalls: [], state: "exited", exitReason: "gave-up" },
    { path: "custom", status: 200, body: { ok: true }, launchCalls: [], state: "exited", exitReason: "done" },
  ]);
  // briefs come from the cached snapshot, and the agents' own checkout goes through git, not the GitHub API
  expect(githubCalls).toEqual([]);
  expect(clones[0]?.exitCode).toBe(0);
  expect(clones[0]?.branch).toBe("fixture/pr-101");
  expect(clones.every((clone) => clone.exitCode === 0)).toBe(true);
  expect(ghCalls).toEqual(["auth token"]);
});

test("legacy cached PR launches without fetching its unknown head repository or inventing push permission", async () => {
  const { result, ghCalls, clones } = await liveAgentScenario(`
    const { getViewerLogin } = await import(${JSON.stringify(new URL("./github.ts", import.meta.url).href)});
    const { buildFetchHandler } = await import(${JSON.stringify(new URL("./http.ts", import.meta.url).href)});
    await getViewerLogin().catch(() => {});
    githubCalls.length = 0;
    process.env.STUB_STATUS = "done";
    const handler = buildFetchHandler(4820, { cacheGithubActionsForCommit: async () => {} });
    const response = await handler(new Request("http://127.0.0.1:4820/api/agents/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "fixture/cockpit", number: 101, instruction: "Inspect the PR" }),
    }));
    const agent = await waitForExit("fixture/cockpit", 101);
    console.log(JSON.stringify({ status: response.status, body: await response.json(), exitReason: agent?.exit_reason, githubCalls }));
  `);
  expect(result).toEqual({ status: 200, body: { ok: true }, exitReason: "done", githubCalls: [] });
  expect(clones.map((clone) => [clone.exitCode, clone.branch])).toEqual([[0, null]]);
  expect(ghCalls).toEqual(["auth token"]);
});

test("a prompt agent's ready signal merges only the head Cockpit re-verifies, and says when GitHub is unavailable", async () => {
  const { result } = await liveAgentScenario(`
    const { mock } = await import("bun:test");
    const { GithubRequestError } = await import(${JSON.stringify(new URL("./github.ts", import.meta.url).href)});
    const pollerUrl = ${JSON.stringify(new URL("./poller.ts", import.meta.url).href)};
    const mergeMethodUrl = ${JSON.stringify(new URL("./mergeMethod.ts", import.meta.url).href)};
    const pollerModule = await import(pollerUrl);
    const mergeMethodModule = await import(mergeMethodUrl);
    let refresh = async () => {};
    const merges = [];
    mock.module(pollerUrl, () => ({ ...pollerModule, refreshPr: (...args) => refresh(...args) }));
    mock.module(mergeMethodUrl, () => ({ ...mergeMethodModule, mergeWithLearning: async (...args) => { merges.push(args); } }));
    const outcomes = {};
    const cases = {
      verified: [${JSON.stringify(`ready-to-merge ${FIXTURE_HEAD}`)}, "0", async () => {}],
      headDrift: [${JSON.stringify(`ready-to-merge ${FIXTURE_HEAD}`)}, "0", async () => { db.run("UPDATE prs SET head_sha = ? WHERE number = 101", ["f".repeat(40)]); }],
      uncleanExit: [${JSON.stringify(`ready-to-merge ${FIXTURE_HEAD}`)}, "1", async () => {}],
      quota: [${JSON.stringify(`ready-to-merge ${FIXTURE_HEAD}`)}, "0", async () => { throw new GithubRequestError("GitHub graphql quota exhausted until later", 403, [], "quota", "graphql", "later"); }],
      noMergeAsked: ["done", "0", async () => {}],
    };
    for (const [name, [status, exit, onRefresh]] of Object.entries(cases)) {
      db.run("UPDATE prs SET head_sha = ? WHERE number = 101", [${JSON.stringify(FIXTURE_HEAD)}]);
      merges.length = 0;
      refresh = onRefresh;
      process.env.STUB_STATUS = status;
      process.env.STUB_EXIT = exit;
      await agents.launchPromptAgent("fixture/cockpit", 101, name === "noMergeAsked" ? "Fix the P1 and P2 review comments" : "Fix the P1 and P2 review comments, then merge it");
      const agent = await waitForExit("fixture/cockpit", 101);
      outcomes[name] = { exitReason: agent?.exit_reason, merges: merges.map((args) => args.slice(0, 4)) };
    }
    console.log(JSON.stringify(outcomes));
  `);
  expect(result).toEqual({
    verified: { exitReason: "merged", merges: [["fixture/cockpit", 101, "main", FIXTURE_HEAD]] },
    headDrift: { exitReason: "merge-refused", merges: [] },
    uncleanExit: { exitReason: "merge-refused", merges: [] },
    quota: { exitReason: "merge-unavailable", merges: [] },
    noMergeAsked: { exitReason: "done", merges: [] },
  });
});

test("a direct-URL PR can merge after a fresh detail-cache read without joining the tracked inbox", async () => {
  const { result } = await liveAgentScenario(`
    const { mock } = await import("bun:test");
    const { getPr, getCachedPrDetail, upsertCachedPrDetail } = await import(${JSON.stringify(new URL("./db.ts", import.meta.url).href)});
    const cacheModuleUrl = ${JSON.stringify(new URL("./cachedPrDetail.ts", import.meta.url).href)};
    const mergeModuleUrl = ${JSON.stringify(new URL("./mergeMethod.ts", import.meta.url).href)};
    const cacheModule = await import(cacheModuleUrl);
    const mergeModule = await import(mergeModuleUrl);
    const original = getPr("fixture/cockpit", 101);
    upsertCachedPrDetail({ repo: original.repo, number: original.number, head_sha: original.head_sha, detail_json: original.detail_json, fetched_at: original.fetched_at });
    db.run("DELETE FROM prs WHERE repo = ? AND number = ?", ["fixture/cockpit", 101]);
    const merges = [];
    let currentHead = ${JSON.stringify(FIXTURE_HEAD)};
    mock.module(cacheModuleUrl, () => ({ ...cacheModule, refreshCachedPrDetail: async () => {
      const row = getCachedPrDetail("fixture/cockpit", 101);
      const detail = JSON.parse(row.detail_json);
      detail.headRefOid = currentHead;
      upsertCachedPrDetail({ ...row, head_sha: currentHead, detail_json: JSON.stringify(detail), fetched_at: "3000-01-01T00:00:00.000Z" });
    } }));
    mock.module(mergeModuleUrl, () => ({ ...mergeModule, mergeWithLearning: async (...args) => { merges.push(args.slice(0, 4)); } }));
    process.env.STUB_STATUS = ${JSON.stringify(`ready-to-merge ${FIXTURE_HEAD}`)};
    const outcomes = {};
    for (const [name, head] of [["valid", ${JSON.stringify(FIXTURE_HEAD)}], ["headDrift", "f".repeat(40)]]) {
      currentHead = head;
      merges.length = 0;
      await agents.launchPromptAgent("fixture/cockpit", 101, "Merge this PR when ready");
      const agent = await waitForExit("fixture/cockpit", 101);
      outcomes[name] = { exitReason: agent?.exit_reason, merges: [...merges], tracked: getPr("fixture/cockpit", 101) !== null };
    }
    console.log(JSON.stringify(outcomes));
  `);
  expect(result).toEqual({
    valid: { exitReason: "merged", merges: [["fixture/cockpit", 101, "main", FIXTURE_HEAD]], tracked: false },
    headDrift: { exitReason: "merge-refused", merges: [], tracked: false },
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
