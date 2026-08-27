import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  countPrs,
  getCachedPrDetail,
  getDiff,
  getFileContents,
  githubGraphqlUsage,
  getPr,
  getPrByBranch,
  getRanks,
  lastWebhookAtForPr,
  latestRescoreForHead,
  listArchivedKeys,
  listClosedPrs,
  listPrIndex,
  listPrs,
  listRunJobs,
  workflowRunsForLease,
  saveDiff,
  saveFileContents,
  setArchived,
  setAutoMergeArmed,
  setRank,
  unsetRank,
  upsertPr,
  upsertCachedPrDetail,
  upsertPrIndex,
  type MutationRow,
  type PrIndexRow,
  type PrRow,
  type RunJobRow,
  type WorkflowRunRow,
} from "./db.ts";
import { localCheckoutBranchFor, localCheckoutPathFor, setLocalCheckoutBranch, worktreePathFor, worktreeWindowIdFor } from "./worktreeScan.ts";
import { prKey } from "./prKey.ts";
import { lastPollAt, pollOnce, refreshPr, trackedRepos } from "./poller.ts";
import {
  commitPrFileEdit,
  compactReviewHunks,
  fetchDiff,
  fetchFileContents,
  fetchFileHistory,
  fetchFileHistoryDiff,
  fetchPrDetail,
  fetchPrCommentsSince,
  fetchGithubQuota,
  GithubRequestError,
  githubAuthStatus,
  startGithubSetup,
  StalePrHeadError,
  getViewerLogin,
  lookupPr,
  lookupPrIndexes,
  searchPrs,
  resolveReviewThread,
  viewerRepos,
  type FileHistoryCommit,
  type FileHistoryDiff,
  type GithubQuota,
  type PrCommentSince,
  type PrDetail,
} from "./github.ts";
import {
  proxyReplicaRequest,
  replicaEnabled,
  replicaSnapshotResponse,
  replicaStatus,
  replicaViewerLogin,
} from "./replica.ts";
import type { GithubUsageSource } from "./githubUsage.ts";
import type { GithubAuthStatus } from "./githubAuth.ts";
import { commitsFromMirror, commitStatsFromMirror, conflictFilesFromMirror, diffFromMirror, fetchMirror, fileFromMirror, INCREMENTAL_FETCH_TIMEOUT_MS, materializePrWorktree, MirrorFetchError, summarizeCommitStats, type PullRequestCommit } from "./mirror.ts";
import { checkState, type CheckState } from "./checkState.ts";
import { currentBaseRef, discardMutation, enqueueMutation, mutationsForPr, retryMutation, type MutationPayload } from "./mutations.ts";
import { isMergeMethod, mergeMethodFor, mergeMethodSourceFor, setMergeMethodPreference } from "./mergeMethod.ts";
import { AGENT_DEFAULTS, readSettings, relayConfig, RELAY_APP_INSTALL_URL, RELAY_APP_SLUG, settingsRepos, writeSettings, type AgentSetting, type Settings } from "./settings.ts";
import { claudeBinPath, ompBinPath } from "./harness.ts";
import { CommitMessageError, generateCommitMessage } from "./commitMessage.ts";
import { relayStatus } from "./relayClient.ts";
import { relayCoverage } from "./relayCoverage.ts";
import { testMatcher } from "../ui/src/lib/testPath.js";
import { checkName, liveCheckNames } from "../ui/src/lib/checks.js";
import { handleImage, handleMockImage } from "./imageproxy.ts";
import {
  agentLogTail,
  agentRunDetail,
  defaultAutofixTemplate,
  defaultFixerTemplate,
  killFixerAgent,
  launchAutofixAgent,
  launchCustomAgent,
  launchPromptAgent,
  listAgentRunsForPr,
  listFixerAgents,
  type AgentRow,
} from "./agents.ts";
import { defaultRescorePrompt, effectiveRescoreScore, maybeRescore, shouldAutoRescore } from "./rescorer.ts";
import { isUpdateAvailable, runningRev } from "./version.ts";
import { spawn } from "node:child_process";
import { repoUsersCached } from "./repoUsers.ts";
import { matchesQuery, parseQuery, wantsHistoricalPrs } from "./query.ts";
import { buildWebhookRoutes } from "./webhooks.ts";
import { findDefinition, grep, localFileHistoryPatch, searchCtx, symbolMentionHistory } from "./repoSearch.ts";
import { lsTree, showFile } from "./gitShow.ts";
import { aggregateReviewScore, aggregateReviewStale, currentReviewerScores, reviewBots } from "./reviewScore.ts";
import { isMockGithub, mockGithub, MOCK_FIXTURE_CLOCK } from "./mockGithub.ts";
import { createTmuxFocusHandler } from "./tmuxFocus.ts";
import type { TmuxFocusHandler } from "./tmuxFocus.ts";
import { needsMeRank } from "./rank.ts";
import { invalidateInbox, invalidatePr } from "./rendererInvalidation.ts";
import { actionJobLog, actionWorkflowGraphs, activateActionsLease, cacheActionsRun, cacheGithubActionsForCommit, cachedJobLogs, formatJobLogs, formatRunJobs } from "./runLogs.ts";
const cockpitRoot = process.cwd();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function localBranchFor(repo: string): string | null {
  return mockGithub?.localBranch(repo) ?? localCheckoutBranchFor(repo);
}

function handleOpenPr(parts: string[]): Response | null {
  if (parts.length !== 5 || parts[0] !== "open" || parts[1] !== "pr") return null;

  let owner: string;
  let repo: string;
  let number: string;
  try {
    [owner, repo, number] = parts.slice(2).map(decodeURIComponent) as [string, string, string];
  } catch {
    return new Response("invalid PR link", { status: 400 });
  }

  const repoPart = /^[A-Za-z0-9_.-]+$/;
  if (!repoPart.test(owner) || !repoPart.test(repo) || !/^[1-9][0-9]*$/.test(number)) {
    return new Response("invalid PR link", { status: 400 });
  }

  return new Response(null, {
    status: 302,
    headers: {
      location: `prcockpit://pr/${owner}/${repo}/${number}`,
      "cache-control": "no-store",
    },
  });
}

async function handleOnboardingRepos(): Promise<Response> {
  try {
    return json(await viewerRepos());
  } catch (err) {
    console.error("onboarding repos fetch failed:", err);
    return json({ error: "couldn't load your repositories — check that gh is authenticated" }, 500);
  }
}

function handleRepoUsers(url: URL): Response {
  const repo = url.searchParams.get("repo") ?? "";
  if (!/^[^/]+\/[^/]+$/.test(repo)) return json({ error: "invalid repo" }, 400);
  const users = repoUsersCached(repo).map((u) => ({ login: u.login, avatarUrl: u.avatar_url }));
  return json(users);
}

// stale once commits landed after the reviewed sha; addressed once stale and that reviewer's threads are all resolved
export function greptileScoreStatus(pr: PrRow): "stale" | "addressed" | null {
  if (pr.greptile_confidence == null) return null;
  if (!pr.greptile_reviewed_sha || pr.greptile_reviewed_sha === pr.head_sha) return null;
  return pr.greptile_unresolved_count === 0 ? "addressed" : "stale";
}

// pr_index lacks review/base fields; those qualifiers just never match a historical row
function stubPrRowFromIndex(entry: PrIndexRow): PrRow {
  return {
    repo: entry.repo,
    number: entry.number,
    state: entry.state,
    is_draft: entry.is_draft,
    title: entry.title,
    author: entry.author,
    base_ref: "",
    head_ref: "",
    head_sha: "",
    updated_at: entry.updated_at,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    commit_count: 0,
    mergeable: "",
    merge_state_status: "",
    auto_merge_enabled: 0,
    viewer_is_author: 0,
    viewer_review_requested: 0,
    viewer_review_state: null,
    ci_status: "NONE",
    review_decision: null,
    unresolved_count: 0,
    needs_me_rank: 0,
    greptile_confidence: null,
    greptile_reviewed_sha: null,
    greptile_unresolved_count: 0,
    detail_json: "{}",
    fetched_at: entry.updated_at,
  };
}

// falls back to raw totals when detail_json predates the files field or the 100-file cap was hit
export function statsExcludingTests(pr: PrRow, detail: any, testRe: RegExp): { additions: number; deletions: number } {
  const files = detail.files;
  if (!Array.isArray(files?.nodes) || files.totalCount > files.nodes.length) {
    return { additions: pr.additions, deletions: pr.deletions };
  }
  let additions = 0;
  let deletions = 0;
  for (const f of files.nodes as Array<{ path: string; additions: number; deletions: number }>) {
    if (testRe.test(f.path)) continue;
    additions += f.additions;
    deletions += f.deletions;
  }
  return { additions, deletions };
}

function handleClosed(url: URL): Response {
  const requestedLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, 200)
    : 100;
  const prs = listClosedPrs(limit).map((pr) => ({
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    author: pr.author,
    state: pr.state,
    isDraft: pr.is_draft === 1,
    updatedAt: pr.updated_at,
    mergedAt: pr.merged_at,
    closedAt: pr.closed_at,
    terminalAt: pr.merged_at ?? pr.closed_at ?? pr.updated_at,
  }));
  return json({ prs });
}

async function handleInbox(url: URL): Promise<Response> {
  const wantArchived = url.searchParams.get("archived") === "1";
  const archivedKeys = listArchivedKeys();
  let prs = listPrs().filter((pr) => archivedKeys.has(prKey(pr)) === wantArchived);
  const q = url.searchParams.get("q");
  if (q) {
    const parsed = parseQuery(q);
    prs = prs.filter((pr) => matchesQuery(pr, parsed, wantArchived));
    if (wantsHistoricalPrs(parsed)) {
      const liveKeys = new Set(prs.map(prKey));
      const historical = listPrIndex()
        .map(stubPrRowFromIndex)
        .filter((pr) => !liveKeys.has(prKey(pr)) && matchesQuery(pr, parsed, false));
      prs = [...prs, ...historical];
    }
  }
  const ranks = getRanks();
  const agentByPr = new Map<string, AgentRow>(listFixerAgents().map((a) => [prKey(a), a]));
  const testRe = testMatcher(readSettings().test_path_regex);

  const rows = prs.map((pr) => {
    const greptileStatus = greptileScoreStatus(pr);
    const rescore = pr.greptile_confidence != null ? latestRescoreForHead(pr.repo, pr.number, pr.head_sha) : null;
    const rescoreScore = rescore && pr.greptile_confidence != null ? effectiveRescoreScore(pr.greptile_confidence, rescore.score) : null;
    const detail = JSON.parse(pr.detail_json);
    const hasReviewShape = Array.isArray(detail.reviews?.nodes) && Array.isArray(detail.comments?.nodes) && Array.isArray(detail.reviewRequests?.nodes);
    const perReviewer = hasReviewShape ? currentReviewerScores(detail) : {};
    const reviewScore = aggregateReviewScore(perReviewer, rescoreScore ?? pr.greptile_confidence);
    const reviewScoreStale = aggregateReviewStale(perReviewer, reviewScore);
    const stats = statsExcludingTests(pr, detail, testRe);
    return {
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      author: pr.author,
      state: pr.state,
      isDraft: pr.is_draft === 1,
      baseRef: pr.base_ref,
      headRef: pr.head_ref,
      headSha: pr.head_sha,
      updatedAt: pr.updated_at,
      additions: stats.additions,
      deletions: stats.deletions,
      rawAdditions: pr.additions,
      rawDeletions: pr.deletions,
      changedFiles: pr.changed_files,
      mergeable: pr.mergeable,
      mergeStateStatus: pr.merge_state_status,
      autoMergeEnabled: pr.auto_merge_enabled === 1,
      viewerIsAuthor: pr.viewer_is_author === 1,
      viewerReviewRequested: pr.viewer_review_requested === 1,
      viewerReviewState: pr.viewer_review_state,
      ciStatus: pr.ci_status,
      reviewDecision: pr.review_decision,
      unresolvedCount: pr.unresolved_count,
      needsMeRank: pr.needs_me_rank,
      greptileConfidence: pr.greptile_confidence,
      greptileStatus,
      greptileRescore: rescore && rescoreScore != null ? { score: rescoreScore, reviewedSha: rescore.review_sha } : null,
      reviewScore,
      reviewScoreStale,
      windowId: worktreeWindowIdFor(pr.repo, pr.head_ref),
      worktreePath: worktreePathFor(pr.repo, pr.head_ref),
      localCheckoutPath: localCheckoutPathFor(pr.repo),
      localBranch: localBranchFor(pr.repo),
      rank: ranks.get(prKey(pr)) ?? null,
      fixerAgentState: agentByPr.get(prKey(pr))?.state ?? null,
      fixerAgentExitReason: agentByPr.get(prKey(pr))?.exit_reason ?? null,
    };
  });

  const viewerLogin = replicaEnabled() ? replicaViewerLogin() : await getViewerLogin().catch(() => null);
  return json({ prs: rows, lastPollAt: isMockGithub ? MOCK_FIXTURE_CLOCK : lastPollAt, viewerLogin });
}

const UNTRACKED_STALE_MS = 5 * 60_000;

async function revalidateCachedPrDetail(
  repo: string,
  number: number,
  fetchDetail: typeof fetchPrDetail,
  source: GithubUsageSource,
): Promise<void> {
  const snapshotCutoffAt = new Date().toISOString();
  const detail = await fetchDetail(repo, number, source);
  upsertCachedPrDetail({
    repo,
    number,
    head_sha: detail.headRefOid,
    detail_json: JSON.stringify(detail),
    fetched_at: snapshotCutoffAt,
  });
  invalidatePr(repo, number);
}

function createPrDetailRevalidator(
  refresh: (repo: string, number: number, source: GithubUsageSource) => Promise<void>,
): (repo: string, number: number, source: GithubUsageSource) => Promise<void> {
  const revalidating = new Map<string, Promise<void>>();
  return (repo, number, source) => {
    const key = `${repo}#${number}`;
    let revalidation = revalidating.get(key);
    if (!revalidation) {
      revalidation = refresh(repo, number, source);
      revalidating.set(key, revalidation);
      void revalidation.catch((err) => console.error(`background revalidate failed for ${repo}#${number}:`, err));
      void revalidation.then(
        () => revalidating.delete(key),
        () => revalidating.delete(key),
      );
    }
    return revalidation;
  };
}

