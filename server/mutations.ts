import {
  deleteMutation,
  getCachedPrDetail,
  getPr,
  insertMutation,
  listMutationsForPr,
  listRefreshingMutations,
  nextPendingMutation,
  repoUserId,
  setAutoMergeArmed,
  setMutationState,
  type MutationRow,
} from "./db.ts";
import {
  addAssigneesToAssignable,
  closePullRequest,
  getViewerLogin,
  markPullRequestReadyForReview,
  postInlineComment,
  postIssueComment,
  postReview,
  postReviewCommentReply,
  removeAssignees,
  removeRequestedReviewers,
  requestReviewsFromUsers,
  setGithubAutoMerge,
  setThreadResolved,
  updatePullRequestBody,
  updatePullRequestTitle,
  updatePullRequestBranch,
} from "./github.ts";
import { pollOnce, refreshPr } from "./poller.ts";
import { killFixerAgent, launchFixerAgent } from "./agents.ts";
import { refreshRepoUsers } from "./repoUsers.ts";
import { isMergeMethod, isMergeMethodSource, MERGEABLE_NOW_STATES, mergeWithLearning, mergeWithSelection, type MergeMethod, type MergeMethodSource } from "./mergeMethod.ts";

export type MutationPayload =
  | { kind: "comment"; body: string }
  | { kind: "reply-to-thread"; rootCommentId: number; body: string }
  | { kind: "resolve-thread"; threadId: string; resolved: boolean }
  | { kind: "review-verdict"; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body: string }
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
  | { kind: "assign"; logins: string[] }
  | { kind: "unassign"; logins: string[] }
  | { kind: "request-reviewers"; logins: string[] }
  | { kind: "unrequest-reviewers"; logins: string[] };

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
  "assign",
  "unassign",
  "request-reviewers",
  "unrequest-reviewers",
]);

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
}

async function resolveRepoUserIds(repo: string, logins: string[]): Promise<string[]> {
  let ids = logins.map((login) => repoUserId(repo, login));
  if (ids.some((id) => id === null)) {
    await refreshRepoUsers(repo);
    ids = logins.map((login) => repoUserId(repo, login));
  }
  const missing = logins.filter((_, i) => ids[i] === null);
  if (missing.length > 0) throw new Error(`unknown repo user(s): ${missing.join(", ")} - not in ${repo}'s assignable users`);
  return ids as string[];
}

export function enqueueMutation(params: { repo: string; number: number; payload: MutationPayload }): number {
  assertMutationPayload(params.payload);
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
  setMutationState(id, "pending", null);
  kickWorker();
}

export function discardMutation(id: number): void {
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
    case "comment":
      await postIssueComment(row.repo, row.number, payload.body);
      return false;
    case "reply-to-thread":
      await postReviewCommentReply(row.repo, row.number, payload.rootCommentId, payload.body);
      return false;
    case "resolve-thread":
      await setThreadResolved(payload.threadId, payload.resolved);
      return false;
    case "review-verdict": {
      const pr = getPr(row.repo, row.number);
      const viewerLogin = await getViewerLogin();
      if (payload.event !== "COMMENT" && pr?.author === viewerLogin) {
        const prefix = payload.event === "APPROVE" ? "**APPROVED**" : "**CHANGES REQUESTED**";
        const body = payload.body ? `${prefix}\n\n${payload.body}` : prefix;
        await postReview(row.repo, row.number, "COMMENT", body);
      } else {
        await postReview(row.repo, row.number, payload.event, payload.body);
      }
      return false;
    }
    case "merge": {
      // Force skips Cockpit's own merge gate; GitHub still decides whether the merge is allowed.
      await refreshPr(row.repo, row.number);
      const currentBase = currentBaseRef(row.repo, row.number);
      if (currentBase !== payload.baseRef) {
        throw new Error(`PR retargeted from ${payload.baseRef} to ${currentBase}; confirm the merge method again`);
      }
      await mergeWithSelection(row.repo, row.number, payload.baseRef, payload.method, payload.source);
      return true;
    }
    case "update-branch": {
      await updatePullRequestBranch(requirePrRef(row.repo, row.number).nodeId);
      return false;
    }
    case "ready-for-review": {
      await markPullRequestReadyForReview(requirePrRef(row.repo, row.number).nodeId);
      return false;
    }
    case "close": {
      await closePullRequest(requirePrRef(row.repo, row.number).nodeId);
      return true;
    }
    case "edit-body": {
      await updatePullRequestBody(requirePrRef(row.repo, row.number).nodeId, payload.body);
      return false;
    }
    case "edit-title": {
      await updatePullRequestTitle(requirePrRef(row.repo, row.number).nodeId, payload.title);
      return false;
    }
    case "inline-comment": {
      const { headSha } = requirePrRef(row.repo, row.number);
      await postInlineComment(row.repo, row.number, headSha, payload);
      return false;
    }
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
    case "assign": {
      const { nodeId } = requirePrRef(row.repo, row.number);
      await addAssigneesToAssignable(nodeId, await resolveRepoUserIds(row.repo, payload.logins));
      return false;
    }
    case "unassign":
      await removeAssignees(row.repo, row.number, payload.logins);
      return false;
    case "request-reviewers": {
      const { nodeId } = requirePrRef(row.repo, row.number);
      await requestReviewsFromUsers(nodeId, await resolveRepoUserIds(row.repo, payload.logins));
      return false;
    }
    case "unrequest-reviewers":
      await removeRequestedReviewers(row.repo, row.number, payload.logins);
      return false;
  }
}

type MutationCompletionDependencies = {
  refreshPr: typeof refreshPr;
  pollOnce: typeof pollOnce;
  deleteMutation: typeof deleteMutation;
  setMutationState: typeof setMutationState;
};

const mutationCompletionDependencies: MutationCompletionDependencies = { refreshPr, pollOnce, deleteMutation, setMutationState };

export async function finalizeMutation(
  row: Pick<MutationRow, "id" | "repo" | "number">,
  merged: boolean,
  dependencies = mutationCompletionDependencies,
): Promise<void> {
  dependencies.setMutationState(row.id, "refreshing", null);
  try {
    await dependencies.refreshPr(row.repo, row.number);
    if (merged) await dependencies.pollOnce();
  } catch (err) {
    console.error("post-mutation refresh failed:", err);
  }
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
  executeMutation: typeof executeMutation;
};

const mutationProcessorDependencies: MutationProcessorDependencies = {
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
