import { relativeTime } from "./time.js";

const WORKING_WINDOW_MS = 10 * 60_000;

const ISSUE_TEXT = {
  quota: "App quota used up; reads need available quota on your account",
  access: "App cannot read this repository; add it under Manage repositories",
  authentication: "GitHub rejected the App credentials; check the installation under Manage repositories",
  connection: "Could not reach GitHub with the App; retrying with the next read",
  request: "App read failed; retrying with the next read",
};

export const quotaAppSetupRequest = $state({ pending: false });

export function requestQuotaAppSetup(event) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  quotaAppSetupRequest.pending = true;
}

export async function fetchQuotaApp() {
  const response = await fetch("/api/github-app/quota");
  if (!response.ok) throw new Error("App status unavailable");
  const { app } = await response.json();
  if (app === undefined) throw new Error("App status unavailable");
  return app;
}

function clock(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function age(iso) {
  const text = relativeTime(iso);
  return text === "now" ? "just now" : `${text} ago`;
}

function issueText(error, now) {
  const text = ISSUE_TEXT[error.kind] ?? "App read failed";
  return error.resetAt && Date.parse(error.resetAt) > now ? `${text} · resets ${clock(error.resetAt)}` : text;
}

function repositoryStatus({ repo, lastSuccessAt, error }, now, cooldown) {
  const success = lastSuccessAt ? Date.parse(lastSuccessAt) : null;
  const current = error ?? null;
  const recent = success !== null && now - success <= WORKING_WINDOW_MS && !current && !cooldown;
  return {
    repo,
    tone: current ? "issue" : recent ? "working" : "neutral",
    text: recent ? `Working · last App read ${age(lastSuccessAt)}` : success !== null ? `Last successful App read ${age(lastSuccessAt)}` : current ? "No successful App read yet" : "Waiting for first App read",
    issue: current ? issueText(current, now) : null,
    success,
    errorAt: current ? Date.parse(current.at) : null,
  };
}

export function quotaAppStatus(app, now) {
  const health = app?.health;
  if (!health || !Array.isArray(health.repositories)) return null;
  const cooldown = health.cooldownUntil && Date.parse(health.cooldownUntil) > now ? health.cooldownUntil : null;
  const rows = health.repositories.map((item) => repositoryStatus(item, now, cooldown));
  const issues = rows.filter((row) => row.issue);
  const working = rows.filter((row) => row.tone === "working");
  const newest = rows.reduce((best, row) => (row.success !== null && (best === null || row.success > best.success) ? row : best), null);
  let summary;
  if (cooldown) {
    summary = { tone: "issue", text: `GitHub's secondary rate limit pauses all Cockpit reads, App included, until ${clock(cooldown)}` };
  } else if (working.length) {
    const newestWorking = working.reduce((best, row) => (row.success > best.success ? row : best));
    summary = issues.length
      ? { tone: "issue", text: `${issues.length} ${issues.length === 1 ? "repository needs" : "repositories need"} attention` }
      : { tone: "working", text: newestWorking.text };
  } else if (issues.length) {
    const latest = issues.reduce((best, row) => (row.errorAt > best.errorAt ? row : best));
    summary = { tone: "issue", text: latest.issue };
  } else if (newest) {
    summary = { tone: "neutral", text: newest.text };
  } else {
    summary = { tone: "neutral", text: "Waiting for first App read" };
  }
  return { summary, rows };
}