type HttpDependencies = {
  fetchPrDetail: typeof fetchPrDetail;
  fetchGithubQuota: typeof fetchGithubQuota;
  fetchPrCommentsSince: typeof fetchPrCommentsSince;
  lookupPrIndexes: typeof lookupPrIndexes;
  commitPrFileEdit: typeof commitPrFileEdit;
  githubAuthStatus: typeof githubAuthStatus;
  startGithubSetup: typeof startGithubSetup;
  generateCommitMessage: typeof generateCommitMessage;
  resolveReviewThread: typeof resolveReviewThread;
  refreshPr: typeof refreshPr;
  handleTmuxFocus: TmuxFocusHandler;
  activateActionsLease: typeof activateActionsLease;
  cacheActionsRun: typeof cacheActionsRun;
  cacheGithubActionsForCommit: typeof cacheGithubActionsForCommit;
  actionWorkflowGraphs: typeof actionWorkflowGraphs;
  actionJobLog: typeof actionJobLog;
};

type HttpRuntime = HttpDependencies & {
  revalidateCachedPrDetail: (repo: string, number: number, source: GithubUsageSource) => Promise<void>;
  revalidateTrackedPr: (repo: string, number: number, source: GithubUsageSource) => Promise<void>;
};

const defaultHttpDependencies: HttpDependencies = {
  fetchPrDetail,
  fetchGithubQuota,
  fetchPrCommentsSince,
  lookupPrIndexes,
  commitPrFileEdit,
  githubAuthStatus,
  startGithubSetup,
  generateCommitMessage,
  resolveReviewThread,
  refreshPr,
  handleTmuxFocus: createTmuxFocusHandler(),
  activateActionsLease,
  cacheActionsRun,
  cacheGithubActionsForCommit,
  actionWorkflowGraphs,
  actionJobLog,
};
async function handleGithubQuota(runtime: HttpRuntime): Promise<Response> {
  try {
    return json(await runtime.fetchGithubQuota());
  } catch (err) {
    console.error("GitHub quota fetch failed:", err);
    return json({ error: "GitHub quota unavailable" }, 502);
  }
}

async function handleGithubUsage(runtime: HttpRuntime): Promise<Response> {
  try {
    const resources = await runtime.fetchGithubQuota();
    return json({
      quota: resources.graphql,
      usage: githubGraphqlUsage(resources.graphql.used, resources.graphql.resetAt),
    });
  } catch (err) {
    console.error("GitHub usage fetch failed:", err);
    return json({ error: "GitHub usage unavailable" }, 502);
  }
}


// Resolved threads bump neither updatedAt nor head SHA, so the poller's change gate misses them.
const TRACKED_STALE_MS = 60_000;

export function trackedDetailIsStale(fetchedAt: string, nowMs: number): boolean {
  return nowMs - new Date(fetchedAt).getTime() > TRACKED_STALE_MS;
}

type MergeabilityDetail = {
  state?: string;
  isDraft?: boolean;
  mergeable?: string;
  mergeStateStatus?: string;
};

// GitHub computes mergeability asynchronously; retry unresolved open PRs sooner than normal detail refreshes.
const TRANSIENT_MERGEABILITY_STALE_MS = 30_000;

export function mergeabilityNeedsRefresh(
  fetchedAt: string,
  detail: MergeabilityDetail,
  nowMs: number,
): boolean {
  if (detail.state !== "OPEN" || detail.isDraft) return false;
  if (detail.mergeable !== "UNKNOWN" && detail.mergeStateStatus !== "UNKNOWN") return false;
  return nowMs - new Date(fetchedAt).getTime() > TRANSIENT_MERGEABILITY_STALE_MS;
}

function trackedMergeabilityDetail(tracked: PrRow): MergeabilityDetail {
  return {
    state: tracked.state,
    isDraft: tracked.is_draft === 1,
    mergeable: tracked.mergeable,
    mergeStateStatus: tracked.merge_state_status,
  };
}

class CheckoutTargetError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function checkoutTargetFor(checkout: string, file: string | null): Promise<{ path: string; target: string }> {
  let canonicalCheckout: string;
  try {
    canonicalCheckout = await realpath(checkout);
  } catch {
    throw new CheckoutTargetError(404, `checkout no longer exists: ${checkout}`);
  }
  if (!file) return { path: canonicalCheckout, target: canonicalCheckout };
  if (path.isAbsolute(file) || file.includes("\0")) throw new CheckoutTargetError(400, "invalid file path");
  const candidate = path.resolve(canonicalCheckout, file);
  const checkoutPrefix = canonicalCheckout.endsWith(path.sep) ? canonicalCheckout : `${canonicalCheckout}${path.sep}`;
  if (!candidate.startsWith(checkoutPrefix)) throw new CheckoutTargetError(400, "file path escapes the checkout");
  let target: string;
  try {
    target = await realpath(candidate);
  } catch {
    throw new CheckoutTargetError(404, `${file} does not exist in the PR checkout`);
  }
  if (!target.startsWith(checkoutPrefix)) throw new CheckoutTargetError(400, "file symlink escapes the checkout");
  return { path: canonicalCheckout, target };
}

function withBaseBranchPr(
  repoName: string,
  num: number,
  detail: PrDetail,
): Record<string, unknown> {
  compactReviewHunks(detail);
  const basePr = getPrByBranch(repoName, detail.baseRefName);
  const headRef = detail.headRefName;
  return {
    ...detail,
    baseBranchPrNumber: basePr && basePr.number !== num ? basePr.number : null,
    worktreePath: headRef ? worktreePathFor(repoName, headRef) : null,
    windowId: headRef ? worktreeWindowIdFor(repoName, headRef) : null,
    localCheckoutPath: localCheckoutPathFor(repoName),
    localBranch: localBranchFor(repoName),
    mergeMethod: mergeMethodFor(repoName, detail.baseRefName),
    mergeMethodSource: mergeMethodSourceFor(repoName, detail.baseRefName),
  };
}

function trackedPrDetail(repoName: string, num: number, tracked: PrRow): Record<string, unknown> {
  const rescore = latestRescoreForHead(repoName, num, tracked.head_sha);
  const rescoreScore = rescore && tracked.greptile_confidence != null ? effectiveRescoreScore(tracked.greptile_confidence, rescore.score) : null;
  const detail = JSON.parse(tracked.detail_json);
  return {
    ...withBaseBranchPr(repoName, num, detail),
    greptileRescore: rescore && rescoreScore != null ? { score: rescoreScore, reviewedSha: rescore.review_sha } : null,
    reviewerScores: currentReviewerScores(detail),
  };
}

type AgentSnapshotStatus = {
  fetchedAt: string;
  freshness: "recent" | "outdated";
  newerActivityAt: string | null;
};

export function snapshotStatus(fetchedAt: string, lastWebhookAt: string | null): AgentSnapshotStatus {
  const newerActivityAt = lastWebhookAt && Date.parse(lastWebhookAt) > Date.parse(fetchedAt) ? lastWebhookAt : null;
  return {
    fetchedAt,
    freshness: newerActivityAt ? "outdated" : "recent",
    newerActivityAt,
  };
}

async function handlePrDetail(
  owner: string,
  repo: string,
  number: string,
  runtime: HttpRuntime,
  agentRead = false,
): Promise<Response> {
  const repoName = `${owner}/${repo}`;
  const num = Number(number);
  void fetchMirror(repoName).catch(() => {});

  let tracked = getPr(repoName, num);
  if (agentRead && tracked) {
    const nowMs = Date.now();
    const agentSnapshot = snapshotStatus(tracked.fetched_at, lastWebhookAtForPr(repoName, num));
    // Serve without blocking, but converge: thread resolutions reach us no other way.
    if (
      agentSnapshot.freshness === "outdated" ||
      trackedDetailIsStale(tracked.fetched_at, nowMs) ||
      mergeabilityNeedsRefresh(tracked.fetched_at, trackedMergeabilityDetail(tracked), nowMs)
    ) runtime.revalidateTrackedPr(repoName, num, "agent read");
    return json({ ...trackedPrDetail(repoName, num, tracked), agentSnapshot });
  }
  if (tracked) {
    const nowMs = Date.now();
    if (mergeabilityNeedsRefresh(tracked.fetched_at, trackedMergeabilityDetail(tracked), nowMs)) {
      runtime.revalidateTrackedPr(repoName, num, "app detail");
    } else if (trackedDetailIsStale(tracked.fetched_at, nowMs)) {
      try {
        await runtime.refreshPr(repoName, num, "app detail");
        tracked = getPr(repoName, num);
      } catch (err) {
        console.error(`stale detail refresh failed for ${repoName}#${num}:`, err);
      }
    }
  }
  if (tracked) return json(trackedPrDetail(repoName, num, tracked));

  const cached = getCachedPrDetail(repoName, num);
  if (agentRead && cached) {
    const nowMs = Date.now();
    const detail = JSON.parse(cached.detail_json);
    const recent = nowMs - new Date(cached.fetched_at).getTime() <= UNTRACKED_STALE_MS;
    const agentSnapshot = snapshotStatus(cached.fetched_at, lastWebhookAtForPr(repoName, num));
    if (agentSnapshot.freshness === "outdated" || !recent || mergeabilityNeedsRefresh(cached.fetched_at, detail, nowMs)) {
      runtime.revalidateCachedPrDetail(repoName, num, "agent read");
    }
    return json({
      ...withBaseBranchPr(repoName, num, detail),
      agentSnapshot,
    });
  }
  if (cached) {
    const nowMs = Date.now();
    const detail = JSON.parse(cached.detail_json);
    const stale = nowMs - new Date(cached.fetched_at).getTime() > UNTRACKED_STALE_MS;
    if (stale || mergeabilityNeedsRefresh(cached.fetched_at, detail, nowMs)) {
      runtime.revalidateCachedPrDetail(repoName, num, "app detail");
    }
    return json(withBaseBranchPr(repoName, num, detail));
  }

  try {
    const snapshotCutoffAt = new Date().toISOString();
    const detail = await runtime.fetchPrDetail(repoName, num, agentRead ? "agent read" : "app detail");
    upsertCachedPrDetail({
      repo: repoName,
      number: num,
      head_sha: detail.headRefOid,
      detail_json: JSON.stringify(detail),
      fetched_at: snapshotCutoffAt,
    });
    const response = withBaseBranchPr(repoName, num, detail);
    return json(agentRead ? { ...response, agentSnapshot: snapshotStatus(snapshotCutoffAt, lastWebhookAtForPr(repoName, num)) } : response);
  } catch (err) {
    console.error(`detail fetch failed for ${repoName}#${num}:`, err);
    const status = err instanceof GithubRequestError ? err.status : 502;
    return json({ error: status === 404 ? "not found" : "GitHub fetch failed" }, status);
  }
}

// bulk cache-warming for the inbox: serves only what's already stored, never hits GitHub
const BULK_DETAIL_KEY_CAP = 100;
const BULK_DETAIL_KEY_RE = /^([^/]+\/[^/]+)#(\d+)$/;

function handlePrDetails(url: URL): Response {
  const keys = (url.searchParams.get("keys") ?? "").split(",").filter(Boolean).slice(0, BULK_DETAIL_KEY_CAP);
  const details: Record<string, unknown> = {};
  for (const key of keys) {
    const match = BULK_DETAIL_KEY_RE.exec(key);
    if (!match) continue;
    const repoName = match[1]!;
    const num = Number(match[2]);
    const tracked = getPr(repoName, num);
    if (tracked) {
      details[key] = trackedPrDetail(repoName, num, tracked);
      continue;
    }
    const cached = getCachedPrDetail(repoName, num);
    if (cached) details[key] = withBaseBranchPr(repoName, num, JSON.parse(cached.detail_json));
  }
  return json({ details });
}

type PrSummaryCheck = { name: string; state: CheckState; required: boolean; url: string | null; logBytes: number | null };
type PrSummaryComment = { author: string; body: string; createdAt: string };
type PrSummaryThread = { handle: string; path: string; line: number | null; outdated: boolean; comments: PrSummaryComment[] };
type PrSummaryNewComment = PrSummaryComment & {
  kind: PrCommentSince["kind"];
  path: string | null;
  line: number | null;
  state: string | null;
  url: string | null;
};

export interface PrAgentSummary {
  ref: string;
  title: string;
  body: string;
  author: string;
  base: string;
  headSha: string;
  head: string;
  createdAt: string;
  url: string;
  state: string;
  draft: boolean;
  merge: string;
  review: string;
  updatedAt: string;
  snapshot: AgentSnapshotStatus | null;
  ci: { headSha: string; checksFetched: boolean; state: string; complete: boolean; passed: number; running: number; failed: number; cancelled: number; skipped: number; checks: PrSummaryCheck[] };
  openComments: PrSummaryThread[];
  openCommentsComplete: boolean;
  newCommentsSince: string | null;
  newComments: PrSummaryNewComment[];
  newCommentsComplete: boolean;
  quota: GithubQuota | null;
}


export function reviewThreadHandle(threadId: string): string {
  return createHash("sha256").update(threadId).digest("hex").slice(0, 10);
}
function compactText(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length <= 800 ? text : `${text.slice(0, 797)}...`;
}

