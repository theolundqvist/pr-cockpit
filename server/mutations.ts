import {
  deleteMutation,
  getCachedPrDetail,
  getPr,
  insertMutation,
  listMutationsForPr,
  listRefreshingMutations,
  nextPendingMutation,
  setAutoMergeArmed,
  setMutationRefreshing,
  setMutationState,
  type MutationRow,
} from "./db.ts";
import {
  addAssignees,
  addPendingInlineComment,
  closePullRequest,
  deletePendingReviewComment,
  discardPendingReview,
  editPendingReviewComment,
  getViewerLogin,
  markPullRequestReadyForReview,
  postInlineComment,
  postIssueComment,
  postReview,
  postReviewCommentReply,
  removeAssignees,
  removeRequestedReviewers,
  requestReviewers,
  setGithubAutoMerge,
  setThreadResolved,
  submitPendingReview,
  updatePullRequestBody,
  updatePullRequestTitle,
  updatePullRequestBranch,
  type PrDetail,
} from "./github.ts";
import { pollOnce, refreshPr } from "./poller.ts";
import { killFixerAgent, launchFixerAgent } from "./agents.ts";
import { refreshRepoUsers } from "./repoUsers.ts";
import { isMergeMethod, isMergeMethodSource, mergeAllowedNow, MERGEABLE_NOW_STATES, mergeWithLearning, mergeWithSelection, type MergeMethod, type MergeMethodSource } from "./mergeMethod.ts";
import { pendingReviewsEnabled } from "./settings.ts";

export type MutationPayload =
  | { kind: "comment"; body: string; commentNodeId?: string }
  | { kind: "reply-to-thread"; rootCommentId: number; body: string }
  | { kind: "resolve-thread"; threadId: string; resolved: boolean }
  | { kind: "review-verdict"; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body: string; pendingReviewId?: number }
  | { kind: "merge"; force: boolean; baseRef: string; method: MergeMethod; source: MergeMethodSource }
  | { kind: "update-branch" }
  | { kind: "ready-for-review" }
  | { kind: "close" }
  | { kind: "edit-body"; body: string }
  | { kind: "edit-title"; title: string }
  | { kind: "auto-merge"; enable: boolean }
  | { kind: "github-auto-merge"; enable: true; method: MergeMethod }
  | { kind: "github-auto-merge"; enable: false }
  | { kind: "inline-comment"; path: string; line: number; side: "LEFT" | "RIGHT"; startLine?: number; startSide?: "LEFT" | "RIGHT"; body: string }
  | { kind: "pending-inline-comment"; headSha: string; path: string; line: number; side: "LEFT" | "RIGHT"; startLine?: number; startSide?: "LEFT" | "RIGHT"; body: string }
  | { kind: "edit-pending-comment"; reviewId: number; commentId: number; body: string }
  | { kind: "delete-pending-comment"; reviewId: number; commentId: number }
  | { kind: "discard-pending-review"; reviewId: number }
  | { kind: "assign"; logins: string[] }
  | { kind: "unassign"; logins: string[] }
  | { kind: "request-reviewers"; logins: string[] }
  | { kind: "unrequest-reviewers"; logins: string[] };
const MUTATION_REFRESH_RETRY_MS = 30_000;
const mutationRefreshTimers = new Map<number, Timer>();

function cancelMutationRefresh(id: number): void {
  clearTimeout(mutationRefreshTimers.get(id));
  mutationRefreshTimers.delete(id);
}
function scheduleMutationRefresh(id: number, retry: () => Promise<void>): void {
  cancelMutationRefresh(id);
  const timer = setTimeout(() => {
    mutationRefreshTimers.delete(id);
    void retry();
  }, MUTATION_REFRESH_RETRY_MS);
  timer.unref();
  mutationRefreshTimers.set(id, timer);
}

const KNOWN_KINDS: ReadonlySet<string> = new Set([
  "comment",
  "reply-to-thread",
  "resolve-thread",
  "review-verdict",
  "merge",
  "update-branch",
  "ready-for-review",
  "close",
  "edit-body",
  "edit-title",
  "auto-merge",
  "github-auto-merge",
  "inline-comment",
  "pending-inline-comment",
  "edit-pending-comment",
  "delete-pending-comment",
  "discard-pending-review",
  "assign",
  "unassign",
  "request-reviewers",
  "unrequest-reviewers",
]);

const PENDING_KINDS: Record<string, true> = {
  "pending-inline-comment": true,
  "edit-pending-comment": true,
  "delete-pending-comment": true,
  "discard-pending-review": true,
};
function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validPendingLocation(value: {
  line?: unknown;
  side?: unknown;
  startLine?: unknown;
  startSide?: unknown;
}): boolean {
  if (!positiveId(value.line) || (value.side !== "LEFT" && value.side !== "RIGHT")) return false;
  if (value.startLine === undefined) return value.startSide === undefined;
  return positiveId(value.startLine)
    && (value.startSide === undefined || value.startSide === "LEFT" || value.startSide === "RIGHT");
}

