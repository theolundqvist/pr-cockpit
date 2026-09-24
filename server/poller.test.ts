import { beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backgroundQuotaAvailable, createPollOnce, nextPollDelayMs, type PollDeps } from "./poller.ts";
import { GithubRequestError, type PrDetailScope, type SearchHit } from "./github.ts";
import type { GithubUsageSource } from "./githubUsage.ts";
import type { PrRow, WebhookRegistrationRow } from "./db.ts";

let registrations: WebhookRegistrationRow[] = [];
let searchHits: SearchHit[] = [];
let registrationStatuses = new Map<string, { state: string } | null>();
let statusLookupError: Error | null = null;
let searchedRepos: string[][] = [];

const refreshPr = mock(async (
  _repo: string,
  _number: number,
  _source?: GithubUsageSource,
  _scope?: PrDetailScope,
) => {});
const invalidateInbox = mock(() => {});
const publishPollCompleted = mock((_lastPollAt: string) => {});

const deps: PollDeps = {
  backgroundPollAllowed: async () => true,
  refreshWorktreeScan: async () => {},
  trackedRepos: async () => ["acme/tracked"],
  listWebhookRegistrations: () => [...registrations],
  searchOpenPrs: async (repos) => {
    searchedRepos.push(repos);
    return searchHits;
  },
  searchRecentPrs: async () => [],
  searchClosedPrs: async () => ({ items: [], failures: [] }),
  getPr: () => null,
  refreshPr,
  lookupPr: async (repo, number) => {
    if (statusLookupError) throw statusLookupError;
    return registrationStatuses.get(`${repo}#${number}`) ?? null;
  },
  deleteWebhookRegistrationsForPr: (repo, number) => {
    const before = registrations.length;
    registrations = registrations.filter((r) => r.repo !== repo || r.number !== number);
    return before - registrations.length;
  },
  reconcileForwarders: () => {},
  evictStalePrs: () => {},
  evictReposNotIn: () => {},
  pruneMirrors: async () => {},
  upsertPrIndex: () => {},
  invalidateInbox,
  publishPollCompleted,
};

test("paces background GraphQL work across the quota window", () => {
  const resetAt = "2026-08-27T11:00:00.000Z";
  const now = Date.parse("2026-08-27T10:30:00.000Z");

  expect(backgroundQuotaAvailable({ limit: 5000, used: 2000, remaining: 3000, resetAt }, now)).toBe(true);
  expect(backgroundQuotaAvailable({ limit: 5000, used: 2500, remaining: 2500, resetAt }, now)).toBe(false);
  expect(backgroundQuotaAvailable({ limit: 5000, used: 4990, remaining: 10, resetAt }, now)).toBe(false);
});

test("allows the first refresh when GitHub reports a full unused window", () => {
  const now = Date.parse("2026-09-01T08:55:16.000Z");
  const resetAt = "2026-09-01T09:55:16.000Z";
  expect(backgroundQuotaAvailable({ limit: 5000, used: 0, remaining: 5000, resetAt }, now)).toBe(true);
});

test("a poll that could not reach GitHub retries on a short backoff capped at the interval", () => {
  expect(nextPollDelayMs(0, 180_000)).toBe(180_000);
  expect([1, 2, 3, 4, 5, 6, 7].map((failures) => nextPollDelayMs(failures, 180_000)))
    .toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 180_000]);
  expect(nextPollDelayMs(3, 15_000)).toBe(15_000);
});

function registration(repo: string, number: number): WebhookRegistrationRow {
  return { window_id: "@1", repo, number, last_webhook_at: null };
}

function hit(repo: string, number: number): SearchHit {
  return { repo, number, title: "t", updatedAt: "2026-07-25T00:00:00Z", headRefOid: "abc", ciState: "SUCCESS" };
}

function registeredKeys(): string[] {
  return registrations.map((r) => `${r.repo}#${r.number}`).sort();
}

