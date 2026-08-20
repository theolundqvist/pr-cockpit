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
