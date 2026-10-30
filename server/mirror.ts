import type { Stats } from "node:fs";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { lstat, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghToken } from "./github.ts";
import { excludedPath } from "../shared/reviewFiles.js";

const dataDir = Bun.env.COCKPIT_DATA_DIR ?? "data";
const mirrorsRoot = `${dataDir}/mirrors`;
const worktreesRoot = `${dataDir}/worktrees`;
const askpassPath = `${mirrorsRoot}/.askpass.sh`;

function mirrorDirName(repo: string): string {
  return repo.replaceAll("/", "__");
}

export function mirrorDir(repo: string): string {
  const entry = mirrorDirName(repo);
  if (deletingMirrors.has(entry)) throw new Error(`mirror cache eviction is in progress for ${repo}`);
  touch(repo);
  return `${mirrorsRoot}/${entry}`;
}

export function prWorktreeDir(repo: string, number: number): string {
  return `${worktreesRoot}/${mirrorDirName(repo)}/pr-${number}`;
}

function ensureAskpass(): void {
  mkdirSync(mirrorsRoot, { recursive: true });
  writeFileSync(askpassPath, '#!/bin/sh\ncase "$1" in\n  Username*) echo "x-access-token" ;;\n  *) echo "$GIT_MIRROR_TOKEN" ;;\nesac\n');
  chmodSync(askpassPath, 0o700);
}

async function git(
  args: string[],
  priorityCommand: string[] = [],
  input?: string,
  env?: Record<string, string>,
): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([...priorityCommand, "git", ...args], {
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
    env: env === undefined ? undefined : { ...Bun.env, ...env },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, exitCode, stdout, stderr };
}

const MIRROR_STALL_SECONDS = 60;

function githubRemote(repo: string): string {
  return `https://github.com/${repo}.git`;
}

async function authedGit(repo: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  ensureAskpass();
  const token = await ghToken();
  const remote = githubRemote(repo);
  const proc = Bun.spawn([
    "git",
    // The mirror authenticates with Cockpit's token over HTTPS. An ambient credential helper answers before
    // GIT_ASKPASS with whatever it stores for github.com (and would store Cockpit's token in turn), and a user's
    // url.*.insteadOf can reroute the remote over SSH. The empty helper resets the helper list; the exact-URL
    // rewrite outranks any shorter user rewrite.
    "-c",
    "credential.helper=",
    "-c",
    `url.${remote}.insteadOf=${remote}`,
    ...args,
  ], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Bun.env,
      GIT_ASKPASS: askpassPath,
      GIT_MIRROR_TOKEN: token,
      GIT_TERMINAL_PROMPT: "0",
      // No fetch carries a deadline, and a transfer whose socket died in sleep never ends:
      // the in-flight fetch every later diff request joins would then stay stale until restart.
      // Abort only a transfer that moved no bytes for a minute, so slow large clones still finish.
      GIT_HTTP_LOW_SPEED_LIMIT: "1",
      GIT_HTTP_LOW_SPEED_TIME: String(MIRROR_STALL_SECONDS),
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, stdout, stderr };
}

export type MirrorFetchFailureKind = "credentials" | "network" | "deadline" | "git";

export class MirrorFetchError extends Error {
  constructor(message: string, readonly kind: MirrorFetchFailureKind) {
    super(message);
  }
}

function mirrorFetchError(operation: "clone" | "fetch", repo: string, result: { stderr: string }): MirrorFetchError {
  if (/Invalid username or password|Invalid username or token|Authentication failed/i.test(result.stderr)) {
    return new MirrorFetchError(`GitHub rejected mirror credentials for ${repo}`, "credentials");
  }
  const detail = result.stderr
    .trim()
    .replace(/https:\/\/[^/@\s]+@/g, "https://[redacted]@")
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+\b/g, "[redacted]")
    .slice(0, 1024);
  const kind = /Could not resolve host|Failed to connect|Connection (?:timed out|reset)|network is unreachable|TLS connection|SSL_connect|remote end hung up|early EOF|Operation too slow/i.test(result.stderr)
    ? "network"
    : "git";
  return new MirrorFetchError(`mirror ${operation} failed for ${repo}${detail ? `: ${detail}` : ""}`, kind);
}

const FETCH_REFSPECS = ["+refs/heads/*:refs/heads/*", "+refs/pull/*/head:refs/remotes/origin/pr/*"];

async function ensureMirror(repo: string): Promise<void> {
  const dir = mirrorDir(repo);
  if (await Bun.file(`${dir}/HEAD`).exists()) return;
  mkdirSync(mirrorsRoot, { recursive: true });
  const clone = await authedGit(repo, ["clone", "--bare", githubRemote(repo), dir]);
  if (!clone.ok) throw mirrorFetchError("clone", repo, clone);
}

const inFlightFetch = new Map<string, Promise<void>>();
const activeOperations = new Map<string, number>();
const mutationTails = new Map<string, Promise<void>>();
const deletingMirrors = new Set<string>();
const deletionWaits = new Map<string, Promise<void>>();
const deletionReleases = new Map<string, () => void>();
const lastUsedAt = new Map<string, number>();
const lastUsePersistedAt = new Map<string, number>();
const RECENT_USE_WINDOW_MS = 10 * 60_000;
const LAST_USED_MARKER = ".cockpit-last-used";
const LAST_USED_PERSIST_INTERVAL_MS = 60_000;
const MAX_PACKS_BEFORE_MAINTENANCE = 50;
const MIRROR_CACHE_TARGET_BYTES = 20 * 1024 * 1024 * 1024;

function missingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function touch(repo: string): void {
  const entry = mirrorDirName(repo);
  const now = Date.now();
  lastUsedAt.set(entry, now);
  let persistedAt = lastUsePersistedAt.get(entry);
  if (persistedAt === undefined) {
    try {
      persistedAt = statSync(`${mirrorsRoot}/${entry}/${LAST_USED_MARKER}`).mtimeMs;
      lastUsePersistedAt.set(entry, persistedAt);
    } catch (error) {
      if (!missingPath(error)) throw error;
    }
  }
  if (persistedAt !== undefined && now - persistedAt < LAST_USED_PERSIST_INTERVAL_MS) return;
  try {
    writeFileSync(`${mirrorsRoot}/${entry}/${LAST_USED_MARKER}`, `${now}\n`);
    lastUsePersistedAt.set(entry, now);
  } catch (error) {
    if (!missingPath(error)) throw error;
  }
}

