import type { PrDetail } from "./github.ts";

export type PrCheck = NonNullable<PrDetail["lastCommit"]["nodes"][number]["commit"]["statusCheckRollup"]>["contexts"]["nodes"][number];

// a check that never ran produced no verdict, so it is neither passed nor failed
export type CheckState = "passed" | "running" | "skipped" | "cancelled" | "failed";

// GitHub's CheckRun conclusions plus the StatusContext states and the non-completed statuses
const STATE_BY_RESULT: Record<string, CheckState> = {
  SUCCESS: "passed",
  SKIPPED: "skipped",
  NEUTRAL: "skipped",
  STALE: "failed",
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

// Select each job's latest check, not every job from only the latest workflow run.
// Metadata-only names do not replace required jobs; distinct workflow/app sources stay separate.
export function currentChecks(checks: PrCheck[]): PrCheck[] {
  const selected = new Map<string, PrCheck>();
  for (const check of checks) {
    const run = check.__typename === "CheckRun" ? check.checkSuite?.workflowRun : null;
    const workflow = run ? String(run.workflow.databaseId ?? run.workflow.name) : "";
    const identity = check.__typename === "CheckRun"
      ? `check:${check.checkSuite?.app?.databaseId ?? ""}:${workflow}:${check.name}`
      : `status:${check.context}`;
    const previous = selected.get(identity);
    const observedAt = (value: PrCheck) => value.__typename === "CheckRun"
      ? value.startedAt ?? value.completedAt ?? ""
      : value.createdAt ?? "";
    const jobId = (value: PrCheck) => value.__typename === "CheckRun"
      ? value.databaseId ?? Number(value.detailsUrl?.match(/\/jobs?\/(\d+)/)?.[1] ?? 0) : 0;
    const runId = (value: PrCheck) => value.__typename === "CheckRun"
      ? value.checkSuite?.workflowRun?.databaseId ?? 0 : 0;
    if (!previous || jobId(check) > jobId(previous)
      || (jobId(check) === jobId(previous) && (runId(check) > runId(previous)
        || (runId(check) === runId(previous) && observedAt(check) >= observedAt(previous))))) {
      selected.set(identity, check);
    }
  }
  return [...selected.values()];
}

// Skipped and neutral jobs satisfy GitHub's required checks, without claiming they ran.
export function unsatisfiedRequiredChecks(detailJson: string): string[] {
  let detail: PrDetail | null = null;
  try {
    detail = JSON.parse(detailJson) as PrDetail;
  } catch {
    return [];
  }
  const nodes = detail?.lastCommit?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  return currentChecks(nodes)
    .filter((check) => check.isRequired === true && !["passed", "skipped"].includes(checkState(check)))
    .map((check) => String(check.__typename === "CheckRun" ? check.name : check.context));
}
