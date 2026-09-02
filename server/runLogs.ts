import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import {
  RUN_JOB_LOG_FORMAT_VERSION,
  actionsLease,
  claimWorkflowRunForPr,
  getFileContents,
  getRunJobLog,
  latestWorkflowRunAttempt,
  listRunJobs,
  markActionsLeaseBootstrapped,
  markWorkflowRunJobsFetched,
  markWorkflowRunReconciled,
  openPrForAction,
  renewActionsLease,
  saveFileContents,
  saveRunJobLog,
  replaceActionWorkflows,
  saveRunJobLogError,
  upsertRunJob,
  upsertWorkflowRun,
  workflowRunsForLease,
  workflowRunsForCommit,
  type RunJobRow,
  type WorkflowRunRow,
} from "./db.ts";
import {
  fetchActionWorkflows,
  fetchFileContents,
  fetchGithubQuota,
  fetchJobLog,
  fetchRunJobs,
  fetchRecentWorkflowRuns,
  fetchWorkflowRuns,
  fetchWorkflowRun,
  fetchWorkflowRunsForWorkflow,
  type RunJob,
  type WorkflowRun,
} from "./github.ts";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const REST_BACKGROUND_RESERVE = 500;
const LOG_WORTHY_CONCLUSION = new Set(["failure", "cancelled", "timed_out", "action_required", "neutral", "startup_failure", "stale"]);
const TIMESTAMP_LINE_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /gm;

export interface CompactRun {
  id: number;
  attempt: number;
  headSha: string;
  headBranch: string;
  workflowName: string;
  workflowPath: string;
  displayTitle: string;
  event: string;
  actorLogin: string | null;
  prNumber: number | null;
  status: string;
  conclusion: string | null;
  eventAt: string;
  createdAt: string | null;
  updatedAt: string | null;
  runStartedAt: string | null;
  runNumber: number;
  htmlUrl: string | null;
}

export interface CompactJob {
  id: number;
  runId: number;
  attempt: number;
  headSha: string;
  headBranch: string;
  workflowName: string;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  htmlUrl: string | null;
  runnerName: string | null;
  runnerGroupName: string | null;
  labels: string[];
  failedStep: string | null;
}

export interface ActionsFetchers {
  fetchWorkflowRuns: typeof fetchWorkflowRuns;
  fetchRunJobs: typeof fetchRunJobs;
  fetchJobLog: typeof fetchJobLog;
  restRemaining: () => Promise<number>;
}

const liveFetchers: ActionsFetchers = {
  fetchWorkflowRuns,
  fetchRunJobs,
  fetchJobLog,
  restRemaining: async () => (await fetchGithubQuota()).rest.remaining,
};

export interface RequestedRunFetchers extends ActionsFetchers {
  fetchWorkflowRun: typeof fetchWorkflowRun;
}

const liveRequestedRunFetchers: RequestedRunFetchers = {
  ...liveFetchers,
  fetchWorkflowRun,
};
const activations = new Map<string, { headSha: string; promise: Promise<void> }>();
const reconciliations = new Map<string, { background: boolean; terminal: boolean; promise: Promise<boolean> }>();
const logFetches = new Map<string, Promise<void>>();

export function cleanJobLog(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(TIMESTAMP_LINE_RE, "");
}

function pullRequestNumber(value: unknown): number | null {
  if (!Array.isArray(value)) return null;
  for (const candidate of value) {
    if (
      candidate &&
      typeof candidate === "object" &&
      "number" in candidate &&
      typeof candidate.number === "number" &&
      Number.isInteger(candidate.number)
    ) {
      return candidate.number;
    }
  }
  return null;
}
function compactRun(run: WorkflowRun): CompactRun {

  return {
    id: run.id,
    attempt: run.run_attempt ?? 1,
    headSha: run.head_sha,
    headBranch: run.head_branch,
    workflowName: run.name,
    workflowPath: run.path ?? "",
    displayTitle: run.display_title ?? run.name,
    event: run.event ?? "",
    actorLogin: run.actor?.login ?? null,
    prNumber: pullRequestNumber(run.pull_requests),
    status: run.status,
    conclusion: run.conclusion,
    eventAt: run.updated_at,
    createdAt: run.created_at ?? null,
    updatedAt: run.updated_at ?? null,
    runStartedAt: run.run_started_at ?? null,
    runNumber: run.run_number ?? 0,
    htmlUrl: run.html_url,
  };
}

