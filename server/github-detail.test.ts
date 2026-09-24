import { describe, expect, test } from "bun:test";
import {
  addAssignees,
  closePullRequest,
  fetchAssignableUsers,
  fetchPrDetailPart,
  getViewerLogin,
  mapRestPrDetailBase,
  compactReviewHunks,
  requestReviewers,
  searchClosedPrs,
  searchPrs,
  searchRecentPrs,
  postIssueComment,
  updatePullRequestBody,
  updatePullRequestBranch,
  updatePullRequestTitle,
  viewerRepos,
  type PrDetail,
  reviewHunkTail,
} from "./github.ts";

const restPullRequest = {
  node_id: "PR_node",
  title: "Keep detail parity",
  number: 42,
  state: "closed" as const,
  merged_at: "2026-08-27T10:00:00Z",
  closed_at: "2026-08-27T10:00:00Z",
  draft: false,
  user: { node_id: "U_node", login: "octocat", avatar_url: "https://avatars.example/octocat", type: "User" },
  base: { ref: "main", sha: "base-sha" },
  head: { ref: "rest-detail", sha: "head-sha" },
  body: "Body",
  additions: 12,
  deletions: 4,
  changed_files: 2,
  mergeable: true,
  mergeable_state: "clean",
  auto_merge: { merge_method: "squash", enabled_by: { login: "maintainer" } },
  created_at: "2026-08-26T09:00:00Z",
  updated_at: "2026-08-27T10:00:00Z",
  html_url: "https://github.com/acme/repo/pull/42",
  commits: 3,
  labels: [{ name: "bug" }],
  assignees: [{ login: "owner" }],
  requested_reviewers: [{ node_id: "U_reviewer", login: "reviewer", avatar_url: "https://avatars.example/reviewer", type: "User" }],
  requested_teams: [{ name: "platform" }],
};

const restFiles = [
  { filename: "server/github.ts", additions: 10, deletions: 4 },
  { filename: "server/github-detail.test.ts", additions: 2, deletions: 0 },
];

describe("review hunk compaction", () => {
  test("keeps exactly the lines rendered beside a review thread", () => {
    const detail = {
      reviewThreads: {
        nodes: [{
          comments: {
            nodes: [{
              diffHunk: "@@ -1,6 +1,6 @@\n-old one\n+new one\n context two\n-old three\n+new three\n context four",
            }],
          },
        }],
      },
    };

    expect(reviewHunkTail(detail.reviewThreads.nodes[0]!.comments.nodes[0]!.diffHunk)).toBe(
      " context two\n-old three\n+new three\n context four",
    );
    expect(compactReviewHunks(detail)).toBe(detail);
    expect(detail.reviewThreads.nodes[0]!.comments.nodes[0]!.diffHunk).toBe(
      " context two\n-old three\n+new three\n context four",
    );
  });
});

