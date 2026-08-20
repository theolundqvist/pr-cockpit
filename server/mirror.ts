import { mkdirSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { ghToken } from "./github.ts";

const dataDir = Bun.env.COCKPIT_DATA_DIR ?? "data";
const mirrorsRoot = `${dataDir}/mirrors`;
const worktreesRoot = `${dataDir}/worktrees`;
const askpassPath = `${mirrorsRoot}/.askpass.sh`;

function mirrorDirName(repo: string): string {
  return repo.replaceAll("/", "__");
}

export function mirrorDir(repo: string): string {
  return `${mirrorsRoot}/${mirrorDirName(repo)}`;
}

export function prWorktreeDir(repo: string, number: number): string {
  return `${worktreesRoot}/${mirrorDirName(repo)}/pr-${number}`;
}

function ensureAskpass(): void {
  mkdirSync(mirrorsRoot, { recursive: true });
  writeFileSync(askpassPath, '#!/bin/sh\ncase "$1" in\n  Username*) echo "x-access-token" ;;\n  *) echo "$GIT_MIRROR_TOKEN" ;;\nesac\n');
  chmodSync(askpassPath, 0o700);
}

async function git(args: string[]): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
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

export class MirrorFetchError extends Error {
  constructor(message: string, readonly timedOut: boolean) {
    super(message);
  }
}

const FETCH_REFSPECS = ["+refs/heads/*:refs/heads/*", "+refs/pull/*/head:refs/remotes/origin/pr/*"];

async function ensureMirror(repo: string, timeoutMs?: number): Promise<void> {
  const dir = mirrorDir(repo);
  if (await Bun.file(`${dir}/HEAD`).exists()) return;
  mkdirSync(mirrorsRoot, { recursive: true });
  const clone = await authedGit(["clone", "--bare", `https://github.com/${repo}.git`, dir], timeoutMs);
  if (!clone.ok) throw new MirrorFetchError(`mirror clone failed for ${repo}: ${clone.stderr}`, clone.timedOut);
}

const inFlightFetch = new Map<string, Promise<void>>();

// on-demand mirrors need to survive the poll cycle's prune immediately after being cloned/fetched
const lastUsedAt = new Map<string, number>();
const RECENT_USE_WINDOW_MS = 10 * 60_000;

function touch(repo: string): void {
  lastUsedAt.set(mirrorDirName(repo), Date.now());
}

// bound for in-request cache fetches; background ingestion stays unbounded
export const INCREMENTAL_FETCH_TIMEOUT_MS = 15_000;

function dedupWaitTimeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new MirrorFetchError(`mirror fetch dedup wait exceeded ${ms}ms`, true)), ms);
  });
}

export function fetchMirror(repo: string, timeoutMs?: number): Promise<void> {
  touch(repo);
  const existing = inFlightFetch.get(repo);
  if (existing) {
    // an in-flight fetch may be unbounded (background/cold-clone) - a bounded caller still needs to give up on time
    return timeoutMs !== undefined ? Promise.race([existing, dedupWaitTimeout(timeoutMs)]) : existing;
  }
  const promise = (async () => {
    await ensureMirror(repo, timeoutMs);
    const dir = mirrorDir(repo);
    const result = await authedGit(["--git-dir", dir, "fetch", "--prune", "origin", ...FETCH_REFSPECS], timeoutMs);
    if (!result.ok) throw new MirrorFetchError(`mirror fetch failed for ${repo}: ${result.stderr}`, result.timedOut);
  })().finally(() => inFlightFetch.delete(repo));
  inFlightFetch.set(repo, promise);
  return promise;
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
  const promise = (async () => {
    const gitDir = mirrorDir(repo);
    if (!(await commitExists(gitDir, sha))) {
      try {
        await fetchMirror(repo, INCREMENTAL_FETCH_TIMEOUT_MS);
      } catch (err) {
        throw new Error(`cache fetch failed for ${repo}: ${err instanceof Error ? err.message : String(err)}`);
      }
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
  })().finally(() => inFlightWorktrees.delete(key));
  inFlightWorktrees.set(key, promise);
  return promise;
}

export function pruneMirrors(repos: string[]): void {
  const keep = new Set(repos.map(mirrorDirName));
  let entries: string[];
  try {
    entries = readdirSync(mirrorsRoot);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (entry.startsWith(".") || keep.has(entry)) continue;
    try {
      if (readdirSync(`${worktreesRoot}/${entry}`).some((name) => name.startsWith("pr-") || name.startsWith(".pr-"))) continue;
    } catch {}
    const usedAt = lastUsedAt.get(entry);
    if (usedAt !== undefined && now - usedAt < RECENT_USE_WINDOW_MS) continue;
    rmSync(`${mirrorsRoot}/${entry}`, { recursive: true, force: true });
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
  touch(repo);
  const dir = mirrorDir(repo);
  if (!(await Bun.file(`${dir}/HEAD`).exists())) return { status: "no-mirror" };
  if (!(await commitExists(dir, base)) || !(await commitExists(dir, head))) return { status: "missing-commit" };
  return conflictFilesFromGitDir(dir, base, head);
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
  touch(repo);
  const dir = mirrorDir(repo);
  if (!(await Bun.file(`${dir}/HEAD`).exists())) return { status: "no-mirror" };
  return diffFromGitDir(dir, base, head, mode);
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
  touch(repo);
  const dir = mirrorDir(repo);
  if (!(await Bun.file(`${dir}/HEAD`).exists())) return { status: "no-mirror" };
  return fileFromGitDir(dir, sha, path);
}
