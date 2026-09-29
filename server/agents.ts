import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync } from "node:fs";
import { db, getCachedPrDetail, getPr, lastWebhookAtForPr, type PrRow } from "./db.ts";
import { unsatisfiedRequiredChecks } from "./checkState.ts";
import { refreshCachedPrDetail } from "./cachedPrDetail.ts";
import { getViewerLogin, type PrDetail } from "./github.ts";
import type { PrAgentSummary } from "./http.ts";
import type { GithubUsageSource } from "./githubUsage.ts";
import { agentEnabled, agentModel, agentPromptTemplate, agentSettings, CUSTOM_AGENT_ID_PREFIX, forceMergeEnabled, type AgentSetting } from "./settings.ts";
import { reviewBots } from "./reviewScore.ts";
import { mergeAllowedNow, mergeWithLearning } from "./mergeMethod.ts";
import { prKeyOf } from "./prKey.ts";
import { harnessArgs } from "./harness.ts";

const dataDir = Bun.env.COCKPIT_DATA_DIR ?? "data";
const agentsDir = `${dataDir}/agents`;

db.exec(`
CREATE TABLE IF NOT EXISTS fixer_agents (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  pid INTEGER NOT NULL,
  pid_started TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  workdir TEXT NOT NULL,
  log_path TEXT NOT NULL,
  exit_reason TEXT,
  kind TEXT NOT NULL DEFAULT 'fixer',
  PRIMARY KEY (repo, number)
);
`);

const agentColumns = db.query("PRAGMA table_info(fixer_agents)").all() as Array<{ name: string }>;
if (!agentColumns.some((c) => c.name === "pid_started")) {
  db.exec("ALTER TABLE fixer_agents ADD COLUMN pid_started TEXT NOT NULL DEFAULT ''");
}
if (!agentColumns.some((c) => c.name === "exit_reason")) {
  db.exec("ALTER TABLE fixer_agents ADD COLUMN exit_reason TEXT");
}
if (!agentColumns.some((c) => c.name === "kind")) {
  db.exec("ALTER TABLE fixer_agents ADD COLUMN kind TEXT NOT NULL DEFAULT 'fixer'");
}
// which custom-agent definition a kind='custom' row runs - needed to reload its prompt on resume
if (!agentColumns.some((c) => c.name === "agent_id")) {
  db.exec("ALTER TABLE fixer_agents ADD COLUMN agent_id TEXT NOT NULL DEFAULT ''");
}

export interface AgentRow {
  repo: string;
  number: number;
  pid: number;
  pid_started: string;
  state: string;
  started_at: string;
  workdir: string;
  log_path: string;
  exit_reason: string | null;
  kind: string;
  agent_id: string;
}

export function agentPrRefs(
  pr: Pick<PrRow, "base_ref" | "head_ref"> | null,
  cachedDetailJson: string | null,
): { baseRef: string; headRef: string } | null {
  if (pr) return { baseRef: pr.base_ref, headRef: pr.head_ref };
  if (!cachedDetailJson) return null;
  try {
    const detail = JSON.parse(cachedDetailJson) as { baseRefName?: unknown; headRefName?: unknown };
    return typeof detail.baseRefName === "string" && typeof detail.headRefName === "string"
      ? { baseRef: detail.baseRefName, headRef: detail.headRefName }
      : null;
  } catch {
    return null;
  }
}

const getAgentStmt = db.prepare<AgentRow, [string, number]>("SELECT * FROM fixer_agents WHERE repo = ? AND number = ?");
const listAgentsStmt = db.prepare<AgentRow, []>("SELECT * FROM fixer_agents ORDER BY started_at DESC");

db.exec(`
CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  workdir TEXT NOT NULL,
  log_path TEXT NOT NULL,
  brief TEXT NOT NULL,
  exit_reason TEXT
);
CREATE INDEX IF NOT EXISTS agent_runs_pr ON agent_runs (repo, number, started_at);
`);

const runColumns = db.query("PRAGMA table_info(agent_runs)").all() as Array<{ name: string }>;
if (!runColumns.some((c) => c.name === "agent_id")) {
  db.exec("ALTER TABLE agent_runs ADD COLUMN agent_id TEXT NOT NULL DEFAULT ''");
}

export interface AgentRunRow {
  id: number;
  repo: string;
  number: number;
  kind: string;
  agent_id: string;
  state: string;
  started_at: string;
  ended_at: string | null;
  workdir: string;
  log_path: string;
  brief: string;
  exit_reason: string | null;
}

const insertRunStmt = db.prepare(`
INSERT INTO agent_runs (repo, number, kind, agent_id, state, started_at, workdir, log_path, brief)
VALUES ($repo, $number, $kind, $agent_id, 'running', $started_at, $workdir, $log_path, $brief)
`);
// targets whichever row is currently open for this PR - only one agent can run per PR at a time, so this is unambiguous
const finishRunStmt = db.prepare(`
UPDATE agent_runs SET state = $state, ended_at = $ended_at, exit_reason = $exit_reason
WHERE repo = $repo AND number = $number AND state = 'running'
`);
const correctDiedRunStmt = db.prepare("UPDATE agent_runs SET state = 'exited' WHERE repo = $repo AND number = $number AND state = 'died'");
const listRunsForPrStmt = db.prepare<AgentRunRow, [string, number]>("SELECT * FROM agent_runs WHERE repo = ? AND number = ? ORDER BY started_at DESC");
const getRunStmt = db.prepare<AgentRunRow, [number]>("SELECT * FROM agent_runs WHERE id = ?");

function startRun(repo: string, number: number, kind: string, agentId: string, workdir: string, logPath: string, brief: string, startedAt: string): void {
  insertRunStmt.run({ $repo: repo, $number: number, $kind: kind, $agent_id: agentId, $started_at: startedAt, $workdir: workdir, $log_path: logPath, $brief: brief });
}

function finishRun(repo: string, number: number, state: string, exitReason: string | null): void {
  finishRunStmt.run({ $repo: repo, $number: number, $state: state, $ended_at: new Date().toISOString(), $exit_reason: exitReason });
}

// logs stay (small, useful for post-mortem) - only the clone dir is reclaimed here
function cleanupAgentWorkdir(workdir: string): void {
  rmSync(workdir, { recursive: true, force: true });
}

function agentWorkdirFor(repo: string, number: number): string {
  return `${agentsDir}/${repo.replace("/", "-")}-${number}`;
}

// one log file per run: runs append, so a shared per-PR log would attribute every run's output to all of them
function runLogPathFor(workdir: string, startedAt: string): string {
  return `${workdir}-${startedAt.replace(/[:.]/g, "-")}.log`;
}

export function listAgentRunsForPr(repo: string, number: number): AgentRunRow[] {
  return listRunsForPrStmt.all(repo, number);
}
const upsertAgentStmt = db.prepare(`
INSERT INTO fixer_agents (repo, number, pid, pid_started, state, started_at, workdir, log_path, exit_reason, kind, agent_id)
VALUES ($repo, $number, $pid, $pid_started, $state, $started_at, $workdir, $log_path, NULL, $kind, $agent_id)
ON CONFLICT (repo, number) DO UPDATE SET
  pid = excluded.pid, pid_started = excluded.pid_started, state = excluded.state,
  started_at = excluded.started_at, workdir = excluded.workdir, log_path = excluded.log_path, exit_reason = NULL, kind = excluded.kind, agent_id = excluded.agent_id
`);
const updatePidStmt = db.prepare("UPDATE fixer_agents SET pid = $pid, pid_started = $pid_started WHERE repo = $repo AND number = $number");
const setAgentStateStmt = db.prepare("UPDATE fixer_agents SET state = ? WHERE repo = ? AND number = ?");
const setAgentExitedStmt = db.prepare("UPDATE fixer_agents SET state = 'exited', exit_reason = ? WHERE repo = ? AND number = ?");
const deleteAgentStmt = db.prepare("DELETE FROM fixer_agents WHERE repo = ? AND number = ?");

