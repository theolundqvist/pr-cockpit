import { fetchGithubQuota, fetchPrDetail, fetchPrDetailPart, lookupPr, searchClosedPrs, searchOpenPrs, searchRecentPrs, type GithubQuotaResource, type PrDetail, type PrDetailScope } from "./github.ts";
import type { GithubUsageSource } from "./githubUsage.ts";
import {
  deleteWebhookRegistrationsForPr,
  evictReposNotIn,
  evictStalePrs,
  getPr,
  listWebhookRegistrations,
  setAutoMergeArmed,
  upsertPr,
  upsertPrIndex,
  type PrRow,
  type WebhookRegistrationRow,
} from "./db.ts";
import { reconcileForwarders } from "./forwarders.ts";
import { prKeyOf } from "./prKey.ts";
import { extractGithubImageUrls, prefetchImages } from "./imageproxy.ts";
import { fetchMirror, pruneMirrors } from "./mirror.ts";
import { needsMeRank } from "./rank.ts";
import { refreshRepoUsers } from "./repoUsers.ts";
import { createPrRefreshScheduler } from "./refreshScheduler.ts";
import { pollIntervalMs, settingsRepos } from "./settings.ts";
import { discoveredRepos, refreshWorktreeScan } from "./worktreeScan.ts";
import { onPrActivity } from "./activity.ts";
import { scoreReviewers } from "./reviewScore.ts";
import { invalidateInbox, invalidatePr, publishPollCompleted } from "./rendererInvalidation.ts";
import { refreshRecentActions } from "./runLogs.ts";
import { GRAPHQL_BACKGROUND_RESERVE } from "../ui/src/lib/quotaImpact.js";

const INDEX_SWEEP_MS = 1_800_000;
const GRAPHQL_WINDOW_MS = 60 * 60_000;

export let lastPollAt: string | null = null;

export function setLastPollAt(value: string | null): void {
  lastPollAt = value;
}

let quotaPauseResetAt: string | null = null;
let openInboxKeys = new Set<string>();

export function backgroundQuotaAvailable(quota: GithubQuotaResource, now = Date.now()): boolean {
  if (quota.remaining >= quota.limit) return true;
  const resetIn = Math.max(0, Date.parse(quota.resetAt) - now);
  const pacedReserve = Math.ceil(quota.limit * Math.min(resetIn, GRAPHQL_WINDOW_MS) / GRAPHQL_WINDOW_MS);
  return quota.remaining > Math.max(GRAPHQL_BACKGROUND_RESERVE, pacedReserve);
}

export async function backgroundPollAllowed(): Promise<boolean> {
  const quota = await fetchGithubQuota();
  if (backgroundQuotaAvailable(quota.graphql)) {
    quotaPauseResetAt = null;
    return true;
  }
  if (quotaPauseResetAt !== quota.graphql.resetAt) {
    quotaPauseResetAt = quota.graphql.resetAt;
    console.warn(`background GitHub refreshes paused with ${quota.graphql.remaining} GraphQL points left; resets ${quota.graphql.resetAt}`);
  }
  return false;
}

export async function trackedRepos(): Promise<string[]> {
  const repos = new Set(settingsRepos());
  for (const r of await discoveredRepos()) repos.add(r);
  return [...repos];
}

function checkRollupStatus(detail: PrDetail): string {
  return detail.lastCommit.nodes[0]?.commit.statusCheckRollup?.state ?? "NONE";
}

// outdated counts as handled - the code the thread commented on is gone
function countUnresolved(detail: PrDetail): number {
  return detail.reviewThreads.nodes.filter((t) => !t.isResolved && !t.isOutdated).length;
}

const GREPTILE_LOGIN = "greptile-apps";
const GREPTILE_CONFIDENCE_RE = /Confidence Score:\s*(\d)\/5/i;
// greptile embeds the commit its summary was written against as a link in the same comment
const GREPTILE_REVIEWED_COMMIT_RE = /Last reviewed commit:.*?\/commit\/([0-9a-f]{40})/is;

type GreptileComments = { comments: { nodes: Array<{ author: { login: string } | null; body: string }> } };
type GreptileThreads = { reviewThreads: { nodes: Array<{ isResolved: boolean; isOutdated: boolean; comments: { nodes: Array<{ author: { login: string } | null }> } }> } };

