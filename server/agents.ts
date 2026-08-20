import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync } from "node:fs";
import { db, getCachedPrDetail, getPr, type PrRow } from "./db.ts";
import { unsatisfiedRequiredChecks } from "./checkState.ts";
import { getViewerLogin } from "./github.ts";
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

function hardRules(headRef: string): string {
  return `HARD RULES - these override everything above:
- Never touch local files, repos, or processes outside this directory (gh/git talking to github.com about THIS PR is of course fine).
- Push ONLY to origin ${headRef}. Never any other branch, tag, or repo. Never force-push. Never rebase. Never amend commits you did not create this session.
- Never run gh pr merge or merge the PR yourself - when the merge step's conditions hold you write "ready-to-merge" and Cockpit performs the merge server-side; never enable GitHub's own auto-merge feature (this PR intentionally doesn't use it); never close or reopen the PR, never touch other PRs or issues.
- Keep every fix minimal: make the check pass without rewriting unrelated code. If a failure requires a real design decision, comment on the PR describing the decision needed and write "gave-up" to ${FIXER_STATUS_FILE} instead of guessing.
- Commit messages are plain and descriptive. No AI attribution, no Co-Authored-By lines, no emoji.
- At most one PR comment per distinct event (announce, give-up, waiting-on-review). Never repeat a comment.
- Last action, always: overwrite the file ${FIXER_STATUS_FILE} in this directory with exactly one word - "continue" (more to check next time), "ready-to-merge" (everything is green per the merge step - Cockpit merges), "merged" (the PR is already merged or closed), "waiting-review" (just posted the waiting-on-review comment), or "gave-up" (just posted the give-up comment).`;
}

// placeholders substituted at spawn time by renderIterationTemplate - a custom template is rendered the same way
const DEFAULT_FIXER_TEMPLATE = `THIS ITERATION - do at most one thing, then stop:
1. Check state: gh pr view {{PR_NUMBER}} --json state,mergeStateStatus,statusCheckRollup,reviewDecision,reviewThreads
2. state MERGED or CLOSED: write "merged" to {{STATUS_FILE}} and stop.
3. Merge conflicts (mergeStateStatus DIRTY): git fetch origin && git merge origin/{{BASE_REF}}. Resolve conflicts faithfully - preserve the intent of BOTH sides; when genuinely unsure, keep the base branch's version and say so in the merge commit body. Commit and push.
4. Else, branch behind base (mergeStateStatus BEHIND): gh pr update-branch {{PR_NUMBER}}; if that fails (e.g. permission), fall back to git fetch origin && git merge origin/{{BASE_REF}} && git push. This re-triggers CI - just do it and stop for this iteration.
5. Else, failing checks: pull the failing job logs (gh run view --log-failed, or the check's detailsUrl), diagnose, fix in this clone with the smallest change that makes the check pass, verify locally with the narrowest relevant command (single test file, lint on the touched files), commit with a plain descriptive message, push.
6. Else, unresolved review threads: for each unresolved thread, check its author. A thread from a configured BOT reviewer ({{BOT_REVIEWERS}}) - if the concern is valid, fix it (commit and push) and reply explaining the fix, then resolve the thread; if not valid, reply explaining why not, then resolve it. A thread from a HUMAN reviewer - never touch it, never resolve it, never reply to it; if that's the only blocker, just note it and continue.{{FORCE_MERGE_STEP}}
8. Else, nothing actionable (checks running, or blocked only on human review): if this is the third consecutive iteration you've seen "blocked only on review, everything else green" (check your own memory of this conversation), comment that the PR is green and waiting on review, then write "waiting-review". Otherwise just note that and continue.
9. Give up: if the same check is still failing after 3 distinct fix attempts by you across this conversation, comment on the PR summarizing each attempt and why it still fails, then write "gave-up".
10. Report a single one-line summary of what you did this iteration.`;

export function defaultFixerTemplate(): string {
  return DEFAULT_FIXER_TEMPLATE.replaceAll("{{BOT_REVIEWERS}}", reviewBots().map((bot) => bot.login).join(", "));
}