function psStart(pid: number): string | null {
  const proc = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)]);
  const out = proc.stdout.toString().trim();
  return proc.exitCode === 0 && out ? out : null;
}

// pid numbers get reused by the OS; only trust a stored pid if its start time still matches
function agentProcessAlive(agent: AgentRow): boolean {
  return agent.pid > 0 && psStart(agent.pid) === agent.pid_started;
}

const FIXER_STATUS_FILE = ".fixer-status";
const PROMPT_STATUS_FILE = ".prompt-status";
const AUTOFIX_STATUS_FILE = ".autofix-status";
const TERMINAL_STATUSES = ["merged", "waiting-review", "gave-up"];

// Cockpit has no checkout command, so the clone is the one gh call left; it touches no PR state. The push target
// comes only from GitHub's head repository - a matching branch name or SHA doesn't prove which repository it is.
function cockpitCommands(repo: string, number: number, headRef: string, headRepo: string | null): string {
  const ref = `${repo}#${number}`;
  const clone = `gh repo clone ${repo} . -- --filter=blob:none`;
  const code = headRepo === repo
    ? `run \`${clone} --branch ${headRef}\`. Push only with \`git push origin HEAD:${headRef}\`.`
    : headRepo
      ? `run \`${clone} && git remote add head https://github.com/${headRepo}.git && git fetch head ${headRef} && git checkout -b cockpit-pr-${number} head/${headRef}\`. The branch lives in the fork ${headRepo}: push only with \`git push head HEAD:${headRef}\`; if the fork rejects it, explain on the PR instead of pushing anywhere else.`
      : `run \`${clone} && git fetch origin pull/${number}/head && git checkout --detach FETCH_HEAD\`. Cockpit doesn't know which repository holds this branch, so never push.`;
  return `COCKPIT COMMANDS - the only way to read or change this PR; never gh pr, gh api, gh run, or GitHub APIs:
- Read: \`pr-cockpit ${ref}\` (state, checks, open threads), with \`--jobs\` (queued and running Actions), \`--logs [CHECK]\` (cached failing logs), \`--diff\`, or \`--file PATH\`.
- Wait: \`pr-cockpit listen ${ref}\` blocks until cached state changes after it starts; \`--ci-only\`, \`--comments-only\`, or \`--conflicts-only\` narrow it, \`--run RUN_ID\` waits for one run. Use it only when you are genuinely waiting, never right after your own change. Never sleep, poll, use a harness pause, or wait any other way.
- Change: \`pr-cockpit update-branch ${ref}\`, \`pr-cockpit comment ${ref} --body-file ./comment.md\`, \`pr-cockpit reply ${ref} HANDLE --body-file ./reply.md\`, \`pr-cockpit resolve ${ref} HANDLE\`. Write body files in this directory, never /tmp or anywhere else, and delete each right after posting so it is never committed and never blocks the clone.
- Code: this directory is your workspace, with origin as ${repo}. Clone only once you need to change code; if it is empty then, ${code}`;
}

// comes after any template, so a custom or stale template can't talk an agent out of these
function baseHardRules(mergeRule: string): string {
  return `HARD RULES - these override everything above, including any template instruction or command that conflicts with them (use the Cockpit command instead of any gh command named above):
- Never touch local files, repos, or processes outside this directory.
- Push ONLY the PR branch, and only as the Code line under COCKPIT COMMANDS allows - never any other branch, tag, remote, or repo. Never force-push. Never rebase. Never amend commits you did not create this session.
- ${mergeRule} Never run \`pr-cockpit merge\`, \`auto-merge\`, \`cockpit-auto-merge\`, \`close\`, \`ready-for-review\`, or \`review\`; never merge, close, or reopen the PR; never change its GitHub or Cockpit auto-merge state; never touch other PRs or issues.
- Resolve conflicts faithfully, preserving the intent of both sides. When you cannot, run \`git merge --abort\` and explain on the PR instead of picking a side or discarding work.
- Commit messages are plain and descriptive. No AI attribution, no Co-Authored-By lines, no emoji.
- At most one PR comment per distinct event. Never repeat a comment.`;
}

function hardRules(): string {
  return `${baseHardRules(`Only Cockpit merges: when the merge step's conditions hold you write "ready-to-merge", and Cockpit re-verifies a freshly refreshed snapshot server-side before merging.`)}
- Keep every fix minimal: make the check pass without rewriting unrelated code. If a failure requires a real design decision, comment on the PR describing the decision needed and write "gave-up" instead of guessing.
- Last action, always: overwrite the file ${FIXER_STATUS_FILE} in this directory with exactly one word - "continue" (nothing more to do until the PR changes; Cockpit relaunches you with a fresh brief when it does), "ready-to-merge" (the merge step's conditions hold - Cockpit merges), "merged" (the PR is already merged or closed), "waiting-review" (just posted the waiting-on-review comment), or "gave-up" (just posted the give-up comment).`;
}

// placeholders substituted at spawn time by renderIterationTemplate - a custom template is rendered the same way
const DEFAULT_FIXER_TEMPLATE = `WORK - handle every blocker you can act on, in this order, starting from the brief above instead of re-reading it. After each push or state change, re-read pr-cockpit {{REPO}}#{{PR_NUMBER}} and start again at step 1; if it still shows the old head, wait with pr-cockpit listen {{REPO}}#{{PR_NUMBER}} and re-read.
1. state MERGED or CLOSED: write "merged" to {{STATUS_FILE}} and stop.
2. Merge conflicts (merge state DIRTY): git fetch origin {{BASE_REF}} && git merge origin/{{BASE_REF}}, resolve, commit, push.
3. Else, branch behind base (merge state BEHIND): pr-cockpit update-branch {{REPO}}#{{PR_NUMBER}}; if that fails, git fetch origin {{BASE_REF}} && git merge origin/{{BASE_REF}}, then push.
4. Else, failing checks: read the cached failing job logs with pr-cockpit {{REPO}}#{{PR_NUMBER}} --logs, diagnose, fix with the smallest change that makes the check pass, verify locally with the narrowest relevant command (single test file, lint on the touched files), commit, push.
5. Else, unresolved review threads: check each thread's author. A thread from a configured BOT reviewer ({{BOT_REVIEWERS}}) - if the concern is valid, fix it (commit and push) and reply explaining the fix; if not, reply explaining why not; then resolve it with pr-cockpit resolve {{REPO}}#{{PR_NUMBER}} HANDLE. A thread from a HUMAN reviewer - never touch, resolve, or reply to it; if that's the only blocker, note it and continue.
6. Else, checks still queued or running (see pr-cockpit {{REPO}}#{{PR_NUMBER}} --jobs): wait with pr-cockpit listen {{REPO}}#{{PR_NUMBER}} --ci-only.{{FORCE_MERGE_STEP}}
8. Else, blocked only on human review: if that has held across three consecutive reads, comment that the PR is green and waiting on review, then write "waiting-review". Otherwise wait with pr-cockpit listen {{REPO}}#{{PR_NUMBER}} and return to step 1.
9. Give up: if the same check is still failing after 3 distinct fix attempts by you across this conversation, comment on the PR summarizing each attempt and why it still fails, then write "gave-up".
10. Report a single one-line summary of what you did.`;

export function defaultFixerTemplate(): string {
  return DEFAULT_FIXER_TEMPLATE.replaceAll("{{BOT_REVIEWERS}}", reviewBots().map((bot) => bot.login).join(", "));
}

// a custom fixer template that drops {{FORCE_MERGE_STEP}} still carries the merge step, last
function renderIterationTemplate(template: string, repo: string, number: number, baseRef: string, mergeStep: string): string {
  const withMergeStep = template.includes("{{FORCE_MERGE_STEP}}") ? template : `${template}${mergeStep}`;
  return withMergeStep
    .replaceAll("{{REPO}}", repo)
    .replaceAll("{{FORCE_MERGE_STEP}}", mergeStep)
    .replaceAll("{{BOT_REVIEWERS}}", reviewBots().map((bot) => bot.login).join(", "))
    .replaceAll("{{PR_NUMBER}}", String(number))
    .replaceAll("{{BASE_REF}}", baseRef)
    .replaceAll("{{STATUS_FILE}}", FIXER_STATUS_FILE);
}

function fixerPrompt(isFirst: boolean, repo: string, number: number, baseRef: string, headRef: string, brief: string, mergeStep: string, template: string): string {
  return `${isFirst
    ? `You are the auto-merge fixer agent for the pull request ${repo}#${number} (branch "${headRef}" into "${baseRef}"). Clear whatever blocks merging, signal Cockpit when the merge step's conditions hold, and get out of the way.`
    : "Same PR, relaunched because it changed or your last run ended. The brief below is current; start from it."}

${brief}

${renderIterationTemplate(template.trim() || DEFAULT_FIXER_TEMPLATE, repo, number, baseRef, mergeStep)}

${hardRules()}`;
}

function nextBlocker(summary: PrAgentSummary): string {
  if (summary.state === "MERGED" || summary.state === "CLOSED") return `the PR is ${summary.state}; nothing to do`;
  if (summary.merge === "DIRTY") return `resolve the merge conflicts with ${summary.base} first`;
  if (summary.merge === "BEHIND") return `bring the branch up to date with \`pr-cockpit update-branch ${summary.ref}\``;
  if (summary.ci.state === "FAILURE" || summary.ci.state === "CANCELLED") return "fix the failing checks, then the open review threads";
  if (summary.openComments.length > 0 || summary.review === "CHANGES_REQUESTED") return "address the open review feedback";
  if (summary.ci.running > 0) return `checks are still running; wait with \`pr-cockpit listen ${summary.ref} --ci-only\``;
  if (summary.ci.state === "PENDING") return `Actions coverage is incomplete in this snapshot; confirm with \`pr-cockpit ${summary.ref} --jobs\` before treating checks as green`;
  return "no blocker is known in this snapshot; only the merge gate remains";
}

