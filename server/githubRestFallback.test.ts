import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrDetail } from "./github.ts";
import {
  restCheckContexts,
  restCommitList,
  restReviewDecision,
  restReviewThreads,
  restRollupState,
  type RestCheckRun,
  type RestReview,
  type RestReviewComment,
} from "./githubRestFallback.ts";

const githubModuleUrl = new URL("./github.ts", import.meta.url).href;
const githubAuthModuleUrl = new URL("./githubAuth.ts", import.meta.url).href;
const settingsModuleUrl = new URL("./settings.ts", import.meta.url).href;

const actor = (login: string, type = "User") => ({ login, avatar_url: `https://avatars.example/${login}`, type });

const reviewComment = (id: number, extra: Partial<RestReviewComment> = {}): RestReviewComment => ({
  id,
  node_id: `PRRC_${id}`,
  user: actor("alice"),
  body: `comment ${id}`,
  created_at: `2026-09-01T10:00:0${id % 10}Z`,
  pull_request_review_id: 1,
  diff_hunk: "@@ -1 +1 @@\n-old\n+new",
  path: "src/app.ts",
  line: 4,
  side: "RIGHT",
  ...extra,
});

const review = (id: number, login: string, state: string): RestReview => ({
  id,
  node_id: `PRR_${id}`,
  user: actor(login),
  state,
  body: "",
  submitted_at: "2026-09-01T10:00:00Z",
});

const checkRun = (id: number, name: string, extra: Partial<RestCheckRun> = {}): RestCheckRun => ({
  id,
  name,
  status: "completed",
  conclusion: "success",
  details_url: null,
  html_url: `https://github.com/acme/app/runs/${id}`,
  started_at: "2026-09-01T10:00:00Z",
  completed_at: "2026-09-01T10:01:00Z",
  app: { id: 15368 },
  check_suite: { id: 5 },
  ...extra,
});

describe("REST review threads", () => {
  test("group replies under their first comment and keep GraphQL ids and resolution", () => {
    const previous = {
      reviewThreads: {
        nodes: [{ id: "PRRT_known", isResolved: true, comments: { nodes: [{ databaseId: 1 }] } }],
      },
    } as unknown as Pick<PrDetail, "reviewThreads">;
    const threads = restReviewThreads(
      [
        reviewComment(3, { in_reply_to_id: 1 }),
        reviewComment(1, { user: actor("greptile-apps[bot]", "Bot") }),
        reviewComment(2, { line: null, side: "LEFT", pull_request_review_id: 9 }),
      ],
      [review(1, "alice", "COMMENTED"), review(9, "viewer", "PENDING")],
      previous,
    );
    expect(threads.nodes.map((thread) => [thread.id, thread.isResolved, thread.isOutdated, thread.diffSide])).toEqual([
      ["PRRT_known", true, false, "RIGHT"],
      ["rest:PRRC_2", false, true, "LEFT"],
    ]);
    expect(threads.nodes[0]!.comments.nodes.map((comment) => comment.databaseId)).toEqual([1, 3]);
    expect(threads.nodes[0]!.comments.nodes[0]!.author).toEqual({
      __typename: "Bot",
      login: "greptile-apps",
      avatarUrl: "https://avatars.example/greptile-apps[bot]",
    });
    expect(threads.nodes[1]!.comments.nodes[0]!.pullRequestReview).toEqual({ state: "PENDING" });
  });
});

describe("REST checks", () => {
  test("mark required checks, attach workflow runs, and roll up the latest run per workflow", () => {
    const contexts = restCheckContexts(
      [checkRun(11, "build", { conclusion: "failure" }), checkRun(12, "lint", { status: "in_progress", conclusion: null })],
      [{ context: "deploy", state: "success", target_url: null, created_at: "2026-09-01T10:00:00Z" }],
      [{ id: 99, check_suite_id: 5, workflow_id: 3, name: "CI" } as never],
      new Set(["build", "deploy"]),
    );
    expect(contexts.map((check) => check.isRequired)).toEqual([true, false, true]);
    expect(contexts[0]).toMatchObject({
      __typename: "CheckRun",
      conclusion: "FAILURE",
      checkSuite: { app: { databaseId: 15368 }, workflowRun: { databaseId: 99, workflow: { databaseId: 3, name: "CI" } } },
    });
    expect(restRollupState(contexts)).toBe("FAILURE");
    expect(restRollupState(contexts.slice(1))).toBe("PENDING");
    expect(restRollupState(contexts.slice(2))).toBe("SUCCESS");
    expect(restRollupState([])).toBeNull();
  });
});

