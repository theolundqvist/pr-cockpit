import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const githubModuleUrl = new URL("./github.ts", import.meta.url).href;
const systemIssuesModuleUrl = new URL("./systemIssues.ts", import.meta.url).href;
const githubUsageModuleUrl = new URL("./githubUsage.ts", import.meta.url).href;
const githubAuthModuleUrl = new URL("./githubAuth.ts", import.meta.url).href;
// Child processes install transport and auth isolation before github.ts evaluates, so static imports cannot exercise these boundaries.

test("closed PR search isolates inaccessible repositories", async () => {
  const fakeGhDir = mkdtempSync(join(tmpdir(), "pr-cockpit-search-isolation-"));
  const fakeGh = join(fakeGhDir, "gh");
  writeFileSync(fakeGh, "#!/bin/sh\nprintf 'fixture-token\\n'\n");
  chmodSync(fakeGh, 0o755);
  try {
    const script = `
      const { searchClosedPrs } = await import(${JSON.stringify(githubModuleUrl)});
      const { systemIssues } = await import(${JSON.stringify(systemIssuesModuleUrl)});
      const queries = [];
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        const query = url.searchParams.get("q");
        queries.push(query);
        if (query.includes("repo:acme/hidden")) {
          return Response.json({ message: "Validation Failed" }, {
            status: 422,
            headers: { "x-ratelimit-reset": String((Date.now() + 60_000) / 1000) },
          });
        }
        const repo = query.includes("repo:acme/first") ? "acme/first" : "acme/last";
        return Response.json({ items: [{
          number: repo === "acme/first" ? 1 : 3,
          title: "Closed pull request",
          state: "closed",
          draft: false,
          updated_at: "2026-09-01T00:00:00Z",
          closed_at: "2026-09-01T00:00:00Z",
          user: { login: "reviewer" },
          repository_url: "https://api.github.com/repos/" + repo,
          pull_request: { merged_at: null },
        }] });
      };
      const result = await searchClosedPrs(["acme/first", "acme/hidden", "acme/last"]);
      console.log(JSON.stringify({
        queries,
        items: result.items.map((item) => item.repo),
        failures: result.failures.map(({ repo, error }) => ({ repo, status: error.status, kind: error.kind, resource: error.resource, resetAt: error.resetAt })),
        unavailableRepos: systemIssues().flatMap((issue) => issue.repo ? [issue.repo] : []),
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
    const result = JSON.parse(stdout);
    expect(result.queries).toHaveLength(3);
    expect(result.queries.every((query: string) => (query.match(/repo:/g) ?? []).length === 1)).toBe(true);
    expect(result.items).toEqual(["acme/first", "acme/last"]);
    expect(result.failures).toEqual([]);
    expect(result.unavailableRepos).toEqual(["acme/hidden"]);
  } finally {
    rmSync(fakeGhDir, { recursive: true, force: true });
  }
});

test("quota readings are shared by concurrent callers and reusable for pacing until stale or reset", async () => {
  const fakeGhDir = mkdtempSync(join(tmpdir(), "pr-cockpit-quota-reuse-"));
  const fakeGh = join(fakeGhDir, "gh");
  writeFileSync(fakeGh, "#!/bin/sh\nprintf 'fixture-token\\n'\n");
  chmodSync(fakeGh, 0o755);
  try {
    const script = `
      const github = await import(${JSON.stringify(githubModuleUrl)});
      const reset = Math.floor(Date.now() / 1000) + 30 * 60;
      let rateLimitCalls = 0;
      globalThis.fetch = async (input) => {
        if (new URL(String(input)).pathname !== "/rate_limit") throw new Error("unexpected request");
        rateLimitCalls++;
        await Bun.sleep(10);
        const window = { limit: 5000, used: 100, remaining: 4900, reset };
        return Response.json({ resources: { core: window, graphql: window } });
      };
      const before = github.recentGithubQuota(5 * 60_000);
      await Promise.all([github.fetchGithubQuota(), github.fetchGithubQuota(), github.fetchGithubQuota()]);
      const now = Date.now();
      console.log(JSON.stringify({
        before,
        rateLimitCalls,
        twoMinutesLater: github.recentGithubQuota(5 * 60_000, now + 2 * 60_000)?.graphql.remaining ?? null,
        tenMinutesLater: github.recentGithubQuota(5 * 60_000, now + 10 * 60_000),
        afterReset: github.recentGithubQuota(60 * 60_000, (reset + 1) * 1000),
      }));
    `;
    const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...Bun.env, COCKPIT_GH_BIN: fakeGh, COCKPIT_MOCK: "", COCKPIT_MOCK_DATA: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      before: null,
      rateLimitCalls: 1,
      twoMinutesLater: 4900,
      tenMinutesLater: null,
      afterReset: null,
    });
  } finally {
    rmSync(fakeGhDir, { recursive: true, force: true });
  }
});

test("non-quota GraphQL errors do not expose the ordinary rate-window reset", async () => {
  const fakeGhDir = mkdtempSync(join(tmpdir(), "pr-cockpit-graphql-error-reset-"));
  const fakeGh = join(fakeGhDir, "gh");
  writeFileSync(fakeGh, "#!/bin/sh\nprintf 'fixture-token\\n'\n");
  chmodSync(fakeGh, 0o755);
  try {
    const script = `
      const github = await import(${JSON.stringify(githubModuleUrl)});
      globalThis.fetch = async () => Response.json({
        errors: [{ type: "NOT_FOUND", message: "Pull request is absent or inaccessible" }],
      }, {
        headers: {
          "x-ratelimit-resource": "graphql",
          "x-ratelimit-remaining": "20",
          "x-ratelimit-reset": String((Date.now() + 60_000) / 1000),
        },
      });
      try {
        await github.fetchRepositoryOpenPrs("acme/app");
      } catch (error) {
        console.log(JSON.stringify({ status: error.status, kind: error.kind, resetAt: error.resetAt }));
      }
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
    expect(JSON.parse(stdout)).toEqual({ status: 404, kind: "graphql", resetAt: null });
  } finally {
    rmSync(fakeGhDir, { recursive: true, force: true });
  }
});