function compactStoredRun(run: WorkflowRunRow): CompactRun {
  return {
    id: run.run_id,
    attempt: run.run_attempt,
    headSha: run.head_sha,
    headBranch: run.head_branch,
    workflowName: run.workflow_name,
    workflowPath: run.workflow_path,
    displayTitle: run.display_title,
    event: run.event,
    actorLogin: run.actor_login,
    prNumber: run.pr_number,
    status: run.status,
    conclusion: run.conclusion,
    eventAt: run.event_at,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    runStartedAt: run.run_started_at,
    runNumber: run.run_number,
    htmlUrl: run.html_url,
  };
}

function compactJob(job: RunJob, run?: CompactRun): CompactJob {
  return {
    id: job.id,
    runId: job.run_id,
    attempt: job.run_attempt ?? run?.attempt ?? 1,
    headSha: job.head_sha || run?.headSha || "",
    headBranch: job.head_branch ?? run?.headBranch ?? "",
    workflowName: job.workflow_name ?? run?.workflowName ?? "",
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    htmlUrl: job.html_url,
    runnerName: job.runner_name ?? null,
    runnerGroupName: job.runner_group_name ?? null,
    labels: job.labels ?? [],
    failedStep: job.steps?.find((step) => step.conclusion === "failure")?.name ?? null,
  };
}
export interface WorkflowGraphJob {
  id: string;
  name: string;
  needs: string[];
  uses: string | null;
}

export interface WorkflowGraph {
  path: string;
  name: string | null;
  jobs: WorkflowGraphJob[];
  error?: string;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function workflowJobName(id: string, value: unknown): string {
  if (typeof value !== "string") return id;
  const staticName = value
    .replace(/\$\{\{.*?\}\}/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return staticName || id;
}

export function parseWorkflowGraph(path: string, source: string): WorkflowGraph {
  const document = objectValue(Bun.YAML.parse(source));
  const jobs = objectValue(document?.jobs);
  if (!jobs) throw new Error("workflow has no jobs map");
  return {
    path,
    name: typeof document?.name === "string" ? document.name : null,
    jobs: Object.entries(jobs).map(([id, value]) => {
      const job = objectValue(value) ?? {};
      const rawNeeds = job.needs;
      const needs = typeof rawNeeds === "string"
        ? [rawNeeds]
        : Array.isArray(rawNeeds) ? rawNeeds.filter((item): item is string => typeof item === "string") : [];
      return {
        id,
        name: workflowJobName(id, job.name),
        needs,
        uses: typeof job.uses === "string" ? job.uses : null,
      };
    }),
  };
}

type WorkflowGraphFetchers = {
  fetchWorkflowRuns: typeof fetchWorkflowRuns;
  fetchFileContents: typeof fetchFileContents;
};

const liveWorkflowGraphFetchers: WorkflowGraphFetchers = { fetchWorkflowRuns, fetchFileContents };

function workflowFilePath(path: string): string {
  const refMarker = path.indexOf("@refs/");
  return refMarker === -1 ? path : path.slice(0, refMarker);
}

async function workflowGraphsForRuns(
  repo: string,
  headSha: string,
  runs: WorkflowRunRow[],
  fetchers: WorkflowGraphFetchers,
): Promise<WorkflowGraph[]> {
  const paths = [...new Set(runs.map((run) => workflowFilePath(run.workflow_path)).filter(Boolean))];
  const settled = await Promise.allSettled(paths.map(async (path) => {
    let source = getFileContents(headSha, path);
    if (source === null) {
      const result = await fetchers.fetchFileContents(repo, path, headSha);
      if ("tooLarge" in result) throw new Error("workflow definition is too large");
      source = result.content;
      saveFileContents(headSha, path, source);
    }
    return parseWorkflowGraph(path, source);
  }));
  return settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    console.error(`Workflow graph load failed for ${repo}:${paths[index]}@${headSha}:`, result.reason);
    return { path: paths[index]!, name: null, jobs: [], error: "Workflow definition unavailable" };
  });
}

