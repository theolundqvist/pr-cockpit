import { relativeTime } from "./time.js";

export const CHECK_BUCKETS = {
  failing: { section: "failing", summary: "failing", dot: "bad" },
  queued: { section: "pending", summary: "queued", dot: "neutral" },
  expected: { section: "pending", summary: "expected", dot: "neutral" },
  in_progress: { section: "in progress", summary: "in progress", dot: "run" },
  neutral: { section: "skipped", summary: "neutral", dot: "neutral" },
  skipped: { section: "skipped", summary: "skipped", dot: "neutral" },
  success: { section: "successful", summary: "successful", dot: "ok" },
};

export const CHECK_SECTIONS = ["failing", "pending", "in progress", "skipped", "successful"];

export function checkBucket(c) {
  if (c.__typename === "CheckRun") {
    const status = (c.status ?? "").toUpperCase();
    if (status !== "COMPLETED") return status === "IN_PROGRESS" ? "in_progress" : "queued";
    const conclusion = (c.conclusion ?? "").toUpperCase();
    if (conclusion === "SUCCESS") return "success";
    if (conclusion === "SKIPPED") return "skipped";
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
        required: c.isRequired ?? false,
        bucket,
        dot: CHECK_BUCKETS[bucket].dot,
        status: checkStatus(bucket, startedAt, completedAt),
      };
    })
    .filter((check) => check.bucket !== "failing" || !live.has(check.name));
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