test("quota boundaries isolate search, GraphQL, and core while transport and mutation failures stay typed", async () => {
  const fakeGhDir = mkdtempSync(join(tmpdir(), "pr-cockpit-github-errors-"));
  const fakeGh = join(fakeGhDir, "gh");
  writeFileSync(fakeGh, "#!/bin/sh\nprintf 'fixture-token\\n'\n");
  chmodSync(fakeGh, 0o755);
  try {
    const script = `
      let now = 2_000_000_000_000;
      Date.now = () => now;
      const github = await import(${JSON.stringify(githubModuleUrl)});
      const usage = await import(${JSON.stringify(githubUsageModuleUrl)});
      const graphqlUsage = [];
      usage.setGithubGraphqlUsageRecorder((event) => graphqlUsage.push(event));
      const calls = { search: 0, graphql: 0, core: 0, gateway: 0, mutation: 0, transport: 0 };
      let searchLimited = true;
      let graphqlLimited = true;
      let coreLimited = false;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        // A blocked resource is revalidated against /rate_limit before being refused. Exhaustion is
        // genuine here, so report zero and let the recorded block stand.
        if (url.pathname === "/rate_limit") {
          return Response.json({
            resources: { core: { remaining: 0 }, search: { remaining: 0 }, graphql: { remaining: 0 } },
          });
        }
        if (url.pathname === "/search/issues") {
          calls.search++;
          if (searchLimited) {
            searchLimited = false;
            return Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: {
              "x-ratelimit-resource": "search", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((now + 1000) / 1000),
            } });
          }
          return Response.json({ items: [] }, { headers: { "x-ratelimit-resource": "search", "x-ratelimit-remaining": "10" } });
        }
        if (url.pathname === "/graphql") {
          calls.graphql++;
          if (graphqlLimited) {
            graphqlLimited = false;
            return Response.json({ errors: [{ type: "RATE_LIMIT", message: "quota exhausted" }] }, { headers: {
              "x-ratelimit-resource": "graphql", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((now + 1000) / 1000),
            } });
          }
          return Response.json({ data: { repository: { pullRequests: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }, {
            headers: { "x-ratelimit-resource": "graphql", "x-ratelimit-remaining": "10" },
          });
        }
        if (url.pathname === "/repos/acme/app/pulls/9") {
          calls.gateway++;
          return new Response("bad gateway", { status: 502, headers: { "x-ratelimit-reset": String((now + 60_000) / 1000) } });
        }
        if (url.pathname.endsWith("/rerun-failed-jobs")) {
          calls.mutation++;
          return new Response("gateway timeout", { status: 504 });
        }
        if (url.pathname.includes("/contents/")) {
          calls.transport++;
          const certificate = Object.assign(new Error("certificate verify failed"), { code: "CERT_HAS_EXPIRED" });
          throw new TypeError("fetch failed", { cause: certificate });
        }
        calls.core++;
        if (coreLimited) {
          coreLimited = false;
          return Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: {
            "x-ratelimit-resource": "core", "retry-after": "1",
          } });
        }
        return Response.json({ workflows: [] }, { headers: { "x-ratelimit-resource": "core", "x-ratelimit-remaining": "10" } });
      };
      const capture = async (fn) => { try { await fn(); return null; } catch (error) { return error; } };

      const searchFirst = await capture(() => github.searchRecentPrs("acme/app"));
      const searchBlocked = await capture(() => github.searchRecentPrs("acme/app"));
      await github.fetchActionWorkflows("acme/app");
      now += 1000;
      await github.searchRecentPrs("acme/app");

      const graphqlFirst = await capture(() => github.fetchRepositoryOpenPrs("acme/app"));
      const graphqlBlocked = await capture(() => github.fetchRepositoryOpenPrs("acme/app"));
      await github.searchRecentPrs("acme/app");
      now += 1000;
      await github.fetchRepositoryOpenPrs("acme/app");

      coreLimited = true;
      const coreFirst = await capture(() => github.fetchActionWorkflows("acme/app"));
      const coreBlocked = await capture(() => github.fetchActionWorkflows("acme/app"));
      await github.searchRecentPrs("acme/app");
      now += 1000;
      await github.fetchActionWorkflows("acme/app");

      const gateway = await capture(() => github.fetchDiff("acme/app", 9));
      const mutation = await capture(() => github.rerunFailedJobs("acme/app", 7));
      const transport = await capture(() => github.fetchFileContents("acme/app", "README.txt", "abc"));
      const shape = (error) => ({ status: error.status, kind: error.kind, resource: error.resource, resetAt: error.resetAt });
      console.log(JSON.stringify({
        calls,
        searchFirst: shape(searchFirst), searchBlocked: shape(searchBlocked),
        graphqlFirst: shape(graphqlFirst), graphqlBlocked: shape(graphqlBlocked),
        coreFirst: shape(coreFirst), coreBlocked: shape(coreBlocked),
        gateway: shape(gateway),
        mutation: shape(mutation), mutationType: mutation instanceof github.RestRequestError,
        transport: shape(transport), transportType: transport instanceof github.GithubRequestError,
        graphqlUsage: graphqlUsage.map(({ status }) => status),
        transportCause: transport.cause?.cause?.code,
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
    const result = JSON.parse(stdout);
    expect(result.calls).toEqual({ search: 4, graphql: 2, core: 3, gateway: 1, mutation: 1, transport: 1 });
    expect(result.searchFirst).toMatchObject({ status: 403, kind: "quota", resource: "search" });
    expect(result.searchBlocked).toMatchObject({ status: 403, kind: "quota", resource: "search" });
    expect(result.graphqlFirst).toMatchObject({ status: 403, kind: "quota", resource: "graphql" });
    expect(result.graphqlBlocked).toMatchObject({ status: 403, kind: "quota", resource: "graphql" });
    expect(result.coreFirst).toMatchObject({ status: 403, kind: "quota", resource: "core" });
    expect(result.coreBlocked).toMatchObject({ status: 403, kind: "quota", resource: "core" });
    expect(result.graphqlUsage).toEqual(["error", "ok"]);
    expect(result.gateway).toMatchObject({ status: 502, kind: "http", resource: "core", resetAt: null });
    expect(result.mutation).toMatchObject({ status: 504, kind: "http", resource: "core", resetAt: null });
    expect(result.mutationType).toBe(true);
    expect(result.transport).toMatchObject({ status: 503, kind: "transport", resource: "core", resetAt: null });
    expect(result.transportType).toBe(true);
    expect(result.transportCause).toBe("CERT_HAS_EXPIRED");
  } finally {
    rmSync(fakeGhDir, { recursive: true, force: true });
  }
});

test("quota state follows auth changes and ignores late responses from the previous token", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-quota-auth-switch-"));
  try {
    const script = `
      const { mock } = await import("bun:test");
      let token = "old-token";
      mock.module(${JSON.stringify(githubAuthModuleUrl)}, () => ({
        githubAuthStatus: async () => ({ ok: true, state: "ready", login: "fixture", error: null, requiredScopes: [], missingScopes: [] }),
        startGithubSetup: async () => ({ ok: true, state: "ready", login: "fixture", error: null, requiredScopes: [], missingScopes: [] }),
        liveGithubToken: async () => token,
      }));
      const github = await import(${JSON.stringify(githubModuleUrl)});
      let coreCalls = 0;
      let searchCalls = 0;
      let oldCoreLimited = false;
      const { promise: oldSearchStarted, resolve: markOldSearchStarted } = Promise.withResolvers();
      const { promise: oldSearchResponse, resolve: resolveOldSearch } = Promise.withResolvers();
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        const authorization = new Headers(init?.headers).get("authorization");
        // Revalidation probe before a refusal. Exhaustion is genuine here, so report zero.
        if (url.pathname === "/rate_limit") {
          return Response.json({
            resources: { core: { remaining: 0 }, search: { remaining: 0 }, graphql: { remaining: 0 } },
          });
        }
        if (url.pathname === "/search/issues") {
          searchCalls++;
          if (authorization === "bearer old-token") {
            markOldSearchStarted();
            return oldSearchResponse;
          }
          return Response.json({ items: [] }, { headers: { "x-ratelimit-resource": "search", "x-ratelimit-remaining": "10" } });
        }
        coreCalls++;
        if (authorization === "bearer old-token" && !oldCoreLimited) {
          oldCoreLimited = true;
          return Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: {
            "x-ratelimit-resource": "core",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String((Date.now() + 60_000) / 1000),
          } });
        }
        return Response.json({ workflows: [] }, { headers: { "x-ratelimit-resource": "core", "x-ratelimit-remaining": "10" } });
      };
      const capture = async (fn) => { try { await fn(); return null; } catch (error) { return error; } };
      const oldLimited = await capture(() => github.fetchActionWorkflows("acme/app"));
      const oldBlocked = await capture(() => github.fetchActionWorkflows("acme/app"));
      token = "new-token";
      await github.fetchActionWorkflows("acme/app");

      token = "old-token";
      const lateOld = capture(() => github.searchRecentPrs("acme/app"));
      await oldSearchStarted;
      token = "new-token";
      await github.fetchActionWorkflows("acme/app");
      resolveOldSearch(Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: {
        "x-ratelimit-resource": "search",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String((Date.now() + 60_000) / 1000),
      } }));
      const lateOldError = await lateOld;
      await github.searchRecentPrs("acme/app");
      console.log(JSON.stringify({
        coreCalls,
        searchCalls,
        oldLimited: { kind: oldLimited.kind, status: oldLimited.status },
        oldBlocked: { kind: oldBlocked.kind, status: oldBlocked.status },
        lateOld: { kind: lateOldError.kind, status: lateOldError.status },
      }));
    `;
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "", COCKPIT_MOCK_DATA: "" },
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
      coreCalls: 3,
      searchCalls: 2,
      oldLimited: { kind: "quota", status: 403 },
      oldBlocked: { kind: "quota", status: 403 },
      lateOld: { kind: "quota", status: 403 },
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a positive primary budget cannot bypass a secondary retry-after cooldown", async () => {
  const fakeGhDir = mkdtempSync(join(tmpdir(), "pr-cockpit-secondary-limit-"));
  const fakeGh = join(fakeGhDir, "gh");
  writeFileSync(fakeGh, "#!/bin/sh\nprintf 'fixture-token\\n'\n");
  chmodSync(fakeGh, 0o755);
  try {
    const script = `
      let now = 2_000_000_000_000;
      Date.now = () => now;
      const github = await import(${JSON.stringify(githubModuleUrl)});
      let limited = true;
      let probes = 0;
      let targetCalls = 0;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rate_limit") {
          probes++;
          return Response.json({ resources: { core: { remaining: 4999 } } });
        }
        targetCalls++;
        if (limited) {
          limited = false;
          return Response.json({ message: "You have exceeded a secondary rate limit" }, { status: 403, headers: {
            "x-ratelimit-resource": "core",
            "x-ratelimit-remaining": "4999",
            "x-ratelimit-reset": String((now + 3_600_000) / 1000),
            "retry-after": "60",
          } });
        }
        return Response.json({ workflows: [] }, { headers: { "x-ratelimit-resource": "core", "x-ratelimit-remaining": "4999" } });
      };
      const capture = async (fn) => { try { await fn(); return null; } catch (error) { return error; } };

      const first = await capture(() => github.fetchActionWorkflows("acme/app"));
      const during = await capture(() => github.fetchActionWorkflows("acme/app"));
      now += 61_000;
      const after = await capture(() => github.fetchActionWorkflows("acme/app"));
      console.log(JSON.stringify({
        firstKind: first?.kind ?? null,
        blockedDuringCooldown: during?.kind === "quota",
        blockedAfterCooldown: after?.kind === "quota",
        blockedUntil: first?.resetAt ?? null,
        probes,
        targetCalls,
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
      firstKind: "quota",
      blockedDuringCooldown: true,
      blockedAfterCooldown: false,
      blockedUntil: new Date(2_000_000_060_000).toISOString(),
      probes: 0,
      targetCalls: 2,
    });
  } finally {
    rmSync(fakeGhDir, { recursive: true, force: true });
  }
});

