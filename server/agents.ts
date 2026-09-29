import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync } from "node:fs";
import { db, getCachedPrDetail, getPr, lastWebhookAtForPr, type PrRow } from "./db.ts";
import { unsatisfiedRequiredChecks } from "./checkState.ts";
import { refreshCachedPrDetail } from "./cachedPrDetail.ts";
import { GithubRequestError, type PrDetail } from "./github.ts";
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

// Clone through Git; gh only supplies local credentials, so checkout needs no GitHub API quota.
function cockpitCommands(repo: string, number: number, headRef: string, headRepo: string | null): string {
  const ref = `${repo}#${number}`;
  const clone = (branch: string) => `git clone -c credential.helper= -c 'credential.helper=!gh auth git-credential' --filter=blob:none ${branch}https://github.com/${repo}.git .`;
  const code = headRepo === repo
    ? `run \`${clone(`--branch ${headRef} `)}\`. Push only with \`git push origin HEAD:${headRef}\`.`
    : headRepo
      ? `run \`${clone("")} && git remote add head https://github.com/${headRepo}.git && git fetch head ${headRef} && git checkout -b cockpit-pr-${number} head/${headRef}\`. The branch lives in the fork ${headRepo}: push only with \`git push head HEAD:${headRef}\`; if the fork rejects it, explain on the PR instead of pushing anywhere else.`
      : `run \`${clone("")} && git fetch origin pull/${number}/head && git checkout --detach FETCH_HEAD\`. Cockpit doesn't know which repository holds this branch, so never push.`;
  return `COCKPIT COMMANDS - the only way to read or change this PR; never gh commands or GitHub APIs:
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
  return `${baseHardRules(`Only Cockpit merges: you signal readiness, and Cockpit re-checks a fresh snapshot before merging exactly the head you name.`)}
- Last action, always: overwrite the file ${FIXER_STATUS_FILE} in this directory with exactly one line - "continue" (nothing more to do until the PR changes; Cockpit relaunches you with a fresh brief when it does), "ready-to-merge <SHA>" (ready to merge at SHA, the full 40-character head commit you checked; a bare "ready-to-merge" or a run that doesn't exit cleanly is refused), "merged" (the PR is already merged or closed), "waiting-review" (you commented on what a person must review or decide), or "gave-up" (you commented on the access or blocker nobody here can clear).`;
}

// placeholders substituted at spawn time by renderIterationTemplate - a custom template is rendered the same way
const DEFAULT_FIXER_TEMPLATE = `The user approved this change and armed auto-merge: landing it is approved, so don't ask anyone to approve the change again. Your job is to get it merged safely. Work out what stands between this PR and a safe merge - merge conflicts, review feedback from people and bots, CI failures this PR caused - and clear it the way the evidence supports. A failing check the PR didn't cause doesn't block the merge, and you don't need to rerun anything to prove that - judge from the evidence you have. Follow your loaded global instructions and the repository's instructions; after cloning, read the repository's AGENTS.md before editing. If only someone else can unblock it, such as a CHANGES_REQUESTED review, a required approval GitHub enforces, or access you lack, comment once saying what's needed.{{FORCE_MERGE_STEP}}`;

export function defaultFixerTemplate(): string {
  return DEFAULT_FIXER_TEMPLATE;
}

// a custom fixer template that drops {{FORCE_MERGE_STEP}} still carries the merge step, last; the step goes in
// first because it carries placeholders of its own. Saved templates may still name {{BOT_REVIEWERS}}.
function renderIterationTemplate(template: string, repo: string, number: number, baseRef: string, mergeStep: string): string {
  const withMergeStep = template.includes("{{FORCE_MERGE_STEP}}") ? template.replaceAll("{{FORCE_MERGE_STEP}}", mergeStep) : `${template}${mergeStep}`;
  return withMergeStep
    .replaceAll("{{REPO}}", repo)
    .replaceAll("{{BOT_REVIEWERS}}", reviewBots().map((bot) => bot.login).join(", "))
    .replaceAll("{{PR_NUMBER}}", String(number))
    .replaceAll("{{BASE_REF}}", baseRef)
    .replaceAll("{{STATUS_FILE}}", FIXER_STATUS_FILE);
}

function fixerPrompt(isFirst: boolean, repo: string, number: number, baseRef: string, headRef: string, brief: string, mergeStep: string, template: string, refusal: string | null): string {
  return `${isFirst
    ? `You are the auto-merge fixer for the pull request ${repo}#${number} (branch "${headRef}" into "${baseRef}").`
    : "Same PR, relaunched because it changed or your last run ended. The brief below is current; start from it."}

${brief}
${refusal ? `\nCOCKPIT REFUSED YOUR LAST READY SIGNAL: ${refusal}.\n` : ""}
${renderIterationTemplate(template.trim() || DEFAULT_FIXER_TEMPLATE, repo, number, baseRef, mergeStep)}

${hardRules()}`;
}

function nextBlocker(summary: PrAgentSummary, strictChecks: boolean): string {
  if (summary.state === "MERGED" || summary.state === "CLOSED") return `the PR is ${summary.state}; nothing to do`;
  if (summary.merge === "DIRTY") return `resolve the merge conflicts with ${summary.base} first`;
  if (summary.merge === "BEHIND") return `bring the branch up to date with \`pr-cockpit update-branch ${summary.ref}\``;
  if (summary.ci.state === "FAILURE" || summary.ci.state === "CANCELLED") return strictChecks ? "fix the failing checks, then the open review threads" : "checks report failures; fix those this PR caused, and address the open review feedback";
  if (summary.openComments.length > 0 || summary.review === "CHANGES_REQUESTED") return "address the open review feedback";
  if (summary.ci.running > 0) return strictChecks ? `checks are still running; wait with \`pr-cockpit listen ${summary.ref} --ci-only\`` : "checks are still running";
  if (summary.ci.state === "PENDING") return `Actions coverage is incomplete in this snapshot; confirm with \`pr-cockpit ${summary.ref} --jobs\` before treating checks as green`;
  return "no blocker is known in this snapshot; only the merge gate remains";
}