describe("poll-loop registration lifecycle", () => {
  beforeEach(() => {
    registrations = [];
    searchHits = [];
    registrationStatuses = new Map();
    statusLookupError = null;
    searchedRepos = [];
    refreshPr.mockClear();
    invalidateInbox.mockClear();
    publishPollCompleted.mockClear();
  });

  test("refreshes and prunes local caches before skipping GitHub work when the quota gate is closed", async () => {
    let worktreesRefreshed = false;
    const evicted: string[][] = [];
    const pruned: string[][] = [];
    const result = await createPollOnce({
      ...deps,
      backgroundPollAllowed: async () => false,
      refreshWorktreeScan: async () => {
        worktreesRefreshed = true;
      },
      evictReposNotIn: (repos) => {
        evicted.push(repos);
      },
      pruneMirrors: async (repos) => {
        pruned.push(repos);
      },
    })();
    expect(result).toEqual({ checked: 0, refreshed: 0 });
    expect(worktreesRefreshed).toBe(true);
    expect(evicted).toEqual([["acme/tracked"]]);
    expect(pruned).toEqual([["acme/tracked"]]);
    expect(searchedRepos).toEqual([]);
  });

  test("prunes all local caches before returning for an empty repository scope", async () => {
    const evicted: string[][] = [];
    const pruned: string[][] = [];
    const result = await createPollOnce({
      ...deps,
      trackedRepos: async () => [],
      evictReposNotIn: (repos) => {
        evicted.push(repos);
      },
      pruneMirrors: async (repos) => {
        pruned.push(repos);
      },
    })();
    expect(result).toEqual({ checked: 0, refreshed: 0 });
    expect(evicted).toEqual([[]]);
    expect(pruned).toEqual([[]]);
    expect(searchedRepos).toEqual([]);
  });

  test("a refresh after repository edits waits for the new scope and shares its poll", async () => {
    let selected = ["acme/old"];
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let searches = 0;
    const poll = createPollOnce({
      ...deps,
      trackedRepos: async () => [...selected],
      searchOpenPrs: async (repos) => {
        searches++;
        if (repos.includes("acme/old")) {
          started.resolve();
          await release.promise;
          return [hit("acme/old", 1)];
        }
        return [hit("acme/new", 2), hit("acme/new", 3)];
      },
    });
    const oldPoll = poll();
    await started.promise;
    selected = ["acme/new"];
    const firstRefresh = poll();
    const secondRefresh = poll();
    release.resolve();
    expect(await oldPoll).toEqual({ checked: 1, refreshed: 1 });
    expect(await firstRefresh).toEqual({ checked: 2, refreshed: 2 });
    expect(await secondRefresh).toEqual({ checked: 2, refreshed: 2 });
    expect(searches).toBe(2);
  });

  test("callers arriving mid-poll share one trailing poll that searches after them", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let searches = 0;
    let hitsNow = [hit("acme/tracked", 1)];
    const poll = createPollOnce({
      ...deps,
      searchOpenPrs: async () => {
        searches++;
        if (searches === 1) {
          const snapshot = hitsNow;
          started.resolve();
          await release.promise;
          return snapshot;
        }
        return hitsNow;
      },
    });
    const running = poll();
    await started.promise;
    hitsNow = [hit("acme/tracked", 1), hit("acme/tracked", 2)];
    const first = poll();
    const second = poll();
    release.resolve();
    expect(await running).toEqual({ checked: 1, refreshed: 1 });
    expect(await first).toEqual({ checked: 2, refreshed: 2 });
    expect(await second).toEqual({ checked: 2, refreshed: 2 });
    expect(searches).toBe(2);
  });

  test("registered repo joins the search scope even when untracked", async () => {
    registrations = [registration("ext/repo", 5)];
    registrationStatuses.set("ext/repo#5", { state: "OPEN" });
    await createPollOnce(deps)();
    expect(searchedRepos[0]).toEqual(["acme/tracked", "ext/repo"]);
  });

  test("registration present in search hits refreshes without a direct status lookup", async () => {
    registrations = [registration("ext/repo", 5)];
    searchHits = [hit("ext/repo", 5)];
    statusLookupError = new Error("lookupPr must not run for open hits");
    await createPollOnce(deps)();
    expect(refreshPr.mock.calls).toContainEqual(["ext/repo", 5, "background poll"]);
    expect(registeredKeys()).toEqual(["ext/repo#5"]);
  });

  test("a poll confirming the searched fields spends no detail fetch", async () => {
    searchHits = [hit("acme/tracked", 5)];
    const row = {
      head_sha: "abc",
      updated_at: "2026-07-25T00:00:00Z",
      ci_status: "SUCCESS",
      fetched_at: "2026-07-20T00:00:00Z",
    } as PrRow;
    await createPollOnce({ ...deps, getPr: () => row })();
    expect(refreshPr).not.toHaveBeenCalled();
  });

  test("untracked unregistered hit is ignored", async () => {
    searchHits = [hit("ext/other", 9)];
    await createPollOnce(deps)();
    expect(refreshPr).not.toHaveBeenCalled();
  });

  test("registration absent from hits but OPEN is kept and refreshed", async () => {
    registrations = [registration("ext/repo", 5)];
    registrationStatuses.set("ext/repo#5", { state: "OPEN" });
    await createPollOnce(deps)();
    expect(registeredKeys()).toEqual(["ext/repo#5"]);
    expect(refreshPr.mock.calls).toContainEqual(["ext/repo", 5, "background poll"]);
  });

  test("registration absent from hits and MERGED is dropped", async () => {
    registrations = [registration("ext/repo", 5)];
    registrationStatuses.set("ext/repo#5", { state: "MERGED" });
    await createPollOnce(deps)();
    expect(registeredKeys()).toEqual([]);
    expect(refreshPr).not.toHaveBeenCalled();
    expect(invalidateInbox).toHaveBeenCalledTimes(1);
  });

  test("registration whose PR lookup finds nothing is dropped", async () => {
    registrations = [registration("ext/repo", 5)];
    await createPollOnce(deps)();
    expect(registeredKeys()).toEqual([]);
  });

  test("status lookup failure keeps the registration", async () => {
    registrations = [registration("ext/repo", 5)];
    statusLookupError = new Error("github down");
    await createPollOnce(deps)();
    expect(registeredKeys()).toEqual(["ext/repo#5"]);
  });
});