test("a body-only secondary limit establishes a fallback cooldown", async () => {
  const fakeGhDir = mkdtempSync(join(tmpdir(), "pr-cockpit-secondary-fallback-"));
  const fakeGh = join(fakeGhDir, "gh");
  writeFileSync(fakeGh, "#!/bin/sh\nprintf 'fixture-token\\n'\n");
  chmodSync(fakeGh, 0o755);
  try {
    const script = `
      let now = 2_000_000_000_000;
      Date.now = () => now;
      const github = await import(${JSON.stringify(githubModuleUrl)});
      let limited = true;
      let probes = 0;
      let targetCalls = 0;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rate_limit") {
          probes++;
          return Response.json({ resources: { core: { remaining: 4999 } } });
        }
        targetCalls++;
        if (limited) {
          limited = false;
          return Response.json({ message: "You have exceeded a secondary rate limit" }, { status: 403, headers: {
            "x-ratelimit-resource": "core",
            "x-ratelimit-remaining": "4999",
          } });
        }
        return Response.json({ workflows: [] }, { headers: { "x-ratelimit-resource": "core", "x-ratelimit-remaining": "4999" } });
      };
      const capture = async (fn) => { try { await fn(); return null; } catch (error) { return error; } };

      const first = await capture(() => github.fetchActionWorkflows("acme/app"));
      const during = await capture(() => github.fetchActionWorkflows("acme/app"));
      now += 301_000;
      const after = await capture(() => github.fetchActionWorkflows("acme/app"));
      console.log(JSON.stringify({
        firstKind: first?.kind ?? null,
        blockedDuringCooldown: during?.kind === "quota",
        blockedAfterCooldown: after?.kind === "quota",
        blockedUntil: first?.resetAt ?? null,
        probes,
        targetCalls,
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
      firstKind: "quota",
      blockedDuringCooldown: true,
      blockedAfterCooldown: false,
      blockedUntil: new Date(2_000_000_300_000).toISOString(),
      probes: 0,
      targetCalls: 2,
    });
  } finally {
    rmSync(fakeGhDir, { recursive: true, force: true });
  }
});

test("a concurrent successful response cannot clear a newer secondary cooldown", async () => {
  const fakeGhDir = mkdtempSync(join(tmpdir(), "pr-cockpit-secondary-race-"));
  const fakeGh = join(fakeGhDir, "gh");
  writeFileSync(fakeGh, "#!/bin/sh\nprintf 'fixture-token\\n'\n");
  chmodSync(fakeGh, 0o755);
  try {
    const script = `
      const github = await import(${JSON.stringify(githubModuleUrl)});
      const { promise: firstResponse, resolve: resolveFirst } = Promise.withResolvers();
      const { promise: firstStarted, resolve: markFirstStarted } = Promise.withResolvers();
      let targetCalls = 0;
      let probes = 0;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rate_limit") {
          probes++;
          return Response.json({ resources: { core: { remaining: 4999 } } });
        }
        targetCalls++;
        if (targetCalls === 1) {
          markFirstStarted();
          return firstResponse;
        }
        if (targetCalls === 2) {
          return Response.json({ message: "secondary rate limit" }, { status: 403, headers: {
            "x-ratelimit-resource": "core",
            "x-ratelimit-remaining": "4999",
            "retry-after": "60",
          } });
        }
        return Response.json({ workflows: [] }, { headers: { "x-ratelimit-resource": "core", "x-ratelimit-remaining": "4999" } });
      };
      const capture = async (fn) => { try { await fn(); return null; } catch (error) { return error; } };

      const earlier = capture(() => github.fetchActionWorkflows("acme/app"));
      await firstStarted;
      const limited = await capture(() => github.fetchActionWorkflows("acme/app"));
      resolveFirst(Response.json({ workflows: [] }, {
        headers: { "x-ratelimit-resource": "core", "x-ratelimit-remaining": "4999" },
      }));
      await earlier;
      const afterLateSuccess = await capture(() => github.fetchActionWorkflows("acme/app"));
      console.log(JSON.stringify({
        limited: limited?.kind === "quota",
        blockedAfterLateSuccess: afterLateSuccess?.kind === "quota",
        targetCalls,
        probes,
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
      limited: true,
      blockedAfterLateSuccess: true,
      targetCalls: 2,
      probes: 0,
    });
  } finally {
    rmSync(fakeGhDir, { recursive: true, force: true });
  }
});