// cache-only apart from a one-time refresh for snapshots cached before they carried the head repository;
// the freshness line keeps a stale clean state from reading as mergeable
async function cockpitBrief(repo: string, number: number, headRef: string, logPath: string): Promise<string> {
  const ref = `${repo}#${number}`;
  const newest = () => {
    const tracked = getPr(repo, number);
    const cached = getCachedPrDetail(repo, number);
    return { tracked, row: !tracked ? cached : cached && cached.fetched_at > tracked.fetched_at ? cached : tracked };
  };
  let { tracked, row } = newest();
  if (row && (JSON.parse(row.detail_json) as PrDetail).headRepository === undefined) {
    await refreshAgentPr(repo, number, logPath, "agent read");
    ({ tracked, row } = newest());
  }
  if (!row) return `COCKPIT BRIEF: Cockpit has no cached snapshot of ${ref}; read it with \`pr-cockpit ${ref}\` first.\n\n${cockpitCommands(repo, number, headRef, null)}`;
  // dynamic: http.ts imports this module statically
  const { buildPrAgentSummary, formatPrAgentSummary, snapshotStatus } = await import("./http.ts");
  const detail = JSON.parse(row.detail_json) as PrDetail;
  const snapshot = snapshotStatus(row.fetched_at, lastWebhookAtForPr(repo, number));
  const summary = buildPrAgentSummary(ref, { ...detail, agentSnapshot: snapshot }, null);
  const githubAutoMerge = detail.autoMergeRequest
    ? `enabled (${detail.autoMergeRequest.mergeMethod}${detail.autoMergeRequest.enabledBy ? ` by @${detail.autoMergeRequest.enabledBy.login}` : ""})`
    : "off";
  return `COCKPIT BRIEF - Cockpit's cached snapshot at this launch, in place of your startup reads. Re-read with \`pr-cockpit ${ref}\` after you change something or \`listen\` wakes${snapshot.freshness === "outdated" ? "; this snapshot is OUTDATED, so re-read it before acting on anything it shows as clear" : ""}.
Next: ${nextBlocker(summary)}.
Auto-merge (cached): Cockpit ${tracked?.auto_merge_enabled ? "armed" : "not armed"} · GitHub ${githubAutoMerge}. Leave both as they are.

${formatPrAgentSummary(summary, { body: false }).trim()}

${cockpitCommands(repo, number, detail.headRefName || headRef, detail.headRepository?.nameWithOwner ?? null)}`;
}

// GitHub's StatusCheckRollupState values, as computed by checkRollupStatus in poller.ts; NONE means no checks at all
const CI_GREEN_STATUSES = new Set(["SUCCESS", "NONE"]);

// the rollup state alone is not enough: force-merge can act while GitHub reports BLOCKED, and a
// required check that was skipped or cancelled leaves that requirement unmet without failing the rollup.
// BLOCKED only ever bypasses an approval rule, and a fresh push can briefly report no checks, so it needs SUCCESS.
export function readyToMerge(pr: PrRow): boolean {
  return pr.review_decision !== "CHANGES_REQUESTED" &&
    CI_GREEN_STATUSES.has(pr.ci_status) &&
    (pr.merge_state_status !== "BLOCKED" || pr.ci_status === "SUCCESS") &&
    pr.unresolved_count === 0 &&
    unsatisfiedRequiredChecks(pr.detail_json).length === 0;
}

// states the conditions instead of gating on launch-time cache state; the server-side gate re-verifies
export function mergeStepText(repo: string, allowMerge = true): string {
  if (!allowMerge) return "";
  if (forceMergeEnabled(repo)) {
    return `\n7. Else, merge check: if checks are green, there are no conflicts, the branch is not behind, there is no CHANGES_REQUESTED, every review thread is resolved or bot-only-and-addressed, and the only remaining blocker (if any) is a required-approval rule, write "ready-to-merge" to {{STATUS_FILE}} and stop; Cockpit re-verifies and merges it itself. Never signal it past failing checks, conflicts, an unresolved human thread, or CHANGES_REQUESTED.`;
  }
  return `\n7. Else, merge check: if the PR is fully green - merge state CLEAN, checks passing, no conflicts, review approved or not required, every thread resolved - write "ready-to-merge" to {{STATUS_FILE}} and stop; Cockpit re-verifies and merges it itself.`;
}

async function runIteration(repo: string, number: number, workdir: string, logPath: string, prompt: string, useContinue: boolean): Promise<string> {
  // clear any stale status (previous iteration, or a previous armed session in a reused workdir) before this one runs
  rmSync(`${workdir}/${FIXER_STATUS_FILE}`, { force: true });
  const logFd = openSync(logPath, "a");
  // strip inherited API keys so the agent authenticates via the harness's own login
  const { ANTHROPIC_API_KEY: _anthropicKey, OPENAI_API_KEY: _openaiKey, CODEX_API_KEY: _codexKey, ...env } = process.env;
  const args = harnessArgs(prompt, agentModel("fixer"), useContinue);
  const proc = Bun.spawn(args, { cwd: workdir, env, stdout: logFd, stderr: logFd, stdin: "ignore" });
  updatePidStmt.run({ $pid: proc.pid, $pid_started: psStart(proc.pid) ?? "", $repo: repo, $number: number });
  await proc.exited;
  closeSync(logFd);

  const statusFile = Bun.file(`${workdir}/${FIXER_STATUS_FILE}`);
  if (!(await statusFile.exists())) return "continue";
  const status = (await statusFile.text()).trim();
  return status === "continue" || status === "ready-to-merge" || TERMINAL_STATUSES.includes(status) ? status : "continue";
}