// cache-only: a missing head repository means the push target is unknown, not permission to guess it or
// spend GitHub quota before starting the agent. The freshness line keeps stale clean state from reading as mergeable.
async function cockpitBrief(repo: string, number: number, headRef: string, strictChecks = true): Promise<string> {
  const ref = `${repo}#${number}`;
  const newest = () => {
    const tracked = getPr(repo, number);
    const cached = getCachedPrDetail(repo, number);
    return { tracked, row: !tracked ? cached : cached && cached.fetched_at > tracked.fetched_at ? cached : tracked };
  };
  const { tracked, row } = newest();
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
Next: ${nextBlocker(summary, strictChecks)}.
Auto-merge (cached): Cockpit ${tracked?.auto_merge_enabled ? "armed" : "not armed"} · GitHub ${githubAutoMerge}. Leave both as they are.

${formatPrAgentSummary(summary, { body: false }).trim()}

${cockpitCommands(repo, number, detail.headRefName || headRef, detail.headRepository?.nameWithOwner ?? null)}`;
}

// the fixer's signal attests its own judgment of the final head, so remote CI doesn't gate it here: GitHub's merge
// state still enforces required checks, and only a force-merge opt-in lets BLOCKED through. Returns why not, or null.
interface MergeGatePr {
  head_sha: string;
  state: string;
  is_draft: number;
  mergeable: string;
  merge_state_status: string;
  base_ref: string;
  review_decision: string | null;
  unresolved_count: number;
}
export function fixerMergeRefusal(repo: string, pr: MergeGatePr, sha: string): string | null {
  if (pr.head_sha !== sha) return `you signaled ${sha}, but the PR head is now ${pr.head_sha}; check that head and signal it instead`;
  if (pr.state !== "OPEN") return `the PR is ${pr.state}`;
  if (pr.is_draft) return "the PR is a draft, and marking it ready for review is a person's call";
  if (pr.mergeable !== "MERGEABLE" || pr.merge_state_status === "DIRTY") return `GitHub reports mergeable ${pr.mergeable || "unknown"} (merge state ${pr.merge_state_status || "unknown"}), not conflict-free`;
  if (pr.merge_state_status === "BEHIND") return `the branch is behind ${pr.base_ref}`;
  if (pr.review_decision === "CHANGES_REQUESTED") return "a CHANGES_REQUESTED review is still in effect, and only its reviewer can clear it";
  if (pr.unresolved_count > 0) return `${pr.unresolved_count} review thread${pr.unresolved_count === 1 ? " is" : "s are"} still unresolved`;
  if (mergeAllowedNow(repo, pr)) return null;
  return pr.merge_state_status === "BLOCKED"
    ? `GitHub reports BLOCKED (a required approval or required check is unmet), and ${repo} is not opted into force-merge, so Cockpit won't bypass it`
    : `GitHub reports merge state ${pr.merge_state_status || "unknown"}, which does not allow merging yet`;
}

