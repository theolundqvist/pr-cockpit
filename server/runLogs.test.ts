import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runLogsUrl = new URL("./runLogs.ts", import.meta.url).href;

// Every assertion runs in a child process so db.ts opens SQLite inside this test's own data dir.
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

test("cleaning strips Actions noise and keeps the tail's failure evidence", async () => {
  const result = await runScenario("pr-cockpit-log-clean-", `
    const { cleanJobLog, JOB_LOG_TAIL_BYTES } = await import(${JSON.stringify(runLogsUrl)});
    const out = {};

    const small = cleanJobLog("\\uFEFF2026-07-15T09:05:01.1234567Z \\u001b[31mFAIL\\u001b[0m one\\n2026-07-15T09:05:02.1234567Z done\\n");
    out.smallBody = small.body;
    out.smallTruncated = small.truncated;

    const filler = Array.from({ length: 40_000 }, (_, i) => \`2026-07-15T09:05:01.1234567Z filler line \${i}\`).join("\\n");
    const big = cleanJobLog(\`\${filler}\\n2026-07-15T09:09:09.1234567Z FAIL src/flight.test.ts > lands the plane\\n2026-07-15T09:09:10.1234567Z ##[error]Process completed with exit code 1\\n\`);
    out.bigTruncated = big.truncated;
    out.bigBytes = Buffer.byteLength(big.body);
    out.keptFailure = big.body.includes("FAIL src/flight.test.ts > lands the plane");
    out.keptExitCode = big.body.includes("##[error]Process completed with exit code 1");
    out.startsMidLine = /^filler line \\d+$/.test(big.body.split("\\n")[0] ?? "");
    out.tailLimit = JOB_LOG_TAIL_BYTES;

    console.log(JSON.stringify(out));
  `);

  // timestamps, ANSI and the BOM go; the text does not
  expect(result.smallBody).toBe("FAIL one\ndone\n");
  expect(result.smallTruncated).toBe(false);
  // a 1.5 MB log is cut to the tail, and the cut lands on a line boundary
  expect(result.bigTruncated).toBe(true);
  expect(result.bigBytes).toBeLessThanOrEqual(result.tailLimit);
  expect(result.bigBytes).toBeGreaterThan(result.tailLimit - 200);
  expect(result.keptFailure).toBe(true);
  expect(result.keptExitCode).toBe(true);
  expect(result.startsMidLine).toBe(true);
});

test("only failed and cancelled runs are visited, and only their unsuccessful jobs are downloaded", async () => {
  const result = await runScenario("pr-cockpit-log-sync-", `
    const { syncRunJobs, failingRunIds, cachedJobLogs } = await import(${JSON.stringify(runLogsUrl)});
    const { db } = await import(${JSON.stringify(new URL("./db.ts", import.meta.url).href)});
    const out = {};
    const head = "c".repeat(40);
    const check = (name, conclusion, runId) => ({
      __typename: "CheckRun",
      name,
      status: "COMPLETED",
      conclusion,
      detailsUrl: null,
      startedAt: null,
      completedAt: null,
      isRequired: true,
      checkSuite: { workflowRun: { databaseId: runId, workflow: { name: "CI" } } },
    });
    const detail = {
      headRefOid: head,
      lastCommit: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
        check("lint", "FAILURE", 900),
        check("tests", "CANCELLED", 901),
        check("build", "SUCCESS", 902),
        check("flaky", "FAILURE", 900),
      ] } } } }] },
    };
    out.runIds = failingRunIds(detail).sort();

    const job = (id, runId, name, conclusion, status = "completed") => ({
      id, run_id: runId, run_attempt: 1, head_sha: head, name, status, conclusion,
      started_at: "2026-07-15T09:00:00Z", completed_at: "2026-07-15T09:05:00Z",
      html_url: \`https://github.com/acme/app/actions/runs/\${runId}/job/\${id}\`,
      steps: [{ name: "Run tests", number: 2, status: "completed", conclusion, started_at: null, completed_at: null }],
    });
    const logCalls = [];
    const fetchers = {
      fetchRunJobs: async (_repo, runId) => runId === 900
        ? [job(1, 900, "lint", "failure"), job(2, 900, "unit", "success"), job(3, 900, "smoke", "skipped")]
        : [job(4, 901, "tests", "cancelled"), job(5, 901, "late", null, "in_progress")],
      fetchJobLog: async (_repo, jobId) => {
        logCalls.push(jobId);
        return \`2026-07-15T09:05:01.1234567Z log for job \${jobId}\\n\`;
      },
      restRemaining: async () => 5000,
    };
    await syncRunJobs("acme/app", detail, { fetchers });
    out.logCalls = logCalls.sort();
    out.rows = db.query("SELECT job_id, conclusion, failed_step, log_bytes, log_truncated, log_error, log_gz IS NOT NULL AS stored FROM run_jobs ORDER BY job_id").all();
    out.cached = cachedJobLogs("acme/app", head).map((entry) => [entry.job.job_id, entry.job.conclusion, entry.body]);
    out.filtered = cachedJobLogs("acme/app", head, "LINT").map((entry) => entry.job.name);

    // a second pass must not re-download an already cached log
    await syncRunJobs("acme/app", detail, { fetchers });
    out.logCallsAfterSecondPass = logCalls.length;

    console.log(JSON.stringify(out));
    db.close();
  `);

  // one run id per failing check, deduplicated; the successful check's run is never visited
  expect(result.runIds).toEqual([900, 901]);
  // logs only for the failure and the cancellation: success, skipped and still-running jobs are skipped
  expect(result.logCalls).toEqual([1, 4]);
  expect(result.logCallsAfterSecondPass).toBe(2);
  // every job's metadata is cached, conclusion verbatim, so no reader re-derives cancelled vs failed
  expect(result.rows).toEqual([
    { job_id: 1, conclusion: "failure", failed_step: "Run tests", log_bytes: 14, log_truncated: 0, log_error: null, stored: 1 },
    { job_id: 2, conclusion: "success", failed_step: null, log_bytes: null, log_truncated: 0, log_error: null, stored: 0 },
    { job_id: 3, conclusion: "skipped", failed_step: null, log_bytes: null, log_truncated: 0, log_error: null, stored: 0 },
    { job_id: 4, conclusion: "cancelled", failed_step: null, log_bytes: 14, log_truncated: 0, log_error: null, stored: 1 },
    { job_id: 5, conclusion: null, failed_step: null, log_bytes: null, log_truncated: 0, log_error: null, stored: 0 },
  ]);
  // readers see the unsuccessful jobs with their decompressed body, and can filter by check name
  expect(result.cached).toEqual([
    [5, null, null],
    [4, "cancelled", "log for job 4\n"],
    [1, "failure", "log for job 1\n"],
  ]);
  expect(result.filtered).toEqual(["lint"]);
});