const activeSupervisors = new Map<string, { stopped: boolean }>();

function prFingerprint(pr: PrRow | null): string {
  return pr ? [pr.state, pr.head_sha, pr.merge_state_status, pr.ci_status, pr.review_decision, pr.unresolved_count, pr.updated_at].join("|") : "";
}

// the run's own push must land in the cache before the merge gate or the next brief reads it; a PR opened only
// by URL lives in the detail cache, and refreshing it through the poller would start tracking it
async function refreshAgentPr(repo: string, number: number, logPath: string, source: GithubUsageSource): Promise<boolean> {
  try {
    if (getPr(repo, number)) {
      // dynamic: a static poller import would close the agents -> poller -> activity -> agents cycle
      const { refreshPr } = await import("./poller.ts");
      await refreshPr(repo, number, source, "all", "detail");
    } else {
      await refreshCachedPrDetail(repo, number, source);
    }
    return true;
  } catch (err) {
    appendFileSync(logPath, `\ncockpit refresh (${source}) failed for ${repo}#${number}: ${err}\n`);
    return false;
  }
}

const IDLE_RELAUNCH_MS = 180_000;
const PR_CHANGE_POLL_MS = 5_000;

// relaunch once the cache differs from what the last run was briefed on; the cap covers missed events and crashes
async function awaitPrChange(repo: string, number: number, briefed: string, control: { stopped: boolean }): Promise<void> {
  const deadline = Date.now() + IDLE_RELAUNCH_MS;
  while (!control.stopped && Date.now() < deadline && prFingerprint(getPr(repo, number)) === briefed) {
    await Bun.sleep(PR_CHANGE_POLL_MS);
  }
}

async function superviseFixer(
  repo: string,
  number: number,
  workdir: string,
  logPath: string,
  baseRef: string,
  headRef: string,
  control: { stopped: boolean },
  resuming: boolean,
): Promise<void> {
  let isFirst = !resuming;
  let mergeFailures = 0;
  try {
    while (!control.stopped) {
      if (!agentEnabled("fixer")) {
        setAgentStateStmt.run("exited", repo, number);
        finishRun(repo, number, "exited", null);
        cleanupAgentWorkdir(workdir);
        return;
      }
      const pr = getPr(repo, number);
      if (!pr || pr.state === "MERGED" || pr.state === "CLOSED") {
        setAgentStateStmt.run("exited", repo, number);
        finishRun(repo, number, "exited", null);
        cleanupAgentWorkdir(workdir);
        return;
      }
      // re-read every launch - settings and cached PR signals are both live, not fixed at arm time
      const briefed = prFingerprint(pr);
      const prompt = fixerPrompt(isFirst, repo, number, baseRef, headRef, await cockpitBrief(repo, number, headRef, logPath), mergeStepText(repo), agentPromptTemplate("fixer"));
      const status = await runIteration(repo, number, workdir, logPath, prompt, !isFirst);
      isFirst = false;
      if (control.stopped) return;
      const refreshed = await refreshAgentPr(repo, number, logPath, "agent read");
      if (control.stopped) return;
      if (status === "ready-to-merge") {
        // the agent's word is a signal, not authority: gate on the post-run refresh and bind the merge to that head
        const fresh = refreshed ? getPr(repo, number) : null;
        const gateOk = fresh && readyToMerge(fresh) && mergeAllowedNow(repo, fresh);
        if (!gateOk) {
          appendFileSync(logPath, `\ncockpit refused merge signal for ${repo}#${number}: ${refreshed ? "PR does not pass the server-side merge gate" : "snapshot could not be refreshed"}\n`);
          await awaitPrChange(repo, number, briefed, control);
          continue;
        }
        try {
          await mergeWithLearning(repo, number, fresh.base_ref, fresh.head_sha);
        } catch (err) {
          mergeFailures += 1;
          appendFileSync(logPath, `\ncockpit merge failed for ${repo}#${number} (attempt ${mergeFailures}/3): ${err}\n`);
          if (mergeFailures >= 3) {
            setAgentExitedStmt.run("gave-up", repo, number);
            finishRun(repo, number, "exited", "gave-up");
            cleanupAgentWorkdir(workdir);
            return;
          }
          await awaitPrChange(repo, number, prFingerprint(fresh), control);
          continue;
        }
        setAgentExitedStmt.run("merged", repo, number);
        finishRun(repo, number, "exited", "merged");
        cleanupAgentWorkdir(workdir);
        await refreshAgentPr(repo, number, logPath, "mutation recovery");
        return;
      }
      if (status !== "continue") {
        setAgentExitedStmt.run(status, repo, number);
        finishRun(repo, number, "exited", status);
        cleanupAgentWorkdir(workdir);
        return;
      }
      await awaitPrChange(repo, number, briefed, control);
    }
  } finally {
    // only remove our own entry - a kill+re-arm during our wait may have already replaced it with a new supervisor
    const key = prKeyOf(repo, number);
    if (activeSupervisors.get(key) === control) activeSupervisors.delete(key);
  }
}

export async function launchFixerAgent(repo: string, number: number): Promise<void> {
  if (!agentEnabled("fixer")) return;
  const key = prKeyOf(repo, number);
  const existing = getAgentStmt.get(repo, number);
  if (activeSupervisors.get(key) || (existing?.state === "running" && agentProcessAlive(existing))) {
    throw new Error("an agent is already running for this PR - kill it first");
  }

  const pr = getPr(repo, number);
  if (!pr) throw new Error(`no cached PR for ${repo}#${number}`);
  const workdir = agentWorkdirFor(repo, number);
  mkdirSync(workdir, { recursive: true });
  const startedAt = new Date().toISOString();
  const logPath = runLogPathFor(workdir, startedAt);

  upsertAgentStmt.run({
    $repo: repo,
    $number: number,
    $pid: 0,
    $pid_started: "",
    $state: "running",
    $started_at: startedAt,
    $workdir: workdir,
    $log_path: logPath,
    $kind: "fixer",
    $agent_id: "",
  });
  startRun(repo, number, "fixer", "", workdir, logPath, "auto-merge fixer: get this PR green (conflicts, checks, threads) and merge it", startedAt);

  const control = { stopped: false };
  activeSupervisors.set(key, control);
  superviseFixer(repo, number, workdir, logPath, pr.base_ref, pr.head_ref, control, false).catch((err) => {
    console.error(`fixer supervisor crashed for ${key}:`, err);
    setAgentStateStmt.run("died", repo, number);
    finishRun(repo, number, "died", null);
    cleanupAgentWorkdir(workdir);
    if (activeSupervisors.get(key) === control) activeSupervisors.delete(key);
  });
}

