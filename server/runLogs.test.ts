import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runLogsUrl = new URL("./runLogs.ts", import.meta.url).href;
const dbUrl = new URL("./db.ts", import.meta.url).href;

async function runScenario(prefix: string, scenario: string): Promise<Record<string, any>> {
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  try {
    const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", scenario], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr);
    return JSON.parse(stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const seed = `
  const head = "a".repeat(40);
  dbm.upsertPr({
    repo: "acme/app", number: 7, state: "OPEN", is_draft: 0, title: "Cache Actions",
    author: "theo", base_ref: "main", head_ref: "feature", head_sha: head,
    updated_at: "2026-08-24T10:00:00Z", additions: 1, deletions: 0, changed_files: 1,
    commit_count: 1, mergeable: "MERGEABLE", merge_state_status: "CLEAN",
    auto_merge_enabled: 0, viewer_is_author: 1, viewer_review_requested: 0,
    viewer_review_state: null, ci_status: "PENDING", review_decision: null,
    unresolved_count: 0, needs_me_rank: 0, greptile_confidence: null,
    greptile_reviewed_sha: null, greptile_unresolved_count: 0,
    detail_json: JSON.stringify({ headRefOid: head }), fetched_at: "2026-08-24T10:00:00Z",
  });
`;

test("event ingestion is monotonic, runner-complete, REST-free without a lease, and head-only", async () => {
  const result = await runScenario("pr-cockpit-actions-events-", `
    const actions = await import(${JSON.stringify(runLogsUrl)});
    const dbm = await import(${JSON.stringify(dbUrl)});
    ${seed}
    let restCalls = 0;
    const fetchers = {
      fetchWorkflowRuns: async () => { restCalls++; return []; },
      fetchRunJobs: async () => { restCalls++; return []; },
      fetchJobLog: async () => { restCalls++; return ""; },
      restRemaining: async () => { restCalls++; return 5000; },
    };
    const job = (status, conclusion, runnerName = null) => ({ job: {
      id: 31, runId: 20, attempt: 1, headSha: head, headBranch: "feature",
      workflowName: "CI", name: "test", status, conclusion, startedAt: null,
      completedAt: status === "completed" ? "2026-08-24T10:03:00Z" : null,
      htmlUrl: null, runnerName, runnerGroupName: runnerName ? "hosted" : null,
      labels: runnerName ? ["ubuntu-latest"] : [], failedStep: conclusion === "failure" ? "bun test" : null,
    } });
    await actions.ingestActionsState("acme/app", job("queued", null), fetchers);
    await actions.ingestActionsState("acme/app", job("in_progress", null, "runner-4"), fetchers);
    await actions.ingestActionsState("acme/app", job("completed", "failure", "runner-4"), fetchers);
    await actions.ingestActionsState("acme/app", job("in_progress", null, "runner-9"), fetchers);
    await actions.ingestActionsState("acme/app", job("queued", null), fetchers);
    const run = (status, conclusion, eventAt) => ({ run: {
      id: 20, attempt: 1, headSha: head, headBranch: "feature", workflowName: "CI",
      status, conclusion, eventAt, htmlUrl: null,
    } });
    await actions.ingestActionsState("acme/app", run("queued", null, "2026-08-24T10:00:00Z"), fetchers);
    await actions.ingestActionsState("acme/app", run("completed", "failure", "2026-08-24T10:04:00Z"), fetchers);
    await actions.ingestActionsState("acme/app", run("queued", null, "2026-08-24T10:05:00Z"), fetchers);
    await actions.ingestActionsState("acme/app", { job: { ...job("completed", "failure").job, id: 32, headSha: "b".repeat(40), headBranch: "main" } }, fetchers);
    await actions.ingestActionsState("acme/app", run("in_progress", null, "2026-08-24T10:06:00Z"), fetchers);
    const compact = actions.compactActionsPayload("workflow_job", { workflow_job: {
      id: 40, run_id: 22, run_attempt: 1, head_sha: head, head_branch: "feature",
      workflow_name: "CI", name: "build", status: "in_progress", conclusion: null,
      started_at: null, completed_at: null, html_url: null, runner_name: "runner-8",
      runner_group_name: "self-hosted", labels: ["arm64"], steps: [],
    } });
    await actions.ingestActionsState("acme/app", compact, fetchers);
    console.log(JSON.stringify({
      restCalls,
      jobs: dbm.db.query("SELECT job_id,status,conclusion,runner_name,runner_group_name,labels_json,failed_step FROM run_jobs ORDER BY job_id").all(),
      jobsOutput: actions.formatRunJobs(head, dbm.listRunJobs("acme/app", head)),
      runs: dbm.db.query("SELECT status,conclusion FROM workflow_runs").all(),
    }));
  `);
  expect(result.restCalls).toBe(0);
  expect(result.jobs).toEqual([
    { job_id: 31, status: "completed", conclusion: "failure", runner_name: "runner-4", runner_group_name: "hosted", labels_json: "[\"ubuntu-latest\"]", failed_step: "bun test" },
    { job_id: 40, status: "in_progress", conclusion: null, runner_name: "runner-8", runner_group_name: "self-hosted", labels_json: "[\"arm64\"]", failed_step: null },
  ]);
  expect(result.runs).toEqual([{ status: "completed", conclusion: "failure" }]);
  expect(result.jobsOutput).toContain("runner hosted/runner-4");
});

test("a terminal job event normalizes stale status and caches a rerun log", async () => {
  const result = await runScenario("pr-cockpit-actions-terminal-job-", `
    const actions = await import(${JSON.stringify(runLogsUrl)});
    const dbm = await import(${JSON.stringify(dbUrl)});
    ${seed}
    dbm.db.query("INSERT INTO actions_leases(repo,number,head_sha,expires_at,bootstrapped_at) VALUES(?,?,?,?,?)")
      .run("acme/app", 7, head, "2099-08-24T10:00:00Z", "2026-08-24T10:00:00Z");
    let logFetches = 0;
    const fetchers = {
      fetchWorkflowRuns: async () => [],
      fetchRunJobs: async () => [],
      fetchJobLog: async () => { logFetches++; return "rerun failure evidence"; },
      restRemaining: async () => 5000,
    };
    await actions.ingestActionsState("acme/app", { job: {
      id: 41, runId: 20, attempt: 2, headSha: head, headBranch: "feature",
      workflowName: "CI", name: "rerun", status: "in_progress", conclusion: "failure",
      startedAt: "2026-08-24T10:00:00Z", completedAt: "2026-08-24T10:03:00Z",
      htmlUrl: "https://github.com/acme/app/actions/runs/20/job/41", runnerName: "runner-4",
      runnerGroupName: "hosted", labels: ["arm64"], failedStep: "bun test",
    } }, fetchers);
    const cached = await actions.cachedJobLogs("acme/app", head);
    const selected = await actions.actionJobLog("acme/app", head, 41, fetchers);
    console.log(JSON.stringify({
      logFetches,
      row: dbm.db.query("SELECT status,conclusion,log_gz IS NOT NULL AS logged FROM run_jobs WHERE job_id=41").get(),
      cachedBody: cached[0]?.body,
      selectedState: selected?.state,
    }));
  `);
  expect(result).toEqual({
    logFetches: 1,
    row: { status: "completed", conclusion: "failure", logged: 1 },
    cachedBody: "rerun failure evidence",
    selectedState: "ready",
  });
});

test("concurrent activation bootstraps once and terminal attempts reconcile once with complete unsuccessful logs", async () => {
  const result = await runScenario("pr-cockpit-actions-lease-", `
    const actions = await import(${JSON.stringify(runLogsUrl)});
    const dbm = await import(${JSON.stringify(dbUrl)});
    ${seed}
    const calls = { runs: 0, jobs: [], logs: [] };
    const run = (id, status, conclusion) => ({
      id, run_attempt: 1, head_sha: head, head_branch: "feature", name: "CI",
      status, conclusion, updated_at: "2026-08-24T10:04:00Z", html_url: null,
    });
    const job = (id, runId, status, conclusion) => ({
      id, run_id: runId, run_attempt: 1, head_sha: head, head_branch: "feature",
      workflow_name: "CI", name: \`job-\${id}\`, status, conclusion,
      started_at: null, completed_at: status === "completed" ? "2026-08-24T10:04:00Z" : null,
      html_url: null, runner_name: null, runner_group_name: null, labels: [], steps: [],
    });
    const huge = Array.from({ length: 30000 }, (_, i) => \`2026-08-24T10:00:00.000Z line-\${i} \\u001b[31mred\\u001b[0m\`).join("\\n");
    const fetchers = {
      fetchWorkflowRuns: async () => { calls.runs++; await Bun.sleep(5); return [run(10, "in_progress", null), run(11, "completed", "failure")]; },
      fetchRunJobs: async (_repo, id, attempt) => {
        calls.jobs.push([id, attempt ?? null]);
        return id === 10 ? [job(100, 10, "in_progress", null)] : [
          job(110, 11, "completed", "failure"),
          job(111, 11, "completed", "success"),
          job(112, 11, "completed", "skipped"),
          job(113, 11, "completed", "startup_failure"),
          job(114, 11, "completed", "stale"),
        ];
      },
      fetchJobLog: async (_repo, id) => { calls.logs.push(id); return huge; },
      restRemaining: async () => 5000,
    };
    dbm.db.query("INSERT INTO actions_leases(repo,number,head_sha,expires_at,bootstrapped_at) VALUES(?,?,?,?,NULL)")
      .run("acme/app", 7, head, "2099-08-24T10:00:00Z");
    await Promise.all([
      actions.resumeActionsLeases(fetchers),
      actions.activateActionsLease("acme/app", 7, head, fetchers),
    ]);
    const first = JSON.parse(JSON.stringify(calls));
    await actions.activateActionsLease("acme/app", 7, head, fetchers);
    const cached = await actions.cachedJobLogs("acme/app", head);
    const body = cached[0].body;
    console.log(JSON.stringify({
      first, after: calls, cachedJobs: cached.map(({ job }) => job.job_id).sort((a, b) => a - b),
      successfulStored: dbm.db.query("SELECT log_gz IS NOT NULL AS stored FROM run_jobs WHERE job_id=111").get().stored,
      bytes: dbm.db.query("SELECT log_bytes,log_truncated FROM run_jobs WHERE job_id=110").get(),
      returnedBytes: Buffer.byteLength(body),
      cleaned: !body.includes("2026-08-24T10:00:00.000Z") && !body.includes("\\u001b[31m"),
      reconciled: dbm.db.query("SELECT reconciled_at IS NOT NULL AS done FROM workflow_runs WHERE run_id=11").get().done,
    }));
  `);
  expect(result.first).toEqual({ runs: 1, jobs: [[10, null], [11, 1]], logs: [110, 111, 113, 114] });
  expect(result.after).toEqual(result.first);
  expect(result.cachedJobs).toEqual([110, 113, 114]);
  expect(result.successfulStored).toBe(1);
  expect(result.bytes.log_truncated).toBe(0);
  expect(result.returnedBytes).toBe(result.bytes.log_bytes);
  expect(result.returnedBytes).toBeGreaterThan(262_144);
  expect(result.cleaned).toBe(true);
  expect(result.reconciled).toBe(1);
});

test("an explicit run request caches one current-head run once and rejects another head", async () => {
  const result = await runScenario("pr-cockpit-actions-requested-run-", `
    const actions = await import(${JSON.stringify(runLogsUrl)});
    const dbm = await import(${JSON.stringify(dbUrl)});
    ${seed}
    let runFetches = 0;
    let jobFetches = 0;
    let logFetches = 0;
    const rawRun = {
      id: 55, run_attempt: 1, head_sha: head, head_branch: "feature", name: "CI",
      path: ".github/workflows/ci.yml", status: "completed", conclusion: "failure",
      updated_at: "2026-08-24T10:04:00Z", html_url: "https://github.com/acme/app/actions/runs/55",
    };
    const fetchers = {
      fetchWorkflowRun: async () => { runFetches++; return rawRun; },
      fetchWorkflowRuns: async () => { throw new Error("broad fetch not allowed"); },
      fetchRunJobs: async () => {
        jobFetches++;
        return [{
          id: 551, run_id: 55, run_attempt: 1, head_sha: head, head_branch: "feature",
          workflow_name: "CI", name: "test", status: "completed", conclusion: "failure",
          started_at: "2026-08-24T10:01:00Z", completed_at: "2026-08-24T10:04:00Z",
          html_url: "https://github.com/acme/app/actions/runs/55/job/551",
          runner_name: "runner-4", runner_group_name: "hosted", labels: ["arm64"],
          steps: [{ name: "Run tests", number: 1, status: "completed", conclusion: "failure", started_at: null, completed_at: null }],
        }];
      },
      fetchJobLog: async () => { logFetches++; return "failure evidence"; },
      restRemaining: async () => 5000,
    };
    const first = await actions.cacheActionsRun("acme/app", 7, head, 55, fetchers);
    const second = await actions.cacheActionsRun("acme/app", 7, head, 55, fetchers);
    const mismatch = await actions.cacheActionsRun("acme/app", 7, head, 56, {
      ...fetchers,
      fetchWorkflowRun: async () => ({ ...rawRun, id: 56, head_sha: "b".repeat(40) }),
    });
    console.log(JSON.stringify({
      first,
      second,
      mismatch,
      runFetches,
      jobFetches,
      logFetches,
      runs: dbm.db.query("SELECT run_id, reconciled_at IS NOT NULL AS reconciled FROM workflow_runs ORDER BY run_id").all(),
      jobs: dbm.db.query("SELECT job_id, log_gz IS NOT NULL AS logged FROM run_jobs ORDER BY job_id").all(),
      lease: dbm.db.query("SELECT head_sha FROM actions_leases WHERE repo=? AND number=?").get("acme/app", 7),
    }));
  `);

  expect(result).toEqual({
    first: "fetched",
    second: "cached",
    mismatch: "head-mismatch",
    runFetches: 1,
    jobFetches: 1,
    logFetches: 1,
    runs: [{ run_id: 55, reconciled: 1 }],
    jobs: [{ job_id: 551, logged: 1 }],
    lease: { head_sha: "a".repeat(40) },
  });
});

test("an explicit activation for a new head queues behind a startup repair for the old head", async () => {
  const result = await runScenario("pr-cockpit-actions-head-change-", `
    const actions = await import(${JSON.stringify(runLogsUrl)});
    const dbm = await import(${JSON.stringify(dbUrl)});
    ${seed}
    const nextHead = "b".repeat(40);
    dbm.db.query("INSERT INTO actions_leases(repo,number,head_sha,expires_at,bootstrapped_at) VALUES(?,?,?,?,NULL)")
      .run("acme/app", 7, head, "2099-08-24T10:00:00Z");
    const heads = [];
    const fetchers = {
      fetchWorkflowRuns: async (_repo, sha) => { heads.push(sha); await Bun.sleep(5); return []; },
      fetchRunJobs: async () => [],
      fetchJobLog: async () => "",
      restRemaining: async () => 5000,
    };
    const resume = actions.resumeActionsLeases(fetchers);
    await Bun.sleep(1);
    const explicit = actions.activateActionsLease("acme/app", 7, nextHead, fetchers);
    await Promise.all([resume, explicit]);
    console.log(JSON.stringify({
      heads,
      lease: dbm.db.query("SELECT head_sha,bootstrapped_at IS NOT NULL AS bootstrapped FROM actions_leases").get(),
    }));
  `);
  expect(result.heads).toEqual(["a".repeat(40), "b".repeat(40)]);
  expect(result.lease).toEqual({ head_sha: "b".repeat(40), bootstrapped: 1 });
});

test("reserve defers background spend, explicit activation repairs, and a newer attempt discards stale logs", async () => {
  const result = await runScenario("pr-cockpit-actions-repair-", `
    const actions = await import(${JSON.stringify(runLogsUrl)});
    const dbm = await import(${JSON.stringify(dbUrl)});
    ${seed}
    let remaining = actions.REST_BACKGROUND_RESERVE;
    const calls = { jobs: [], logs: 0 };
    const run = (attempt) => ({
      id: 50, attempt, headSha: head, headBranch: "feature", workflowName: "CI",
      status: "completed", conclusion: "failure", eventAt: \`2026-08-24T10:0\${attempt}:00Z\`, htmlUrl: null,
    });
    const fetchers = {
      fetchWorkflowRuns: async () => [],
      fetchRunJobs: async (_repo, _id, attempt) => {
        calls.jobs.push(attempt);
        return [{ id: 500, run_id: 50, run_attempt: attempt, head_sha: head, head_branch: "feature",
          workflow_name: "CI", name: "fail", status: "completed", conclusion: "failure",
          started_at: null, completed_at: null, html_url: null, labels: [], steps: [] }];
      },
      fetchJobLog: async () => { calls.logs++; return "failure evidence"; },
      restRemaining: async () => remaining,
    };
    await actions.activateActionsLease("acme/app", 7, head, fetchers);
    await actions.ingestActionsState("acme/app", { run: run(1) }, fetchers);
    const deferred = dbm.db.query("SELECT reconciled_at FROM workflow_runs WHERE run_id=50 AND run_attempt=1").get();
    await actions.activateActionsLease("acme/app", 7, head, fetchers);
    const repaired = dbm.db.query("SELECT reconciled_at IS NOT NULL AS done,log_gz IS NOT NULL AS logged FROM workflow_runs JOIN run_jobs USING(repo,run_id,run_attempt)").get();
    remaining = 5000;
    await actions.ingestActionsState("acme/app", { run: run(2) }, fetchers);
    console.log(JSON.stringify({
      deferred, repaired, calls,
      oldJobs: dbm.db.query("SELECT COUNT(*) AS n FROM run_jobs WHERE run_id=50 AND run_attempt=1").get().n,
      visible: (await actions.cachedJobLogs("acme/app", head)).length,
    }));
  `);
  expect(result.deferred).toEqual({ reconciled_at: null });
  expect(result.repaired).toEqual({ done: 1, logged: 1 });
  expect(result.calls.jobs).toEqual([1, 2]);
  expect(result.calls.logs).toBe(2);
  expect(result.oldJobs).toBe(0);
  expect(result.visible).toBe(1);
});

test("startup resumes every active lease without extending expiry and retries transient log failures", async () => {
  const result = await runScenario("pr-cockpit-actions-resume-", `
    const actions = await import(${JSON.stringify(runLogsUrl)});
    const dbm = await import(${JSON.stringify(dbUrl)});
    ${seed}
    const expiry = "2099-08-24T10:00:00Z";
    dbm.db.query("INSERT INTO actions_leases(repo,number,head_sha,expires_at,bootstrapped_at) VALUES(?,?,?,?,NULL)")
      .run("acme/app", 7, head, expiry);
    let logCalls = 0;
    const fetchers = {
      fetchWorkflowRuns: async () => [{ id: 80, run_attempt: 1, head_sha: head, head_branch: "feature",
        name: "CI", status: "completed", conclusion: "failure", updated_at: "2026-08-24T10:00:00Z", html_url: null }],
      fetchRunJobs: async () => [{ id: 800, run_id: 80, run_attempt: 1, head_sha: head, head_branch: "feature",
        workflow_name: "CI", name: "queued-build", status: "completed", conclusion: "failure",
        started_at: null, completed_at: null, html_url: null, runner_name: null, runner_group_name: null,
        labels: ["arm64", "macOS"], steps: [] }],
      fetchJobLog: async () => {
        logCalls++;
        if (logCalls === 1) throw new Error("temporary download failure");
        return "complete log";
      },
      restRemaining: async () => 5000,
    };
    await actions.resumeActionsLeases(fetchers);
    const afterResume = dbm.db.query("SELECT expires_at FROM actions_leases").get().expires_at;
    const beforeRetry = dbm.db.query("SELECT reconciled_at FROM workflow_runs").get().reconciled_at;
    await actions.activateActionsLease("acme/app", 7, head, fetchers);
    const afterRetry = dbm.db.query("SELECT reconciled_at IS NOT NULL AS done,log_gz IS NOT NULL AS logged FROM workflow_runs JOIN run_jobs USING(repo,run_id,run_attempt)").get();
    const jobsOutput = actions.formatRunJobs(head, dbm.listRunJobs("acme/app", head));
    console.log(JSON.stringify({ expiry, afterResume, beforeRetry, afterRetry, logCalls, jobsOutput }));
  `);
  expect(result.afterResume).toBe(result.expiry);
  expect(result.beforeRetry).toBeNull();
  expect(result.afterRetry).toEqual({ done: 1, logged: 1 });
  expect(result.logCalls).toBe(2);
  expect(result.jobsOutput).toContain("requested arm64, macOS");
});

test("reactivating an expired lease on the same head bootstraps missed events", async () => {
  const result = await runScenario("pr-cockpit-actions-expired-", `
    const actions = await import(${JSON.stringify(runLogsUrl)});
    const dbm = await import(${JSON.stringify(dbUrl)});
    ${seed}
    dbm.db.query("INSERT INTO actions_leases(repo,number,head_sha,expires_at,bootstrapped_at) VALUES(?,?,?,?,?)")
      .run("acme/app", 7, head, "2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z");
    let runLists = 0;
    const fetchers = {
      fetchWorkflowRuns: async () => { runLists++; return []; },
      fetchRunJobs: async () => [],
      fetchJobLog: async () => "",
      restRemaining: async () => 5000,
    };
    await actions.activateActionsLease("acme/app", 7, head, fetchers);
    console.log(JSON.stringify({
      runLists,
      lease: dbm.db.query("SELECT bootstrapped_at IS NOT NULL AS bootstrapped, expires_at > datetime('now') AS active FROM actions_leases").get(),
    }));
  `);
  expect(result.runLists).toBe(1);
  expect(result.lease).toEqual({ bootstrapped: 1, active: 1 });
});

test("duplicate terminal deliveries and explicit activation share one reconciliation", async () => {
  const result = await runScenario("pr-cockpit-actions-terminal-dedupe-", `
    const actions = await import(${JSON.stringify(runLogsUrl)});
    const dbm = await import(${JSON.stringify(dbUrl)});
    ${seed}
    dbm.db.query("INSERT INTO actions_leases(repo,number,head_sha,expires_at,bootstrapped_at) VALUES(?,?,?,?,?)")
      .run("acme/app", 7, head, "2099-08-24T10:00:00Z", "2026-08-24T09:00:00Z");
    const calls = { runs: 0, jobs: 0, logs: 0 };
    const fetchers = {
      fetchWorkflowRuns: async () => { calls.runs++; return []; },
      fetchRunJobs: async () => {
        calls.jobs++;
        await Bun.sleep(5);
        return [{ id: 990, run_id: 99, run_attempt: 1, head_sha: head, head_branch: "feature",
          workflow_name: "CI", name: "failed", status: "completed", conclusion: "failure",
          started_at: null, completed_at: null, html_url: null, labels: [], steps: [] }];
      },
      fetchJobLog: async () => { calls.logs++; return "failure"; },
      restRemaining: async () => 5000,
    };
    const state = { run: {
      id: 99, attempt: 1, headSha: head, headBranch: "feature", workflowName: "CI",
      status: "completed", conclusion: "failure", eventAt: "2026-08-24T10:00:00Z", htmlUrl: null,
    } };
    await Promise.all([
      actions.ingestActionsState("acme/app", state, fetchers),
      actions.ingestActionsState("acme/app", state, fetchers),
      actions.activateActionsLease("acme/app", 7, head, fetchers),
    ]);
    console.log(JSON.stringify({
      calls,
      reconciled: dbm.db.query("SELECT reconciled_at IS NOT NULL AS done FROM workflow_runs WHERE run_id=99").get().done,
    }));
  `);
  expect(result.calls).toEqual({ runs: 0, jobs: 1, logs: 1 });
  expect(result.reconciled).toBe(1);
});

test("a selected successful job fetches and serves its full log once", async () => {
  const result = await runScenario("pr-cockpit-actions-viewer-log-", `
    const actions = await import(${JSON.stringify(runLogsUrl)});
    const dbm = await import(${JSON.stringify(dbUrl)});
    ${seed}
    dbm.upsertRunJob({
      repo: "acme/app", job_id: 120, run_id: 12, run_attempt: 1, head_sha: head,
      head_branch: "feature", workflow_name: "CI", name: "build", status: "completed",
      conclusion: "success", started_at: "2026-08-24T10:00:00Z", completed_at: "2026-08-24T10:02:00Z",
      html_url: null, runner_name: "runner-1", runner_group_name: "hosted",
      labels_json: "[\\"arm64\\"]", failed_step: null,
    });
    const source = Array.from({ length: 30000 }, (_, i) => \`2026-08-24T10:00:00.000Z line-\${i}\`).join("\\n");
    let fetches = 0;
    const fetchers = {
      fetchWorkflowRuns: async () => [],
      fetchRunJobs: async () => [],
      fetchJobLog: async () => { fetches++; return source; },
      restRemaining: async () => 5000,
    };
    const [first, duplicate] = await Promise.all([
      actions.actionJobLog("acme/app", head, 120, fetchers),
      actions.actionJobLog("acme/app", head, 120, fetchers),
    ]);
    console.log(JSON.stringify({
      state: first.state,
      fetches,
      firstBytes: Buffer.byteLength(first.body),
      duplicateBody: duplicate.body === first.body,
      cleaned: !first.body.includes("2026-08-24T10:00:00.000Z"),
      stored: dbm.db.query("SELECT log_gz IS NOT NULL AS stored,log_bytes,log_error FROM run_jobs WHERE job_id=120").get(),
    }));
  `);
  expect(result.fetches).toBe(1);
  expect(result.state).toBe("ready");
  expect(result.firstBytes).toBeGreaterThan(262_144);
  expect(result.firstBytes).toBe(result.stored.log_bytes);
  expect(result.duplicateBody).toBe(true);
  expect(result.cleaned).toBe(true);
  expect(result.stored).toEqual({ stored: 1, log_bytes: result.firstBytes, log_error: null });
});

test("a skipped job reports that no log was produced without fetching GitHub", async () => {
  const result = await runScenario("pr-cockpit-actions-skipped-log-", `
    const actions = await import(${JSON.stringify(runLogsUrl)});
    const dbm = await import(${JSON.stringify(dbUrl)});
    ${seed}
    dbm.upsertRunJob({
      repo: "acme/app", job_id: 121, run_id: 12, run_attempt: 1, head_sha: head, head_branch: "feature",
      workflow_name: "CI", name: "skipped", status: "completed", conclusion: "skipped",
      started_at: null, completed_at: "2026-08-24T10:02:00Z", html_url: null, runner_name: null,
      runner_group_name: null, labels_json: "[]", failed_step: null,
    });
    let fetches = 0;
    const log = await actions.actionJobLog("acme/app", head, 121, {
      fetchWorkflowRuns: async () => [],
      fetchRunJobs: async () => [],
      fetchJobLog: async () => { fetches++; return ""; },
      restRemaining: async () => 5000,
    });
    console.log(JSON.stringify({ fetches, state: log.state, body: log.body }));
  `);
  expect(result).toEqual({ fetches: 0, state: "not-produced", body: null });
});

test("workflow graphs parse dependencies and reuse cached definitions", async () => {
  const result = await runScenario("pr-cockpit-actions-graph-", `
    const actions = await import(${JSON.stringify(runLogsUrl)});
    const dbm = await import(${JSON.stringify(dbUrl)});
    ${seed}
    const calls = { runs: 0, files: 0 };
    const fetchers = {
      fetchWorkflowRuns: async () => {
        calls.runs++;
        return [{
          id: 70, run_attempt: 1, head_sha: head, head_branch: "feature", name: "CI",
          path: ".github/workflows/ci.yml", status: "completed", conclusion: "success",
          updated_at: "2026-08-24T10:04:00Z", html_url: null,
        }];
      },
      fetchFileContents: async () => {
        calls.files++;
        return { content: "name: CI\\njobs:\\n  lint:\\n    name: Lint\\n    runs-on: ubuntu-latest\\n  test:\\n    name: Test\\n    needs: lint\\n    runs-on: ubuntu-latest\\n  deploy:\\n    needs: [lint, test]\\n    uses: acme/workflows/.github/workflows/deploy.yml@main\\n" };
      },
    };
    const first = await actions.actionWorkflowGraphs("acme/app", 7, head, fetchers);
    const second = await actions.actionWorkflowGraphs("acme/app", 7, head, fetchers);
    console.log(JSON.stringify({ calls, first, same: JSON.stringify(first) === JSON.stringify(second) }));
  `);
  expect(result.calls).toEqual({ runs: 1, files: 1 });
  expect(result.same).toBe(true);
  expect(result.first).toEqual([{
    path: ".github/workflows/ci.yml",
    name: "CI",
    jobs: [
      { id: "lint", name: "Lint", needs: [], uses: null },
      { id: "test", name: "Test", needs: ["lint"], uses: null },
      { id: "deploy", name: "deploy", needs: ["lint", "test"], uses: "acme/workflows/.github/workflows/deploy.yml@main" },
    ],
  }]);
});