export async function actionWorkflowGraphs(
  repo: string,
  number: number,
  headSha: string,
  fetchers: WorkflowGraphFetchers = liveWorkflowGraphFetchers,
): Promise<WorkflowGraph[]> {
  let runs = workflowRunsForLease(repo, number, headSha);
  if (runs.length === 0 || runs.some((run) => !run.workflow_path)) {
    const refreshed = await fetchers.fetchWorkflowRuns(repo, headSha);
    for (const run of refreshed) storeRun(repo, number, compactRun(run));
    runs = workflowRunsForLease(repo, number, headSha);
  }
  return workflowGraphsForRuns(repo, headSha, runs, fetchers);
}

export async function repoActionWorkflowGraphs(
  repo: string,
  headSha: string,
  fetchers: WorkflowGraphFetchers = liveWorkflowGraphFetchers,
): Promise<WorkflowGraph[]> {
  let runs = workflowRunsForCommit(repo, headSha);
  if (runs.length === 0 || runs.some((run) => !run.workflow_path)) {
    const refreshed = await fetchers.fetchWorkflowRuns(repo, headSha);
    for (const run of refreshed) storeRun(repo, null, compactRun(run));
    runs = workflowRunsForCommit(repo, headSha);
  }
  return workflowGraphsForRuns(repo, headSha, runs, fetchers);
}


export function compactActionsPayload(event: string, payload: any): { run?: CompactRun; job?: CompactJob } | null {
  if (event === "workflow_run" && payload.workflow_run) {
    const raw = payload.workflow_run;
    if (typeof raw.id !== "number" || typeof raw.head_sha !== "string" || typeof raw.status !== "string") return null;
    return {
      run: {
        id: raw.id,
        attempt: raw.run_attempt ?? 1,
        headSha: raw.head_sha,
        headBranch: raw.head_branch ?? "",
        workflowName: raw.name ?? raw.workflow_name ?? "",
        workflowPath: raw.path ?? "",
        displayTitle: raw.display_title ?? raw.name ?? raw.workflow_name ?? "",
        event: raw.event ?? "",
        actorLogin: raw.actor?.login ?? null,
        prNumber: pullRequestNumber(raw.pull_requests),
        status: raw.status,
        conclusion: raw.conclusion ?? null,
        eventAt: raw.updated_at ?? raw.run_started_at ?? "",
        createdAt: raw.created_at ?? null,
        updatedAt: raw.updated_at ?? null,
        runStartedAt: raw.run_started_at ?? null,
        runNumber: raw.run_number ?? 0,
        htmlUrl: raw.html_url ?? null,
      },
    };
  }
  if (event === "workflow_job" && payload.workflow_job) {
    const raw = payload.workflow_job;
    if (
      typeof raw.id !== "number" ||
      typeof raw.run_id !== "number" ||
      typeof raw.name !== "string" ||
      typeof raw.status !== "string"
    ) return null;
    return {
      job: {
        id: raw.id,
        runId: raw.run_id,
        attempt: raw.run_attempt ?? 1,
        headSha: raw.head_sha ?? payload.workflow_run?.head_sha ?? "",
        headBranch: raw.head_branch ?? payload.workflow_run?.head_branch ?? "",
        workflowName: raw.workflow_name ?? payload.workflow_run?.name ?? "",
        name: raw.name,
        status: raw.status,
        conclusion: raw.conclusion ?? null,
        startedAt: raw.started_at ?? null,
        completedAt: raw.completed_at ?? null,
        htmlUrl: raw.html_url ?? null,
        runnerName: raw.runner_name ?? null,
        runnerGroupName: raw.runner_group_name ?? null,
        labels: raw.labels ?? [],
        failedStep: raw.steps?.find((step: any) => step.conclusion === "failure")?.name ?? null,
      },
    };
  }
  return null;
}

function storeRun(repo: string, number: number | null, run: CompactRun): boolean {
  return upsertWorkflowRun({
    repo, run_id: run.id, run_attempt: run.attempt, pr_number: number ?? run.prNumber,
    head_sha: run.headSha, head_branch: run.headBranch, workflow_name: run.workflowName,
    workflow_path: run.workflowPath ?? "", display_title: run.displayTitle, event: run.event,
    actor_login: run.actorLogin, status: run.status, conclusion: run.conclusion,
    event_at: run.eventAt, created_at: run.createdAt, updated_at: run.updatedAt,
    run_started_at: run.runStartedAt, run_number: run.runNumber, html_url: run.htmlUrl,
  });
}
export async function refreshRecentActions(
  repo: string,
  runFetcher: typeof fetchRecentWorkflowRuns = fetchRecentWorkflowRuns,
  workflowFetcher: typeof fetchActionWorkflows = fetchActionWorkflows,
): Promise<number> {
  const [runs, workflows] = await Promise.all([runFetcher(repo), workflowFetcher(repo)]);
  replaceActionWorkflows(repo, workflows);
  let changed = 0;
  for (const raw of runs) {
    if (storeRun(repo, null, compactRun(raw))) changed++;
  }
  return changed;
}

