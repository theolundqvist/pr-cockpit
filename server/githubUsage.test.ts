import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instrumentGithubGraphql, RATE_LIMIT_ALIAS } from "./githubUsage.ts";

// The child must set COCKPIT_DATA_DIR before db.ts opens SQLite, so this intentionally tests the module-loading boundary.
const dbModuleUrl = new URL("./db.ts", import.meta.url).href;
const usageModuleUrl = new URL("./githubUsage.ts", import.meta.url).href;

test("instruments queries and uses the fixed mutation cost", () => {
  const query = instrumentGithubGraphql("query($owner: String!) { repository(owner: $owner, name: \"app\") { id } }");
  expect(query.fixedCost).toBeNull();
  expect(query.document).toContain(`${RATE_LIMIT_ALIAS}: rateLimit { cost used remaining resetAt }`);

  const mutation = "mutation($id: ID!) { closePullRequest(input: { pullRequestId: $id }) { pullRequest { id } } }";
  expect(instrumentGithubGraphql(mutation)).toEqual({ document: mutation, fixedCost: 1 });
});

test("aggregates attributed calls for the current quota window", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-github-usage-"));
  const resetAt = new Date(Math.ceil(Date.now() / 1000) * 1000 + 2 * 60 * 60_000).toISOString();
  const scenario = `
    const database = await import(${JSON.stringify(dbModuleUrl)});
    const usage = await import(${JSON.stringify(usageModuleUrl)});
    const resetAt = ${JSON.stringify(resetAt)};
    const previousResetAt = new Date(Date.parse(resetAt) - 60 * 60_000).toISOString();
    usage.recordGithubGraphqlUsage({ occurredAt: new Date(Date.parse(previousResetAt) - 30 * 60_000).toISOString(), source: "daemon", operation: "PR checks", cost: 4, used: 120, remaining: 4880, resetAt: previousResetAt, status: "ok" });
    usage.recordGithubGraphqlUsage({ occurredAt: new Date().toISOString(), source: "background poll", operation: "open PR search", cost: 2, used: 42, remaining: 4958, resetAt, status: "ok" });
    usage.recordGithubGraphqlUsage({ occurredAt: new Date().toISOString(), source: "app detail", operation: "PR detail", cost: 8, used: 50, remaining: 4950, resetAt: resetAt.replace(".000Z", "Z"), status: "ok" });
    console.log(JSON.stringify(database.githubGraphqlUsage(50, 5000, resetAt, Date.parse(resetAt) - 30 * 60_000)));
    database.db.close();
  `;

  try {
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", scenario], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir },
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
    expect(result.localPoints).toBe(10);
    expect(result.localRequests).toBe(2);
    expect(result.otherPoints).toBe(40);
    expect(result.sources).toEqual([
      { source: "app detail", points: 8, requests: 1, unknownCostRequests: 0 },
      { source: "background poll", points: 2, requests: 1, unknownCostRequests: 0 },
    ]);
    expect(result.operations[0]).toEqual({ operation: "PR detail", points: 8, requests: 1, unknownCostRequests: 0 });
    expect(result.predictedUsed).toBe(100);
    expect(result.history).toHaveLength(72);
    expect(result.history.at(-2)).toMatchObject({ resetAt: new Date(Date.parse(resetAt) - 60 * 60_000).toISOString(), used: 120, localPoints: 4, localRequests: 1 });
    expect(result.history.at(-1)).toMatchObject({ resetAt, used: 50, localPoints: 10, localRequests: 2 });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