function assertMutationPayload(value: unknown): asserts value is MutationPayload {
  if (!value || typeof value !== "object" || !("kind" in value) || typeof value.kind !== "string" || !KNOWN_KINDS.has(value.kind)) {
    throw new Error("invalid mutation payload");
  }
  if (value.kind === "merge") {
    if (!("force" in value) || typeof value.force !== "boolean" ||
      !("baseRef" in value) || typeof value.baseRef !== "string" || !value.baseRef ||
      !("method" in value) || !isMergeMethod(value.method) ||
      !("source" in value) || !isMergeMethodSource(value.source) || (value.source === "default" && value.method !== "squash")) {
      throw new Error("merge requires a valid branch and method snapshot");
    }
  }
  if (value.kind === "github-auto-merge") {
    if (!("enable" in value) || typeof value.enable !== "boolean") throw new Error("GitHub auto-merge requires enable");
    if (value.enable && (!("method" in value) || !isMergeMethod(value.method))) {
      throw new Error("enabling GitHub auto-merge requires a valid merge method");
    }
    if (!value.enable && "method" in value) throw new Error("disabling GitHub auto-merge must not include a merge method");
  }
  if (value.kind === "review-verdict" && "pendingReviewId" in value && value.pendingReviewId !== undefined && !positiveId(value.pendingReviewId)) {
    throw new Error("pending review verdict requires a valid review ID");
  }
  if (value.kind === "pending-inline-comment") {
    if (!("headSha" in value) || typeof value.headSha !== "string" || !/^[0-9a-f]{40}$/i.test(value.headSha)
      || !("path" in value) || typeof value.path !== "string" || !value.path
      || !("body" in value) || typeof value.body !== "string" || !value.body.trim()
      || !validPendingLocation(value)) {
      throw new Error("pending inline comment requires a head SHA, body, and valid diff location");
    }
  }
  if (value.kind === "edit-pending-comment") {
    if (!("reviewId" in value) || !positiveId(value.reviewId)
      || !("commentId" in value) || !positiveId(value.commentId)
      || !("body" in value) || typeof value.body !== "string" || !value.body.trim()) {
      throw new Error("editing a pending comment requires valid review and comment IDs and a body");
    }
  }
  if (value.kind === "delete-pending-comment") {
    if (!("reviewId" in value) || !positiveId(value.reviewId) || !("commentId" in value) || !positiveId(value.commentId)) {
      throw new Error("deleting a pending comment requires valid review and comment IDs");
    }
  }
  if (value.kind === "discard-pending-review" && (!("reviewId" in value) || !positiveId(value.reviewId))) {
    throw new Error("discarding a pending review requires a valid review ID");
  }
}


export function enqueueMutation(params: {
  repo: string;
  number: number;
  payload: MutationPayload;
  allowPendingReviews?: boolean;
}): number {
  assertMutationPayload(params.payload);
  if ((PENDING_KINDS[params.payload.kind]
    || (params.payload.kind === "review-verdict" && params.payload.pendingReviewId !== undefined))
    && !(params.allowPendingReviews || pendingReviewsEnabled())) {
    throw new Error("pending reviews are disabled");
  }
  if (!/^[^/]+\/[^/]+$/.test(params.repo)) {
    throw new Error(`invalid repo ${params.repo}`);
  }
  if (params.payload.kind === "edit-title" && !params.payload.title.trim()) {
    throw new Error("pull request title cannot be empty");
  }
  const id = insertMutation({
    repo: params.repo,
    number: params.number,
    kind: params.payload.kind,
    payload_json: JSON.stringify(params.payload),
    created_at: new Date().toISOString(),
  });
  kickWorker();
  return id;
}

export function mutationsForPr(repo: string, number: number): MutationRow[] {
  return listMutationsForPr(repo, number);
}

export function retryMutation(id: number): void {
  cancelMutationRefresh(id);
  setMutationState(id, "pending", null);
  kickWorker();
}

export function discardMutation(id: number): void {
  cancelMutationRefresh(id);
  deleteMutation(id);
}

// untracked PRs opened in the detail view live in pr_detail_cache, not the tracked prs table
function requirePrRef(repo: string, number: number): { headSha: string; nodeId: string } {
  const pr = getPr(repo, number);
  if (pr) return { headSha: pr.head_sha, nodeId: (JSON.parse(pr.detail_json) as { id: string }).id };
  const cached = getCachedPrDetail(repo, number);
  if (!cached) throw new Error(`no cached PR for ${repo}#${number}`);
  return { headSha: cached.head_sha, nodeId: (JSON.parse(cached.detail_json) as { id: string }).id };
}