export async function withMirrorOperation<T>(repo: string, operation: () => Promise<T>): Promise<T> {
  const entry = mirrorDirName(repo);
  let deletion = deletionWaits.get(entry);
  while (deletion) {
    await deletion;
    deletion = deletionWaits.get(entry);
  }
  touch(repo);
  activeOperations.set(entry, (activeOperations.get(entry) ?? 0) + 1);
  try {
    return await operation();
  } finally {
    const remaining = (activeOperations.get(entry) ?? 1) - 1;
    if (remaining === 0) activeOperations.delete(entry);
    else activeOperations.set(entry, remaining);
    touch(repo);
  }
}

let maintenanceQueue = Promise.resolve();

async function maintainMirror(repo: string): Promise<void> {
  const dir = mirrorDir(repo);
  let packs = 0;
  try {
    packs = (await readdir(`${dir}/objects/pack`)).filter((name) => name.endsWith(".pack")).length;
  } catch (error) {
    if (!missingPath(error)) throw error;
  }
  if (packs <= MAX_PACKS_BEFORE_MAINTENANCE) return;

  const previous = maintenanceQueue;
  const { promise, resolve: release } = Promise.withResolvers<void>();
  maintenanceQueue = promise;
  await previous;
  try {
    const priorityCommand = [
      ...(Bun.which("ionice") ? ["ionice", "-c", "3"] : []),
      ...(Bun.which("nice") ? ["nice", "-n", "10"] : []),
    ];
    const result = await git([
      "-c",
      "pack.threads=1",
      "-c",
      "pack.windowMemory=256m",
      "-c",
      "pack.deltaCacheSize=64m",
      "--git-dir",
      dir,
      "maintenance",
      "run",
      "--task=gc",
    ], priorityCommand);
    if (!result.ok) {
      throw new MirrorFetchError(`mirror maintenance failed for ${repo}: ${result.stderr.trim() || `git exited ${result.exitCode}`}`, "git");
    }
  } finally {
    release();
  }
}

// Bounds how long an in-request caller waits; the fetch itself always runs to completion. Killing git inside
// its ref transaction orphans refs/**/*.lock, after which every fetch of that mirror fails with "cannot lock
// ref ... File exists", and unbounded callers that joined the fetch still need its result. Git's low-speed
// limit aborts a dead transfer instead.
export const INCREMENTAL_FETCH_TIMEOUT_MS = 15_000;