describe("REST commit list", () => {
  test("rolls up only the head and carries earlier rollups and line counts by oid", () => {
    const commit = (sha: string) => ({
      sha,
      commit: { message: `${sha} headline\n\nbody`, author: { name: "Alice", date: "2026-09-01T09:00:00Z" }, committer: { date: "2026-09-01T10:00:00Z" } },
      author: actor("alice"),
      parents: [{ sha: "parent" }],
    });
    const previous = {
      commitList: { nodes: [{ commit: { oid: "old", additions: 3, deletions: 1, statusCheckRollup: { state: "SUCCESS" } } }] },
    } as unknown as Pick<PrDetail, "commitList">;
    const list = restCommitList([commit("old"), commit("new")], "new", "PENDING", previous);
    expect(list.nodes.map(({ commit }) => [commit.oid, commit.messageHeadline, commit.statusCheckRollup, commit.additions])).toEqual([
      ["old", "old headline", { state: "SUCCESS" }, 3],
      ["new", "new headline", { state: "PENDING" }, undefined],
    ]);
    expect(list.nodes[1]!.commit.committedDate).toBe("2026-09-01T10:00:00Z");
  });
});

describe("REST review decision", () => {
  test("uses each reviewer's latest approving or blocking review", () => {
    expect(restReviewDecision([review(1, "a", "CHANGES_REQUESTED"), review(2, "a", "COMMENTED")], 0)).toBe("CHANGES_REQUESTED");
    expect(restReviewDecision([review(1, "a", "CHANGES_REQUESTED"), review(2, "a", "APPROVED")], 0)).toBe("APPROVED");
    expect(restReviewDecision([review(1, "a", "APPROVED"), review(2, "a", "DISMISSED")], 0)).toBeNull();
    expect(restReviewDecision([review(1, "a", "APPROVED")], 2)).toBe("REVIEW_REQUIRED");
    expect(restReviewDecision([], 1)).toBe("REVIEW_REQUIRED");
  });
});