function promptAgentPrompt(repo: string, number: number, baseRef: string, headRef: string, viewerLogin: string, instruction: string, brief: string): string {
  return `You are a one-shot agent working on the pull request ${repo}#${number} (branch "${headRef}" into "${baseRef}"), acting on a direct instruction from @${viewerLogin}. This is a SINGLE run - there is no next iteration.

${brief}

INSTRUCTION from @${viewerLogin}:
${instruction}

Carry out the instruction. If it changes code, commit with a plain descriptive message and push it as the rules below allow.

${baseHardRules("This run has no merge authority, whatever the instruction says.")}
- Do exactly what the instruction asks and nothing more - no unrelated cleanup or refactors. If it needs no code change, make no commit.
- Last action, always: overwrite the file ${PROMPT_STATUS_FILE} in this directory with exactly one word - "done" (you committed and pushed), "no-op" (nothing to change), or "gave-up" (you could not or should not do it; post a single PR comment explaining why first).`;
}

async function runPromptOnce(repo: string, number: number, workdir: string, logPath: string, prompt: string, model: string): Promise<string> {
  rmSync(`${workdir}/${PROMPT_STATUS_FILE}`, { force: true });
  const logFd = openSync(logPath, "a");
  // strip inherited API keys so the agent authenticates via the harness's own login
  const { ANTHROPIC_API_KEY: _anthropicKey, OPENAI_API_KEY: _openaiKey, CODEX_API_KEY: _codexKey, ...env } = process.env;
  const args = harnessArgs(prompt, model);
  const proc = Bun.spawn(args, { cwd: workdir, env, stdout: logFd, stderr: logFd, stdin: "ignore" });
  updatePidStmt.run({ $pid: proc.pid, $pid_started: psStart(proc.pid) ?? "", $repo: repo, $number: number });
  await proc.exited;
  closeSync(logFd);

  const statusFile = Bun.file(`${workdir}/${PROMPT_STATUS_FILE}`);
  const sentinel = (await statusFile.exists()) ? (await statusFile.text()).trim() : null;
  // only an explicit success sentinel on a clean exit is trusted; a crash or missing sentinel gives up so it never arms
  if (proc.exitCode === 0 && sentinel === "done") return "done";
  if (proc.exitCode === 0 && sentinel === "no-op") return "no-op";
  return "gave-up";
}

async function runPromptAgent(repo: string, number: number, workdir: string, logPath: string, baseRef: string, headRef: string, viewerLogin: string, instruction: string, model: string): Promise<void> {
  const prompt = promptAgentPrompt(repo, number, baseRef, headRef, viewerLogin, instruction, await cockpitBrief(repo, number, headRef, logPath));
  const status = await runPromptOnce(repo, number, workdir, logPath, prompt, model);
  // a kill during the run already set state=killed - respect it, no exit-state clobber, no handoff
  if (getAgentStmt.get(repo, number)?.state === "killed") return;
  setAgentExitedStmt.run(status, repo, number);
  finishRun(repo, number, "exited", status);
}

export async function launchPromptAgent(repo: string, number: number, instruction: string, model = "opus"): Promise<void> {
  const key = prKeyOf(repo, number);
  const existing = getAgentStmt.get(repo, number);
  if (activeSupervisors.get(key) || (existing?.state === "running" && agentProcessAlive(existing))) {
    throw new Error("an agent is already running for this PR - kill it first");
  }

  const refs = agentPrRefs(getPr(repo, number), getCachedPrDetail(repo, number)?.detail_json ?? null);
  if (!refs) throw new Error(`no cached PR for ${repo}#${number}`);
  const viewerLogin = await getViewerLogin();
  const workdir = agentWorkdirFor(repo, number);
  mkdirSync(workdir, { recursive: true });
  const startedAt = new Date().toISOString();
  const logPath = runLogPathFor(workdir, startedAt);

  upsertAgentStmt.run({
    $repo: repo,
    $number: number,
    $pid: 0,
    $pid_started: "",
    $state: "running",
    $started_at: startedAt,
    $workdir: workdir,
    $log_path: logPath,
    $kind: "prompt",
    $agent_id: "",
  });
  startRun(repo, number, "prompt", "", workdir, logPath, instruction, startedAt);

  runPromptAgent(repo, number, workdir, logPath, refs.baseRef, refs.headRef, viewerLogin, instruction, model).catch((err) => {
    console.error(`prompt agent crashed for ${key}:`, err);
    setAgentStateStmt.run("died", repo, number);
    finishRun(repo, number, "died", null);
  });
}

// unlike the merge-fixer, autofix addresses (and resolves) human threads too - it never merges, so there's no blast radius to guard against
const AUTOFIX_ITERATION_TEMPLATE = `WORK - handle every blocker you can act on, in this order, starting from the brief above instead of re-reading it. After each push or state change, re-read pr-cockpit {{REPO}}#{{PR_NUMBER}} and start again at step 1; if it still shows the old head, wait with pr-cockpit listen {{REPO}}#{{PR_NUMBER}} and re-read.
1. state MERGED or CLOSED: write "gave-up" to {{STATUS_FILE}} and stop.
2. Merge conflicts (merge state DIRTY): git fetch origin {{BASE_REF}} && git merge origin/{{BASE_REF}}, resolve, commit, push.
3. Else, branch behind base (merge state BEHIND): pr-cockpit update-branch {{REPO}}#{{PR_NUMBER}}; if that fails, git fetch origin {{BASE_REF}} && git merge origin/{{BASE_REF}}, then push.
4. Else, failing checks: read the cached failing job logs with pr-cockpit {{REPO}}#{{PR_NUMBER}} --logs, diagnose, fix with the smallest change that makes the check pass, verify locally with the narrowest relevant command (single test file, lint on the touched files), commit, push.
5. Else, unresolved review threads (from Greptile, other bots, AND human reviewers alike): for each, if the concern is valid, fix it (commit and push) and reply explaining the fix; if not, reply with a short explanation of why not; then resolve it with pr-cockpit resolve {{REPO}}#{{PR_NUMBER}} HANDLE.
6. Else, checks still queued or running (see pr-cockpit {{REPO}}#{{PR_NUMBER}} --jobs): wait with pr-cockpit listen {{REPO}}#{{PR_NUMBER}} --ci-only.
7. Else, fully green (checks passing, no conflicts, no unresolved threads): write "continue" to {{STATUS_FILE}} and stop; Cockpit confirms it and ends the run for a human to merge.
8. Else, blocked only on human review approval: if that has held across three consecutive reads, comment that the PR is green and waiting on review, then write "waiting-review" to {{STATUS_FILE}}. Otherwise wait with pr-cockpit listen {{REPO}}#{{PR_NUMBER}} and return to step 1.
9. Give up: if the same check or thread is still unresolved after 3 distinct fix attempts by you across this conversation, comment on the PR summarizing each attempt and why it still fails, then write "gave-up" to {{STATUS_FILE}}.
10. Report a single one-line summary of what you did.`;

export function defaultAutofixTemplate(): string {
  return AUTOFIX_ITERATION_TEMPLATE;
}

function autofixPrompt(isFirst: boolean, repo: string, number: number, baseRef: string, headRef: string, brief: string): string {
  const body = (agentPromptTemplate("autofix").trim() || AUTOFIX_ITERATION_TEMPLATE)
    .replaceAll("{{REPO}}", repo)
    .replaceAll("{{PR_NUMBER}}", String(number))
    .replaceAll("{{BASE_REF}}", baseRef)
    .replaceAll("{{STATUS_FILE}}", AUTOFIX_STATUS_FILE);
  return `${isFirst
    ? `You are the auto-fix agent for the pull request ${repo}#${number} (branch "${headRef}" into "${baseRef}"). Your one goal is to get it fully green - CI passing, no merge conflicts, zero unresolved review threads - then stop and let a human merge it.`
    : "Same PR, relaunched because it changed or your last run ended. The brief below is current; start from it."}

${brief}

${body}