async function waitForFetch(fetch: Promise<void>, ms: number): Promise<void> {
  const { promise: timeout, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new MirrorFetchError(`mirror fetch wait exceeded ${ms}ms`, "deadline")), ms);
  try {
    await Promise.race([fetch, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function fetchMirror(repo: string, timeoutMs?: number): Promise<void> {
  touch(repo);
  const existing = inFlightFetch.get(repo);
  if (existing) {
    return timeoutMs !== undefined ? waitForFetch(existing, timeoutMs) : existing;
  }

  const entry = mirrorDirName(repo);
  const previousMutation = mutationTails.get(entry) ?? Promise.resolve();
  const fetched = withMirrorOperation(repo, async () => {
    await previousMutation;
    await ensureMirror(repo);
    touch(repo);
    const dir = mirrorDir(repo);
    const result = await authedGit(repo, ["--git-dir", dir, "fetch", "--no-auto-maintenance", "--prune", "origin", ...FETCH_REFSPECS]);
    if (!result.ok) throw mirrorFetchError("fetch", repo, result);
  });
  const ready = fetched.finally(() => inFlightFetch.delete(repo));
  inFlightFetch.set(repo, ready);

  const mutationTail = ready.then(
    async () => {
      try {
        await withMirrorOperation(repo, () => maintainMirror(repo));
      } catch (error) {
        console.error(`mirror maintenance failed for ${repo}:`, error);
      }
    },
    () => {},
  );
  mutationTails.set(entry, mutationTail);
  void mutationTail.finally(() => {
    if (mutationTails.get(entry) === mutationTail) mutationTails.delete(entry);
  });

  return timeoutMs !== undefined ? waitForFetch(ready, timeoutMs) : ready;
}

const inFlightWorktrees = new Map<string, Promise<string>>();

function recordMaterializedHead(marker: string, repo: string, number: number, sha: string): void {
  try {
    writeFileSync(marker, `${sha}\n`);
  } catch (err) {
    throw new Error(`PR worktree marker update failed for ${repo}#${number}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function materializePrWorktree(repo: string, number: number, sha: string): Promise<string> {
  const key = `${repo}#${number}`;
  const existing = inFlightWorktrees.get(key);
  if (existing) {
    return existing.then(
      () => materializePrWorktree(repo, number, sha),
      () => materializePrWorktree(repo, number, sha),
    );
  }
  const promise = withMirrorOperation(repo, async () => {
    const gitDir = mirrorDir(repo);
    if (!(await commitExists(gitDir, sha))) {
      await fetchMirror(repo, INCREMENTAL_FETCH_TIMEOUT_MS);
    }
    if (!(await commitExists(gitDir, sha))) {
      throw new Error(`cache fetch failed for ${repo}: PR head ${sha} is unavailable`);
    }

    const parent = `${worktreesRoot}/${mirrorDirName(repo)}`;
    const dir = prWorktreeDir(repo, number);
    const marker = `${parent}/.pr-${number}.head`;
    if (await Bun.file(`${dir}/.git`).exists()) {
      const head = await git(["-C", dir, "rev-parse", "HEAD"]);
      if (!head.ok) throw new Error(`PR worktree inspection failed for ${repo}#${number}: ${head.stderr.trim()}`);
      const currentHead = head.stdout.trim();
      if (currentHead === sha) {
        recordMaterializedHead(marker, repo, number, sha);
        return dir;
      }
      let materializedHead: string;
      try {
        materializedHead = (await Bun.file(marker).text()).trim();
      } catch {
        throw new Error(`PR worktree update failed for ${repo}#${number}: materialized-head marker is missing`);
      }
      if (currentHead !== materializedHead) {
        throw new Error(`PR worktree update failed for ${repo}#${number}: ${dir} has commits not present at the last materialized head`);
      }
      const status = await git(["-C", dir, "status", "--porcelain", "--untracked-files=all", "--ignored=matching"]);
      if (!status.ok) throw new Error(`PR worktree inspection failed for ${repo}#${number}: ${status.stderr.trim()}`);
      if (status.stdout.trim()) {
        throw new Error(`PR worktree update failed for ${repo}#${number}: ${dir} has uncommitted changes`);
      }
      const checkout = await git(["-C", dir, "checkout", "--detach", sha]);
      if (!checkout.ok) throw new Error(`PR worktree update failed for ${repo}#${number}: ${checkout.stderr.trim()}`);
      recordMaterializedHead(marker, repo, number, sha);
      return dir;
    }

    mkdirSync(parent, { recursive: true });
    const added = await git(["--git-dir", gitDir, "worktree", "add", "--detach", dir, sha]);
    if (!added.ok) throw new Error(`PR worktree creation failed for ${repo}#${number}: ${added.stderr.trim()}`);
    recordMaterializedHead(marker, repo, number, sha);
    return dir;
  }).finally(() => inFlightWorktrees.delete(key));
  inFlightWorktrees.set(key, promise);
  return promise;
}

// Checkouts exist to prewarm the external editor. A closed or unknown PR keeps its checkout
// for a day after last use and an open one for a week, so repeat edits stay instant while
// the cache stays bounded: each checkout of a large repository is a full working tree.
export const CLOSED_PR_WORKTREE_IDLE_MS = 24 * 60 * 60_000;
export const OPEN_PR_WORKTREE_IDLE_MS = 7 * 24 * 60 * 60_000;

export type PrWorktreePruneResult = { removed: string[]; kept: string[] };

async function prWorktreeLastUsedAt(parent: string, number: number, dir: string): Promise<number> {
  try {
    return (await stat(`${parent}/.pr-${number}.head`)).mtimeMs;
  } catch (error) {
    if (!missingPath(error)) throw error;
    return (await stat(dir)).mtimeMs;
  }
}

// Local commits or edits (including ignored files, as materialization treats them) are user work.
async function prWorktreeHoldsLocalWork(parent: string, number: number, dir: string): Promise<boolean> {
  const head = await git(["-C", dir, "rev-parse", "HEAD"]);
  if (!head.ok) return true;
  let materializedHead = "";
  try {
    materializedHead = (await Bun.file(`${parent}/.pr-${number}.head`).text()).trim();
  } catch {
    return true;
  }
  if (head.stdout.trim() !== materializedHead) return true;
  const status = await git(["-C", dir, "status", "--porcelain", "--untracked-files=all", "--ignored=matching"]);
  return !status.ok || status.stdout.trim() !== "";
}

async function removePrWorktree(repo: string, number: number): Promise<boolean> {
  const key = `${repo}#${number}`;
  if (inFlightWorktrees.has(key)) return false;
  const removal = withMirrorOperation(repo, async () => {
    const parent = `${worktreesRoot}/${mirrorDirName(repo)}`;
    const dir = prWorktreeDir(repo, number);
    if (await prWorktreeHoldsLocalWork(parent, number, dir)) return "";
    const removed = await git(["--git-dir", mirrorDir(repo), "worktree", "remove", "--force", dir]);
    if (!removed.ok) throw new Error(`PR worktree removal failed for ${key}: ${removed.stderr.trim()}`);
    await rm(`${parent}/.pr-${number}.head`, { force: true });
    return dir;
  }).finally(() => inFlightWorktrees.delete(key));
  // A materialization requested meanwhile waits for the removal and then recreates the checkout.
  inFlightWorktrees.set(key, removal);
  return (await removal) !== "";
}

export async function prunePrWorktrees(
  isOpen: (repo: string, number: number) => boolean,
  now = Date.now(),
): Promise<PrWorktreePruneResult> {
  const result: PrWorktreePruneResult = { removed: [], kept: [] };
  let entries: string[];
  try {
    entries = (await readdir(worktreesRoot)).filter((entry) => !entry.startsWith("."));
  } catch (error) {
    if (missingPath(error)) return result;
    throw error;
  }
  for (const entry of entries) {
    const separator = entry.indexOf("__");
    if (separator <= 0) continue;
    const repo = `${entry.slice(0, separator)}/${entry.slice(separator + 2)}`;
    if (!(await Bun.file(`${mirrorsRoot}/${entry}/HEAD`).exists())) continue;
    const parent = `${worktreesRoot}/${entry}`;
    for (const name of await readdir(parent)) {
      const match = /^pr-(\d+)$/.exec(name);
      if (!match) continue;
      const number = Number(match[1]);
      const dir = `${parent}/${name}`;
      const key = `${repo}#${number}`;
      const idleMs = now - await prWorktreeLastUsedAt(parent, number, dir);
      const maxIdleMs = isOpen(repo, number) ? OPEN_PR_WORKTREE_IDLE_MS : CLOSED_PR_WORKTREE_IDLE_MS;
      if (idleMs <= maxIdleMs) continue;
      try {
        (await removePrWorktree(repo, number) ? result.removed : result.kept).push(key);
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        result.kept.push(key);
      }
    }
    // Drops admin entries whose checkout directory vanished outside Cockpit.
    await git(["--git-dir", `${mirrorsRoot}/${entry}`, "worktree", "prune"]);
  }
  return result;
}

const PR_WORKTREE_PRUNE_DELAY_MS = 2 * 60_000;
const PR_WORKTREE_PRUNE_INTERVAL_MS = 60 * 60_000;

export function startPrWorktreePruning(isOpen: (repo: string, number: number) => boolean): void {
  const sweep = () => {
    prunePrWorktrees(isOpen)
      .then(({ removed, kept }) => {
        if (removed.length || kept.length) {
          console.log(`PR worktree cache: removed ${removed.length} idle checkouts; kept ${kept.length} holding local work or failing removal`);
        }
      })
      .catch((error) => console.error("PR worktree pruning failed:", error))
      .finally(() => setTimeout(sweep, PR_WORKTREE_PRUNE_INTERVAL_MS));
  };
  setTimeout(sweep, PR_WORKTREE_PRUNE_DELAY_MS);
}

async function directorySize(path: string): Promise<number> {
  let pathStat: Stats;
  try {
    pathStat = await lstat(path);
  } catch (error) {
    if (missingPath(error)) return 0;
    throw error;
  }
  if (!pathStat.isDirectory()) return pathStat.size;
  let size = pathStat.size;
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch (error) {
    if (missingPath(error)) return size;
    throw error;
  }
  for (const entry of entries) size += await directorySize(`${path}/${entry}`);
  return size;
}

async function mirrorLastUsedAt(entry: string): Promise<number> {
  const inMemory = lastUsedAt.get(entry);
  if (inMemory !== undefined) return inMemory;
  try {
    return (await stat(`${mirrorsRoot}/${entry}/${LAST_USED_MARKER}`)).mtimeMs;
  } catch (error) {
    if (!missingPath(error)) throw error;
    return (await stat(`${mirrorsRoot}/${entry}`)).mtimeMs;
  }
}

async function hasLinkedWorktree(entry: string): Promise<boolean> {
  try {
    if ((await readdir(`${worktreesRoot}/${entry}`)).length > 0) return true;
  } catch (error) {
    if (!missingPath(error)) throw error;
  }
  try {
    return (await readdir(`${mirrorsRoot}/${entry}/worktrees`)).length > 0;
  } catch (error) {
    if (!missingPath(error)) throw error;
    return false;
  }
}

function beginDeletion(entry: string): void {
  const { promise, resolve } = Promise.withResolvers<void>();
  deletingMirrors.add(entry);
  deletionWaits.set(entry, promise);
  deletionReleases.set(entry, resolve);
}

function finishDeletion(entry: string): void {
  deletingMirrors.delete(entry);
  deletionWaits.delete(entry);
  deletionReleases.get(entry)?.();
  deletionReleases.delete(entry);
}

async function evictMirror(entry: string, usedAt: number): Promise<boolean> {
  if (
    deletingMirrors.has(entry)
    || (activeOperations.get(entry) ?? 0) > 0
    || Date.now() - (lastUsedAt.get(entry) ?? usedAt) < RECENT_USE_WINDOW_MS
  ) return false;

  beginDeletion(entry);
  try {
    if (await hasLinkedWorktree(entry)) return false;
    await rm(`${mirrorsRoot}/${entry}`, { recursive: true, force: true });
    lastUsedAt.delete(entry);
    lastUsePersistedAt.delete(entry);
    return true;
  } finally {
    finishDeletion(entry);
  }
}

export async function pruneMirrors(repos: string[]): Promise<void> {
  const keep = new Set(repos.map(mirrorDirName));
  let entries: string[];
  try {
    entries = (await readdir(mirrorsRoot)).filter((entry) => !entry.startsWith("."));
  } catch (error) {
    if (missingPath(error)) return;
    throw error;
  }

  const now = Date.now();
  let totalBytes = 0;
  let protectedBytes = 0;
  const untracked: Array<{ entry: string; size: number; usedAt: number }> = [];
  const tracked: Array<{ entry: string; size: number; usedAt: number }> = [];
  for (const entry of entries) {
    const size = await directorySize(`${mirrorsRoot}/${entry}`);
    if (size === 0) continue;
    totalBytes += size;
    let usedAt: number;
    try {
      usedAt = await mirrorLastUsedAt(entry);
    } catch (error) {
      if (missingPath(error)) {
        totalBytes -= size;
        continue;
      }
      throw error;
    }
    if (
      deletingMirrors.has(entry)
      || (activeOperations.get(entry) ?? 0) > 0
      || await hasLinkedWorktree(entry)
      || now - usedAt < RECENT_USE_WINDOW_MS
    ) {
      protectedBytes += size;
      continue;
    }
    (keep.has(entry) ? tracked : untracked).push({ entry, size, usedAt });
  }

  untracked.sort((left, right) => left.usedAt - right.usedAt);
  tracked.sort((left, right) => left.usedAt - right.usedAt);
  for (const candidate of untracked) {
    if (await evictMirror(candidate.entry, candidate.usedAt)) totalBytes -= candidate.size;
    else protectedBytes += candidate.size;
  }
  for (const candidate of tracked) {
    if (totalBytes <= MIRROR_CACHE_TARGET_BYTES) break;
    if (await evictMirror(candidate.entry, candidate.usedAt)) totalBytes -= candidate.size;
    else protectedBytes += candidate.size;
  }

  if (totalBytes > MIRROR_CACHE_TARGET_BYTES) {
    console.warn(
      `mirror cache remains ${totalBytes} bytes, above the ${MIRROR_CACHE_TARGET_BYTES}-byte target; `
      + `${protectedBytes} bytes are protected by active operations, linked worktrees, or use within the last 10 minutes`,
    );
  }
}

async function commitExists(dir: string, sha: string): Promise<boolean> {
  const result = await git(["--git-dir", dir, "cat-file", "-e", `${sha}^{commit}`]);
  return result.ok;
}

export type MirrorDiffResult =
  | { status: "ok"; patch: string }
  | { status: "no-mirror" }
  | { status: "missing-commit" }
  | { status: "diff-failed" };

export type CommitFileStat = { path: string; additions: number; deletions: number };
export type PullRequestCommit = { sha: string; headline: string; committedAt: string };

export type MirrorCommitListResult =
  | { status: "ok"; commits: PullRequestCommit[] }
  | { status: "no-mirror" }
  | { status: "missing-commit" }
  | { status: "list-failed" };


export type MirrorCommitStatsResult =
  | { status: "ok"; commits: Array<{ sha: string; files: CommitFileStat[] }> }
  | { status: "no-mirror" }
  | { status: "missing-commit" }
  | { status: "stats-failed" };

export type CommitLineCount = {
  additions: number;
  deletions: number;
  skippedExcluded: boolean;
  excludedOnly: boolean;
};

export function summarizeCommitStats(
  commits: Array<{ sha: string; files: CommitFileStat[] }>,
  testPattern: RegExp,
  generatedByCommit: ReadonlyMap<string, ReadonlySet<string>>,
): Record<string, CommitLineCount> {
  const counts: Record<string, CommitLineCount> = {};
  for (const commit of commits) {
    const totals = { additions: 0, deletions: 0, skippedExcluded: false, excludedOnly: false };
    const excluded = { additions: 0, deletions: 0 };
    let includedFile = false;
    for (const file of commit.files) {
      const bucket = excludedPath(file.path, testPattern, generatedByCommit.get(commit.sha)!) ? excluded : totals;
      bucket.additions += file.additions;
      bucket.deletions += file.deletions;
      if (bucket === excluded) totals.skippedExcluded = true;
      else includedFile = true;
    }
    counts[commit.sha] = !includedFile && totals.skippedExcluded
      ? { additions: excluded.additions, deletions: excluded.deletions, skippedExcluded: false, excludedOnly: true }
      : totals;
  }
  return counts;
}

export type MirrorFileResult =
  | { status: "ok"; content: string }
  | { status: "no-mirror" }
  | { status: "missing-commit" }
  | { status: "not-found" }
  | { status: "read-failed" };

export type MirrorConflictResult =
  | { status: "conflicts"; files: string[] }
  | { status: "clean"; files: [] }
  | { status: "no-mirror" }
  | { status: "missing-commit" }
  | { status: "merge-failed"; error: string };

// merge-tree --write-tree arrived in Git 2.38; older Git rejects it with a bare usage
// message, so name the missing prerequisite instead of echoing that usage text.
async function mergeTreeFailure(stderr: string): Promise<string> {
  const version = (await git(["version"])).stdout.trim();
  const match = /^git version (\d+)\.(\d+)/.exec(version);
  if (match && (Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 38))) {
    return `Conflict lookup requires Git 2.38 or newer for merge-tree --write-tree; the server has ${version}`;
  }
  return stderr.trim() || "git merge-tree failed";
}

export async function conflictFilesFromGitDir(
  gitDir: string,
  base: string,
  head: string,
): Promise<Extract<MirrorConflictResult, { status: "conflicts" | "clean" | "merge-failed" }>> {
  // --no-messages leaves a stable shape: tree OID first, followed by the unique
  // paths from Git's conflicted-file-info section. NUL delimiters preserve every
  // valid path byte except NUL itself (which Git filenames cannot contain).
  const result = await git([
    "--git-dir",
    gitDir,
    "merge-tree",
    "--write-tree",
    "--name-only",
    "--no-messages",
    "-z",
    base,
    head,
  ]);
  if (result.exitCode === 0) return { status: "clean", files: [] };
  if (result.exitCode !== 1) return { status: "merge-failed", error: await mergeTreeFailure(result.stderr) };
  const files = [...new Set(result.stdout.split("\0").slice(1).filter((path) => path !== ""))];
  return { status: "conflicts", files };
}

export async function conflictFilesFromMirror(
  repo: string,
  base: string,
  head: string,
): Promise<MirrorConflictResult> {
  return withMirrorOperation(repo, async () => {
    const dir = mirrorDir(repo);
    if (!(await Bun.file(`${dir}/HEAD`).exists())) return { status: "no-mirror" };
    if (!(await commitExists(dir, base)) || !(await commitExists(dir, head))) return { status: "missing-commit" };
    return conflictFilesFromGitDir(dir, base, head);
  });
}

export type MergeLabels = { head: string; base: string };

export type MergeConflictFile = { path: string; content: string } | { path: string; unsupported: string };

export type MirrorConflictMergeResult =
  | { status: "conflicts"; headSha: string; baseSha: string; files: MergeConflictFile[] }
  | { status: "clean" }
  | { status: "no-mirror" }
  | { status: "missing-commit" }
  | { status: "merge-failed"; error: string };

type ConflictStages = Partial<Record<"1" | "2" | "3", { mode: string; oid: string }>>;

type BaseIntoHeadMerge =
  | { status: "clean"; tree: string }
  | { status: "conflicts"; tree: string; stages: Map<string, ConflictStages> }
  | { status: "merge-failed"; error: string };

// Head is "ours", so every conflict shows the PR's side first as GitHub's conflict editor does. The
// pinned style keeps a user's diff3/zdiff3 config out of the markers.
async function mergeBaseIntoHead(gitDir: string, headSha: string, baseSha: string): Promise<BaseIntoHeadMerge> {
  const result = await git([
    "--git-dir",
    gitDir,
    "-c",
    "merge.conflictStyle=merge",
    "merge-tree",
    "--write-tree",
    "--no-messages",
    "-z",
    headSha,
    baseSha,
  ]);
  if (result.exitCode !== 0 && result.exitCode !== 1) return { status: "merge-failed", error: await mergeTreeFailure(result.stderr) };
  const [tree = "", ...entries] = result.stdout.split("\0");
  if (result.exitCode === 0) return { status: "clean", tree };
  const stages = new Map<string, ConflictStages>();
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [mode = "", oid = "", stage = ""] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    const byStage = stages.get(path) ?? {};
    byStage[stage as "1" | "2" | "3"] = { mode, oid };
    stages.set(path, byStage);
  }
  return { status: "conflicts", tree, stages };
}

const EDITABLE_MODES: Record<string, true> = { "100644": true, "100755": true };

function textConflict(stages: ConflictStages): boolean {
  return !!stages["2"] && !!stages["3"] && EDITABLE_MODES[stages["2"].mode] === true && EDITABLE_MODES[stages["3"].mode] === true;
}

const MAX_CONFLICT_EDIT_BYTES = 1024 * 1024;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

async function gitBlobBytes(gitDir: string, object: string): Promise<Uint8Array | null> {
  const proc = Bun.spawn(["git", "--git-dir", gitDir, "cat-file", "blob", object], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const [bytes, exitCode] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
  return exitCode === 0 ? new Uint8Array(bytes) : null;
}

async function conflictFileFromMerge(
  gitDir: string,
  merge: Extract<BaseIntoHeadMerge, { status: "conflicts" }>,
  path: string,
  revisions: { headSha: string; baseSha: string },
  labels: MergeLabels,
): Promise<MergeConflictFile> {
  const stages = merge.stages.get(path)!;
  if (!stages["2"]) return { path, unsupported: `Deleted in ${labels.head} and changed in ${labels.base}` };
  if (!stages["3"]) return { path, unsupported: `Deleted in ${labels.base} and changed in ${labels.head}` };
  if (!textConflict(stages)) return { path, unsupported: "Symlink or submodule conflict" };
  const bytes = await gitBlobBytes(gitDir, `${merge.tree}:${path}`);
  if (!bytes) return { path, unsupported: "Git wrote no merged file at this path" };
  if (bytes.length > MAX_CONFLICT_EDIT_BYTES) return { path, unsupported: "Too large to resolve here" };
  let text: string;
  try {
    text = strictUtf8.decode(bytes);
  } catch {
    return { path, unsupported: "Binary file" };
  }
  // A content conflict without markers is one Git declined to merge as text (binary or a merge attribute).
  if (text.includes("\0") || !/^<{7,}(?: |\r?$)/m.test(text)) return { path, unsupported: "Git couldn't merge this file as text" };
  // merge-tree labels each side with the revision it was given; the editor names the branches.
  const content = text
    .replace(new RegExp(`^(<{7,}) ${revisions.headSha}(?=:|\\r?$)`, "gm"), (_, marker: string) => `${marker} ${labels.head}`)
    .replace(new RegExp(`^(>{7,}) ${revisions.baseSha}(?=:|\\r?$)`, "gm"), (_, marker: string) => `${marker} ${labels.base}`);
  return { path, content };
}

async function commitSha(gitDir: string, revision: string): Promise<string | null> {
  const result = await git(["--git-dir", gitDir, "rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`]);
  return result.ok ? result.stdout.trim() : null;
}

/** The merge of `base` into `head` with each conflicted file as Git wrote it, markers labelled with branch names. */
export async function conflictMergeFromGitDir(
  gitDir: string,
  base: string,
  head: string,
  labels: MergeLabels,
): Promise<Exclude<MirrorConflictMergeResult, { status: "no-mirror" }>> {
  const [baseSha, headSha] = await Promise.all([commitSha(gitDir, base), commitSha(gitDir, head)]);
  if (!baseSha || !headSha) return { status: "missing-commit" };
  const merge = await mergeBaseIntoHead(gitDir, headSha, baseSha);
  if (merge.status === "clean") return { status: "clean" };
  if (merge.status === "merge-failed") return merge;
  const files = await Promise.all([...merge.stages.keys()].map((path) => conflictFileFromMerge(gitDir, merge, path, { headSha, baseSha }, labels)));
  return { status: "conflicts", headSha, baseSha, files };
}

export async function conflictMergeFromMirror(
  repo: string,
  base: string,
  head: string,
  labels: MergeLabels,
): Promise<MirrorConflictMergeResult> {
  return withMirrorOperation(repo, async () => {
    const dir = mirrorDir(repo);
    if (!(await Bun.file(`${dir}/HEAD`).exists())) return { status: "no-mirror" };
    return conflictMergeFromGitDir(dir, base, head, labels);
  });
}

export type MergeTreeEntry = {
  path: string;
  mode: string;
  type: "blob" | "commit";
  // null deletes the path.
  sha: string | null;
  // The blob's bytes when the head's tree lacks it, so GitHub may not hold it yet.
  content?: Uint8Array;
};

export type ResolvedMerge = { tree: string; baseTree: string; entries: MergeTreeEntry[] };

export type MirrorResolvedMergeResult =
  | { status: "ok"; merge: ResolvedMerge }
  | { status: "conflicts-changed" }
  | { status: "no-mirror" }
  | { status: "missing-commit" }
  | { status: "merge-failed"; error: string };

/**
 * Merges `baseSha` into `headSha` with every conflicted path replaced by its resolution, in a throwaway
 * index. `entries` turn the base commit's tree into the result; GitHub rebuilds the same tree from them.
 */
export async function resolvedMergeFromGitDir(
  gitDir: string,
  baseSha: string,
  headSha: string,
  resolutions: ReadonlyArray<{ path: string; content: string }>,
): Promise<Exclude<MirrorResolvedMergeResult, { status: "no-mirror" }>> {
  if (!(await commitExists(gitDir, baseSha)) || !(await commitExists(gitDir, headSha))) return { status: "missing-commit" };
  const merge = await mergeBaseIntoHead(gitDir, headSha, baseSha);
  if (merge.status === "merge-failed") return merge;
  const conflicted = merge.status === "conflicts" ? merge.stages : new Map<string, ConflictStages>();
  const resolvedPaths = new Set(resolutions.map(({ path }) => path));
  if (
    resolvedPaths.size !== resolutions.length
    || conflicted.size !== resolvedPaths.size
    || [...conflicted].some(([path, stages]) => !resolvedPaths.has(path) || !textConflict(stages))
  ) {
    return { status: "conflicts-changed" };
  }

  const scratch = await mkdtemp(join(tmpdir(), "pr-cockpit-merge-"));
  const index = { GIT_INDEX_FILE: join(scratch, "index") };
  const failed = (step: string, result: { stderr: string }) => ({ status: "merge-failed" as const, error: result.stderr.trim() || `git ${step} failed` });
  try {
    const read = await git(["--git-dir", gitDir, "read-tree", merge.tree], [], undefined, index);
    if (!read.ok) return failed("read-tree", read);
    const listed = await git(["--git-dir", gitDir, "--literal-pathspecs", "ls-tree", "-r", "-z", merge.tree, "--", ...resolvedPaths]);
    if (!listed.ok) return failed("ls-tree", listed);
    const modes = new Map(listed.stdout.split("\0").filter(Boolean).map((entry) => [entry.slice(entry.indexOf("\t") + 1), entry.slice(0, entry.indexOf(" "))]));
    let indexInfo = "";
    for (const { path, content } of resolutions) {
      const blob = await git(["--git-dir", gitDir, "hash-object", "-w", "--stdin", "--no-filters"], [], content);
      if (!blob.ok) return failed("hash-object", blob);
      indexInfo += `${modes.get(path) ?? "100644"} ${blob.stdout.trim()}\t${path}\0`;
    }
    const updated = await git(["--git-dir", gitDir, "update-index", "-z", "--index-info"], [], indexInfo, index);
    if (!updated.ok) return failed("update-index", updated);
    const written = await git(["--git-dir", gitDir, "write-tree"], [], undefined, index);
    if (!written.ok) return failed("write-tree", written);
    const tree = written.stdout.trim();

    const baseTree = await git(["--git-dir", gitDir, "rev-parse", `${baseSha}^{tree}`]);
    if (!baseTree.ok) return failed("rev-parse", baseTree);
    const [fromBase, fromHead] = await Promise.all([
      git(["--git-dir", gitDir, "diff-tree", "-r", "-z", "--no-renames", baseSha, tree]),
      git(["--git-dir", gitDir, "diff-tree", "-r", "-z", "--no-renames", "--name-only", headSha, tree]),
    ]);
    if (!fromBase.ok) return failed("diff-tree", fromBase);
    if (!fromHead.ok) return failed("diff-tree", fromHead);
    const unlikeHead = new Set(fromHead.stdout.split("\0").filter(Boolean));
    const fields = fromBase.stdout.split("\0");
    const entries: MergeTreeEntry[] = [];
    for (let field = 0; field + 1 < fields.length; field += 2) {
      const [oldMode = "", newMode = "", , newSha = "", status = ""] = fields[field]!.slice(1).split(" ");
      const path = fields[field + 1]!;
      const mode = status === "D" ? oldMode : newMode;
      const entry: MergeTreeEntry = { path, mode, type: mode === "160000" ? "commit" : "blob", sha: status === "D" ? null : newSha };
      if (entry.sha !== null && entry.type === "blob" && unlikeHead.has(path)) {
        const bytes = await gitBlobBytes(gitDir, entry.sha);
        if (!bytes) return { status: "merge-failed", error: `git cat-file failed for ${path}` };
        entry.content = bytes;
      }
      entries.push(entry);
    }
    return { status: "ok", merge: { tree, baseTree: baseTree.stdout.trim(), entries } };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function resolvedMergeFromMirror(
  repo: string,
  baseSha: string,
  headSha: string,
  resolutions: ReadonlyArray<{ path: string; content: string }>,
): Promise<MirrorResolvedMergeResult> {
  return withMirrorOperation(repo, async () => {
    const dir = mirrorDir(repo);
    if (!(await Bun.file(`${dir}/HEAD`).exists())) return { status: "no-mirror" };
    return resolvedMergeFromGitDir(dir, baseSha, headSha, resolutions);
  });
}

export async function diffFromGitDir(
  gitDir: string,
  base: string,
  head: string,
  mode: "two-dot" | "three-dot",
): Promise<Exclude<MirrorDiffResult, { status: "no-mirror" }>> {
  if (!(await commitExists(gitDir, base)) || !(await commitExists(gitDir, head))) return { status: "missing-commit" };
  const range = mode === "two-dot" ? `${base}..${head}` : `${base}...${head}`;
  const result = await git(["--git-dir", gitDir, "diff", range]);
  if (!result.ok) return { status: "diff-failed" };
  return { status: "ok", patch: result.stdout };
}

export async function diffFromMirror(
  repo: string,
  base: string,
  head: string,
  mode: "two-dot" | "three-dot",
): Promise<MirrorDiffResult> {
  return withMirrorOperation(repo, async () => {
    const dir = mirrorDir(repo);
    if (!(await Bun.file(`${dir}/HEAD`).exists())) return { status: "no-mirror" };
    return diffFromGitDir(dir, base, head, mode);
  });
}

export async function commitsFromGitDir(
  gitDir: string,
  base: string,
  head: string,
): Promise<Exclude<MirrorCommitListResult, { status: "no-mirror" }>> {
  if (!(await commitExists(gitDir, base)) || !(await commitExists(gitDir, head))) return { status: "missing-commit" };
  const result = await git([
    "--git-dir",
    gitDir,
    "log",
    "--reverse",
    "--topo-order",
    "--format=%H%x00%s%x00%aI%x00",
    `${base}..${head}`,
  ]);
  if (!result.ok) return { status: "list-failed" };
  const fields = result.stdout.split("\0");
  const commits: PullRequestCommit[] = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const sha = fields[index]!.trimStart();
    const headline = fields[index + 1]!;
    const committedAt = fields[index + 2]!;
    if (sha !== "") commits.push({ sha, headline, committedAt });
  }
  return { status: "ok", commits };
}

export async function commitsFromMirror(
  repo: string,
  base: string,
  head: string,
): Promise<MirrorCommitListResult> {
  return withMirrorOperation(repo, async () => {
    const dir = mirrorDir(repo);
    if (!(await Bun.file(`${dir}/HEAD`).exists())) return { status: "no-mirror" };
    return commitsFromGitDir(dir, base, head);
  });
}

export type DeployedCommit = { sha: string; firstParent: string | null; subject: string };

export type MirrorDeployedCommitsResult =
  | { status: "ok"; commits: DeployedCommit[]; missingEarlierHeads: number }
  | { status: "no-mirror" }
  | { status: "missing-commit" }
  | { status: "list-failed" };

// Commits a deploy of `head` shipped beyond earlier deploys: reachable from head and from none of
// the earlier heads, committed after `sinceMs` so a first deploy never walks the whole history.
// An earlier head the mirror lacks bounds nothing, so callers learn how many.
export async function deployedCommitsFromMirror(
  repo: string,
  head: string,
  earlierHeads: string[],
  sinceMs: number,
): Promise<MirrorDeployedCommitsResult> {
  return withMirrorOperation(repo, async () => {
    const dir = mirrorDir(repo);
    if (!(await Bun.file(`${dir}/HEAD`).exists())) return { status: "no-mirror" };
    if (!(await commitExists(dir, head))) return { status: "missing-commit" };
    let present: string[] = [];
    if (earlierHeads.length > 0) {
      const check = await git(["--git-dir", dir, "cat-file", "--batch-check"], [], `${earlierHeads.join("\n")}\n`);
      if (!check.ok) return { status: "list-failed" };
      present = check.stdout.split("\n").flatMap((line) => {
        const [sha, type] = line.split(" ");
        return sha && type === "commit" ? [sha] : [];
      });
    }
    const result = await git(
      ["--git-dir", dir, "log", "--stdin", `--since=@${Math.floor(sinceMs / 1000)}`, "--format=%H%x00%P%x00%s%x00"],
      [],
      [head, ...present.map((sha) => `^${sha}`)].join("\n") + "\n",
    );
    if (!result.ok) return { status: "list-failed" };
    const fields = result.stdout.split("\0");
    const commits: DeployedCommit[] = [];
    for (let index = 0; index + 2 < fields.length; index += 3) {
      const sha = fields[index]!.trimStart();
      if (sha !== "") commits.push({ sha, firstParent: fields[index + 1]!.split(" ")[0] || null, subject: fields[index + 2]! });
    }
    return { status: "ok", commits, missingEarlierHeads: earlierHeads.length - present.length };
  });
}

export async function commitStatsFromGitDir(
  gitDir: string,
  base: string,
  head: string,
): Promise<Exclude<MirrorCommitStatsResult, { status: "no-mirror" }>> {
  if (!(await commitExists(gitDir, base)) || !(await commitExists(gitDir, head))) return { status: "missing-commit" };
  // one walk yields every commit's per-file counts; -z ends each header and row with NUL, so paths stay
  // unquoted and may hold tabs or newlines. Headers are \x1e<sha>; the first row after one gains a leading
  // newline; rows are `added TAB deleted TAB path`, "-" counting a binary file, except that a rename's
  // path is empty and its old and new paths follow as the next two fields. --find-renames pins Git's
  // default detection so a user's diff.renames cannot turn renames into a delete plus an add.
  const result = await git([
    "--git-dir",
    gitDir,
    "log",
    "-z",
    "--find-renames",
    "--numstat",
    "--format=%x1e%H",
    `${base}..${head}`,
  ]);
  if (!result.ok) return { status: "stats-failed" };
  const commits: Array<{ sha: string; files: CommitFileStat[] }> = [];
  const fields = result.stdout.split("\0");
  let files: CommitFileStat[] | null = null;
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    if (field.startsWith("\x1e")) {
      files = [];
      commits.push({ sha: field.slice(1), files });
      continue;
    }
    if (field === "") continue;
    const row = /^\n?(\d+|-)\t(\d+|-)\t/.exec(field);
    if (row === null || files === null) return { status: "stats-failed" };
    let path = field.slice(row[0].length);
    if (path === "") {
      path = fields[index + 2] ?? "";
      index += 2;
      if (path === "") return { status: "stats-failed" };
    }
    files.push({ path, additions: Number(row[1]) || 0, deletions: Number(row[2]) || 0 });
  }
  // merges carry no numstat rows; omitting them lets the client fall back to GitHub's own totals
  return { status: "ok", commits: commits.filter((commit) => commit.files.length > 0) };
}

export async function commitStatsFromMirror(
  repo: string,
  base: string,
  head: string,
): Promise<MirrorCommitStatsResult> {
  return withMirrorOperation(repo, async () => {
    const dir = mirrorDir(repo);
    if (!(await Bun.file(`${dir}/HEAD`).exists())) return { status: "no-mirror" };
    return commitStatsFromGitDir(dir, base, head);
  });
}

export async function fileFromGitDir(
  gitDir: string,
  sha: string,
  path: string,
): Promise<Exclude<MirrorFileResult, { status: "no-mirror" }>> {
  if (!(await commitExists(gitDir, sha))) return { status: "missing-commit" };
  const object = `${sha}:${path}`;
  const type = await git(["--git-dir", gitDir, "cat-file", "-t", object]);
  if (!type.ok || type.stdout.trim() !== "blob") return { status: "not-found" };
  const content = await git(["--git-dir", gitDir, "cat-file", "-p", object]);
  if (!content.ok) return { status: "read-failed" };
  return { status: "ok", content: content.stdout };
}

export async function fileFromMirror(repo: string, sha: string, path: string): Promise<MirrorFileResult> {
  return withMirrorOperation(repo, async () => {
    const dir = mirrorDir(repo);
    if (!(await Bun.file(`${dir}/HEAD`).exists())) return { status: "no-mirror" };
    return fileFromGitDir(dir, sha, path);
  });
}

export type MirrorBranch = { name: string; sha: string; default: boolean };

export type MirrorBranchesResult =
  | { status: "ok"; branches: MirrorBranch[] }
  | { status: "no-mirror" }
  | { status: "list-failed" };

// A bare clone's HEAD names the default branch it was cloned from. The default branch comes first,
// then the others by newest commit.
export async function branchesFromGitDir(gitDir: string): Promise<Exclude<MirrorBranchesResult, { status: "no-mirror" }>> {
  const [head, refs] = await Promise.all([
    git(["--git-dir", gitDir, "symbolic-ref", "-q", "HEAD"]),
    git(["--git-dir", gitDir, "for-each-ref", "--sort=-committerdate", "--format=%(objectname) %(refname)", "refs/heads/"]),
  ]);
  if (!refs.ok) return { status: "list-failed" };
  const defaultRef = head.ok ? head.stdout.trim() : "";
  const branches: MirrorBranch[] = [];
  for (const line of refs.stdout.split("\n")) {
    const space = line.indexOf(" ");
    if (space === -1) continue;
    const ref = line.slice(space + 1);
    branches.push({ name: ref.slice("refs/heads/".length), sha: line.slice(0, space), default: ref === defaultRef });
  }
  branches.sort((left, right) => Number(right.default) - Number(left.default));
  return { status: "ok", branches };
}

export async function branchesFromMirror(repo: string): Promise<MirrorBranchesResult> {
  return withMirrorOperation(repo, async () => {
    const dir = mirrorDir(repo);
    if (!(await Bun.file(`${dir}/HEAD`).exists())) return { status: "no-mirror" };
    return branchesFromGitDir(dir);
  });
}

// The default branch a mirror was cloned from, read straight from its HEAD so list rendering never
// spawns git; null without a mirror.
export function mirrorDefaultBranch(repo: string): string | null {
  let head: string;
  try {
    head = readFileSync(`${mirrorDir(repo)}/HEAD`, "utf8").trim();
  } catch {
    return null;
  }
  return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : null;
}