test("closed-PR sweeps after the first only ask for PRs updated since the last complete sweep", async () => {
  const bounds: Array<string | null> = [];
  let failNext = false;
  const poll = createPollOnce({
    ...deps,
    searchClosedPrs: async (repos, updatedSince = null) => {
      bounds.push(updatedSince);
      if (!failNext) return { items: [], failures: [] };
      failNext = false;
      return { items: [], failures: [{ repo: repos[0]!, error: new GithubRequestError("search down", 503) }] };
    },
  });
  const error = console.error;
  console.error = () => {};
  try {
    setSystemTime(new Date("2026-09-24T08:00:00.000Z"));
    await poll();
    setSystemTime(new Date("2026-09-24T08:31:00.000Z"));
    failNext = true;
    await poll();
    setSystemTime(new Date("2026-09-24T09:02:00.000Z"));
    await poll();
  } finally {
    setSystemTime();
    console.error = error;
  }
  expect(bounds).toEqual([null, "2026-09-24T07:45:00.000Z", "2026-09-24T07:45:00.000Z"]);
});

test("a poll completes without waiting for the repo-wide Actions listing, and never stacks two", async () => {
  const order: string[] = [];
  let releaseActions!: () => void;
  const actionsGate = new Promise<void>((resolve) => { releaseActions = resolve; });
  let listings = 0;
  let inFlight = 0;
  let peak = 0;
  const poll = createPollOnce({
    ...deps,
    listWebhookRegistrations: () => [],
    refreshRecentActions: async () => {
      listings++;
      await actionsGate;
      order.push("actions");
      return 0;
    },
    searchOpenPrs: async () => [1, 2, 3, 4, 5].map((number) => hit("acme/tracked", number)),
    refreshPr: async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(5);
      inFlight--;
      order.push("refresh");
    },
    publishPollCompleted: () => { order.push("complete"); },
  });
  expect(await poll()).toEqual({ checked: 5, refreshed: 5 });
  expect(order).toEqual(["refresh", "refresh", "refresh", "refresh", "refresh", "complete"]);
  expect(peak).toBe(3);

  await poll();
  expect(listings).toBe(1);
  releaseActions();
  while (!order.includes("actions")) await Bun.sleep(1);
  await Bun.sleep(1);
  await poll();
  expect(listings).toBe(2);
});