${baseHardRules("Getting the PR green is the whole job - a human merges it; you have no merge authority.")}
- Keep every fix minimal: make the check or thread resolve without rewriting unrelated code.
- Last action, always: overwrite the file ${AUTOFIX_STATUS_FILE} in this directory with exactly one word - "continue" (nothing more to do until the PR changes; Cockpit relaunches you with a fresh brief when it does), "waiting-review" (just posted the waiting-on-review comment), or "gave-up" (just posted the give-up comment).`;
}

async function runAutofixIteration(repo: string, number: number, workdir: string, logPath: string, prompt: string, useContinue: boolean): Promise<string> {
  rmSync(`${workdir}/${AUTOFIX_STATUS_FILE}`, { force: true });
  const logFd = openSync(logPath, "a");
  // strip inherited API keys so the agent authenticates via the harness's own login
  const { ANTHROPIC_API_KEY: _anthropicKey, OPENAI_API_KEY: _openaiKey, CODEX_API_KEY: _codexKey, ...env } = process.env;
  const args = harnessArgs(prompt, agentModel("autofix"), useContinue);
  const proc = Bun.spawn(args, { cwd: workdir, env, stdout: logFd, stderr: logFd, stdin: "ignore" });
  updatePidStmt.run({ $pid: proc.pid, $pid_started: psStart(proc.pid) ?? "", $repo: repo, $number: number });
  await proc.exited;
  closeSync(logFd);

  const statusFile = Bun.file(`${workdir}/${AUTOFIX_STATUS_FILE}`);
  if (!(await statusFile.exists())) return "continue";
  const status = (await statusFile.text()).trim();
  return status === "gave-up" || status === "waiting-review" ? status : "continue";
}

export function isGreen(pr: PrRow): boolean {
  return readyToMerge(pr) && pr.merge_state_status === "CLEAN";
}

async function superviseAutofix(
  repo: string,
  number: number,
  workdir: string,
  logPath: string,
  baseRef: string,
  headRef: string,
  control: { stopped: boolean },
  resuming: boolean,
): Promise<void> {
  let isFirst = !resuming;
  try {
    while (!control.stopped) {
      if (!agentEnabled("autofix")) {
        setAgentStateStmt.run("exited", repo, number);
        finishRun(repo, number, "exited", null);
        cleanupAgentWorkdir(workdir);
        return;
      }
      const pr = getPr(repo, number);
      if (!pr || pr.state === "MERGED" || pr.state === "CLOSED") {
        setAgentStateStmt.run("exited", repo, number);
        finishRun(repo, number, "exited", null);
        cleanupAgentWorkdir(workdir);
        return;
      }
      if (isGreen(pr)) {
        setAgentExitedStmt.run("green", repo, number);
        finishRun(repo, number, "exited", "green");
        cleanupAgentWorkdir(workdir);
        return;
      }
      const briefed = prFingerprint(pr);
      const prompt = autofixPrompt(isFirst, repo, number, baseRef, headRef, await cockpitBrief(repo, number, headRef, logPath));
      const status = await runAutofixIteration(repo, number, workdir, logPath, prompt, !isFirst);
      isFirst = false;
      if (control.stopped) return;
      if (status === "gave-up" || status === "waiting-review") {
        setAgentExitedStmt.run(status, repo, number);
        finishRun(repo, number, "exited", status);
        cleanupAgentWorkdir(workdir);
        return;
      }
      await refreshAgentPr(repo, number, logPath, "agent read");
      await awaitPrChange(repo, number, briefed, control);
    }
  } finally {
    const key = prKeyOf(repo, number);
    if (activeSupervisors.get(key) === control) activeSupervisors.delete(key);
  }
}

export async function launchAutofixAgent(repo: string, number: number): Promise<void> {
  if (!agentEnabled("autofix")) return;
  const key = prKeyOf(repo, number);
  const existing = getAgentStmt.get(repo, number);
  if (activeSupervisors.get(key) || (existing?.state === "running" && agentProcessAlive(existing))) {
    throw new Error("an agent is already running for this PR - kill it first");
  }

  const pr = getPr(repo, number);
  if (!pr) throw new Error(`no cached PR for ${repo}#${number}`);
  const workdir = agentWorkdirFor(repo, number);
  mkdirSync(workdir, { recursive: true });
  const startedAt = new Date().toISOString();
  const logPath = runLogPathFor(workdir, startedAt);

  upsertAgentStmt.run({
    $repo: repo,
    $number: number,
    $pid: 0,
    $pid_started: "",
    $state: "running",
    $started_at: startedAt,
    $workdir: workdir,
    $log_path: logPath,
    $kind: "autofix",
    $agent_id: "",
  });
  startRun(repo, number, "autofix", "", workdir, logPath, "auto-fix: get this PR green (CI, conflicts, threads), never merge", startedAt);

  const control = { stopped: false };
  activeSupervisors.set(key, control);
  superviseAutofix(repo, number, workdir, logPath, pr.base_ref, pr.head_ref, control, false).catch((err) => {
    console.error(`autofix supervisor crashed for ${key}:`, err);
    setAgentStateStmt.run("died", repo, number);
    finishRun(repo, number, "died", null);
    cleanupAgentWorkdir(workdir);
    if (activeSupervisors.get(key) === control) activeSupervisors.delete(key);
  });
}

const CUSTOM_STATUS_FILE = ".custom-status";

function customPrompt(agent: AgentSetting, isFirst: boolean, repo: string, number: number, baseRef: string, headRef: string, viewerLogin: string, brief: string): string {
  const instruction = agent.prompt_template
    .replaceAll("{{REPO}}", repo)
    .replaceAll("{{PR_NUMBER}}", String(number))
    .replaceAll("{{BASE_REF}}", baseRef)
    .replaceAll("{{STATUS_FILE}}", CUSTOM_STATUS_FILE);
  return `${isFirst
    ? `You are the "${agent.name}" agent for the pull request ${repo}#${number} (branch "${headRef}" into "${baseRef}"), armed by @${viewerLogin}. Your instruction is below.`
    : "Same PR, relaunched because it changed or your last run ended. The brief below is current; start from it."}

${brief}

INSTRUCTION:
${instruction}

