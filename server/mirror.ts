import type { Stats } from "node:fs";
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { lstat, readdir, rm, stat } from "node:fs/promises";
import { ghToken } from "./github.ts";

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
): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([...priorityCommand, "git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, exitCode, stdout, stderr };
}

async function authedGit(args: string[], timeoutMs?: number): Promise<{ ok: boolean; stdout: string; stderr: string; timedOut: boolean }> {
  ensureAskpass();
  const token = await ghToken();
  // detached + group kill below - git's network transport is a git-remote-https grandchild a single-pid kill misses
  const proc = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    detached: timeoutMs !== undefined,
    env: { ...Bun.env, GIT_ASKPASS: askpassPath, GIT_MIRROR_TOKEN: token, GIT_TERMINAL_PROMPT: "0" },
  });
  let timedOut = false;
  const timer =
    timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          try {
            process.kill(-proc.pid, "SIGKILL");
          } catch {}
        }, timeoutMs)
      : null;
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (timer) clearTimeout(timer);
  return { ok: !timedOut && exitCode === 0, stdout, stderr, timedOut };
}

export type MirrorFetchFailureKind = "credentials" | "network" | "deadline" | "git";

export class MirrorFetchError extends Error {
  constructor(message: string, readonly kind: MirrorFetchFailureKind) {
    super(message);
  }
}

function mirrorFetchError(operation: "clone" | "fetch", repo: string, result: { stderr: string; timedOut: boolean }): MirrorFetchError {
  if (result.timedOut) return new MirrorFetchError(`mirror ${operation} deadline exceeded for ${repo}`, "deadline");
  if (/Invalid username or password|Invalid username or token|Authentication failed/i.test(result.stderr)) {
    return new MirrorFetchError(`GitHub rejected mirror credentials for ${repo}`, "credentials");
  }
  const detail = result.stderr
    .trim()
    .replace(/https:\/\/[^/@\s]+@/g, "https://[redacted]@")
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+\b/g, "[redacted]")
    .slice(0, 1024);
  const kind = /Could not resolve host|Failed to connect|Connection (?:timed out|reset)|network is unreachable|TLS connection|SSL_connect|remote end hung up|early EOF/i.test(result.stderr)
    ? "network"
    : "git";
  return new MirrorFetchError(`mirror ${operation} failed for ${repo}${detail ? `: ${detail}` : ""}`, kind);
}

const FETCH_REFSPECS = ["+refs/heads/*:refs/heads/*", "+refs/pull/*/head:refs/remotes/origin/pr/*"];

async function ensureMirror(repo: string, timeoutMs?: number): Promise<void> {
  const dir = mirrorDir(repo);
  if (await Bun.file(`${dir}/HEAD`).exists()) return;
  mkdirSync(mirrorsRoot, { recursive: true });
  const clone = await authedGit(["clone", "--bare", `https://github.com/${repo}.git`, dir], timeoutMs);
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

// bound for in-request cache fetches; background ingestion stays unbounded
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
    await ensureMirror(repo, timeoutMs);
    touch(repo);
    const dir = mirrorDir(repo);
    const result = await authedGit(["--git-dir", dir, "fetch", "--no-auto-maintenance", "--prune", "origin", ...FETCH_REFSPECS], timeoutMs);
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
  skippedTests: boolean;
  testsOnly: boolean;
};

export function summarizeCommitStats(
  commits: Array<{ sha: string; files: CommitFileStat[] }>,
  testPattern: RegExp,
): Record<string, CommitLineCount> {
  const counts: Record<string, CommitLineCount> = {};
  for (const commit of commits) {
    const totals = { additions: 0, deletions: 0, skippedTests: false, testsOnly: false };
    const tests = { additions: 0, deletions: 0 };
    for (const file of commit.files) {
      const bucket = testPattern.test(file.path) ? tests : totals;
      bucket.additions += file.additions;
      bucket.deletions += file.deletions;
      if (bucket === tests) totals.skippedTests = true;
    }
    counts[commit.sha] = totals.additions === 0 && totals.deletions === 0 && totals.skippedTests
      ? { additions: tests.additions, deletions: tests.deletions, skippedTests: false, testsOnly: true }
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
  if (result.exitCode !== 1) {
    return { status: "merge-failed", error: result.stderr.trim() || "git merge-tree failed" };
  }
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

export async function commitStatsFromGitDir(
  gitDir: string,
  base: string,
  head: string,
): Promise<Exclude<MirrorCommitStatsResult, { status: "no-mirror" }>> {
  if (!(await commitExists(gitDir, base)) || !(await commitExists(gitDir, head))) return { status: "missing-commit" };
  // one walk yields every commit's per-file counts; \x1e delimits records so headline text can never look like a row
  const result = await git([
    "--git-dir",
    gitDir,
    "log",
    "--no-renames",
    "--numstat",
    "--format=%x1e%H",
    `${base}..${head}`,
  ]);
  if (!result.ok) return { status: "stats-failed" };
  const commits: Array<{ sha: string; files: CommitFileStat[] }> = [];
  for (const record of result.stdout.split("\x1e")) {
    const lines = record.split("\n").filter((line) => line !== "");
    const sha = lines.shift();
    if (sha === undefined) continue;
    const files: CommitFileStat[] = [];
    for (const line of lines) {
      const [added, removed, ...rest] = line.split("\t");
      const path = rest.join("\t");
      if (path === "") continue;
      // binary files report "-" for both counts
      files.push({ path, additions: Number(added) || 0, deletions: Number(removed) || 0 });
    }
    // merges carry no numstat rows; omitting them lets the client fall back to GitHub's own totals
    if (files.length > 0) commits.push({ sha, files });
  }
  return { status: "ok", commits };
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