function snapshotAge(fetchedAt: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(fetchedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export function buildPrAgentSummary(
  ref: string,
  detail: PrDetail & { agentSnapshot?: AgentSnapshotStatus },
  quota: GithubQuota | null,
  newCommentsSince: string | null = null,
  commentsSince: PrCommentSince[] = [],
): PrAgentSummary {
  const rollup = detail.lastCommit?.nodes?.[0]?.commit?.statusCheckRollup;
  const checksFetched = detail.lastCommit?.nodes?.[0] !== undefined;
  const checkNodes = rollup?.contexts?.nodes ?? [];
  const live = liveCheckNames(checkNodes);
  const checks: PrSummaryCheck[] = [];
  const counts: Record<CheckState, number> = { passed: 0, running: 0, failed: 0, cancelled: 0, skipped: 0 };
  // a cached log turns a red check into something an agent can read without another GitHub call
  const logBytesByJob: Record<string, number> = {};
  for (const job of listRunJobs(ref.slice(0, ref.lastIndexOf("#")), String(detail.headRefOid ?? ""))) {
    if (job.log_bytes !== null) logBytesByJob[job.name] = job.log_bytes;
  }
  for (const check of checkNodes) {
    const state = checkState(check);
    // a re-queued run supersedes the previous attempt's verdict
    if ((state === "failed" || state === "cancelled") && live.has(checkName(check))) continue;
    counts[state] += 1;
    const name = String(check.__typename === "CheckRun" ? check.name : check.context);
    checks.push({
      name,
      state,
      required: check.isRequired === true,
      url: check.__typename === "CheckRun" ? check.detailsUrl ?? null : check.targetUrl ?? null,
      logBytes: logBytesByJob[name] ?? null,
    });
  }

  const openComments: PrSummaryThread[] = detail.reviewThreads.nodes
    .filter((thread) => !thread.isResolved)
    .map((thread) => ({
      handle: reviewThreadHandle(thread.id),
      path: thread.path,
      line: thread.line,
      outdated: thread.isOutdated,
      comments: thread.comments.nodes.map((comment) => ({
        author: comment.author?.login ?? "unknown",
        body: compactText(comment.body),
        createdAt: comment.createdAt,
      })),
    }));

  const newComments: PrSummaryNewComment[] = commentsSince.map((comment) => ({
    ...comment,
    body: compactText(comment.body),
  }));

  const checkPageComplete = checksFetched && (!rollup ||
    (rollup.contexts.pageInfo ? !rollup.contexts.pageInfo.hasNextPage : rollup.contexts.nodes.length < 100));
  const commentPagesComplete =
    detail.reviewThreads.pageInfo?.hasNextPage === false &&
    detail.reviewThreads.nodes
      .filter((thread) => !thread.isResolved)
      .every((thread) => thread.comments.pageInfo?.hasNextPage === false);

  return {
    ref,
    title: compactText(detail.title),
    body: String(detail.body ?? ""),
    url: String(detail.url ?? ""),
    author: String(detail.author?.login ?? "unknown"),
    base: String(detail.baseRefName ?? ""),
    head: String(detail.headRefName ?? ""),
    headSha: String(detail.headRefOid ?? ""),
    createdAt: String(detail.createdAt ?? ""),
    state: String(detail.state ?? "UNKNOWN"),
    draft: detail.isDraft === true,
    merge: String(detail.mergeStateStatus ?? detail.mergeable ?? "UNKNOWN"),
    review: String(detail.reviewDecision ?? "NONE"),
    updatedAt: String(detail.updatedAt ?? ""),
    snapshot: detail.agentSnapshot ?? null,
    ci: { headSha: String(detail.headRefOid ?? ""), checksFetched, state: String(rollup?.state ?? "NONE"), complete: checkPageComplete, ...counts, checks },
    openComments,
    openCommentsComplete: commentPagesComplete,
    newCommentsSince,
    newComments,
    newCommentsComplete: true,
    quota,
  };
}

export interface AgentSummaryFormatOptions {
  comments?: boolean;
  body?: boolean;
  digest?: boolean;
}

function newCommentLine(comment: PrSummaryNewComment): string {
  const location = comment.path ? ` · \`${comment.path}${comment.line == null ? "" : `:${comment.line}`}\`` : "";
  const verdict = comment.state ? ` · ${comment.state.toLowerCase().replace(/_/g, " ")}` : "";
  return `- @${comment.author} · ${comment.kind}${verdict}${location}: ${comment.body}${comment.url ? ` — ${comment.url}` : ""}`;
}

function openThreadLines(summary: PrAgentSummary, staleMarkers: string[]): string[] {
  const lines: string[] = [];
  if (summary.openComments.length === 0) lines.push("_No open review comments._");
  for (const thread of summary.openComments) {
    lines.push(`- \`${thread.handle}\` · \`${thread.path}${thread.line == null ? "" : `:${thread.line}`}\`${thread.outdated ? " · OUTDATED" : ""}${thread.outdated && thread.comments.some((comment) => staleMarkers.some((marker) => comment.body.includes(marker))) ? " · STALE AUTO-RESOLVE — resolve manually" : ""}`);
    for (const comment of thread.comments) lines.push(`  - @${comment.author}: ${comment.body}`);
  }
  if (!summary.openCommentsComplete) lines.push("_Partial: review threads or replies may be missing._");
  return lines;
}

function formatPrAgentDigest(summary: PrAgentSummary, includeComments: boolean, staleMarkers: string[]): string {
  const lines: string[] = [];
  if (summary.snapshot?.freshness === "outdated") {
    lines.push(`Cached snapshot: OUTDATED · ${snapshotAge(summary.snapshot.fetchedAt)} old · ${summary.snapshot.fetchedAt}`);
    if (summary.snapshot.newerActivityAt) lines.push(`Known newer activity: webhook received ${summary.snapshot.newerActivityAt}.`);
  }
  const attention = summary.ci.checks.filter((check) => check.state === "failed" || check.state === "cancelled");
  if (attention.length > 0) {
    lines.push(`CI: ${summary.ci.state}`);
    for (const check of attention) {
      const log = check.logBytes === null ? "" : ` · log cached (${Math.max(1, Math.round(check.logBytes / 1024))} KB)`;
      lines.push(`- ${check.state.toUpperCase()}${check.required ? " required" : ""}: ${check.name}${log}`);
    }
    if (attention.some((check) => check.logBytes !== null)) {
      lines.push(`Read a cached log with \`pr-cockpit ${summary.ref} --logs [check name]\`.`);
    }
  }
  if (summary.ci.running > 0) {
    lines.push(`Inspect queued and running Actions state with \`pr-cockpit ${summary.ref} --jobs\`.`);
  }
  if (includeComments) {
    const commentLines = summary.newComments.length > 0
      ? summary.newComments.map(newCommentLine)
      : summary.openComments.length > 0 ? openThreadLines(summary, staleMarkers) : [];
    if (commentLines.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push(...commentLines);
    }
  }
  if (lines.length === 0) lines.push(`No new comments. CI: ${summary.ci.state} · Review: ${summary.review}.`);
  return `${lines.join("\n")}\n`;
}

export function formatPrAgentSummary(summary: PrAgentSummary, options: AgentSummaryFormatOptions = {}): string {
  const { comments: includeComments = true, body: includeBody = true, digest = false } = options;
  const number = summary.ref.slice(summary.ref.lastIndexOf("#") + 1);
  const staleMarkers = reviewBots().flatMap((bot) => bot.staleMarker ? [bot.staleMarker] : []);
  if (digest) return formatPrAgentDigest(summary, includeComments, staleMarkers);
  const lines = [
    `# Pull Request #${number}: ${summary.title}`,
    "",
    `State: ${summary.state}`,
    `Draft: ${summary.draft}`,
    `Author: @${summary.author}`,
    `Base: ${summary.base}`,
    `Head: ${summary.head}`,
    `Head SHA: ${summary.headSha}`,
    `Merge state: ${summary.merge}`,
    `Created: ${summary.createdAt}`,
    `Updated: ${summary.updatedAt}`,
    `URL: ${summary.url}`,
  ];
  if (summary.snapshot) {
    const { fetchedAt, freshness, newerActivityAt } = summary.snapshot;
    lines.push("", `Cached snapshot: ${freshness === "outdated" ? "OUTDATED · " : ""}${snapshotAge(fetchedAt)} old · ${fetchedAt}`);
    if (newerActivityAt) {
      lines.push(`Known newer activity: webhook received ${newerActivityAt}. This snapshot does not include that activity.`);
    }
    if (summary.quota?.graphql.remaining === 0) {
      lines.push(`Refresh unavailable until ${summary.quota.graphql.resetAt}: GitHub GraphQL quota exhausted.`);
    }
  }

  lines.push("", "## Body", "");
  lines.push(includeBody ? summary.body || "_No body._" : `_Omitted. Read it with \`pr-cockpit ${summary.ref}\`._`);
  lines.push("", "## Cockpit Status", "");
  lines.push(
    `Review: ${summary.review} · CI: ${summary.ci.state}`,
    `Checks: ${summary.ci.passed} passed · ${summary.ci.running} running · ${summary.ci.failed} failed · ${summary.ci.cancelled} cancelled · ${summary.ci.skipped} skipped · ${summary.ci.checks.length} total${!summary.ci.checksFetched ? " · NOT FETCHED" : summary.ci.complete ? "" : " · PARTIAL (100+ checks)"}`,
  );
  for (const check of summary.ci.checks) {
    const log = check.logBytes === null ? "" : ` · log cached (${Math.max(1, Math.round(check.logBytes / 1024))} KB)`;
    lines.push(`- ${check.state.toUpperCase()}${check.required ? " required" : ""}: ${check.name}${log}${check.url ? ` — ${check.url}` : ""}`);
  }
  if (summary.ci.checks.some((check) => check.logBytes !== null)) {
    lines.push("", `Read a cached log with \`pr-cockpit ${summary.ref} --logs [check name]\` instead of polling GitHub Actions.`);
  }
  if (summary.ci.running > 0) {
    lines.push("", `Inspect queued and running Actions state with \`pr-cockpit ${summary.ref} --jobs\` instead of polling GitHub Actions.`);
  }

  if (includeComments && summary.newCommentsSince) {
    lines.push("", `## New Comments Since ${summary.newCommentsSince}`, "");
    if (summary.newComments.length === 0) lines.push("_No new comments._");
    for (const comment of summary.newComments) lines.push(newCommentLine(comment));
  } else if (includeComments) {
    lines.push("", "## Open Review Comments", "");
    lines.push(...openThreadLines(summary, staleMarkers));
  }

  lines.push("", summary.quota
    ? `Quota: REST ${summary.quota.rest.remaining}/${summary.quota.rest.limit} left · GraphQL ${summary.quota.graphql.remaining}/${summary.quota.graphql.limit} left`
    : "Quota: unavailable");
  return `${lines.join("\n")}\n`;
}

const PR_REF_PART_RE = /^[A-Za-z0-9_.-]+$/;
const PR_NUMBER_RE = /^[1-9][0-9]*$/;

function validPrReference(owner: string, repo: string, number: string): boolean {
  return PR_REF_PART_RE.test(owner) && PR_REF_PART_RE.test(repo) && PR_NUMBER_RE.test(number);
}

async function handleAgentPr(
  owner: string,
  repo: string,
  number: string,
  url: URL,
  runtime: HttpRuntime,
): Promise<Response> {
  if (!validPrReference(owner, repo, number)) return json({ error: "invalid PR reference" }, 400);
  const format = url.searchParams.get("format") ?? "markdown";
  if (format !== "markdown" && format !== "json") return json({ error: "format must be markdown or json" }, 400);
  const commentsInput = url.searchParams.get("comments");
  if (commentsInput !== null && commentsInput !== "0" && commentsInput !== "1") return json({ error: "comments must be 0 or 1" }, 400);
  const includeComments = commentsInput !== "0";
  const bodyInput = url.searchParams.get("body");
  if (bodyInput !== null && bodyInput !== "0" && bodyInput !== "1") return json({ error: "body must be 0 or 1" }, 400);
  const includeBody = bodyInput !== "0";
  const digestInput = url.searchParams.get("digest");
  if (digestInput !== null && digestInput !== "0" && digestInput !== "1") return json({ error: "digest must be 0 or 1" }, 400);
  const digest = digestInput === "1";
  const sinceInput = url.searchParams.get("since");
  let newCommentsSince: string | null = null;
  if (sinceInput !== null) {
    const sinceMs = Date.parse(sinceInput);
    if (!Number.isFinite(sinceMs)) return json({ error: "since must be an ISO date or timestamp" }, 400);
    newCommentsSince = new Date(sinceMs).toISOString();
  }

  let commentsSince: PrCommentSince[] = [];
  if (includeComments && newCommentsSince !== null) {
    try {
      commentsSince = await runtime.fetchPrCommentsSince(`${owner}/${repo}`, Number(number), newCommentsSince);
    } catch (err) {
      console.error(`GitHub comments fetch failed for ${owner}/${repo}#${number}:`, err);
      const status = err instanceof GithubRequestError ? err.status : 502;
      return json({ error: "GitHub comments fetch failed" }, status);
    }
  }
  const detailResponse = await handlePrDetail(owner, repo, number, runtime, true);
  if (!detailResponse.ok) return detailResponse;
  // handlePrDetail serializes the PrDetail and agent cache metadata produced above.
  const detail = await detailResponse.json() as unknown as PrDetail & { agentSnapshot: AgentSnapshotStatus };
  let quota: GithubQuota | null = null;
  try {
    quota = await runtime.fetchGithubQuota();
  } catch (err) {
    console.error("GitHub quota fetch failed:", err);
  }
  const summary = buildPrAgentSummary(`${owner}/${repo}#${number}`, detail, quota, newCommentsSince, commentsSince);
  if (format === "json") return json(summary);
  return new Response(formatPrAgentSummary(summary, { comments: includeComments, body: includeBody, digest }), {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}

function markReviewThreadResolved(repo: string, number: number, threadId: string): void {
  const tracked = getPr(repo, number);
  if (tracked) {
    const detail = JSON.parse(tracked.detail_json) as PrDetail;
    const thread = detail.reviewThreads.nodes.find((candidate) => candidate.id === threadId);
    if (!thread || thread.isResolved) return;
    thread.isResolved = true;
    const unresolved = detail.reviewThreads.nodes.filter((candidate) => !candidate.isResolved && !candidate.isOutdated);
    upsertPr({
      ...tracked,
      unresolved_count: unresolved.length,
      needs_me_rank: needsMeRank({
        ciStatus: tracked.ci_status,
        reviewDecision: tracked.review_decision,
        unresolvedCount: unresolved.length,
        mergeable: tracked.mergeable,
        isDraft: tracked.is_draft === 1,
      }),
      greptile_unresolved_count: unresolved.filter(
        (candidate) => candidate.comments.nodes[0]?.author?.login === "greptile-apps",
      ).length,
      detail_json: JSON.stringify(detail),
    });
    invalidatePr(repo, number);
    invalidateInbox();
    return;
  }
  const cached = getCachedPrDetail(repo, number);
  if (!cached) return;
  const detail = JSON.parse(cached.detail_json) as PrDetail;
  const thread = detail.reviewThreads.nodes.find((candidate) => candidate.id === threadId);
  if (!thread || thread.isResolved) return;
  thread.isResolved = true;
  upsertCachedPrDetail({ ...cached, detail_json: JSON.stringify(detail) });
  invalidatePr(repo, number);
}

function fieldValue(payload: object, field: string): unknown {
  return Reflect.get(payload, field);
}

function requiredString(payload: object, field: string): string {
  const value = fieldValue(payload, field);
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function requiredBoolean(payload: object, field: string): boolean {
  const value = fieldValue(payload, field);
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function requiredLogins(payload: object): string[] {
  const logins = fieldValue(payload, "logins");
  if (!Array.isArray(logins) || logins.length === 0 || !logins.every((login): login is string => typeof login === "string")) {
    throw new Error("logins must be a non-empty string array");
  }
  return logins;
}

function reviewThreadByHandle(detail: PrDetail, handle: unknown) {
  if (typeof handle !== "string" || !/^[0-9a-f]{10}$/.test(handle)) throw new Error("valid thread handle required");
  const matches = detail.reviewThreads.nodes.filter((thread) => reviewThreadHandle(thread.id) === handle);
  if (matches.length === 0) throw new Error("review thread handle not found");
  if (matches.length > 1) throw new Error("review thread handle is ambiguous");
  return matches[0]!;
}

export function normalizeAgentMutation(repo: string, number: number, detail: PrDetail, input: unknown): MutationPayload {
  if (!input || typeof input !== "object" || Array.isArray(input) || !("kind" in input) || typeof input.kind !== "string") {
    throw new Error("mutation kind required");
  }
  switch (input.kind) {
    case "merge": {
      const force = fieldValue(input, "force");
      const method = fieldValue(input, "method");
      if ("force" in input && typeof force !== "boolean") throw new Error("force must be a boolean");
      if ("method" in input && !isMergeMethod(method)) throw new Error("invalid merge method");
      const baseRef = currentBaseRef(repo, number);
      return {
        kind: "merge",
        force: force === true,
        baseRef,
        method: isMergeMethod(method) ? method : mergeMethodFor(repo, baseRef),
        source: isMergeMethod(method) ? "explicit" : mergeMethodSourceFor(repo, baseRef),
      };
    }
    case "reply-to-thread": {
      const thread = reviewThreadByHandle(detail, fieldValue(input, "threadHandle"));
      const rootCommentId = thread.comments.nodes[0]?.databaseId;
      if (!Number.isInteger(rootCommentId)) throw new Error("review thread has no replyable root comment");
      return { kind: "reply-to-thread", rootCommentId: rootCommentId!, body: requiredString(input, "body") };
    }
    case "resolve-thread": {
      const resolved = fieldValue(input, "resolved");
      if ("resolved" in input && typeof resolved !== "boolean") throw new Error("resolved must be a boolean");
      const thread = reviewThreadByHandle(detail, fieldValue(input, "threadHandle"));
      return { kind: "resolve-thread", threadId: thread.id, resolved: resolved !== false };
    }
    case "comment":
      return { kind: "comment", body: requiredString(input, "body") };
    case "review-verdict": {
      const event = fieldValue(input, "event");
      if (event !== "APPROVE" && event !== "REQUEST_CHANGES" && event !== "COMMENT") throw new Error("invalid review event");
      return { kind: "review-verdict", event, body: requiredString(input, "body") };
    }
    case "update-branch":
    case "ready-for-review":
    case "close":
      return { kind: input.kind };
    case "auto-merge":
      return { kind: "auto-merge", enable: requiredBoolean(input, "enable") };
    case "github-auto-merge": {
      const enable = requiredBoolean(input, "enable");
      if (!enable) return { kind: "github-auto-merge", enable: false };
      const method = fieldValue(input, "method");
      if (!isMergeMethod(method)) throw new Error("invalid merge method");
      return { kind: "github-auto-merge", enable: true, method };
    }
    case "inline-comment": {
      const line = fieldValue(input, "line");
      const side = fieldValue(input, "side");
      if (!Number.isInteger(line) || Number(line) < 1) throw new Error("line must be a positive integer");
      if (side !== "LEFT" && side !== "RIGHT") throw new Error("side must be LEFT or RIGHT");
      const startLine = fieldValue(input, "startLine");
      const startSide = fieldValue(input, "startSide");
      if (startLine === undefined && startSide === undefined) {
        return {
          kind: "inline-comment",
          path: requiredString(input, "path"),
          line: Number(line),
          side,
          body: requiredString(input, "body"),
        };
      }
      if (!Number.isInteger(startLine) || Number(startLine) < 1) throw new Error("startLine must be a positive integer");
      if (startSide !== "LEFT" && startSide !== "RIGHT") throw new Error("startSide must be LEFT or RIGHT");
      return {
        kind: "inline-comment",
        path: requiredString(input, "path"),
        line: Number(line),
        side,
        startLine: Number(startLine),
        startSide,
        body: requiredString(input, "body"),
      };
    }
    case "assign":
    case "unassign":
    case "request-reviewers":
    case "unrequest-reviewers":
      return { kind: input.kind, logins: requiredLogins(input) };
    case "edit-body":
      return { kind: "edit-body", body: requiredString(input, "body") };
    case "edit-title":
      return { kind: "edit-title", title: requiredString(input, "title") };
    default:
      throw new Error(`unsupported mutation kind: ${input.kind}`);
  }
}

async function handleAgentMutation(owner: string, repo: string, number: string, req: Request): Promise<Response> {
  if (!validPrReference(owner, repo, number)) return json({ error: "invalid PR reference" }, 400);
  const repoName = `${owner}/${repo}`;
  const num = Number(number);
  const stored = getPr(repoName, num) ?? getCachedPrDetail(repoName, num);
  if (!stored) return json({ error: "PR is not cached yet" }, 404);
  const detail = JSON.parse(stored.detail_json) as PrDetail;
  const requestBody: unknown = await req.json().catch(() => null);
  try {
    if (!requestBody || typeof requestBody !== "object" || Array.isArray(requestBody) || !("payload" in requestBody)) {
      throw new Error("mutation payload required");
    }
    const payload = normalizeAgentMutation(repoName, num, detail, requestBody.payload);
    return json({ id: enqueueMutation({ repo: repoName, number: num, payload }) }, 201);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
}

async function handleResolveReviewThread(
  owner: string,
  repo: string,
  number: string,
  handle: string,
  runtime: HttpRuntime,
): Promise<Response> {
  if (!validPrReference(owner, repo, number) || !/^[0-9a-f]{10}$/.test(handle)) {
    return json({ error: "invalid PR reference or thread handle" }, 400);
  }
  const repoName = `${owner}/${repo}`;
  const num = Number(number);
  const stored = getPr(repoName, num) ?? getCachedPrDetail(repoName, num);
  if (!stored) return json({ error: "PR is not cached yet" }, 404);
  const detail = JSON.parse(stored.detail_json) as PrDetail;
  let thread;
  try {
    thread = reviewThreadByHandle(detail, handle);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, message.endsWith("not found") ? 404 : message.endsWith("ambiguous") ? 409 : 400);
  }
  const alreadyResolved = thread.isResolved;
  try {
    await runtime.resolveReviewThread(thread.id);
  } catch (err) {
    const status = err instanceof GithubRequestError ? err.status : 502;
    return json({ error: err instanceof Error ? err.message : "GitHub thread resolution failed" }, status);
  }
  try {
    if (getPr(repoName, num)) {
      await runtime.revalidateTrackedPr(repoName, num, "mutation recovery");
    } else {
      await runtime.revalidateCachedPrDetail(repoName, num, "mutation recovery");
    }
  } catch (err) {
    console.error(`post-resolution refresh failed for ${repoName}#${num}:`, err);
  }
  markReviewThreadResolved(repoName, num, thread.id);
  return json({ resolved: true, alreadyResolved });
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

function resolvePrContext(repoName: string, num: number): { headSha: string; baseRef: string; baseSha: string | null } | null {
  const tracked = getPr(repoName, num);
  if (tracked) {
    const detail = JSON.parse(tracked.detail_json) as { baseRefOid?: string };
    return { headSha: tracked.head_sha, baseRef: tracked.base_ref, baseSha: detail.baseRefOid ?? null };
  }
  const cached = getCachedPrDetail(repoName, num);
  if (!cached) return null;
  const detail = JSON.parse(cached.detail_json) as { baseRefName: string; baseRefOid?: string };
  return { headSha: cached.head_sha, baseRef: detail.baseRefName, baseSha: detail.baseRefOid ?? null };
}

async function handlePrConflicts(owner: string, repo: string, number: string): Promise<Response> {
  const repoName = `${owner}/${repo}`;
  const num = Number(number);
  const ctx = resolvePrContext(repoName, num);
  if (!ctx) return json({ error: "PR is not cached yet" }, 404);
  if (isMockGithub) return json({ files: mockGithub!.conflictFiles(repoName, num) });

  try {
    await fetchMirror(repoName, INCREMENTAL_FETCH_TIMEOUT_MS);
  } catch (err) {
    console.error(`conflict file fetch failed for ${repoName}#${num}:`, err);
    return json({ error: "Conflict files are still loading" }, 503);
  }

  const result = await conflictFilesFromMirror(repoName, `refs/heads/${ctx.baseRef}`, ctx.headSha);
  if (result.status === "conflicts") return json({ files: result.files });
  if (result.status === "clean") return json({ error: "No conflicts found against the latest base branch" }, 409);
  if (result.status === "merge-failed") {
    console.error(`conflict merge-tree failed for ${repoName}#${num}: ${result.error}`);
  }
  return json({ error: "Couldn't determine conflicting files" }, 503);
}

// Per-commit counts for the timeline. Aggregate mirror file lists here so large histories never
// cross into the renderer; when the mirror has nothing to say, the client uses GraphQL totals.
async function handlePrCommitStats(owner: string, repo: string, number: string, url: URL): Promise<Response> {
  if (!validPrReference(owner, repo, number)) return json({ error: "invalid PR reference" }, 400);
  const repoName = `${owner}/${repo}`;
  const num = Number(number);
  const ctx = resolvePrContext(repoName, num);
  if (!ctx) return json({ error: "PR is not cached yet" }, 404);
  if (isMockGithub || !ctx.baseSha) return json({ commits: {} });
  const testPatternSource = url.searchParams.get("testPattern");
  if (testPatternSource === null) return json({ error: "testPattern is required" }, 400);
  let testPattern: RegExp;
  try {
    testPattern = new RegExp(testPatternSource);
  } catch {
    return json({ error: "testPattern is invalid" }, 400);
  }

  let result = await commitStatsFromMirror(repoName, ctx.baseSha, ctx.headSha);
  if (result.status === "missing-commit") {
    try {
      await fetchMirror(repoName, INCREMENTAL_FETCH_TIMEOUT_MS);
      result = await commitStatsFromMirror(repoName, ctx.baseSha, ctx.headSha);
    } catch (err) {
      console.error(`commit stats mirror fetch failed for ${repoName}#${num}:`, err);
      return json({ commits: {} });
    }
  }
  if (result.status !== "ok") return json({ commits: {} });
  return json({ commits: summarizeCommitStats(result.commits, testPattern) });
}

async function handlePrDiff(owner: string, repo: string, number: string, url: URL): Promise<Response> {
  if (!validPrReference(owner, repo, number)) return json({ error: "invalid PR reference" }, 400);
  const repoName = `${owner}/${repo}`;
  const num = Number(number);
  const base = url.searchParams.get("base");
  const head = url.searchParams.get("head");

  if (base !== null) {
    if (!base || !head || !FULL_SHA_RE.test(base) || !FULL_SHA_RE.test(head)) {
      return new Response("base and head must be 40-char commit shas", { status: 400 });
    }
    if (isMockGithub) return new Response("range diffs unavailable in mock mode", { status: 404 });
    const rangeKey = `${base}..${head}`;
    const cached = getDiff(rangeKey);
    if (cached !== null) return new Response(cached, { headers: { "content-type": "text/x-diff" } });

    let result = await diffFromMirror(repoName, base, head, "two-dot");
    if (result.status === "missing-commit") {
      // mirror exists but hasn't seen these commits yet - bounded incremental fetch, retry once in-request
      try {
        await fetchMirror(repoName, INCREMENTAL_FETCH_TIMEOUT_MS);
        result = await diffFromMirror(repoName, base, head, "two-dot");
      } catch (err) {
        console.error(`incremental mirror fetch failed for ${repoName}:`, err);
        if (err instanceof MirrorFetchError && !err.timedOut) {
          // fast, non-timeout failure (bad auth, repo 404, ...) - not a "come back later" case
          return new Response("mirror fetch failed", { status: 502 });
        }
        // fetch timed out or stalled - retry it unbounded in the background, tell the client to come back
        fetchMirror(repoName).catch((bgErr) => console.error(`background mirror fetch failed for ${repoName}:`, bgErr));
        return new Response(JSON.stringify({ building: true }), {
          status: 503,
          headers: { "content-type": "application/json", "retry-after": "5" },
        });
      }
    }
    if (result.status === "ok") {
      saveDiff(rangeKey, result.patch);
      return new Response(result.patch, { headers: { "content-type": "text/x-diff" } });
    }
    if (result.status === "no-mirror") {
      // no mirror yet at all - a cold clone can take minutes, so kick it off async and tell the client to retry
      fetchMirror(repoName).catch((err) => console.error(`on-demand mirror clone failed for ${repoName}:`, err));
      return new Response(JSON.stringify({ building: true }), {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "5" },
      });
    }
    // mirror is the only backend that can serve true two-dot; GitHub's compare API is three-dot
    return new Response("mirror unavailable for this range", { status: 502 });
  }
  if (head !== null && !FULL_SHA_RE.test(head)) {
    return new Response("head must be a 40-char commit sha", { status: 400 });
  }

  const ctx = resolvePrContext(repoName, num);
  if (head !== null && !ctx) return json({ error: "PR is not cached yet" }, 404);
  const baseCommit = ctx ? ctx.baseSha ?? `refs/heads/${ctx.baseRef}` : null;
  const diffHead = head ?? ctx?.headSha ?? null;
  const diffKey = baseCommit && diffHead ? `${baseCommit}...${diffHead}` : null;
  if (ctx && baseCommit && diffHead && !isMockGithub) {
    const patch = getDiff(diffKey!);
    if (patch !== null) return new Response(patch, { headers: { "content-type": "text/x-diff" } });

    let mirrored = await diffFromMirror(repoName, baseCommit, diffHead, "three-dot");
    if (mirrored.status === "missing-commit") {
      try {
        await fetchMirror(repoName, INCREMENTAL_FETCH_TIMEOUT_MS);
        mirrored = await diffFromMirror(repoName, baseCommit, diffHead, "three-dot");
      } catch (err) {
        console.error(`incremental mirror fetch failed for ${repoName}#${num}:`, err);
        if (err instanceof MirrorFetchError && !err.timedOut) {
          return new Response("mirror fetch failed", { status: 502 });
        }
        fetchMirror(repoName).catch((bgErr) => console.error(`background mirror fetch failed for ${repoName}:`, bgErr));
        return new Response(JSON.stringify({ building: true }), {
          status: 503,
          headers: { "content-type": "application/json", "retry-after": "5" },
        });
      }
    }
    if (mirrored.status === "ok") {
      saveDiff(diffKey!, mirrored.patch);
      return new Response(mirrored.patch, { headers: { "content-type": "text/x-diff" } });
    }
    if (mirrored.status === "no-mirror") {
      fetchMirror(repoName).catch((err) => console.error(`on-demand mirror clone failed for ${repoName}:`, err));
      return new Response(JSON.stringify({ building: true }), {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "5" },
      });
    }
    return new Response("mirror unavailable for this pull request", { status: 502 });
  }

  try {
    const patch = head !== null && baseCommit
      ? await fetchDiff(repoName, num, baseCommit, head)
      : await fetchDiff(repoName, num);
    if (diffKey) saveDiff(diffKey, patch);
    return new Response(patch, { headers: { "content-type": "text/x-diff" } });
  } catch {
    return new Response("not found", { status: 404 });
  }
}

async function handleAgentPrDiff(owner: string, repo: string, number: string, url: URL): Promise<Response> {
  if (!validPrReference(owner, repo, number)) return json({ error: "invalid PR reference" }, 400);
  if (!resolvePrContext(`${owner}/${repo}`, Number(number))) return json({ error: "PR is not cached yet" }, 404);
  return handlePrDiff(owner, repo, number, url);
}

type CachedActionsContext = {
  repoName: string;
  num: number;
  headSha: string;
  currentHeadSha: string;
  baseSha: string | null;
  commits: PullRequestCommit[];
};

function cachedActionsContext(owner: string, repo: string, number: string): CachedActionsContext | Response {
  if (!validPrReference(owner, repo, number)) return json({ error: "invalid PR reference" }, 400);
  const repoName = `${owner}/${repo}`;
  const num = Number(number);
  const cached = getPr(repoName, num) ?? getCachedPrDetail(repoName, num);
  if (!cached) return json({ error: "PR is not cached yet" }, 404);
  const detail = JSON.parse(cached.detail_json) as PrDetail;
  const commits = (detail.commitList?.nodes ?? []).map(({ commit }) => ({
    sha: commit.oid,
    headline: commit.messageHeadline,
    committedAt: commit.committedDate,
  }));
  return {
    repoName,
    num,
    headSha: detail.headRefOid,
    currentHeadSha: detail.headRefOid,
    baseSha: detail.baseRefOid ?? null,
    commits,
  };
}

async function mirroredActionCommits(context: CachedActionsContext) {
  if (!context.baseSha) return null;
  let result = await commitsFromMirror(context.repoName, context.baseSha, context.currentHeadSha);
  if (result.status === "no-mirror" || result.status === "missing-commit") {
    try {
      await fetchMirror(context.repoName, INCREMENTAL_FETCH_TIMEOUT_MS);
      result = await commitsFromMirror(context.repoName, context.baseSha, context.currentHeadSha);
    } catch (error) {
      console.error(`Actions commit fetch failed for ${context.repoName}#${context.num}:`, error);
      return null;
    }
  }
  return result.status === "ok" ? result.commits : null;
}

async function selectedActionsContext(
  owner: string,
  repo: string,
  number: string,
  url: URL,
): Promise<CachedActionsContext | Response> {
  const context = cachedActionsContext(owner, repo, number);
  if (context instanceof Response) return context;
  const requested = url.searchParams.get("sha");
  if (requested === null || requested === context.currentHeadSha) return context;
  if (!FULL_SHA_RE.test(requested)) return json({ error: "invalid commit SHA" }, 400);
  if (context.commits.some((commit) => commit.sha === requested)) return { ...context, headSha: requested };
  if (!isMockGithub) {
    const commits = await mirroredActionCommits(context);
    if (commits?.some((commit) => commit.sha === requested)) return { ...context, headSha: requested };
  }
  return json({ error: "commit is not part of this pull request" }, 400);
}

async function handleActionCommits(owner: string, repo: string, number: string): Promise<Response> {
  const context = cachedActionsContext(owner, repo, number);
  if (context instanceof Response) return context;
  if (isMockGithub) return json({ headSha: context.currentHeadSha, commits: context.commits });
  const commits = await mirroredActionCommits(context);
  if (!commits) return json({ error: "Pull request commits are still loading" }, 503);
  return json({ headSha: context.currentHeadSha, commits });
}

async function handleActionsLease(owner: string, repo: string, number: string, runtime: HttpRuntime): Promise<Response> {
  const context = cachedActionsContext(owner, repo, number);
  if (context instanceof Response) return context;
  await runtime.activateActionsLease(context.repoName, context.num, context.headSha);
  return json({ ok: true });
}

function serializeActionRun(run: WorkflowRunRow) {
  return {
    id: run.run_id,
    attempt: run.run_attempt,
    workflowName: run.workflow_name,
    workflowPath: run.workflow_path,
    status: run.status,
    conclusion: run.conclusion,
    eventAt: run.event_at,
    htmlUrl: run.html_url,
  };
}

function serializeActionJob(job: RunJobRow) {
  const labels = JSON.parse(job.labels_json) as string[];
  return {
    id: job.job_id,
    runId: job.run_id,
    attempt: job.run_attempt,
    workflowName: job.workflow_name,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    htmlUrl: job.html_url,
    runnerName: job.runner_name,
    runnerGroupName: job.runner_group_name,
    labels,
    failedStep: job.failed_step,
    logBytes: job.log_bytes,
    logError: job.log_error,
  };
}

async function refreshActionsContext(context: CachedActionsContext, runtime: HttpRuntime): Promise<void> {
  if (context.headSha !== context.currentHeadSha) {
    await runtime.cacheGithubActionsForCommit(context.repoName, context.num, context.headSha);
    return;
  }
  void runtime.activateActionsLease(context.repoName, context.num, context.headSha).catch((error) => {
    console.error(`Actions cache refresh failed for ${context.repoName}#${context.num}:`, error);
  });
}
async function handleActions(owner: string, repo: string, number: string, url: URL, runtime: HttpRuntime): Promise<Response> {
  const context = await selectedActionsContext(owner, repo, number, url);
  if (context instanceof Response) return context;
  try {
    await refreshActionsContext(context, runtime);
    const runs = workflowRunsForLease(context.repoName, context.num, context.headSha)
      .sort((left, right) => Date.parse(right.event_at) - Date.parse(left.event_at))
      .map(serializeActionRun);
    const jobs = listRunJobs(context.repoName, context.headSha).map(serializeActionJob);
    return json({ headSha: context.headSha, runs, jobs });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 502);
  }
}
async function handleActionGraphs(owner: string, repo: string, number: string, url: URL, runtime: HttpRuntime): Promise<Response> {
  const context = await selectedActionsContext(owner, repo, number, url);
  if (context instanceof Response) return context;
  try {
    await refreshActionsContext(context, runtime);
    const workflows = await runtime.actionWorkflowGraphs(context.repoName, context.num, context.headSha);
    return json({ headSha: context.headSha, workflows });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 502);
  }
}


async function handleActionLog(
  owner: string,
  repo: string,
  number: string,
  jobId: string,
  url: URL,
  runtime: HttpRuntime,
): Promise<Response> {
  const context = await selectedActionsContext(owner, repo, number, url);
  if (context instanceof Response) return context;
  const id = Number(jobId);
  if (!Number.isSafeInteger(id) || id <= 0) return json({ error: "invalid job id" }, 400);
  try {
    const result = await runtime.actionJobLog(context.repoName, context.headSha, id);
    if (!result) return json({ error: "job is not cached for this PR commit" }, 404);
    return json({
      job: serializeActionJob(result.job),
      body: result.body,
      state: result.state,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 502);
  }
}

function handleAgentPrJobs(owner: string, repo: string, number: string): Response {
  const context = cachedActionsContext(owner, repo, number);
  if (context instanceof Response) return context;
  return new Response(formatRunJobs(context.headSha, listRunJobs(context.repoName, context.headSha)), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

async function handleAgentCacheRun(
  owner: string,
  repo: string,
  number: string,
  runId: string,
  runtime: HttpRuntime,
): Promise<Response> {
  const context = cachedActionsContext(owner, repo, number);
  if (context instanceof Response) return context;
  const id = Number(runId);
  if (!Number.isSafeInteger(id) || id <= 0) return json({ error: "valid Actions run ID required" }, 400);

  try {
    const result = await runtime.cacheActionsRun(context.repoName, context.num, context.headSha, id);
    if (result === "head-mismatch") {
      return json({ error: "Actions run does not belong to the current PR head" }, 409);
    }
    const jobs = listRunJobs(context.repoName, context.headSha).filter((job) => job.run_id === id);
    return new Response(`Actions run ${id}: ${result}\n\n${formatRunJobs(context.headSha, jobs)}`, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 502);
  }
}

async function handleAgentPrLogs(owner: string, repo: string, number: string, url: URL): Promise<Response> {
  const context = cachedActionsContext(owner, repo, number);
  if (context instanceof Response) return context;
  const check = url.searchParams.get("check") ?? undefined;
  const entries = await cachedJobLogs(context.repoName, context.headSha, check);
  return new Response(formatJobLogs(context.headSha, entries), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

async function handleAgentPrFile(owner: string, repo: string, number: string, url: URL): Promise<Response> {
  if (!validPrReference(owner, repo, number)) return json({ error: "invalid PR reference" }, 400);
  const path = url.searchParams.get("path") ?? "";
  if (!path || path.startsWith("/") || path.includes("\0")) return json({ error: "valid path query param required" }, 400);

  const repoName = `${owner}/${repo}`;
  const num = Number(number);
  const ctx = resolvePrContext(repoName, num);
  if (!ctx) return json({ error: "PR is not cached yet" }, 404);

  const cached = getFileContents(ctx.headSha, path);
  if (cached !== null) return new Response(cached, { headers: { "content-type": "text/plain; charset=utf-8" } });
  if (isMockGithub) return json({ error: "file is not cached" }, 404);

  let result = await fileFromMirror(repoName, ctx.headSha, path);
  if (result.status === "no-mirror") {
    fetchMirror(repoName).catch((err) => console.error(`on-demand mirror clone failed for ${repoName}:`, err));
    return new Response(JSON.stringify({ building: true }), {
      status: 503,
      headers: { "content-type": "application/json", "retry-after": "5" },
    });
  }
  if (result.status === "missing-commit") {
    try {
      await fetchMirror(repoName, INCREMENTAL_FETCH_TIMEOUT_MS);
      result = await fileFromMirror(repoName, ctx.headSha, path);
    } catch (err) {
      console.error(`incremental mirror fetch failed for ${repoName}#${num}:`, err);
      if (err instanceof MirrorFetchError && !err.timedOut) return json({ error: "mirror fetch failed" }, 502);
      fetchMirror(repoName).catch((bgErr) => console.error(`background mirror fetch failed for ${repoName}:`, bgErr));
      return new Response(JSON.stringify({ building: true }), {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "5" },
      });
    }
  }
  if (result.status === "ok") {
    saveFileContents(ctx.headSha, path, result.content);
    return new Response(result.content, { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  if (result.status === "not-found" || result.status === "missing-commit") return json({ error: "not found" }, 404);
  return json({ error: "mirror read failed" }, 502);
}

async function handleSearchPrs(url: URL): Promise<Response> {
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (!q) return json({ results: [] });
  const repos = await trackedRepos();
  const results = await searchPrs(repos, q);
  const numMatch = q.match(/^#?(\d+)$/);
  if (numMatch) {
    const number = Number(numMatch[1]);
    const lookups = await Promise.all(repos.map((r) => lookupPr(r, number).catch(() => null)));
    for (const hit of lookups) {
      if (hit && !results.some((r) => r.repo === hit.repo && r.number === hit.number)) {
        results.unshift(hit);
      }
    }
  }
  return json({ results });
}

async function handleFile(url: URL): Promise<Response> {
  const repo = url.searchParams.get("repo");
  const path = url.searchParams.get("path");
  const sha = url.searchParams.get("sha");
  if (!repo || !path || !sha) return json({ error: "repo, path and sha query params required" }, 400);

  const cached = getFileContents(sha, path);
  if (cached !== null) return json({ content: cached });

  try {
    const result = await fetchFileContents(repo, path, sha);
    if ("tooLarge" in result) return json({ tooLarge: true });
    saveFileContents(sha, path, result.content);
    return json({ content: result.content });
  } catch {
    return json({ error: "not found" }, 404);
  }
}

const CANONICAL_REPO_RE = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;
const MAX_COMMIT_HEADLINE_LENGTH = 200;
function isRepoFilePath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !value.startsWith("/")
    && !value.includes("\0")
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isWorkflowScopeError(path: string, error: unknown): boolean {
  return path.startsWith(".github/workflows/")
    && error instanceof GithubRequestError
    && (
      error.graphqlErrors.some(({ type, message }) =>
        type === "FORBIDDEN" && /personal access token/i.test(message ?? ""))
      || /REST request failed: 403.*(?:personal access token|resource not accessible)/is.test(error.message)
    );
}
const AUTH_SCOPE_ALLOWED: Record<string, true> = { repo: true, workflow: true };

function requestedAuthScopes(value: unknown): string[] | null {
  if (value === undefined) return ["repo", "workflow"];
  if (!Array.isArray(value) || value.length === 0) return null;
  const scopes = [...new Set(value)];
  return scopes.every((scope) => typeof scope === "string" && AUTH_SCOPE_ALLOWED[scope]) ? scopes.sort() as string[] : null;
}

function githubSetupResponse(auth: GithubAuthStatus, status = 401): Response {
  return json({ error: auth.error ?? "GitHub setup required.", code: "github-setup", auth }, status);
}




async function handlePrFileEdit(req: Request, runtime: HttpRuntime): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "invalid file edit request" }, 400);
  }
  const { repo, number, path, expectedHeadOid, content, message } = body as Record<string, unknown>;
  if (
    typeof repo !== "string"
    || !CANONICAL_REPO_RE.test(repo)
    || typeof number !== "number"
    || !Number.isSafeInteger(number)
    || number <= 0
    || !isRepoFilePath(path)
    || typeof expectedHeadOid !== "string"
    || !FULL_SHA_RE.test(expectedHeadOid)
    || typeof content !== "string"
    || !content.isWellFormed()
    || typeof message !== "string"
  ) {
    return json({ error: "invalid file edit request" }, 400);
  }

  const headline = message.trim();
  if (!headline || headline.length > MAX_COMMIT_HEADLINE_LENGTH || /[\r\n]/.test(headline)) {
    return json({ error: "invalid file edit request" }, 400);
  }

  try {
    const { commitOid } = await runtime.commitPrFileEdit({
      repo,
      number,
      path,
      expectedHeadOid: expectedHeadOid.toLowerCase(),
      content,
      message: headline,
    });
    void runtime.refreshPr(repo, number, "file edit").catch((error) => console.error(`PR detail refresh failed after file edit for ${repo}#${number}:`, error));
    return json({ ok: true, commitOid });
  } catch (error) {
    if (error instanceof StalePrHeadError) {
      return json({ error: error.message, code: "stale-head" }, 409);
    }
    const workflowScopeMissing = isWorkflowScopeError(path, error);
    const requiredScopes = workflowScopeMissing ? ["repo", "workflow"] : ["repo"];
    let auth = await runtime.githubAuthStatus(requiredScopes);
    if (workflowScopeMissing && auth.ok) {
      auth = { ...auth, ok: false, state: "missing-scopes", error: "Allow workflow access.", missingScopes: ["workflow"] };
    }
    if (!auth.ok) return githubSetupResponse(auth, 403);
    console.error(`PR file edit failed for ${repo}#${number}:`, error);
    return json({ error: "GitHub commit failed" }, 502);
  }
}

async function handleCommitMessage(req: Request, runtime: HttpRuntime): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "invalid commit message request" }, 400);
  }
  const { repo, number, path, hunk } = body as Record<string, unknown>;
  if (
    typeof repo !== "string"
    || !CANONICAL_REPO_RE.test(repo)
    || typeof number !== "number"
    || !Number.isSafeInteger(number)
    || number <= 0
    || !isRepoFilePath(path)
    || typeof hunk !== "string"
    || hunk.length === 0
    || hunk.length > 30_000
    || !hunk.isWellFormed()
  ) {
    return json({ error: "invalid commit message request" }, 400);
  }

  const stored = getPr(repo, number) ?? getCachedPrDetail(repo, number);
  if (!stored) return json({ error: "PR is not cached yet" }, 404);
  const detail = JSON.parse(stored.detail_json) as { title?: string };
  const title = detail.title ?? ("title" in stored && typeof stored.title === "string" ? stored.title : "");
  try {
    const message = await runtime.generateCommitMessage({
      title,
      path,
      hunk,
    });
    return json({ message });
  } catch (error) {
    if (error instanceof CommitMessageError) {
      return json({ error: error.message, code: error.code }, error.code === "omp-auth" ? 409 : 503);
    }
    console.error(`Commit message generation failed for ${repo}#${number}:`, error);
    return json({ error: "Commit message generation failed" }, 502);
  }
}

const REPO_RE = /^[^/]+\/[^/]+$/;
// headRef reaches `git fetch origin <ref>` - a leading-dash value would be parsed as a git option, so forbid it
const REF_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

const MIN_SEARCH_QUERY = 2;

async function handleRepoSearch(req: Request, url: URL): Promise<Response> {
  const repo = url.searchParams.get("repo") ?? "";
  const sha = url.searchParams.get("sha") ?? "";
  const headRef = url.searchParams.get("headRef") ?? "";
  const q = url.searchParams.get("q") ?? "";
  if (!REPO_RE.test(repo) || !FULL_SHA_RE.test(sha) || !REF_RE.test(headRef)) return json({ error: "invalid repo/sha/headRef" }, 400);
  if (q.length < MIN_SEARCH_QUERY) return json({ status: "ok", matches: [] });
  const ctx = searchCtx(repo, headRef, sha);
  if (ctx.status !== "ok") return json({ status: ctx.status });
  return json({ status: "ok", matches: await grep(ctx.checkout, sha, q, req.signal) });
}
async function handleRepoDefinition(req: Request, url: URL): Promise<Response> {
  const repo = url.searchParams.get("repo") ?? "";
  const sha = url.searchParams.get("sha") ?? "";
  const headRef = url.searchParams.get("headRef") ?? "";
  const symbol = url.searchParams.get("symbol") ?? "";
  const fromPath = url.searchParams.get("path") ?? "";
  if (!REPO_RE.test(repo) || !FULL_SHA_RE.test(sha) || !REF_RE.test(headRef) || !symbol || symbol.length > 200 || !fromPath) {
    return json({ error: "invalid repo/sha/headRef/symbol/path" }, 400);
  }
  const line = Number(url.searchParams.get("line") ?? "");
  const character = Number(url.searchParams.get("col") ?? "");
  const query = Number.isInteger(line) && line > 0 && Number.isInteger(character) && character >= 0
    ? { repo, position: { line, character } }
    : undefined;
  const ctx = searchCtx(repo, headRef, sha);
  if (ctx.status !== "ok") return json({ status: ctx.status });
  const result = await findDefinition(ctx.checkout, sha, symbol, fromPath, req.signal, query);
  return json({ status: "ok", ...result });
}


async function handleRepoFiles(url: URL): Promise<Response> {
  const repo = url.searchParams.get("repo") ?? "";
  const sha = url.searchParams.get("sha") ?? "";
  const headRef = url.searchParams.get("headRef") ?? "";
  if (!REPO_RE.test(repo) || !FULL_SHA_RE.test(sha) || !REF_RE.test(headRef)) return json({ error: "invalid repo/sha/headRef" }, 400);
  const ctx = searchCtx(repo, headRef, sha);
  if (ctx.status !== "ok") return json({ status: ctx.status });
  return json({ status: "ok", paths: lsTree(ctx.checkout, repo, sha) });
}

async function handleRepoFile(url: URL): Promise<Response> {
  const repo = url.searchParams.get("repo") ?? "";
  const sha = url.searchParams.get("sha") ?? "";
  const headRef = url.searchParams.get("headRef") ?? "";
  const path = url.searchParams.get("path") ?? "";
  if (!REPO_RE.test(repo) || !FULL_SHA_RE.test(sha) || !REF_RE.test(headRef) || !path) {
    return json({ error: "invalid repo/sha/headRef/path" }, 400);
  }
  const ctx = searchCtx(repo, headRef, sha);
  if (ctx.status !== "ok") return json({ status: ctx.status });
  const content = showFile(ctx.checkout, sha, path);
  if (content === null) return json({ status: "not-found" });
  return json({ status: "ok", content });
}

const FILE_HISTORY_TTL_MS = 5 * 60_000;
const FILE_HISTORY_CAP = 200;
const fileHistoryCache = new Map<string, { commits: FileHistoryCommit[]; fetchedAt: number }>();

async function handleFileHistory(req: Request, url: URL): Promise<Response> {
  const repo = url.searchParams.get("repo") ?? "";
  const path = url.searchParams.get("path") ?? "";
  const base = url.searchParams.get("base") ?? "";
  const symbol = url.searchParams.get("symbol") ?? "";
  const baseSha = url.searchParams.get("baseSha") ?? "";
  if (!REPO_RE.test(repo) || !path || !REF_RE.test(base)) return json({ error: "invalid repo/path/base" }, 400);
  if (symbol && (!FULL_SHA_RE.test(baseSha) || symbol.length > 200)) {
    return json({ error: "invalid symbol history ref" }, 400);
  }
  const key = `${repo}\n${base}\n${path}\n${baseSha}\n${symbol}`;
  const cached = fileHistoryCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < FILE_HISTORY_TTL_MS) return json({ commits: cached.commits });
  try {
    let commits: FileHistoryCommit[];
    if (symbol) {
      const ctx = searchCtx(repo, base, baseSha);
      if (ctx.status !== "ok") return json({ error: ctx.status }, 503);
      commits = await symbolMentionHistory(ctx.checkout, baseSha, path, symbol, req.signal);
    } else {
      commits = await fetchFileHistory(repo, path, base);
    }
    if (fileHistoryCache.size >= FILE_HISTORY_CAP) {
      const oldest = fileHistoryCache.keys().next().value;
      if (oldest !== undefined) fileHistoryCache.delete(oldest);
    }
    fileHistoryCache.set(key, { commits, fetchedAt: Date.now() });
    return json({ commits });
  } catch (err) {
    console.error("file history fetch failed:", err);
    return json({ error: "couldn't load file history" }, 502);
  }
}

const FILE_HISTORY_DIFF_CAP = 200;
type CachedFileHistoryDiff = FileHistoryDiff | { localPatch: string } | null;
const fileHistoryDiffCache = new Map<string, CachedFileHistoryDiff>();

async function handleFileHistoryDiff(req: Request, url: URL): Promise<Response> {
  const repo = url.searchParams.get("repo") ?? "";
  const sha = url.searchParams.get("sha") ?? "";
  const path = url.searchParams.get("path") ?? "";
  const local = url.searchParams.get("local") === "1";
  if (!REPO_RE.test(repo) || !FULL_SHA_RE.test(sha) || !path) return json({ error: "invalid repo/sha/path" }, 400);
  const key = `${local ? "local" : "github"}\n${repo}\n${sha}\n${path}`;
  if (fileHistoryDiffCache.has(key)) return json(fileHistoryDiffCache.get(key) ?? { notFound: true });
  try {
    let entry: CachedFileHistoryDiff;
    if (local) {
      const ctx = searchCtx(repo, "", sha);
      if (ctx.status !== "ok") return json({ error: ctx.status }, 503);
      const patch = await localFileHistoryPatch(ctx.checkout, sha, path, req.signal);
      entry = patch === null ? null : { localPatch: patch };
    } else {
      entry = await fetchFileHistoryDiff(repo, sha, path);
    }
    if (fileHistoryDiffCache.size >= FILE_HISTORY_DIFF_CAP) {
      const oldest = fileHistoryDiffCache.keys().next().value;
      if (oldest !== undefined) fileHistoryDiffCache.delete(oldest);
    }
    fileHistoryDiffCache.set(key, entry);
    return json(entry ?? { notFound: true });
  } catch (err) {
    console.error("file history diff fetch failed:", err);
    return json({ error: "couldn't load diff" }, 502);
  }
}

const PR_INDEX_KEY_CAP = 100;
const PR_INDEX_KEY_RE = /^([^/]+\/[^/]+)#(\d+)$/;

function prIndexResponse(rows: PrIndexRow[]): Response {
  return json({
    prs: rows.map((r) => ({
      repo: r.repo,
      number: r.number,
      title: r.title,
      state: r.state,
      isDraft: r.is_draft === 1,
      author: r.author,
      updatedAt: r.updated_at,
    })),
  });
}

async function handlePrIndex(url: URL, runtime: HttpRuntime): Promise<Response> {
  const requestedKeys = url.searchParams.get("keys");
  if (requestedKeys === null) return prIndexResponse(listPrIndex());

  const requested = requestedKeys
    .split(",")
    .slice(0, PR_INDEX_KEY_CAP)
    .flatMap((key) => {
      const match = PR_INDEX_KEY_RE.exec(key);
      return match ? [{ key, repo: match[1]!, number: Number(match[2]) }] : [];
    });
  const byKey = new Map(listPrIndex().map((row) => [prKey(row), row]));
  const missingByRepo = new Map<string, number[]>();
  for (const ref of requested) {
    if (byKey.has(ref.key)) continue;
    const numbers = missingByRepo.get(ref.repo) ?? [];
    numbers.push(ref.number);
    missingByRepo.set(ref.repo, numbers);
  }

  const lookups = await Promise.allSettled(
    [...missingByRepo].map(([repo, numbers]) => runtime.lookupPrIndexes(repo, numbers)),
  );
  for (const result of lookups) {
    if (result.status === "rejected") {
      console.error("PR title lookup failed:", result.reason);
      continue;
    }
    upsertPrIndex(result.value);
    for (const entry of result.value) {
      byKey.set(prKey(entry), {
        repo: entry.repo,
        number: entry.number,
        title: entry.title,
        state: entry.state,
        is_draft: entry.isDraft ? 1 : 0,
        author: entry.author,
        updated_at: entry.updatedAt,
        merged_at: entry.mergedAt ?? null,
        closed_at: entry.closedAt ?? null,
        involves_me: entry.involvesMe ? 1 : 0,
      });
    }
  }

  return prIndexResponse(requested.flatMap(({ key }) => {
    const row = byKey.get(key);
    return row ? [row] : [];
  }));
}

async function handleRefresh(): Promise<Response> {
  const result = await pollOnce();
  return json(result);
}

async function handlePutSettings(req: Request): Promise<Response> {
  let body: Partial<{
    repos: string;
    default_repo: string;
    poll_interval_s: number;
    replica_ssh_host: string;
    per_view_window_size: boolean;
    per_view_window_position: boolean;
    theme: string;
    font_interface: string;
    font_ui: string;
    font_code: string;
    font_comments: string;
    code_theme: string;
    general_scale: number;
    diff_scale: number;
    hide_sidebar: boolean;
    hide_tests_default: boolean;
    newest_comments_first: boolean;
    test_path_regex: string;
    diff_layout: string;
    force_merge_repos: string;
    agents: AgentSetting[];
    keybind_open_app: string;
    keybind_open_palette: string;
    agent_harness: string;
    relay_url: string;
  }>;
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const previousReplica = readSettings().replica_ssh_host;
  let settings: Settings;
  try {
    settings = writeSettings(body);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
  if (settings.replica_ssh_host !== previousReplica && Bun.env.COCKPIT_LAUNCHER) {
    setTimeout(() => process.exit(1), 250);
  }
  return json(withAgentPromptDefaults(settings));
}

const AGENT_PROMPT_DEFAULTS: Record<string, () => string> = {
  fixer: defaultFixerTemplate,
  autofix: defaultAutofixTemplate,
  rescorer: defaultRescorePrompt,
};

function withAgentPromptDefaults(settings: Settings) {
  return {
    ...settings,
    agents: settings.agents.map((a) => ({ ...a, prompt_default: AGENT_PROMPT_DEFAULTS[a.id]?.() ?? "" })),
    agent_defaults: AGENT_DEFAULTS,
    harness_available: { claude: claudeBinPath() !== null, omp: ompBinPath() !== null },
  };
}

function handleRelayStatus(): Response {
  return json({ url: relayConfig().url, ...relayStatus() });
}

let coverageErrorLogged = false;

let appExistsCache: { value: boolean; fetchedAt: number } | null = null;

async function relayAppExists(): Promise<boolean> {
  if (isMockGithub) return true;
  if (appExistsCache && Date.now() - appExistsCache.fetchedAt < 10 * 60_000) return appExistsCache.value;
  let exists = true;
  try {
    const res = await fetch(`https://api.github.com/apps/${RELAY_APP_SLUG}`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    exists = res.status !== 404;
  } catch {
    exists = true;
  }
  appExistsCache = { value: exists, fetchedAt: Date.now() };
  return exists;
}

async function handleRelayCoverage(url: URL): Promise<Response> {
  const param = url.searchParams.get("repos");
  const repos = param !== null ? param.split(",").map((r) => r.trim()).filter(Boolean) : settingsRepos();
  if (isMockGithub) {
    return json({ repos: Object.fromEntries(repos.map((repo) => [repo, true])), installUrl: RELAY_APP_INSTALL_URL, appExists: true });
  }
  const appExists = await relayAppExists();
  try {
    return json({ repos: await relayCoverage(repos), installUrl: RELAY_APP_INSTALL_URL, appExists });
  } catch (err) {
    if (!coverageErrorLogged) {
      console.warn("relay coverage lookup failed:", err);
      coverageErrorLogged = true;
    }
    return json({ repos: null, installUrl: RELAY_APP_INSTALL_URL, appExists });
  }
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const GITHUB_APP_EVENTS = [
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_review_thread",
  "issue_comment",
  "check_run",
  "check_suite",
  "status",
  "push",
  "workflow_run",
  "workflow_job",
];

function handleGithubAppStart(url: URL, port: number): Response {
  const org = url.searchParams.get("org") ?? "";
  if (!org) return html("<p>missing org query param</p>", 400);
  const manifest = {
    name: "pr-cockpit-relay",
    url: "https://github.com/theolundqvist/pr-cockpit",
    hook_attributes: { url: `${relayConfig().url}/github`, active: true },
    redirect_url: `http://127.0.0.1:${port}/api/github-app/callback`,
    public: true,
    default_permissions: { pull_requests: "read", checks: "read", statuses: "read", issues: "read", contents: "read", actions: "read", metadata: "read" },
    default_events: GITHUB_APP_EVENTS,
  };
  return html(`<!doctype html>
<meta charset="utf-8">
<title>pr-cockpit — GitHub App setup</title>
<body onload="document.forms[0].submit()">
<form method="post" action="https://github.com/organizations/${escapeHtml(encodeURIComponent(org))}/settings/apps/new">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
</form>
<p>Redirecting to GitHub…</p>
</body>`);
}

async function handleGithubAppCallback(url: URL): Promise<Response> {
  if (isMockGithub) return html("<p>GitHub App setup is unavailable in screenshot fixture mode.</p>", 404);
  const code = url.searchParams.get("code") ?? "";
  const res = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "user-agent": "pr-cockpit" },
  });
  if (!res.ok) {
    return html(
      `<!doctype html>
<meta charset="utf-8">
<title>pr-cockpit — GitHub App setup failed</title>
<p>GitHub rejected the app-creation code (it expires after a few minutes and is single-use). Go back to cockpit Settings and click "Set up GitHub App…" again.</p>`,
      502,
    );
  }
  const { html_url, webhook_secret } = (await res.json()) as { html_url: string; webhook_secret: string; slug: string };
  return html(`<!doctype html>
<meta charset="utf-8">
<title>pr-cockpit — GitHub App created</title>
<h1>GitHub App created</h1>
<ol>
<li><a href="${escapeHtml(html_url)}/installations/new">Install it on your org</a> and select the repos to relay.</li>
<li>Point the relay at the new webhook secret (this secret is shown only on this local page):
<pre>cd relay &amp;&amp; echo '${escapeHtml(webhook_secret)}' | bunx wrangler secret put WEBHOOK_SECRET</pre></li>
</ol>`);
}

function handleHealthz(): Response {
  return json({ root: cockpitRoot, lastPollAt, prCount: countPrs(), replica: replicaEnabled() ? replicaStatus() : null });
}

function handleShutdown(): Response {
  setTimeout(() => process.exit(0), 100);
  return json({ ok: true });
}

let updateSpawned = false;

// mirrors the shell's updateAndRestart gating: resolves only once the pull settles, success or failure
function handleUpdate(): Promise<Response> {
  if (updateSpawned) return Promise.resolve(json({ ok: true }));
  updateSpawned = true;
  const root = `${import.meta.dir}/..`;
  const child = spawn(`${root}/scripts/update`, [], { cwd: root, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (!settled && stdout.includes("PULL_OK")) {
        settled = true;
        child.unref();
        resolve(json({ ok: true }));
      }
    });
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.once("exit", () => {
      if (settled) return;
      settled = true;
      updateSpawned = false;
      const match = stderr.match(/UPDATE_FAILED (.*)/);
      resolve(json({ error: match?.[1]?.trim() || "update failed" }, 500));
    });
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      updateSpawned = false;
      resolve(json({ error: err.message }, 500));
    });
  });
}

