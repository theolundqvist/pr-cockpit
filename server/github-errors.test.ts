import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const githubModuleUrl = new URL("./github.ts", import.meta.url).href;
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
    expect(result.failures).toEqual([{ repo: "acme/hidden", status: 422, kind: "http", resource: "search", resetAt: null }]);
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

test("a secondary rate limit blocks for retry-after, not for the primary window's reset", async () => {
  // GitHub answers a burst (a secondary limit) with 403 + `retry-after`, and the SAME response still
  // carries `x-ratelimit-reset` for the primary hourly window — which is untouched and may be most of
  // an hour away. Combining them turned a one-minute cooldown into a one-hour block: every mutation
  // refused while `gh api rate_limit` reported the full 5000 remaining.
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
      globalThis.fetch = async (input) => {
        if (limited) {
          limited = false;
          // retry-after says 60s. x-ratelimit-reset points an hour out, for a budget that is fine.
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
      // Still inside the 60s cooldown: blocked.
      const during = await capture(() => github.fetchActionWorkflows("acme/app"));
      // Past the cooldown but far short of the hourly reset: must be allowed again.
      now += 61_000;
      const after = await capture(() => github.fetchActionWorkflows("acme/app"));
      console.log(JSON.stringify({
        firstKind: first?.kind ?? null,
        blockedDuringCooldown: during?.kind === "quota",
        blockedAfterCooldown: after?.kind === "quota",
        blockedUntil: first?.resetAt ?? null,
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
    expect(result.firstKind).toBe("quota");
    expect(result.blockedDuringCooldown).toBe(true);
    // The whole point: 61 seconds later the block is gone, rather than lasting the full hour.
    expect(result.blockedAfterCooldown).toBe(false);
    expect(result.blockedUntil).toBe(new Date(2_000_000_060_000).toISOString());
  } finally {
    rmSync(fakeGhDir, { recursive: true, force: true });
  }
});
