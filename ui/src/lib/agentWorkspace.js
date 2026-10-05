import { prKeyOf } from "./prKey.js";

// Navigation, status and search rules for the Agents workspace. The PR page keeps agentRuns.js.

const AGENTS_BASE = "#/agents";
const POSITIVE_INT = /^[1-9]\d*$/;
const REPO_NAME = /^[^/\s]+\/[^/\s]+$/;

export function isAgentsHash(hash) {
  const query = hash.indexOf("?");
  return (query === -1 ? hash : hash.slice(0, query)) === AGENTS_BASE;
}

// `latest` is bare #/agents; `invalid` keeps a malformed link requested instead of guessing a session.
export function parseAgentsRoute(hash) {
  if (!isAgentsHash(hash)) return null;
  const query = hash.indexOf("?");
  const params = new URLSearchParams(query === -1 ? "" : hash.slice(query + 1));
  const repo = params.get("repo");
  const pr = params.get("pr");
  const run = params.get("run");
  if (repo === null && pr === null && run === null) return { kind: "latest" };
  const number = Number(pr);
  const runId = run === null ? null : Number(run);
  if (!repo || !REPO_NAME.test(repo) || !POSITIVE_INT.test(pr ?? "") || !Number.isSafeInteger(number) || (run !== null && (!POSITIVE_INT.test(run) || !Number.isSafeInteger(runId)))) {
    return { kind: "invalid" };
  }
  return { kind: "session", repo, number, runId };
}

export function agentsHref(repo, number, runId = null) {
  const params = new URLSearchParams({ repo, pr: String(number) });
  if (runId !== null) params.set("run", String(runId));
  return `${AGENTS_BASE}?${params}`;
}

export function sameAgentsRoute(a, b) {
  return a.kind === b.kind && a.repo === b.repo && a.number === b.number && a.runId === b.runId;
}

function findConversation(conversations, repo, number) {
  return conversations.find((conversation) => conversation.repo === repo && conversation.number === number) ?? null;
}

// The explicit route a requested one settles to, or null when it is already explicit or cannot be resolved.
// Applied only when the route itself changes, so a poll never rewrites the URL or moves to a newer run.
export function canonicalAgentsRoute(route, conversations) {
  if (route.kind === "latest") {
    const first = conversations[0];
    return first ? { kind: "session", repo: first.repo, number: first.number, runId: first.runs[0]?.id ?? null } : null;
  }
  if (route.kind !== "session" || route.runId !== null) return null;
  const newest = findConversation(conversations, route.repo, route.number)?.runs[0];
  return newest ? { ...route, runId: newest.id } : null;
}

// Pure lookup of an already-settled route; no defaults, so missing targets stay visibly missing.
export function resolveAgentsSelection(route, conversations) {
  if (route.kind === "invalid") return { status: "invalid", conversation: null, runId: null };
  if (route.kind !== "session") return { status: "none", conversation: null, runId: null };
  const conversation = findConversation(conversations, route.repo, route.number);
  if (!conversation) return { status: "missing-session", conversation: null, runId: route.runId };
  if (route.runId === null) {
    return { status: conversation.runs.length ? "choose-run" : "no-runs", conversation, runId: null };
  }
  if (conversation.runs.some((run) => run.id === route.runId)) return { status: "ready", conversation, runId: route.runId };
  const owner = conversations.find((other) => other.runs.some((run) => run.id === route.runId)) ?? null;
  return { status: "missing-run", conversation, runId: route.runId, owner };
}

const ATTENTION_REASONS = { "gave-up": "gave up", "merge-refused": "merge refused", "merge-unavailable": "merge unavailable" };
const FINISHED_REASONS = { "waiting-review": "waiting on review", "no-op": "no changes needed" };

