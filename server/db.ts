import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { setGithubGraphqlUsageRecorder, type GithubGraphqlUsageEvent } from "./githubUsage.ts";
import type { PrIndexEntry } from "./github.ts";
import { SCHEMA_EPOCH } from "./schemaEpoch.ts";
import { prKey } from "./prKey.ts";

const dataDir = Bun.env.COCKPIT_DATA_DIR ?? "data";
mkdirSync(dataDir, { recursive: true });

export const RUN_JOB_LOG_FORMAT_VERSION = 2;
export const db = new Database(`${dataDir}/cockpit.db`);
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
CREATE TABLE IF NOT EXISTS prs (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  state TEXT NOT NULL,
  is_draft INTEGER NOT NULL,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  head_ref TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  additions INTEGER NOT NULL,
  deletions INTEGER NOT NULL,
  changed_files INTEGER NOT NULL,
  commit_count INTEGER NOT NULL,
  mergeable TEXT NOT NULL,
  merge_state_status TEXT NOT NULL DEFAULT '',
  auto_merge_enabled INTEGER NOT NULL DEFAULT 0,
  viewer_is_author INTEGER NOT NULL DEFAULT 0,
  viewer_review_requested INTEGER NOT NULL DEFAULT 0,
  viewer_review_state TEXT,
  ci_status TEXT NOT NULL,
  review_decision TEXT,
  unresolved_count INTEGER NOT NULL,
  needs_me_rank INTEGER NOT NULL,
  greptile_confidence INTEGER,
  greptile_reviewed_sha TEXT,
  greptile_unresolved_count INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);

CREATE INDEX IF NOT EXISTS prs_rank_idx ON prs (needs_me_rank, updated_at DESC);

CREATE TABLE IF NOT EXISTS diffs (
  head_sha TEXT PRIMARY KEY,
  patch TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS file_contents (
  sha TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (sha, path)
);

CREATE TABLE IF NOT EXISTS mutations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS mutations_pr_idx ON mutations (repo, number, id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS github_graphql_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  machine TEXT NOT NULL,
  source TEXT NOT NULL,
  operation TEXT NOT NULL,
  cost INTEGER,
  used INTEGER,
  remaining INTEGER,
  reset_at TEXT,
  status TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS github_graphql_usage_window_idx
ON github_graphql_usage (reset_at, source, operation);

CREATE TABLE IF NOT EXISTS pr_index (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  is_draft INTEGER NOT NULL,
  author TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  merged_at TEXT,
  closed_at TEXT,
  involves_me INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo, number)
);

CREATE TABLE IF NOT EXISTS archived_prs (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  archived_at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);

CREATE TABLE IF NOT EXISTS pr_rank (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  position REAL NOT NULL,
  PRIMARY KEY (repo, number)
);

CREATE TABLE IF NOT EXISTS pr_detail_cache (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);

CREATE TABLE IF NOT EXISTS merged_pr_analytics_cache (
  repo TEXT NOT NULL,
  base TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (repo, base)
);

CREATE TABLE IF NOT EXISTS repo_users (
  repo TEXT NOT NULL,
  login TEXT NOT NULL,
  user_id TEXT NOT NULL,
  avatar_url TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (repo, login)
);

CREATE TABLE IF NOT EXISTS webhook_registrations (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  window_id TEXT,
  last_webhook_at TEXT,
  PRIMARY KEY (repo, number)
);

CREATE TABLE IF NOT EXISTS pr_webhook_activity (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (repo, number)
);

CREATE TABLE IF NOT EXISTS review_rescores (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  reviewer TEXT NOT NULL,
  review_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  score REAL NOT NULL,
  verdicts_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo, number, reviewer, review_sha, head_sha)
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  repo TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  run_attempt INTEGER NOT NULL,
  pr_number INTEGER,
  head_sha TEXT NOT NULL,
  head_branch TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  workflow_path TEXT NOT NULL DEFAULT '',
  display_title TEXT NOT NULL DEFAULT '',
  event TEXT NOT NULL DEFAULT '',
  actor_login TEXT,
  status TEXT NOT NULL,
  conclusion TEXT,
  event_at TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT,
  run_started_at TEXT,
  run_number INTEGER NOT NULL DEFAULT 0,
  html_url TEXT,
  jobs_fetched_at TEXT,
  reconciled_at TEXT,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (repo, run_id, run_attempt)
);

CREATE TABLE IF NOT EXISTS action_workflows (
  repo TEXT NOT NULL,
  workflow_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  state TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (repo, path)
);

CREATE INDEX IF NOT EXISTS workflow_runs_pr_idx ON workflow_runs (repo, pr_number, head_sha);
CREATE INDEX IF NOT EXISTS workflow_runs_repo_time_idx ON workflow_runs (repo, event_at DESC);

CREATE TABLE IF NOT EXISTS actions_leases (
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  bootstrapped_at TEXT,
  PRIMARY KEY (repo, number)
);

CREATE TABLE IF NOT EXISTS run_jobs (
  repo TEXT NOT NULL,
  job_id INTEGER NOT NULL,
  run_id INTEGER NOT NULL,
  run_attempt INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  head_branch TEXT NOT NULL DEFAULT '',
  workflow_name TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  conclusion TEXT,
  started_at TEXT,
  completed_at TEXT,
  html_url TEXT,
  runner_name TEXT,
  runner_group_name TEXT,
  labels_json TEXT NOT NULL DEFAULT '[]',
  failed_step TEXT,
  log_gz BLOB,
  log_bytes INTEGER,
  log_truncated INTEGER NOT NULL DEFAULT 0,
  log_error TEXT,
  log_format_version INTEGER NOT NULL DEFAULT ${RUN_JOB_LOG_FORMAT_VERSION},
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (repo, job_id)
);

CREATE INDEX IF NOT EXISTS run_jobs_sha_idx ON run_jobs (repo, head_sha, run_id, run_attempt);
`);

let workflowRunColumns = db.query("PRAGMA table_info(workflow_runs)").all() as Array<{ name: string; notnull: number }>;
const workflowRunPrNumber = workflowRunColumns.find((column) => column.name === "pr_number");
if (workflowRunPrNumber?.notnull === 1) {
  db.exec(`
    DROP INDEX IF EXISTS workflow_runs_pr_idx;
    ALTER TABLE workflow_runs RENAME TO workflow_runs_legacy;
    CREATE TABLE workflow_runs (
      repo TEXT NOT NULL,
      run_id INTEGER NOT NULL,
      run_attempt INTEGER NOT NULL,
      pr_number INTEGER,
      head_sha TEXT NOT NULL,
      head_branch TEXT NOT NULL,
      workflow_name TEXT NOT NULL,
      workflow_path TEXT NOT NULL DEFAULT '',
      display_title TEXT NOT NULL DEFAULT '',
      event TEXT NOT NULL DEFAULT '',
      actor_login TEXT,
      status TEXT NOT NULL,
      conclusion TEXT,
      event_at TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT,
      run_started_at TEXT,
      run_number INTEGER NOT NULL DEFAULT 0,
      html_url TEXT,
      jobs_fetched_at TEXT,
      reconciled_at TEXT,
      fetched_at TEXT NOT NULL,
      PRIMARY KEY (repo, run_id, run_attempt)
    );
    INSERT INTO workflow_runs (
      repo, run_id, run_attempt, pr_number, head_sha, head_branch, workflow_name,
      workflow_path, status, conclusion, event_at, html_url, jobs_fetched_at,
      reconciled_at, fetched_at
    )
    SELECT
      repo, run_id, run_attempt, pr_number, head_sha, head_branch, workflow_name,
      workflow_path, status, conclusion, event_at, html_url, jobs_fetched_at,
      reconciled_at, fetched_at
    FROM workflow_runs_legacy;
    DROP TABLE workflow_runs_legacy;
    CREATE INDEX workflow_runs_pr_idx ON workflow_runs (repo, pr_number, head_sha);
    CREATE INDEX workflow_runs_repo_time_idx ON workflow_runs (repo, event_at DESC);
  `);
  workflowRunColumns = db.query("PRAGMA table_info(workflow_runs)").all() as Array<{ name: string; notnull: number }>;
}
for (const [name, definition] of [
  ["workflow_path", "TEXT NOT NULL DEFAULT ''"],
  ["display_title", "TEXT NOT NULL DEFAULT ''"],
  ["event", "TEXT NOT NULL DEFAULT ''"],
  ["actor_login", "TEXT"],
  ["created_at", "TEXT"],
  ["updated_at", "TEXT"],
  ["run_started_at", "TEXT"],
  ["run_number", "INTEGER NOT NULL DEFAULT 0"],
] as const) {
  if (!workflowRunColumns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE workflow_runs ADD COLUMN ${name} ${definition}`);
  }
}
db.exec("CREATE INDEX IF NOT EXISTS workflow_runs_repo_time_idx ON workflow_runs (repo, event_at DESC)");