function serializeMutation(row: MutationRow) {
  return {
    id: row.id,
    repo: row.repo,
    number: row.number,
    kind: row.kind,
    payload: JSON.parse(row.payload_json),
    state: row.state === "refreshing" ? "pending" : row.state,
    error: row.error,
    createdAt: row.created_at,
  };
}

async function handleEnqueueMutation(req: Request): Promise<Response> {
  const body = (await req.json()) as { repo: string; number: number; payload: MutationPayload };
  try {
    const id = enqueueMutation({ repo: body.repo, number: body.number, payload: body.payload });
    return json({ id }, 201);
  } catch (err) {
    return json({ error: String(err) }, 400);
  }
}

function handleListMutations(url: URL): Response {
  const repo = url.searchParams.get("repo");
  const number = url.searchParams.get("number");
  if (!repo || !number) return json({ error: "repo and number query params required" }, 400);
  return json({ mutations: mutationsForPr(repo, Number(number)).map(serializeMutation) });
}

function handleRetryMutation(id: string): Response {
  retryMutation(Number(id));
  return json({ ok: true });
}

function handleDiscardMutation(id: string): Response {
  discardMutation(Number(id));
  return json({ ok: true });
}

async function handleSetArchived(req: Request): Promise<Response> {
  const body = (await req.json()) as { repo: string; number: number; archived: boolean };
  setArchived(body.repo, body.number, body.archived);
  invalidateInbox();
  return json({ ok: true });
}