const WORKFLOW_REFRESH_INTERVAL_MS = 60_000;
const workflowRefreshedAt = new Map<string, number>();

// Selected workflows are fetched through their own endpoint: the repo-wide recent-runs
// window covers only a day or so in busy repositories and misses quieter workflows entirely.
export async function refreshWorkflowRuns(
  repo: string,
  workflowId: number,
  runFetcher: typeof fetchWorkflowRunsForWorkflow = fetchWorkflowRunsForWorkflow,
): Promise<number> {
  const key = `${repo}\n${workflowId}`;
  const now = Date.now();
  const last = workflowRefreshedAt.get(key);
  if (last !== undefined && now - last < WORKFLOW_REFRESH_INTERVAL_MS) return 0;
  workflowRefreshedAt.set(key, now);
  let changed = 0;
  try {
    for (const raw of await runFetcher(repo, workflowId)) {
      if (storeRun(repo, null, compactRun(raw))) changed++;
    }
  } catch (error) {
    workflowRefreshedAt.delete(key);
    throw error;
  }
  return changed;
}

function jobIsComplete(job: { status: string; conclusion: string | null }): boolean {
  return job.status === "completed" || job.conclusion !== null;
}

function storeJob(repo: string, job: CompactJob): boolean {
  return upsertRunJob({
    repo, job_id: job.id, run_id: job.runId, run_attempt: job.attempt, head_sha: job.headSha,
    head_branch: job.headBranch, workflow_name: job.workflowName, name: job.name,
    status: jobIsComplete(job) ? "completed" : job.status,
    conclusion: job.conclusion, started_at: job.startedAt, completed_at: job.completedAt,
    html_url: job.htmlUrl, runner_name: job.runnerName, runner_group_name: job.runnerGroupName,
    labels_json: JSON.stringify(job.labels), failed_step: job.failedStep,
  });
}

function jobProducesLog(job: { status: string; conclusion: string | null }): boolean {
  return jobIsComplete(job) && job.conclusion !== "skipped";
}

async function fetchLogs(repo: string, jobs: CompactJob[], fetchers: ActionsFetchers, background: boolean): Promise<boolean> {
  const wanted = jobs.filter((job) => jobProducesLog(job) && getRunJobLog(repo, job.id) === null);
  if (wanted.length === 0) return true;
  if (background && (await fetchers.restRemaining()) - wanted.length < REST_BACKGROUND_RESERVE) {
    for (const job of wanted) saveRunJobLogError(repo, job.id, job.attempt, "log not fetched: REST quota reserved for actions");
    return false;
  }
  let complete = true;
  for (const job of wanted) {
    try {
      const body = cleanJobLog(await fetchers.fetchJobLog(repo, job.id));
      const compressed = await gzipAsync(body);
      saveRunJobLog(repo, job.id, job.runId, job.attempt, job.headSha, compressed, Buffer.byteLength(body));
    } catch (error) {
      complete = false;
      saveRunJobLogError(repo, job.id, job.attempt, error instanceof Error ? error.message : String(error));
    }
  }
  return complete;
}
async function reconcileRun(repo: string, run: CompactRun, fetchers: ActionsFetchers, background: boolean): Promise<boolean> {
  if (background && await fetchers.restRemaining() <= REST_BACKGROUND_RESERVE) return false;
  const jobs = (await fetchers.fetchRunJobs(repo, run.id, run.status === "completed" ? run.attempt : undefined))
    .map((job) => compactJob(job, run));
  for (const job of jobs) storeJob(repo, job);
  markWorkflowRunJobsFetched(repo, run.id, run.attempt);
  if (!(await fetchLogs(repo, jobs, fetchers, background))) return false;
  if (run.status === "completed") markWorkflowRunReconciled(repo, run.id, run.attempt);
  return true;
}