// Workspace-only status for an agent or run row; group drives the sidebar sections.
export function workspaceStatus(row) {
  if (!row) return { label: "No runs", tone: "neutral", group: "recent", reason: null };
  if (row.state === "running") return { label: "Working", tone: "working", group: "working", reason: null };
  if (row.state === "died") return { label: "Needs attention", tone: "attention", group: "attention", reason: "stopped unexpectedly" };
  if (row.state === "killed") return { label: "Stopped", tone: "neutral", group: "recent", reason: null };
  const exit = row.exit_reason;
  if (exit === "merged") return { label: "Merged", tone: "merged", group: "recent", reason: null };
  if (Object.hasOwn(ATTENTION_REASONS, exit)) return { label: "Needs attention", tone: "attention", group: "attention", reason: ATTENTION_REASONS[exit] };
  if (exit === "green") return { label: "Completed", tone: "completed", group: "recent", reason: "checks green" };
  if (exit === "done") return { label: "Completed", tone: "completed", group: "recent", reason: null };
  return { label: "Finished", tone: "neutral", group: "recent", reason: exit ? (Object.hasOwn(FINISHED_REASONS, exit) ? FINISHED_REASONS[exit] : exit) : null };
}

// The persisted agent row predates run history for older sessions, so the newer of the two decides the state.
export function sessionStatusRow(conversation) {
  const run = conversation.runs[0];
  if (!run) return conversation.agent;
  if (!conversation.agent) return run;
  return conversation.agent.started_at > run.started_at ? conversation.agent : run;
}

export function sessionActivity(conversation) {
  let latest = conversation.agent?.started_at ?? "";
  for (const run of conversation.runs) {
    const at = run.ended_at ?? run.started_at;
    if (at > latest) latest = at;
  }
  return latest;
}

export function sessionTitle(conversation) {
  return conversation.title || `${conversation.repo}#${conversation.number}`;
}

export const SESSION_GROUPS = [
  { id: "working", label: "Working" },
  { id: "attention", label: "Needs attention" },
  { id: "recent", label: "Recent" },
];

const SNIPPET_BEFORE = 24;
const SNIPPET_LENGTH = 110;

export function matchSnippet(text, needle) {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = flat.toLowerCase().indexOf(needle);
  if (at === -1) return null;
  const start = Math.max(0, at - SNIPPET_BEFORE);
  const end = Math.min(flat.length, start + SNIPPET_LENGTH);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

// Every whitespace-separated term must appear in the title, repo#number, an agent label or any run brief.
// A term found only in a brief returns that brief's excerpt, since the row does not otherwise show it.
function matchSession(conversation, terms, labelOf) {
  if (!terms.length) return { snippet: null };
  const shown = `${conversation.title ?? ""}\n${conversation.repo}#${conversation.number}`.toLowerCase();
  const labels = [conversation.agent, ...conversation.runs].filter(Boolean).map((row) => labelOf(row).toLowerCase()).join("\n");
  const briefs = conversation.runs.map((run) => run.brief ?? "");
  let snippet = null;
  for (const term of terms) {
    if (shown.includes(term) || labels.includes(term)) continue;
    const brief = briefs.find((text) => text.toLowerCase().includes(term));
    if (brief === undefined) return null;
    snippet ??= matchSnippet(brief, term);
  }
  return { snippet };
}

export function sessionEntries(conversations, query, labelOf) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const entries = [];
  for (const conversation of conversations) {
    const match = matchSession(conversation, terms, labelOf);
    if (!match) continue;
    const statusRow = sessionStatusRow(conversation);
    entries.push({
      conversation,
      key: prKeyOf(conversation.repo, conversation.number),
      statusRow,
      status: workspaceStatus(statusRow),
      snippet: match.snippet,
    });
  }
  return entries;
}

// Sections come from each row's status; backend order is kept inside a section.
export function groupSessionEntries(entries) {
  return SESSION_GROUPS
    .map((group) => ({ ...group, entries: entries.filter((entry) => entry.status.group === group.id) }))
    .filter((group) => group.entries.length);
}