async function handleReorder(req: Request): Promise<Response> {
  const body = (await req.json()) as { repo: string; number: number; position: number | null };
  if (body.position === null) {
    unsetRank(body.repo, body.number);
  } else {
    setRank(body.repo, body.number, body.position);
  }
  invalidateInbox();
  return json({ ok: true });
}

function runGit(root: string, args: string[]): { success: boolean; stdout: string; stderr: string } {
  try {
    const proc = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
    return { success: proc.success, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  } catch (err) {
    return { success: false, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

function gitMessage(result: { stdout: string; stderr: string }): string {
  return [result.stderr, result.stdout].join("\n").trim().replace(/\s+/g, " ") || "Git refused the branch switch.";
}

async function handleSwitchBranch(req: Request): Promise<Response> {
  const body = (await req.json()) as { repo?: string; headRef?: string };
  const repo = body.repo;
  const headRef = body.headRef?.trim();
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo) || !headRef) {
    return json({ error: "repo and headRef are required" }, 400);
  }

  const checkoutPath = localCheckoutPathFor(repo);
  if (!checkoutPath) return json({ error: "no local checkout found for this repository" }, 404);

  if (!runGit(checkoutPath, ["check-ref-format", "--branch", headRef]).success) {
    return json({ error: "headRef must be a local branch name" }, 400);
  }
  if (!runGit(checkoutPath, ["show-ref", "--verify", "--quiet", `refs/heads/${headRef}`]).success) {
    return json({ error: `branch ${headRef} is not available in ${checkoutPath}` }, 404);
  }

  const currentBranch = runGit(checkoutPath, ["branch", "--show-current"]);
  if (!currentBranch.success) return json({ error: `couldn't inspect ${checkoutPath}: ${gitMessage(currentBranch)}` }, 503);
  const previousBranch = currentBranch.stdout.trim();
  if (previousBranch === headRef) {
    setLocalCheckoutBranch(repo, headRef);
    return json({ ok: true, alreadyOnBranch: true, checkoutPath, branch: headRef });
  }

  const existingWorktree = worktreePathFor(repo, headRef);
  if (existingWorktree && existingWorktree !== checkoutPath) {
    const status = runGit(existingWorktree, ["status", "--porcelain"]);
    if (!status.success) return json({ error: `couldn't inspect ${existingWorktree}: ${gitMessage(status)}` }, 503);
    if (status.stdout.trim()) {
      return json({ error: `${headRef} has uncommitted changes in ${existingWorktree}; won't check it out twice.` }, 409);
    }
  }

  const switched = runGit(checkoutPath, ["switch", "--ignore-other-worktrees", headRef]);
  if (!switched.success) return json({ error: `couldn't switch ${checkoutPath}: ${gitMessage(switched)}` }, 409);

  setLocalCheckoutBranch(repo, headRef);
  return json({ ok: true, checkoutPath, previousBranch, branch: headRef });
}

export function buildFetchHandler(port: number, dependencyOverrides: Partial<HttpDependencies> = {}) {
  const dependencies: HttpDependencies = { ...defaultHttpDependencies, ...dependencyOverrides };
  const runtime: HttpRuntime = {
    ...dependencies,
    revalidateCachedPrDetail: createPrDetailRevalidator((repo, number, source) =>
      revalidateCachedPrDetail(repo, number, dependencies.fetchPrDetail, source)
    ),
    revalidateTrackedPr: createPrDetailRevalidator(async (repo, number, source) => {
      await dependencies.refreshPr(repo, number, source);
    }),
  };
  const webhookRoute = buildWebhookRoutes();
  return async function fetchHandler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (isMockGithub && url.pathname === "/api/image") {
      return handleMockImage(url);
    }
    if (isMockGithub && req.method !== "GET") {
      let allowed = (req.method === "POST" && url.pathname === "/api/archive")
        || (req.method === "POST" && url.pathname === "/api/commit-message")
        || (req.method === "POST" && url.pathname === "/api/auth/setup")
        || (req.method === "PUT" && url.pathname === "/api/settings")
        || (req.method === "POST" && parts.length === 6 && parts[0] === "api" && parts[1] === "pr" && parts[5] === "merge-method");
      if (!allowed && req.method === "POST" && url.pathname === "/api/mutations") {
        const body: unknown = await req.clone().json().catch(() => null);
        allowed = Boolean(
          body && typeof body === "object" && "payload" in body &&
          body.payload && typeof body.payload === "object" && "kind" in body.payload &&
          body.payload.kind === "github-auto-merge",
        );
      }
      if (!allowed) return json({ error: "screenshot fixture mode is read-only" }, 405);
    }

    if (req.method === "GET" && url.pathname === "/api/replica/inbox") {
      return replicaSnapshotResponse(req);
    }
    if (req.method === "GET" && url.pathname === "/api/replica/status") {
      return json(replicaStatus());
    }
    const replicaResponse = await proxyReplicaRequest(req, url);
    if (replicaResponse) return replicaResponse;

    if (req.method === "GET") {
      const openPrResponse = handleOpenPr(parts);
      if (openPrResponse) return openPrResponse;
    }

    const webhookResponse = await webhookRoute(req, url);
    if (webhookResponse) return webhookResponse;

    if (req.method === "GET" && url.pathname === "/api/quota") {
      return handleGithubQuota(runtime);
    }
    if (req.method === "GET" && url.pathname === "/api/github-usage") {
      return handleGithubUsage(runtime);
    }
    if (req.method === "GET" && url.pathname === "/api/inbox") {
      return handleInbox(url);
    }
    if (req.method === "GET" && url.pathname === "/api/closed") {
      return handleClosed(url);
    }
    if (req.method === "GET" && url.pathname === "/api/auth/status") {
      const scopes = requestedAuthScopes(url.searchParams.get("scopes")?.split(","));
      return scopes ? json(await runtime.githubAuthStatus(scopes)) : json({ error: "invalid auth scopes" }, 400);
    }
    if (req.method === "POST" && url.pathname === "/api/auth/setup") {
      const body = await req.json().catch(() => null) as { scopes?: unknown } | null;
      const scopes = requestedAuthScopes(body?.scopes);
      return scopes ? json(await runtime.startGithubSetup(scopes)) : json({ error: "invalid auth scopes" }, 400);
    }
    if (req.method === "GET" && url.pathname === "/api/onboarding/repos") {
      return handleOnboardingRepos();
    }
    if (req.method === "GET" && url.pathname === "/api/repo-users") {
      return handleRepoUsers(url);
    }
    if (req.method === "POST" && url.pathname === "/api/archive") {
      return handleSetArchived(req);
    }
    if (req.method === "POST" && url.pathname === "/api/inbox/reorder") {
      return handleReorder(req);
    }
    if (req.method === "GET" && url.pathname === "/api/search-prs") {
      return handleSearchPrs(url);
    }
    if (req.method === "GET" && url.pathname === "/api/pr-index") {
      return handlePrIndex(url, runtime);
    }
    if (req.method === "GET" && url.pathname === "/api/pr-details") {
      return handlePrDetails(url);
    }
    if (req.method === "GET" && url.pathname === "/api/file") {
      return handleFile(url);
    }
    if (req.method === "POST" && url.pathname === "/api/pr-file-edit") {
      return handlePrFileEdit(req, runtime);
    }
    if (req.method === "POST" && url.pathname === "/api/commit-message") {
      return handleCommitMessage(req, runtime);
    }
    if (req.method === "GET" && url.pathname === "/api/file-history") {
      return handleFileHistory(req, url);
    }
    if (req.method === "GET" && url.pathname === "/api/file-history/diff") {
      return handleFileHistoryDiff(req, url);
    }
    if (req.method === "GET" && url.pathname === "/api/repo-search") {
      return handleRepoSearch(req, url);
    }
    if (req.method === "GET" && url.pathname === "/api/repo-definition") {
      return handleRepoDefinition(req, url);
    }
    if (req.method === "GET" && url.pathname === "/api/repo-files") {
      return handleRepoFiles(url);
    }
    if (req.method === "GET" && url.pathname === "/api/repo-file") {
      return handleRepoFile(url);
    }
    if (req.method === "GET" && url.pathname === "/api/image") {
      return handleImage(url);
    }
    if (req.method === "GET" && url.pathname === "/api/relay/status") {
      return handleRelayStatus();
    }
    if (req.method === "GET" && url.pathname === "/api/relay/coverage") {
      return handleRelayCoverage(url);
    }
    if (req.method === "GET" && url.pathname === "/api/github-app/start") {
      return handleGithubAppStart(url, port);
    }
    if (req.method === "GET" && url.pathname === "/api/github-app/callback") {
      return handleGithubAppCallback(url);
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      return handleHealthz();
    }
    if (req.method === "POST" && url.pathname === "/api/shutdown") {
      return handleShutdown();
    }
    if (req.method === "GET" && url.pathname === "/api/version") {
      return json({ updateAvailable: isUpdateAvailable(), rev: runningRev() });
    }
    if (req.method === "POST" && url.pathname === "/api/update") {
      return handleUpdate();
    }
    if (req.method === "POST" && url.pathname === "/api/refresh") {
      return handleRefresh();
    }
    if (req.method === "GET" && url.pathname === "/api/settings") {
      return json(withAgentPromptDefaults(readSettings()));
    }
    if (req.method === "PUT" && url.pathname === "/api/settings") {
      return handlePutSettings(req);
    }
    if (req.method === "POST" && url.pathname === "/api/mutations") {
      return handleEnqueueMutation(req);
    }
    if (req.method === "GET" && url.pathname === "/api/mutations") {
      return handleListMutations(url);
    }
    if (
      req.method === "POST" &&
      parts.length === 4 &&
      parts[0] === "api" &&
      parts[1] === "mutations" &&
      parts[3] === "retry"
    ) {
      return handleRetryMutation(parts[2]!);
    }
    if (req.method === "DELETE" && parts.length === 3 && parts[0] === "api" && parts[1] === "mutations") {
      return handleDiscardMutation(parts[2]!);
    }
    if (req.method === "POST" && url.pathname === "/api/switch-branch") {
      return handleSwitchBranch(req);
    }
    if (req.method === "POST" && url.pathname === "/api/tmux/focus") {
      return runtime.handleTmuxFocus(req);
    }
    if (req.method === "GET" && url.pathname === "/api/agents") {
      return json({ agents: listFixerAgents() });
    }
    if (req.method === "POST" && url.pathname === "/api/agents/prompt") {
      const body = (await req.json()) as { repo: string; number: number; instruction: string };
      if (!/^[^/]+\/[^/]+$/.test(body.repo ?? "") || !Number.isInteger(body.number)) {
        return json({ error: "invalid repo/number" }, 400);
      }
      if (typeof body.instruction !== "string" || !body.instruction.trim()) {
        return json({ error: "instruction required" }, 400);
      }
      try {
        await launchPromptAgent(body.repo, body.number, body.instruction.trim());
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 409);
      }
      return json({ ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/agents/autofix") {
      const body = (await req.json()) as { repo: string; number: number };
      if (!/^[^/]+\/[^/]+$/.test(body.repo ?? "") || !Number.isInteger(body.number)) {
        return json({ error: "invalid repo/number" }, 400);
      }
      try {
        await launchAutofixAgent(body.repo, body.number);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 409);
      }
      return json({ ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/agents/custom") {
      const body = (await req.json()) as { repo: string; number: number; agentId: string };
      if (!/^[^/]+\/[^/]+$/.test(body.repo ?? "") || !Number.isInteger(body.number) || typeof body.agentId !== "string") {
        return json({ error: "invalid repo/number/agentId" }, 400);
      }
      try {
        await launchCustomAgent(body.repo, body.number, body.agentId);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 409);
      }
      return json({ ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/agents/rescore") {
      const body = (await req.json()) as { repo: string; number: number };
      if (!/^[^/]+\/[^/]+$/.test(body.repo ?? "") || !Number.isInteger(body.number)) {
        return json({ error: "invalid repo/number" }, 400);
      }
      const pr = getPr(body.repo, body.number);
      if (!pr || !shouldAutoRescore(pr)) {
        return json({ error: "nothing to re-score - needs your own PR with a stale Greptile review" }, 409);
      }
      maybeRescore(body.repo, body.number).catch((err) => console.error(`manual rescore failed for ${body.repo}#${body.number}:`, err));
      return json({ ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/agents/kill") {
      const body = (await req.json()) as { repo: string; number: number };
      if (!/^[^/]+\/[^/]+$/.test(body.repo ?? "") || !Number.isInteger(body.number)) {
        return json({ error: "invalid repo/number" }, 400);
      }
      killFixerAgent(body.repo, body.number);
      setAutoMergeArmed(body.repo, body.number, false);
      invalidatePr(body.repo, body.number);
      invalidateInbox();
      return json({ ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/agents/log") {
      const repo = url.searchParams.get("repo") ?? "";
      const number = Number(url.searchParams.get("number"));
      const log = await agentLogTail(repo, number);
      if (log === null) return json({ error: "no agent" }, 404);
      return json({ log });
    }
    if (req.method === "GET" && url.pathname === "/api/agents/runs") {
      const repo = url.searchParams.get("repo") ?? "";
      const number = Number(url.searchParams.get("number"));
      return json({ runs: listAgentRunsForPr(repo, number) });
    }
    if (req.method === "GET" && url.pathname === "/api/agents/runs/detail") {
      const id = Number(url.searchParams.get("id"));
      const detail = await agentRunDetail(id);
      if (!detail) return json({ error: "no such run" }, 404);
      return json(detail);
    }
    if (
      req.method === "GET" &&
      parts.length === 6 &&
      parts[0] === "api" &&
      parts[1] === "pr" &&
      parts[5] === "actions"
    ) {
      return handleActions(parts[2]!, parts[3]!, parts[4]!, url, runtime);
    }
    if (
      req.method === "GET" &&
      parts.length === 7 &&
      parts[0] === "api" &&
      parts[1] === "pr" &&
      parts[5] === "actions" &&
      parts[6] === "commits"
    ) {
      return handleActionCommits(parts[2]!, parts[3]!, parts[4]!);
    }
    if (
      req.method === "GET" &&
      parts.length === 7 &&
      parts[0] === "api" &&
      parts[1] === "pr" &&
      parts[5] === "actions" &&
      parts[6] === "graph"
    ) {
      return handleActionGraphs(parts[2]!, parts[3]!, parts[4]!, url, runtime);
    }
    if (
      req.method === "GET" &&
      parts.length === 9 &&
      parts[0] === "api" &&
      parts[1] === "pr" &&
      parts[5] === "actions" &&
      parts[6] === "jobs" &&
      parts[8] === "log"
    ) {
      return handleActionLog(parts[2]!, parts[3]!, parts[4]!, parts[7]!, url, runtime);
    }
    if (
      req.method === "GET" &&
      parts.length === 6 &&
      parts[0] === "api" &&
      parts[1] === "pr" &&
      parts[5] === "conflicts"
    ) {
      return handlePrConflicts(parts[2]!, parts[3]!, parts[4]!);
    }
    if (
      req.method === "GET" &&
      parts.length === 6 &&
      parts[0] === "api" &&
      parts[1] === "pr" &&
      parts[5] === "commit-stats"
    ) {
      return handlePrCommitStats(parts[2]!, parts[3]!, parts[4]!, url);
    }
    if (
      req.method === "GET" &&
      parts.length === 6 &&
      parts[0] === "api" &&
      parts[1] === "pr" &&
      parts[5] === "diff"
    ) {
      return handlePrDiff(parts[2]!, parts[3]!, parts[4]!, url);
    }
    if (
      req.method === "GET" &&
      parts.length === 7 &&
      parts[0] === "api" &&
      parts[1] === "agent" &&
      parts[2] === "pr"
    ) {
      if (parts[6] === "diff") return handleAgentPrDiff(parts[3]!, parts[4]!, parts[5]!, url);
      if (parts[6] === "jobs") return handleAgentPrJobs(parts[3]!, parts[4]!, parts[5]!);
      if (parts[6] === "logs") return handleAgentPrLogs(parts[3]!, parts[4]!, parts[5]!, url);
      if (parts[6] === "file") return handleAgentPrFile(parts[3]!, parts[4]!, parts[5]!, url);
    }
    if (
      req.method === "POST" &&
      parts.length === 9 &&
      parts[0] === "api" &&
      parts[1] === "agent" &&
      parts[2] === "pr" &&
      parts[6] === "runs" &&
      parts[8] === "cache"
    ) {
      const trustedCliHost = /^(?:127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.headers.get("host") ?? url.host);
      if (!trustedCliHost || req.headers.get("x-pr-cockpit-cli") !== "1") {
        return json({ error: "trusted CLI request required" }, 403);
      }
      return handleAgentCacheRun(parts[3]!, parts[4]!, parts[5]!, parts[7]!, runtime);
    }
    const trustedCliHost = /^(?:127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.headers.get("host") ?? url.host);
    if (
      req.method === "POST" &&
      parts.length === 7 &&
      parts[0] === "api" &&
      parts[1] === "agent" &&
      parts[2] === "pr" &&
      parts[6] === "actions-lease"
    ) {
      if (!trustedCliHost || req.headers.get("x-pr-cockpit-cli") !== "1") {
        return json({ error: "trusted CLI request required" }, 403);
      }
      return handleActionsLease(parts[3]!, parts[4]!, parts[5]!, runtime);
    }
    if (
      req.method === "POST" &&
      parts.length === 7 &&
      parts[0] === "api" &&
      parts[1] === "agent" &&
      parts[2] === "pr" &&
      parts[6] === "mutations"
    ) {
      if (!trustedCliHost || req.headers.get("x-pr-cockpit-cli") !== "1") {
        return json({ error: "trusted CLI request required" }, 403);
      }
      return handleAgentMutation(parts[3]!, parts[4]!, parts[5]!, req);
    }
    if (
      req.method === "POST" &&
      parts.length === 8 &&
      parts[0] === "api" &&
      parts[1] === "agent" &&
      parts[2] === "pr" &&
      parts[6] === "threads"
    ) {
      if (!trustedCliHost) return json({ error: "loopback CLI request required" }, 403);
      if (req.headers.get("x-pr-cockpit-cli") !== "1") return json({ error: "trusted CLI request required" }, 403);
      return handleResolveReviewThread(parts[3]!, parts[4]!, parts[5]!, parts[7]!, runtime);
    }
    if (
      req.method === "GET" &&
      parts.length === 6 &&
      parts[0] === "api" &&
      parts[1] === "agent" &&
      parts[2] === "pr"
    ) {
      return handleAgentPr(parts[3]!, parts[4]!, parts[5]!, url, runtime);
    }
    if (req.method === "POST" && parts.length === 6 && parts[0] === "api" && parts[1] === "pr" && parts[5] === "merge-method") {
      const repoName = `${parts[2]!}/${parts[3]!}`;
      const num = Number(parts[4]!);
      if (!Number.isInteger(num)) return json({ error: "bad PR number" }, 400);
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json({ error: "invalid JSON body" }, 400);
      }
      const method = body && typeof body === "object" && "method" in body ? body.method : null;
      if (!isMergeMethod(method)) return json({ error: "method must be merge, squash, or rebase" }, 400);
      try {
        const baseRef = currentBaseRef(repoName, num);
        setMergeMethodPreference(repoName, baseRef, method);
        return json({ method, source: "explicit", baseRef });
      } catch (err) {
        return json({ error: String(err) }, 409);
      }
    }
    if (req.method === "GET" && parts.length === 6 && parts[0] === "api" && parts[1] === "pr" && parts[5] === "checkout") {
      const repoName = `${parts[2]!}/${parts[3]!}`;
      const num = Number(parts[4]!);
      if (!Number.isInteger(num)) return json({ error: "bad PR number" }, 400);
      const pr = getPr(repoName, num);
      const cached = pr ? null : getCachedPrDetail(repoName, num);
      const cachedDetail = cached ? (JSON.parse(cached.detail_json) as { headRefOid?: string }) : null;
      const headSha = pr?.head_sha ?? cached?.head_sha ?? cachedDetail?.headRefOid ?? null;
      if (!headSha || !FULL_SHA_RE.test(headSha)) return json({ error: `no known PR head commit for ${repoName}#${num}` }, 404);
      try {
        const checkout = await materializePrWorktree(repoName, num, headSha);
        return json(await checkoutTargetFor(checkout, url.searchParams.get("file")));
      } catch (err) {
        if (err instanceof CheckoutTargetError) return json({ error: err.message }, err.status);
        return json({ error: err instanceof Error ? err.message : String(err) }, 502);
      }
    }
    if (req.method === "GET" && parts.length === 5 && parts[0] === "api" && parts[1] === "pr") {
      return handlePrDetail(parts[2]!, parts[3]!, parts[4]!, runtime);
    }

    const staticFile = Bun.file(`static${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (await staticFile.exists()) {
      return new Response(staticFile);
    }

    return new Response("not found", { status: 404 });
  };
}