export function lastGreptileComment(detail: GreptileComments): string | null {
  const scored = detail.comments.nodes.filter((c) => c.author?.login === GREPTILE_LOGIN && GREPTILE_CONFIDENCE_RE.test(c.body));
  return scored[scored.length - 1]?.body ?? null;
}

export function greptileConfidence(detail: GreptileComments): number | null {
  const body = lastGreptileComment(detail);
  const match = body?.match(GREPTILE_CONFIDENCE_RE);
  return match ? Number(match[1]) : null;
}

export function greptileReviewedSha(detail: GreptileComments): string | null {
  const body = lastGreptileComment(detail);
  return body?.match(GREPTILE_REVIEWED_COMMIT_RE)?.[1] ?? null;
}

export function greptileUnresolvedCount(detail: GreptileThreads): number {
  return detail.reviewThreads.nodes.filter((t) => !t.isResolved && !t.isOutdated && t.comments.nodes[0]?.author?.login === GREPTILE_LOGIN).length;
}

function prefetchDetailImages(detail: PrDetail): void {
  const bodies = [detail.body];
  for (const review of detail.reviews.nodes) bodies.push(review.body);
  for (const comment of detail.comments.nodes) bodies.push(comment.body);
  for (const thread of detail.reviewThreads.nodes) for (const comment of thread.comments.nodes) bodies.push(comment.body);
  const urls = [...new Set(bodies.flatMap(extractGithubImageUrls))];
  if (urls.length === 0) return;
  prefetchImages(urls).catch((err) => console.error(`image prefetch failed for ${detail.url}:`, err));
}

async function refreshPrNow(
  repo: string,
  number: number,
  source: GithubUsageSource = "app detail",
  scope: PrDetailScope = "all",
): Promise<void> {
  const previous = getPr(repo, number);
  const snapshotCutoffAt = new Date().toISOString();
  const current = previous ? JSON.parse(previous.detail_json) as PrDetail : null;
  const detail = scope === "all" || current === null
    ? await fetchPrDetail(repo, number, source)
    : await fetchPrDetailPart(repo, number, current, scope, source);
  if (!previous || previous.head_sha !== detail.headRefOid) {
    fetchMirror(repo).catch((err) => console.error(`mirror fetch failed for ${repo}:`, err));
    onPrActivity(repo, number, previous !== null);
  }
  scoreReviewers(repo, number, detail);
  const ciStatus = checkRollupStatus(detail);
  const unresolvedCount = countUnresolved(detail);
  const rank = needsMeRank({
    ciStatus,
    reviewDecision: detail.reviewDecision,
    unresolvedCount,
    mergeable: detail.mergeable,
    isDraft: detail.isDraft,
  });

  upsertPr({
    repo,
    number,
    state: detail.isDraft ? "draft" : detail.state,
    is_draft: detail.isDraft ? 1 : 0,
    title: detail.title,
    author: detail.author?.login ?? "unknown",
    base_ref: detail.baseRefName,
    head_ref: detail.headRefName,
    head_sha: detail.headRefOid,
    updated_at: detail.updatedAt,
    additions: detail.additions,
    deletions: detail.deletions,
    changed_files: detail.changedFiles,
    commit_count: detail.commitCount.totalCount,
    mergeable: detail.mergeable,
    merge_state_status: detail.mergeStateStatus,
    // insert-only column (see db.ts's upsertStmt) - only matters the first time a PR is seen, never armed yet
    auto_merge_enabled: 0,
    viewer_is_author: detail.viewerIsAuthor ? 1 : 0,
    viewer_review_requested: detail.viewerReviewRequested ? 1 : 0,
    viewer_review_state: detail.viewerReviewState,
    ci_status: ciStatus,
    review_decision: detail.reviewDecision,
    unresolved_count: unresolvedCount,
    needs_me_rank: rank,
    greptile_confidence: greptileConfidence(detail),
    greptile_reviewed_sha: greptileReviewedSha(detail),
    greptile_unresolved_count: greptileUnresolvedCount(detail),
    detail_json: JSON.stringify(detail),
    fetched_at: snapshotCutoffAt,
  });

  upsertPrIndex([{
    repo,
    number,
    title: detail.title,
    state: detail.state,
    isDraft: detail.isDraft,
    author: detail.author?.login ?? "unknown",
    mergedAt: detail.mergedAt,
    closedAt: detail.closedAt,
    involvesMe: openInboxKeys.has(prKeyOf(repo, number)),
    updatedAt: detail.updatedAt,
  }]);

  prefetchDetailImages(detail);

  // keyed on the freshly observed state, not the pre-await `previous` snapshot - closed prs can't be re-armed
  if (detail.state === "MERGED" || detail.state === "CLOSED") setAutoMergeArmed(repo, number, false);
  invalidatePr(repo, number);
  invalidateInbox();
}

