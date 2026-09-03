import { beforeEach, describe, expect, test } from "bun:test";
import { buildFetchHandler, buildPrAgentSummary, checkoutTargetFor, formatPrAgentSummary, mergeabilityNeedsRefresh, normalizeAgentMutation, reviewThreadHandle, snapshotStatus, statsExcludingTests, trackedDetailIsStale } from "./http.ts";
import { GithubRequestError, StalePrHeadError, type PrDetail } from "./github.ts";
import { db, getCachedPrDetail, getPr, getSetting, listRunJobs, saveDiff, saveFileContents, setSetting, upsertCachedPrDetail, upsertPr, upsertPrIndex, upsertRunJob, upsertWorkflowRun } from "./db.ts";
import { testMatcher } from "../ui/src/lib/testPath.js";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pr = { additions: 999, deletions: 999 } as any;
const testRe = testMatcher("");

function trackedPrRow({
  repo,
  number,
  fetchedAt,
  mergeable = "MERGEABLE",
  mergeStateStatus = "CLEAN",
}: {
  repo: string;
  number: number;
  fetchedAt: string;
  mergeable?: string;
  mergeStateStatus?: string;
}) {
  const updatedAt = "2026-07-25T00:00:00Z";
  return {
    repo,
    number,
    state: "OPEN",
    is_draft: 0,
    title: "tracked",
    author: "octocat",
    base_ref: "main",
    head_ref: "feature",
    head_sha: "a".repeat(40),
    updated_at: updatedAt,
    additions: 1,
    deletions: 0,
    changed_files: 1,
    commit_count: 1,
    mergeable,
    merge_state_status: mergeStateStatus,
    auto_merge_enabled: 0,
    viewer_is_author: 1,
    viewer_review_requested: 0,
    viewer_review_state: null,
    ci_status: "SUCCESS",
    review_decision: null,
    unresolved_count: 0,
    needs_me_rank: 0,
    greptile_confidence: null,
    greptile_reviewed_sha: null,
    greptile_unresolved_count: 0,
    detail_json: JSON.stringify({
      number,
      title: "tracked",
      body: "",
      state: "OPEN",
      isDraft: false,
      updatedAt,
      headRefName: "feature",
      headRefOid: "a".repeat(40),
      baseRefName: "main",
      mergeable,
      mergeStateStatus,
      reviews: { nodes: [] },
      reviewRequests: { nodes: [] },
      comments: { nodes: [] },
      reviewThreads: { nodes: [] },
      commitList: { nodes: [] },
    }),
    fetched_at: fetchedAt,
  } as unknown as Parameters<typeof upsertPr>[0];
}

describe("statsExcludingTests", () => {
  test("sums non-test files, drops test files", () => {
    const detail = {
      files: {
        totalCount: 3,
        nodes: [
          { path: "src/foo.ts", additions: 10, deletions: 2 },
          { path: "src/foo.test.ts", additions: 50, deletions: 40 },
          { path: "src/bar.ts", additions: 5, deletions: 1 },
        ],
      },
    };
    expect(statsExcludingTests(pr, detail, testRe)).toEqual({ additions: 15, deletions: 3 });
  });

  test("falls back to raw totals when the 100-file cap was hit", () => {
    const detail = { files: { totalCount: 120, nodes: [{ path: "src/foo.ts", additions: 10, deletions: 2 }] } };
    expect(statsExcludingTests(pr, detail, testRe)).toEqual({ additions: 999, deletions: 999 });
  });

  test("falls back to raw totals when detail_json predates the files field", () => {
    expect(statsExcludingTests(pr, {}, testRe)).toEqual({ additions: 999, deletions: 999 });
  });

  test("respects a custom test_path_regex", () => {
    const detail = {
      files: {
        totalCount: 2,
        nodes: [
          { path: "src/foo.ts", additions: 10, deletions: 2 },
          { path: "e2e/foo.ts", additions: 50, deletions: 40 },
        ],
      },
    };
    expect(statsExcludingTests(pr, detail, testMatcher("^e2e/"))).toEqual({ additions: 10, deletions: 2 });
  });
});

describe("trackedDetailIsStale", () => {
  const now = Date.parse("2026-07-06T10:00:00Z");

  test("fresh row is served as-is", () => {
    expect(trackedDetailIsStale("2026-07-06T09:59:30Z", now)).toBe(false);
  });

  test("row older than the TTL triggers a refresh", () => {
    expect(trackedDetailIsStale("2026-07-06T09:58:00Z", now)).toBe(true);
  });

  test("boundary: exactly at the TTL is not stale", () => {
    expect(trackedDetailIsStale("2026-07-06T09:59:00Z", now)).toBe(false);
  });
});

describe("mergeabilityNeedsRefresh", () => {
  const now = Date.parse("2026-07-06T10:00:00Z");
  const transient = { state: "OPEN", isDraft: false, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };

  test("boundary: exactly at the transient TTL is not stale", () => {
    expect(mergeabilityNeedsRefresh("2026-07-06T09:59:30Z", transient, now)).toBe(false);
  });

  test("transient mergeability older than the TTL triggers a refresh", () => {
    expect(mergeabilityNeedsRefresh("2026-07-06T09:59:29.999Z", transient, now)).toBe(true);
  });

  test("one unresolved mergeability field triggers a refresh", () => {
    expect(mergeabilityNeedsRefresh("2026-07-06T09:00:00Z", {
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "UNKNOWN",
    }, now)).toBe(true);
  });

  test("stable mergeability does not trigger a refresh", () => {
    expect(mergeabilityNeedsRefresh("2026-07-06T09:00:00Z", {
      state: "OPEN",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "BEHIND",
    }, now)).toBe(false);
  });

  test("draft mergeability does not trigger a refresh", () => {
    expect(mergeabilityNeedsRefresh("2026-07-06T09:00:00Z", {
      state: "OPEN",
      isDraft: true,
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
    }, now)).toBe(false);
  });

  test("closed PR mergeability does not trigger a refresh", () => {
    expect(mergeabilityNeedsRefresh("2026-07-06T09:00:00Z", {
      state: "MERGED",
      isDraft: false,
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
    }, now)).toBe(false);
  });
});

describe("health", () => {
  test("identifies the checkout serving the port", async () => {
    const response = await buildFetchHandler(4820)(new Request("http://127.0.0.1:4820/healthz"));
    const body = (await response.json()) as { root?: string; supervisor?: string; pid?: number };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ root: process.cwd(), supervisor: "unmanaged", pid: process.pid });
  });
});

describe("merged PR analytics", () => {
  beforeEach(() => db.exec("DELETE FROM merged_pr_analytics_cache"));

  test("returns the repository/base response, caps the window, and serves the durable cache", async () => {
    const calls: Array<{ repo: string; base: string }> = [];
    const analytics = {
      repo: "example-org/webapp",
      base: "release/v2",
      asOf: new Date().toISOString(),
      pullRequests: [{
        number: 42,
        title: "Ship release analytics",
        url: "https://github.com/example-org/webapp/pull/42",
        author: "octocat",
        mergedAt: "2026-08-26T09:30:00.000Z",
      }],
    };
    const fetchHandler = buildFetchHandler(4820, {
      fetchMergedPrAnalytics: async (repo, base) => {
        calls.push({ repo, base });
        return analytics;
      },
    });

    const url = "http://127.0.0.1:4820/api/merged-pr-analytics?repo=example-org%2Fwebapp&base=release%2Fv2&days=999";
    const response = await fetchHandler(new Request(url));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(analytics);
    expect(calls).toEqual([{ repo: "example-org/webapp", base: "release/v2" }]);

    const cachedResponse = await fetchHandler(new Request(url));
    expect(cachedResponse.status).toBe(200);
    expect(await cachedResponse.json()).toEqual(analytics);
    expect(calls).toHaveLength(1);
  });

  test("windows the cached payload to the requested days", async () => {
    const recent = {
      number: 7,
      title: "Fresh merge",
      url: "https://github.com/example-org/api/pull/7",
      author: "hubot",
      mergedAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
    };
    const old = { ...recent, number: 6, title: "Old merge", mergedAt: new Date(Date.now() - 40 * 24 * 60 * 60_000).toISOString() };
    const fetchHandler = buildFetchHandler(4820, {
      fetchMergedPrAnalytics: async (repo, base) => ({ repo, base, asOf: new Date().toISOString(), pullRequests: [recent, old] }),
    });

    const response = await fetchHandler(new Request(
      "http://127.0.0.1:4820/api/merged-pr-analytics?repo=example-org%2Fapi&base=main&days=30",
    ));
    const body = await response.json();
    expect(body.pullRequests).toEqual([recent]);
  });

  test("rejects invalid repository, base, and days parameters before fetching", async () => {
    let calls = 0;
    const fetchHandler = buildFetchHandler(4820, {
      fetchMergedPrAnalytics: async () => {
        calls += 1;
        throw new Error("should not fetch");
      },
    });
    const invalidQueries = [
      "base=main&days=30",
      "repo=example-org&base=main&days=30",
      "repo=example-org%2Fwebapp&days=30",
      "repo=example-org%2Fwebapp&base=..%2Fmain&days=30",
      "repo=example-org%2Fwebapp&base=main&days=0",
      "repo=example-org%2Fwebapp&base=main&days=1.5",
      "repo=example-org%2Fwebapp&base=main&days=recent",
    ];

    for (const query of invalidQueries) {
      const response = await fetchHandler(new Request(`http://127.0.0.1:4820/api/merged-pr-analytics?${query}`));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid repo/base/days" });
    }
    expect(calls).toBe(0);
  });
});