function queueReconciliation(
  repo: string,
  run: CompactRun,
  fetchers: ActionsFetchers,
  background: boolean,
): Promise<boolean> {
  const key = `${repo}:${run.id}:${run.attempt}`;
  const pending = reconciliations.get(key);
  if (pending) {
    const terminalFollowup = run.status === "completed" && !pending.terminal;
    const explicitFollowup = !background && pending.background;
    if (!terminalFollowup && !explicitFollowup) return pending.promise;
    const start = pending.promise.then((complete) => {
      if (terminalFollowup || (explicitFollowup && !complete)) {
        return reconcileRun(repo, run, fetchers, background);
      }
      return complete;
    });
    let entry: { background: boolean; terminal: boolean; promise: Promise<boolean> };
    entry = {
      background,
      terminal: pending.terminal || run.status === "completed",
      promise: start.finally(() => {
        if (reconciliations.get(key) === entry) reconciliations.delete(key);
      }),
    };
    reconciliations.set(key, entry);
    return entry.promise;
  }
  const start = reconcileRun(repo, run, fetchers, background);
  let entry: { background: boolean; terminal: boolean; promise: Promise<boolean> };
  entry = {
    background,
    terminal: run.status === "completed",
    promise: start.finally(() => {
      if (reconciliations.get(key) === entry) reconciliations.delete(key);
    }),
  };
  reconciliations.set(key, entry);
  return entry.promise;
}

export async function cacheActionsRun(
  repo: string,
  number: number,
  headSha: string,
  headBranch: string,
  runId: number,
  fetchers: RequestedRunFetchers = liveRequestedRunFetchers,
): Promise<"cached" | "fetched" | "ownership-mismatch"> {
  const run = compactRun(await fetchers.fetchWorkflowRun(repo, runId));
  if (
    !run.headBranch
    || run.headBranch !== headBranch
    || (run.prNumber !== null && run.prNumber !== number)
    || !claimWorkflowRunForPr(repo, runId, number, headBranch)
  ) {
    return "ownership-mismatch";
  }

  storeRun(repo, number, run);
  if (!claimWorkflowRunForPr(repo, runId, number, headBranch)) {
    return "ownership-mismatch";
  }
  const latest = latestWorkflowRunAttempt(repo, runId);
  if (!latest) throw new Error("Actions run disappeared while caching");
  renewActionsLease(repo, number, headSha);
  if (latest.status === "completed" && latest.reconciled_at !== null) {
    return "cached";
  }
  const reconciled = await queueReconciliation(repo, compactStoredRun(latest), fetchers, false);
  if (latest.status === "completed" && !reconciled) {
    throw new Error(`Actions run ${runId} reconciliation did not complete`);
  }
  return "fetched";
}

async function repairActionsLease(repo: string, number: number, headSha: string, fetchers: ActionsFetchers): Promise<void> {
  const lease = actionsLease(repo, number);
  if (!lease || lease.head_sha !== headSha) return;
  if (lease.bootstrapped_at === null) {
    const runs = await fetchers.fetchWorkflowRuns(repo, headSha);
    for (const raw of runs) storeRun(repo, number, compactRun(raw));
    for (const raw of runs) {
      const run = compactRun(raw);
      if (run.status !== "completed") await queueReconciliation(repo, run, fetchers, false);
    }
    markActionsLeaseBootstrapped(repo, number, headSha);
  }
  for (const row of workflowRunsForLease(repo, number, headSha)) {
    if (row.status !== "completed" || row.reconciled_at !== null) continue;
    await queueReconciliation(repo, {
      id: row.run_id, attempt: row.run_attempt, headSha: row.head_sha, headBranch: row.head_branch,
      workflowName: row.workflow_name, workflowPath: row.workflow_path,
      displayTitle: row.display_title, event: row.event, actorLogin: row.actor_login,
      prNumber: row.pr_number, status: row.status, conclusion: row.conclusion,
      eventAt: row.event_at, createdAt: row.created_at, updatedAt: row.updated_at,
      runStartedAt: row.run_started_at, runNumber: row.run_number, htmlUrl: row.html_url,
    }, fetchers, false);
  }
}