function renderIterationTemplate(template: string, number: number, baseRef: string, mergeStep: string): string {
  return template
    .replaceAll("{{FORCE_MERGE_STEP}}", mergeStep)
    .replaceAll("{{BOT_REVIEWERS}}", reviewBots().map((bot) => bot.login).join(", "))
    .replaceAll("{{PR_NUMBER}}", String(number))
    .replaceAll("{{BASE_REF}}", baseRef)
    .replaceAll("{{STATUS_FILE}}", FIXER_STATUS_FILE);
}

function iterationBody(number: number, baseRef: string, mergeStep: string, template: string): string {
  return renderIterationTemplate(template.trim() || DEFAULT_FIXER_TEMPLATE, number, baseRef, mergeStep);
}

function firstIterationPrompt(repo: string, number: number, baseRef: string, headRef: string, viewerLogin: string, mergeStep: string, template: string): string {
  return `You are the auto-merge fixer agent for the pull request ${repo}#${number} (branch "${headRef}" into "${baseRef}").
This PR does not use GitHub's own auto-merge - you own getting it merged yourself, via the merge step below, once everything is green. Your one goal is to clear whatever blocks that, then merge it and get out of the way. You will be invoked again roughly every 3 minutes to check again - each invocation is ONE iteration, not a loop you run yourself.

SETUP (do this first):
1. This directory is your workspace. If it is empty, run: gh repo clone ${repo} . -- --depth 50
   then: gh pr checkout ${number}
2. Announce yourself, but first check you haven't already: if any existing comment on the PR contains "// cockpit auto-merger", skip this step entirely (a previous agent session announced). Otherwise:
   gh pr comment ${number} --body "Approved and armed for auto-merge by @${viewerLogin}. I'll merge this when everything is green - conflicts and failing checks - until then. // cockpit auto-merger"

${iterationBody(number, baseRef, mergeStep, template)}

${hardRules(headRef)}`;
}

function nextIterationPrompt(number: number, baseRef: string, headRef: string, mergeStep: string, template: string): string {
  return `Same PR, next check-in (roughly 3 minutes since your last iteration). Setup and the announce comment are already done - do not repeat them.

${iterationBody(number, baseRef, mergeStep, template)}

${hardRules(headRef)}`;
}

// matches GitHub's StatusCheckRollupState values, as computed by checkRollupStatus in poller.ts
const CI_FAILING_STATUSES = new Set(["FAILURE", "ERROR"]);

// the rollup state alone is not enough: force-merge can act while GitHub reports BLOCKED, and a
// required check that was skipped or cancelled leaves that requirement unmet without failing the rollup
function readyToMerge(pr: PrRow): boolean {
  return pr.review_decision !== "CHANGES_REQUESTED" &&
    !CI_FAILING_STATUSES.has(pr.ci_status) &&
    pr.unresolved_count === 0 &&
    unsatisfiedRequiredChecks(pr.detail_json).length === 0;
}

// mutually exclusive by construction - CLEAN and BLOCKED can't both hold - so at most one step is ever active
export function mergeStepText(repo: string, pr: PrRow, allowMerge = true): string {
  if (!allowMerge) return "";
  if (readyToMerge(pr) && pr.merge_state_status === "CLEAN") {
    return `\n7. Merge check: if the PR is fully green - checks passing, no conflicts, review approved or not required, every thread resolved - write "ready-to-merge" to {{STATUS_FILE}} and stop; Cockpit performs the merge itself.`;
  }
  if (readyToMerge(pr) && forceMergeEnabled(repo) && pr.merge_state_status === "BLOCKED") {
    return `\n7. Force-merge check: if the ONLY thing blocking merge is a required-approval rule - checks green, no conflicts, no CHANGES_REQUESTED, every review thread resolved or bot-only-and-addressed - write "ready-to-merge" to {{STATUS_FILE}} and stop; Cockpit performs the merge itself. Never signal it past failing checks, conflicts, an unresolved human thread, or CHANGES_REQUESTED, only ever a pure "needs approval" rule when everything else is actually green.`;
  }
  return "";
}