describe("hosted update policy", () => {
  test("hides updates and rejects update requests when updates are disabled", async () => {
    const previous = process.env.COCKPIT_UPDATE_DISABLED;
    process.env.COCKPIT_UPDATE_DISABLED = "1";
    try {
      const fetchHandler = buildFetchHandler(4820);
      const versionResponse = await fetchHandler(new Request("http://127.0.0.1:4820/api/version"));
      const updateResponse = await fetchHandler(new Request("http://127.0.0.1:4820/api/update", { method: "POST" }));

      expect(versionResponse.status).toBe(200);
      expect(await versionResponse.json()).toMatchObject({ updateAvailable: false });
      expect(updateResponse.status).toBe(403);
      expect(await updateResponse.json()).toEqual({ error: "updates are disabled for this installation" });
    } finally {
      if (previous === undefined) delete process.env.COCKPIT_UPDATE_DISABLED;
      else process.env.COCKPIT_UPDATE_DISABLED = previous;
    }
  });
});

describe("PR link bridge", () => {
  const fetchHandler = buildFetchHandler(4820);

  test("redirects the local HTTP URL to the registered app protocol", async () => {
    const response = await fetchHandler(new Request("http://127.0.0.1:4820/open/pr/example-org/webapp/5950"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("prcockpit://pr/example-org/webapp/5950");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("rejects malformed PR paths instead of producing an arbitrary protocol URL", async () => {
    const response = await fetchHandler(new Request("http://127.0.0.1:4820/open/pr/example-org/webapp/not-a-number"));

    expect(response.status).toBe(400);
  });
});

describe("agent PR summary", () => {
  const detail = {
    title: "Fix calendar recurrence",
    body: "Keep recurrence expansion bounded.",
    url: "https://github.com/example-org/webapp/pull/6133",
    state: "OPEN",
    isDraft: false,
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    reviewDecision: "REVIEW_REQUIRED",
    updatedAt: "2026-07-22T10:00:00Z",
    headRefName: "reconcile-cooldown",
    headRefOid: "a".repeat(40),
    lastCommit: {
      nodes: [{
        commit: {
          statusCheckRollup: {
            state: "PENDING",
            contexts: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: null, isRequired: true },
                { __typename: "CheckRun", name: "tests", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: null, isRequired: true },
                { __typename: "CheckRun", name: "review", status: "IN_PROGRESS", conclusion: null, detailsUrl: "https://example.com/review", isRequired: false },
                { __typename: "StatusContext", context: "deploy", state: "FAILURE", targetUrl: "https://example.com/deploy", isRequired: true },
                { __typename: "CheckRun", name: "trpc compat", status: "COMPLETED", conclusion: "SKIPPED", detailsUrl: null, isRequired: true },
                { __typename: "CheckRun", name: "browser", status: "COMPLETED", conclusion: "CANCELLED", detailsUrl: null, isRequired: false },
              ],
            },
          },
        },
      }],
    },
    reviewThreads: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        {
          id: "thread-calendar",
          isResolved: false,
          isOutdated: false,
          path: "src/calendar.ts",
          line: 42,
          comments: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ author: { login: "reviewer" }, body: "Handle  the\nDST boundary.", createdAt: "2026-07-22T09:00:00Z" }],
          },
        },
        {
          id: "thread-calendar-outdated",
          isResolved: false,
          isOutdated: true,
          path: "src/calendar.ts",
          line: null,
          comments: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{ author: { login: "theo" }, body: "This still needs follow-up.", createdAt: "2026-07-22T09:30:00Z" }],
          },
        },
        { id: "thread-resolved", isResolved: true, isOutdated: false, path: "old.ts", line: 1, comments: { nodes: [] } },
      ],
    },
  } as unknown as PrDetail;

  test("includes every fetched check and the checked head", () => {
    const summary = buildPrAgentSummary("example-org/webapp#6133", detail, null);

    expect(summary.head).toBe("reconcile-cooldown");
    expect(summary.headSha).toBe("a".repeat(40));
    expect(summary.ci).toEqual({
      headSha: "a".repeat(40),
      checksFetched: true,
      state: "PENDING",
      complete: true,
      passed: 2,
      running: 1,
      failed: 1,
      cancelled: 1,
      skipped: 1,
      checks: [
        { name: "lint", state: "passed", required: true, url: null, logBytes: null },
        { name: "tests", state: "passed", required: true, url: null, logBytes: null },
        { name: "review", state: "running", required: false, url: "https://example.com/review", logBytes: null },
        { name: "deploy", state: "failed", required: true, url: "https://example.com/deploy", logBytes: null },
        { name: "trpc compat", state: "skipped", required: true, url: null, logBytes: null },
        { name: "browser", state: "cancelled", required: false, url: null, logBytes: null },
      ],
    });
    expect(summary.openComments).toEqual([
      {
        handle: reviewThreadHandle("thread-calendar"),
        path: "src/calendar.ts",
        line: 42,
        outdated: false,
        comments: [{ author: "reviewer", body: "Handle the DST boundary.", createdAt: "2026-07-22T09:00:00Z" }],
      },
      {
        path: "src/calendar.ts",
        handle: reviewThreadHandle("thread-calendar-outdated"),
        line: null,
        outdated: true,
        comments: [{ author: "theo", body: "This still needs follow-up.", createdAt: "2026-07-22T09:30:00Z" }],
      },
    ]);
    expect(summary.openCommentsComplete).toBe(true);
  });


  test("drops a failed check the moment the same job is queued again, so agents never chase a stale run", () => {
    const rerun = structuredClone(detail) as PrDetail;
    const nodes = rerun.lastCommit.nodes[0]!.commit.statusCheckRollup!.contexts.nodes as unknown[];
    nodes.push(
      { __typename: "CheckRun", name: "flaky", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: null, isRequired: false },
      { __typename: "CheckRun", name: "flaky", status: "QUEUED", conclusion: null, detailsUrl: null, isRequired: false },
      { __typename: "CheckRun", name: "browser", status: "QUEUED", conclusion: null, detailsUrl: null, isRequired: false },
    );

    const ci = buildPrAgentSummary("example-org/webapp#6133", rerun, null).ci;
    expect(ci.checks.filter((c) => c.name === "flaky")).toEqual([
      { name: "flaky", state: "running", required: false, url: null, logBytes: null },
    ]);
    expect(ci.checks.filter((c) => c.name === "browser")).toEqual([
      { name: "browser", state: "running", required: false, url: null, logBytes: null },
    ]);
    expect(ci.failed).toBe(1);
    expect(ci.cancelled).toBe(0);
    expect(ci.running).toBe(3);
  });

  test("keeps a four-minute-old snapshot recent without newer webhook evidence", () => {
    const fetchedAt = new Date(Date.now() - 4 * 60_000).toISOString();
    const agentSnapshot = snapshotStatus(fetchedAt, null);
    const output = formatPrAgentSummary(buildPrAgentSummary("example-org/webapp#6133", { ...detail, agentSnapshot }, null));

    expect(agentSnapshot).toEqual({
      fetchedAt,
      freshness: "recent",
      newerActivityAt: null,
    });
    expect(output).toContain(`Cached snapshot: 4m old · ${fetchedAt}`);
    expect(output).not.toContain("Cached snapshot: OUTDATED");
    expect(output).not.toContain("Cached snapshot is stale");
  });

  test("marks a snapshot outdated when a later webhook is known", () => {
    expect(snapshotStatus("2026-07-22T13:45:00Z", "2026-07-22T13:46:00Z")).toEqual({
      fetchedAt: "2026-07-22T13:45:00Z",
      freshness: "outdated",
      newerActivityAt: "2026-07-22T13:46:00Z",
    });
  });

  test("labels cached data when quota prevents refresh", () => {
    const fetchedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    const newerActivityAt = new Date().toISOString();
    const resetAt = "2026-07-22T14:10:52.000Z";
    const summary = buildPrAgentSummary("example-org/webapp#6133", {
      ...detail,
      agentSnapshot: {
        fetchedAt,
        freshness: "outdated",
        newerActivityAt,
      },
    }, {
      rest: { limit: 5_000, used: 1, remaining: 4_999, resetAt },
      graphql: { limit: 5_000, used: 5_000, remaining: 0, resetAt },
      fetchedAt,
    });
    const output = formatPrAgentSummary(summary);

    expect(summary.snapshot).toEqual({ fetchedAt, freshness: "outdated", newerActivityAt });

    expect(output).toContain(`Cached snapshot: OUTDATED · 11m old · ${fetchedAt}`);
    expect(output).toContain(`Refresh unavailable until ${resetAt}: GitHub GraphQL quota exhausted.`);
    expect(output).toContain("Cached snapshot: OUTDATED");
    expect(output).toContain(`Known newer activity: webhook received ${newerActivityAt}.`);
    expect(output).toContain("This snapshot does not include that activity.");
    expect(output).toContain("Checks: 2 passed · 1 running · 1 failed · 1 cancelled · 1 skipped · 6 total");
    expect(output).toContain("## Body\n\nKeep recurrence expansion bounded.");
    expect(output).toContain("FAILED required: deploy");
    expect(output).toContain("SKIPPED required: trpc compat");
    expect(output).toContain("CANCELLED: browser");
    expect(output).toContain("`src/calendar.ts:42`");
    expect(output).toContain("`src/calendar.ts` · OUTDATED");
    expect(output).toContain("Head SHA: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  test("omits the body with a read pointer when includeBody is false", () => {
    const output = formatPrAgentSummary(buildPrAgentSummary("example-org/webapp#6133", detail, null), { body: false });
    expect(output).toContain("## Body\n\n_Omitted. Read it with `pr-cockpit example-org/webapp#6133`._");
    expect(output).not.toContain("Keep recurrence expansion bounded.");
    expect(output).toContain("## Cockpit Status");
  });

  test("flags outdated auto-resolve-marker threads for manual resolution", () => {
    const original = getSetting("review_bots");
    const marked = structuredClone(detail);
    marked.reviewThreads.nodes[1]!.comments.nodes[0]!.body = "Fixed in the latest push. <!-- example-reviewer-inline -->";
    try {
      setSetting("review_bots", JSON.stringify([{ login: "example-reviewer", patterns: [], staleMarker: "example-reviewer-inline" }]));
      const output = formatPrAgentSummary(buildPrAgentSummary("example-org/webapp#6133", marked, null));
      expect(output).toContain(
        `- \`${reviewThreadHandle("thread-calendar-outdated")}\` · \`src/calendar.ts\` · OUTDATED · STALE AUTO-RESOLVE — resolve manually`,
      );

      setSetting("review_bots", "[]");
      expect(formatPrAgentSummary(buildPrAgentSummary("example-org/webapp#6133", marked, null))).not.toContain("STALE AUTO-RESOLVE — resolve manually");
    } finally {
      if (original === null) db.query("DELETE FROM settings WHERE key = 'review_bots'").run();
      else setSetting("review_bots", original);
    }
  });

  test("labels paginated checks and comments as partial", () => {
    const partial = structuredClone(detail);
    partial.lastCommit.nodes[0]!.commit.statusCheckRollup!.contexts.pageInfo = { hasNextPage: true, endCursor: "checks" };
    partial.reviewThreads.nodes[0]!.comments.pageInfo = { hasNextPage: true, endCursor: "comments" };
    const output = formatPrAgentSummary(buildPrAgentSummary("example-org/webapp#6133", partial, null));

    expect(output).toContain("PARTIAL (100+ checks)");
    expect(output).toContain("_Partial: review threads or replies may be missing._");
  });

  test("distinguishes an empty check result from a missing check result", () => {
    const empty = structuredClone(detail);
    empty.lastCommit.nodes[0]!.commit.statusCheckRollup = null;
    expect(buildPrAgentSummary("example-org/webapp#6133", empty, null).ci).toMatchObject({
      checksFetched: true,
      complete: true,
      checks: [],
    });

    const missing = structuredClone(detail);
    missing.lastCommit.nodes = [];
    expect(buildPrAgentSummary("example-org/webapp#6133", missing, null).ci).toMatchObject({
      checksFetched: false,
      complete: false,
      checks: [],
    });
  });

  test("does not claim legacy comment snapshots are complete without pagination metadata", () => {
    const partial = structuredClone(detail);
    delete partial.reviewThreads.pageInfo;
    delete partial.reviewThreads.nodes[0]!.comments.pageInfo;

    expect(buildPrAgentSummary("example-org/webapp#6133", partial, null).openCommentsComplete).toBe(false);
  });
  test("renders only REST comments supplied for the requested since boundary", () => {
    const since = "2026-07-22T10:00:00Z";
    const output = formatPrAgentSummary(buildPrAgentSummary("example-org/webapp#6133", detail, null, since, [{
      kind: "thread",
      author: "reviewer",
      body: "  Keep this\nbounded. ",
      createdAt: "2026-07-22T10:05:00Z",
      path: "src/calendar.ts",
      line: 42,
      state: null,
      url: "https://github.com/example-org/webapp/pull/6133#discussion_r1",
    }]));

    expect(output).toContain(`## New Comments Since ${since}`);
    expect(output).toContain("thread · `src/calendar.ts:42`: Keep this bounded.");
    expect(output).toContain("https://github.com/example-org/webapp/pull/6133#discussion_r1");
    expect(output).not.toContain("Handle the DST boundary.");
  });

  test("digest renders only the delta: new comments plus failing checks", () => {
    const since = "2026-07-22T10:00:00Z";
    const output = formatPrAgentSummary(buildPrAgentSummary("example-org/webapp#6133", detail, null, since, [{
      kind: "review comment",
      author: "reviewer",
      body: "Keep this bounded.",
      createdAt: "2026-07-22T10:05:00Z",
      path: "src/calendar.ts",
      line: 42,
      state: null,
      url: "https://github.com/example-org/webapp/pull/6133#discussion_r1",
    }]), { digest: true });

    expect(output).toContain("- @reviewer · review comment · `src/calendar.ts:42`: Keep this bounded.");
    expect(output).toContain("CI: PENDING");
    expect(output).toContain("- FAILED required: deploy");
    expect(output).toContain("- CANCELLED: browser");
    expect(output).not.toContain("# Pull Request");
    expect(output).not.toContain("## ");
    expect(output).not.toContain("Full state");
    expect(output).not.toContain("State: OPEN");
    expect(output).not.toContain("- PASSED");
    expect(output).not.toContain("Quota:");
  });

  test("digest falls back to open review threads when no new comments arrived", () => {
    const output = formatPrAgentSummary(buildPrAgentSummary("example-org/webapp#6133", detail, null, "2026-07-22T10:00:00Z", []), { digest: true });

    expect(output).toContain("Handle the DST boundary.");
    expect(output).not.toContain("_No new comments._");
    expect(output).not.toContain("## Open Review Comments");
  });


  test("rejects malformed agent PR references", async () => {
    const response = await buildFetchHandler(4820)(new Request("http://127.0.0.1:4820/api/agent/pr/example-org/webapp/not-a-number"));
    expect(response.status).toBe(400);
  });

  test("resolves a cached review thread by its displayed handle", async () => {
    const repo = "cockpit-test/thread-resolution";
    const number = 987654325;
    const threadId = "PRRT_test_thread";
    const cachedDetail = {
      headRefOid: "a".repeat(40),
      reviewThreads: {
        nodes: [{ id: threadId, isResolved: false, isOutdated: false, path: "src/value.ts", line: 7, comments: { nodes: [] } }],
      },
    } as unknown as PrDetail;
    upsertCachedPrDetail({
      repo,
      number,
      head_sha: cachedDetail.headRefOid,
      detail_json: JSON.stringify(cachedDetail),
      fetched_at: new Date().toISOString(),
    });
    const resolvedIds: string[] = [];
    const fetchHandler = buildFetchHandler(4820, {
      resolveReviewThread: async (id) => {
        resolvedIds.push(id);
      },
      fetchPrDetail: async () => ({
        ...cachedDetail,
        reviewThreads: { nodes: [{ ...cachedDetail.reviewThreads.nodes[0]!, isResolved: true }] },
      }),
    });
    const requestUrl = `http://127.0.0.1:4820/api/agent/pr/cockpit-test/thread-resolution/${number}/threads/${reviewThreadHandle(threadId)}`;
    const response = await fetchHandler(new Request(requestUrl, {
      method: "POST",
      headers: { "x-pr-cockpit-cli": "1" },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resolved: true, alreadyResolved: false });
    expect(resolvedIds).toEqual([threadId]);
    expect(JSON.parse(getCachedPrDetail(repo, number)!.detail_json).reviewThreads.nodes[0].isResolved).toBe(true);
    const repeated = await fetchHandler(new Request(requestUrl, {
      method: "POST",
      headers: { "x-pr-cockpit-cli": "1" },
    }));
    expect(await repeated.json()).toEqual({ resolved: true, alreadyResolved: true });
    expect(resolvedIds).toEqual([threadId, threadId]);
  });

  test("normalizes agent-friendly merge and thread mutations", () => {
    const repo = "cockpit-test/agent-mutations";
    const number = 987654327;
    const threadId = "PRRT_agent_mutation";
    const row = trackedPrRow({ repo, number, fetchedAt: new Date().toISOString() });
    const detail = JSON.parse(row.detail_json) as PrDetail;
    detail.reviewThreads.nodes = [{
      id: threadId,
      isResolved: false,
      isOutdated: false,
      path: "src/value.ts",
      line: 7,
      diffSide: "RIGHT",
      comments: {
        nodes: [{
          databaseId: 42,
          diffHunk: "",
          author: null,
          body: "root",
          createdAt: "2026-08-27T00:00:00Z",
          reactions: [],
        }],
      },
    }];
    upsertPr({ ...row, detail_json: JSON.stringify(detail) });
    const threadHandle = reviewThreadHandle(threadId);

    expect(normalizeAgentMutation(repo, number, detail, { kind: "merge", force: true, method: "rebase" })).toEqual({
      kind: "merge",
      force: true,
      baseRef: "main",
      method: "rebase",
      source: "explicit",
    });
    expect(normalizeAgentMutation(repo, number, detail, {
      kind: "reply-to-thread",
      threadHandle,
      body: "fixed",
    })).toEqual({ kind: "reply-to-thread", rootCommentId: 42, body: "fixed" });
    expect(normalizeAgentMutation(repo, number, detail, {
      kind: "resolve-thread",
      threadHandle,
      resolved: false,
    })).toEqual({ kind: "resolve-thread", threadId, resolved: false });

    db.query("DELETE FROM prs WHERE repo = ? AND number = ?").run(repo, number);
  });

  test("accepts trusted CLI mutations through the agent route", async () => {
    const repo = "cockpit-test/agent-mutation-route";
    const number = 987654328;
    upsertPr(trackedPrRow({ repo, number, fetchedAt: new Date().toISOString() }));
    const handler = buildFetchHandler(4820);
    const url = `http://127.0.0.1:4820/api/agent/pr/cockpit-test/agent-mutation-route/${number}/mutations`;
    const denied = await handler(new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: { kind: "auto-merge", enable: true } }),
    }));
    expect(denied.status).toBe(403);

    const accepted = await handler(new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pr-cockpit-cli": "1" },
      body: JSON.stringify({ payload: { kind: "auto-merge", enable: true } }),
    }));
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toHaveProperty("id");
  });

  test("recomputes tracked PR rank when resolution refresh fails", async () => {
    const repo = "cockpit-test/thread-rank";
    const number = 987654326;
    const threadId = "PRRT_rank_thread";
    const row = trackedPrRow({ repo, number, fetchedAt: new Date().toISOString() });
    const detail = JSON.parse(row.detail_json) as PrDetail;
    detail.reviewThreads.nodes = [{
      id: threadId,
      isResolved: false,
      isOutdated: false,
      path: "src/value.ts",
      line: 7,
      diffSide: "RIGHT",
      comments: { nodes: [] },
    }];
    upsertPr({ ...row, unresolved_count: 1, needs_me_rank: 1, detail_json: JSON.stringify(detail) });
    const response = await buildFetchHandler(4820, {
      resolveReviewThread: async () => {},
      refreshPr: async () => {
        throw new Error("refresh unavailable");
      },
    })(new Request(
      `http://127.0.0.1:4820/api/agent/pr/cockpit-test/thread-rank/${number}/threads/${reviewThreadHandle(threadId)}`,
      { method: "POST", headers: { "x-pr-cockpit-cli": "1" } },
    ));

    expect(response.status).toBe(200);
    expect(getPr(repo, number)).toMatchObject({ unresolved_count: 0, needs_me_rank: 2 });
    db.query("DELETE FROM prs WHERE repo = ? AND number = ?").run(repo, number);
  });

  test("rejects browser posts to the thread mutation route", async () => {
    const response = await buildFetchHandler(4820)(new Request(
      "http://127.0.0.1:4820/api/agent/pr/example-org/webapp/6700/threads/0123456789",
      {
        method: "POST",
        headers: {
          host: "attacker.example",
          origin: "http://attacker.example",
          "sec-fetch-site": "same-origin",
          "x-pr-cockpit-cli": "1",
        },
      },
    ));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "loopback CLI request required" });
  });

  test("rejects malformed agent diff references", async () => {
    const response = await buildFetchHandler(4820)(new Request("http://127.0.0.1:4820/api/agent/pr/example-org/webapp/not-a-number/diff"));
    expect(response.status).toBe(400);
  });

  test("does not fetch an uncached PR diff from GitHub", async () => {
    const response = await buildFetchHandler(4820)(
      new Request("http://127.0.0.1:4820/api/agent/pr/cockpit-test/uncached/987654322/diff"),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "PR is not cached yet" });
  });

  test("does not fetch an uncached PR file from GitHub", async () => {
    const response = await buildFetchHandler(4820)(
      new Request("http://127.0.0.1:4820/api/agent/pr/cockpit-test/uncached/987654322/file?path=src%2Fvalue.ts"),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "PR is not cached yet" });
  });

  test("requires a path for agent file reads", async () => {
    const response = await buildFetchHandler(4820)(new Request("http://127.0.0.1:4820/api/agent/pr/example-org/webapp/6133/file"));
    expect(response.status).toBe(400);
  });

  test("old agent reads deduplicate background refresh and converge", async () => {
    const repo = "cockpit-test/revalidation";
    const number = 987654320;
    const staleDetail = {
      ...detail,
      title: "stale",
      headRefOid: "a".repeat(40),
      headRefName: "revalidation",
      baseRefName: "main",
    } as PrDetail;
    const freshDetail = {
      ...staleDetail,
      title: "fresh",
      headRefOid: "b".repeat(40),
    };
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let markFetchReturned!: () => void;
    const fetchReturned = new Promise<void>((resolve) => {
      markFetchReturned = resolve;
    });
    const refreshFinished = fetchReturned.then(async () => {
      await Promise.resolve();
    });
    let refreshCalls = 0;
    const fetchedAt = new Date().toISOString();
    const fetchHandler = buildFetchHandler(4820, {
      fetchPrDetail: async () => {
        refreshCalls += 1;
        await refreshGate;
        markFetchReturned();
        return freshDetail;
      },
      fetchGithubQuota: async () => ({
        rest: { limit: 5_000, used: 0, remaining: 5_000, resetAt: fetchedAt },
        graphql: { limit: 5_000, used: 0, remaining: 5_000, resetAt: fetchedAt },
        fetchedAt,
      }),
      fetchPrCommentsSince: async () => [],
    });
    const url = `http://127.0.0.1:4820/api/agent/pr/cockpit-test/revalidation/${number}?format=json`;

    upsertCachedPrDetail({
      repo,
      number,
      head_sha: staleDetail.headRefOid,
      detail_json: JSON.stringify(staleDetail),
      fetched_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });

    try {
      const first = await fetchHandler(new Request(url));
      const second = await fetchHandler(new Request(url));
      const firstSummary = await first.json() as { title: string; snapshot: { freshness: string } };
      const secondSummary = await second.json() as { title: string };
      expect(firstSummary.title).toBe("stale");
      expect(firstSummary.snapshot.freshness).toBe("recent");
      expect(secondSummary.title).toBe("stale");
      expect(refreshCalls).toBe(1);

      releaseRefresh();
      await refreshFinished;

      const refreshed = await fetchHandler(new Request(url));
      const refreshedSummary = await refreshed.json() as {
        title: string;
        headSha: string;
        ci: { headSha: string; checksFetched: boolean; checks: unknown[] };
        snapshot: { freshness: string };
      };
      expect(refreshedSummary.title).toBe("fresh");
      expect(refreshedSummary.headSha).toBe("b".repeat(40));
      expect(refreshedSummary.ci).toMatchObject({
        headSha: "b".repeat(40),
        checksFetched: true,
      });
      expect(refreshedSummary.ci.checks).toHaveLength(6);
      expect(refreshedSummary.snapshot.freshness).toBe("recent");
      expect(refreshCalls).toBe(1);
    } finally {
      releaseRefresh();
      if (refreshCalls > 0) await refreshFinished;
      db.query("DELETE FROM pr_detail_cache WHERE repo = ? AND number = ?").run(repo, number);
    }
  });

  test("an old tracked agent read revalidates in the background; a fresh one does not", async () => {
    const repo = "cockpit-test/tracked-revalidate";
    const number = 987654322;

    let refreshCalls = 0;
    let releaseRefresh!: () => void;
    let markRefreshFinished!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshFinished = new Promise<void>((resolve) => {
      markRefreshFinished = resolve;
    });
    const fetchHandler = buildFetchHandler(4820, {
      refreshPr: async () => {
        refreshCalls += 1;
        await refreshGate;
        markRefreshFinished();
      },
    });
    const url = `http://127.0.0.1:4820/api/agent/pr/${repo}/${number}?format=json`;

    try {
      upsertPr(trackedPrRow({ repo, number, fetchedAt: new Date(Date.now() - 10 * 60_000).toISOString() }));
      const stale = await fetchHandler(new Request(url));
      expect((await stale.json() as { snapshot: { freshness: string } }).snapshot.freshness).toBe("recent");
      // Second stale read lands while the first refresh is still in flight.
      await fetchHandler(new Request(url));
      expect(refreshCalls).toBe(1);
      releaseRefresh();
      await refreshFinished;
      // Let the revalidator drop its in-flight entry, so a wrong refresh here would not dedup away.
      await new Promise((resolve) => setTimeout(resolve, 0));

      upsertPr(trackedPrRow({ repo, number, fetchedAt: new Date().toISOString() }));
      const fresh = await fetchHandler(new Request(url));
      expect((await fresh.json() as { snapshot: { freshness: string } }).snapshot.freshness).toBe("recent");
      expect(refreshCalls).toBe(1);
    } finally {
      db.query("DELETE FROM prs WHERE repo = ? AND number = ?").run(repo, number);
    }
  });

  test("serves a requested PR file from Cockpit's cache", async () => {
    const repo = "cockpit-test/agent-file";
    const number = 987654321;
    const headSha = "a".repeat(40);
    const path = "src/value.ts";
    upsertCachedPrDetail({
      repo,
      number,
      head_sha: headSha,
      detail_json: JSON.stringify({ baseRefName: "main" }),
      fetched_at: new Date().toISOString(),
    });
    saveFileContents(headSha, path, "export const value = 42;\n");

    try {
      const response = await buildFetchHandler(4820)(
        new Request(`http://127.0.0.1:4820/api/agent/pr/cockpit-test/agent-file/${number}/file?path=${encodeURIComponent(path)}`),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(await response.text()).toBe("export const value = 42;\n");
    } finally {
      db.query("DELETE FROM pr_detail_cache WHERE repo = ? AND number = ?").run(repo, number);
      db.query("DELETE FROM file_contents WHERE sha = ? AND path = ?").run(headSha, path);
    }
  });
});