const runJobColumns = db.query("PRAGMA table_info(run_jobs)").all() as Array<{ name: string }>;
for (const [name, definition] of [
  ["head_branch", "TEXT NOT NULL DEFAULT ''"],
  ["workflow_name", "TEXT NOT NULL DEFAULT ''"],
  ["runner_name", "TEXT"],
  ["runner_group_name", "TEXT"],
  ["labels_json", "TEXT NOT NULL DEFAULT '[]'"],
  ["log_format_version", "INTEGER NOT NULL DEFAULT 1"],
] as const) {
  if (!runJobColumns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE run_jobs ADD COLUMN ${name} ${definition}`);
  }
}

const prsColumns = db.query("PRAGMA table_info(prs)").all() as Array<{ name: string }>;
if (!prsColumns.some((c) => c.name === "merge_state_status")) {
  db.exec("ALTER TABLE prs ADD COLUMN merge_state_status TEXT NOT NULL DEFAULT ''");
}
if (!prsColumns.some((c) => c.name === "auto_merge_enabled")) {
  db.exec("ALTER TABLE prs ADD COLUMN auto_merge_enabled INTEGER NOT NULL DEFAULT 0");
}
if (!prsColumns.some((c) => c.name === "viewer_is_author")) {
  db.exec("ALTER TABLE prs ADD COLUMN viewer_is_author INTEGER NOT NULL DEFAULT 0");
}
if (!prsColumns.some((c) => c.name === "viewer_review_requested")) {
  db.exec("ALTER TABLE prs ADD COLUMN viewer_review_requested INTEGER NOT NULL DEFAULT 0");
}
if (!prsColumns.some((c) => c.name === "viewer_review_state")) {
  db.exec("ALTER TABLE prs ADD COLUMN viewer_review_state TEXT");
}
if (!prsColumns.some((c) => c.name === "greptile_confidence")) {
  db.exec("ALTER TABLE prs ADD COLUMN greptile_confidence INTEGER");
}
if (!prsColumns.some((c) => c.name === "greptile_reviewed_sha")) {
  db.exec("ALTER TABLE prs ADD COLUMN greptile_reviewed_sha TEXT");
}
if (!prsColumns.some((c) => c.name === "greptile_unresolved_count")) {
  db.exec("ALTER TABLE prs ADD COLUMN greptile_unresolved_count INTEGER NOT NULL DEFAULT 0");
}

const prIndexColumns = db.query("PRAGMA table_info(pr_index)").all() as Array<{ name: string }>;
if (!prIndexColumns.some((c) => c.name === "merged_at")) {
  db.exec("ALTER TABLE pr_index ADD COLUMN merged_at TEXT");
}
if (!prIndexColumns.some((c) => c.name === "closed_at")) {
  db.exec("ALTER TABLE pr_index ADD COLUMN closed_at TEXT");
}
if (!prIndexColumns.some((c) => c.name === "involves_me")) {
  db.exec("ALTER TABLE pr_index ADD COLUMN involves_me INTEGER NOT NULL DEFAULT 0");
}
db.exec("CREATE INDEX IF NOT EXISTS pr_index_terminal_idx ON pr_index (involves_me, state, COALESCE(merged_at, closed_at, updated_at) DESC)");

const webhookRegistrationColumns = db.query("PRAGMA table_info(webhook_registrations)").all() as Array<{ name: string; pk: number }>;
if (webhookRegistrationColumns.find((c) => c.name === "window_id")?.pk) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE webhook_registrations_rekey (
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        window_id TEXT,
        last_webhook_at TEXT,
        PRIMARY KEY (repo, number)
      );
      INSERT INTO webhook_registrations_rekey (repo, number, window_id, last_webhook_at)
      SELECT repo, number, window_id, last_webhook_at
      FROM (
        SELECT repo, number, window_id, last_webhook_at,
          ROW_NUMBER() OVER (
            PARTITION BY repo, number
            ORDER BY last_webhook_at IS NULL, last_webhook_at DESC, rowid DESC
          ) AS row_number
        FROM webhook_registrations
      )
      WHERE row_number = 1;
      DROP TABLE webhook_registrations;
      ALTER TABLE webhook_registrations_rekey RENAME TO webhook_registrations;
    `);
  })();
}

// Old merge rows lack the click-time branch/method snapshot required by the current contract.
db.exec(`
  UPDATE mutations
  SET kind = 'merge', payload_json = json_set(payload_json, '$.kind', 'merge')
  WHERE kind = 'merge-squash';
  DELETE FROM mutations
  WHERE kind = 'merge' AND json_extract(payload_json, '$.baseRef') IS NULL;
`);

// merge methods learned from GitHub or explicitly selected by the user, keyed per repo:base
db.exec(`
  CREATE TABLE IF NOT EXISTS merge_methods (
    repo TEXT NOT NULL,
    base_ref TEXT NOT NULL,
    method TEXT NOT NULL,
    learned_at TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'learned',
    PRIMARY KEY (repo, base_ref)
  );
`);
const mergeMethodColumns = db.query("PRAGMA table_info(merge_methods)").all() as Array<{ name: string }>;
if (!mergeMethodColumns.some((c) => c.name === "source")) {
  db.exec("ALTER TABLE merge_methods ADD COLUMN source TEXT NOT NULL DEFAULT 'learned'");
}
const diffColumns = db.query("PRAGMA table_info(diffs)").all() as Array<{ name: string }>;
if (!diffColumns.some((c) => c.name === "fetched_at")) {
  db.exec("ALTER TABLE diffs ADD COLUMN fetched_at TEXT NOT NULL DEFAULT ''");
}

const storedEpoch = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
if (storedEpoch !== SCHEMA_EPOCH) {
  db.exec("DELETE FROM diffs; DELETE FROM pr_detail_cache;");
  db.exec(`PRAGMA user_version = ${SCHEMA_EPOCH}`);
}

db.exec("DELETE FROM pr_detail_cache WHERE fetched_at < datetime('now', '-30 days')");
db.exec("DELETE FROM pr_webhook_activity WHERE received_at < datetime('now', '-30 days')");
// Diffs are a pure re-fetchable cache and were insert-only until this column existed;
// legacy rows carry '' and so are swept by the same retention pass.
db.exec("DELETE FROM diffs WHERE fetched_at < datetime('now', '-30 days')");
// Job rows and their logs are re-fetchable and only useful while the PR head is current.
db.exec("DELETE FROM run_jobs WHERE fetched_at < datetime('now', '-30 days')");
db.exec("DELETE FROM workflow_runs WHERE fetched_at < datetime('now', '-30 days')");
db.exec("DELETE FROM actions_leases");

export interface PrRow {
  repo: string;
  number: number;
  state: string;
  is_draft: number;
  title: string;
  author: string;
  base_ref: string;
  head_ref: string;
  head_sha: string;
  updated_at: string;
  additions: number;
  deletions: number;
  changed_files: number;
  commit_count: number;
  mergeable: string;
  merge_state_status: string;
  auto_merge_enabled: number;
  viewer_is_author: number;
  viewer_review_requested: number;
  viewer_review_state: string | null;
  ci_status: string;
  review_decision: string | null;
  unresolved_count: number;
  needs_me_rank: number;
  greptile_confidence: number | null;
  greptile_reviewed_sha: string | null;
  greptile_unresolved_count: number;
  detail_json: string;
  fetched_at: string;
}