async function runIteration(repo: string, number: number, workdir: string, logPath: string, prompt: string, useContinue: boolean): Promise<string> {
  // clear any stale status (previous iteration, or a previous armed session in a reused workdir) before this one runs
  rmSync(`${workdir}/${FIXER_STATUS_FILE}`, { force: true });
  const logFd = openSync(logPath, "a");
  // strip inherited API keys so the agent authenticates via the harness's own login
  const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
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

const ITERATION_INTERVAL_MS = 180_000;
const activeSupervisors = new Map<string, { stopped: boolean }>();

async function superviseFixer(
  repo: string,
  number: number,
  workdir: string,
  logPath: string,
  baseRef: string,
  headRef: string,
  viewerLogin: string,
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
      // re-read every tick - settings and cached PR signals are both live, not fixed at arm time
      const mergeStep = mergeStepText(repo, pr);
      const template = agentPromptTemplate("fixer");
      const prompt = isFirst
        ? firstIterationPrompt(repo, number, baseRef, headRef, viewerLogin, mergeStep, template)
        : nextIterationPrompt(number, baseRef, headRef, mergeStep, template);
      const status = await runIteration(repo, number, workdir, logPath, prompt, !isFirst);
      isFirst = false;
      if (control.stopped) return;
      if (status === "ready-to-merge") {
        // the agent's word is a signal, not authority: re-read the row and re-check the
        // same server-side predicates that gated the prompt, on post-iteration state -
        // this also binds the merge to the freshest verified head so a race push 409s
        const fresh = getPr(repo, number);
        const gateOk = fresh && readyToMerge(fresh) && mergeAllowedNow(repo, fresh);
        if (!gateOk) {
          appendFileSync(logPath, `\ncockpit refused merge signal for ${repo}#${number}: PR no longer passes the server-side merge gate\n`);
          await Bun.sleep(ITERATION_INTERVAL_MS);
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
          await Bun.sleep(ITERATION_INTERVAL_MS);
          continue;
        }
        setAgentExitedStmt.run("merged", repo, number);
        finishRun(repo, number, "exited", "merged");
        cleanupAgentWorkdir(workdir);
        try {
          // dynamic: a static poller import would close the agents -> poller -> activity -> agents cycle
          const { refreshPr } = await import("./poller.ts");
          await refreshPr(repo, number);
        } catch (err) {
          appendFileSync(logPath, `\npost-merge refresh failed for ${repo}#${number}: ${err}\n`);
        }
        return;
      }
      if (status !== "continue") {
        setAgentExitedStmt.run(status, repo, number);
        finishRun(repo, number, "exited", status);
        cleanupAgentWorkdir(workdir);
        return;
      }
      await Bun.sleep(ITERATION_INTERVAL_MS);
    }
  } finally {
    // only remove our own entry - a kill+re-arm during our sleep may have already replaced it with a new supervisor
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
    $kind: "fixer",
    $agent_id: "",
  });
  startRun(repo, number, "fixer", "", workdir, logPath, "auto-merge fixer: get this PR green (conflicts, checks, threads) and merge it", startedAt);

  const control = { stopped: false };
  activeSupervisors.set(key, control);
  superviseFixer(repo, number, workdir, logPath, pr.base_ref, pr.head_ref, viewerLogin, control, false).catch((err) => {
    console.error(`fixer supervisor crashed for ${key}:`, err);
    setAgentStateStmt.run("died", repo, number);
    finishRun(repo, number, "died", null);
    cleanupAgentWorkdir(workdir);
    if (activeSupervisors.get(key) === control) activeSupervisors.delete(key);
  });
}

function promptHardRules(headRef: string): string {
  return `HARD RULES - these override the instruction:
- Never touch local files, repos, or processes outside this directory (gh/git talking to github.com about THIS PR is fine).
- Push ONLY to origin ${headRef}. Never any other branch, tag, or repo. Never force-push, never rebase, never amend commits you did not create this session.
- Never merge, close, or reopen the PR, and never enable GitHub's own auto-merge feature. Never touch other PRs or issues.
- Do exactly what the instruction asks and nothing more - no unrelated cleanup or refactors. If it needs no code change, make no commit.
- Commit messages are plain and descriptive. No AI attribution, no Co-Authored-By lines, no emoji.
- Last action, always: overwrite the file ${PROMPT_STATUS_FILE} in this directory with exactly one word - "done" (you committed and pushed), "no-op" (nothing to change), or "gave-up" (you could not or should not do it; post a single PR comment explaining why first).`;
}