export const refreshPr = createPrRefreshScheduler(refreshPrNow);

export interface PollDeps {
  backgroundPollAllowed: typeof backgroundPollAllowed;
  refreshWorktreeScan: typeof refreshWorktreeScan;
  settingsRepos: typeof settingsRepos;
  trackedRepos: typeof trackedRepos;
  listWebhookRegistrations: typeof listWebhookRegistrations;
  refreshRecentActions?: typeof refreshRecentActions;
  searchOpenPrs: typeof searchOpenPrs;
  searchRecentPrs: typeof searchRecentPrs;
  searchClosedPrs: typeof searchClosedPrs;
  getPr: typeof getPr;
  refreshPr: typeof refreshPr;
  lookupPr: (repo: string, number: number) => Promise<{ state: string } | null>;
  deleteWebhookRegistrationsForPr: typeof deleteWebhookRegistrationsForPr;
  reconcileForwarders: typeof reconcileForwarders;
  evictStalePrs: typeof evictStalePrs;
  evictReposNotIn: typeof evictReposNotIn;
  pruneMirrors: typeof pruneMirrors;
  upsertPrIndex: typeof upsertPrIndex;
  invalidateInbox: typeof invalidateInbox;
  publishPollCompleted: typeof publishPollCompleted;
}

export function createPollOnce(deps: PollDeps): () => Promise<{ checked: number; refreshed: number }> {
  let inFlightPoll: {
    repos: Set<string>;
    promise: Promise<{ checked: number; refreshed: number }>;
  } | null = null;
  let lastIndexSweepAt: number | null = null;

  async function pollOnceInner(): Promise<{ checked: number; refreshed: number }> {
    await deps.refreshWorktreeScan();
    if (!await deps.backgroundPollAllowed()) return { checked: 0, refreshed: 0 };
    const repos = await deps.trackedRepos();
    const registrations = deps.listWebhookRegistrations();
    const tracked = new Set(repos);
    const registered = new Set(registrations.map((r) => prKeyOf(r.repo, r.number)));
    const searchRepos = [...new Set([...repos, ...registrations.map((r) => r.repo)])];
    if (searchRepos.length === 0) {
      lastPollAt = new Date().toISOString();
      deps.publishPollCompleted(lastPollAt);
      return { checked: 0, refreshed: 0 };
    }
    const refreshActions = deps.refreshRecentActions;
    if (refreshActions) {
      const actionRefreshes = await Promise.allSettled(repos.map((repo) => refreshActions(repo)));
      actionRefreshes.forEach((result, index) => {
        if (result.status === "rejected") {
          console.error(`Actions refresh failed for ${repos[index]}:`, result.reason);
        }
      });
    }


    const hits = await deps.searchOpenPrs(searchRepos);
    const nextOpenInboxKeys = new Set(hits.map((hit) => prKeyOf(hit.repo, hit.number)));
    const openInboxChanged = nextOpenInboxKeys.size !== openInboxKeys.size
      || [...nextOpenInboxKeys].some((key) => !openInboxKeys.has(key));
    openInboxKeys = nextOpenInboxKeys;
    let refreshed = 0;
    for (const hit of hits) {
      if (!tracked.has(hit.repo) && !registered.has(prKeyOf(hit.repo, hit.number))) continue;
      const cached = deps.getPr(hit.repo, hit.number);
      // fetched_at deliberately stays put: thread resolution moves none of these fields, so only detail staleness repairs it.
      const unchanged = cached && cached.head_sha === hit.headRefOid && cached.updated_at === hit.updatedAt && cached.ci_status === hit.ciState;
      if (unchanged) continue;
      await deps.refreshPr(hit.repo, hit.number, "background poll");
      refreshed++;
    }

    const registrationMembershipChanged = await reconcileRegistrations(registrations, new Set(hits.map((h) => prKeyOf(h.repo, h.number))));

    for (const repo of repos) {
      const keepNumbers = hits.filter((h) => h.repo === repo).map((h) => h.number);
      deps.evictStalePrs(repo, keepNumbers);
    }
    const keepRepos = [...new Set([...repos, ...deps.listWebhookRegistrations().map((r) => r.repo)])];
    deps.evictReposNotIn(keepRepos);
    deps.pruneMirrors(keepRepos);

    await sweepPrIndexIfDue(repos);
    lastPollAt = new Date().toISOString();
    deps.publishPollCompleted(lastPollAt);
    if (openInboxChanged || registrationMembershipChanged) deps.invalidateInbox();
    return { checked: hits.length, refreshed };
  }

  // searchOpenPrs scopes to involves:@me, so an open registered PR can be absent from hits;
  // confirm with a direct lookup before dropping, and refresh it here since nothing else will.
  async function reconcileRegistrations(registrations: WebhookRegistrationRow[], openKeys: Set<string>): Promise<boolean> {
    let dropped = false;
    for (const reg of registrations) {
      if (openKeys.has(prKeyOf(reg.repo, reg.number))) continue;
      try {
        const status = await deps.lookupPr(reg.repo, reg.number);
        if (status?.state === "OPEN") {
          await deps.refreshPr(reg.repo, reg.number, "background poll");
          continue;
        }
        deps.deleteWebhookRegistrationsForPr(reg.repo, reg.number);
        console.log(`registration dropped (${status?.state ?? "not found"}): ${reg.repo}#${reg.number}`);
        dropped = true;
      } catch (e) {
        console.error(`registration check failed for ${reg.repo}#${reg.number}:`, e);
      }
    }
    if (dropped) deps.reconcileForwarders();
    return dropped;
  }

  async function sweepPrIndexIfDue(repos: string[]): Promise<void> {
    if (lastIndexSweepAt !== null && Date.now() - lastIndexSweepAt < INDEX_SWEEP_MS) return;
    const sweeps = await Promise.allSettled([
      ...repos.map((repo) => deps.searchRecentPrs(repo)),
      deps.searchClosedPrs(repos),
    ]);
    let changed = false;
    for (const sweep of sweeps) {
      if (sweep.status === "fulfilled") {
        if (sweep.value.length > 0) {
          deps.upsertPrIndex(sweep.value);
          changed = true;
        }
      } else {
        console.error("pr-index sweep failed:", sweep.reason);
      }
    }
    if (changed) deps.invalidateInbox();
    lastIndexSweepAt = Date.now();
  }

  function poll(): Promise<{ checked: number; refreshed: number }> {
    const repos = deps.settingsRepos();
    if (inFlightPoll) {
      const current = inFlightPoll;
      if (repos.length === current.repos.size && repos.every((repo) => current.repos.has(repo))) {
        return current.promise;
      }
      return current.promise.then(poll);
    }
    const promise = pollOnceInner().finally(() => {
      inFlightPoll = null;
    });
    inFlightPoll = { repos: new Set(repos), promise };
    return promise;
  }
  return poll;
}

export const pollOnce = createPollOnce({
  backgroundPollAllowed,
  refreshWorktreeScan,
  settingsRepos,
  trackedRepos,
  listWebhookRegistrations,
  refreshRecentActions,
  searchOpenPrs,
  searchRecentPrs,
  searchClosedPrs,
  getPr,
  refreshPr,
  lookupPr,
  deleteWebhookRegistrationsForPr,
  reconcileForwarders,
  evictStalePrs,
  evictReposNotIn,
  pruneMirrors,
  upsertPrIndex,
  invalidateInbox,
  publishPollCompleted,
});

export function startPoller(): void {
  const tick = () => {
    pollOnce()
      .catch((err) => console.error("poll failed:", err))
      .finally(() => setTimeout(tick, pollIntervalMs()));
  };
  tick();

  // Keep the first assignee/reviewer picker from opening on a cold cache.
  trackedRepos()
    .then((repos) => Promise.allSettled(repos.map((repo) => refreshRepoUsers(repo))))
    .catch((err) => console.error("repo-users priming failed:", err));
}
