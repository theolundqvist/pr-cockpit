import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const githubModuleUrl = new URL("./github.ts", import.meta.url).href;

test("Actions run and attempt-specific job fetches continue until a short page", async () => {
  const fakeGhDir = mkdtempSync(join(tmpdir(), "pr-cockpit-actions-pagination-"));
  const fakeGh = join(fakeGhDir, "gh");
  writeFileSync(fakeGh, "#!/bin/sh\nprintf 'fixture-token\\n'\n");
  chmodSync(fakeGh, 0o755);
  try {
    const script = `
      const { fetchWorkflowRuns, fetchRecentWorkflowRuns, fetchRunJobs } = await import(${JSON.stringify(githubModuleUrl)});
      const calls = [];
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        calls.push(url.pathname + url.search);
        const second = url.searchParams.get("page") === "2";
        if (url.pathname.endsWith("/actions/runs")) {
          return Response.json({ workflow_runs: Array.from({ length: second ? 1 : 100 }, (_, i) => ({ id: (second ? 100 : 0) + i })) });
        }
        return Response.json({ jobs: Array.from({ length: second ? 1 : 100 }, (_, i) => ({ id: (second ? 100 : 0) + i })) });
      };
      const runs = await fetchWorkflowRuns("acme/app", "abc");
      const recent = await fetchRecentWorkflowRuns("acme/app");
      const jobs = await fetchRunJobs("acme/app", 44, 3);
      console.log(JSON.stringify({ runs: runs.length, recent: recent.length, jobs: jobs.length, calls }));
    `;
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...Bun.env, COCKPIT_GH_BIN: fakeGh, COCKPIT_MOCK: "", COCKPIT_MOCK_DATA: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr);
    const result = JSON.parse(stdout);
    expect(result.runs).toBe(101);
    expect(result.recent).toBe(101);
    expect(result.jobs).toBe(101);
    expect(result.calls).toEqual([
      "/repos/acme/app/actions/runs?head_sha=abc&per_page=100&page=1",
      "/repos/acme/app/actions/runs?head_sha=abc&per_page=100&page=2",
      "/repos/acme/app/actions/runs?per_page=100&page=1",
      "/repos/acme/app/actions/runs?per_page=100&page=2",
      "/repos/acme/app/actions/runs/44/attempts/3/jobs?per_page=100&page=1",
      "/repos/acme/app/actions/runs/44/attempts/3/jobs?per_page=100&page=2",
    ]);
  } finally {
    rmSync(fakeGhDir, { recursive: true, force: true });
  }
});

test("repo-wide Actions retains non-PR runs and reports latest success independently of status", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-actions-page-"));
  try {
    const script = `
      const { ingestActionsState } = await import(${JSON.stringify(new URL("./runLogs.ts", import.meta.url).href)});
      const { buildFetchHandler } = await import(${JSON.stringify(new URL("./http.ts", import.meta.url).href)});
      const base = {
        attempt: 1,
        headBranch: "main",
        workflowName: "Release Backend (Production)",
        workflowPath: ".github/workflows/release.yml",
        event: "workflow_dispatch",
        actorLogin: "release-bot",
        prNumber: null,
        status: "completed",
        createdAt: "2026-08-28T09:00:00Z",
        runStartedAt: "2026-08-28T09:00:05Z",
        htmlUrl: "https://github.com/acme/app/actions/runs/1",
      };
      await ingestActionsState("acme/app", { run: {
        ...base, id: 1, headSha: "a".repeat(40), displayTitle: "Release v42",
        conclusion: "success", eventAt: "2026-08-28T09:10:00Z",
        updatedAt: "2026-08-28T09:10:00Z", runNumber: 42,
      } });
      await ingestActionsState("acme/app", { run: {
        ...base, id: 2, headSha: "b".repeat(40), displayTitle: "Release v43",
        conclusion: "failure", eventAt: "2026-08-28T10:10:00Z",
        updatedAt: "2026-08-28T10:10:00Z", runNumber: 43,
      } });
      const handler = buildFetchHandler(4899);
      const response = await handler(new Request(
        "http://127.0.0.1:4899/api/actions/runs?repo=acme%2Fapp&workflow=Release%20Backend%20(Production)&status=failed"
      ));
      console.log(JSON.stringify({ status: response.status, body: await response.json() }));
      process.exit(0);
    `;
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: {
        ...Bun.env,
        COCKPIT_DATA_DIR: dataDir,
        COCKPIT_REPOS: "acme/app",
        COCKPIT_MOCK: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr);
    const result = JSON.parse(stdout);
    expect(result.status).toBe(200);
    expect(result.body.runs).toHaveLength(1);
    expect(result.body.runs[0]).toMatchObject({
      id: 2,
      prNumber: null,
      conclusion: "failure",
      displayTitle: "Release v43",
    });
    expect(result.body.latestSuccessful).toMatchObject({
      id: 1,
      runNumber: 42,
      conclusion: "success",
    });
    expect(result.body.workflows).toContain("Release Backend (Production)");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
