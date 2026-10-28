import { relativeTime } from "./time.js";

export const CHECK_BUCKETS = {
  failing: { section: "failing", summary: "failing", icon: { status: "completed", conclusion: "failure" } },
  in_progress: { section: "in progress", summary: "in progress", icon: { status: "in_progress", conclusion: null } },
  queued: { section: "pending", summary: "queued", icon: { status: "queued", conclusion: null } },
  expected: { section: "pending", summary: "expected", icon: { status: "pending", conclusion: null } },
  success: { section: "successful", summary: "successful", icon: { status: "completed", conclusion: "success" } },
  cancelled: { section: "cancelled", summary: "cancelled", icon: { status: "completed", conclusion: "cancelled" } },
  neutral: { section: "skipped", summary: "neutral", icon: { status: "completed", conclusion: "neutral" } },
  skipped: { section: "skipped", summary: "skipped", icon: { status: "completed", conclusion: "skipped" } },
};

export const CHECK_SECTIONS = ["failing", "in progress", "pending", "successful", "cancelled", "skipped"];

export function checkBucket(c) {
  if (c.__typename === "CheckRun") {
    const status = (c.status ?? "").toUpperCase();
    if (status !== "COMPLETED") return status === "IN_PROGRESS" ? "in_progress" : "queued";
    const conclusion = (c.conclusion ?? "").toUpperCase();
    if (conclusion === "SUCCESS") return "success";
    if (conclusion === "SKIPPED") return "skipped";
    if (conclusion === "CANCELLED") return "cancelled";
    if (conclusion === "NEUTRAL" || conclusion === "STALE") return "neutral";
    return "failing";
  }
  const state = (c.state ?? "").toUpperCase();
  if (state === "SUCCESS") return "success";
  if (state === "FAILURE" || state === "ERROR") return "failing";
  if (state === "EXPECTED") return "expected";
  return "queued";
}

export function checkName(c) {
  if (c.__typename !== "CheckRun") return c.context;
  const wf = c.checkSuite?.workflowRun?.workflow?.name;
  return wf ? `${wf} / ${c.name}` : c.name;
}

export function checkDuration(startedAt, completedAt) {
  if (!startedAt || !completedAt) return null;
  const ms = new Date(completedAt) - new Date(startedAt);
  if (!(ms >= 0)) return null;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function checkStatus(bucket, startedAt, completedAt) {
  const dur = checkDuration(startedAt, completedAt);
  if (bucket === "failing") return dur ? `Failing after ${dur}` : "Failing";
  if (bucket === "success") return dur ? `Successful in ${dur}` : "Successful";
  if (bucket === "cancelled") return dur ? `Cancelled after ${dur}` : "Cancelled";
  if (bucket === "in_progress") {
    if (!startedAt) return "In progress";
    const rt = relativeTime(startedAt);
    return rt === "now" ? "Started just now" : `Started ${rt} ago`;
  }
  if (bucket === "queued") return "Queued";
  if (bucket === "expected") return "Expected";
  if (bucket === "neutral") return "Neutral";
  return "Skipped";
}

// GitHub leaves a job's previous attempt in the rollup when it is re-run, so a failing check whose
// name is queued or running again is a verdict about code that is already being re-checked
export function liveCheckNames(nodes) {
  const live = new Set();
  for (const c of nodes) {
    const bucket = checkBucket(c);
    if (bucket === "queued" || bucket === "expected" || bucket === "in_progress") live.add(checkName(c));
  }
  return live;
}

export function buildChecks(rollup) {
  const nodes = rollup?.contexts.nodes ?? [];
  const live = liveCheckNames(nodes);
  return nodes
    .map((c) => {
      const bucket = checkBucket(c);
      const startedAt = c.startedAt ?? null;
      const completedAt = c.completedAt ?? null;
      return {
        name: checkName(c),
        url: c.detailsUrl ?? c.targetUrl ?? null,
        jobId: c.__typename === "CheckRun"
          ? Number(c.detailsUrl?.match(/\/job\/(\d+)/)?.[1]) || null
          : null,
        required: c.isRequired ?? false,
        bucket,
        icon: CHECK_BUCKETS[bucket].icon,
        status: checkStatus(bucket, startedAt, completedAt),
      };
    })
    .filter((check) => (check.bucket !== "failing" && check.bucket !== "cancelled") || !live.has(check.name));
}

// Preview servers publish a link-only "Prompt preview" check run whose details URL is the PR's rendered prompt diff.
// A re-run leaves the earlier run in the rollup, so the most recently started one wins.
export function promptDiffLink(rollup) {
  let latest = null;
  for (const c of rollup?.contexts.nodes ?? []) {
    if (c.__typename !== "CheckRun" || c.name !== "Prompt preview" || !c.detailsUrl) continue;
    if (!latest || (c.startedAt ?? "") >= (latest.startedAt ?? "")) latest = c;
  }
  if (!latest) return null;
  // A neutral conclusion means the diff could not be generated; the link stays, labelled with that conclusion.
  return { url: latest.detailsUrl, hint: (latest.conclusion ?? "").toUpperCase() === "NEUTRAL" ? "Check concluded neutral" : null };
}

export function countChecks(checks) {
  const counts = {};
  for (const c of checks) counts[c.bucket] = (counts[c.bucket] ?? 0) + 1;
  return counts;
}

export function summarizeChecks(counts) {
  return Object.keys(CHECK_BUCKETS)
    .filter((b) => counts[b])
    .map((b) => `${counts[b]} ${CHECK_BUCKETS[b].summary}`)
    .join(", ");
}

export function sectionizeChecks(checks) {
  const groups = new Map();
  for (const c of checks) {
    const section = CHECK_BUCKETS[c.bucket].section;
    if (!groups.has(section)) groups.set(section, []);
    groups.get(section).push(c);
  }
  return CHECK_SECTIONS.filter((s) => groups.has(s)).map((s) => ({ section: s, rows: groups.get(s) }));
}

export function ciFixPrompt({ repo, number, branch, checks }) {
  const prUrl = `https://github.com/${repo}/pull/${number}`;
  const checkCommand = `gh pr checks ${number} --repo ${repo}`;
  const rows = checks.map((check) => [
    `- ${check.name}${check.required ? " (required)" : ""}`,
    `  Status: ${check.status || "Failing"}`,
    `  Logs: ${check.url || checkCommand}`,
  ].join("\n"));

  return [
    `Fix the failing CI on ${repo} PR #${number}.`,
    "",
    `PR: ${prUrl}`,
    `Branch: ${branch}`,
    "",
    "Failing checks:",
    ...rows,
    "",
    `Start by inspecting the failed logs with: ${checkCommand}`,
    `Fix the root cause, run the narrowest relevant checks locally, and push the fix to ${branch}.`,
  ].join("\n");
}