${baseHardRules("Custom agents have no merge authority, whatever the instruction says.")}
- Keep every change minimal: do what the instruction asks without rewriting unrelated code.
- Last action, always: overwrite the file ${CUSTOM_STATUS_FILE} in this directory with exactly one word - "continue" (nothing more to do until the PR changes; Cockpit relaunches you with a fresh brief when it does), "done" (the instruction is fully satisfied), or "gave-up" (you cannot or should not proceed; post a single PR comment explaining why first).`;
}

async function runCustomIteration(repo: string, number: number, agentId: string, workdir: string, logPath: string, prompt: string, useContinue: boolean): Promise<string> {
  rmSync(`${workdir}/${CUSTOM_STATUS_FILE}`, { force: true });
  const logFd = openSync(logPath, "a");
  // strip inherited API keys so the agent authenticates via the harness's own login
  const { ANTHROPIC_API_KEY: _anthropicKey, OPENAI_API_KEY: _openaiKey, CODEX_API_KEY: _codexKey, ...env } = process.env;
  const args = harnessArgs(prompt, agentModel(agentId), useContinue);
  const proc = Bun.spawn(args, { cwd: workdir, env, stdout: logFd, stderr: logFd, stdin: "ignore" });
  updatePidStmt.run({ $pid: proc.pid, $pid_started: psStart(proc.pid) ?? "", $repo: repo, $number: number });
  await proc.exited;
  closeSync(logFd);

  const statusFile = Bun.file(`${workdir}/${CUSTOM_STATUS_FILE}`);
  if (!(await statusFile.exists())) return "continue";
  const status = (await statusFile.text()).trim();
  return status === "done" || status === "gave-up" ? status : "continue";
}

function customAgentDef(agentId: string): AgentSetting | null {
  if (!agentId.startsWith(CUSTOM_AGENT_ID_PREFIX)) return null;
  const def = agentSettings().find((a) => a.id === agentId);
  return def && def.enabled && def.prompt_template.trim() ? def : null;
}

async function superviseCustom(
  repo: string,
  number: number,
  agentId: string,
  workdir: string,
  logPath: string,
  baseRef: string,
  headRef: string,
  viewerLogin: string,
  control: { stopped: boolean },
  resuming: boolean,
): Promise<void> {
  let isFirst = !resuming;
  try {
    while (!control.stopped) {
      // re-read every tick - a disabled, deleted, or prompt-emptied definition stops the loop
      const def = customAgentDef(agentId);
      const pr = getPr(repo, number);
      if (!def || !pr || pr.state === "MERGED" || pr.state === "CLOSED") {
        setAgentStateStmt.run("exited", repo, number);
        finishRun(repo, number, "exited", null);
        cleanupAgentWorkdir(workdir);
        return;
      }
      const briefed = prFingerprint(pr);
      const prompt = customPrompt(def, isFirst, repo, number, baseRef, headRef, viewerLogin, await cockpitBrief(repo, number, headRef, logPath));
      const status = await runCustomIteration(repo, number, agentId, workdir, logPath, prompt, !isFirst);
      isFirst = false;
      if (control.stopped) return;
      if (status !== "continue") {
        setAgentExitedStmt.run(status, repo, number);
        finishRun(repo, number, "exited", status);
        cleanupAgentWorkdir(workdir);
        return;
      }
      await refreshAgentPr(repo, number, logPath, "agent read");
      await awaitPrChange(repo, number, briefed, control);
    }
  } finally {
    const key = prKeyOf(repo, number);
    if (activeSupervisors.get(key) === control) activeSupervisors.delete(key);
  }
}

export async function launchCustomAgent(repo: string, number: number, agentId: string): Promise<void> {
  const def = customAgentDef(agentId);
  if (!def) throw new Error("unknown, disabled, or prompt-less custom agent");
  const key = prKeyOf(repo, number);
  const existing = getAgentStmt.get(repo, number);
  if (activeSupervisors.get(key) || (existing?.state === "running" && agentProcessAlive(existing))) {
    throw new Error("an agent is already running for this PR - kill it first");
  }

  const pr = getPr(repo, number);
  if (!pr) throw new Error(`no cached PR for ${repo}#${number}`);
  const viewerLogin = await getViewerLogin();
  const workdir = agentWorkdirFor(repo, number);
  mkdirSync(workdir, { recursive: true });
  const startedAt = new Date().toISOString();
  const logPath = runLogPathFor(workdir, startedAt);

  upsertAgentStmt.run({
    $repo: repo,
    $number: number,
    $pid: 0,
    $pid_started: "",
    $state: "running",
    $started_at: startedAt,
    $workdir: workdir,
    $log_path: logPath,
    $kind: "custom",
    $agent_id: agentId,
  });
  startRun(repo, number, "custom", def.id, workdir, logPath, `${def.name}: ${def.prompt_template.trim().split("\n")[0]}`, startedAt);

  const control = { stopped: false };
  activeSupervisors.set(key, control);
  superviseCustom(repo, number, agentId, workdir, logPath, pr.base_ref, pr.head_ref, viewerLogin, control, false).catch((err) => {
    console.error(`custom agent supervisor crashed for ${key}:`, err);
    setAgentStateStmt.run("died", repo, number);
    finishRun(repo, number, "died", null);
    cleanupAgentWorkdir(workdir);
    if (activeSupervisors.get(key) === control) activeSupervisors.delete(key);
  });
}

// server restarts wipe every in-memory supervisor - resume anything still "running" rather than orphaning it
export function startFixerSupervision(): void {
  for (const row of listAgentsStmt.all()) {
    if (row.state !== "running") continue;
    const pr = getPr(row.repo, row.number);
    if (pr?.state === "MERGED" || pr?.state === "CLOSED") {
      setAgentStateStmt.run("exited", row.repo, row.number);
      finishRun(row.repo, row.number, "exited", null);
      cleanupAgentWorkdir(row.workdir);
      continue;
    }
    // a one-shot prompt run has no loop to resume, and must never fall through to the merging fixer
    if (!pr || row.kind === "prompt" || !existsSync(row.workdir)) {
      setAgentStateStmt.run("died", row.repo, row.number);
      finishRun(row.repo, row.number, "died", null);
      continue;
    }
    const key = prKeyOf(row.repo, row.number);
    const control = { stopped: false };
    activeSupervisors.set(key, control);
    const resumed = row.kind === "custom"
      ? superviseCustom(row.repo, row.number, row.agent_id, row.workdir, row.log_path, pr.base_ref, pr.head_ref, "", control, true)
      : row.kind === "autofix"
        ? superviseAutofix(row.repo, row.number, row.workdir, row.log_path, pr.base_ref, pr.head_ref, control, true)
        : superviseFixer(row.repo, row.number, row.workdir, row.log_path, pr.base_ref, pr.head_ref, control, true);
    resumed.catch((err) => {
      console.error(`agent resume crashed for ${key}:`, err);
      setAgentStateStmt.run("died", row.repo, row.number);
      finishRun(row.repo, row.number, "died", null);
      if (activeSupervisors.get(key) === control) activeSupervisors.delete(key);
    });
  }
  sweepOrphanedAgentWorkdirs();
}

function sweepOrphanedAgentWorkdirs(): void {
  if (!existsSync(agentsDir)) return;
  const runningWorkdirs = new Set(
    listAgentsStmt.all().filter((row) => row.state === "running").map((row) => agentWorkdirFor(row.repo, row.number)),
  );
  for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = `${agentsDir}/${entry.name}`;
    if (!runningWorkdirs.has(path)) cleanupAgentWorkdir(path);
  }
}

export function killFixerAgent(repo: string, number: number): void {
  const key = prKeyOf(repo, number);
  const control = activeSupervisors.get(key);
  if (control) control.stopped = true;
  activeSupervisors.delete(key);

  const agent = getAgentStmt.get(repo, number);
  if (agent && agentProcessAlive(agent)) {
    try {
      process.kill(agent.pid, "SIGTERM");
    } catch {}
  }
  setAgentStateStmt.run("killed", repo, number);
  finishRun(repo, number, "killed", null);
}

export function getFixerAgent(repo: string, number: number): AgentRow | null {
  return getAgentStmt.get(repo, number) ?? null;
}

export function listFixerAgents(): AgentRow[] {
  const rows = listAgentsStmt.all();
  for (const row of rows) {
    // corrects a "died" row whose PR turned out to actually be resolved after classification
    if (row.state === "died") {
      const pr = getPr(row.repo, row.number);
      if (pr?.state === "MERGED" || pr?.state === "CLOSED") {
        setAgentStateStmt.run("exited", row.repo, row.number);
        correctDiedRunStmt.run({ $repo: row.repo, $number: row.number });
        row.state = "exited";
      }
    }
  }
  return rows;
}