// states the gate instead of checking launch-time cache state; the server-side gate re-verifies
export function mergeStepText(repo: string, allowMerge = true): string {
  if (!allowMerge) return "";
  const gate = "Cockpit merges the head you signal only when it has no conflicts, isn't behind, and has no CHANGES_REQUESTED review or unresolved thread";
  return forceMergeEnabled(repo)
    ? `\n${gate}; this repository opted into force-merge, so GitHub's BLOCKED state doesn't stop it.`
    : `\n${gate}, and GitHub allows the merge; BLOCKED means a required approval or check is unmet, and Cockpit won't bypass it.`;
}

const READY_SIGNAL = /^ready-to-merge ([0-9a-f]{40})$/;

interface MergeOutcome {
  // null once merged; otherwise why not, phrased for the agent
  refusal: string | null;
  unavailable: boolean;
  // the snapshot that passed the gate when GitHub itself then refused or failed the merge
  gated: PrRow | null;
}

// the one merge path for agent signals. The agent's word is a signal, not authority: gate on the post-run refresh
// and bind the merge to the head it signaled. refreshFailure is refreshAgentPr's result for that refresh.
async function mergeSignaledHead(repo: string, number: number, sha: string, refreshFailure: unknown, logPath: string): Promise<MergeOutcome> {
  // GitHub never answered (quota block or transport), as opposed to deciding against the read or merge
  const unavailable = (err: unknown) => err instanceof GithubRequestError && (err.kind === "quota" || err.kind === "transport");
  const tracked = refreshFailure === null ? getPr(repo, number) : null;
  const cached = refreshFailure === null && !tracked ? getCachedPrDetail(repo, number) : null;
  const detail = cached ? JSON.parse(cached.detail_json) as PrDetail : null;
  // A PR opened by URL stays untracked. Project only its freshly fetched gate fields, never grant push access
  // or infer mergeability from a cached pre-run snapshot.
  const fresh: MergeGatePr | null = tracked ?? (detail && {
    head_sha: detail.headRefOid,
    state: detail.state,
    is_draft: detail.isDraft ? 1 : 0,
    mergeable: detail.mergeable,
    merge_state_status: detail.mergeStateStatus,
    base_ref: detail.baseRefName,
    review_decision: detail.reviewDecision,
    unresolved_count: detail.reviewThreads.nodes.filter((thread) => !thread.isResolved && !thread.isOutdated).length,
  });
  const refused = refreshFailure !== null
    ? `Cockpit could not refresh the PR, so it could not re-verify it: ${truncate(String(refreshFailure), 300)}`
    : !fresh
      ? "Cockpit could not find a fresh PR snapshot"
      : fixerMergeRefusal(repo, fresh, sha);
  if (refused || !fresh) {
    appendFileSync(logPath, `\ncockpit refused merge signal for ${repo}#${number}: ${refused}\n`);
    return { refusal: refused, unavailable: unavailable(refreshFailure), gated: null };
  }
  try {
    await mergeWithLearning(repo, number, fresh.base_ref, sha);
  } catch (err) {
    appendFileSync(logPath, `\ncockpit merge failed for ${repo}#${number}: ${err}\n`);
    return {
      refusal: `${unavailable(err) ? "GitHub was unavailable for Cockpit's merge of" : "GitHub rejected Cockpit's merge of"} ${sha}: ${truncate(String(err), 300)}`,
      unavailable: unavailable(err),
      gated: tracked,
    };
  }
  return { refusal: null, unavailable: false, gated: null };
}

interface FixerStatus {
  status: string;
  sha: string | null;
  refusal: string | null;
}

// the ready signal must name the head the agent checked and come from a clean harness exit; anything else is
// refused back to the agent in its next brief instead of merging or silently relaunching on the same prompt
export function parseFixerStatus(text: string | null, exitCode: number | null): FixerStatus {
  const status = text?.trim() ?? "continue";
  if (status.startsWith("ready-to-merge")) {
    const sha = READY_SIGNAL.exec(status)?.[1] ?? null;
    if (!sha) return { status: "continue", sha: null, refusal: `your status file said "${truncate(status, 80)}", but the ready signal must be exactly "ready-to-merge <SHA>" with the full 40-character lowercase head commit you checked` };
    if (exitCode !== 0) return { status: "continue", sha: null, refusal: `your harness exited with code ${exitCode} after signaling ${sha}, and Cockpit only accepts a ready signal from a run that exits cleanly` };
    return { status: "ready-to-merge", sha, refusal: null };
  }
  return { status: status === "continue" || TERMINAL_STATUSES.includes(status) ? status : "continue", sha: null, refusal: null };
}