describe("PR detail refresh", () => {
  test("an old normal tracked read revalidates transient mergeability without blocking", async () => {
    const repo = "cockpit-test/transient-mergeability";
    const number = 987654323;
    let refreshCalls = 0;
    let releaseRefresh!: () => void;
    let markRefreshFinished!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshFinished = new Promise<void>((resolve) => {
      markRefreshFinished = resolve;
    });
    const fetchHandler = buildFetchHandler(4820, {
      refreshPr: async () => {
        refreshCalls += 1;
        await refreshGate;
        upsertPr(trackedPrRow({
          repo,
          number,
          fetchedAt: new Date().toISOString(),
          mergeable: "MERGEABLE",
          mergeStateStatus: "BEHIND",
        }));
        markRefreshFinished();
      },
    });
    const url = `http://127.0.0.1:4820/api/pr/cockpit-test/transient-mergeability/${number}`;

    try {
      upsertPr(trackedPrRow({
        repo,
        number,
        fetchedAt: new Date(Date.now() - 61_000).toISOString(),
        mergeable: "UNKNOWN",
        mergeStateStatus: "UNKNOWN",
      }));
      const stale = await fetchHandler(new Request(url));
      expect((await stale.json() as { mergeStateStatus: string }).mergeStateStatus).toBe("UNKNOWN");
      expect(refreshCalls).toBe(1);

      releaseRefresh();
      await refreshFinished;
      const refreshed = await fetchHandler(new Request(url));
      expect((await refreshed.json() as { mergeStateStatus: string }).mergeStateStatus).toBe("BEHIND");
      expect(refreshCalls).toBe(1);
    } finally {
      releaseRefresh();
      db.query("DELETE FROM prs WHERE repo = ? AND number = ?").run(repo, number);
    }
  });

  test("an untracked read revalidates transient mergeability without blocking", async () => {
    const repo = "cockpit-test/untracked-mergeability";
    const number = 987654324;
    const staleDetail = {
      state: "OPEN",
      isDraft: false,
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
      updatedAt: "2026-07-25T00:00:00Z",
      headRefName: "feature",
      headRefOid: "a".repeat(40),
      baseRefName: "main",
    };
    let releaseRefresh!: () => void;
    let markRefreshFinished!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshFinished = new Promise<void>((resolve) => {
      markRefreshFinished = resolve;
    });
    let refreshCalls = 0;
    const fetchHandler = buildFetchHandler(4820, {
      fetchPrDetail: async () => {
        refreshCalls += 1;
        await refreshGate;
        markRefreshFinished();
        return {
          ...staleDetail,
          mergeable: "MERGEABLE",
          mergeStateStatus: "BEHIND",
        } as unknown as PrDetail;
      },
    });
    const url = `http://127.0.0.1:4820/api/pr/cockpit-test/untracked-mergeability/${number}`;

    try {
      upsertCachedPrDetail({
        repo,
        number,
        head_sha: staleDetail.headRefOid,
        detail_json: JSON.stringify(staleDetail),
        fetched_at: new Date(Date.now() - 31_000).toISOString(),
      });
      const stale = await fetchHandler(new Request(url));
      expect((await stale.json() as { mergeStateStatus: string }).mergeStateStatus).toBe("UNKNOWN");
      expect(refreshCalls).toBe(1);

      releaseRefresh();
      await refreshFinished;
      await new Promise((resolve) => setTimeout(resolve, 0));
      const refreshed = await fetchHandler(new Request(url));
      expect((await refreshed.json() as { mergeStateStatus: string }).mergeStateStatus).toBe("BEHIND");
      expect(refreshCalls).toBe(1);
    } finally {
      releaseRefresh();
      db.query("DELETE FROM pr_detail_cache WHERE repo = ? AND number = ?").run(repo, number);
    }
  });
});

