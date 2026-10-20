import { db, getSetting, workflowRunAttempt, type WorkflowRunRow } from "./db.ts";
import { deployedCommitsFromMirror, fetchMirror, type MirrorDeployedCommitsResult } from "./mirror.ts";
import { notifyDeployedPrs, storedNotificationSettings, type DeployedPr } from "./notifications.ts";
import { deployRunMayMatch } from "../shared/notificationRules.ts";

// Deploys batch merges, so a PR counts as deployed by the first successful run of a workflow on
// its base branch whose head reaches its merge commit; only PRs merged this recently are considered.
const CANDIDATE_WINDOW_MS = 7 * 24 * 60 * 60_000;
// Commit dates trail merge times by seconds; the slack keeps the bounded history walk from
// stopping short of a candidate's merge commit.
const HISTORY_SLACK_MS = 24 * 60 * 60_000;

type MergedPrRow = { number: number; merge_commit: string | null; detail_json: string };

// Base branch and merge commit live in the PR detail Cockpit fetched (inbox PRs and PRs opened in
// the app); the index narrows to recent merges first so only those details are read, and
// json_extract keeps the large documents out of JavaScript.
const mergedPrsStmt = db.prepare<MergedPrRow, Record<string, string>>(`
  SELECT i.number,
    json_extract(d.detail_json, '$.mergeCommit.oid') AS merge_commit,
    json_object(
      'title', json_extract(d.detail_json, '$.title'),
      'author', json(json_extract(d.detail_json, '$.author')),
      'viewerLogin', json_extract(d.detail_json, '$.viewerLogin'),
      'viewerIsAuthor', json(CASE WHEN json_extract(d.detail_json, '$.viewerIsAuthor') THEN 'true' ELSE 'false' END),
      'viewerReviewRequested', json(CASE WHEN json_extract(d.detail_json, '$.viewerReviewRequested') THEN 'true' ELSE 'false' END),
      'isDraft', json(CASE WHEN json_extract(d.detail_json, '$.isDraft') THEN 'true' ELSE 'false' END),
      'assignees', json(COALESCE(json_extract(d.detail_json, '$.assignees'), '{"nodes":[]}'))
    ) AS detail_json
  FROM pr_index i
  JOIN (
    SELECT repo, number, detail_json FROM prs WHERE repo = $repo
    UNION ALL
    SELECT c.repo, c.number, c.detail_json FROM pr_detail_cache c
    WHERE c.repo = $repo AND NOT EXISTS (SELECT 1 FROM prs p WHERE p.repo = c.repo AND p.number = c.number)
  ) d ON d.repo = i.repo AND d.number = i.number
  WHERE i.repo = $repo AND i.state = 'MERGED' AND i.merged_at >= $since AND i.merged_at <= $until
    AND json_extract(d.detail_json, '$.baseRefName') = $branch
`);

const earlierHeadsStmt = db.prepare<{ head_sha: string }, Record<string, string | number>>(`
  SELECT DISTINCT head_sha FROM workflow_runs
  WHERE repo = $repo AND head_branch = $branch AND workflow_name = $workflow
    AND status = 'completed' AND conclusion = 'success'
    AND (COALESCE(updated_at, event_at) < $at
      OR (COALESCE(updated_at, event_at) = $at AND (run_id < $runId OR (run_id = $runId AND run_attempt < $attempt))))
`);

