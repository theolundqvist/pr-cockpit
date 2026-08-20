import { db } from "./db.ts";
import { mergePullRequest, RestRequestError } from "./github.ts";
import { forceMergeEnabled } from "./settings.ts";

export type MergeMethod = "merge" | "squash" | "rebase";
export type MergeMethodSource = "explicit" | "learned" | "default";
const ALL_METHODS: readonly MergeMethod[] = ["squash", "merge", "rebase"];

export function isMergeMethod(value: unknown): value is MergeMethod {
  return value === "merge" || value === "squash" || value === "rebase";
}

export function isMergeMethodSource(value: unknown): value is MergeMethodSource {
  return value === "explicit" || value === "learned" || value === "default";
}

// merge_state_status values GitHub still offers merge for: UNSTABLE means only
// non-required checks are failing or pending, HAS_HOOKS means pre-receive hooks exist
export const MERGEABLE_NOW_STATES = new Set(["CLEAN", "UNSTABLE", "HAS_HOOKS"]);

// the one merge-now policy shared by the mutation path and the fixer supervisor:
// GitHub offers merge, or the only blocker is a bypassable rule on a force-merge repo
export function mergeAllowedNow(repo: string, pr: { merge_state_status: string }): boolean {
  return MERGEABLE_NOW_STATES.has(pr.merge_state_status) ||
    (forceMergeEnabled(repo) && pr.merge_state_status === "BLOCKED");
}

type MergeMethodRow = { method: string; source: string };
const getMethodStmt = db.prepare<MergeMethodRow, [string, string]>(
  "SELECT method, source FROM merge_methods WHERE repo = ? AND base_ref = ?",
);
const learnMethodStmt = db.prepare(`
  INSERT INTO merge_methods (repo, base_ref, method, learned_at, source) VALUES (?, ?, ?, ?, 'learned')
  ON CONFLICT (repo, base_ref) DO UPDATE SET
    method = excluded.method,
    learned_at = excluded.learned_at,
    source = 'learned'
  WHERE merge_methods.source != 'explicit'
`);
const setPreferenceStmt = db.prepare(`
  INSERT INTO merge_methods (repo, base_ref, method, learned_at, source) VALUES (?, ?, ?, ?, 'explicit')
  ON CONFLICT (repo, base_ref) DO UPDATE SET
    method = excluded.method,
    learned_at = excluded.learned_at,
    source = 'explicit'
`);

// GitHub has no readable per-branch "required merge method" - repo settings are
// repo-wide and ruleset reads need admin scopes - so the only universal source of
// truth is GitHub rejecting a method at merge time. Default to squash, learn the
// accepted method per repo:base from those rejections, persist forever.
export function mergeMethodFor(repo: string, baseRef: string): MergeMethod {
  const stored = getMethodStmt.get(repo, baseRef)?.method;
  return isMergeMethod(stored) ? stored : "squash";
}

export function mergeMethodSourceFor(repo: string, baseRef: string): MergeMethodSource {
  const source = getMethodStmt.get(repo, baseRef)?.source;
  return source === "explicit" || source === "learned" ? source : "default";
}

export function learnMergeMethod(repo: string, baseRef: string, method: MergeMethod): void {
  learnMethodStmt.run(repo, baseRef, method, new Date().toISOString());
}

export function setMergeMethodPreference(repo: string, baseRef: string, method: MergeMethod): void {
  setPreferenceStmt.run(repo, baseRef, method, new Date().toISOString());
}

// Method-rejection bodies from PUT /pulls/{n}/merge (405 from repo settings; the
// ruleset variant is documented as "Merge is not an allowed merge method" and may
// arrive as 422 like other ruleset violations, so accept either status):
//   "Squash merges are not allowed on this repository."
//   "Merge commits are not allowed on this repository."
//   "Rebase merges are not allowed on this repository."
export function isMethodNotAllowedError(err: unknown): boolean {
  return err instanceof RestRequestError && (err.status === 405 || err.status === 422) &&
    /is not an allowed merge method|(?:merge commits|squash merges|rebase merges) are not allowed/i.test(err.message);
}

// The single merge executor. An unlearned repo:base walks squash -> merge -> rebase,
// moving past a failure only when GitHub explicitly rejected the METHOD - any other
// error (not mergeable, protection, SHA drift) propagates untouched - and persists a
// method only when the walk had to move off the default. A learned method is a
// history contract: if GitHub later rejects it (settings changed), the failure
// surfaces for a human instead of silently switching merge semantics.
async function mergeUnlearned(
  repo: string,
  number: number,
  baseRef: string,
  sha: string | undefined,
  merge: typeof mergePullRequest,
): Promise<void> {
  for (let i = 0; i < ALL_METHODS.length; i++) {
    const method = ALL_METHODS[i]!;
    try {
      await merge(repo, number, method, sha);
      if (i > 0) learnMergeMethod(repo, baseRef, method);
      return;
    } catch (err) {
      if (!isMethodNotAllowedError(err) || i === ALL_METHODS.length - 1) throw err;
    }
  }
}

export async function mergeWithSelection(
  repo: string,
  number: number,
  baseRef: string,
  method: MergeMethod,
  source: MergeMethodSource,
  sha?: string,
  merge: typeof mergePullRequest = mergePullRequest,
): Promise<void> {
  if (source === "default") return mergeUnlearned(repo, number, baseRef, sha, merge);
  await merge(repo, number, method, sha);
}

export async function mergeWithLearning(
  repo: string,
  number: number,
  baseRef: string,
  sha?: string,
  merge: typeof mergePullRequest = mergePullRequest,
): Promise<void> {
  const learned = getMethodStmt.get(repo, baseRef)?.method;
  if (isMergeMethod(learned)) {
    await merge(repo, number, learned, sha);
    return;
  }
  await mergeUnlearned(repo, number, baseRef, sha, merge);
}