const upsertStmt = db.prepare(`
INSERT INTO prs (
  repo, number, state, is_draft, title, author, base_ref, head_ref, head_sha,
  updated_at, additions, deletions, changed_files, commit_count, mergeable, merge_state_status,
  auto_merge_enabled, viewer_is_author, viewer_review_requested, viewer_review_state,
  ci_status, review_decision, unresolved_count, needs_me_rank, greptile_confidence, greptile_reviewed_sha,
  greptile_unresolved_count, detail_json, fetched_at
) VALUES (
  $repo, $number, $state, $is_draft, $title, $author, $base_ref, $head_ref, $head_sha,
  $updated_at, $additions, $deletions, $changed_files, $commit_count, $mergeable, $merge_state_status,
  $auto_merge_enabled, $viewer_is_author, $viewer_review_requested, $viewer_review_state,
  $ci_status, $review_decision, $unresolved_count, $needs_me_rank, $greptile_confidence, $greptile_reviewed_sha,
  $greptile_unresolved_count, $detail_json, $fetched_at
)
ON CONFLICT (repo, number) DO UPDATE SET
  state = excluded.state,
  is_draft = excluded.is_draft,
  title = excluded.title,
  author = excluded.author,
  base_ref = excluded.base_ref,
  head_ref = excluded.head_ref,
  head_sha = excluded.head_sha,
  updated_at = excluded.updated_at,
  additions = excluded.additions,
  deletions = excluded.deletions,
  changed_files = excluded.changed_files,
  commit_count = excluded.commit_count,
  mergeable = excluded.mergeable,
  merge_state_status = excluded.merge_state_status,
  -- auto_merge_enabled deliberately absent: insert-only, cockpit-owned, see setAutoMergeArmed
  viewer_is_author = excluded.viewer_is_author,
  viewer_review_requested = excluded.viewer_review_requested,
  viewer_review_state = excluded.viewer_review_state,
  ci_status = excluded.ci_status,
  review_decision = excluded.review_decision,
  unresolved_count = excluded.unresolved_count,
  needs_me_rank = excluded.needs_me_rank,
  greptile_confidence = excluded.greptile_confidence,
  greptile_reviewed_sha = excluded.greptile_reviewed_sha,
  greptile_unresolved_count = excluded.greptile_unresolved_count,
  detail_json = excluded.detail_json,
  fetched_at = excluded.fetched_at
`);

export function upsertPr(row: PrRow): void {
  upsertStmt.run({
    $repo: row.repo,
    $number: row.number,
    $state: row.state,
    $is_draft: row.is_draft,
    $title: row.title,
    $author: row.author,
    $base_ref: row.base_ref,
    $head_ref: row.head_ref,
    $head_sha: row.head_sha,
    $updated_at: row.updated_at,
    $additions: row.additions,
    $deletions: row.deletions,
    $changed_files: row.changed_files,
    $commit_count: row.commit_count,
    $mergeable: row.mergeable,
    $merge_state_status: row.merge_state_status,
    $auto_merge_enabled: row.auto_merge_enabled,
    $viewer_is_author: row.viewer_is_author,
    $viewer_review_requested: row.viewer_review_requested,
    $viewer_review_state: row.viewer_review_state,
    $ci_status: row.ci_status,
    $review_decision: row.review_decision,
    $unresolved_count: row.unresolved_count,
    $needs_me_rank: row.needs_me_rank,
    $greptile_confidence: row.greptile_confidence,
    $greptile_reviewed_sha: row.greptile_reviewed_sha,
    $greptile_unresolved_count: row.greptile_unresolved_count,
    $detail_json: row.detail_json,
    $fetched_at: row.fetched_at,
  });
}

const getPrStmt = db.prepare<PrRow, [string, number]>(
  "SELECT * FROM prs WHERE repo = ? AND number = ?",
);

export function getPr(repo: string, number: number): PrRow | null {
  return getPrStmt.get(repo, number) ?? null;
}

const getPrByBranchStmt = db.prepare<PrRow, [string, string]>(
  "SELECT * FROM prs WHERE repo = ? AND head_ref = ? ORDER BY updated_at DESC LIMIT 1",
);

export function getPrByBranch(repo: string, branch: string): PrRow | null {
  return getPrByBranchStmt.get(repo, branch) ?? null;
}

const setAutoMergeArmedStmt = db.prepare("UPDATE prs SET auto_merge_enabled = ? WHERE repo = ? AND number = ?");

export interface RepoUserRow {
  repo: string;
  login: string;
  user_id: string;
  avatar_url: string;
  fetched_at: string;
}

const listRepoUsersStmt = db.prepare<RepoUserRow, [string]>("SELECT * FROM repo_users WHERE repo = ? ORDER BY login ASC");

export function getRepoUsers(repo: string): RepoUserRow[] {
  return listRepoUsersStmt.all(repo);
}

const insertRepoUserStmt = db.prepare(`
INSERT INTO repo_users (repo, login, user_id, avatar_url, fetched_at) VALUES ($repo, $login, $user_id, $avatar_url, $fetched_at)
ON CONFLICT (repo, login) DO UPDATE SET user_id = excluded.user_id, avatar_url = excluded.avatar_url, fetched_at = excluded.fetched_at
`);
const deleteRepoUsersStmt = db.prepare("DELETE FROM repo_users WHERE repo = ?");

// full replace per refresh - GitHub's assignableUsers list is the current truth, stale logins should drop off
const setRepoUsersTxn = db.transaction((repo: string, users: Array<{ login: string; id: string; avatarUrl: string }>, fetchedAt: string) => {
  deleteRepoUsersStmt.run(repo);
  for (const u of users) {
    insertRepoUserStmt.run({ $repo: repo, $login: u.login, $user_id: u.id, $avatar_url: u.avatarUrl, $fetched_at: fetchedAt });
  }
});

export function setRepoUsers(repo: string, users: Array<{ login: string; id: string; avatarUrl: string }>, fetchedAt: string): void {
  setRepoUsersTxn(repo, users, fetchedAt);
}

const repoUserIdStmt = db.prepare<{ user_id: string }, [string, string]>("SELECT user_id FROM repo_users WHERE repo = ? AND login = ?");

export function repoUserId(repo: string, login: string): string | null {
  return repoUserIdStmt.get(repo, login)?.user_id ?? null;
}

export interface WebhookRegistrationRow {
  window_id: string | null;
  repo: string;
  number: number;
  last_webhook_at: string | null;
}

export interface WebhookRegistrationKey {
  repo: string;
  number: number;
}

const listWebhookRegistrationsStmt = db.prepare<WebhookRegistrationRow, []>("SELECT * FROM webhook_registrations");

export function listWebhookRegistrations(): WebhookRegistrationRow[] {
  return listWebhookRegistrationsStmt.all();
}

const registrationsBoundToWindowStmt = db.prepare<WebhookRegistrationKey, { $window_id: string; $repo: string; $number: number }>(
  "SELECT repo, number FROM webhook_registrations WHERE window_id = $window_id AND NOT (repo = $repo AND number = $number)",
);
const clearOtherWebhookRegistrationsForWindowStmt = db.prepare(
  "UPDATE webhook_registrations SET window_id = NULL WHERE window_id = $window_id AND NOT (repo = $repo AND number = $number)",
);
const upsertWebhookRegistrationStmt = db.prepare(`
INSERT INTO webhook_registrations (repo, number, window_id, last_webhook_at) VALUES ($repo, $number, $window_id, NULL)
ON CONFLICT (repo, number) DO UPDATE SET
  window_id = COALESCE(excluded.window_id, webhook_registrations.window_id),
  last_webhook_at = NULL
`);
const setWebhookRegistrationTxn = db.transaction((repo: string, number: number, windowId: string | null): WebhookRegistrationKey[] => {
  const rebound = windowId
    ? registrationsBoundToWindowStmt.all({ $window_id: windowId, $repo: repo, $number: number })
    : [];
  if (windowId) clearOtherWebhookRegistrationsForWindowStmt.run({ $window_id: windowId, $repo: repo, $number: number });
  upsertWebhookRegistrationStmt.run({ $repo: repo, $number: number, $window_id: windowId });
  return rebound;
});