function queueActionsLease(
  repo: string,
  number: number,
  headSha: string,
  fetchers: ActionsFetchers,
): Promise<void> {
  const key = `${repo}#${number}`;
  const pending = activations.get(key);
  if (pending?.headSha === headSha) return pending.promise;
  const start = pending
    ? pending.promise.catch(() => {}).then(() => repairActionsLease(repo, number, headSha, fetchers))
    : repairActionsLease(repo, number, headSha, fetchers);
  let entry: { headSha: string; promise: Promise<void> };
  entry = {
    headSha,
    promise: start.finally(() => {
      if (activations.get(key) === entry) activations.delete(key);
    }),
  };
  activations.set(key, entry);
  return entry.promise;
}

export async function cacheGithubActionsForCommit(
  repo: string,
  number: number,
  headSha: string,
  fetchers: ActionsFetchers = liveFetchers,
): Promise<void> {
  const runs = (await fetchers.fetchWorkflowRuns(repo, headSha)).map(compactRun);
  for (const run of runs) storeRun(repo, number, run);
  for (const run of runs) {
    const jobs = (await fetchers.fetchRunJobs(repo, run.id, run.status === "completed" ? run.attempt : undefined))
      .map((job) => compactJob(job, run));
    for (const job of jobs) storeJob(repo, job);
    markWorkflowRunJobsFetched(repo, run.id, run.attempt);
  }
}

export async function cacheRepoActionsRunJobs(
  run: WorkflowRunRow,
  fetchers: ActionsFetchers = liveFetchers,
  background = false,
): Promise<boolean> {
  if (background && await fetchers.restRemaining() <= REST_BACKGROUND_RESERVE) return false;
  const compact: CompactRun = {
    id: run.run_id,
    attempt: run.run_attempt,
    headSha: run.head_sha,
    headBranch: run.head_branch,
    workflowName: run.workflow_name,
    workflowPath: run.workflow_path,
    displayTitle: run.display_title,
    event: run.event,
    actorLogin: run.actor_login,
    prNumber: run.pr_number,
    status: run.status,
    conclusion: run.conclusion,
    eventAt: run.event_at,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    runStartedAt: run.run_started_at,
    runNumber: run.run_number,
    htmlUrl: run.html_url,
  };
  const jobs = await fetchers.fetchRunJobs(
    run.repo,
    run.run_id,
    run.status === "completed" ? run.run_attempt : undefined,
  );
  for (const job of jobs) storeJob(run.repo, compactJob(job, compact));
  markWorkflowRunJobsFetched(run.repo, run.run_id, run.run_attempt);
  return true;
}

export function activateActionsLease(
  repo: string,
  number: number,
  headSha: string,
  fetchers: ActionsFetchers = liveFetchers,
): Promise<void> {
  renewActionsLease(repo, number, headSha);
  return queueActionsLease(repo, number, headSha, fetchers);
}


export async function ingestActionsState(
  repo: string,
  state: { run?: CompactRun; job?: CompactJob },
  fetchers: ActionsFetchers = liveFetchers,
): Promise<boolean> {
  const item = state.run ?? state.job;
  if (!item) return false;
  const pr = openPrForAction(repo, item.headSha, item.headBranch);
  if (state.run) {
    const changed = storeRun(repo, pr?.number ?? null, state.run);
    if (!pr) return changed;
    const lease = actionsLease(repo, pr.number);
    if (changed && lease?.head_sha === pr.head_sha && state.run.status === "completed") {
      const row = workflowRunsForLease(repo, pr.number, pr.head_sha)
        .find((candidate) => candidate.run_id === state.run!.id && candidate.run_attempt === state.run!.attempt);
      if (row?.reconciled_at === null) await queueReconciliation(repo, state.run, fetchers, true);
    }
    return changed;
  }
  const job = state.job!;
  if (!job.headSha) return false;
  const changed = storeJob(repo, job);
  if (!pr) return changed;
  const lease = actionsLease(repo, pr.number);
  if (changed && lease?.head_sha === pr.head_sha && jobProducesLog(job) && getRunJobLog(repo, job.id) === null) {
    await fetchLogs(repo, [job], fetchers, true);
  }
  return changed;
}

export interface CachedJobLog {
  job: RunJobRow;
  body: string | null;
}

export interface ActionJobLog extends CachedJobLog {
  state: "pending" | "not-produced" | "ready" | "deferred";
}

