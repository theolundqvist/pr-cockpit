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
      const { fetchWorkflowRuns, fetchRunJobs } = await import(${JSON.stringify(githubModuleUrl)});
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
      const jobs = await fetchRunJobs("acme/app", 44, 3);
      console.log(JSON.stringify({ runs: runs.length, jobs: jobs.length, calls }));
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
    expect(result.jobs).toBe(101);
    expect(result.calls).toEqual([
      "/repos/acme/app/actions/runs?head_sha=abc&per_page=100&page=1",
      "/repos/acme/app/actions/runs?head_sha=abc&per_page=100&page=2",
      "/repos/acme/app/actions/runs/44/attempts/3/jobs?per_page=100&page=1",
      "/repos/acme/app/actions/runs/44/attempts/3/jobs?per_page=100&page=2",
    ]);
  } finally {
    rmSync(fakeGhDir, { recursive: true, force: true });
  }
});