describe("PR title index", () => {
  test("hydrates explicitly requested missing titles and caches them", async () => {
    const repo = "cockpit-test/title-index";
    const number = 987654320;
    const updatedAt = "2026-07-24T20:00:00.000Z";
    let lookupCalls = 0;
    const fetchHandler = buildFetchHandler(4820, {
      lookupPrIndexes: async (requestedRepo, numbers) => {
        lookupCalls += 1;
        expect(requestedRepo).toBe(repo);
        expect(numbers).toEqual([number]);
        return [{
          repo,
          number,
          title: "Hydrated PR title",
          state: "MERGED",
          isDraft: false,
          author: "theo",
          updatedAt,
        }];
      },
    });
    const url = `http://127.0.0.1:4820/api/pr-index?keys=${encodeURIComponent(`${repo}#${number}`)}`;

    db.query("DELETE FROM pr_index WHERE repo = ? AND number = ?").run(repo, number);
    try {
      const first = await fetchHandler(new Request(url));
      expect(await first.json()).toEqual({
        prs: [{
          repo,
          number,
          title: "Hydrated PR title",
          state: "MERGED",
          isDraft: false,
          author: "theo",
          updatedAt,
        }],
      });

      const second = await fetchHandler(new Request(url));
      expect((await second.json() as { prs: unknown[] }).prs).toHaveLength(1);
      expect(lookupCalls).toBe(1);
    } finally {
      db.query("DELETE FROM pr_index WHERE repo = ? AND number = ?").run(repo, number);
    }
  });
});