export function setWebhookRegistration(repo: string, number: number, windowId?: string): WebhookRegistrationKey[] {
  return setWebhookRegistrationTxn(repo, number, windowId ?? null);
}

const deleteWebhookRegistrationsForWindowStmt = db.prepare("DELETE FROM webhook_registrations WHERE window_id = ?");

export function deleteWebhookRegistrationsForWindow(windowId: string): boolean {
  return deleteWebhookRegistrationsForWindowStmt.run(windowId).changes > 0;
}

const deleteWebhookRegistrationStmt = db.prepare("DELETE FROM webhook_registrations WHERE repo = ? AND number = ?");

export function deleteWebhookRegistration(repo: string, number: number): boolean {
  return deleteWebhookRegistrationStmt.run(repo, number).changes > 0;
}

export function deleteWebhookRegistrationsForPr(repo: string, number: number): void {
  deleteWebhookRegistrationStmt.run(repo, number);
}

const touchWebhookRegistrationsStmt = db.prepare(
  "UPDATE webhook_registrations SET last_webhook_at = $last_webhook_at WHERE repo = $repo AND number = $number",
);

export function touchWebhookRegistrations(repo: string, number: number, at: string): void {
  touchWebhookRegistrationsStmt.run({ $repo: repo, $number: number, $last_webhook_at: at });
}

const recordPrWebhookActivityStmt = db.prepare(`
INSERT INTO pr_webhook_activity (repo, number, received_at) VALUES ($repo, $number, $received_at)
ON CONFLICT (repo, number) DO UPDATE SET received_at = excluded.received_at
`);

export function recordPrWebhookActivity(repo: string, number: number, receivedAt: string): void {
  recordPrWebhookActivityStmt.run({ $repo: repo, $number: number, $received_at: receivedAt });
}

const openPrNumbersForBranchStmt = db.prepare<{ number: number }, [string, string, string]>(
  "SELECT number FROM prs WHERE repo = ? AND state NOT IN ('MERGED', 'CLOSED') AND (base_ref = ? OR head_ref = ?)",
);

export function openPrNumbersForBranch(repo: string, branch: string): number[] {
  return openPrNumbersForBranchStmt.all(repo, branch, branch).map((row) => row.number);
}

export function openPrForAction(repo: string, headSha: string, headRef: string): PrRow | null {
  return db.prepare<PrRow, [string, string, string, string, string]>(`
    SELECT * FROM prs
    WHERE repo = ? AND state NOT IN ('MERGED', 'CLOSED')
      AND (head_sha = ? OR (head_sha != ? AND head_ref = ?))
    ORDER BY head_sha = ? DESC, updated_at DESC
    LIMIT 1
  `).get(repo, headSha, headSha, headRef, headSha) ?? null;
}

const lastWebhookAtForPrStmt = db.prepare<{ received_at: string }, [string, number]>(
  "SELECT received_at FROM pr_webhook_activity WHERE repo = ? AND number = ?",
);

export function lastWebhookAtForPr(repo: string, number: number): string | null {
  return lastWebhookAtForPrStmt.get(repo, number)?.received_at ?? null;
}

export interface RescoreRow {
  repo: string;
  number: number;
  reviewer: string;
  review_sha: string;
  head_sha: string;
  score: number;
  verdicts_json: string;
  created_at: string;
}

const getRescoreStmt = db.prepare<RescoreRow, [string, number, string, string, string]>(
  "SELECT * FROM review_rescores WHERE repo = ? AND number = ? AND reviewer = ? AND review_sha = ? AND head_sha = ?",
);

export function getRescoreFor(repo: string, number: number, reviewer: string, reviewSha: string, headSha: string): RescoreRow | null {
  return getRescoreStmt.get(repo, number, reviewer, reviewSha, headSha) ?? null;
}

const insertRescoreStmt = db.prepare(`
INSERT INTO review_rescores (repo, number, reviewer, review_sha, head_sha, score, verdicts_json, created_at)
VALUES ($repo, $number, $reviewer, $review_sha, $head_sha, $score, $verdicts_json, $created_at)
ON CONFLICT (repo, number, reviewer, review_sha, head_sha) DO NOTHING
`);

// a triple is scored at most once - re-running a scored triple would defeat the whole point of memoizing it
export function insertRescore(row: RescoreRow): void {
  insertRescoreStmt.run({
    $repo: row.repo,
    $number: row.number,
    $reviewer: row.reviewer,
    $review_sha: row.review_sha,
    $head_sha: row.head_sha,
    $score: row.score,
    $verdicts_json: row.verdicts_json,
    $created_at: row.created_at,
  });
}

const latestRescoreForHeadStmt = db.prepare<RescoreRow, [string, number, string]>(
  "SELECT * FROM review_rescores WHERE repo = ? AND number = ? AND head_sha = ? ORDER BY created_at DESC LIMIT 1",
);

export function latestRescoreForHead(repo: string, number: number, headSha: string): RescoreRow | null {
  return latestRescoreForHeadStmt.get(repo, number, headSha) ?? null;
}

// cockpit no longer calls GitHub's own auto-merge mutation, so this is the sole source of truth for "armed"
export function setAutoMergeArmed(repo: string, number: number, armed: boolean): void {
  setAutoMergeArmedStmt.run(armed ? 1 : 0, repo, number);
}

const countPrsStmt = db.prepare<{ count: number }, []>("SELECT COUNT(*) AS count FROM prs");

export function countPrs(): number {
  return countPrsStmt.get()!.count;
}

const listPrsStmt = db.prepare<PrRow, []>(
  "SELECT * FROM prs ORDER BY needs_me_rank ASC, updated_at DESC",
);

export function listPrs(): PrRow[] {
  return listPrsStmt.all();
}

const getDiffStmt = db.prepare<{ patch: string }, [string]>(
  "SELECT patch FROM diffs WHERE head_sha = ?",
);

export function getDiff(headSha: string): string | null {
  return getDiffStmt.get(headSha)?.patch ?? null;
}

const insertDiffStmt = db.prepare(
  "INSERT OR IGNORE INTO diffs (head_sha, patch, fetched_at) VALUES (?, ?, datetime('now'))",
);

export function saveDiff(headSha: string, patch: string): void {
  insertDiffStmt.run(headSha, patch);
}

const getFileContentsStmt = db.prepare<{ content: string }, [string, string]>(
  "SELECT content FROM file_contents WHERE sha = ? AND path = ?",
);

export function getFileContents(sha: string, path: string): string | null {
  return getFileContentsStmt.get(sha, path)?.content ?? null;
}

const saveFileContentsStmt = db.prepare(
  "INSERT OR IGNORE INTO file_contents (sha, path, content) VALUES (?, ?, ?)",
);

export function saveFileContents(sha: string, path: string, content: string): void {
  saveFileContentsStmt.run(sha, path, content);
}

export interface WorkflowRunRow {
  repo: string;
  run_id: number;
  run_attempt: number;
  pr_number: number | null;
  head_sha: string;
  head_branch: string;
  workflow_name: string;
  workflow_path: string;
  display_title: string;
  event: string;
  actor_login: string | null;
  status: string;
  conclusion: string | null;
  event_at: string;
  created_at: string | null;
  updated_at: string | null;
  run_started_at: string | null;
  run_number: number;
  html_url: string | null;
  jobs_fetched_at: string | null;
  reconciled_at: string | null;
  fetched_at: string;
}

export interface ActionWorkflowRow {
  repo: string;
  workflow_id: number;
  name: string;
  path: string;
  state: string;
  fetched_at: string;
}

export interface RunJobRow {
  repo: string;
  job_id: number;
  run_id: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string;
  workflow_name: string;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
  runner_name: string | null;
  runner_group_name: string | null;
  labels_json: string;
  failed_step: string | null;
  log_bytes: number | null;
  log_truncated: number;
  log_error: string | null;
  log_format_version: number;
  fetched_at: string;
}