// Quota blocks are module state, so the exhausted-GraphQL path runs in its own process.
test("an exhausted GraphQL pool reads PRs over REST unless the fallback is turned off", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-rest-fallback-"));
  try {
    const script = `
      const { mock } = await import("bun:test");
      mock.module(${JSON.stringify(githubAuthModuleUrl)}, () => ({
        githubAuthStatus: async () => ({ ok: true, state: "ready", login: "viewer", error: null, requiredScopes: [], missingScopes: [] }),
        startGithubSetup: async () => ({ ok: true, state: "ready", login: "viewer", error: null, requiredScopes: [], missingScopes: [] }),
        liveGithubToken: async () => "fixture-token",
      }));
      const { writeSettings } = await import(${JSON.stringify(settingsModuleUrl)});
      const github = await import(${JSON.stringify(githubModuleUrl)});
      const head = "a".repeat(40);
      const user = (login, type = "User") => ({ login, avatar_url: "https://avatars.example/" + login, type, node_id: "U_" + login });
      const pull = {
        node_id: "PR_7", title: "Fallback", number: 7, state: "open", merged_at: null, closed_at: null, draft: false,
        user: user("author"), base: { ref: "main", sha: "b".repeat(40) }, head: { ref: "topic", sha: head, repo: { full_name: "acme/app" } },
        body: "", additions: 1, deletions: 0, changed_files: 1, mergeable: true, mergeable_state: "clean", auto_merge: null,
        created_at: "2026-09-01T09:00:00Z", updated_at: "2026-09-01T10:00:00Z", html_url: "https://github.com/acme/app/pull/7",
        commits: 1, labels: [], assignees: [], requested_reviewers: [], requested_teams: [],
      };
      const routes = {
        "/user": { login: "viewer" },
        "/repos/acme/app": { permissions: { admin: true } },
        "/repos/acme/app/pulls/7": pull,
        "/repos/acme/app/pulls/7/files": [{ filename: "a.ts", additions: 1, deletions: 0 }],
        "/repos/acme/app/issues/7": { reactions: { "+1": 2 } },
        "/repos/acme/app/pulls/7/commits": [{ sha: head, commit: { message: "Fallback", author: { name: "A", date: "2026-09-01T10:00:00Z" }, committer: { date: "2026-09-01T10:00:00Z" } }, author: user("author"), parents: [] }],
        "/repos/acme/app/pulls/7/reviews": [{ id: 1, node_id: "PRR_1", user: user("alice"), state: "APPROVED", body: "", submitted_at: "2026-09-01T10:00:00Z" }],
        "/repos/acme/app/issues/7/comments": [],
        "/repos/acme/app/pulls/7/comments": [{ id: 100, node_id: "PRRC_100", user: user("greptile-apps[bot]", "Bot"), body: "nit", created_at: "2026-09-01T10:00:00Z", pull_request_review_id: 1, diff_hunk: "@@ -1 +1 @@\\n+x", path: "a.ts", line: 1, side: "RIGHT" }],
        ["/repos/acme/app/commits/" + head + "/check-runs"]: { check_runs: [{ id: 11, name: "build", status: "completed", conclusion: "failure", details_url: null, html_url: null, started_at: null, completed_at: null, app: { id: 1 }, check_suite: { id: 5 } }] },
        ["/repos/acme/app/commits/" + head + "/status"]: { statuses: [] },
        "/repos/acme/app/actions/runs": { workflow_runs: [{ id: 99, check_suite_id: 5, workflow_id: 3, name: "CI" }] },
        "/repos/acme/app/branches/main": { protection: { required_status_checks: { contexts: ["build"] } } },
        "/repos/acme/app/rules/branches/main": [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }],
        "/search/issues": { items: [{ number: 7, repository_url: "https://api.github.com/repos/acme/app" }] },
      };
      const paths = [];
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        paths.push(url.pathname);
        if (url.pathname === "/graphql") {
          return Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: {
            "x-ratelimit-resource": "graphql",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Math.ceil((Date.now() + 3_600_000) / 1000)),
          } });
        }
        if (url.pathname === "/rate_limit") return Response.json({ resources: { graphql: { remaining: 0 } } });
        const body = routes[url.pathname];
        return body === undefined
          ? Response.json({ message: "Not Found" }, { status: 404 })
          : Response.json(body, { headers: { "x-ratelimit-resource": url.pathname.startsWith("/search/") ? "search" : "core", "x-ratelimit-remaining": "4000" } });
      };
      const capture = async (fn) => { try { await fn(); return null; } catch (error) { return error; } };

      const defaultOn = writeSettings({}).rest_fallback_enabled;
      writeSettings({ rest_fallback_enabled: false });
      const disabled = await capture(() => github.fetchPrDetail("acme/app", 7));
      writeSettings({ rest_fallback_enabled: true });
      paths.length = 0;
      const previous = { commitList: { nodes: [] }, reviewThreads: { nodes: [{ id: "PRRT_known", isResolved: true, comments: { nodes: [{ databaseId: 100 }] } }] } };
      const detail = await github.fetchPrDetail("acme/app", 7, "app detail", previous);
      const hits = await github.searchOpenPrs(["acme/app"]);
      const rollup = detail.lastCommit.nodes[0].commit.statusCheckRollup;
      console.log(JSON.stringify({
        defaultOn,
        disabled: { kind: disabled?.kind, resource: disabled?.resource },
        graphqlAfterEnable: paths.filter((path) => path === "/graphql").length,
        reviewDecision: detail.reviewDecision,
        viewerCanMergeAsAdmin: detail.viewerCanMergeAsAdmin,
        reactions: detail.reactions,
        rollup: rollup.state,
        check: { name: rollup.contexts.nodes[0].name, isRequired: rollup.contexts.nodes[0].isRequired, workflow: rollup.contexts.nodes[0].checkSuite.workflowRun.workflow.name },
        thread: { id: detail.reviewThreads.nodes[0].id, isResolved: detail.reviewThreads.nodes[0].isResolved, author: detail.reviewThreads.nodes[0].comments.nodes[0].author.login },
        commit: detail.commitList.nodes[0].commit.statusCheckRollup,
        hits,
      }));
    `;
    const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "", COCKPIT_MOCK_DATA: "", COCKPIT_REPLICA_SSH_HOST: "", COCKPIT_PROXY: "" },
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
      defaultOn: true,
      disabled: { kind: "quota", resource: "graphql" },
      graphqlAfterEnable: 0,
      reviewDecision: "APPROVED",
      viewerCanMergeAsAdmin: true,
      reactions: [{ content: "THUMBS_UP", count: 2, viewerReacted: false }],
      rollup: "FAILURE",
      check: { name: "build", isRequired: true, workflow: "CI" },
      thread: { id: "PRRT_known", isResolved: true, author: "greptile-apps" },
      commit: { state: "FAILURE" },
      hits: [{ repo: "acme/app", number: 7, title: "Fallback", updatedAt: "2026-09-01T10:00:00Z", headRefOid: "a".repeat(40), ciState: "FAILURE" }],
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// /rate_limit's graphql entry disagrees with GraphQL's own accounting; pacing and blocks must follow GraphQL.
test("GraphQL's own quota reading, not /rate_limit's, moves background reads to REST and holds a RATE_LIMIT block", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-graphql-reading-"));
  try {
    const script = `
      const { mock } = await import("bun:test");
      mock.module(${JSON.stringify(githubAuthModuleUrl)}, () => ({
        githubAuthStatus: async () => ({ ok: true, state: "ready", login: "viewer", error: null, requiredScopes: [], missingScopes: [] }),
        startGithubSetup: async () => ({ ok: true, state: "ready", login: "viewer", error: null, requiredScopes: [], missingScopes: [] }),
        liveGithubToken: async () => "fixture-token",
      }));
      let now = Date.parse("2026-09-01T10:30:00Z");
      Date.now = () => now;
      const github = await import(${JSON.stringify(githubModuleUrl)});
      const reset = Math.floor(Date.parse("2026-09-01T11:00:00Z") / 1000);
      let graphqlRemaining = 4000;
      let rateLimited = false;
      const calls = { graphql: 0, search: 0, pull: 0 };
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/rate_limit") {
          return Response.json({ resources: {
            core: { limit: 5000, used: 100, remaining: 4900, reset },
            graphql: { limit: 5000, used: 18, remaining: 4982, reset: reset + 900 },
          } });
        }
        const core = { "x-ratelimit-resource": "core", "x-ratelimit-remaining": "4900", "x-ratelimit-reset": String(reset) };
        if (url.pathname === "/graphql") {
          calls.graphql++;
          const headers = {
            "x-ratelimit-resource": "graphql", "x-ratelimit-limit": "5000", "x-ratelimit-reset": String(reset),
            "x-ratelimit-remaining": String(rateLimited ? 0 : graphqlRemaining), "x-ratelimit-used": String(rateLimited ? 5000 : 5000 - graphqlRemaining),
          };
          if (rateLimited) return Response.json({ errors: [{ type: "RATE_LIMIT", message: "API rate limit already exceeded" }] }, { headers });
          return Response.json({ data: {
            __prCockpitRateLimit: { cost: 1, used: 5000 - graphqlRemaining, remaining: graphqlRemaining, resetAt: new Date(reset * 1000).toISOString() },
            search: { nodes: [] },
          } }, { headers });
        }
        if (url.pathname === "/search/issues") {
          calls.search++;
          return Response.json({ items: [] }, { headers: { ...core, "x-ratelimit-resource": "search" } });
        }
        if (url.pathname === "/repos/acme/app/pulls") return Response.json([], { headers: core });
        return Response.json({ message: "Not Found" }, { status: 404, headers: core });
      };
      const route = async () => {
        const before = { ...calls };
        await github.searchOpenPrs(["acme/app"]);
        return calls.graphql > before.graphql ? "graphql" : calls.search > before.search ? "rest" : "none";
      };
      const routes = [await route()];
      graphqlRemaining = 900;
      routes.push(await route());
      const paced = (await github.fetchGithubQuota()).graphql;
      routes.push(await route());
      graphqlRemaining = 4000;
      const fresh = github.backgroundQuotaAvailable({ limit: 5000, used: 1000, remaining: 4000, resetAt: new Date(reset * 1000).toISOString() });
      rateLimited = true;
      // An interactive read answered RATE_LIMIT is served over REST and blocks GraphQL until its reset.
      const rateLimitedRead = await github.fetchRepositoryOpenPrs("acme/app").then((prs) => "rest:" + prs.length, (error) => error.kind + ":" + error.resource);
      now += 5 * 60_000;
      const graphqlBefore = calls.graphql;
      routes.push(await route());
      const graphqlWhileBlocked = calls.graphql - graphqlBefore;
      now = (reset + 1) * 1000;
      rateLimited = false;
      routes.push(await route());
      console.log(JSON.stringify({ routes, paced: { remaining: paced.remaining, used: paced.used }, fresh, rateLimitedRead, graphqlWhileBlocked }));
    `;
    const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "", COCKPIT_MOCK_DATA: "", COCKPIT_REPLICA_SSH_HOST: "", COCKPIT_PROXY: "" },
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
      // 900 points with 30 minutes left is behind an even pace, so background search moves to REST.
      routes: ["graphql", "graphql", "rest", "rest", "graphql"],
      paced: { remaining: 900, used: 4100 },
      fresh: true,
      rateLimitedRead: "rest:0",
      graphqlWhileBlocked: 0,
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a REST inbox search skips the per-PR head and CI reads for PRs the caller already knows", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-rest-known-hits-"));
  try {
    const script = `
      const { mock } = await import("bun:test");
      mock.module(${JSON.stringify(githubAuthModuleUrl)}, () => ({
        githubAuthStatus: async () => ({ ok: true, state: "ready", login: "viewer", error: null, requiredScopes: [], missingScopes: [] }),
        startGithubSetup: async () => ({ ok: true, state: "ready", login: "viewer", error: null, requiredScopes: [], missingScopes: [] }),
        liveGithubToken: async () => "fixture-token",
      }));
      const github = await import(${JSON.stringify(githubModuleUrl)});
      const reset = String(Math.ceil((Date.now() + 3_600_000) / 1000));
      const head = "c".repeat(40);
      const paths = [];
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/graphql") {
          return Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: {
            "x-ratelimit-resource": "graphql", "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset,
          } });
        }
        paths.push(url.pathname);
        const headers = { "x-ratelimit-resource": url.pathname.startsWith("/search/") ? "search" : "core", "x-ratelimit-remaining": "4000" };
        const item = (number) => ({ number, title: "PR " + number, updated_at: "2026-09-01T10:00:00Z", repository_url: "https://api.github.com/repos/acme/app" });
        if (url.pathname === "/search/issues") return Response.json({ items: [item(7), item(8)] }, { headers });
        if (url.pathname === "/repos/acme/app/pulls/8") return Response.json({ number: 8, title: "PR 8", updated_at: "2026-09-01T10:00:00Z", head: { sha: head } }, { headers });
        if (url.pathname.endsWith("/check-runs")) return Response.json({ check_runs: [] }, { headers });
        if (url.pathname.endsWith("/status")) return Response.json({ statuses: [] }, { headers });
        if (url.pathname === "/repos/acme/app/actions/runs") return Response.json({ workflow_runs: [] }, { headers });
        return Response.json({ message: "Not Found" }, { status: 404, headers });
      };
      const hits = await github.searchOpenPrs(["acme/app"], (repo, number) => number === 7 ? { headRefOid: "a".repeat(40), ciState: "PENDING" } : null);
      console.log(JSON.stringify({ hits: hits.map((hit) => [hit.number, hit.headRefOid.slice(0, 1), hit.ciState]), pulls: paths.filter((path) => path.includes("/pulls/")) }));
    `;
    const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "", COCKPIT_MOCK_DATA: "", COCKPIT_REPLICA_SSH_HOST: "", COCKPIT_PROXY: "" },
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
      hits: [[7, "a", "PENDING"], [8, "c", "NONE"]],
      pulls: ["/repos/acme/app/pulls/8"],
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a checks refresh over REST reads only the head's checks and keeps the rest of the detail", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-rest-checks-scope-"));
  try {
    const script = `
      const { mock } = await import("bun:test");
      mock.module(${JSON.stringify(githubAuthModuleUrl)}, () => ({
        githubAuthStatus: async () => ({ ok: true, state: "ready", login: "viewer", error: null, requiredScopes: [], missingScopes: [] }),
        startGithubSetup: async () => ({ ok: true, state: "ready", login: "viewer", error: null, requiredScopes: [], missingScopes: [] }),
        liveGithubToken: async () => "fixture-token",
      }));
      const github = await import(${JSON.stringify(githubModuleUrl)});
      const reset = String(Math.ceil((Date.now() + 3_600_000) / 1000));
      const head = "a".repeat(40);
      const paths = [];
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/graphql") {
          return Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: {
            "x-ratelimit-resource": "graphql", "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset,
          } });
        }
        paths.push(url.pathname);
        const headers = { "x-ratelimit-resource": "core", "x-ratelimit-remaining": "4000" };
        if (url.pathname.endsWith("/check-runs")) return Response.json({ check_runs: [
          { id: 11, name: "build", status: "completed", conclusion: "failure", details_url: null, html_url: null, started_at: null, completed_at: null, app: { id: 1 }, check_suite: { id: 5 } },
          { id: 12, name: "lint", status: "in_progress", conclusion: null, details_url: null, html_url: null, started_at: null, completed_at: null, app: { id: 1 }, check_suite: { id: 5 } },
        ] }, { headers });
        if (url.pathname.endsWith("/status")) return Response.json({ statuses: [] }, { headers });
        if (url.pathname === "/repos/acme/app/actions/runs") return Response.json({ workflow_runs: [] }, { headers });
        return Response.json({ message: "Not Found" }, { status: 404, headers });
      };
      const commit = (oid, state) => ({ commit: { oid, abbreviatedOid: oid.slice(0, 7), messageHeadline: "m", committedDate: "", statusCheckRollup: { state }, author: { name: "A", user: null }, parents: { nodes: [] } } });
      const current = {
        title: "Kept", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: head,
        reviewThreads: { nodes: [{ id: "PRRT_1" }] },
        lastCommit: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
          { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS", isRequired: true },
        ] } } } }] },
        commitList: { nodes: [commit("b".repeat(40), "SUCCESS"), commit(head, "SUCCESS")] },
      };
      const detail = await github.fetchPrDetailPart("acme/app", 7, current, "checks", "relay");
      const rollup = detail.lastCommit.nodes[0].commit.statusCheckRollup;
      console.log(JSON.stringify({
        paths: [...new Set(paths)].sort(),
        rollup: rollup.state,
        checks: rollup.contexts.nodes.map((check) => [check.name, check.isRequired]),
        commits: detail.commitList.nodes.map((node) => node.commit.statusCheckRollup.state),
        kept: [detail.title, detail.reviewThreads.nodes[0].id],
      }));
    `;
    const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "", COCKPIT_MOCK_DATA: "", COCKPIT_REPLICA_SSH_HOST: "", COCKPIT_PROXY: "" },
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
      paths: ["/repos/acme/app/actions/runs", `/repos/acme/app/commits/${"a".repeat(40)}/check-runs`, `/repos/acme/app/commits/${"a".repeat(40)}/status`],
      rollup: "FAILURE",
      checks: [["build", true], ["lint", false]],
      commits: ["SUCCESS", "FAILURE"],
      kept: ["Kept", "PRRT_1"],
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