test("a PR refresh publishes checks and status before the Actions catalog lands", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-refresh-order-"));
  const url = (file: string) => JSON.stringify(new URL(file, import.meta.url).href);
  const scenario = `
    import { mock } from "bun:test";
    const head = "a".repeat(40);
    const detail = {
      title: "t", body: "", url: "https://github.com/acme/app/pull/7", state: "OPEN", isDraft: false,
      author: { login: "theo" }, baseRefName: "main", headRefName: "feature", headRefOid: head,
      updatedAt: "2026-09-24T08:00:00Z", additions: 1, deletions: 0, changedFiles: 1,
      commitCount: { totalCount: 1 }, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
      reviewDecision: null, viewerIsAuthor: true, viewerReviewRequested: false, viewerReviewState: null,
      reviews: { nodes: [] }, comments: { nodes: [] }, reviewThreads: { nodes: [] },
      lastCommit: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [] } } } }] },
    };
    const events = [];
    const github = await import(${url("./github.ts")});
    mock.module(${url("./github.ts")}, () => ({ ...github, fetchPrDetail: async () => detail }));
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const runLogs = await import(${url("./runLogs.ts")});
    mock.module(${url("./runLogs.ts")}, () => ({
      ...runLogs,
      cacheGithubActionsForCommit: async () => { events.push("catalog:start"); await gate; events.push("catalog:end"); },
    }));
    const dbm = await import(${url("./db.ts")});
    dbm.upsertPr({
      repo: "acme/app", number: 7, state: "OPEN", is_draft: 0, title: "old", author: "theo",
      base_ref: "main", head_ref: "feature", head_sha: head, updated_at: "2026-09-24T07:00:00Z",
      additions: 1, deletions: 0, changed_files: 1, commit_count: 1, mergeable: "MERGEABLE",
      merge_state_status: "CLEAN", auto_merge_enabled: 0, viewer_is_author: 1, viewer_review_requested: 0,
      viewer_review_state: null, ci_status: "PENDING", review_decision: null, unresolved_count: 0,
      needs_me_rank: 0, greptile_confidence: null, greptile_reviewed_sha: null, greptile_unresolved_count: 0,
      detail_json: JSON.stringify(detail), fetched_at: "2026-09-24T07:00:00Z",
    });
    const invalidation = await import(${url("./rendererInvalidation.ts")});
    invalidation.setRendererInvalidationPublisher((event) => {
      if (event.type === "pr") events.push("pr:" + dbm.getPr("acme/app", 7).title);
    });
    const { refreshPr } = await import(${url("./poller.ts")});
    let settled = false;
    const refresh = refreshPr("acme/app", 7, "relay", "all").then(() => { settled = true; });
    while (!events.includes("catalog:start")) await Bun.sleep(1);
    const beforeCatalog = { events: [...events], settled };
    release();
    await refresh;
    console.log(JSON.stringify({ beforeCatalog, events }));
    process.exit(0);
  `;
  try {
    const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", scenario], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(result.beforeCatalog).toEqual({ events: ["pr:t", "catalog:start"], settled: false });
    expect(result.events).toEqual(["pr:t", "catalog:start", "catalog:end", "pr:t"]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