// Reads the freshest cached base after refreshes and for preference writes.
export function currentBaseRef(repo: string, number: number): string {
  const pr = getPr(repo, number);
  if (pr?.base_ref) return pr.base_ref;
  const detail: unknown = JSON.parse(getCachedPrDetail(repo, number)?.detail_json ?? "null");
  if (detail && typeof detail === "object" && "baseRefName" in detail && typeof detail.baseRefName === "string" && detail.baseRefName) {
    return detail.baseRefName;
  }
  // never guess: learned merge methods are keyed on the base, and a wrongly squashed
  // merge-commit-only branch is exactly what this policy exists to prevent
  throw new Error(`no base ref known for ${repo}#${number} - cannot pick merge method`);
}

// returns whether this mutation took the PR out of the open set (merge/close), so the caller polls broadly
async function executeMutation(row: MutationRow): Promise<boolean> {
  const payload: unknown = JSON.parse(row.payload_json);
  assertMutationPayload(payload);
  switch (payload.kind) {
    case "comment": {
      const commentNodeId = await postIssueComment(row.repo, row.number, payload.body);
      row.payload_json = JSON.stringify({ ...payload, commentNodeId });
      return false;
    }
    case "reply-to-thread":
      await postReviewCommentReply(row.repo, row.number, payload.rootCommentId, payload.body);
      return false;
    case "resolve-thread":
      await setThreadResolved(payload.threadId, payload.resolved);
      return false;
    case "review-verdict": {
      const pr = getPr(row.repo, row.number);
      const viewerLogin = await getViewerLogin();
      let event = payload.event;
      let body = payload.body;
      if (event !== "COMMENT" && pr?.author === viewerLogin) {
        const prefix = event === "APPROVE" ? "**APPROVED**" : "**CHANGES REQUESTED**";
        body = body ? `${prefix}\n\n${body}` : prefix;
        event = "COMMENT";
      }
      if (payload.pendingReviewId === undefined) await postReview(row.repo, row.number, event, body);
      else await submitPendingReview(row.repo, row.number, payload.pendingReviewId, event, body);
      return false;
    }
    case "merge": {
      // Force skips Cockpit's own merge gate; GitHub still decides whether the merge is allowed.
      await refreshPr(row.repo, row.number, "mutation recovery");
      const currentBase = currentBaseRef(row.repo, row.number);
      if (currentBase !== payload.baseRef) {
        throw new Error(`PR retargeted from ${payload.baseRef} to ${currentBase}; confirm the merge method again`);
      }
      const pr = getPr(row.repo, row.number);
      if (!pr) throw new Error(`no cached PR for ${row.repo}#${row.number}`);
      if (!payload.force && !mergeAllowedNow(row.repo, pr)) {
        throw new Error(`Cockpit merge gate rejected ${pr.merge_state_status}`);
      }
      await mergeWithSelection(row.repo, row.number, payload.baseRef, payload.method, payload.source);
      return true;
    }
    case "update-branch":
      await updatePullRequestBranch(row.repo, row.number);
      return false;
    case "ready-for-review": {
      await markPullRequestReadyForReview(requirePrRef(row.repo, row.number).nodeId);
      return false;
    }
    case "close":
      await closePullRequest(row.repo, row.number);
      return true;
    case "edit-body":
      await updatePullRequestBody(row.repo, row.number, payload.body);
      return false;
    case "edit-title":
      await updatePullRequestTitle(row.repo, row.number, payload.title);
      return false;
    case "inline-comment": {
      const { headSha } = requirePrRef(row.repo, row.number);
      await postInlineComment(row.repo, row.number, headSha, payload);
      return false;
    }
    case "pending-inline-comment":
      await addPendingInlineComment(row.repo, row.number, payload.headSha, {
        path: payload.path,
        line: payload.line,
        side: payload.side,
        ...(payload.startLine === undefined
          ? {}
          : { startLine: payload.startLine, startSide: payload.startSide ?? payload.side }),
        body: payload.body,
      });
      return false;
    case "edit-pending-comment":
      await editPendingReviewComment(row.repo, row.number, payload.reviewId, payload.commentId, payload.body);
      return false;
    case "delete-pending-comment":
      await deletePendingReviewComment(row.repo, row.number, payload.reviewId, payload.commentId);
      return false;
    case "discard-pending-review":
      await discardPendingReview(row.repo, row.number, payload.reviewId);
      return false;
    // Cockpit bot auto-merge: a fixer agent waits/fixes, then the supervisor merges.
    case "auto-merge": {
      const pr = getPr(row.repo, row.number);
      if (!pr) throw new Error(`no cached PR for ${row.repo}#${row.number}`);
      if (payload.enable) {
        if (!pr.is_draft && MERGEABLE_NOW_STATES.has(pr.merge_state_status)) {
          await mergeWithLearning(row.repo, row.number, pr.base_ref);
          return true;
        }
        await launchFixerAgent(row.repo, row.number);
        setAutoMergeArmed(row.repo, row.number, true);
        return false;
      }
      killFixerAgent(row.repo, row.number);
      setAutoMergeArmed(row.repo, row.number, false);
      return false;
    }
    case "github-auto-merge":
      await setGithubAutoMerge(requirePrRef(row.repo, row.number).nodeId, payload.enable ? payload.method : null);
      return false;
    case "assign":
      await addAssignees(row.repo, row.number, payload.logins);
      return false;
    case "unassign":
      await removeAssignees(row.repo, row.number, payload.logins);
      return false;
    case "request-reviewers":
      await requestReviewers(row.repo, row.number, payload.logins);
      return false;
    case "unrequest-reviewers":
      await removeRequestedReviewers(row.repo, row.number, payload.logins);
      return false;
  }
}