describe("PR file edits", () => {
  const requestBody = {
    repo: "base-owner/base-repo",
    number: 42,
    path: "src/value.ts",
    expectedHeadOid: "a".repeat(40),
    content: "export const value = 42;\n",
    message: "Edit value",
  };

  function fileEditRequest(body: Record<string, unknown>): Request {
    return new Request("http://127.0.0.1:4820/api/pr-file-edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("writes the exact replacement, refreshes in the background, and returns its commit", async () => {
    let received: unknown;
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    let markRefreshFinished!: () => void;
    const refreshFinished = new Promise<void>((resolve) => {
      markRefreshFinished = resolve;
    });
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshCompleted = false;
    let refreshCalls = 0;
    const commitOid = "c".repeat(40);
    const fetchHandler = buildFetchHandler(4820, {
      commitPrFileEdit: async (input) => {
        received = input;
        return { commitOid };
      },
      refreshPr: async (repo, number) => {
        refreshCalls += 1;
        expect(repo).toBe(requestBody.repo);
        expect(number).toBe(requestBody.number);
        markRefreshStarted();
        await refreshGate;
        refreshCompleted = true;
        markRefreshFinished();
      },
    });

    const responsePromise = fetchHandler(fileEditRequest(requestBody));
    await refreshStarted;
    try {
      const response = await responsePromise;
      expect(received).toEqual(requestBody);
      expect(refreshCalls).toBe(1);
      expect(refreshCompleted).toBe(false);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, commitOid });
    } finally {
      releaseRefresh();
      await refreshFinished;
    }
  });

  test("accepts an empty full replacement", async () => {
    let received: unknown;
    const body = { ...requestBody, content: "" };
    const fetchHandler = buildFetchHandler(4820, {
      commitPrFileEdit: async (input) => {
        received = input;
        return { commitOid: "c".repeat(40) };
      },
      refreshPr: async () => {},
    });

    const response = await fetchHandler(fileEditRequest(body));
    expect(received).toEqual(body);
    expect(response.status).toBe(200);
  });

  test("returns stale-head without refreshing after a stale write", async () => {
    let writeCalls = 0;
    let refreshCalls = 0;
    const fetchHandler = buildFetchHandler(4820, {
      commitPrFileEdit: async () => {
        writeCalls += 1;
        throw new StalePrHeadError();
      },
      refreshPr: async () => {
        refreshCalls += 1;
      },
    });

    const response = await fetchHandler(fileEditRequest(requestBody));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "PR head changed; reload before committing",
      code: "stale-head",
    });
    expect(writeCalls).toBe(1);
    expect(refreshCalls).toBe(0);
  });

  test("returns guided setup when REST workflow access is missing", async () => {
    const body = { ...requestBody, path: ".github/workflows/ci.yml" };
    const auth = {
      ok: false,
      state: "missing-scopes" as const,
      login: "octocat",
      error: "Allow workflow access.",
      requiredScopes: ["repo", "workflow"],
      missingScopes: ["workflow"],
    };
    const fetchHandler = buildFetchHandler(4820, {
      commitPrFileEdit: async () => {
        throw new GithubRequestError(
          'GitHub REST request failed: 403 {"message":"Resource not accessible by personal access token"}',
          502,
        );
      },
      githubAuthStatus: async (scopes) => {
        expect(scopes).toEqual(["repo", "workflow"]);
        return auth;
      },
      refreshPr: async () => {},
    });

    const response = await fetchHandler(fileEditRequest(body));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Allow workflow access.",
      code: "github-setup",
      auth,
    });
  });

  test("starts GitHub setup with only allowed requested scopes", async () => {
    let requestedScopes: readonly string[] = [];
    const auth = {
      ok: false,
      state: "authorizing" as const,
      login: "octocat",
      error: null,
      requiredScopes: ["repo", "workflow"],
      missingScopes: ["workflow"],
    };
    const fetchHandler = buildFetchHandler(4820, {
      startGithubSetup: async (scopes) => {
        requestedScopes = scopes ?? [];
        return auth;
      },
    });

    const response = await fetchHandler(new Request("http://127.0.0.1:4820/api/auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scopes: ["workflow", "repo"] }),
    }));
    expect(response.status).toBe(200);
    expect(requestedScopes).toEqual(["repo", "workflow"]);
    expect(await response.json()).toEqual(auth);
  });

  const invalidRequests: [string, Record<string, unknown>][] = [
    ["a traversal path", { ...requestBody, path: "../private.ts" }],
    ["an abbreviated head SHA", { ...requestBody, expectedHeadOid: "a".repeat(39) }],
    ["a multiline message", { ...requestBody, message: "Edit value\nand more" }],
    ["a blank message", { ...requestBody, message: "   " }],
    ["an overlong message", { ...requestBody, message: "x".repeat(201) }],
    ["an escaped lone high surrogate in content", { ...requestBody, content: String.fromCharCode(0xd800) }],
  ];

  for (const [description, body] of invalidRequests) {
    test(`rejects ${description} without writing`, async () => {
      let writeCalls = 0;
      let refreshCalls = 0;
      const fetchHandler = buildFetchHandler(4820, {
        commitPrFileEdit: async () => {
          writeCalls += 1;
          return { commitOid: "c".repeat(40) };
        },
        refreshPr: async () => {
          refreshCalls += 1;
        },
      });

      const response = await fetchHandler(fileEditRequest(body));
      expect(response.status).toBe(400);
      expect(writeCalls).toBe(0);
      expect(refreshCalls).toBe(0);
    });
  }
});