export async function actionJobLog(
  repo: string,
  headSha: string,
  jobId: number,
  fetchers: ActionsFetchers = liveFetchers,
  background = false,
): Promise<ActionJobLog | null> {
  let job = listRunJobs(repo, headSha).find((candidate) => candidate.job_id === jobId);
  if (!job) return null;
  if (!jobIsComplete(job)) return { job, body: null, state: "pending" };
  if (!jobProducesLog(job)) return { job, body: null, state: "not-produced" };

  const cachedBefore = getRunJobLog(repo, jobId);
  const canUseCached = cachedBefore !== null && job.log_truncated !== 1;
  if (cachedBefore === null || job.log_truncated === 1 || job.log_format_version < RUN_JOB_LOG_FORMAT_VERSION) {
    if (background && await fetchers.restRemaining() <= REST_BACKGROUND_RESERVE) {
      return { job, body: null, state: "deferred" };
    }
    const key = `${repo}:${jobId}`;
    let pending = logFetches.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const body = cleanJobLog(await fetchers.fetchJobLog(repo, jobId));
          const compressed = await gzipAsync(body);
          if (!saveRunJobLog(repo, jobId, job.run_id, job.run_attempt, headSha, compressed, Buffer.byteLength(body))) {
            throw new Error("job changed before its log could be cached");
          }
        } catch (error) {
          saveRunJobLogError(repo, jobId, job.run_attempt, error instanceof Error ? error.message : String(error));
          if (!canUseCached) throw error;
        }
      })().finally(() => logFetches.delete(key));
      logFetches.set(key, pending);
    }
    await pending;
    job = listRunJobs(repo, headSha).find((candidate) => candidate.job_id === jobId) ?? job;
  }

  const compressed = getRunJobLog(repo, jobId);
  if (!compressed) return { job, body: null, state: "ready" };
  return {
    job,
    state: "ready",
    body: (await gunzipAsync(compressed)).toString(),
  };
}


export async function cachedJobLogs(repo: string, headSha: string, checkName?: string): Promise<CachedJobLog[]> {
  const jobs = listRunJobs(repo, headSha).filter((job) =>
    jobIsComplete(job) && job.conclusion !== null && LOG_WORTHY_CONCLUSION.has(job.conclusion)
  );
  const matched = checkName ? jobs.filter((job) => job.name.toLowerCase().includes(checkName.toLowerCase())) : jobs;
  const entries: CachedJobLog[] = [];
  for (const job of matched) {
    const gz = getRunJobLog(repo, job.job_id);
    entries.push({ job, body: gz ? (await gunzipAsync(gz)).toString() : null });
  }
  return entries;
}

export function formatRunJobs(headSha: string, jobs: RunJobRow[]): string {
  if (jobs.length === 0) return `No cached Actions jobs for ${headSha}.\n`;
  const rows = jobs.map((job) => {
    const labels = (JSON.parse(job.labels_json) as string[]).join(", ");
    const scheduling = job.runner_name
      ? ` · runner ${job.runner_group_name ? `${job.runner_group_name}/` : ""}${job.runner_name}`
      : labels ? ` · requested ${labels}` : "";
    return `- ${job.workflow_name ? `${job.workflow_name} / ` : ""}${job.name}: ${job.conclusion ?? job.status}${scheduling}`;
  });
  return `Cached Actions jobs for ${headSha}\n\n${rows.join("\n")}\n`;
}

export function formatJobLogs(headSha: string, entries: CachedJobLog[]): string {
  if (entries.length === 0) return `No cached jobs for ${headSha}. Nothing failed, or the run has not finished.\n`;
  const sections = entries.map(({ job, body }) => {
    const facts = [
      job.conclusion ?? job.status,
      job.failed_step ? `failed step: ${job.failed_step}` : null,
      job.log_truncated === 1 ? "legacy truncated log" : null,
      job.html_url,
    ].filter((fact) => fact !== null);
    const text = body ?? `no log cached: ${job.log_error ?? (jobIsComplete(job) ? "log fetch pending" : "job is not complete")}`;
    return `===== ${job.name} · ${facts.join(" · ")}\n\n${text.endsWith("\n") ? text : `${text}\n`}`;
  });
  return `Cached job logs for ${headSha} · ${entries.length} job(s)\n\n${sections.join("\n")}`;
}
