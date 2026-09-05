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
  user: { node_id: "U_node", login: "octocat", avatar_url: "https://avatars.example/octocat" },
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
  requested_reviewers: [{ node_id: "U_reviewer", login: "reviewer", avatar_url: "https://avatars.example/reviewer" }],
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
      author: { login: "octocat", avatarUrl: "https://avatars.example/octocat" },
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
      expect((await searchClosedPrs(["acme/repo"]))[0]?.involvesMe).toBe(true);
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