test("primary exhaustion and secondary cooldown from one response are both retained", async () => {
  const fakeGhDir = mkdtempSync(join(tmpdir(), "pr-cockpit-combined-limit-"));
  const fakeGh = join(fakeGhDir, "gh");
  writeFileSync(fakeGh, "#!/bin/sh\nprintf 'fixture-token\\n'\n");
  chmodSync(fakeGh, 0o755);
  try {
    const script = `
      let now = 2_000_000_000_000;
      Date.now = () => now;
      const github = await import(${JSON.stringify(githubModuleUrl)});
      let limited = true;
      let probes = 0;
      let targetCalls = 0;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rate_limit") {
          probes++;
          return Response.json({ resources: { core: { remaining: 5000 } } });
        }
        targetCalls++;
        if (limited) {
          limited = false;
          return Response.json({ message: "both limits" }, { status: 403, headers: {
            "x-ratelimit-resource": "core",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String((now + 3_600_000) / 1000),
            "retry-after": "60",
          } });
        }
        return Response.json({ workflows: [] }, { headers: { "x-ratelimit-resource": "core", "x-ratelimit-remaining": "5000" } });
      };
      const capture = async (fn) => { try { await fn(); return null; } catch (error) { return error; } };

      const first = await capture(() => github.fetchActionWorkflows("acme/app"));
      const duringSecondary = await capture(() => github.fetchActionWorkflows("acme/app"));
      now += 61_000;
      const afterRefill = await capture(() => github.fetchActionWorkflows("acme/app"));
      console.log(JSON.stringify({
        firstResetAt: first?.resetAt,
        blockedDuringSecondary: duringSecondary?.kind === "quota",
        blockedAfterRefill: afterRefill?.kind === "quota",
        probes,
        targetCalls,
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
      firstResetAt: new Date(2_000_003_600_000).toISOString(),
      blockedDuringSecondary: true,
      blockedAfterRefill: false,
      probes: 1,
      targetCalls: 2,
    });
  } finally {
    rmSync(fakeGhDir, { recursive: true, force: true });
  }
});

test("primary quota revalidation is bounded and clears a refilled budget", async () => {
  const fakeGhDir = mkdtempSync(join(tmpdir(), "pr-cockpit-quota-revalidate-"));
  const fakeGh = join(fakeGhDir, "gh");
  writeFileSync(fakeGh, "#!/bin/sh\nprintf 'fixture-token\\n'\n");
  chmodSync(fakeGh, 0o755);
  try {
    const script = `
      let now = 2_000_000_000_000;
      Date.now = () => now;
      const github = await import(${JSON.stringify(githubModuleUrl)});
      let refilled = false;
      let limited = true;
      let probes = 0;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rate_limit") {
          probes++;
          await Promise.resolve();
          return Response.json({ resources: { core: { remaining: refilled ? 5000 : 0 } } });
        }
        if (limited) {
          limited = false;
          return Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: {
            "x-ratelimit-resource": "core",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String((now + 3_600_000) / 1000),
          } });
        }
        return Response.json({ workflows: [] }, { headers: { "x-ratelimit-resource": "core", "x-ratelimit-remaining": "5000" } });
      };
      const capture = async (fn) => { try { await fn(); return null; } catch (error) { return error; } };

      const first = await capture(() => github.fetchActionWorkflows("acme/app"));
      const blocked = await Promise.all(Array.from({ length: 4 }, () => capture(() => github.fetchActionWorkflows("acme/app"))));
      refilled = true;
      const withinCadence = await capture(() => github.fetchActionWorkflows("acme/app"));
      now += 30_001;
      const afterRefill = await capture(() => github.fetchActionWorkflows("acme/app"));
      console.log(JSON.stringify({
        firstKind: first?.kind ?? null,
        allBlocked: blocked.every((error) => error?.kind === "quota"),
        blockedWithinCadence: withinCadence?.kind === "quota",
        blockedAfterRefill: afterRefill?.kind === "quota",
        probes,
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
      firstKind: "quota",
      allBlocked: true,
      blockedWithinCadence: true,
      blockedAfterRefill: false,
      probes: 2,
    });
  } finally {
    rmSync(fakeGhDir, { recursive: true, force: true });
  }
});

