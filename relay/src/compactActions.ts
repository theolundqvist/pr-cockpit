export interface CompactRun {
  id: number;
  attempt: number;
  headSha: string;
  headBranch: string;
  workflowName: string;
  status: string;
  conclusion: string | null;
  eventAt: string;
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

export function deliveredCursor(latest: number, events: Array<{ seq: number }>): number {
  return events.at(-1)?.seq ?? latest;
}
export function compactActions(event: string, payload: any): { run?: CompactRun; job?: CompactJob } {
  if (event === "workflow_run" && payload.workflow_run) {
    const run = payload.workflow_run;
    return { run: {
      id: run.id,
      attempt: run.run_attempt ?? 1,
      headSha: run.head_sha,
      headBranch: run.head_branch ?? "",
      workflowName: run.name ?? run.workflow_name ?? "",
      status: run.status,
      conclusion: run.conclusion ?? null,
      eventAt: run.updated_at ?? run.run_started_at,
      htmlUrl: run.html_url ?? null,
    } };
  }
  if (event === "workflow_job" && payload.workflow_job) {
    const job = payload.workflow_job;
    return { job: {
      id: job.id,
      runId: job.run_id,
      attempt: job.run_attempt ?? 1,
      headSha: job.head_sha ?? payload.workflow_run?.head_sha ?? "",
      headBranch: job.head_branch ?? payload.workflow_run?.head_branch ?? "",
      workflowName: job.workflow_name ?? payload.workflow_run?.name ?? "",
      name: job.name,
      status: job.status,
      conclusion: job.conclusion ?? null,
      startedAt: job.started_at ?? null,
      completedAt: job.completed_at ?? null,
      htmlUrl: job.html_url ?? null,
      runnerName: job.runner_name ?? null,
      runnerGroupName: job.runner_group_name ?? null,
      labels: job.labels ?? [],
      failedStep: job.steps?.find((step: any) => step.conclusion === "failure")?.name ?? null,
    } };
  }
  return {};
}