const runStateRank = (status: string): number =>
  status === "completed" ? 2 : status === "in_progress" ? 1 : 0;
const jobStateRank = (status: string): number =>
  status === "completed" ? 2 : status === "in_progress" ? 1 : 0;

const getWorkflowRunStmt = db.prepare<WorkflowRunRow, [string, number, number]>(
  "SELECT * FROM workflow_runs WHERE repo = ? AND run_id = ? AND run_attempt = ?",
);
const upsertWorkflowRunStmt = db.prepare(`
  INSERT INTO workflow_runs (
    repo, run_id, run_attempt, pr_number, head_sha, head_branch, workflow_name, workflow_path,
    display_title, event, actor_login, status, conclusion, event_at, created_at, updated_at,
    run_started_at, run_number, html_url, fetched_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT (repo, run_id, run_attempt) DO UPDATE SET
    pr_number = COALESCE(excluded.pr_number, workflow_runs.pr_number),
    head_sha = excluded.head_sha, head_branch = excluded.head_branch,
    workflow_name = excluded.workflow_name, workflow_path = excluded.workflow_path,
    display_title = excluded.display_title, event = excluded.event, actor_login = excluded.actor_login,
    status = excluded.status, conclusion = excluded.conclusion, event_at = excluded.event_at,
    created_at = excluded.created_at, updated_at = excluded.updated_at,
    run_started_at = excluded.run_started_at, run_number = excluded.run_number,
    html_url = excluded.html_url, fetched_at = datetime('now')
`);

type WorkflowRunInput =
  Omit<
    WorkflowRunRow,
    | "display_title"
    | "event"
    | "actor_login"
    | "created_at"
    | "updated_at"
    | "run_started_at"
    | "run_number"
    | "jobs_fetched_at"
    | "reconciled_at"
    | "fetched_at"
  >
  & Partial<Pick<
    WorkflowRunRow,
    "display_title" | "event" | "actor_login" | "created_at" | "updated_at" | "run_started_at" | "run_number"
  >>;

export function upsertWorkflowRun(run: WorkflowRunInput): boolean {
  const latest = db.prepare<{ attempt: number | null }, [string, number]>(
    "SELECT MAX(run_attempt) AS attempt FROM workflow_runs WHERE repo = ? AND run_id = ?",
  ).get(run.repo, run.run_id)?.attempt;
  if (latest !== null && latest !== undefined && run.run_attempt < latest) return false;
  const current = getWorkflowRunStmt.get(run.repo, run.run_id, run.run_attempt);
  if (current) {
    const incomingRank = runStateRank(run.status);
    const currentRank = runStateRank(current.status);
    if (incomingRank < currentRank) return false;
    if (incomingRank === currentRank && Date.parse(run.event_at) < Date.parse(current.event_at)) return false;
  }
  db.prepare("DELETE FROM run_jobs WHERE repo = ? AND run_id = ? AND run_attempt < ?")
    .run(run.repo, run.run_id, run.run_attempt);
  upsertWorkflowRunStmt.run(
    run.repo, run.run_id, run.run_attempt, run.pr_number, run.head_sha, run.head_branch,
    run.workflow_name, run.workflow_path, run.display_title ?? run.workflow_name, run.event ?? "",
    run.actor_login ?? null, run.status, run.conclusion, run.event_at, run.created_at ?? null,
    run.updated_at ?? run.event_at, run.run_started_at ?? null, run.run_number ?? 0, run.html_url,
  );
  return true;
}

const getRunJobStmt = db.prepare<RunJobRow, [string, number]>(
  `SELECT repo, job_id, run_id, run_attempt, head_sha, head_branch, workflow_name, name,
    status, conclusion, started_at, completed_at, html_url, runner_name, runner_group_name,
    labels_json, failed_step, log_bytes, log_truncated, log_error, log_format_version, fetched_at
   FROM run_jobs WHERE repo = ? AND job_id = ?`,
);
const upsertRunJobStmt = db.prepare(`
  INSERT INTO run_jobs (
    repo, job_id, run_id, run_attempt, head_sha, head_branch, workflow_name, name,
    status, conclusion, started_at, completed_at, html_url, runner_name, runner_group_name,
    labels_json, failed_step, fetched_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT (repo, job_id) DO UPDATE SET
    run_id = excluded.run_id, run_attempt = excluded.run_attempt, head_sha = excluded.head_sha,
    head_branch = excluded.head_branch, workflow_name = excluded.workflow_name, name = excluded.name,
    status = excluded.status, conclusion = excluded.conclusion, started_at = excluded.started_at,
    completed_at = excluded.completed_at, html_url = excluded.html_url, runner_name = excluded.runner_name,
    runner_group_name = excluded.runner_group_name, labels_json = excluded.labels_json,
    failed_step = excluded.failed_step, fetched_at = datetime('now')
`);

export function upsertRunJob(job: Omit<RunJobRow, "log_bytes" | "log_truncated" | "log_error" | "log_format_version" | "fetched_at">): boolean {
  const latest = db.prepare<{ attempt: number | null }, [string, number]>(
    "SELECT MAX(run_attempt) AS attempt FROM workflow_runs WHERE repo = ? AND run_id = ?",
  ).get(job.repo, job.run_id)?.attempt;
  if (latest !== null && latest !== undefined && job.run_attempt < latest) return false;
  const current = getRunJobStmt.get(job.repo, job.job_id);
  if (current && job.run_attempt < current.run_attempt) return false;
  if (current && job.run_attempt === current.run_attempt) {
    const incomingRank = jobStateRank(job.status);
    const currentRank = jobStateRank(current.status);
    if (incomingRank < currentRank) return false;
    const incomingAt = job.completed_at ?? job.started_at;
    const currentAt = current.completed_at ?? current.started_at;
    if (incomingRank === currentRank && incomingAt !== null && currentAt !== null && Date.parse(incomingAt) < Date.parse(currentAt)) return false;
  }
  upsertRunJobStmt.run(
    job.repo, job.job_id, job.run_id, job.run_attempt, job.head_sha, job.head_branch,
    job.workflow_name, job.name, job.status, job.conclusion, job.started_at, job.completed_at,
    job.html_url, job.runner_name, job.runner_group_name, job.labels_json, job.failed_step,
  );
  return true;
}

const listRunJobsStmt = db.prepare<RunJobRow, [string, string]>(
  `SELECT j.repo, j.job_id, j.run_id, j.run_attempt, j.head_sha, j.head_branch,
    j.workflow_name, j.name, j.status, j.conclusion, j.started_at, j.completed_at,
    j.html_url, j.runner_name, j.runner_group_name, j.labels_json, j.failed_step,
    j.log_bytes, j.log_truncated, j.log_error, j.log_format_version, j.fetched_at
   FROM run_jobs j
   WHERE j.repo = ? AND j.head_sha = ?
     AND NOT EXISTS (
       SELECT 1 FROM run_jobs newer
       WHERE newer.repo = j.repo AND newer.run_id = j.run_id
         AND newer.head_sha = j.head_sha AND newer.run_attempt > j.run_attempt
     )
   ORDER BY j.completed_at DESC, j.job_id DESC`,
);

export function listRunJobs(repo: string, headSha: string): RunJobRow[] {
  return listRunJobsStmt.all(repo, headSha);
}

const getRunJobLogStmt = db.prepare<{ log_gz: Uint8Array | null }, [string, number]>(
  "SELECT log_gz FROM run_jobs WHERE repo = ? AND job_id = ?",
);

export function getRunJobLog(repo: string, jobId: number): Uint8Array | null {
  return getRunJobLogStmt.get(repo, jobId)?.log_gz ?? null;
}

const saveRunJobLogStmt = db.prepare(
  `UPDATE run_jobs SET log_gz = ?, log_bytes = ?, log_truncated = 0, log_error = NULL,
    log_format_version = ${RUN_JOB_LOG_FORMAT_VERSION}
   WHERE repo = ? AND job_id = ? AND run_id = ? AND run_attempt = ? AND head_sha = ?`,
);