describe("commit message generation", () => {
  test("uses the cached PR title and edited hunk", async () => {
    const repo = "cockpit-test/commit-message";
    const number = 987654321;
    const row = trackedPrRow({ repo, number, fetchedAt: new Date().toISOString() });
    row.title = "Stop queued staging deploys";
    row.detail_json = JSON.stringify({
      ...JSON.parse(row.detail_json),
      title: row.title,
      body: "Keep only the newest pending deployment.",
    });
    upsertPr(row);
    let received: unknown;
    const fetchHandler = buildFetchHandler(4820, {
      generateCommitMessage: async (input) => {
        received = input;
        return "fix(ci): remove the deployment queue";
      },
    });

    const response = await fetchHandler(new Request("http://127.0.0.1:4820/api/commit-message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo,
        number,
        path: ".github/workflows/eas.yml",
        hunk: "@@ -64,1 +64,0 @@\n-      queue: max",
      }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "fix(ci): remove the deployment queue" });
    expect(received).toEqual({
      title: row.title,
      path: ".github/workflows/eas.yml",
      hunk: "@@ -64,1 +64,0 @@\n-      queue: max",
    });
  });
});

describe("PR diff head overrides", () => {
  const repo = "cockpit-test/head-only-diff";
  const number = 987654319;
  const baseSha = "b".repeat(40);
  const trackedHead = "c".repeat(40);
  const requestedHead = "d".repeat(40);
  const diffKey = `${baseSha}...${requestedHead}`;
  const patch = "diff --git a/src/value.ts b/src/value.ts\n";

  test("uses the cached three-dot diff for a requested head", async () => {
    db.query("DELETE FROM prs WHERE repo = ? AND number = ?").run(repo, number);
    db.query("DELETE FROM pr_detail_cache WHERE repo = ? AND number = ?").run(repo, number);
    db.query("DELETE FROM diffs WHERE head_sha = ?").run(diffKey);
    upsertCachedPrDetail({
      repo,
      number,
      head_sha: trackedHead,
      detail_json: JSON.stringify({ baseRefName: "main", baseRefOid: baseSha }),
      fetched_at: new Date().toISOString(),
    });
    saveDiff(diffKey, patch);

    try {
      const response = await buildFetchHandler(4820)(
        new Request(`http://127.0.0.1:4820/api/pr/cockpit-test/head-only-diff/${number}/diff?head=${requestedHead}`),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(patch);
    } finally {
      db.query("DELETE FROM pr_detail_cache WHERE repo = ? AND number = ?").run(repo, number);
      db.query("DELETE FROM diffs WHERE head_sha = ?").run(diffKey);
    }
  });

  test("rejects base-only and malformed head overrides", async () => {
    const fetchHandler = buildFetchHandler(4820);

    for (const query of [`?base=${baseSha}`, "?head=not-a-sha"]) {
      const response = await fetchHandler(
        new Request(`http://127.0.0.1:4820/api/pr/cockpit-test/head-only-diff/${number}/diff${query}`),
      );
      expect(response.status).toBe(400);
    }
  });
});

describe("recently closed PRs", () => {
  test("returns terminal PRs in event order and normalizes limits", async () => {
    const repo = "cockpit-test/recently-closed";
    const entries = Array.from({ length: 205 }, (_, number) => {
      const terminalAt = new Date(Date.UTC(2026, 7, 1, 0, 0, number)).toISOString();
      return {
        repo,
        number,
        title: `PR ${number}`,
        state: number % 2 === 0 ? "MERGED" : "CLOSED",
        isDraft: false,
        author: "theo",
        updatedAt: "2026-07-01T00:00:00.000Z",
        mergedAt: number % 2 === 0 ? terminalAt : null,
        closedAt: number % 2 === 0 ? null : terminalAt,
        involvesMe: true,
      };
    });
    upsertPrIndex(entries);
    const fetchHandler = buildFetchHandler(4820);

    try {
      const limitedResponse = await fetchHandler(new Request("http://127.0.0.1:4820/api/closed?limit=2"));
      const limited = await limitedResponse.json() as { prs: Array<Record<string, unknown>> };
      expect(limitedResponse.status).toBe(200);
      expect(limited.prs).toHaveLength(2);
      expect(limited.prs.map((pr) => pr.number)).toEqual([204, 203]);
      expect(limited.prs[0]).toEqual({
        repo,
        number: 204,
        title: "PR 204",
        author: "theo",
        state: "MERGED",
        isDraft: false,
        updatedAt: "2026-07-01T00:00:00.000Z",
        mergedAt: "2026-08-01T00:03:24.000Z",
        closedAt: null,
        terminalAt: "2026-08-01T00:03:24.000Z",
      });

      const cappedResponse = await fetchHandler(new Request("http://127.0.0.1:4820/api/closed?limit=999"));
      const capped = await cappedResponse.json() as { prs: unknown[] };
      expect(capped.prs).toHaveLength(200);

      const fallbackResponse = await fetchHandler(new Request("http://127.0.0.1:4820/api/closed?limit=nonsense"));
      const fallback = await fallbackResponse.json() as { prs: unknown[] };
      expect(fallback.prs).toHaveLength(100);

      const defaultResponse = await fetchHandler(new Request("http://127.0.0.1:4820/api/closed"));
      const defaults = await defaultResponse.json() as { prs: unknown[] };
      expect(defaults.prs).toHaveLength(100);
    } finally {
      db.query("DELETE FROM pr_index WHERE repo = ?").run(repo);
    }
  });
});

describe("merge method preference", () => {
  test("stores an explicit preference for the PR base branch", async () => {
    const repo = "cockpit-test/merge-method";
    const number = 987654323;
    upsertCachedPrDetail({
      repo,
      number,
      head_sha: "b".repeat(40),
      detail_json: JSON.stringify({ baseRefName: "production" }),
      fetched_at: new Date().toISOString(),
    });
    try {
      const response = await buildFetchHandler(4820)(
        new Request(`http://127.0.0.1:4820/api/pr/${repo}/${number}/merge-method`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ method: "merge" }),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ method: "merge", source: "explicit", baseRef: "production" });
      expect(
        db.query("SELECT method, source FROM merge_methods WHERE repo = ? AND base_ref = ?").get(repo, "production"),
      ).toEqual({ method: "merge", source: "explicit" });

      const invalid = await buildFetchHandler(4820)(
        new Request(`http://127.0.0.1:4820/api/pr/${repo}/${number}/merge-method`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ method: "octopus" }),
        }),
      );
      expect(invalid.status).toBe(400);
    } finally {
      db.query("DELETE FROM merge_methods WHERE repo = ?").run(repo);
      db.query("DELETE FROM pr_detail_cache WHERE repo = ? AND number = ?").run(repo, number);
    }
  });

  test("returns JSON when the PR base is unavailable", async () => {
    const response = await buildFetchHandler(4820)(
      new Request("http://127.0.0.1:4820/api/pr/cockpit-test/missing-base/987654324/merge-method", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "squash" }),
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Error: no base ref known for cockpit-test/missing-base#987654324 - cannot pick merge method",
    });
  });
});

