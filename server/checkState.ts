import type { PrDetail } from "./github.ts";

export type PrCheck = NonNullable<PrDetail["lastCommit"]["nodes"][number]["commit"]["statusCheckRollup"]>["contexts"]["nodes"][number];

// a check that never ran produced no verdict, so it is neither passed nor failed
export type CheckState = "passed" | "running" | "skipped" | "cancelled" | "failed";

// GitHub's CheckRun conclusions plus the StatusContext states and the non-completed statuses
const STATE_BY_RESULT: Record<string, CheckState> = {
  SUCCESS: "passed",
  SKIPPED: "skipped",
  NEUTRAL: "skipped",
  STALE: "skipped",
  CANCELLED: "cancelled",
  FAILURE: "failed",
  ERROR: "failed",
  TIMED_OUT: "failed",
  ACTION_REQUIRED: "failed",
  STARTUP_FAILURE: "failed",
  QUEUED: "running",
  IN_PROGRESS: "running",
  PENDING: "running",
  WAITING: "running",
  REQUESTED: "running",
  EXPECTED: "running",
};

export function checkState(check: PrCheck): CheckState {
  const result = String(check.__typename === "CheckRun" ? check.conclusion ?? check.status : check.state ?? "").toUpperCase();
  // an unrecognised result is reported as failing so a check never reads better than it is
  return STATE_BY_RESULT[result] ?? "failed";
}

// Keep raw contexts/jobs as history; only the newest run of a workflow votes on CI.
export function currentChecks(checks: PrCheck[]): PrCheck[] {
  const latestRuns = new Map<string, number>();
  for (const check of checks) {
    if (check.__typename !== "CheckRun") continue;
    const run = check.checkSuite?.workflowRun;
    if (run?.databaseId == null) continue;
    const identity = String(run.workflow.databaseId ?? run.workflow.name);
    latestRuns.set(identity, Math.max(latestRuns.get(identity) ?? 0, run.databaseId));
  }
  const selected = new Map<string, PrCheck>();
  for (const check of checks) {
    const run = check.__typename === "CheckRun" ? check.checkSuite?.workflowRun : null;
    const workflow = run ? String(run.workflow.databaseId ?? run.workflow.name) : "";
    if (run?.databaseId != null && latestRuns.get(workflow) !== run.databaseId) continue;
    const identity = check.__typename === "CheckRun"
      ? `check:${check.checkSuite?.app?.databaseId ?? ""}:${workflow}:${check.name}`
      : `status:${check.context}`;
    const previous = selected.get(identity);
    const observedAt = (value: PrCheck) => value.__typename === "CheckRun"
      ? value.startedAt ?? value.completedAt ?? ""
      : value.createdAt ?? "";
    const jobId = (value: PrCheck) => value.__typename === "CheckRun"
      ? value.databaseId ?? Number(value.detailsUrl?.match(/\/jobs?\/(\d+)/)?.[1] ?? 0) : 0;
    if (!previous || jobId(check) > jobId(previous)
      || (jobId(check) === jobId(previous) && observedAt(check) >= observedAt(previous))) {
      selected.set(identity, check);
    }
  }
  return [...selected.values()];
}

// a required check only counts as satisfied when it actually passed: skipped, cancelled and
// still-running required checks leave the merge requirement unmet
export function unsatisfiedRequiredChecks(detailJson: string): string[] {
  let detail: PrDetail | null = null;
  try {
    detail = JSON.parse(detailJson) as PrDetail;
  } catch {
    return [];
  }
  const nodes = detail?.lastCommit?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  return nodes
    .filter((check) => check.isRequired === true && checkState(check) !== "passed")
    .map((check) => String(check.__typename === "CheckRun" ? check.name : check.context));
}