export function saveRunJobLog(
  repo: string, jobId: number, runId: number, runAttempt: number, headSha: string,
  gz: Uint8Array, bytes: number,
): boolean {
  return saveRunJobLogStmt.run(gz, bytes, repo, jobId, runId, runAttempt, headSha).changes > 0;
}

const saveRunJobLogErrorStmt = db.prepare(
  "UPDATE run_jobs SET log_error = ? WHERE repo = ? AND job_id = ? AND run_attempt = ?",
);

export function saveRunJobLogError(repo: string, jobId: number, runAttempt: number, error: string): void {
  saveRunJobLogErrorStmt.run(error, repo, jobId, runAttempt);
}

export function markWorkflowRunJobsFetched(repo: string, runId: number, runAttempt: number): void {
  db.prepare("UPDATE workflow_runs SET jobs_fetched_at = datetime('now') WHERE repo = ? AND run_id = ? AND run_attempt = ?")
    .run(repo, runId, runAttempt);
}

export function markWorkflowRunReconciled(repo: string, runId: number, runAttempt: number): void {
  db.prepare("UPDATE workflow_runs SET reconciled_at = datetime('now') WHERE repo = ? AND run_id = ? AND run_attempt = ?")
    .run(repo, runId, runAttempt);
}

export function workflowRunsForLease(repo: string, number: number, headSha: string): WorkflowRunRow[] {
  return db.prepare<WorkflowRunRow, [string, number, string]>(
    "SELECT * FROM workflow_runs WHERE repo = ? AND pr_number = ? AND head_sha = ? ORDER BY run_id, run_attempt",
  ).all(repo, number, headSha);
}
export function workflowRunsForCommit(repo: string, headSha: string): WorkflowRunRow[] {
  return db.prepare<WorkflowRunRow, [string, string]>(
    "SELECT * FROM workflow_runs WHERE repo = ? AND head_sha = ? ORDER BY run_id, run_attempt",
  ).all(repo, headSha);
}
export function listWorkflowRuns(repos: string[], limit = 200, offset = 0): WorkflowRunRow[] {
  if (repos.length === 0) return [];
  const placeholders = repos.map(() => "?").join(", ");
  return db.query<WorkflowRunRow, [...string[], number, number]>(
    `SELECT * FROM workflow_runs
     WHERE repo IN (${placeholders})
     ORDER BY event_at DESC, run_id DESC, run_attempt DESC
     LIMIT ? OFFSET ?`,
  ).all(...repos, limit, offset);
}

const deleteActionWorkflowsStmt = db.prepare("DELETE FROM action_workflows WHERE repo = ?");
const insertActionWorkflowStmt = db.prepare(
  "INSERT INTO action_workflows (repo, workflow_id, name, path, state, fetched_at) VALUES (?, ?, ?, ?, ?, ?)",
);
const replaceActionWorkflowsTxn = db.transaction((
  repo: string,
  workflows: Array<{ id: number; name: string; path: string; state: string }>,
  fetchedAt: string,
) => {
  deleteActionWorkflowsStmt.run(repo);
  for (const workflow of workflows) {
    insertActionWorkflowStmt.run(repo, workflow.id, workflow.name, workflow.path, workflow.state, fetchedAt);
  }
});

export function replaceActionWorkflows(
  repo: string,
  workflows: Array<{ id: number; name: string; path: string; state: string }>,
): void {
  replaceActionWorkflowsTxn(repo, workflows, new Date().toISOString());
}

export function listActionWorkflows(repos: string[]): ActionWorkflowRow[] {
  if (repos.length === 0) return [];
  const placeholders = repos.map(() => "?").join(", ");
  return db.query<ActionWorkflowRow, string[]>(
    `SELECT * FROM action_workflows WHERE repo IN (${placeholders}) ORDER BY name COLLATE NOCASE, path`,
  ).all(...repos);
}

export function listRunJobsForRun(repo: string, runId: number, runAttempt: number): RunJobRow[] {
  return db.query<RunJobRow, [string, number, number]>(
    `SELECT repo, job_id, run_id, run_attempt, head_sha, head_branch, workflow_name, name,
      status, conclusion, started_at, completed_at, html_url, runner_name, runner_group_name,
      labels_json, failed_step, log_bytes, log_truncated, log_error, log_format_version, fetched_at
     FROM run_jobs
     WHERE repo = ? AND run_id = ? AND run_attempt = ?
     ORDER BY COALESCE(started_at, completed_at), job_id`,
  ).all(repo, runId, runAttempt);
}

export interface ActionsLeaseRow {
  repo: string;
  number: number;
  head_sha: string;
  expires_at: string;
  bootstrapped_at: string | null;
}

export function actionsLease(repo: string, number: number): ActionsLeaseRow | null {
  return db.prepare<ActionsLeaseRow, [string, number]>(
    "SELECT * FROM actions_leases WHERE repo = ? AND number = ? AND expires_at > datetime('now')",
  ).get(repo, number) ?? null;
}

export function renewActionsLease(repo: string, number: number, headSha: string): ActionsLeaseRow {
  db.prepare(`
    INSERT INTO actions_leases (repo, number, head_sha, expires_at, bootstrapped_at)
    VALUES (?, ?, ?, datetime('now', '+2 minutes'), NULL)
    ON CONFLICT (repo, number) DO UPDATE SET
      head_sha = excluded.head_sha, expires_at = excluded.expires_at,
      bootstrapped_at = CASE
        WHEN actions_leases.head_sha = excluded.head_sha AND actions_leases.expires_at > datetime('now')
        THEN actions_leases.bootstrapped_at
        ELSE NULL
      END
  `).run(repo, number, headSha);
  return actionsLease(repo, number)!;
}

export function markActionsLeaseBootstrapped(repo: string, number: number, headSha: string): void {
  db.prepare("UPDATE actions_leases SET bootstrapped_at = datetime('now') WHERE repo = ? AND number = ? AND head_sha = ?")
    .run(repo, number, headSha);
}



export interface MutationRow {
  id: number;
  repo: string;
  number: number;
  kind: string;
  payload_json: string;
  state: string;
  error: string | null;
  created_at: string;
}

const insertMutationStmt = db.prepare(`
INSERT INTO mutations (repo, number, kind, payload_json, state, error, created_at)
VALUES ($repo, $number, $kind, $payload_json, 'pending', NULL, $created_at)
`);

export function insertMutation(row: {
  repo: string;
  number: number;
  kind: string;
  payload_json: string;
  created_at: string;
}): number {
  const result = insertMutationStmt.run({
    $repo: row.repo,
    $number: row.number,
    $kind: row.kind,
    $payload_json: row.payload_json,
    $created_at: row.created_at,
  });
  return Number(result.lastInsertRowid);
}

const listMutationsForPrStmt = db.prepare<MutationRow, [string, number]>(
  "SELECT * FROM mutations WHERE repo = ? AND number = ? AND state != 'done' ORDER BY id ASC",
);

export function listMutationsForPr(repo: string, number: number): MutationRow[] {
  return listMutationsForPrStmt.all(repo, number);
}

const nextPendingMutationStmt = db.prepare<MutationRow, []>(
  "SELECT * FROM mutations WHERE state = 'pending' ORDER BY id ASC LIMIT 1",
);

export function nextPendingMutation(): MutationRow | null {
  return nextPendingMutationStmt.get() ?? null;
}

const listRefreshingMutationsStmt = db.prepare<MutationRow, []>(
  "SELECT * FROM mutations WHERE state = 'refreshing' ORDER BY id ASC",
);

export function listRefreshingMutations(): MutationRow[] {
  return listRefreshingMutationsStmt.all();
}

const setMutationStateStmt = db.prepare(
  "UPDATE mutations SET state = $state, error = $error WHERE id = $id",
);

export function setMutationState(id: number, state: string, error: string | null): void {
  setMutationStateStmt.run({ $id: id, $state: state, $error: error });
}

const deleteMutationStmt = db.prepare("DELETE FROM mutations WHERE id = ?");

export function deleteMutation(id: number): void {
  deleteMutationStmt.run(id);
}

