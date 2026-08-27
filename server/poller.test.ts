import { beforeEach, describe, expect, mock, test } from "bun:test";
import { backgroundQuotaAvailable, createPollOnce, type PollDeps } from "./poller.ts";
import type { SearchHit } from "./github.ts";
import type { PrRow, WebhookRegistrationRow } from "./db.ts";

let registrations: WebhookRegistrationRow[] = [];
let searchHits: SearchHit[] = [];
let registrationStatuses = new Map<string, { state: string } | null>();
let statusLookupError: Error | null = null;
let searchedRepos: string[][] = [];

const refreshPr = mock(async (_repo: string, _number: number) => {});
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
  searchClosedPrs: async () => [],
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
  pruneMirrors: () => {},
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

  test("refreshes local worktrees before skipping GitHub work when the quota gate is closed", async () => {
    let worktreesRefreshed = false;
    const result = await createPollOnce({
      ...deps,
      backgroundPollAllowed: async () => false,
      refreshWorktreeScan: async () => {
        worktreesRefreshed = true;
      },
    })();
    expect(result).toEqual({ checked: 0, refreshed: 0 });
    expect(worktreesRefreshed).toBe(true);
    expect(searchedRepos).toEqual([]);
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
