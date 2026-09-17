import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const githubModuleUrl = new URL("./github.ts", import.meta.url).href;
const dbModuleUrl = new URL("./db.ts", import.meta.url).href;
const httpModuleUrl = new URL("./http.ts", import.meta.url).href;

interface ChildProcess {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
}

function child(script: string, env: Record<string, string | undefined> = {}) {
  return Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
    env: { ...Bun.env, COCKPIT_GH_BIN: "/bin/echo", COCKPIT_MOCK: "", COCKPIT_MOCK_DATA: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function output(process: ChildProcess) {
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return JSON.parse(stdout.trim());
}

test("pending review transport paginates, scopes to the viewer, and preserves stale drafts", async () => {
  const script = `
    const calls = [];
    const pending = {
      id: 91,
      node_id: "PRR_pending_91",
      user: { login: "viewer" },
      state: "PENDING",
      body: "summary",
      commit_id: "${"a".repeat(40)}",
    };
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? "GET";
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, path: url.pathname + url.search, body });
      if (url.pathname === "/user") return Response.json({ login: "viewer" });
      if (url.pathname.endsWith("/pulls/8/reviews")) {
        return method === "GET" ? Response.json([]) : new Response(null, { status: 200 });
      }
      if (url.pathname.endsWith("/pulls/8") && method === "GET") {
        return Response.json({ state: "open", head: { sha: "${"b".repeat(40)}" } });
      }
      if (url.pathname.endsWith("/pulls/7/reviews")) {
        if (url.searchParams.get("page") === "2") return Response.json([
          pending,
          {
            id: 92, node_id: "PRR_posted_92", user: { login: "reviewer" }, state: "COMMENTED",
            body: "", commit_id: "${"a".repeat(40)}", submitted_at: "2026-01-02T00:00:00Z",
            html_url: "https://github.com/acme/app/pull/7#pullrequestreview-92",
          },
        ]);
        return Response.json([
          { ...pending, id: 80, node_id: "PRR_other", user: { login: "other" } },
        ], { headers: { link: '<https://api.github.com/repos/acme/app/pulls/7/reviews?per_page=100&page=2>; rel="next"' } });
      }
      if (url.pathname.endsWith("/pulls/7/reviews/91/comments")) {
        if (url.searchParams.get("page") === "2") return Response.json([{
          id: 902, path: "src/two.ts", line: 12, original_line: 12, side: "RIGHT", original_side: "RIGHT",
          start_line: 9, original_start_line: 9, start_side: "RIGHT", original_start_side: "RIGHT", body: "range",
        }]);
        return Response.json([{
          id: 901, path: "src/one.ts", line: 4, original_line: 4, side: "RIGHT", original_side: "RIGHT",
          start_line: null, original_start_line: null, start_side: null, original_start_side: null, body: "single",
        }], { headers: { link: '<https://api.github.com/repos/acme/app/pulls/7/reviews/91/comments?per_page=100&page=2>; rel="next"' } });
      }
      if (url.pathname.endsWith("/issues/7/comments")) return Response.json([]);
      if (url.pathname.endsWith("/pulls/7/comments")) return Response.json([
        {
          id: 701, pull_request_review_id: 91, user: { login: "viewer" }, body: "private draft",
          created_at: "2026-01-02T00:00:00Z", html_url: "https://github.com/acme/app/pull/7#discussion_r701",
          path: "src/private.ts", line: 3, original_line: 3,
        },
        {
          id: 702, pull_request_review_id: 92, user: { login: "reviewer" }, body: "published comment",
          created_at: "2026-01-02T00:00:00Z", html_url: "https://github.com/acme/app/pull/7#discussion_r702",
          path: "src/public.ts", line: 4, original_line: 4,
        },
      ]);
      if (url.pathname.endsWith("/pulls/7") && method === "GET") {
        return Response.json({ state: "open", head: { sha: globalThis.currentHead ?? "${"a".repeat(40)}" } });
      }
      if (url.pathname === "/graphql") return Response.json({ data: { addPullRequestReviewThread: { thread: { id: "thread" } } } });
      if (method === "PATCH" || method === "DELETE" || url.pathname.endsWith("/events")) return new Response(null, { status: 200 });
      throw new Error("unexpected request " + method + " " + url);
    };
    await import(${JSON.stringify(dbModuleUrl)});
    const api = await import(${JSON.stringify(githubModuleUrl)});
    const review = await api.fetchPendingReview("acme/app", 7);
    const commentsSince = await api.fetchPrCommentsSince("acme/app", 7, "2026-01-01T00:00:00Z");
    const beforeAdd = calls.length;
    await api.addPendingInlineComment("acme/app", 7, "${"a".repeat(40)}", {
      path: "src/new.ts", line: 20, side: "RIGHT", startLine: 18, startSide: "LEFT", body: "new thread",
    });
    const addCalls = calls.slice(beforeAdd);
    let foreignError = "";
    const beforeForeign = calls.length;
    try { await api.editPendingReviewComment("acme/app", 7, 91, 999, "not mine"); }
    catch (error) { foreignError = error.message; }
    const foreignMutationCalls = calls.slice(beforeForeign).filter((call) => call.method !== "GET").length;
    globalThis.currentHead = "${"b".repeat(40)}";
    let staleError = "";
    const beforeStale = calls.length;
    try { await api.submitPendingReview("acme/app", 7, 91, "COMMENT", "publish"); }
    catch (error) { staleError = error.message; }
    const staleEventCalls = calls.slice(beforeStale).filter((call) => call.path.endsWith("/events")).length;
    const beforeCreate = calls.length;
    await api.addPendingInlineComment("acme/app", 8, "${"b".repeat(40)}", {
      path: "src/first.ts", line: 5, side: "LEFT", body: "first draft",
    });
    const createCalls = calls.slice(beforeCreate);
    console.log(JSON.stringify({ review, commentsSince, addCalls, createCalls, foreignError, foreignMutationCalls, staleError, staleEventCalls }));
  `;
  const result = await output(child(script));
  expect(result.review).toEqual({
    id: 91,
    headSha: "a".repeat(40),
    body: "summary",
    comments: [
      { id: 901, path: "src/one.ts", line: 4, side: "RIGHT", body: "single" },
      { id: 902, path: "src/two.ts", line: 12, side: "RIGHT", startLine: 9, startSide: "RIGHT", body: "range" },
    ],
  });
  expect(result.commentsSince.map((comment: { body: string }) => comment.body)).toEqual(["published comment"]);
  expect(result.addCalls.find((call: { path: string }) => call.path === "/graphql")?.body.variables.input).toEqual({
    pullRequestReviewId: "PRR_pending_91",
    body: "new thread",
    path: "src/new.ts",
    line: 20,
    side: "RIGHT",
    startLine: 18,
    startSide: "LEFT",
  });
  const create = result.createCalls.find((call: { method: string; path: string }) =>
    call.method === "POST" && call.path === "/repos/acme/app/pulls/8/reviews"
  );
  expect(create.body).toEqual({
    commit_id: "b".repeat(40),
    comments: [{ body: "first draft", path: "src/first.ts", line: 5, side: "LEFT" }],
  });
  expect(create.body).not.toHaveProperty("event");
  expect(result.foreignError).toBe("Pending review comment not found");
  expect(result.foreignMutationCalls).toBe(0);
  expect(result.staleError).toContain(`pending review ${"a".repeat(40)} to current ${"b".repeat(40)}`);
  expect(result.staleEventCalls).toBe(0);
});

test("review detail keeps published comments when a pending reply shares the thread", async () => {
  const script = `
    const comment = (id, body, state) => ({
      id,
      databaseId: Number(id.replace(/\\D/g, "")),
      diffHunk: "@@ -1,2 +1,2 @@\\n-old\\n+new",
      author: { __typename: "User", login: "reviewer", avatarUrl: "https://avatars.example/reviewer" },
      body,
      createdAt: "2026-01-02T00:00:00Z",
      pullRequestReview: { state },
      reactionGroups: [],
    });
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/user") return Response.json({ login: "viewer" });
      if (url.pathname === "/graphql") return Response.json({
        data: {
          repository: {
            pullRequest: {
              author: { __typename: "User", login: "author", avatarUrl: "https://avatars.example/author" },
              reactionGroups: [],
              viewerCanMergeAsAdmin: false,
              reviewDecision: null,
              reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: "mixed-thread",
                    isResolved: false,
                    isOutdated: false,
                    path: "src/mixed.ts",
                    line: 12,
                    diffSide: "RIGHT",
                    comments: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [
                        comment("comment-101", "published root", "COMMENTED"),
                        comment("comment-102", "pending reply must stay private", "PENDING"),
                      ],
                    },
                  },
                  {
                    id: "pending-thread",
                    isResolved: false,
                    isOutdated: false,
                    path: "src/private.ts",
                    line: 4,
                    diffSide: "RIGHT",
                    comments: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [comment("comment-201", "wholly pending thread", "PENDING")],
                    },
                  },
                ],
              },
            },
          },
        },
      });
      throw new Error("unexpected request " + url);
    };
    // Load after installing the child process's mocked transport.
    const api = await import(${JSON.stringify(githubModuleUrl)});
    const detail = await api.fetchPrDetailPart(
      "acme/app",
      7,
      { reviewRequests: { nodes: [] } },
      "review",
      "relay",
    );
    console.log(JSON.stringify(detail.reviewThreads));
  `;
  const threads = await output(child(script));
  expect(threads.nodes).toHaveLength(1);
  expect(threads.nodes[0]).toMatchObject({
    id: "mixed-thread",
    isResolved: false,
    isOutdated: false,
    path: "src/mixed.ts",
    line: 12,
    diffSide: "RIGHT",
  });
  expect(threads.nodes[0].comments.nodes.map((comment: { body: string }) => comment.body)).toEqual([
    "published root",
  ]);
  expect(JSON.stringify(threads)).not.toContain("pending reply must stay private");
  expect(JSON.stringify(threads)).not.toContain("wholly pending thread");
});

test("disabled pending review API performs no GitHub work", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-pending-review-disabled-"));
  const script = `
    const { setSetting } = await import(${JSON.stringify(dbModuleUrl)});
    setSetting("pending_reviews_enabled", "false");
    let calls = 0;
    const { buildFetchHandler } = await import(${JSON.stringify(httpModuleUrl)});
    const handler = buildFetchHandler(4820, { fetchPendingReview: async () => { calls += 1; throw new Error("must not run"); } });
    const response = await handler(new Request("http://127.0.0.1:4820/api/pr/acme/app/7/pending-review"));
    console.log(JSON.stringify({ status: response.status, body: await response.json(), calls }));
  `;
  try {
    const result = await output(child(script, { COCKPIT_DATA_DIR: dataDir }));
    expect(result).toEqual({ status: 200, body: { review: null }, calls: 0 });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