export function failInterruptedMutations(): void {
  db.prepare("UPDATE mutations SET state = 'failed', error = 'interrupted' WHERE state = 'pending'").run();
}

export interface PrIndexRow {
  repo: string;
  number: number;
  title: string;
  state: string;
  is_draft: number;
  author: string;
  updated_at: string;
  merged_at: string | null;
  closed_at: string | null;
  involves_me: number;
}

const upsertPrIndexStmt = db.prepare(`
INSERT INTO pr_index (
  repo, number, title, state, is_draft, author, updated_at, merged_at, closed_at, involves_me
)
VALUES (
  $repo, $number, $title, $state, $is_draft, $author, $updated_at, $merged_at, $closed_at, $involves_me
)
ON CONFLICT (repo, number) DO UPDATE SET
  title = excluded.title,
  state = excluded.state,
  is_draft = excluded.is_draft,
  author = excluded.author,
  updated_at = excluded.updated_at,
  merged_at = COALESCE(excluded.merged_at, pr_index.merged_at),
  closed_at = COALESCE(excluded.closed_at, pr_index.closed_at),
  involves_me = MAX(pr_index.involves_me, excluded.involves_me)
`);

const upsertPrIndexTxn = db.transaction((entries: PrIndexEntry[]) => {
  for (const entry of entries) {
    upsertPrIndexStmt.run({
      $repo: entry.repo,
      $number: entry.number,
      $title: entry.title,
      $state: entry.state,
      $is_draft: entry.isDraft ? 1 : 0,
      $author: entry.author,
      $updated_at: entry.updatedAt,
      $merged_at: entry.mergedAt ?? null,
      $closed_at: entry.closedAt ?? null,
      $involves_me: entry.involvesMe ? 1 : 0,
    });
  }
});

export function upsertPrIndex(entries: PrIndexEntry[]): void {
  upsertPrIndexTxn(entries);
}

const listPrIndexStmt = db.prepare<PrIndexRow, []>(
  "SELECT * FROM pr_index ORDER BY updated_at DESC",
);

export function listPrIndex(): PrIndexRow[] {
  return listPrIndexStmt.all();
}

const listClosedPrsStmt = db.prepare<PrIndexRow, [number]>(`
SELECT *
FROM pr_index
WHERE state IN ('MERGED', 'CLOSED') AND involves_me = 1
ORDER BY COALESCE(merged_at, closed_at, updated_at) DESC
LIMIT ?
`);

export function listClosedPrs(limit: number): PrIndexRow[] {
  return listClosedPrsStmt.all(limit);
}

const getSettingStmt = db.prepare<{ value: string }, [string]>(
  "SELECT value FROM settings WHERE key = ?",
);

export function getSetting(key: string): string | null {
  return getSettingStmt.get(key)?.value ?? null;
}

const setSettingStmt = db.prepare(
  "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
);

export function setSetting(key: string, value: string): void {
  setSettingStmt.run(key, value);
}

function preservePrDetails(whereSql: string, params: Array<string | number>): void {
  db.prepare(`
    INSERT INTO pr_detail_cache (repo, number, head_sha, detail_json, fetched_at)
    SELECT repo, number, head_sha, detail_json, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')
    FROM prs
    WHERE ${whereSql}
    ON CONFLICT (repo, number) DO UPDATE SET
      head_sha = excluded.head_sha,
      detail_json = excluded.detail_json,
      fetched_at = excluded.fetched_at
  `).run(...params);
}

const evictReposNotInTxn = db.transaction((repos: string[]) => {
  const placeholders = repos.map(() => "?").join(",");
  const whereSql = `repo NOT IN (${placeholders})`;
  preservePrDetails(whereSql, repos);
  db.prepare(`DELETE FROM prs WHERE ${whereSql}`).run(...repos);
});

export function evictReposNotIn(repos: string[]): void {
  if (repos.length === 0) return;
  evictReposNotInTxn(repos);
}

const distinctPrReposStmt = db.prepare<{ repo: string }, []>("SELECT DISTINCT repo FROM prs");

export function distinctPrRepos(): string[] {
  return distinctPrReposStmt.all().map((row) => row.repo);
}

const evictStalePrsTxn = db.transaction((repo: string, keepNumbers: number[]) => {
  const params: Array<string | number> = [repo, ...keepNumbers];
  const whereSql = keepNumbers.length === 0
    ? "repo = ?"
    : `repo = ? AND number NOT IN (${keepNumbers.map(() => "?").join(",")})`;
  preservePrDetails(whereSql, params);
  db.prepare(`DELETE FROM prs WHERE ${whereSql}`).run(...params);
});

export function evictStalePrs(repo: string, keepNumbers: number[]): void {
  evictStalePrsTxn(repo, keepNumbers);
}

const setArchivedStmt = db.prepare(`
INSERT INTO archived_prs (repo, number, archived_at) VALUES ($repo, $number, $archived_at)
ON CONFLICT (repo, number) DO UPDATE SET archived_at = excluded.archived_at
`);

const unsetArchivedStmt = db.prepare("DELETE FROM archived_prs WHERE repo = ? AND number = ?");

export function setArchived(repo: string, number: number, archived: boolean): void {
  if (archived) {
    setArchivedStmt.run({ $repo: repo, $number: number, $archived_at: new Date().toISOString() });
  } else {
    unsetArchivedStmt.run(repo, number);
  }
}

const archivedKeysStmt = db.prepare<{ repo: string; number: number }, []>(
  "SELECT repo, number FROM archived_prs",
);

export function listArchivedKeys(): Set<string> {
  return new Set(archivedKeysStmt.all().map(prKey));
}

const setRankStmt = db.prepare(`
INSERT INTO pr_rank (repo, number, position) VALUES ($repo, $number, $position)
ON CONFLICT (repo, number) DO UPDATE SET position = excluded.position
`);

const unsetRankStmt = db.prepare("DELETE FROM pr_rank WHERE repo = ? AND number = ?");

export function setRank(repo: string, number: number, position: number): void {
  setRankStmt.run({ $repo: repo, $number: number, $position: position });
}

export function unsetRank(repo: string, number: number): void {
  unsetRankStmt.run(repo, number);
}

const ranksStmt = db.prepare<{ repo: string; number: number; position: number }, []>(
  "SELECT repo, number, position FROM pr_rank",
);

export function getRanks(): Map<string, number> {
  return new Map(ranksStmt.all().map((r) => [prKey(r), r.position]));
}

export interface CachedPrDetailRow {
  repo: string;
  number: number;
  head_sha: string;
  detail_json: string;
  fetched_at: string;
}

const upsertCachedPrDetailStmt = db.prepare(`
INSERT INTO pr_detail_cache (repo, number, head_sha, detail_json, fetched_at)
VALUES ($repo, $number, $head_sha, $detail_json, $fetched_at)
ON CONFLICT (repo, number) DO UPDATE SET
  head_sha = excluded.head_sha,
  detail_json = excluded.detail_json,
  fetched_at = excluded.fetched_at
`);

export function upsertCachedPrDetail(row: CachedPrDetailRow): void {
  upsertCachedPrDetailStmt.run({
    $repo: row.repo,
    $number: row.number,
    $head_sha: row.head_sha,
    $detail_json: row.detail_json,
    $fetched_at: row.fetched_at,
  });
}

const getCachedPrDetailStmt = db.prepare<CachedPrDetailRow, [string, number]>(
  "SELECT * FROM pr_detail_cache WHERE repo = ? AND number = ?",
);

export function getCachedPrDetail(repo: string, number: number): CachedPrDetailRow | null {
  return getCachedPrDetailStmt.get(repo, number) ?? null;
}

const upsertMergedPrAnalyticsStmt = db.prepare(`
INSERT INTO merged_pr_analytics_cache (repo, base, payload_json, fetched_at)
VALUES ($repo, $base, $payload_json, $fetched_at)
ON CONFLICT (repo, base) DO UPDATE SET
  payload_json = excluded.payload_json,
  fetched_at = excluded.fetched_at
`);