function sameGithubText(left: string, right: string): boolean {
  return left.replaceAll("\r\n", "\n").trimEnd() === right.replaceAll("\r\n", "\n").trimEnd();
}

function mutationReflected(row: Pick<MutationRow, "repo" | "number" | "payload_json">): boolean {
  const payload: unknown = JSON.parse(row.payload_json);
  assertMutationPayload(payload);
  if (payload.kind !== "comment" && payload.kind !== "edit-body") return true;
  const cached = getPr(row.repo, row.number)?.detail_json ?? getCachedPrDetail(row.repo, row.number)?.detail_json;
  if (!cached) return false;
  const detail = JSON.parse(cached) as PrDetail;
  if (payload.kind === "edit-body") return sameGithubText(detail.body, payload.body);
  if (!payload.commentNodeId) return false;
  return detail.comments.nodes.some((comment) => comment.id === payload.commentNodeId);
}

type MutationCompletionDependencies = {
  refreshPr: typeof refreshPr;
  pollOnce: typeof pollOnce;
  deleteMutation: typeof deleteMutation;
  setMutationState: typeof setMutationState;
  scheduleRecovery?: (id: number, retry: () => Promise<void>) => void;
};

const mutationCompletionDependencies: MutationCompletionDependencies = {
  refreshPr,
  pollOnce,
  deleteMutation,
  setMutationState,
};

export async function finalizeMutation(
  row: Pick<MutationRow, "id" | "repo" | "number" | "kind" | "payload_json">,
  merged: boolean,
  dependencies = mutationCompletionDependencies,
): Promise<void> {
  try {
    await dependencies.refreshPr(row.repo, row.number, "mutation recovery");
    if (merged) await dependencies.pollOnce();
    if (!mutationReflected(row)) throw new Error("refreshed cache does not contain the accepted change");
  } catch (err) {
    const error = `GitHub accepted ${row.kind}, but cache refresh failed: ${err instanceof Error ? err.message : String(err)}`;
    dependencies.setMutationState(row.id, "refreshing", error);
    console.warn(error);
    const retry = () => finalizeMutation(row, merged, dependencies);
    (dependencies.scheduleRecovery ?? scheduleMutationRefresh)(row.id, retry);
    return;
  }
  cancelMutationRefresh(row.id);
  dependencies.deleteMutation(row.id);
}

export async function recoverRefreshingMutations(
  dependencies: MutationCompletionDependencies = mutationCompletionDependencies,
): Promise<void> {
  for (const row of listRefreshingMutations()) {
    await finalizeMutation(row, false, dependencies);
  }
}

type MutationProcessorDependencies = MutationCompletionDependencies & {
  setMutationRefreshing: typeof setMutationRefreshing;
  executeMutation: typeof executeMutation;
};

const mutationProcessorDependencies: MutationProcessorDependencies = {
  setMutationRefreshing,
  ...mutationCompletionDependencies,
  executeMutation,
};

export async function processMutation(row: MutationRow, dependencies = mutationProcessorDependencies): Promise<void> {
  let merged: boolean;
  try {
    merged = await dependencies.executeMutation(row);
  } catch (err) {
    dependencies.setMutationState(row.id, "failed", String(err));
    return;
  }
  dependencies.setMutationRefreshing(row.id, row.payload_json);
  await finalizeMutation(row, merged, dependencies);
}

let draining = false;

export function kickWorker(): void {
  if (draining) return;
  draining = true;
  drainQueue().finally(() => {
    draining = false;
  });
}

async function drainQueue(): Promise<void> {
  let row = nextPendingMutation();
  while (row) {
    await processMutation(row);
    row = nextPendingMutation();
  }
}