describe("contextual editor target", () => {
  test("contains an existing PR file in the canonical checkout", async () => {
    const checkout = mkdtempSync(join(tmpdir(), "pr-cockpit-editor-target-"));
    const outside = mkdtempSync(join(tmpdir(), "pr-cockpit-editor-outside-"));
    mkdirSync(join(checkout, "src"));
    writeFileSync(join(checkout, "src", "current.ts"), "export {};\n");
    writeFileSync(join(outside, "secret.ts"), "secret\n");
    symlinkSync(join(outside, "secret.ts"), join(checkout, "src", "escape.ts"));
    try {
      const canonicalCheckout = realpathSync(checkout);
      expect(await checkoutTargetFor(checkout, "src/current.ts")).toEqual({
        path: canonicalCheckout,
        target: join(canonicalCheckout, "src", "current.ts"),
      });
      await expect(checkoutTargetFor(checkout, "../outside.ts")).rejects.toThrow("escapes the checkout");
      await expect(checkoutTargetFor(checkout, "src/escape.ts")).rejects.toThrow("symlink escapes");
      await expect(checkoutTargetFor(checkout, "src/deleted.ts")).rejects.toThrow("does not exist");
    } finally {
      rmSync(checkout, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
describe("Actions viewer API", () => {
  test("serves current and selected-commit workflow jobs with on-demand logs", async () => {
    const repo = "http-actions/viewer";
    const number = 96133;
    const head = "f".repeat(40);
    const previous = "e".repeat(40);
    const row = trackedPrRow({ repo, number, fetchedAt: "2026-08-25T08:00:00Z" });
    const detail = { ...JSON.parse(row.detail_json), headRefOid: head };
    detail.commitList.nodes.push({
      commit: { oid: previous, messageHeadline: "Previous commit", committedDate: "2026-08-25T07:00:00Z" },
    });
    upsertPr({
      ...row,
      head_sha: head,
      detail_json: JSON.stringify(detail),
    });
    upsertWorkflowRun({
      repo,
      run_id: 44,
      run_attempt: 1,
      pr_number: number,
      head_sha: head,
      head_branch: "actions-viewer",
      workflow_name: "CI",
      workflow_path: ".github/workflows/ci.yml",
      status: "completed",
      conclusion: "failure",
      event_at: "2026-08-25T08:02:00Z",
      html_url: "https://github.com/http-actions/viewer/actions/runs/44",
    });
    upsertRunJob({
      repo,
      job_id: 4401,
      run_id: 44,
      run_attempt: 1,
      head_sha: head,
      head_branch: "actions-viewer",
      workflow_name: "CI",
      name: "build",
      status: "completed",
      conclusion: "failure",
      started_at: "2026-08-25T08:00:00Z",
      completed_at: "2026-08-25T08:02:00Z",
      html_url: "https://github.com/http-actions/viewer/actions/runs/44/job/4401",
      runner_name: "runner-3",
      runner_group_name: "hosted",
      labels_json: "[\"arm64\"]",
      failed_step: "Compile",
    });
    upsertWorkflowRun({
      repo,
      run_id: 43,
      run_attempt: 1,
      pr_number: number,
      head_sha: previous,
      head_branch: "actions-viewer",
      workflow_name: "CI",
      workflow_path: ".github/workflows/ci.yml",
      status: "completed",
      conclusion: "success",
      event_at: "2026-08-25T07:02:00Z",
      html_url: "https://github.com/http-actions/viewer/actions/runs/43",
    });
    upsertRunJob({
      repo,
      job_id: 4301,
      run_id: 43,
      run_attempt: 1,
      head_sha: previous,
      head_branch: "actions-viewer",
      workflow_name: "CI",
      name: "build previous",
      status: "completed",
      conclusion: "success",
      started_at: "2026-08-25T07:00:00Z",
      completed_at: "2026-08-25T07:02:00Z",
      html_url: "https://github.com/http-actions/viewer/actions/runs/43/job/4301",
      runner_name: "runner-2",
      runner_group_name: "hosted",
      labels_json: "[\"arm64\"]",
      failed_step: null,
    });
    let activations = 0;
    const fetchHandler = buildFetchHandler(4820, {
      activateActionsLease: () => {
        activations++;
        return Promise.withResolvers<void>().promise;
      },
      actionJobLog: async (_repo, _headSha, jobId) => ({
        job: listRunJobs(repo, head).find((job) => job.job_id === jobId)!,
        body: "complete log",
        state: "ready",
      }),
    });

    try {
      const actionsResponse = await Promise.race([
        fetchHandler(new Request(`http://127.0.0.1:4820/api/pr/http-actions/viewer/${number}/actions`)),
        Bun.sleep(50).then(() => {
          throw new Error("Actions response waited for cache repair");
        }),
      ]);
      expect(actionsResponse.status).toBe(200);
      expect(await actionsResponse.json()).toEqual({
        headSha: head,
        runs: [{
          id: 44,
          attempt: 1,
          workflowName: "CI",
          workflowPath: ".github/workflows/ci.yml",
          status: "completed",
          conclusion: "failure",
          eventAt: "2026-08-25T08:02:00Z",
          htmlUrl: "https://github.com/http-actions/viewer/actions/runs/44",
        }],
        jobs: [{
          id: 4401,
          runId: 44,
          attempt: 1,
          workflowName: "CI",
          name: "build",
          status: "completed",
          conclusion: "failure",
          startedAt: "2026-08-25T08:00:00Z",
          completedAt: "2026-08-25T08:02:00Z",
          htmlUrl: "https://github.com/http-actions/viewer/actions/runs/44/job/4401",
          runnerName: "runner-3",
          runnerGroupName: "hosted",
          labels: ["arm64"],
          failedStep: "Compile",
          steps: [],
          logBytes: null,
          logError: null,
        }],
      });
      expect(activations).toBe(1);

      const logResponse = await fetchHandler(new Request(`http://127.0.0.1:4820/api/pr/http-actions/viewer/${number}/actions/jobs/4401/log`));
      expect(logResponse.status).toBe(200);
      expect(await logResponse.json()).toMatchObject({ body: "complete log", state: "ready", job: { id: 4401, name: "build" } });
      const historicalLoads: string[] = [];
      let logHead = "";
      const historicalHandler = buildFetchHandler(4820, {
        cacheGithubActionsForCommit: async (_repo, _number, sha) => {
          historicalLoads.push(sha);
        },
        actionJobLog: async (_repo, sha, jobId) => {
          logHead = sha;
          return {
            job: listRunJobs(repo, previous).find((job) => job.job_id === jobId)!,
            body: "previous log",
            state: "ready",
          };
        },
      });
      const historicalResponse = await historicalHandler(new Request(
        `http://127.0.0.1:4820/api/pr/http-actions/viewer/${number}/actions?sha=${previous}`,
      ));
      expect(historicalResponse.status).toBe(200);
      expect(await historicalResponse.json()).toMatchObject({
        headSha: previous,
        runs: [{ id: 43, conclusion: "success" }],
        jobs: [{ id: 4301, name: "build previous", conclusion: "success" }],
      });
      expect(historicalLoads).toEqual([previous]);

      const historicalLog = await historicalHandler(new Request(
        `http://127.0.0.1:4820/api/pr/http-actions/viewer/${number}/actions/jobs/4301/log?sha=${previous}`,
      ));
      expect(historicalLog.status).toBe(200);
      expect(await historicalLog.json()).toMatchObject({ body: "previous log", job: { id: 4301 } });
      expect(logHead).toBe(previous);


      let finishActivation = () => {};
      const activation = new Promise<void>((resolve) => {
        finishActivation = resolve;
      });
      const graphHandler = buildFetchHandler(4820, {
        activateActionsLease: () => activation,
        actionWorkflowGraphs: async () => {
          finishActivation();
          return [{
            path: ".github/workflows/ci.yml",
            name: "CI",
            jobs: [
              { id: "build", name: "Build", needs: [], uses: null },
              { id: "test", name: "Test", needs: ["build"], uses: null },
            ],
          }];
        },
      });
      const graphResponse = await graphHandler(new Request(`http://127.0.0.1:4820/api/pr/http-actions/viewer/${number}/actions/graph`));
      expect(graphResponse.status).toBe(200);
      expect(await graphResponse.json()).toEqual({
        headSha: head,
        workflows: [{
          path: ".github/workflows/ci.yml",
          name: "CI",
          jobs: [
            { id: "build", name: "Build", needs: [], uses: null },
            { id: "test", name: "Test", needs: ["build"], uses: null },
          ],
        }],
      });
    } finally {
      db.run("DELETE FROM run_jobs WHERE repo = ?", [repo]);
      db.run("DELETE FROM workflow_runs WHERE repo = ?", [repo]);
      db.run("DELETE FROM prs WHERE repo = ? AND number = ?", [repo, number]);
    }
  });

  test("trusted agent route requests one current-head Actions run", async () => {
    const repo = "http-actions/requested";
    const number = 96134;
    const head = "e".repeat(40);
    const row = trackedPrRow({ repo, number, fetchedAt: "2026-08-25T08:00:00Z" });
    upsertPr({
      ...row,
      head_sha: head,
      detail_json: JSON.stringify({ ...JSON.parse(row.detail_json), headRefOid: head }),
    });
    let requested: unknown = null;
    const fetchHandler = buildFetchHandler(4820, {
      cacheActionsRun: async (...args) => {
        requested = args;
        return "fetched";
      },
    });

    try {
      const response = await fetchHandler(new Request(
        `http://127.0.0.1:4820/api/agent/pr/http-actions/requested/${number}/runs/987/cache`,
        { method: "POST", headers: { "X-PR-Cockpit-CLI": "1" } },
      ));
      expect(response.status).toBe(200);
      expect(requested).toEqual([repo, number, head, "feature", 987]);
      expect(await response.text()).toContain("Actions run 987: fetched");
    } finally {
      db.run("DELETE FROM prs WHERE repo = ? AND number = ?", [repo, number]);
    }
  });


  test("trusted jobs route returns recent branch runs across SHAs and filters one latest attempt", async () => {
    const repo = "http-actions/branch-jobs";
    const number = 96135;
    const head = "a".repeat(40);
    const row = trackedPrRow({ repo, number, fetchedAt: new Date().toISOString() });
    upsertPr({ ...row, head_sha: head });
    const now = new Date().toISOString();
    const runs = [
      { id: 70, attempt: 1, owner: number, sha: "b".repeat(40), branch: "feature", status: "completed" },
      { id: 71, attempt: 1, owner: null, sha: head, branch: "feature", status: "completed" },
      { id: 72, attempt: 1, owner: number, sha: head, branch: "other", status: "completed" },
      { id: 73, attempt: 1, owner: number + 1, sha: head, branch: "feature", status: "completed" },
      { id: 74, attempt: 1, owner: number, sha: head, branch: "feature", status: "completed" },
      { id: 74, attempt: 2, owner: number, sha: head, branch: "feature", status: "in_progress" },
      { id: 75, attempt: 1, owner: number, sha: "c".repeat(40), branch: "feature", status: "completed" },
    ];
    for (const run of runs) {
      upsertWorkflowRun({
        repo,
        run_id: run.id,
        run_attempt: run.attempt,
        pr_number: run.owner,
        head_sha: run.sha,
        head_branch: run.branch,
        workflow_name: "Dispatch",
        event: run.id === 70 ? "workflow_dispatch" : "push",
        workflow_path: ".github/workflows/dispatch.yml",
        status: run.status,
        conclusion: run.status === "completed" ? "success" : null,
        event_at: now,
        html_url: null,
      });
      upsertRunJob({
        repo,
        job_id: run.id * 10 + run.attempt,
        run_id: run.id,
        run_attempt: run.attempt,
        head_sha: run.sha,
        head_branch: run.branch,
        workflow_name: "Dispatch",
        name: `job-${run.id}-${run.attempt}`,
        status: run.status,
        conclusion: run.status === "completed" ? "success" : null,
        started_at: now,
        completed_at: run.status === "completed" ? now : null,
        html_url: null,
        runner_name: null,
        runner_group_name: null,
        labels_json: "[]",
        failed_step: null,
      });
    }
    db.query("UPDATE workflow_runs SET fetched_at = datetime('now', '-73 hours') WHERE repo = ? AND run_id = ?")
      .run(repo, 75);
    db.run("UPDATE workflow_runs SET reconciled_at = ? WHERE repo = ? AND run_id = ?", [now, repo, 70]);
    const fetchHandler = buildFetchHandler(4820);

    try {
      const all = await fetchHandler(new Request(
        `http://127.0.0.1:4820/api/agent/pr/http-actions/branch-jobs/${number}/jobs?format=json`,
      ));
      expect(all.status).toBe(200);
      expect(await all.json()).toMatchObject({
        runs: [
          { id: 74, attempt: 2, event: "push" },
          { id: 71, attempt: 1, event: "push", reconciled: false },
          { id: 70, attempt: 1, event: "workflow_dispatch", reconciled: true },
        ],
        jobs: [{ id: 701 }, { id: 711 }, { id: 742 }],
      });

      const exact = await fetchHandler(new Request(
        `http://127.0.0.1:4820/api/agent/pr/http-actions/branch-jobs/${number}/jobs?format=json&runId=74`,
      ));
      expect(exact.status).toBe(200);
      expect(await exact.json()).toMatchObject({
        runs: [{ id: 74, attempt: 2 }],
        selectedRun: { id: 74, attempt: 2, status: "in_progress", reconciled: false },
        jobs: [{ id: 742 }],
      });

      const rejected = await fetchHandler(new Request(
        `http://127.0.0.1:4820/api/agent/pr/http-actions/branch-jobs/${number}/jobs?format=json&runId=72`,
      ));
      const stale = await fetchHandler(new Request(
        `http://127.0.0.1:4820/api/agent/pr/http-actions/branch-jobs/${number}/jobs?format=json&runId=75`,
      ));
      expect(stale.status).toBe(404);
      expect(rejected.status).toBe(404);
      expect(await rejected.json()).toEqual({ error: "Actions run does not belong to this PR branch" });
    } finally {
      db.run("DELETE FROM run_jobs WHERE repo = ?", [repo]);
      db.run("DELETE FROM workflow_runs WHERE repo = ?", [repo]);
      db.run("DELETE FROM prs WHERE repo = ? AND number = ?", [repo, number]);
    }
  });
});