test("a reserved REST pool and a failed download are recorded instead of thrown", async () => {
  const result = await runScenario("pr-cockpit-log-quota-", `
    const { syncRunJobs, REST_BACKGROUND_RESERVE } = await import(${JSON.stringify(runLogsUrl)});
    const { db } = await import(${JSON.stringify(new URL("./db.ts", import.meta.url).href)});
    const out = {};
    const head = "d".repeat(40);
    const detail = {
      headRefOid: head,
      lastCommit: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{
        __typename: "CheckRun",
        name: "lint",
        status: "COMPLETED",
        conclusion: "FAILURE",
        detailsUrl: null,
        startedAt: null,
        completedAt: null,
        isRequired: true,
        checkSuite: { workflowRun: { databaseId: 700, workflow: { name: "CI" } } },
      }] } } } }] },
    };
    const jobs = [{
      id: 11, run_id: 700, run_attempt: 1, head_sha: head, name: "lint", status: "completed",
      conclusion: "failure", started_at: null, completed_at: null, html_url: null, steps: [],
    }];
    let logCalls = 0;
    const drained = {
      fetchRunJobs: async () => jobs,
      fetchJobLog: async () => { logCalls++; return "x"; },
      restRemaining: async () => REST_BACKGROUND_RESERVE,
    };
    await syncRunJobs("acme/app", detail, { fetchers: drained });
    out.reservedCalls = logCalls;
    out.reservedError = db.query("SELECT log_error FROM run_jobs WHERE job_id = 11").get().log_error;

    // an explicit read is allowed to spend the reserve
    await syncRunJobs("acme/app", detail, { fetchers: drained, background: false });
    out.foregroundCalls = logCalls;

    const broken = {
      fetchRunJobs: async () => jobs,
      fetchJobLog: async () => { throw new Error("job log fetch failed: 410 gone"); },
      restRemaining: async () => 5000,
    };
    db.query("UPDATE run_jobs SET log_gz = NULL WHERE job_id = 11").run();
    await syncRunJobs("acme/app", detail, { fetchers: broken });
    out.brokenError = db.query("SELECT log_error FROM run_jobs WHERE job_id = 11").get().log_error;

    const exploded = { fetchRunJobs: async () => { throw new Error("run jobs fetch failed: 502"); }, fetchJobLog: async () => "", restRemaining: async () => 5000 };
    out.runFailureThrew = await syncRunJobs("acme/app", detail, { fetchers: exploded }).then(() => false, () => true);

    console.log(JSON.stringify(out));
    db.close();
  `);

  // background sync leaves the reserve alone and says so on the row
  expect(result.reservedCalls).toBe(0);
  expect(result.reservedError).toBe("log not fetched: REST quota reserved for actions");
  // an agent's explicit read still gets its log
  expect(result.foregroundCalls).toBe(1);
  // an expired or missing log is recorded, not raised
  expect(result.brokenError).toBe("job log fetch failed: 410 gone");
  // one broken run never fails the whole sync
  expect(result.runFailureThrew).toBe(false);
});