test("a stale positive probe cannot clear a newer primary block", async () => {
  const fakeGhDir = mkdtempSync(join(tmpdir(), "pr-cockpit-stale-quota-probe-"));
  const fakeGh = join(fakeGhDir, "gh");
  writeFileSync(fakeGh, "#!/bin/sh\nprintf 'fixture-token\\n'\n");
  chmodSync(fakeGh, 0o755);
  try {
    const script = `
      const github = await import(${JSON.stringify(githubModuleUrl)});
      const { promise: pendingResponse, resolve: resolvePending } = Promise.withResolvers();
      const { promise: pendingStarted, resolve: markPendingStarted } = Promise.withResolvers();
      const { promise: probeResponse, resolve: resolveProbe } = Promise.withResolvers();
      const { promise: probeStarted, resolve: markProbeStarted } = Promise.withResolvers();
      let targetCalls = 0;
      let probes = 0;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rate_limit") {
          probes++;
          markProbeStarted();
          return probeResponse;
        }
        targetCalls++;
        if (targetCalls === 1) {
          markPendingStarted();
          return pendingResponse;
        }
        if (targetCalls === 2) {
          return Response.json({ message: "first primary block" }, { status: 403, headers: {
            "x-ratelimit-resource": "core",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String((Date.now() + 60_000) / 1000),
          } });
        }
        return Response.json({ workflows: [] });
      };
      const capture = async (fn) => { try { await fn(); return null; } catch (error) { return error; } };

      const pending = capture(() => github.fetchActionWorkflows("acme/app"));
      await pendingStarted;
      await capture(() => github.fetchActionWorkflows("acme/app"));
      const probing = capture(() => github.fetchActionWorkflows("acme/app"));
      await probeStarted;
      resolvePending(Response.json({ message: "newer primary block" }, { status: 403, headers: {
        "x-ratelimit-resource": "core",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String((Date.now() + 120_000) / 1000),
      } }));
      await pending;
      resolveProbe(Response.json({ resources: { core: { remaining: 5000 } } }));
      const staleProbeRequest = await probing;
      const afterStaleProbe = await capture(() => github.fetchActionWorkflows("acme/app"));
      console.log(JSON.stringify({
        staleProbeBlocked: staleProbeRequest?.kind === "quota",
        stillBlocked: afterStaleProbe?.kind === "quota",
        targetCalls,
        probes,
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
      staleProbeBlocked: true,
      stillBlocked: true,
      targetCalls: 2,
      probes: 1,
    });
  } finally {
    rmSync(fakeGhDir, { recursive: true, force: true });
  }
});

test("PR detail spends no GraphQL while its REST half is quota-blocked", async () => {
  const fakeGhDir = mkdtempSync(join(tmpdir(), "pr-cockpit-detail-core-block-"));
  const fakeGh = join(fakeGhDir, "gh");
  writeFileSync(fakeGh, "#!/bin/sh\nprintf 'fixture-token\\n'\n");
  chmodSync(fakeGh, 0o755);
  try {
    const script = `
      const github = await import(${JSON.stringify(githubModuleUrl)});
      let graphqlCalls = 0;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rate_limit") return Response.json({ resources: { core: { remaining: 0 } } });
        if (url.pathname === "/graphql") graphqlCalls++;
        return Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: {
          "x-ratelimit-resource": "core",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String((Date.now() + 60_000) / 1000),
        } });
      };
      const capture = async (fn) => { try { await fn(); return null; } catch (error) { return error; } };
      await capture(() => github.fetchActionWorkflows("acme/app"));
      const errors = [];
      for (let attempt = 0; attempt < 3; attempt++) errors.push(await capture(() => github.fetchPrDetail("acme/app", 7, "agent read")));
      console.log(JSON.stringify({ blocked: errors.map((error) => error?.kind === "quota" && error.resource === "core"), graphqlCalls }));
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
    expect(JSON.parse(stdout)).toEqual({ blocked: [true, true, true], graphqlCalls: 0 });
  } finally {
    rmSync(fakeGhDir, { recursive: true, force: true });
  }
});