async function runIteration(repo: string, number: number, workdir: string, logPath: string, prompt: string, useContinue: boolean): Promise<FixerStatus> {
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
  return parseFixerStatus((await statusFile.exists()) ? await statusFile.text() : null, proc.exitCode);
}

const activeSupervisors = new Map<string, { stopped: boolean }>();

function prFingerprint(pr: PrRow | null): string {
  return pr ? [pr.state, pr.head_sha, pr.merge_state_status, pr.ci_status, pr.review_decision, pr.unresolved_count, pr.updated_at].join("|") : "";
}

// the run's own push must land in the cache before the merge gate or the next brief reads it; a PR opened only
// by URL lives in the detail cache, and refreshing it through the poller would start tracking it. Resolves to the
// failure, or null once the cache holds a fresh read.
async function refreshAgentPr(repo: string, number: number, logPath: string, source: GithubUsageSource): Promise<unknown> {
  try {
    if (getPr(repo, number)) {
      // dynamic: a static poller import would close the agents -> poller -> activity -> agents cycle
      const { refreshPr } = await import("./poller.ts");
      await refreshPr(repo, number, source, "all", "detail");
    } else {
      await refreshCachedPrDetail(repo, number, source);
    }
    return null;
  } catch (err) {
    appendFileSync(logPath, `\ncockpit refresh (${source}) failed for ${repo}#${number}: ${err}\n`);
    return err;
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
  // why Cockpit turned down the last ready signal, carried into the next brief so the agent acts on it
  let refusal: string | null = null;
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
      const prompt = fixerPrompt(isFirst, repo, number, baseRef, headRef, await cockpitBrief(repo, number, headRef, false), mergeStepText(repo), agentPromptTemplate("fixer"), refusal);
      refusal = null;
      const run = await runIteration(repo, number, workdir, logPath, prompt, !isFirst);
      isFirst = false;
      if (control.stopped) return;
      const refreshFailure = await refreshAgentPr(repo, number, logPath, "agent read");
      if (control.stopped) return;
      if (run.refusal) {
        refusal = run.refusal;
        appendFileSync(logPath, `\ncockpit refused merge signal for ${repo}#${number}: ${refusal}\n`);
        await awaitPrChange(repo, number, briefed, control);
        continue;
      }
      if (run.status === "ready-to-merge" && run.sha) {
        // disabling the fixer during the run revokes its merge authority; the loop head then exits
        if (!agentEnabled("fixer")) continue;
        const outcome = await mergeSignaledHead(repo, number, run.sha, refreshFailure, logPath);
        if (outcome.refusal) {
          // no retry cap: the agent reads the reason next run and either clears it or reports the blocker itself
          refusal = outcome.refusal;
          await awaitPrChange(repo, number, outcome.gated ? prFingerprint(outcome.gated) : briefed, control);
          continue;
        }
        setAgentExitedStmt.run("merged", repo, number);
        finishRun(repo, number, "exited", "merged");
        cleanupAgentWorkdir(workdir);
        await refreshAgentPr(repo, number, logPath, "mutation recovery");
        return;
      }
      if (run.status !== "continue") {
        setAgentExitedStmt.run(run.status, repo, number);
        finishRun(repo, number, "exited", run.status);
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
  startRun(repo, number, "fixer", "", workdir, logPath, "auto-merge fixer: merge this approved PR safely", startedAt);

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

// the launching user is named by role, not GitHub login: resolving the login is a REST call that must not gate a cached launch
function promptAgentPrompt(repo: string, number: number, baseRef: string, headRef: string, instruction: string, brief: string): string {
  return `You are a one-shot agent working on the pull request ${repo}#${number} (branch "${headRef}" into "${baseRef}"), acting on the user's direct instruction. This is a SINGLE run - there is no next iteration.

${brief}

INSTRUCTION from the user:
${instruction}

Carry out the instruction. If it changes code, commit with a plain descriptive message and push it as the rules below allow.

${baseHardRules(`Merge authority comes only from the INSTRUCTION above: only if it explicitly asks for this PR to be merged may you signal it ready, as the last rule below allows. ${mergeStepText(repo).trim()} Otherwise this run has no merge authority.`)}
- Do exactly what the instruction asks and nothing more - no unrelated cleanup or refactors. If it needs no code change, make no commit.
- Last action, always: overwrite the file ${PROMPT_STATUS_FILE} in this directory with exactly one line - "done" (you did what it asked), "no-op" (nothing to change), "gave-up" (you could not or should not do it; post a single PR comment explaining why first), or, only when the instruction explicitly asks to merge this PR and you judge it ready, "ready-to-merge <SHA>" (the full 40-character head commit you checked; a bare "ready-to-merge" or a run that doesn't exit cleanly is refused).`;
}

async function runPromptOnce(repo: string, number: number, workdir: string, logPath: string, prompt: string, model: string): Promise<FixerStatus> {
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
  if (sentinel?.startsWith("ready-to-merge")) return parseFixerStatus(sentinel, proc.exitCode);
  // only an explicit success sentinel on a clean exit is trusted; a crash or missing sentinel gives up so it never arms
  const status = proc.exitCode === 0 && (sentinel === "done" || sentinel === "no-op") ? sentinel : "gave-up";
  return { status, sha: null, refusal: null };
}

// one shot: a refused or unavailable merge ends the run with its reason in the log instead of relaunching
async function runPromptAgent(repo: string, number: number, workdir: string, logPath: string, baseRef: string, headRef: string, instruction: string, model: string): Promise<void> {
  const prompt = promptAgentPrompt(repo, number, baseRef, headRef, instruction, await cockpitBrief(repo, number, headRef));
  const run = await runPromptOnce(repo, number, workdir, logPath, prompt, model);
  // a kill during the run already set state=killed - respect it, no exit-state clobber, no handoff
  if (getAgentStmt.get(repo, number)?.state === "killed") return;
  let status = run.status;
  if (run.refusal) {
    appendFileSync(logPath, `\ncockpit refused merge signal for ${repo}#${number}: ${run.refusal}\n`);
    status = "merge-refused";
  } else if (run.status === "ready-to-merge" && run.sha) {
    const refreshFailure = await refreshAgentPr(repo, number, logPath, "agent read");
    if (getAgentStmt.get(repo, number)?.state === "killed") return;
    const outcome = await mergeSignaledHead(repo, number, run.sha, refreshFailure, logPath);
    status = !outcome.refusal ? "merged" : outcome.unavailable ? "merge-unavailable" : "merge-refused";
    if (!outcome.refusal) await refreshAgentPr(repo, number, logPath, "mutation recovery");
  }
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

  runPromptAgent(repo, number, workdir, logPath, refs.baseRef, refs.headRef, instruction, model).catch((err) => {
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

// GitHub's StatusCheckRollupState values, as computed by checkRollupStatus in poller.ts; NONE means no checks at all
const CI_GREEN_STATUSES = new Set(["SUCCESS", "NONE"]);

// autofix stops only on a fully green PR: the rollup alone is not enough, because a required check that was
// skipped or cancelled leaves that requirement unmet without failing the rollup
export function isGreen(pr: PrRow): boolean {
  return pr.merge_state_status === "CLEAN" &&
    pr.review_decision !== "CHANGES_REQUESTED" &&
    CI_GREEN_STATUSES.has(pr.ci_status) &&
    pr.unresolved_count === 0 &&
    unsatisfiedRequiredChecks(pr.detail_json).length === 0;
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
      const prompt = autofixPrompt(isFirst, repo, number, baseRef, headRef, await cockpitBrief(repo, number, headRef));
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

function customPrompt(agent: AgentSetting, isFirst: boolean, repo: string, number: number, baseRef: string, headRef: string, brief: string): string {
  const instruction = agent.prompt_template
    .replaceAll("{{REPO}}", repo)
    .replaceAll("{{PR_NUMBER}}", String(number))
    .replaceAll("{{BASE_REF}}", baseRef)
    .replaceAll("{{STATUS_FILE}}", CUSTOM_STATUS_FILE);
  return `${isFirst
    ? `You are the "${agent.name}" agent for the pull request ${repo}#${number} (branch "${headRef}" into "${baseRef}"), armed by the user. Your instruction is below.`
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
      const prompt = customPrompt(def, isFirst, repo, number, baseRef, headRef, await cockpitBrief(repo, number, headRef));
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
  superviseCustom(repo, number, agentId, workdir, logPath, pr.base_ref, pr.head_ref, control, false).catch((err) => {
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
      ? superviseCustom(row.repo, row.number, row.agent_id, row.workdir, row.log_path, pr.base_ref, pr.head_ref, control, true)
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
