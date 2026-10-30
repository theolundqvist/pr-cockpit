import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrDetail } from "./github.ts";

type Call = { path: string; token: string; query: string | null; variables: { ids?: string[]; after?: string; threadId?: string } };
type Failure = { kind: string; resource: string | null; status: number; message: string };
const moduleUrl = (name: string) => new URL(`./${name}.ts`, import.meta.url).href;

// Configure synthetic credentials and loopback transport before loading GitHub modules.
async function scenario<T>(code: string): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "cockpit-detail-parity-"));
  const privateKeyPath = join(directory, "private.pem");
  const configPath = join(directory, "app.json");
  const gh = join(directory, "gh");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({ appId: "123", privateKeyPath }), { mode: 0o600 });
  writeFileSync(gh, "#!/bin/sh\nprintf 'personal-token\\n'\n");
  chmodSync(gh, 0o755);
  const script = `
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const state = { app: true, coreBlocked: false, appGraphqlBlocked: false, userGraphqlBlocked: false,
      appGraphqlRemaining: 4000, userGraphqlRemaining: 4000,
      missingReaction: false, missingPermission: false, secondary: false, refresh: false, invalidCursor: false };
    const reset = Math.ceil(Date.now() / 1000) + 1800;
    const headers = (resource, remaining = 4000) => ({
      "x-ratelimit-resource": resource, "x-ratelimit-remaining": String(remaining),
      "x-ratelimit-limit": "5000", "x-ratelimit-used": String(5000 - remaining), "x-ratelimit-reset": String(reset),
    });
    const ok = (body, resource = "core") => Response.json(body, { headers: headers(resource) });
    const exhausted = (resource) => Response.json({ message: "API rate limit exceeded" }, { status: 403, headers: headers(resource, 0) });
    const page = { hasNextPage: false, endCursor: null };
    const author = { __typename: "User", login: "author", avatarUrl: "https://avatars.example/author" };
    const viewer = { ...author, login: "viewer" };
    const head = "a".repeat(40);
    const restAuthor = { login: "author", node_id: "U_author", avatar_url: author.avatarUrl, type: "User" };
    const restPull = {
      node_id: "PR_7", title: "Detail parity", number: 7, state: "open", merged_at: null, closed_at: null, draft: false,
      user: restAuthor, base: { ref: "main", sha: "b".repeat(40) }, head: { ref: "topic", sha: head, repo: { full_name: "acme/repo" } },
      body: "PR body", additions: 5, deletions: 2, changed_files: 1, mergeable: true, mergeable_state: "clean", auto_merge: null,
      created_at: "2026-09-01T09:00:00Z", updated_at: "2026-09-01T10:00:00Z", html_url: "https://github.com/acme/repo/pull/7",
      commits: 1, labels: [], assignees: [], requested_reviewers: [{ ...restAuthor, login: "viewer" }], requested_teams: [],
    };
    const base = {
      id: "PR_7", title: restPull.title, number: 7, state: "OPEN", mergedAt: null, mergeCommit: null, mergedBy: null,
      closedAt: null, isDraft: false, author, baseRefName: "main", baseRefOid: restPull.base.sha,
      headRefName: "topic", headRefOid: head, headRepository: { nameWithOwner: "acme/repo" }, body: restPull.body,
      additions: 5, deletions: 2, changedFiles: 1, files: { totalCount: 1, nodes: [{ path: "a.ts", additions: 5, deletions: 2 }] },
      mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", autoMergeRequest: null,
      createdAt: restPull.created_at, updatedAt: restPull.updated_at, url: restPull.html_url,
      commitCount: { totalCount: 1 }, labels: { nodes: [] }, assignees: { nodes: [] },
      reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "viewer", avatarUrl: author.avatarUrl } }] },
    };
    const groups = (personal, id) => [
      { content: "THUMBS_UP", reactors: { totalCount: 3 }, ...(personal ? { viewerHasReacted: id !== "C_1" } : {}) },
      { content: "HEART", reactors: { totalCount: 2 }, ...(personal ? { viewerHasReacted: false } : {}) },
    ];
    const comment = (id, personal) => ({ id, databaseId: Number(id.replace(/\\D/g, "")) || 500,
      author, body: state.refresh ? "updated " + id : id, createdAt: restPull.created_at,
      reactionGroups: groups(personal, id) });
    const threadComment = (id, personal) => ({ ...comment(id, personal),
      diffHunk: "@@ -1 +1 @@\\n context\\n-old\\n+new", pullRequestReview: { state: "COMMENTED" } });
    const thread = (index, personal) => ({ id: "T_" + index,
      isResolved: index === 1 || (state.refresh && index === 2), isOutdated: index === 1,
      path: "a.ts", line: index + 1, diffSide: "RIGHT",
      comments: { pageInfo: index === 0 ? { hasNextPage: true, endCursor: "comments-50" } : page,
        nodes: [threadComment("C_" + index, personal)] } });
    const reviewData = (personal) => ({ ...(personal ? { viewerCanMergeAsAdmin: false } : { id: "PR_7" }),
      author, reactionGroups: groups(personal, "PR_7"), reviewDecision: "APPROVED",
      reviews: { pageInfo: page, nodes: [
        { ...comment("R_1", personal), author: viewer, state: "APPROVED", submittedAt: restPull.created_at },
        { ...comment("R_pending", personal), author: viewer, state: "PENDING", submittedAt: null },
      ] },
      comments: { pageInfo: page, nodes: [comment("IC_1", personal)] },
      reviewThreads: { pageInfo: { hasNextPage: true, endCursor: state.invalidCursor ? null : "threads-100" },
        nodes: Array.from({ length: 100 }, (_, index) => thread(index, personal)) },
    });
    const commit = { oid: head, abbreviatedOid: "aaaaaaa", messageHeadline: "Commit", committedDate: restPull.created_at,
      author: null, parents: { nodes: [] } };
    const previous = { commitList: { nodes: [{ commit: { ...commit, additions: 5, deletions: 2 } }] }, reviewThreads: { nodes: [] } };
    const calls = [];
    let labelEvents = [];
    const respond = async (input, init) => {
      const url = new URL(String(input));
      assert(url.origin === "https://api.github.com", "Unexpected network origin");
      const token = new Headers(init?.headers).get("authorization")?.replace(/^bearer /i, "");
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      const query = body?.query ?? null;
      const variables = body?.variables ?? {};
      if (url.pathname.endsWith("/installation")) return state.app ? Response.json({ id: 41 }) : new Response(null, { status: 404 });
      if (url.pathname === "/app/installations/41/access_tokens") return Response.json({
        token: "app-token", expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: { contents: "read", pull_requests: "read", issues: "read", checks: "read", actions: "read" },
      });
      calls.push({ path: url.pathname, token, query, variables });
      if (url.pathname === "/graphql") {
        if ((token === "app-token" && state.appGraphqlBlocked) || (token === "personal-token" && state.userGraphqlBlocked)) return exhausted("graphql");
        if (state.secondary) return Response.json({ message: "secondary rate limit" }, { status: 403,
          headers: { ...headers("graphql"), "retry-after": "120" } });
        if (token === "app-token") assert(!/viewerHasReacted|viewerCanMergeAsAdmin|\\bviewer\\s*\\{/.test(query), "App received viewer fields");
        if (query.includes("timelineItems")) return ok({ data: { repository: { pullRequest: { timelineItems: {
          nodes: labelEvents.map(({ created_at, ...event }) => ({ ...event, createdAt: created_at })),
        } } } } }, "graphql");
        if (query.includes("nodes(ids: $ids)")) {
          assert(token === "personal-token", "Viewer overlay used App identity");
          return ok({ data: { viewer: { login: "viewer" }, nodes: variables.ids.map((id) => ({ id,
            ...(id === "PR_7" && !state.missingPermission ? { viewerCanMergeAsAdmin: false } : {}),
            reactionGroups: state.missingReaction ? [] : groups(true, id).map(({ content, viewerHasReacted }) => ({ content, viewerHasReacted })),
          })).reverse() } }, "graphql");
        }
        if (query.includes("mergeStateStatus")) return ok({ data: { repository: { pullRequest: base },
          ...(query.includes("viewer { login }") ? { viewer: { login: "viewer" } } : {}) } }, "graphql");
        if (query.includes("commitList:")) return ok({ data: { repository: { pullRequest: {
          lastCommit: { nodes: [{ commit: { statusCheckRollup: null } }] }, commitList: { nodes: [{ commit }] },
        } } } }, "graphql");
        if (query.includes("commits(last: 100)")) return ok({ data: { repository: { pullRequest: {
          commits: { nodes: [{ commit: { oid: head, additions: 5, deletions: 2 } }] },
        } } } }, "graphql");
        if (query.includes("reviewDecision")) return ok({ data: { repository: { pullRequest: reviewData(query.includes("viewerHasReacted")) } } }, "graphql");
        if (query.includes("reviewThreads(first: 100, after:")) {
          const personal = query.includes("viewerHasReacted");
          const cursorOnly = !query.includes("isResolved");
          const connection = cursorOnly && variables.after === null
            ? { pageInfo: { hasNextPage: true, endCursor: "threads-100" } }
            : { pageInfo: page, ...(cursorOnly ? {} : { nodes: [thread(100, personal)] }) };
          return ok({ data: { repository: { pullRequest: { reviewThreads: connection } } } }, "graphql");
        }
        if (query.includes("node(id: $threadId)")) return ok({ data: { node: { comments: {
          pageInfo: page, nodes: [threadComment("C_reply", query.includes("viewerHasReacted"))],
        } } } }, "graphql");
        throw new Error("Unexpected GraphQL document: " + query);
      }
      if (state.coreBlocked) return exhausted("core");
      if (url.pathname.endsWith("/issues/7/events")) return ok(labelEvents);
      if (url.pathname === "/user") return ok({ login: "viewer", id: 1 });
      if (url.pathname === "/repos/acme/repo") return ok({ permissions: { admin: true } });
      if (url.pathname.endsWith("/pulls/7")) return ok(restPull);
      if (url.pathname.endsWith("/pulls/7/files")) return ok([{ filename: "a.ts", additions: 5, deletions: 2 }]);
      if (url.pathname.endsWith("/issues/7")) return ok({ reactions: { "+1": 3 } });
      if (url.pathname.endsWith("/issues/7/comments")) return ok([{
        node_id: "REST_comment", id: 999, user: restAuthor, body: "degraded REST", created_at: restPull.created_at,
      }]);
      if (url.pathname.endsWith("/check-runs")) return ok({ check_runs: [] });
      if (url.pathname.endsWith("/status")) return ok({ statuses: [] });
      if (url.pathname.endsWith("/actions/runs")) return ok({ workflow_runs: [] });
      if (url.pathname.endsWith("/actions/workflows")) return ok({ workflows: [] });
      if (url.pathname.includes("/rules/branches/")) return ok([]);
      if (url.pathname.endsWith("/branches/main")) return ok({});
      if (url.pathname.endsWith("/pulls/7/commits") || url.pathname.endsWith("/pulls/7/reviews")
        || url.pathname.endsWith("/pulls/7/comments") || url.pathname.includes("/rules/")) return ok([]);
      throw new Error("Unexpected REST path: " + url.pathname);
    };
    const nativeFetch = globalThis.fetch;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
      const url = new URL(request.url);
      const response = await respond("https://api.github.com" + url.pathname + url.search, {
        method: request.method, headers: request.headers,
        body: request.method === "POST" ? await request.text() : undefined,
      });
      if (url.pathname === "/graphql" && response.ok) {
        const app = request.headers.get("authorization") === "bearer app-token";
        const remaining = app ? state.appGraphqlRemaining : state.userGraphqlRemaining;
        response.headers.set("x-ratelimit-remaining", String(remaining));
        response.headers.set("x-ratelimit-used", String(5000 - remaining));
      }
      return response;
    } });
    globalThis.fetch = (input, options) => {
      const url = new URL(String(input));
      assert(url.origin === "https://api.github.com", "Unexpected network origin");
      return nativeFetch("http://127.0.0.1:" + server.port + url.pathname + url.search, options);
    };
    const settings = await import(${JSON.stringify(moduleUrl("settings"))});
    settings.writeSettings({ rest_fallback_enabled: false });
    const github = await import(${JSON.stringify(moduleUrl("github"))});
    const capture = async (work) => { try { return { value: await work() }; }
      catch (error) { return { error: { kind: error.kind, resource: error.resource, status: error.status, message: error.message } }; } };
    const fetchDetail = () => github.fetchPrDetail("acme/repo", 7, "app detail", previous);
    try { ${code} } finally { server.stop(true); (await import(${JSON.stringify(moduleUrl("db"))})).db.close(); }
  `;
  try {
    const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: directory, COCKPIT_GITHUB_APP_CONFIG: configPath, COCKPIT_GH_BIN: gh,
        COCKPIT_MOCK: "", COCKPIT_MOCK_DATA: "", COCKPIT_REPLICA_SSH_HOST: "", COCKPIT_PROXY: "" },
      stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    return JSON.parse(stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function expectReviewParity(detail: PrDetail): void {
  expect(detail.viewerLogin).toBe("viewer");
  expect(detail.viewerCanMergeAsAdmin).toBe(false);
  expect(detail.viewerReviewRequested).toBe(true);
  expect(detail.viewerReviewState).toBe("APPROVED");
  expect(detail.reviews.nodes.map((review) => review.id)).toEqual(["R_1"]);
  for (const reactions of [detail.reactions, detail.reviews.nodes[0]!.reactions, detail.comments.nodes[0]!.reactions]) {
    expect(reactions).toEqual([
      { content: "THUMBS_UP", count: 3, viewerReacted: true },
      { content: "HEART", count: 2, viewerReacted: false },
    ]);
  }
  expect(detail.reviewThreads.nodes).toHaveLength(101);
  expect(detail.reviewThreads.pageInfo?.hasNextPage).toBe(false);
  expect(detail.reviewThreads.nodes[0]!.comments.nodes.map((comment) => comment.id)).toEqual(["C_0", "C_reply"]);
  expect(detail.reviewThreads.nodes[0]!.comments.nodes[1]!.reactions[0]!.viewerReacted).toBe(true);
  expect(detail.reviewThreads.nodes[1]).toMatchObject({ id: "T_1", isResolved: true, isOutdated: true });
  expect(detail.reviewThreads.nodes[1]!.comments.nodes[0]!.reactions[0]!.viewerReacted).toBe(false);
  expect(detail.reviewThreads.nodes[100]).toMatchObject({ id: "T_100", isResolved: false });
}

test("App detail preserves GraphQL thread identity, resolution, reactions, and personal bypass ability", async () => {
  const result = await scenario<{ detail: PrDetail; calls: Call[] }>(`
    const detail = await fetchDetail();
    console.log(JSON.stringify({ detail, calls }));
  `);
  expectReviewParity(result.detail);
  expect(result.calls.every((call) => call.path === "/graphql")).toBe(true);
  const repository = result.calls.filter((call) => call.token === "app-token");
  expect(repository.some((call) => call.query?.includes("mergeStateStatus"))).toBe(true);
  expect(repository.some((call) => call.variables.threadId === "T_0")).toBe(true);
  expect(repository.every((call) => !/viewerHasReacted|viewerCanMergeAsAdmin|\bviewer\s*\{/.test(call.query!))).toBe(true);
  const personal = result.calls.filter((call) => call.token === "personal-token");
  expect(personal).toHaveLength(2);
  expect(personal.map((call) => call.variables.ids?.length)).toEqual([100, 6]);
  expect(personal.every((call) => call.query?.includes("nodes(ids: $ids)") && !call.query.includes("reactors") && !call.query.includes("body"))).toBe(true);
});

test("scoped review refresh retains full parity and pagination without fetching metadata or checks", async () => {
  const result = await scenario<{ detail: PrDetail; calls: Call[]; unchangedChecks: boolean; unchangedFiles: boolean }>(`
    const initial = await fetchDetail();
    state.refresh = true;
    calls.length = 0;
    const detail = await github.fetchPrDetailPart("acme/repo", 7, initial, "review", "webhook");
    console.log(JSON.stringify({ detail, calls, unchangedChecks: detail.lastCommit === initial.lastCommit,
      unchangedFiles: detail.files === initial.files }));
  `);
  expectReviewParity(result.detail);
  expect(result.detail.reviewThreads.nodes[2]).toMatchObject({ id: "T_2", isResolved: true });
  expect(result.detail.comments.nodes[0]!.body).toBe("updated IC_1");
  expect(result.unchangedChecks).toBe(true);
  expect(result.unchangedFiles).toBe(true);
  expect(result.calls.every((call) => call.path === "/graphql" && !/mergeStateStatus|commitList:/.test(call.query!))).toBe(true);
  expect(result.calls.some((call) => call.variables.after === "threads-100" && call.query?.includes("isResolved"))).toBe(true);
});

test("no-App detail keeps its personal review document and REST metadata with identical output", async () => {
  const result = await scenario<{ detail: PrDetail; calls: Call[] }>(`
    state.app = false;
    const detail = await fetchDetail();
    console.log(JSON.stringify({ detail, calls }));
  `);
  expectReviewParity(result.detail);
  expect(result.calls.every((call) => call.token === "personal-token")).toBe(true);
  expect(result.calls.some((call) => call.path.endsWith("/pulls/7"))).toBe(true);
  expect(result.calls.some((call) => call.path === "/user")).toBe(true);
  expect(result.calls.some((call) => call.query?.includes("reviewDecision") && call.query.includes("viewerCanMergeAsAdmin"))).toBe(true);
  expect(result.calls.some((call) => call.query?.includes("nodes(ids:"))).toBe(false);
});

test("both exhausted core pools still allow full and scoped detail over GraphQL", async () => {
  const result = await scenario<{ detail: PrDetail; refreshed: PrDetail; calls: Call[]; seed: { error: Failure } }>(`
    state.coreBlocked = true;
    const seed = await capture(() => github.fetchActionWorkflows("acme/repo"));
    calls.length = 0;
    const detail = await fetchDetail();
    const refreshed = await github.fetchPrDetailPart("acme/repo", 7, detail, "review", "webhook");
    console.log(JSON.stringify({ detail, refreshed, calls, seed }));
  `);
  expect(result.seed.error).toMatchObject({ kind: "quota", resource: "core" });
  expectReviewParity(result.detail);
  expectReviewParity(result.refreshed);
  expect(result.calls.every((call) => call.path === "/graphql")).toBe(true);
});

test("App GraphQL primary exhaustion uses bounded personal GraphQL fallback without degraded REST", async () => {
  const result = await scenario<{ detail: PrDetail; refreshed: PrDetail; calls: Call[]; refreshCalls: Call[] }>(`
    state.appGraphqlBlocked = true;
    const detail = await fetchDetail();
    const before = calls.length;
    const refreshed = await github.fetchPrDetailPart("acme/repo", 7, detail, "review", "webhook");
    console.log(JSON.stringify({ detail, refreshed, calls, refreshCalls: calls.slice(before) }));
  `);
  expectReviewParity(result.detail);
  expectReviewParity(result.refreshed);
  expect(result.calls.every((call) => call.path === "/graphql")).toBe(true);
  expect(result.calls.some((call) => call.token === "app-token")).toBe(true);
  expect(result.calls.some((call) => call.token === "personal-token" && call.query?.includes("reviewDecision"))).toBe(true);
  expect(result.refreshCalls.every((call) => call.token === "personal-token")).toBe(true);
  const attempted = result.calls.filter((call) => call.token === "app-token").map((call) => JSON.stringify([call.query, call.variables]));
  expect(new Set(attempted).size).toBe(attempted.length);
});

for (const app of [false, true]) {
  test(`${app ? "App" : "no-App"} detail gates exhausted personal GraphQL before parallel metadata spending when REST fallback is off`, async () => {
    const result = await scenario<{ outcome: { error: Failure }; calls: Call[] }>(`
      state.app = ${app};
      state.userGraphqlBlocked = true;
      await capture(() => github.resolveReviewThread("T_0"));
      calls.length = 0;
      const outcome = await capture(fetchDetail);
      console.log(JSON.stringify({ outcome, calls }));
    `);
    expect(result.outcome.error).toMatchObject({ kind: "quota", resource: "graphql" });
    expect(result.calls).toEqual([]);
  });
}

test("explicit REST fallback preference permits degraded full and scoped reads after personal GraphQL exhaustion", async () => {
  const result = await scenario<{ detail: PrDetail; refreshed: PrDetail; calls: Call[] }>(`
    settings.writeSettings({ rest_fallback_enabled: true });
    state.userGraphqlBlocked = true;
    await capture(() => github.resolveReviewThread("T_0"));
    calls.length = 0;
    const detail = await fetchDetail();
    const refreshed = await github.fetchPrDetailPart("acme/repo", 7, detail, "review", "webhook");
    console.log(JSON.stringify({ detail, refreshed, calls }));
  `);
  expect(result.detail.comments.nodes[0]!.body).toBe("degraded REST");
  expect(result.refreshed.comments.nodes[0]!.body).toBe("degraded REST");
  expect(result.calls.every((call) => call.path !== "/graphql")).toBe(true);
  expect(result.calls.filter((call) => call.path.endsWith("/issues/7/comments")).every((call) => call.token === "app-token")).toBe(true);
  expect(result.calls.find((call) => call.path === "/repos/acme/repo")?.token).toBe("personal-token");
});

for (const field of ["missingReaction", "missingPermission"]) {
  test(`missing personal ${field === "missingReaction" ? "reaction state" : "bypass ability"} fails explicitly instead of inventing false`, async () => {
    const result = await scenario<{ outcome: { error: Failure }; calls: Call[] }>(`
      state.${field} = true;
      settings.writeSettings({ rest_fallback_enabled: true });
      const outcome = await capture(fetchDetail);
      console.log(JSON.stringify({ outcome, calls }));
    `);
    expect(result.outcome.error.status).toBe(502);
    expect(result.calls.every((call) => call.path === "/graphql")).toBe(true);
  });
}

test("App detail rejects incomplete thread pagination rather than returning a partial snapshot", async () => {
  const result = await scenario<{ outcome: { error: Failure } }>(`
    state.invalidCursor = true;
    const outcome = await capture(fetchDetail);
    console.log(JSON.stringify({ outcome }));
  `);
  expect(result.outcome.error).toMatchObject({ status: 502 });
});

test("secondary cooldown never becomes a REST fallback or another-identity retry", async () => {
  const result = await scenario<{ first: { error: Failure }; again: { error: Failure }; calls: Call[] }>(`
    settings.writeSettings({ rest_fallback_enabled: true });
    state.secondary = true;
    const first = await capture(fetchDetail);
    calls.length = 0;
    const again = await capture(fetchDetail);
    console.log(JSON.stringify({ first, again, calls }));
  `);
  expect(result.first.error).toMatchObject({ kind: "quota", resource: "graphql" });
  expect(result.again.error).toMatchObject({ kind: "quota", resource: "graphql" });
  expect(result.calls).toEqual([]);
});

test("background viewer overlays preserve the personal reserve while foreground detail remains available", async () => {
  const result = await scenario<{ full: { error: Failure }; review: { error: Failure }; blockedCalls: Call[]; foreground: PrDetail }>(`
    state.userGraphqlRemaining = 50;
    const initial = await fetchDetail();
    calls.length = 0;
    const full = await capture(() => github.fetchPrDetail("acme/repo", 7, "webhook", previous));
    const review = await capture(() => github.fetchPrDetailPart("acme/repo", 7, initial, "review", "webhook"));
    const blockedCalls = calls.slice();
    const foreground = await fetchDetail();
    console.log(JSON.stringify({ full, review, blockedCalls, foreground }));
  `);
  expect(result.full.error).toMatchObject({ kind: "quota", resource: "graphql" });
  expect(result.review.error).toMatchObject({ kind: "quota", resource: "graphql" });
  expect(result.blockedCalls).toEqual([]);
  expectReviewParity(result.foreground);
});

test("a healthy personal GraphQL pool preserves full fidelity when the App reaches its background reserve", async () => {
  const result = await scenario<{ detail: PrDetail; calls: Call[] }>(`
    state.appGraphqlRemaining = 50;
    await fetchDetail();
    settings.writeSettings({ rest_fallback_enabled: true });
    calls.length = 0;
    const detail = await github.fetchPrDetail("acme/repo", 7, "webhook", previous);
    console.log(JSON.stringify({ detail, calls }));
  `);
  expectReviewParity(result.detail);
  expect(result.calls.every(call => call.path === "/graphql" && call.token === "personal-token")).toBe(true);
});

for (const mode of ["app", "personal", "graphql-fallback"]) {
  test(`order clock uses the latest addition while order remains present (${mode})`, async () => {
    const result = await scenario<{ timestamps: Array<string | null>; disabledReads: number }>(`
      state.app = ${mode !== "personal"};
      state.coreBlocked = ${mode === "graphql-fallback"};
      base.labels.nodes = restPull.labels = [{ name: "order" }, { name: "kitchen: chef" }];
      labelEvents = [
        { event: "labeled", label: { name: "order" }, created_at: "2026-09-01T09:00:00Z" },
        { event: "labeled", label: { name: "kitchen: chef" }, created_at: "2026-09-01T09:30:00Z" },
      ];
      settings.writeSettings({ cooking_section_enabled: false });
      await fetchDetail();
      const disabledReads = calls.filter((call) => call.path.endsWith("/events") || call.query?.includes("timelineItems")).length;
      settings.writeSettings({ cooking_section_enabled: true });
      const first = await fetchDetail();
      base.labels.nodes = restPull.labels = [{ name: "order" }, { name: "kitchen: oven" }];
      base.updatedAt = restPull.updated_at = "2026-09-01T10:00:00Z";
      const nextStage = await fetchDetail();
      labelEvents.push({ event: "unlabeled", label: { name: "order" }, created_at: "2026-09-01T10:04:00Z" });
      labelEvents.push({ event: "labeled", label: { name: "order" }, created_at: "2026-09-01T10:05:00Z" });
      const reordered = await fetchDetail();
      base.labels.nodes = restPull.labels = [{ name: "kitchen: oven" }];
      const removed = await fetchDetail();
      base.labels.nodes = restPull.labels = [{ name: "order" }];
      const bareOrder = await fetchDetail();
      labelEvents = [];
      const unknown = await fetchDetail();
      console.log(JSON.stringify({ disabledReads, timestamps: [first, nextStage, reordered, removed, bareOrder, unknown].map((detail) => detail.kitchenEnteredAt) }));
    `);
    expect(result.disabledReads).toBe(0);
    expect(result.timestamps).toEqual(["2026-09-01T09:00:00Z", "2026-09-01T09:00:00Z", "2026-09-01T10:05:00Z", null, "2026-09-01T10:05:00Z", null]);
  });
}