// GitHub's default subjects: "Title (#12)" for a squash merge, "Merge pull request #12 from …" for a merge commit.
const PR_SUBJECT = /\(#(\d+)\)\s*$|^Merge pull request #(\d+) /;

export interface DeployCheckDeps {
  deployedCommits: typeof deployedCommitsFromMirror;
  fetchMirror: (repo: string) => Promise<void>;
}

const liveDeps: DeployCheckDeps = { deployedCommits: deployedCommitsFromMirror, fetchMirror: (repo) => fetchMirror(repo) };

// Asked before the run is stored: only a newly successful completion that some enabled deployed
// rule could match by workflow and branch is worth a check; with no such rule nothing is read.
export function deployCheckWanted(
  repo: string,
  run: { id: number; attempt: number; status: string; conclusion: string | null; workflowName: string; headBranch: string },
): boolean {
  return run.status === "completed" && run.conclusion === "success"
    && deployRunMayMatch(storedNotificationSettings(), run.workflowName, run.headBranch)
    && workflowRunAttempt(repo, run.id, run.attempt)?.conclusion !== "success";
}

const deployChecks = new Map<string, Promise<void>>();

// Checks of one repository run in order, so concurrent completions share one mirror fetch and a
// later deploy is judged after the earlier one it builds on.
export function queueDeployCheck(repo: string, runId: number, attempt: number, deps: DeployCheckDeps = liveDeps): Promise<void> {
  const next = (deployChecks.get(repo) ?? Promise.resolve())
    .then(() => checkDeployRun(repo, runId, attempt, deps))
    .catch((error) => console.error(`deploy notification check failed for ${repo} run ${runId}/${attempt}:`, error));
  deployChecks.set(repo, next);
  void next.finally(() => {
    if (deployChecks.get(repo) === next) deployChecks.delete(repo);
  });
  return next;
}

async function deployedCommits(
  run: WorkflowRunRow,
  earlierHeads: string[],
  sinceMs: number,
  deps: DeployCheckDeps,
): Promise<MirrorDeployedCommitsResult> {
  const first = await deps.deployedCommits(run.repo, run.head_sha, earlierHeads, sinceMs);
  if (first.status === "list-failed" || (first.status === "ok" && first.missingEarlierHeads === 0)) return first;
  // The mirror trails GitHub: fetch (no API quota) rather than judge a deploy it cannot see.
  await deps.fetchMirror(run.repo);
  return deps.deployedCommits(run.repo, run.head_sha, earlierHeads, sinceMs);
}

export async function checkDeployRun(repo: string, runId: number, attempt: number, deps: DeployCheckDeps = liveDeps): Promise<void> {
  const run = workflowRunAttempt(repo, runId, attempt);
  if (!run || run.status !== "completed" || run.conclusion !== "success") return;
  if (!deployRunMayMatch(storedNotificationSettings(), run.workflow_name, run.head_branch)) return;
  const enabledAtMs = Date.parse(getSetting("notifications_enabled_at") ?? "");
  const completedAt = run.updated_at ?? run.event_at;
  const completedAtMs = Date.parse(completedAt);
  if (!Number.isFinite(enabledAtMs) || !Number.isFinite(completedAtMs) || completedAtMs < enabledAtMs) return;

  const sinceMs = completedAtMs - CANDIDATE_WINDOW_MS;
  const candidates = mergedPrsStmt.all({
    $repo: repo,
    $branch: run.head_branch,
    $since: new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, "Z"),
    $until: completedAt,
  });
  if (candidates.length === 0) return;

  const earlierHeads = earlierHeadsStmt.all({
    $repo: repo, $branch: run.head_branch, $workflow: run.workflow_name,
    $at: completedAt, $runId: run.run_id, $attempt: run.run_attempt,
  }).map((row) => row.head_sha);
  const result = await deployedCommits(run, earlierHeads, sinceMs - HISTORY_SLACK_MS, deps);
  if (result.status !== "ok") {
    console.error(`deploy notification check skipped ${repo} run ${runId}/${attempt}: mirror ${result.status} for ${run.head_sha}`);
    return;
  }
  if (result.missingEarlierHeads > 0) {
    console.warn(`deploy notification check for ${repo} run ${runId}/${attempt}: ${result.missingEarlierHeads} earlier deploy heads are missing from the mirror`);
  }

  const shipped = new Map(result.commits.map((commit) => [commit.sha, commit]));
  // Details cached before Cockpit read merge commits name none; such a PR, whose base is this
  // branch, landed as the first-parent commit GitHub titled with its number.
  const titledOnBranch = new Map<number, string>();
  for (let commit = shipped.get(run.head_sha); commit; commit = commit.firstParent ? shipped.get(commit.firstParent) : undefined) {
    const match = PR_SUBJECT.exec(commit.subject);
    const number = Number(match?.[1] ?? match?.[2]);
    if (Number.isSafeInteger(number) && !titledOnBranch.has(number)) titledOnBranch.set(number, commit.sha);
  }

  const deployed: DeployedPr[] = candidates
    .filter((pr) => pr.merge_commit !== null ? shipped.has(pr.merge_commit) : titledOnBranch.has(pr.number))
    .map((pr) => ({ number: pr.number, detail: JSON.parse(pr.detail_json) }));
  if (deployed.length > 0) notifyDeployedPrs(run, completedAt, deployed);
}
