import { gunzipSync, gzipSync } from "node:zlib";
import { checkState } from "./checkState.ts";
import { getRunJobLog, listRunJobs, saveRunJobLog, saveRunJobLogError, upsertRunJob, type RunJobRow } from "./db.ts";
import { fetchGithubQuota, fetchJobLog, fetchRunJobs, type PrDetail, type RunJob } from "./github.ts";

// A 256 KB tail carried the failure evidence in every one of 14 sampled real failures on
// scape-app/scape, the largest of which was 603 KB raw.
export const JOB_LOG_TAIL_BYTES = 262_144;
// Log downloads spend the same REST pool as merges and diffs, so background fetching stops early.
export const REST_BACKGROUND_RESERVE = 500;
const RUN_FETCH_CONCURRENCY = 4;
// success and skipped jobs have no reader; a null conclusion means the job never finished
const LOG_WORTHY_CONCLUSION: Record<string, true> = {
  failure: true,
  cancelled: true,
  timed_out: true,
  action_required: true,
  neutral: true,
};

const TIMESTAMP_LINE_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z /gm;
// ANSI SGR codes; \u001b is a control character by definition
const ANSI_RE = /\u001b\[[0-9;]*m/g;

export interface JobLogFetchers {
  fetchRunJobs: typeof fetchRunJobs;
  fetchJobLog: typeof fetchJobLog;
  restRemaining: () => Promise<number>;
}

const liveFetchers: JobLogFetchers = {
  fetchRunJobs,
  fetchJobLog,
  restRemaining: async () => (await fetchGithubQuota()).rest.remaining,
};

export function cleanJobLog(text: string): { body: string; truncated: boolean } {
  const plain = text.replace(/^\uFEFF/, "").replace(TIMESTAMP_LINE_RE, "").replace(ANSI_RE, "");
  if (Buffer.byteLength(plain) <= JOB_LOG_TAIL_BYTES) return { body: plain, truncated: false };
  const tail = Buffer.from(plain).subarray(-JOB_LOG_TAIL_BYTES).toString();
  // a byte cut lands mid-line, and half a line reads as corrupt output rather than a tail
  const firstBreak = tail.indexOf("\n");
  return { body: firstBreak === -1 ? tail : tail.slice(firstBreak + 1), truncated: true };
}

// The run a check belongs to is the only contractual route to its job ids: GitHub documents
// details_url as an arbitrary integrator URL, so its /job/<id> shape must never be parsed.
export function failingRunIds(detail: PrDetail): number[] {
  const nodes = detail.lastCommit?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const runIds = new Set<number>();
  for (const check of nodes) {
    if (check.__typename !== "CheckRun") continue;
    const state = checkState(check);
    if (state !== "failed" && state !== "cancelled") continue;
    const runId = check.checkSuite?.workflowRun?.databaseId;
    if (typeof runId === "number") runIds.add(runId);
  }
  return [...runIds];
}

function storeJob(repo: string, job: RunJob): void {
  upsertRunJob({
    repo,
    job_id: job.id,
    run_id: job.run_id,
    run_attempt: job.run_attempt ?? 1,
    head_sha: job.head_sha,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    started_at: job.started_at,
    completed_at: job.completed_at,
    html_url: job.html_url,
    failed_step: job.steps?.find((step) => step.conclusion === "failure")?.name ?? null,
  });
}

async function storeJobLog(repo: string, job: RunJob, fetchers: JobLogFetchers): Promise<void> {
  try {
    const { body, truncated } = cleanJobLog(await fetchers.fetchJobLog(repo, job.id));
    saveRunJobLog(repo, job.id, gzipSync(body), Buffer.byteLength(body), truncated);
  } catch (err) {
    saveRunJobLogError(repo, job.id, err instanceof Error ? err.message : String(err));
  }
}

async function syncRun(repo: string, runId: number, fetchers: JobLogFetchers, background: boolean): Promise<void> {
  const jobs = await fetchers.fetchRunJobs(repo, runId);
  const wanted: RunJob[] = [];
  for (const job of jobs) {
    storeJob(repo, job);
    const logged = job.status === "completed" && job.conclusion !== null && LOG_WORTHY_CONCLUSION[job.conclusion] === true;
    if (logged && !getRunJobLog(repo, job.id)) wanted.push(job);
  }
  if (wanted.length === 0) return;
  if (background && (await fetchers.restRemaining()) - wanted.length < REST_BACKGROUND_RESERVE) {
    for (const job of wanted) saveRunJobLogError(repo, job.id, "log not fetched: REST quota reserved for actions");
    return;
  }
  for (const job of wanted) await storeJobLog(repo, job, fetchers);
}

// Runs are fetched in parallel while each run's own logs are fetched serially: a run contributes at
// most one in-flight download, which keeps a 30-job matrix from opening 30 sockets at once.
export async function syncRunJobs(
  repo: string,
  detail: PrDetail,
  { background = true, fetchers = liveFetchers }: { background?: boolean; fetchers?: JobLogFetchers } = {},
): Promise<void> {
  const runIds = failingRunIds(detail);
  for (let index = 0; index < runIds.length; index += RUN_FETCH_CONCURRENCY) {
    const wave = runIds.slice(index, index + RUN_FETCH_CONCURRENCY);
    const settled = await Promise.allSettled(wave.map((runId) => syncRun(repo, runId, fetchers, background)));
    for (const result of settled) {
      if (result.status === "rejected") console.error(`run job sync failed for ${repo}:`, result.reason);
    }
  }
}

export interface CachedJobLog {
  job: RunJobRow;
  body: string | null;
}

export function cachedJobLogs(repo: string, headSha: string, checkName?: string): CachedJobLog[] {
  const jobs = listRunJobs(repo, headSha).filter((job) => job.conclusion !== "success" && job.conclusion !== "skipped");
  const matched = checkName
    ? jobs.filter((job) => job.name.toLowerCase().includes(checkName.toLowerCase()))
    : jobs;
  return matched.map((job) => {
    const gz = getRunJobLog(repo, job.job_id);
    return { job, body: gz ? gunzipSync(gz).toString() : null };
  });
}

export function formatJobLogs(headSha: string, entries: CachedJobLog[]): string {
  if (entries.length === 0) return `No cached jobs for ${headSha}. Nothing failed, or the run has not finished.\n`;
  const sections = entries.map(({ job, body }) => {
    const facts = [
      job.conclusion ?? job.status,
      job.failed_step ? `failed step: ${job.failed_step}` : null,
      job.log_truncated === 1 ? `truncated to the last ${JOB_LOG_TAIL_BYTES / 1024} KB` : null,
      job.html_url,
    ].filter((fact) => fact !== null);
    const text = body ?? `no log cached: ${job.log_error ?? "job is not complete"}`;
    return `===== ${job.name} · ${facts.join(" · ")}\n\n${text.endsWith("\n") ? text : `${text}\n`}`;
  });
  return `Cached job logs for ${headSha} · ${entries.length} job(s)\n\n${sections.join("\n")}`;
}