export function upsertMergedPrAnalyticsCache(repo: string, base: string, payloadJson: string, fetchedAt: string): void {
  upsertMergedPrAnalyticsStmt.run({ $repo: repo, $base: base, $payload_json: payloadJson, $fetched_at: fetchedAt });
}

const getMergedPrAnalyticsStmt = db.prepare<{ payload_json: string; fetched_at: string }, [string, string]>(
  "SELECT payload_json, fetched_at FROM merged_pr_analytics_cache WHERE repo = ? AND base = ?",
);

export function getMergedPrAnalyticsCache(repo: string, base: string): { payload_json: string; fetched_at: string } | null {
  return getMergedPrAnalyticsStmt.get(repo, base) ?? null;
}

const insertGithubGraphqlUsageStmt = db.prepare(`
INSERT INTO github_graphql_usage (
  occurred_at, machine, source, operation, cost, used, remaining, reset_at, status
) VALUES (
  $occurred_at, $machine, $source, $operation, $cost, $used, $remaining, $reset_at, $status
)`);
const pruneGithubGraphqlUsageStmt = db.prepare(
  "DELETE FROM github_graphql_usage WHERE julianday(occurred_at) < julianday('now', '-7 days')",
);
let lastGithubUsagePruneAt = 0;
const githubUsageTrackingStartedAt = new Date().toISOString();

setGithubGraphqlUsageRecorder((event: GithubGraphqlUsageEvent) => {
  const now = Date.now();
  if (now - lastGithubUsagePruneAt >= 60 * 60_000) {
    pruneGithubGraphqlUsageStmt.run();
    lastGithubUsagePruneAt = now;
  }
  insertGithubGraphqlUsageStmt.run({
    $occurred_at: event.occurredAt,
    $machine: hostname(),
    $source: event.source,
    $operation: event.operation,
    $cost: event.cost,
    $used: event.used,
    $remaining: event.remaining,
    $reset_at: event.resetAt ? new Date(event.resetAt).toISOString() : null,
    $status: event.status,
  });
});

interface GithubUsageRow {
  label: string;
  points: number;
  requests: number;
  unknown_cost_requests: number;
}

export interface GithubGraphqlUsageSummary {
  machine: string;
  recordedSince: string | null;
  localPoints: number;
  localRequests: number;
  unknownCostRequests: number;
  otherPoints: number | null;
  windowComplete: boolean;
  windowStartedAt: string;
  sources: Array<{ source: string; points: number; requests: number; unknownCostRequests: number }>;
  operations: Array<{ operation: string; points: number; requests: number; unknownCostRequests: number }>;
  history: Array<{
    resetAt: string;
    used: number | null;
    localPoints: number;
    localRequests: number;
    unknownCostRequests: number;
  }>;
  predictedUsed: number | null;
}

function githubUsageRows(column: "source" | "operation", resetAt: string): GithubUsageRow[] {
  return db.query<GithubUsageRow, [string]>(`
    SELECT ${column} AS label,
      COALESCE(SUM(cost), 0) AS points,
      COUNT(*) AS requests,
      SUM(cost IS NULL) AS unknown_cost_requests
    FROM github_graphql_usage
    WHERE julianday(reset_at) = julianday(?)
    GROUP BY ${column}
    ORDER BY points DESC, requests DESC, label
  `).all(resetAt);
}

interface GithubUsageHistoryRow {
  reset_at: string;
  used: number | null;
  local_points: number;
  local_requests: number;
  unknown_cost_requests: number;
}

function githubUsageHistory(globalUsed: number, resetAt: string): GithubGraphqlUsageSummary["history"] {
  const resetMs = Date.parse(resetAt);
  const hourMs = 60 * 60_000;
  const rows = db.query<GithubUsageHistoryRow, [string]>(`
    SELECT reset_at,
      MAX(used) AS used,
      COALESCE(SUM(cost), 0) AS local_points,
      COUNT(*) AS local_requests,
      SUM(cost IS NULL) AS unknown_cost_requests
    FROM github_graphql_usage
    WHERE julianday(reset_at) > julianday(?)
    GROUP BY reset_at
  `).all(new Date(resetMs - 72 * hourMs).toISOString());
  const byReset = new Map(rows.map((row) => [Date.parse(row.reset_at), row]));
  return Array.from({ length: 72 }, (_, index) => {
    const bucketResetMs = resetMs - (71 - index) * hourMs;
    const row = byReset.get(bucketResetMs);
    return {
      resetAt: new Date(bucketResetMs).toISOString(),
      used: bucketResetMs === resetMs ? globalUsed : row?.used ?? null,
      localPoints: row?.local_points ?? 0,
      localRequests: row?.local_requests ?? 0,
      unknownCostRequests: row?.unknown_cost_requests ?? 0,
    };
  });
}

export function predictGithubHourlyUsage(
  used: number,
  limit: number,
  windowStartedAt: string,
  nowMs = Date.now(),
): number | null {
  const elapsedMs = nowMs - Date.parse(windowStartedAt);
  if (used <= 0 || elapsedMs < 5 * 60_000) return null;
  return Math.min(limit, Math.round(used * 60 * 60_000 / Math.min(elapsedMs, 60 * 60_000)));
}


export function githubGraphqlUsage(globalUsed: number, globalLimit: number, resetAt: string, nowMs = Date.now()): GithubGraphqlUsageSummary {
  const sources = githubUsageRows("source", resetAt);
  const operations = githubUsageRows("operation", resetAt);
  const localPoints = sources.reduce((sum, row) => sum + row.points, 0);
  const localRequests = sources.reduce((sum, row) => sum + row.requests, 0);
  const unknownCostRequests = sources.reduce((sum, row) => sum + row.unknown_cost_requests, 0);
  const first = db.query<{ occurred_at: string | null }, [string]>(
    "SELECT MIN(occurred_at) AS occurred_at FROM github_graphql_usage WHERE julianday(reset_at) = julianday(?)",
  ).get(resetAt);
  const windowStartedAt = new Date(Date.parse(resetAt) - 60 * 60_000).toISOString();
  const windowComplete = Date.parse(githubUsageTrackingStartedAt) <= Date.parse(windowStartedAt)
    && unknownCostRequests === 0;
  return {
    machine: hostname(),
    recordedSince: first?.occurred_at ?? null,
    localPoints,
    localRequests,
    unknownCostRequests,
    otherPoints: windowComplete ? Math.max(0, globalUsed - localPoints) : null,
    windowComplete,
    windowStartedAt,
    sources: sources.map((row) => ({
      source: row.label,
      points: row.points,
      requests: row.requests,
      unknownCostRequests: row.unknown_cost_requests,
    })),
    operations: operations.map((row) => ({
      operation: row.label,
      points: row.points,
      requests: row.requests,
      unknownCostRequests: row.unknown_cost_requests,
    })),
    history: githubUsageHistory(globalUsed, resetAt),
    predictedUsed: predictGithubHourlyUsage(globalUsed, globalLimit, windowStartedAt, nowMs),
  };
}

const REPLICA_TABLES = [
  "prs",
  "archived_prs",
  "pr_index",
  "pr_rank",
  "repo_users",
  "review_rescores",
  "review_scores",
  "fixer_agents",
] as const;

export type InboxReplica = Record<(typeof REPLICA_TABLES)[number], Array<Record<string, unknown>>>;

export function readInboxReplica(): InboxReplica {
  return Object.fromEntries(REPLICA_TABLES.map((table) => [table, db.query(`SELECT * FROM ${table}`).all()])) as InboxReplica;
}

function replicaBinding(value: unknown): SQLQueryBindings {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return value;
  }
  throw new Error(`Unsupported replica value: ${typeof value}`);
}

const replaceInboxReplicaTxn = db.transaction((snapshot: InboxReplica) => {
  for (const table of REPLICA_TABLES) {
    const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((column) => column.name);
    const insert = db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`);
    db.exec(`DELETE FROM ${table}`);
    for (const row of snapshot[table]) insert.run(...columns.map((column) => replicaBinding(row[column] ?? null)));
  }
});

export function replaceInboxReplica(snapshot: InboxReplica): void {
  replaceInboxReplicaTxn(snapshot);
}
