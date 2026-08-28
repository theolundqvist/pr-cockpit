import { fetchRepoActionLog, fetchRepoActions } from "./api.js";

const MAX_RUNS = 20;
const MAX_LOGS = 100;
const RUN_CACHE_MS = 15_000;
const runSnapshots = new Map();
const runSnapshotRequests = new Map();
const rememberedRuns = new Map();
const actionLogs = new Map();
const actionLogRequests = new Map();

const terminalFailures = new Set(["failure", "timed_out", "action_required", "startup_failure", "stale"]);
const runningStatuses = new Set(["in_progress", "pending", "waiting", "requested"]);

function boundedSet(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

function runKey(run) {
  return `${run.repo}:${run.headSha ?? ""}:${run.id}`;
}

export function actionLogKey(repo, headSha, jobId) {
  return `${repo}:${headSha}:${jobId}`;
}

export function rememberActionRun(run) {
  boundedSet(rememberedRuns, `${run.repo}:${run.id}`, run, MAX_RUNS);
}

export function rememberedActionRun(repo, runId) {
  return rememberedRuns.get(`${repo}:${runId}`) ?? null;
}

export function chooseDefaultActionJob(jobs) {
  return jobs.find((job) => terminalFailures.has(job.conclusion))
    ?? jobs.find((job) => runningStatuses.has(job.status))
    ?? jobs.find((job) => job.conclusion !== "skipped")
    ?? null;
}

function prioritizedJobs(jobs) {
  return jobs
    .filter((job) => job.conclusion !== "skipped")
    .map((job, index) => ({
      job,
      index,
      priority: terminalFailures.has(job.conclusion) ? 0 : runningStatuses.has(job.status) ? 1 : 2,
    }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(({ job }) => job);
}

export function cachedActionLog(key) {
  return actionLogs.get(key) ?? null;
}

export function loadActionLog(key, loader) {
  const cached = actionLogs.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = actionLogRequests.get(key);
  if (pending) return pending;
  const request = loader().then((result) => {
    if (result?.state === "ready" || result?.state === "not-produced") {
      boundedSet(actionLogs, key, result, MAX_LOGS);
    }
    return result;
  }).finally(() => actionLogRequests.delete(key));
  actionLogRequests.set(key, request);
  return request;
}

export async function prefetchActionLogs(jobs, keyForJob, loaderForJob, isCurrent = () => true) {
  const queue = prioritizedJobs(jobs);
  let cursor = 0;
  async function worker() {
    while (isCurrent()) {
      const job = queue[cursor++];
      if (!job) return;
      try {
        await loadActionLog(keyForJob(job), () => loaderForJob(job));
      } catch {
        // Background prefetch is opportunistic; interactive selection surfaces its own error.
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
}

export function loadRepoRunSnapshot(run, background = false) {
  const key = runKey(run);
  const cached = runSnapshots.get(key);
  if (cached && Date.now() - cached.at < RUN_CACHE_MS) return Promise.resolve(cached.snapshot);
  const pending = runSnapshotRequests.get(key);
  if (pending) return pending;
  rememberActionRun(run);
  const request = fetchRepoActions({
    repo: [run.repo],
    headSha: run.headSha ?? "",
    runId: run.id,
    prefetch: background ? "1" : "",
  }).then((snapshot) => {
    boundedSet(runSnapshots, key, { at: Date.now(), snapshot }, MAX_RUNS);
    if (snapshot.selectedRun) rememberActionRun(snapshot.selectedRun);
    return snapshot;
  }).finally(() => runSnapshotRequests.delete(key));
  runSnapshotRequests.set(key, request);
  return request;
}

export function prefetchRepoRun(run) {
  let current = true;
  void loadRepoRunSnapshot(run, true).then((snapshot) => {
    if (!current) return;
    const jobs = snapshot.jobs.filter((job) => job.runId === run.id);
    return prefetchActionLogs(
      jobs,
      (job) => actionLogKey(run.repo, run.headSha, job.id),
      (job) => fetchRepoActionLog(run.repo, run.headSha, job.id, null, true),
      () => current,
    );
  }).catch(() => {});
  return () => (current = false);
}