function promptAgentPrompt(repo: string, number: number, baseRef: string, headRef: string, viewerLogin: string, instruction: string): string {
  return `You are a one-shot agent working on the pull request ${repo}#${number} (branch "${headRef}" into "${baseRef}"), acting on a direct instruction from @${viewerLogin}. This is a SINGLE run - there is no next iteration.

SETUP (do this first):
1. This directory is your workspace. If it is empty, run: gh repo clone ${repo} . -- --depth 50
   then: gh pr checkout ${number}

INSTRUCTION from @${viewerLogin}:
${instruction}

Carry out the instruction, then commit your changes with a plain descriptive message and push to origin ${headRef}.

${promptHardRules(headRef)}`;
}

async function runPromptOnce(repo: string, number: number, workdir: string, logPath: string, prompt: string, model: string): Promise<string> {
  rmSync(`${workdir}/${PROMPT_STATUS_FILE}`, { force: true });
  const logFd = openSync(logPath, "a");
  // strip inherited API keys so the agent authenticates via the harness's own login
  const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
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
  const prompt = promptAgentPrompt(repo, number, baseRef, headRef, viewerLogin, instruction);
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
const AUTOFIX_ITERATION_TEMPLATE = `THIS ITERATION - do at most one thing, then stop:
1. Check state: gh pr view {{PR_NUMBER}} --json state,mergeStateStatus,statusCheckRollup,reviewDecision,reviewThreads
2. state MERGED or CLOSED: write "gave-up" to {{STATUS_FILE}} and stop.
3. Merge conflicts (mergeStateStatus DIRTY): git fetch origin && git merge origin/{{BASE_REF}}. Resolve conflicts faithfully - preserve the intent of BOTH sides; when genuinely unsure, keep the base branch's version and say so in the merge commit body. Commit and push.
4. Else, branch behind base (mergeStateStatus BEHIND): gh pr update-branch {{PR_NUMBER}}; if that fails (e.g. permission), fall back to git fetch origin && git merge origin/{{BASE_REF}} && git push. This re-triggers CI - just do it and stop for this iteration.
5. Else, failing checks: pull the failing job logs (gh run view --log-failed, or the check's detailsUrl), diagnose, fix in this clone with the smallest change that makes the check pass, verify locally with the narrowest relevant command (single test file, lint on the touched files), commit with a plain descriptive message, push.
6. Else, unresolved review threads (from Greptile, other bots, AND human reviewers alike): for each, if the concern is valid, fix it (commit and push) and reply explaining the fix, then resolve the thread; if not valid, reply with a short explanation of why not, then resolve it.
7. Else, nothing actionable (checks running, or blocked only on human review approval - mergeStateStatus BLOCKED with no CHANGES_REQUESTED, no failing checks, no unresolved threads): if this is the third consecutive iteration you've seen "blocked only on approval, everything else green" (check your own memory of this conversation), comment that the PR is green and waiting on review, then write "waiting-review" to {{STATUS_FILE}}. Otherwise just note that and continue.
8. Give up: if the same check or thread is still unresolved after 3 distinct fix attempts by you across this conversation, comment on the PR summarizing each attempt and why it still fails, then write "gave-up" to {{STATUS_FILE}}.
9. Otherwise, overwrite {{STATUS_FILE}} with exactly "continue".
10. Report a single one-line summary of what you did this iteration.`;

export function defaultAutofixTemplate(): string {
  return AUTOFIX_ITERATION_TEMPLATE;
}

function autofixHardRules(headRef: string): string {
  return `HARD RULES - these override everything above:
- Never touch local files, repos, or processes outside this directory (gh/git talking to github.com about THIS PR is of course fine).
- Push ONLY to origin ${headRef}. Never any other branch, tag, or repo. Never force-push. Never rebase. Never amend commits you did not create this session.
- Never merge the PR, never enable GitHub's own auto-merge feature, never close or reopen the PR, never touch other PRs or issues. Getting the PR green is the whole job - a human merges it.
- Keep every fix minimal: make the check or thread resolve without rewriting unrelated code.
- Commit messages are plain and descriptive. No AI attribution, no Co-Authored-By lines, no emoji.
- At most one PR comment per distinct event (waiting-on-review, give-up). Never repeat a comment.
- Last action, always: overwrite the file ${AUTOFIX_STATUS_FILE} in this directory with exactly one word - "continue" (more to check next time), "waiting-review" (just posted the waiting-on-review comment), or "gave-up" (just posted the give-up comment).`;
}

function autofixIterationBody(number: number, baseRef: string): string {
  return (agentPromptTemplate("autofix").trim() || AUTOFIX_ITERATION_TEMPLATE)
    .replaceAll("{{PR_NUMBER}}", String(number))
    .replaceAll("{{BASE_REF}}", baseRef)
    .replaceAll("{{STATUS_FILE}}", AUTOFIX_STATUS_FILE);
}

function autofixFirstIterationPrompt(repo: string, number: number, baseRef: string, headRef: string): string {
  return `You are the auto-fix agent for the pull request ${repo}#${number} (branch "${headRef}" into "${baseRef}"). Your one goal is to get it fully green - CI passing, no merge conflicts, zero unresolved review threads - then stop and let a human merge it. You will be invoked again roughly every 3 minutes to check again - each invocation is ONE iteration, not a loop you run yourself.

SETUP (do this first):
1. This directory is your workspace. If it is empty, run: gh repo clone ${repo} . -- --depth 50
   then: gh pr checkout ${number}

${autofixIterationBody(number, baseRef)}

${autofixHardRules(headRef)}`;
}

function autofixNextIterationPrompt(number: number, baseRef: string, headRef: string): string {
  return `Same PR, next check-in (roughly 3 minutes since your last iteration). Setup is already done - do not repeat it.

${autofixIterationBody(number, baseRef)}

${autofixHardRules(headRef)}`;
}

async function runAutofixIteration(repo: string, number: number, workdir: string, logPath: string, prompt: string, useContinue: boolean): Promise<string> {
  rmSync(`${workdir}/${AUTOFIX_STATUS_FILE}`, { force: true });
  const logFd = openSync(logPath, "a");
  // strip inherited API keys so the agent authenticates via the harness's own login
  const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
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
      const prompt = isFirst ? autofixFirstIterationPrompt(repo, number, baseRef, headRef) : autofixNextIterationPrompt(number, baseRef, headRef);
      const status = await runAutofixIteration(repo, number, workdir, logPath, prompt, !isFirst);
      isFirst = false;
      if (control.stopped) return;
      if (status === "gave-up" || status === "waiting-review") {
        setAgentExitedStmt.run(status, repo, number);
        finishRun(repo, number, "exited", status);
        cleanupAgentWorkdir(workdir);
        return;
      }
      await Bun.sleep(ITERATION_INTERVAL_MS);
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

function customHardRules(headRef: string): string {
  return `HARD RULES - these override everything above:
- Never touch local files, repos, or processes outside this directory (gh/git talking to github.com about THIS PR is of course fine).
- Push ONLY to origin ${headRef}. Never any other branch, tag, or repo. Never force-push. Never rebase. Never amend commits you did not create this session.
- Never merge the PR, never enable GitHub's own auto-merge feature, never close or reopen the PR, never touch other PRs or issues.
- Keep every change minimal: do what the instruction asks without rewriting unrelated code.
- Commit messages are plain and descriptive. No AI attribution, no Co-Authored-By lines, no emoji.
- At most one PR comment per distinct event (give-up). Never repeat a comment.
- Last action, always: overwrite the file ${CUSTOM_STATUS_FILE} in this directory with exactly one word - "continue" (more to do next time), "done" (the instruction is fully satisfied), or "gave-up" (you cannot or should not proceed; post a single PR comment explaining why first).`;
}

function customIterationBody(agent: AgentSetting, number: number, baseRef: string): string {
  return agent.prompt_template
    .replaceAll("{{PR_NUMBER}}", String(number))
    .replaceAll("{{BASE_REF}}", baseRef)
    .replaceAll("{{STATUS_FILE}}", CUSTOM_STATUS_FILE);
}

function customFirstIterationPrompt(agent: AgentSetting, repo: string, number: number, baseRef: string, headRef: string, viewerLogin: string): string {
  return `You are the "${agent.name}" agent for the pull request ${repo}#${number} (branch "${headRef}" into "${baseRef}"), armed by @${viewerLogin}. Your instruction is below. You will be invoked again roughly every 3 minutes to check again - each invocation is ONE iteration, not a loop you run yourself.

SETUP (do this first):
1. This directory is your workspace. If it is empty, run: gh repo clone ${repo} . -- --depth 50
   then: gh pr checkout ${number}

INSTRUCTION:
${customIterationBody(agent, number, baseRef)}

${customHardRules(headRef)}`;
}

function customNextIterationPrompt(agent: AgentSetting, number: number, baseRef: string, headRef: string): string {
  return `Same PR, next check-in (roughly 3 minutes since your last iteration). Setup is already done - do not repeat it.

INSTRUCTION:
${customIterationBody(agent, number, baseRef)}

${customHardRules(headRef)}`;
}

async function runCustomIteration(repo: string, number: number, agentId: string, workdir: string, logPath: string, prompt: string, useContinue: boolean): Promise<string> {
  rmSync(`${workdir}/${CUSTOM_STATUS_FILE}`, { force: true });
  const logFd = openSync(logPath, "a");
  // strip inherited API keys so the agent authenticates via the harness's own login
  const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
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
      const prompt = isFirst
        ? customFirstIterationPrompt(def, repo, number, baseRef, headRef, viewerLogin)
        : customNextIterationPrompt(def, number, baseRef, headRef);
      const status = await runCustomIteration(repo, number, agentId, workdir, logPath, prompt, !isFirst);
      isFirst = false;
      if (control.stopped) return;
      if (status !== "continue") {
        setAgentExitedStmt.run(status, repo, number);
        finishRun(repo, number, "exited", status);
        cleanupAgentWorkdir(workdir);
        return;
      }
      await Bun.sleep(ITERATION_INTERVAL_MS);
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
    if (!pr || !existsSync(row.workdir)) {
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
        : superviseFixer(row.repo, row.number, row.workdir, row.log_path, pr.base_ref, pr.head_ref, "", control, true);
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

const TURN_EVENT_TYPES: Record<string, true> = { assistant: true, message_end: true, result: true, agent_end: true };
// omp emits thousands of streaming-delta events per run, so match the leading type before parsing the line
const EVENT_TYPE_PREFIX = /^\{"type":"([a-z_]+)"/;

// both harnesses stream one JSON event per line; only assistant output and the final result carry signal.
// claude emits "assistant"/"result" with an ISO top-level timestamp, omp emits "message_end"/"agent_end"
// with an epoch-ms timestamp on the message. null means the line was not JSON at all (raw CLI noise).
function eventTurns(line: string, lastTs: { value: string }): AgentTurn[] | null {
  if (!line.startsWith("{")) return null;
  const typed = EVENT_TYPE_PREFIX.exec(line)?.[1];
  if (typed && !TURN_EVENT_TYPES[typed]) return [];
  let event: {
    type?: string;
    timestamp?: string;
    message?: { role?: string; content?: unknown; timestamp?: number };
    messages?: unknown;
    is_error?: boolean;
    result?: unknown;
  };
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof event.timestamp === "string") lastTs.value = event.timestamp;
  if (typeof event.message?.timestamp === "number") lastTs.value = new Date(event.message.timestamp).toISOString();
  const ts = lastTs.value;
  if (event.type === "assistant" || (event.type === "message_end" && event.message?.role === "assistant")) {
    const turns: AgentTurn[] = [];
    for (const block of (Array.isArray(event.message?.content) ? event.message.content : []) as Array<Record<string, unknown>>) {
      if (block.type === "text" && typeof block.text === "string") turns.push({ ts, kind: "text", text: block.text });
      else if (block.type === "tool_use") turns.push({ ts, kind: "tool", toolName: block.name as string, toolInput: block.input });
      else if (block.type === "toolCall") turns.push({ ts, kind: "tool", toolName: block.name as string, toolInput: block.arguments });
    }
    return turns;
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
