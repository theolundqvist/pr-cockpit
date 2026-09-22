import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const githubModuleUrl = new URL("./github.ts", import.meta.url).href;
const issuesModuleUrl = new URL("./systemIssues.ts", import.meta.url).href;

test("an inaccessible repository is isolated and skipped until retry", async () => {
  const fakeGhDir = mkdtempSync(join(tmpdir(), "pr-cockpit-repository-access-"));
  const fakeGh = join(fakeGhDir, "gh");
  writeFileSync(fakeGh, "#!/bin/sh\nprintf 'fixture-token\\n'\n");
  chmodSync(fakeGh, 0o755);
  try {
    const script = `
      const github = await import(${JSON.stringify(githubModuleUrl)});
      const health = await import(${JSON.stringify(issuesModuleUrl)});
      const queries = [];
      globalThis.fetch = async (_input, init) => {
        const query = JSON.parse(init.body).variables.searchQuery;
        queries.push(query);
        if (query.includes("repo:acme/private")) {
          return Response.json({ errors: [{ type: "VALIDATION", message: "The listed users and repositories cannot be searched because you do not have permission." }] });
        }
        return Response.json({ data: { search: { nodes: [{
          number: 7,
          title: "Visible pull request",
          updatedAt: "2026-09-22T00:00:00Z",
          headRefOid: "a".repeat(40),
          repository: { nameWithOwner: "acme/good" },
          commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
        }] } } });
      };

      const first = await github.searchOpenPrs(["acme/good", "acme/private"]);
      const callsAfterIsolation = queries.length;
      const second = await github.searchOpenPrs(["acme/good", "acme/private"]);
      const issue = health.systemIssues().find((entry) => entry.repo === "acme/private");
      health.retrySystemIssue("repository-access:acme/private");
      const availableAfterRetry = health.repositoryAvailable("acme/private");
      console.log(JSON.stringify({
        first: first.map((entry) => entry.repo),
        second: second.map((entry) => entry.repo),
        callsAfterIsolation,
        totalCalls: queries.length,
        issue: issue && { kind: issue.kind, repo: issue.repo },
        availableAfterRetry,
      }));
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
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      first: ["acme/good"],
      second: ["acme/good"],
      callsAfterIsolation: 3,
      totalCalls: 4,
      issue: { kind: "repository-access", repo: "acme/private" },
      availableAfterRetry: true,
    });
  } finally {
    rmSync(fakeGhDir, { recursive: true, force: true });
  }
});