test("a stale quota probe cannot change the next account's block", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-quota-probe-auth-switch-"));
  try {
    const script = `
      const { mock } = await import("bun:test");
      let token = "old-token";
      mock.module(${JSON.stringify(githubAuthModuleUrl)}, () => ({
        githubAuthStatus: async () => ({ ok: true, state: "ready", login: "fixture", error: null, requiredScopes: [], missingScopes: [] }),
        startGithubSetup: async () => ({ ok: true, state: "ready", login: "fixture", error: null, requiredScopes: [], missingScopes: [] }),
        liveGithubToken: async () => token,
      }));
      const github = await import(${JSON.stringify(githubModuleUrl)});
      const { promise: oldProbeResponse, resolve: resolveOldProbe } = Promise.withResolvers();
      const { promise: oldProbeStarted, resolve: markOldProbeStarted } = Promise.withResolvers();
      let oldLimited = false;
      let newLimited = false;
      const probes = [];
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        const authorization = new Headers(init?.headers).get("authorization");
        if (url.pathname === "/rate_limit") {
          probes.push(authorization);
          if (authorization === "bearer old-token") {
            markOldProbeStarted();
            return oldProbeResponse;
          }
          return Response.json({ resources: { core: { remaining: 0 } } });
        }
        if (authorization === "bearer old-token" && !oldLimited) {
          oldLimited = true;
          return Response.json({ message: "old exhausted" }, { status: 403, headers: {
            "x-ratelimit-resource": "core",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String((Date.now() + 3_600_000) / 1000),
          } });
        }
        if (authorization === "bearer new-token" && !newLimited) {
          newLimited = true;
          return Response.json({ message: "new exhausted" }, { status: 403, headers: {
            "x-ratelimit-resource": "core",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String((Date.now() + 3_600_000) / 1000),
          } });
        }
        return Response.json({ workflows: [] }, { headers: {
          "x-ratelimit-resource": "core",
          "x-ratelimit-remaining": "5000",
        } });
      };
      const capture = async (fn) => { try { await fn(); return null; } catch (error) { return error; } };

      await capture(() => github.fetchActionWorkflows("acme/app"));
      const oldBlocked = capture(() => github.fetchActionWorkflows("acme/app"));
      await oldProbeStarted;
      token = "new-token";
      const newLimitedError = await capture(() => github.fetchActionWorkflows("acme/app"));
      resolveOldProbe(Response.json({ resources: { core: { remaining: 5000 } } }));
      const staleOldRequest = await oldBlocked;
      const newBlocked = await capture(() => github.fetchActionWorkflows("acme/app"));
      console.log(JSON.stringify({
        newLimited: newLimitedError?.kind === "quota",
        staleOldBlocked: staleOldRequest?.kind === "quota",
        newStillBlocked: newBlocked?.kind === "quota",
        probes,
      }));
    `;
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "", COCKPIT_MOCK_DATA: "" },
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
      newLimited: true,
      staleOldBlocked: true,
      newStillBlocked: true,
      probes: ["bearer old-token", "bearer new-token"],
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a retry-after from a quota probe prevents further probes and API requests", async () => {
  const fakeGhDir = mkdtempSync(join(tmpdir(), "pr-cockpit-probe-secondary-limit-"));
  const fakeGh = join(fakeGhDir, "gh");
  writeFileSync(fakeGh, "#!/bin/sh\nprintf 'fixture-token\\n'\n");
  chmodSync(fakeGh, 0o755);
  try {
    const script = `
      let now = 2_000_000_000_000;
      Date.now = () => now;
      const github = await import(${JSON.stringify(githubModuleUrl)});
      let limited = true;
      let probes = 0;
      let targetCalls = 0;
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rate_limit") {
          probes++;
          return Response.json({ message: "slow down" }, { status: 429, headers: { "retry-after": "60" } });
        }
        targetCalls++;
        if (limited) {
          limited = false;
          return Response.json({ message: "primary exhausted" }, { status: 403, headers: {
            "x-ratelimit-resource": "core",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String((now + 10_000) / 1000),
          } });
        }
        return Response.json({ workflows: [] }, { headers: { "x-ratelimit-resource": "core", "x-ratelimit-remaining": "5000" } });
      };
      const capture = async (fn) => { try { await fn(); return null; } catch (error) { return error; } };

      await capture(() => github.fetchActionWorkflows("acme/app"));
      const probeLimited = await capture(() => github.fetchActionWorkflows("acme/app"));
      now += 31_000;
      const afterPrimaryReset = await capture(() => github.fetchActionWorkflows("acme/app"));
      now += 30_000;
      const afterRetryAfter = await capture(() => github.fetchActionWorkflows("acme/app"));
      console.log(JSON.stringify({
        probeLimited: probeLimited?.kind === "quota",
        blockedAfterPrimaryReset: afterPrimaryReset?.kind === "quota",
        blockedAfterRetryAfter: afterRetryAfter?.kind === "quota",
        probes,
        targetCalls,
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
      probeLimited: true,
      blockedAfterPrimaryReset: true,
      blockedAfterRetryAfter: false,
      probes: 1,
      targetCalls: 2,
    });
  } finally {
    rmSync(fakeGhDir, { recursive: true, force: true });
  }
});

test("GitHub requests carry a deadline so a silently dead socket cannot stall polling", async () => {
  const fakeGhDir = mkdtempSync(join(tmpdir(), "pr-cockpit-request-deadline-"));
  const fakeGh = join(fakeGhDir, "gh");
  writeFileSync(fakeGh, "#!/bin/sh\nprintf 'fixture-token\\n'\n");
  chmodSync(fakeGh, 0o755);
  try {
    const script = `
      const { searchClosedPrs } = await import(${JSON.stringify(githubModuleUrl)});
      const signals = [];
      globalThis.fetch = async (_input, init) => {
        signals.push(init?.signal instanceof AbortSignal);
        return Response.json({ items: [] });
      };
      await searchClosedPrs(["acme/first"]);
      console.log(JSON.stringify(signals));
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
    const signals = JSON.parse(stdout);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every(Boolean)).toBe(true);
  } finally {
    rmSync(fakeGhDir, { recursive: true, force: true });
  }
});