export function removeFixerAgent(repo: string, number: number): void {
  const key = prKeyOf(repo, number);
  const control = activeSupervisors.get(key);
  if (control) control.stopped = true;
  activeSupervisors.delete(key);

  const agent = getAgentStmt.get(repo, number);
  if (!agent) return;
  if (agent.state === "running") finishRun(repo, number, "killed", null);
  if (agentProcessAlive(agent)) {
    try {
      process.kill(agent.pid, "SIGTERM");
    } catch {}
  }
  rmSync(agent.workdir, { recursive: true, force: true });
  rmSync(agent.log_path, { force: true });
  deleteAgentStmt.run(agent.repo, agent.number);
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function summarizeToolUse(name: string, input: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  if (name.toLowerCase() === "bash" && typeof inp.command === "string") return `${name}(${truncate(inp.command, 80)})`;
  // claude tools carry "description", omp tools carry the intent as "i"
  const intent = typeof inp.description === "string" ? inp.description : typeof inp.i === "string" ? inp.i : null;
  return intent ? `${name}(${truncate(intent, 80)})` : name;
}

export interface AgentTurn {
  ts: string;
  kind: "text" | "tool" | "result";
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  isError?: boolean;
}

const TURN_EVENT_TYPES: Record<string, true> = {
  assistant: true,
  message_end: true,
  result: true,
  agent_end: true,
  "item.started": true,
  "item.completed": true,
  "turn.failed": true,
  error: true,
};
const CODEX_TOOL_ITEM_TYPES: Record<string, true> = {
  command_execution: true,
  file_change: true,
  mcp_tool_call: true,
  web_search: true,
  plan_update: true,
};

// OMP emits thousands of streaming-delta events per run, so match the leading type before parsing the line
const EVENT_TYPE_PREFIX = /^\{"type":"([a-z_.]+)"/;

// Every harness streams one JSON event per line; only assistant output, tool starts, and final results carry signal.
// Claude emits "assistant"/"result" with an ISO top-level timestamp, OMP emits "message_end"/"agent_end"
// with an epoch-ms timestamp on the message, and Codex emits undated item/turn events.
function eventTurns(line: string, lastTs: { value: string }): AgentTurn[] | null {
  if (!line.startsWith("{")) return null;
  const typed = EVENT_TYPE_PREFIX.exec(line)?.[1];
  if (typed && !TURN_EVENT_TYPES[typed]) return [];
  let event: {
    type?: string;
    timestamp?: string;
    message?: unknown;
    messages?: unknown;
    item?: Record<string, unknown>;
    error?: { message?: unknown };
    is_error?: boolean;
    result?: unknown;
  };
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  const message = event.message && typeof event.message === "object"
    ? event.message as { role?: string; content?: unknown; timestamp?: number }
    : undefined;
  if (typeof event.timestamp === "string") lastTs.value = event.timestamp;
  if (typeof message?.timestamp === "number") lastTs.value = new Date(message.timestamp).toISOString();
  const ts = lastTs.value;
  if (event.type === "assistant" || (event.type === "message_end" && message?.role === "assistant")) {
    const turns: AgentTurn[] = [];
    for (const block of (Array.isArray(message?.content) ? message.content : []) as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") turns.push({ ts, kind: "text", text: block.text });
      else if (block.type === "tool_use") turns.push({ ts, kind: "tool", toolName: block.name as string, toolInput: block.input });
      else if (block.type === "toolCall") turns.push({ ts, kind: "tool", toolName: block.name as string, toolInput: block.arguments });
    }
    return turns;
  }
  if (event.type === "item.started" && typeof event.item?.type === "string" && CODEX_TOOL_ITEM_TYPES[event.item.type]) {
    return [{ ts, kind: "tool", toolName: event.item.type, toolInput: event.item }];
  }
  if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
    return [{ ts, kind: "text", text: event.item.text }];
  }
  if (event.type === "error") {
    return [{ ts, kind: "result", text: typeof event.message === "string" ? event.message : "Codex error", isError: true }];
  }
  if (event.type === "turn.failed") {
    return [{ ts, kind: "result", text: String(event.error?.message ?? "Codex turn failed"), isError: true }];
  }
  if (event.type === "result") return [{ ts, kind: "result", text: String(event.result ?? ""), isError: !!event.is_error }];
  if (event.type === "agent_end") {
    const messages = (Array.isArray(event.messages) ? event.messages : []) as Array<{ role?: string; content?: unknown }>;
    const final = messages.filter((m) => m.role === "assistant").at(-1);
    const blocks = (Array.isArray(final?.content) ? final.content : []) as Array<Record<string, unknown>>;
    const text = blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("");
    return [{ ts, kind: "result", text, isError: false }];
  }
  return [];
}

function renderTurn(turn: AgentTurn): string {
  const ts = turn.ts.slice(11, 19) || "??:??:??";
  if (turn.kind === "tool") return `[${ts}] → ${summarizeToolUse(turn.toolName ?? "", turn.toolInput)}`;
  if (turn.kind === "result") return `[${ts}] ${turn.isError ? "ERROR" : "done"}: ${truncate(turn.text ?? "", 300)}`;
  return `[${ts}] ${truncate(turn.text ?? "", 300)}`;
}

const MAX_LOG_TAIL_BYTES = 200_000;
// omp replays the whole transcript in a single agent_end line (hundreds of KB), so a small byte tail can hold
// zero parseable events - read a window big enough that the last real turns survive, then cap by turn count
const MAX_RUN_LOG_BYTES = 8_000_000;
const MAX_RUN_TURNS = 800;

// a byte-offset tail can start mid-line; that fragment is not a JSON event, so drop it
async function tailLines(path: string, bytes: number): Promise<string[] | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const start = Math.max(0, file.size - bytes);
  const text = await (start > 0 ? file.slice(start) : file).text();
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return start > 0 ? lines.slice(1) : lines;
}

export async function agentLogTail(repo: string, number: number, lines = 200): Promise<string | null> {
  const agent = getAgentStmt.get(repo, number);
  if (!agent) return null;
  const logLines = await tailLines(agent.log_path, MAX_RUN_LOG_BYTES);
  if (!logLines) return "";
  const lastTs = { value: "" };
  const rendered = logLines.flatMap((l) => {
    const turns = eventTurns(l, lastTs);
    return turns === null ? [l] : turns.map(renderTurn);
  });
  return rendered.slice(-lines).join("\n");
}

// structured event stream for the AGENTS tab's turn-by-turn detail view
export function turnsFromLines(lines: string[]): AgentTurn[] {
  const lastTs = { value: "" };
  return lines.flatMap((l) => eventTurns(l, lastTs) ?? []);
}

export function getAgentRun(id: number): AgentRunRow | null {
  return getRunStmt.get(id) ?? null;
}

// runs launched before per-run log files all append to one log per PR, so drop turns from a run's neighbours
export function runWindowTurns(turns: AgentTurn[], run: { started_at: string; ended_at: string | null }): AgentTurn[] {
  const startMs = Date.parse(run.started_at);
  const endMs = run.ended_at ? Date.parse(run.ended_at) : Number.POSITIVE_INFINITY;
  if (Number.isNaN(startMs)) return turns;
  return turns.filter((turn) => {
    const ms = Date.parse(turn.ts);
    return Number.isNaN(ms) || (ms >= startMs && ms <= endMs);
  });
}

export async function agentRunDetail(id: number): Promise<{ run: AgentRunRow; turns: AgentTurn[]; rawLog: string } | null> {
  const run = getAgentRun(id);
  if (!run) return null;
  const logLines = await tailLines(run.log_path, MAX_RUN_LOG_BYTES);
  if (!logLines) return { run, turns: [], rawLog: "" };
  const turns = runWindowTurns(turnsFromLines(logLines), run).slice(-MAX_RUN_TURNS);
  const rawTail = await tailLines(run.log_path, MAX_LOG_TAIL_BYTES);
  return { run, turns, rawLog: (rawTail ?? []).join("\n") };
}