describe("REST PR detail parity", () => {
  test("maps REST metadata and files to the GraphQL detail contract", () => {
    expect(mapRestPrDetailBase(restPullRequest, restFiles)).toEqual({
      id: "PR_node",
      title: "Keep detail parity",
      number: 42,
      state: "MERGED",
      mergedAt: "2026-08-27T10:00:00Z",
      closedAt: "2026-08-27T10:00:00Z",
      isDraft: false,
      author: { __typename: "User", login: "octocat", avatarUrl: "https://avatars.example/octocat" },
      baseRefName: "main",
      baseRefOid: "base-sha",
      headRefName: "rest-detail",
      headRefOid: "head-sha",
      body: "Body",
      additions: 12,
      deletions: 4,
      changedFiles: 2,
      files: {
        totalCount: 2,
        nodes: [
          { path: "server/github.ts", additions: 10, deletions: 4 },
          { path: "server/github-detail.test.ts", additions: 2, deletions: 0 },
        ],
      },
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      autoMergeRequest: { mergeMethod: "SQUASH", enabledBy: { login: "maintainer" } },
      createdAt: "2026-08-26T09:00:00Z",
      updatedAt: "2026-08-27T10:00:00Z",
      url: "https://github.com/acme/repo/pull/42",
      commitCount: { totalCount: 3 },
      labels: { nodes: [{ name: "bug" }] },
      assignees: { nodes: [{ login: "owner" }] },
      reviewRequests: {
        nodes: [
          {
            requestedReviewer: {
              __typename: "User",
              login: "reviewer",
              avatarUrl: "https://avatars.example/reviewer",
            },
          },
          { requestedReviewer: { __typename: "Team", name: "platform" } },
        ],
      },
    });
  });

  test("preserves REST bot actor type", () => {
    const mapped = mapRestPrDetailBase({
      ...restPullRequest,
      user: { ...restPullRequest.user, type: "Bot" },
    }, []);
    expect(mapped.author?.__typename).toBe("Bot");
  });

  test("preserves GraphQL null and enum semantics", () => {
    expect(mapRestPrDetailBase({
      ...restPullRequest,
      state: "open",
      merged_at: null,
      closed_at: null,
      body: null,
      mergeable: null,
      mergeable_state: "unknown",
      auto_merge: null,
      user: null,
    }, [])).toMatchObject({
      state: "OPEN",
      body: "",
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
      autoMergeRequest: null,
      author: null,
    });
  });

  test("updates checks without refetching unchanged metadata or review data", async () => {
    const base = mapRestPrDetailBase(restPullRequest, restFiles);
    const current = {
      ...base,
      lastCommit: { nodes: [] },
      commitList: { nodes: [] },
      viewerLogin: "viewer",
      viewerIsAuthor: false,
      viewerReviewRequested: false,
      viewerReviewState: null,
      viewerCanMergeAsAdmin: false,
      reviewDecision: null,
      reactions: [],
      reviews: { pageInfo: null, nodes: [{ id: "review-1" }] },
      comments: { pageInfo: null, nodes: [{ id: "comment-1" }] },
      reviewThreads: { pageInfo: null, nodes: [{ id: "thread-1" }] },
    } as unknown as PrDetail;
    const originalFetch = globalThis.fetch;
    const paths: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === "/graphql") {
        expect(JSON.parse(String(init?.body)).query).toContain("statusCheckRollup");
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                lastCommit: { nodes: [{ commit: { statusCheckRollup: null } }] },
                commitList: {
                  nodes: [{
                    commit: {
                      oid: "new-head-sha",
                      abbreviatedOid: "new-head",
                      messageHeadline: "Update checks",
                      committedDate: "2026-08-27T10:00:00Z",
                      author: null,
                      parents: { nodes: [] },
                    },
                  }],
                },
              },
            },
          },
        });
      }
      if (url.pathname === "/repos/acme/repo/pulls/42") throw new Error("metadata should stay cached");
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    try {
      const next = await fetchPrDetailPart("acme/repo", 42, current, "checks", "relay");
      expect(next.title).toBe(restPullRequest.title);
      expect(next.commitList.nodes[0]?.commit.oid).toBe("new-head-sha");
      expect(next.reviews).toBe(current.reviews);
      expect(next.comments).toBe(current.comments);
      expect(next.reviewThreads).toBe(current.reviewThreads);
      expect(paths).toEqual(["/graphql"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("carries commit line counts over and asks only about new commits", async () => {
    const known = "a".repeat(40);
    const added = "b".repeat(40);
    const commit = (oid: string, counts: { additions?: number; deletions?: number } = {}) => ({
      commit: { oid, abbreviatedOid: oid.slice(0, 7), messageHeadline: oid, committedDate: "2026-08-27T10:00:00Z", author: null, parents: { nodes: [] }, ...counts },
    });
    const current = {
      ...mapRestPrDetailBase(restPullRequest, restFiles),
      lastCommit: { nodes: [] },
      commitList: { nodes: [commit(known, { additions: 7, deletions: 2 })] },
    } as unknown as PrDetail;
    const originalFetch = globalThis.fetch;
    const queries: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      const query = JSON.parse(String(init?.body)).query as string;
      queries.push(query);
      if (query.includes("commitList")) {
        expect(query).not.toContain("additions");
        return Response.json({
          data: { repository: { pullRequest: { lastCommit: { nodes: [{ commit: { statusCheckRollup: null } }] }, commitList: { nodes: [commit(known), commit(added)] } } } },
        });
      }
      expect(query).toContain(`object(oid: "${added}")`);
      expect(query).not.toContain(known);
      return Response.json({ data: { repository: { c0: { additions: 30, deletions: 4 } } } });
    }) as typeof fetch;

    try {
      const next = await fetchPrDetailPart("acme/repo", 42, current, "checks", "relay");
      expect(next.commitList.nodes.map(({ commit }) => [commit.oid, commit.additions, commit.deletions])).toEqual([
        [known, 7, 2],
        [added, 30, 4],
      ]);
      expect(queries).toHaveLength(2);

      queries.length = 0;
      const again = await fetchPrDetailPart("acme/repo", 42, next, "checks", "relay");
      expect(again.commitList.nodes[1]?.commit.additions).toBe(30);
      expect(queries).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses REST for equivalent setup, search, and user mutations", async () => {
    const requests: Array<{ url: URL; method: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      requests.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url.pathname === "/user") {
        return Response.json({ login: "viewer" });
      }
      if (url.pathname === "/user/repos") {
        return Response.json([{ full_name: "acme/repo", pushed_at: "2026-08-27T10:00:00Z", private: true }]);
      }
      if (url.pathname === "/repos/acme/repo/assignees") {
        return Response.json([{ node_id: "U_node", login: "reviewer", avatar_url: "https://avatars.example/reviewer" }]);
      }
      if (url.pathname === "/search/issues") {
        return Response.json({
          items: [{
            number: 42,
            title: "Keep detail parity",
            state: "closed",
            draft: false,
            updated_at: "2026-08-27T10:00:00Z",
            closed_at: "2026-08-27T10:00:00Z",
            user: { login: "octocat" },
            repository_url: "https://api.github.com/repos/acme/repo",
            pull_request: { merged_at: "2026-08-27T10:00:00Z" },
          }],
        });
      }
      if (url.pathname === "/repos/acme/repo/issues/42/comments") {
        return Response.json({ node_id: "IC_comment-node" }, { status: 201 });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    try {
      expect(await getViewerLogin()).toBe("viewer");
      expect(await viewerRepos()).toEqual([{
        nameWithOwner: "acme/repo",
        pushedAt: "2026-08-27T10:00:00Z",
        isPrivate: true,
      }]);
      expect(await fetchAssignableUsers("acme/repo")).toEqual([{
        id: "U_node",
        login: "reviewer",
        avatarUrl: "https://avatars.example/reviewer",
      }]);
      expect(await searchPrs(["acme/repo"], "parity")).toEqual([{
        repo: "acme/repo",
        number: 42,
        title: "Keep detail parity",
        state: "MERGED",
      }]);
      expect((await searchRecentPrs("acme/repo"))[0]?.state).toBe("MERGED");
      expect((await searchClosedPrs(["acme/repo"])).items[0]?.involvesMe).toBe(true);
      expect(await postIssueComment("acme/repo", 42, "Accepted comment")).toBe("IC_comment-node");
      await addAssignees("acme/repo", 42, ["owner"]);
      await updatePullRequestBranch("acme/repo", 42);
      await closePullRequest("acme/repo", 42);
      await updatePullRequestBody("acme/repo", 42, "Updated body");
      await updatePullRequestTitle("acme/repo", 42, "Updated title");
      await requestReviewers("acme/repo", 42, ["reviewer"]);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requests.map(({ url, method }) => `${method} ${url.pathname}`)).toEqual([
      "GET /user",
      "GET /user/repos",
      "GET /repos/acme/repo/assignees",
      "GET /search/issues",
      "GET /search/issues",
      "GET /search/issues",
      "POST /repos/acme/repo/issues/42/comments",
      "POST /repos/acme/repo/issues/42/assignees",
      "PUT /repos/acme/repo/pulls/42/update-branch",
      "PATCH /repos/acme/repo/pulls/42",
      "PATCH /repos/acme/repo/pulls/42",
      "PATCH /repos/acme/repo/pulls/42",
      "POST /repos/acme/repo/pulls/42/requested_reviewers",
    ]);
  });
});

describe("review thread pagination", () => {
  const thread = (id: string) => ({
    id,
    isResolved: true,
    isOutdated: false,
    path: "server/github.ts",
    line: 1,
    diffSide: "RIGHT",
    comments: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ id: `${id}-c`, databaseId: 1, diffHunk: "", author: null, body: id, createdAt: "2026-08-27T10:00:00Z", pullRequestReview: null, reactionGroups: [] }],
    },
  });
  const threadIds = Array.from({ length: 250 }, (_, index) => `t${index}`);
  const pageStarts: Record<string, number> = { c100: 100, c200: 200 };
  const pageAt = (start: number) => {
    const end = Math.min(start + 100, threadIds.length);
    return {
      pageInfo: { hasNextPage: end < threadIds.length, endCursor: `c${end}` },
      nodes: threadIds.slice(start, end).map(thread),
    };
  };
  const reviewPage = (reviewThreads: unknown) => ({
    data: {
      repository: {
        pullRequest: {
          reactionGroups: [],
          viewerCanMergeAsAdmin: false,
          reviewDecision: null,
          reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          reviewThreads,
          author: null,
        },
      },
    },
  });
  const currentWithThreads = (count: number) => ({
    ...mapRestPrDetailBase(restPullRequest, restFiles),
    lastCommit: { nodes: [] },
    commitList: { nodes: [] },
    reviewThreads: { pageInfo: null, nodes: threadIds.slice(0, count).map(thread) },
  } as unknown as PrDetail);

  async function withGithub(
    respond: (query: string, after: string | null) => Promise<unknown> | unknown,
    run: () => Promise<void>,
  ): Promise<void> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      if (new URL(String(input)).pathname === "/user") return Response.json({ login: "viewer" });
      const body = JSON.parse(String(init?.body)) as { query: string; variables: { after?: string | null } };
      return Response.json(await respond(body.query, body.variables.after ?? null));
    }) as typeof fetch;
    try {
      await run();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  test("starts the later pages of a PR that already had a full page beside the first", async () => {
    const started: string[] = [];
    let laterPagesStarted!: () => void;
    const laterPages = new Promise<void>((resolve) => { laterPagesStarted = resolve; });
    await withGithub(async (query, after) => {
      if (query.includes("viewerCanMergeAsAdmin")) {
        // Serial pagination would wait here for pages it only requests after this answer.
        await Promise.race([laterPages, Bun.sleep(500)]);
        started.push("first page answered");
        return reviewPage(pageAt(0));
      }
      if (!query.includes("comments(first: 50)")) {
        const page = pageAt(after === null ? 0 : pageStarts[after]!);
        return { data: { repository: { pullRequest: { reviewThreads: { pageInfo: page.pageInfo } } } } };
      }
      started.push(`page ${after}`);
      if (after === "c200") laterPagesStarted();
      return { data: { repository: { pullRequest: { reviewThreads: pageAt(pageStarts[after!]!) } } } };
    }, async () => {
      const next = await fetchPrDetailPart("acme/repo", 42, currentWithThreads(100), "review", "relay");
      expect(next.reviewThreads.nodes.map((node) => node.id)).toEqual(threadIds);
      expect(started).toEqual(["page c100", "page c200", "first page answered"]);
    });
  });

  test("falls back to following the first page when the thread list moved during the walk", async () => {
    await withGithub((query, after) => {
      if (query.includes("viewerCanMergeAsAdmin")) return reviewPage(pageAt(0));
      if (!query.includes("comments(first: 50)")) {
        // The early walk, started before the first page, saw a list that has since changed.
        const pageInfo = after === null
          ? { hasNextPage: true, endCursor: "moved" }
          : after === "moved" ? { hasNextPage: false, endCursor: "gone" } : pageAt(pageStarts[after]!).pageInfo;
        return { data: { repository: { pullRequest: { reviewThreads: { pageInfo } } } } };
      }
      const reviewThreads = after === "moved"
        ? { pageInfo: { hasNextPage: false, endCursor: "gone" }, nodes: [thread("stale")] }
        : pageAt(pageStarts[after!]!);
      return { data: { repository: { pullRequest: { reviewThreads } } } };
    }, async () => {
      const next = await fetchPrDetailPart("acme/repo", 42, currentWithThreads(100), "review", "relay");
      expect(next.reviewThreads.nodes.map((node) => node.id)).toEqual(threadIds);
    });
  });

  test("a PR without a full page of threads makes no extra requests", async () => {
    const queries: string[] = [];
    await withGithub((query) => {
      queries.push(query);
      return reviewPage({ pageInfo: { hasNextPage: false, endCursor: "c3" }, nodes: threadIds.slice(0, 3).map(thread) });
    }, async () => {
      const next = await fetchPrDetailPart("acme/repo", 42, currentWithThreads(3), "review", "relay");
      expect(next.reviewThreads.nodes).toHaveLength(3);
      expect(queries).toHaveLength(1);
    });
  });
});
