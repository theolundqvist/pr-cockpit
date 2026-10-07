import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  githubRestCharged,
  instrumentGithubGraphql,
  normalizeGithubRestEndpoint,
  RATE_LIMIT_ALIAS,
} from "./githubUsage.ts";

// The child must set COCKPIT_DATA_DIR before db.ts opens SQLite, so this intentionally tests the module-loading boundary.
const dbModuleUrl = new URL("./db.ts", import.meta.url).href;
const usageModuleUrl = new URL("./githubUsage.ts", import.meta.url).href;
const githubModuleUrl = new URL("./github.ts", import.meta.url).href;
const settingsModuleUrl = new URL("./settings.ts", import.meta.url).href;

// Runs the scenario in a fresh process on its own database, with a gh that answers a fixture token
// unless the scenario brings its own.
async function runScenario(scenario: string, gh = "#!/bin/sh\nprintf 'fixture-token\\n'\n"): Promise<any> {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-github-usage-"));
  const fakeGh = join(dataDir, "gh");
  writeFileSync(fakeGh, gh);
  chmodSync(fakeGh, 0o755);
  try {
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", scenario], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_GH_BIN: fakeGh, COCKPIT_MOCK: "", COCKPIT_MOCK_DATA: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr);
    return JSON.parse(stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("instruments queries and uses the fixed mutation cost", () => {
  const query = instrumentGithubGraphql("query($owner: String!) { repository(owner: $owner, name: \"app\") { id } }");
  expect(query.fixedCost).toBeNull();
  expect(query.document).toContain(`${RATE_LIMIT_ALIAS}: rateLimit { cost used remaining resetAt }`);

  const mutation = "mutation($id: ID!) { closePullRequest(input: { pullRequestId: $id }) { pullRequest { id } } }";
  expect(instrumentGithubGraphql(mutation)).toEqual({ document: mutation, fixedCost: 1 });
});

test("aggregates attributed calls for the current quota window", async () => {
  const resetAt = new Date(Math.ceil(Date.now() / 1000) * 1000 + 2 * 60 * 60_000).toISOString();
  const result = await runScenario(`
    const database = await import(${JSON.stringify(dbModuleUrl)});
    const usage = await import(${JSON.stringify(usageModuleUrl)});
    const resetAt = ${JSON.stringify(resetAt)};
    const previousResetAt = new Date(Date.parse(resetAt) - 60 * 60_000).toISOString();
    usage.recordGithubGraphqlUsage({ occurredAt: new Date(Date.parse(previousResetAt) - 30 * 60_000).toISOString(), source: "daemon", operation: "PR checks", cost: 4, used: 120, remaining: 4880, resetAt: previousResetAt, status: "ok" });
    usage.recordGithubGraphqlUsage({ occurredAt: new Date().toISOString(), source: "background poll", operation: "open PR search", cost: 2, used: 42, remaining: 4958, resetAt, status: "ok" });
    usage.recordGithubGraphqlUsage({ occurredAt: new Date().toISOString(), source: "app detail", operation: "PR detail", cost: 8, used: 50, remaining: 4950, resetAt: resetAt.replace(".000Z", "Z"), status: "ok" });
    console.log(JSON.stringify(database.githubGraphqlUsage(50, 5000, resetAt, Date.parse(resetAt) - 30 * 60_000)));
    database.db.close();
  `);
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
});

test("REST routes keep their shape without owners, identifiers, paths, or queries", () => {
  expect(normalizeGithubRestEndpoint("/repos/acme/app/actions/runs/123/jobs?per_page=100&filter=latest&page=1"))
    .toBe("/repos/:owner/:repo/actions/runs/:run_id/jobs");
  expect(normalizeGithubRestEndpoint("/repos/acme/app/actions/runs/123/attempts/2/jobs?per_page=100&page=1"))
    .toBe("/repos/:owner/:repo/actions/runs/:run_id/attempts/:attempt_number/jobs");
  expect(normalizeGithubRestEndpoint("/repos/acme/app/actions/jobs/9/logs")).toBe("/repos/:owner/:repo/actions/jobs/:job_id/logs");
  expect(normalizeGithubRestEndpoint("/repos/acme/app/pulls/comments/5")).toBe("/repos/:owner/:repo/pulls/comments/:comment_id");
  expect(normalizeGithubRestEndpoint("/repos/acme/app/contents/src/secret%20plan.ts?ref=abc")).toBe("/repos/:owner/:repo/contents/:path");
  expect(normalizeGithubRestEndpoint("/repos/acme/app/git/refs/heads/feature/x")).toBe("/repos/:owner/:repo/git/refs/:ref");
  expect(normalizeGithubRestEndpoint("/repos/acme/app/issues/7/labels/needs%20review"))
    .toBe("/repos/:owner/:repo/issues/:issue_number/labels/:name");
  expect(normalizeGithubRestEndpoint("/search/issues?q=repo%3Aacme%2Fapp+secret")).toBe("/search/issues");
  // A route the table does not know keeps nothing that could name an owner or object.
  expect(normalizeGithubRestEndpoint("/orgs/acme/teams/core")).toBe("/:id/:id/:id/:id");
});

test("only REST answers that served the request are charged", () => {
  expect(githubRestCharged("GET", "/repos/:owner/:repo", 200)).toBe(true);
  expect(githubRestCharged("GET", "/repos/:owner/:repo/actions/jobs/:job_id/logs", 302)).toBe(true);
  expect(githubRestCharged("GET", "/repos/:owner/:repo", 304)).toBe(false);
  expect(githubRestCharged("GET", "/rate_limit", 200)).toBe(false);
  expect(githubRestCharged("GET", "/user", 403)).toBeNull();
  expect(githubRestCharged("GET", "/user", 429)).toBeNull();
  expect(githubRestCharged("GET", "/user", null)).toBeNull();
});

test("REST requests are recorded per source, including the quota probe but not a refusal", async () => {
  const result = await runScenario(`
    const settings = await import(${JSON.stringify(settingsModuleUrl)});
    const github = await import(${JSON.stringify(githubModuleUrl)});
    const usage = await import(${JSON.stringify(usageModuleUrl)});
    const database = await import(${JSON.stringify(dbModuleUrl)});
    const resetSeconds = Math.ceil(Date.now() / 1000) + 30 * 60;
    const requested = [];
    let exhausted = false;
    const slowGate = Promise.withResolvers();
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      requested.push(url.pathname);
      const used = exhausted ? 5000 : requested.length;
      const headers = {
        "x-ratelimit-resource": "core",
        "x-ratelimit-limit": "5000",
        "x-ratelimit-used": String(used),
        "x-ratelimit-remaining": String(5000 - used),
        "x-ratelimit-reset": String(resetSeconds),
        etag: '"v1"',
      };
      if (exhausted) return Response.json({ message: "API rate limit exceeded" }, { status: 403, headers });
      // The first request answers last, so a source held in shared state would label both alike.
      if (url.pathname === "/repos/acme/slow/assignees") await slowGate.promise;
      if (init.headers?.["If-None-Match"] === '"v1"') return new Response(null, { status: 304, headers });
      return Response.json([], { headers });
    };
    await github.fetchAssignableUsers("acme/before");
    settings.writeSettings({ rest_usage_enabled: true });
    const slow = usage.withGithubUsageSource("agent read", () => github.fetchAssignableUsers("acme/slow"));
    await usage.withGithubUsageSource("relay", () => github.fetchAssignableUsers("acme/fast"));
    slowGate.resolve();
    await slow;
    await github.fetchAssignableUsers("acme/fast");
    exhausted = true;
    const failures = [];
    for (const repo of ["acme/slow", "acme/other"]) {
      await usage.withGithubUsageSource("background poll", () => github.fetchAssignableUsers(repo))
        .catch((error) => failures.push(error.kind));
    }
    console.log(JSON.stringify({
      requested,
      failures,
      rows: database.db.query("SELECT source, method, endpoint, resource, status, charged FROM github_rest_usage ORDER BY id").all(),
      summary: database.githubRestUsage(5000, new Date(resetSeconds * 1000).toISOString()),
    }));
    database.db.close();
  `);
  // The exhausted core window blocks acme/other before it is sent; only the probe that confirms the block goes out.
  expect(result.requested).toEqual([
    "/repos/acme/before/assignees",
    "/repos/acme/slow/assignees",
    "/repos/acme/fast/assignees",
    "/repos/acme/fast/assignees",
    "/repos/acme/slow/assignees",
    "/user",
  ]);
  expect(result.failures).toEqual(["quota", "quota"]);
  const endpoint = "/repos/:owner/:repo/assignees";
  expect(result.rows).toEqual([
    { source: "relay", method: "GET", endpoint, resource: "core", status: 200, charged: 1 },
    { source: "agent read", method: "GET", endpoint, resource: "core", status: 200, charged: 1 },
    { source: "unknown", method: "GET", endpoint, resource: "core", status: 304, charged: 0 },
    { source: "background poll", method: "GET", endpoint, resource: "core", status: 403, charged: null },
    { source: "background poll", method: "GET", endpoint: "/user", resource: "core", status: 403, charged: null },
  ]);
  // Recording began mid-window and two charges are unknown, so the rest of GitHub's count is not attributed.
  expect(result.summary).toMatchObject({
    localRequests: 5,
    chargedRequests: 2,
    notModifiedRequests: 1,
    unknownChargeRequests: 2,
    windowComplete: false,
    otherRequests: null,
  });
});

test("the REST remainder is attributed only for a fully recorded window with known charges", async () => {
  const resetAt = new Date(Math.ceil(Date.now() / 1000) * 1000 + 2 * 60 * 60_000).toISOString();
  const result = await runScenario(`
    const database = await import(${JSON.stringify(dbModuleUrl)});
    const settings = await import(${JSON.stringify(settingsModuleUrl)});
    const usage = await import(${JSON.stringify(usageModuleUrl)});
    const resetAt = ${JSON.stringify(resetAt)};
    const previousResetAt = new Date(Date.parse(resetAt) - 60 * 60_000).toISOString();
    const nextResetAt = new Date(Date.parse(resetAt) + 60 * 60_000).toISOString();
    const coverage = usage.githubRestCoverage();
    const record = (overrides) => usage.recordGithubRestUsage({
      occurredAt: new Date().toISOString(),
      source: "background poll",
      method: "GET",
      endpoint: "/repos/:owner/:repo/pulls",
      resource: "core",
      status: 200,
      used: 10,
      remaining: 4990,
      resetAt,
      charged: true,
      coverageEpoch: coverage.epoch,
      ...overrides,
    });
    record({ used: 29 });
    record({ source: "app detail", endpoint: "/repos/:owner/:repo/pulls/:pull_number", used: 30 });
    record({ status: 304, charged: false });
    record({ resource: "search", endpoint: "/search/issues", resetAt: new Date(Date.now() + 60_000).toISOString() });
    record({ resetAt: previousResetAt, used: 120 });
    record({ endpoint: "/rate_limit", resetAt: previousResetAt, used: 9999, charged: false });
    record({ occurredAt: new Date(Date.parse(resetAt) - 90 * 60_000).toISOString(), status: null, used: null, remaining: null, resetAt: null, charged: null });
    const complete = database.githubRestUsage(30, resetAt);
    record({
      occurredAt: new Date(Date.parse(resetAt) - 30 * 60_000).toISOString(),
      resetAt: new Date(Date.parse(resetAt) - 1000).toISOString(),
    });
    const ambiguous = database.githubRestUsage(30, resetAt);
    // GitHub reports fewer requests than this machine was charged for.
    record({ resetAt: nextResetAt, used: 1 });
    record({ resetAt: nextResetAt, used: 1 });
    const negative = database.githubRestUsage(1, nextResetAt);
    record({ status: 502, charged: null });
    const unknownCharge = database.githubRestUsage(30, resetAt);
    settings.writeSettings({ rest_usage_enabled: true });
    const reenabled = database.githubRestUsage(30, resetAt);
    usage.githubRestCoverage();
    const nextSpan = database.githubRestUsage(30, resetAt);
    // A GitHub CLI command spends this budget outside the ledger while it runs. Requests sent
    // meanwhile are still recorded, but their span never attributes the rest of the window.
    const endCliOperation = usage.beginUnmeteredGithubCliOperation();
    const endOtherCliOperation = usage.beginUnmeteredGithubCliOperation();
    const cliCoverage = usage.githubRestCoverage();
    record({ coverageEpoch: cliCoverage.epoch, used: 31 });
    const cliRunning = database.githubRestUsage(31, resetAt);
    endCliOperation();
    const cliEnded = usage.activeGithubRestCoverage();
    endCliOperation();
    const otherCliRunning = usage.githubRestCoverage();
    endOtherCliOperation();
    const afterCli = usage.githubRestCoverage();
    console.log(JSON.stringify({ complete, ambiguous, negative, unknownCharge, reenabled, nextSpan, cliCoverage, cliRunning, cliEnded, otherCliRunning, afterCli }));
    database.db.close();
  `);
  expect(result.complete).toMatchObject({
    localRequests: 3,
    chargedRequests: 2,
    notModifiedRequests: 1,
    unknownChargeRequests: 0,
    windowComplete: true,
    otherRequests: 28,
  });
  expect(result.complete.sources).toEqual([
    { source: "background poll", requests: 2, chargedRequests: 1, notModifiedRequests: 1, unknownChargeRequests: 0 },
    { source: "app detail", requests: 1, chargedRequests: 1, notModifiedRequests: 0, unknownChargeRequests: 0 },
  ]);
  expect(result.complete.history).toHaveLength(72);
  expect(result.complete.history.at(-1)).toMatchObject({ resetAt, used: 30, localRequests: 3, chargedRequests: 2 });
  // The free /rate_limit read reports a different count, so it never stands in for the window's usage.
  expect(result.complete.history.at(-2)).toMatchObject({ used: 120, localRequests: 3, chargedRequests: 1, unknownChargeRequests: 1 });
  // An inconsistent reading is unknown, not zero.
  expect(result.negative).toMatchObject({ chargedRequests: 2, windowComplete: true, otherRequests: null });
  expect(result.ambiguous).toMatchObject({ chargedRequests: 2, unknownChargeRequests: 0, windowComplete: true, otherRequests: null });
  expect(result.unknownCharge).toMatchObject({ unknownChargeRequests: 1, windowComplete: true, otherRequests: null });
  expect(result.reenabled).toMatchObject({ windowComplete: false, otherRequests: null });
  // The span opened after re-enabling holds none of the window's charged readings.
  expect(result.nextSpan).toMatchObject({ localRequests: 0, windowComplete: true, otherRequests: null });
  expect(result.cliCoverage.eligible).toBe(false);
  expect(result.cliRunning).toMatchObject({ localRequests: 1, chargedRequests: 1, windowComplete: false, otherRequests: null });
  expect(result.cliEnded).toBeNull();
  // Ending one command twice does not release another one's hold.
  expect(result.otherCliRunning.eligible).toBe(false);
  expect(result.afterCli.eligible).toBe(true);
});

test("/rate_limit's own core count never yields a REST remainder", async () => {
  const result = await runScenario(`
    const settings = await import(${JSON.stringify(settingsModuleUrl)});
    const github = await import(${JSON.stringify(githubModuleUrl)});
    const database = await import(${JSON.stringify(dbModuleUrl)});
    // A window that starts after recording began, as if all of it had been observed.
    const reset = Math.ceil(Date.now() / 1000) + 2 * 60 * 60;
    const pool = (limit, used) => ({ limit, used, remaining: limit - used, reset });
    globalThis.fetch = async () => Response.json(
      { resources: { core: pool(5000, 1), graphql: pool(5000, 0), search: pool(30, 0) } },
      {
        headers: {
          "x-ratelimit-resource": "core",
          "x-ratelimit-limit": "5000",
          "x-ratelimit-used": "1",
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-reset": String(reset),
        },
      },
    );
    settings.writeSettings({ rest_usage_enabled: true });
    const quota = await github.fetchGithubQuota();
    console.log(JSON.stringify({ reset, quota: quota.rest, summary: database.githubRestUsage(quota.rest.used, quota.rest.resetAt) }));
    database.db.close();
  `);
  // The quota display keeps /rate_limit's reading; the ledger has no charged core response to trust.
  expect(result.quota).toMatchObject({ used: 1, resetAt: new Date(result.reset * 1000).toISOString() });
  expect(result.summary).toMatchObject({
    localRequests: 1,
    chargedRequests: 0,
    unknownChargeRequests: 0,
    windowComplete: true,
    otherRequests: null,
  });
});

test("a credential change starts a new coverage span even when GitHub reports the same reset", async () => {
  // gh answers the token in its directory; signing in again replaces token A with token B.
  const gh = [
    "#!/bin/sh",
    "token=\"$(dirname \"$0\")/token\"",
    "case \"$1 $2\" in",
    "  'auth token') [ -s \"$token\" ] && cat \"$token\" ;;",
    "  'auth login') printf 'token-b\\n' > \"$token\" ;;",
    "esac",
    "",
  ].join("\n");
  const result = await runScenario(`
    import { rmSync, writeFileSync } from "node:fs";
    // The scenario's clock, moved instead of waiting for GitHub's hourly windows. It is set before
    // the modules load, so their start times read it too.
    const RealDate = Date;
    let offset = -45 * 60_000;
    globalThis.Date = class extends RealDate {
      constructor(...args) {
        super(...(args.length === 0 ? [RealDate.now() + offset] : args));
      }
      static now() {
        return RealDate.now() + offset;
      }
    };
    const settings = await import(${JSON.stringify(settingsModuleUrl)});
    const github = await import(${JSON.stringify(githubModuleUrl)});
    const database = await import(${JSON.stringify(dbModuleUrl)});
    const tokenFile = process.env.COCKPIT_DATA_DIR + "/token";
    writeFileSync(tokenFile, "token-a\\n");
    const reset = Math.ceil(RealDate.now() / 1000) + 30 * 60;
    let windowReset = reset;
    let used = 0;
    const tokens = [];
    globalThis.fetch = async (input, init = {}) => {
      tokens.push(init.headers.Authorization);
      used++;
      return Response.json([], {
        headers: {
          "x-ratelimit-resource": "core",
          "x-ratelimit-limit": "5000",
          "x-ratelimit-used": String(used),
          "x-ratelimit-remaining": String(5000 - used),
          "x-ratelimit-reset": String(windowReset),
        },
      });
    };
    const summary = (resetSeconds) => database.githubRestUsage(used, new RealDate(resetSeconds * 1000).toISOString());
    // Token A is recorded from before the window began.
    settings.writeSettings({ rest_usage_enabled: true });
    await github.fetchAssignableUsers("acme/app");
    offset = 0;
    used++;
    await github.fetchAssignableUsers("acme/app");
    const tokenA = summary(reset);
    // Signing in again mid-window switches to token B, whose responses report the same reset.
    rmSync(tokenFile);
    await github.startGithubSetup();
    // The sign-in runs in the background; the cached token is dropped once gh exits.
    while ((await github.ghToken()) !== "token-b") {
      const turn = Promise.withResolvers();
      setImmediate(turn.resolve);
      await turn.promise;
    }
    await github.fetchAssignableUsers("acme/app");
    const tokenB = summary(reset);
    // The next window is token B's alone.
    offset = 40 * 60_000;
    windowReset = reset + 60 * 60;
    used = 2;
    await github.fetchAssignableUsers("acme/app");
    const nextWindow = summary(windowReset);
    console.log(JSON.stringify({ tokens, tokenA, tokenB, nextWindow }));
    database.db.close();
  `, gh);
  expect(result.tokens).toEqual(["bearer token-a", "bearer token-a", "bearer token-b", "bearer token-b"]);
  expect(result.tokenA).toMatchObject({ chargedRequests: 2, windowComplete: true, otherRequests: 1 });
  // Token A's charges are not subtracted from token B's count, and B was not recorded for the whole window.
  expect(result.tokenB).toMatchObject({ localRequests: 1, chargedRequests: 1, windowComplete: false, otherRequests: null });
  expect(result.nextWindow).toMatchObject({ localRequests: 1, chargedRequests: 1, windowComplete: true, otherRequests: 2 });
});

test("a GitHub CLI auth check holds coverage ineligible while it runs, since gh's API request is not in the ledger", async () => {
  const gh = [
    "#!/bin/sh",
    "[ \"$1 $2\" = 'auth status' ] && printf '%s' '{\"hosts\":{\"github.com\":[{\"active\":true,\"state\":\"success\",\"login\":\"octocat\",\"scopes\":\"repo, workflow\"}]}}'",
    "exit 0",
    "",
  ].join("\n");
  const result = await runScenario(`
    const github = await import(${JSON.stringify(githubModuleUrl)});
    const usage = await import(${JSON.stringify(usageModuleUrl)});
    usage.githubRestCoverage();
    const check = github.githubAuthStatus(["repo"]);
    const duringCheck = usage.githubRestCoverage();
    const status = await check;
    const afterCheck = usage.activeGithubRestCoverage();
    const nextSpan = usage.githubRestCoverage();
    console.log(JSON.stringify({ ok: status.ok, duringCheck: duringCheck.eligible, afterCheck, nextSpan: nextSpan.eligible }));
  `, gh);
  expect(result).toEqual({ ok: true, duringCheck: false, afterCheck: null, nextSpan: true });
});

test("only requests sent and settled while one recording span runs enter the REST ledger", async () => {
  const result = await runScenario(`
    const settings = await import(${JSON.stringify(settingsModuleUrl)});
    const github = await import(${JSON.stringify(githubModuleUrl)});
    const usage = await import(${JSON.stringify(usageModuleUrl)});
    const database = await import(${JSON.stringify(dbModuleUrl)});
    const reset = Math.ceil(Date.now() / 1000) + 30 * 60;
    const sent = { "sent-off": Promise.withResolvers(), "sent-before-reenable": Promise.withResolvers() };
    const settle = { "sent-off": Promise.withResolvers(), "sent-before-reenable": Promise.withResolvers() };
    globalThis.fetch = async (input) => {
      const repo = new URL(String(input)).pathname.split("/")[3];
      sent[repo]?.resolve();
      await settle[repo]?.promise;
      return Response.json([], {
        headers: {
          "x-ratelimit-resource": "core",
          "x-ratelimit-limit": "5000",
          "x-ratelimit-used": "1",
          "x-ratelimit-remaining": "4999",
          "x-ratelimit-reset": String(reset),
        },
      });
    };
    // Sent while recording is off, settled after it is switched on.
    const sentOff = usage.withGithubUsageSource("relay", () => github.fetchAssignableUsers("acme/sent-off"));
    await sent["sent-off"].promise;
    settings.writeSettings({ rest_usage_enabled: true });
    settle["sent-off"].resolve();
    await sentOff;
    // Sent while recording is on, settled after it is switched off and on again.
    const sentBefore = usage.withGithubUsageSource("agent read", () => github.fetchAssignableUsers("acme/sent-before-reenable"));
    await sent["sent-before-reenable"].promise;
    settings.writeSettings({ rest_usage_enabled: false });
    settings.writeSettings({ rest_usage_enabled: true });
    settle["sent-before-reenable"].resolve();
    await sentBefore;
    await usage.withGithubUsageSource("background poll", () => github.fetchAssignableUsers("acme/settled"));
    console.log(JSON.stringify(database.db.query("SELECT source, status, charged FROM github_rest_usage ORDER BY id").all()));
    database.db.close();
  `);
  expect(result).toEqual([{ source: "background poll", status: 200, charged: 1 }]);
});

test("a failed SQLite write invalidates external attribution through recovery", async () => {
  const result = await runScenario(`
    const database = await import(${JSON.stringify(dbModuleUrl)});
    const usage = await import(${JSON.stringify(usageModuleUrl)});
    const settings = await import(${JSON.stringify(settingsModuleUrl)});
    settings.writeSettings({ rest_usage_enabled: true });
    const RealDate = Date;
    const present = RealDate.now();
    let clock = present - 60 * 60_000;
    globalThis.Date = class extends RealDate {
      constructor(value) { super(arguments.length ? value : clock); }
      static now() { return clock; }
    };
    const coverage = usage.githubRestCoverage();
    clock = present;
    const resetAt = new Date(clock + 30 * 60_000).toISOString();
    const event = {
      occurredAt: new Date().toISOString(), source: "user action", method: "GET",
      endpoint: "/user", resource: "core", status: 200, used: 9, remaining: 4991,
      resetAt, charged: true, coverageEpoch: coverage.epoch,
    };
    usage.recordGithubRestUsage(event);
    const before = database.githubRestUsage(9, resetAt);
    database.db.exec("PRAGMA query_only = ON");
    usage.recordGithubRestUsage({ ...event, used: 10, remaining: 4990 });
    const failed = database.githubRestUsage(10, resetAt);
    database.db.exec("PRAGMA query_only = OFF");
    const recovered = usage.githubRestCoverage();
    usage.recordGithubRestUsage({ ...event, used: 11, remaining: 4989, coverageEpoch: recovered.epoch });
    const after = database.githubRestUsage(11, resetAt);
    console.log(JSON.stringify({ before, failed, after }));
    database.db.close();
  `);
  expect(result.before.windowComplete).toBe(true);
  expect(result.before.otherRequests).toBe(8);
  expect(result.failed.windowComplete).toBe(false);
  expect(result.failed.otherRequests).toBeNull();
  expect(result.after.localRequests).toBe(1);
  expect(result.after.windowComplete).toBe(false);
  expect(result.after.otherRequests).toBeNull();
});

test("a native HTTP redirect leaves its combined REST charge unknown", async () => {
  const result = await runScenario(`
    const settings = await import(${JSON.stringify(settingsModuleUrl)});
    const database = await import(${JSON.stringify(dbModuleUrl)});
    const github = await import(${JSON.stringify(githubModuleUrl)});
    settings.writeSettings({ rest_usage_enabled: true });
    const nativeFetch = globalThis.fetch;
    const paths = [];
    const resetSeconds = Math.ceil(Date.now() / 1000) + 30 * 60;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        paths.push(path);
        if (path === "/repos/fixture/repository/labels") {
          return Response.redirect(new URL("/followed", server.url).href, 301);
        }
        return Response.json([{ name: "fixture-label", color: "abcdef" }], { headers: {
          "x-ratelimit-resource": "core", "x-ratelimit-used": "2",
          "x-ratelimit-remaining": "4998", "x-ratelimit-reset": String(resetSeconds),
        } });
      },
    });
    globalThis.fetch = (input, init) => {
      const url = new URL(String(input));
      if (url.hostname !== "api.github.com") throw new Error("Unexpected fixture request");
      return nativeFetch(new URL(url.pathname + url.search, server.url), init);
    };
    try {
      await github.fetchRepoLabels("fixture/repository");
      console.log(JSON.stringify({
        paths,
        summary: database.githubRestUsage(2, new Date(resetSeconds * 1000).toISOString()),
        charges: database.db.query("SELECT charged FROM github_rest_usage ORDER BY id").all(),
      }));
    } finally {
      server.stop(true);
      database.db.close();
    }
  `);
  expect(result.paths).toEqual(["/repos/fixture/repository/labels", "/followed"]);
  expect(result.charges).toEqual([{ charged: null }]);
  expect(result.summary.unknownChargeRequests).toBe(1);
  expect(result.summary.otherRequests).toBeNull();
});

test("private identifiers matching route keywords stay masked without masking collection routes", () => {
  expect(normalizeGithubRestEndpoint("/repos/fixture/repository/labels/status?token=private"))
    .toBe("/repos/:owner/:repo/labels/:name");
  expect(normalizeGithubRestEndpoint("/users/repos"))
    .toBe("/users/:username");
  expect(normalizeGithubRestEndpoint("/repos/fixture/repository/commits/labels/status"))
    .toBe("/repos/:owner/:repo/commits/:sha/status");
  expect(normalizeGithubRestEndpoint("/repos/fixture/repository/issues/events"))
    .toBe("/repos/:owner/:repo/issues/events");
  expect(normalizeGithubRestEndpoint("/repos/fixture/repository/pulls/comments/123"))
    .toBe("/repos/:owner/:repo/pulls/comments/:comment_id");
});

test("concurrent Cockpit charges never become other-client usage before responses settle", async () => {
  const result = await runScenario(`
    const RealDate = Date;
    let offset = -45 * 60_000;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [RealDate.now() + offset])); }
      static now() { return RealDate.now() + offset; }
    };
    const settings = await import(${JSON.stringify(settingsModuleUrl)});
    const github = await import(${JSON.stringify(githubModuleUrl)});
    const database = await import(${JSON.stringify(dbModuleUrl)});
    const reset = Math.ceil(RealDate.now() / 1000) + 30 * 60;
    let used = 0;
    const held = Promise.withResolvers();
    const received = Promise.withResolvers();
    globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      used++;
      const headers = {
        "x-ratelimit-resource": "core", "x-ratelimit-limit": "5000",
        "x-ratelimit-used": String(used), "x-ratelimit-remaining": String(5000 - used),
        "x-ratelimit-reset": String(offset < 0 ? reset - 3600 : reset),
      };
      if (path === "/repos/fixture/slow/assignees") {
        received.resolve();
        await held.promise;
      }
      return Response.json([], { headers });
    };
    settings.writeSettings({ rest_usage_enabled: true });
    await github.fetchAssignableUsers("fixture/before");
    offset = 0;
    used = 0;
    const slow = github.fetchAssignableUsers("fixture/slow");
    await received.promise;
    await github.fetchAssignableUsers("fixture/fast");
    const inFlight = database.githubRestUsage(used, new RealDate(reset * 1000).toISOString());
    held.resolve();
    await slow;
    const settled = database.githubRestUsage(used, new RealDate(reset * 1000).toISOString());
    console.log(JSON.stringify({ inFlight, settled }));
    database.db.close();
  `);
  expect(result.inFlight.windowComplete).toBe(true);
  expect(result.inFlight.localRequests).toBe(1);
  expect(result.inFlight.otherRequests).toBeNull();
  expect(result.settled.localRequests).toBe(2);
  expect(result.settled.chargedRequests).toBe(2);
  expect(result.settled.otherRequests).toBe(0);
});

test("a charged answer without quota headers cannot be subtracted from an earlier reading", async () => {
  const result = await runScenario(`
    const database = await import(${JSON.stringify(dbModuleUrl)});
    const usage = await import(${JSON.stringify(usageModuleUrl)});
    const settings = await import(${JSON.stringify(settingsModuleUrl)});
    settings.writeSettings({ rest_usage_enabled: true });
    const RealDate = Date;
    const present = RealDate.now();
    let clock = present - 60 * 60_000;
    globalThis.Date = class extends RealDate {
      constructor(value) { super(arguments.length ? value : clock); }
      static now() { return clock; }
    };
    const coverage = usage.githubRestCoverage();
    clock = present;
    const resetAt = new Date(clock + 30 * 60_000).toISOString();
    const event = {
      occurredAt: new Date().toISOString(), source: "user action", method: "GET",
      endpoint: "/user", resource: "core", status: 200, used: 9, remaining: 4991,
      resetAt, charged: true, coverageEpoch: coverage.epoch,
    };
    usage.recordGithubRestUsage(event);
    const before = database.githubRestUsage(9, resetAt);
    clock += 1_000;
    usage.recordGithubRestUsage({
      ...event, occurredAt: new Date().toISOString(), used: null, remaining: null, resetAt: null,
    });
    const after = database.githubRestUsage(10, resetAt);
    console.log(JSON.stringify({ before, after }));
    database.db.close();
  `);
  expect(result.before.otherRequests).toBe(8);
  expect(result.after.localRequests).toBe(2);
  expect(result.after.chargedRequests).toBe(2);
  expect(result.after.unknownChargeRequests).toBe(0);
  expect(result.after.otherRequests).toBeNull();
});

test("an unrecorded request crossing a new window cannot contaminate a later recording span", async () => {
  const result = await runScenario(`
    const RealDate = Date;
    let clock = Math.floor(RealDate.now() / 1000) * 1000;
    globalThis.Date = class extends RealDate {
      constructor(value) { super(arguments.length ? value : clock); }
      static now() { return clock; }
    };
    const settings = await import(${JSON.stringify(settingsModuleUrl)});
    const github = await import(${JSON.stringify(githubModuleUrl)});
    const database = await import(${JSON.stringify(dbModuleUrl)});
    let resetAt = null;
    let used = 1;
    const held = Promise.withResolvers();
    const received = Promise.withResolvers();
    const headers = (count) => ({
      "x-ratelimit-resource": "core", "x-ratelimit-limit": "5000",
      "x-ratelimit-used": String(count), "x-ratelimit-remaining": String(5000 - count),
      "x-ratelimit-reset": String(Date.parse(resetAt) / 1000),
    });
    globalThis.fetch = async (input) => {
      if (new URL(String(input)).pathname === "/repos/fixture/old/assignees") {
        received.resolve();
        await held.promise;
        return Response.json([], { headers: headers(1) });
      }
      if (resetAt === null) {
        clock += 1_000;
        resetAt = new Date(clock + 60 * 60_000).toISOString();
      }
      return Response.json([], { headers: headers(++used) });
    };
    settings.writeSettings({ rest_usage_enabled: false });
    const old = github.fetchAssignableUsers("fixture/old");
    await received.promise;
    settings.writeSettings({ rest_usage_enabled: true });
    await github.fetchAssignableUsers("fixture/current");
    const during = database.githubRestUsage(used, resetAt);
    held.resolve();
    await old;
    const afterOld = database.githubRestUsage(used, resetAt);
    clock += 1_000;
    await github.fetchAssignableUsers("fixture/fresh");
    const fresh = database.githubRestUsage(used, resetAt);
    console.log(JSON.stringify({ during, afterOld, fresh }));
    database.db.close();
  `);
  expect(result.during.windowComplete).toBe(true);
  expect(result.during.localRequests).toBe(1);
  expect(result.during.otherRequests).toBeNull();
  expect(result.afterOld.windowComplete).toBe(false);
  expect(result.afterOld.otherRequests).toBeNull();
  expect(result.fresh.localRequests).toBe(1);
  expect(result.fresh.windowComplete).toBe(false);
  expect(result.fresh.otherRequests).toBeNull();
});

test("GraphQL traffic preserves a fully covered REST window and its external remainder", async () => {
  const result = await runScenario(`
    const RealDate = Date;
    let offset = -45 * 60_000;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [RealDate.now() + offset])); }
      static now() { return RealDate.now() + offset; }
    };
    const settings = await import(${JSON.stringify(settingsModuleUrl)});
    const github = await import(${JSON.stringify(githubModuleUrl)});
    const database = await import(${JSON.stringify(dbModuleUrl)});
    const reset = Math.ceil(RealDate.now() / 1000) + 30 * 60;
    let used = 4;
    let graphqlRequests = 0;
    globalThis.fetch = async (input) => {
      if (new URL(String(input)).pathname === "/graphql") {
        graphqlRequests++;
        return Response.json({ data: { repository: { pr0: null } } }, { headers: {
          "x-ratelimit-resource": "graphql", "x-ratelimit-limit": "5000",
          "x-ratelimit-used": "1", "x-ratelimit-remaining": "4999", "x-ratelimit-reset": String(reset),
        } });
      }
      return Response.json([], { headers: {
        "x-ratelimit-resource": "core", "x-ratelimit-limit": "5000",
        "x-ratelimit-used": String(++used), "x-ratelimit-remaining": String(5000 - used),
        "x-ratelimit-reset": String(offset < 0 ? reset - 3600 : reset),
      } });
    };
    const summary = () => database.githubRestUsage(used, new RealDate(reset * 1000).toISOString());
    settings.writeSettings({ rest_usage_enabled: true });
    await github.fetchAssignableUsers("fixture/before");
    offset = 0;
    used = 4;
    await github.fetchAssignableUsers("fixture/first");
    const beforeGraphql = summary();
    await github.lookupPrIndexes("fixture/repository", [1]);
    const afterGraphql = summary();
    await github.fetchAssignableUsers("fixture/second");
    const afterRest = summary();
    console.log(JSON.stringify({ graphqlRequests, beforeGraphql, afterGraphql, afterRest }));
    database.db.close();
  `);
  expect(result.graphqlRequests).toBe(1);
  expect(result.beforeGraphql.otherRequests).toBe(4);
  expect(result.afterGraphql.otherRequests).toBe(4);
  expect(result.afterGraphql.localRequests).toBe(1);
  expect(result.afterRest.otherRequests).toBe(4);
  expect(result.afterRest.localRequests).toBe(2);
});
