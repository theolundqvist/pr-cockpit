import { access } from "node:fs/promises";
import { join } from "node:path";

export interface LocalCheckout {
  path: string;
  branch: string | null;
}

export interface WorktreeScanInput {
  overrideRoots: string[];
  matchRepos: string[];
}

export interface WorktreeScanResult {
  byBranch: [string, string][];
  windowIdByPath: [string, string][];
  localCheckoutByRepo: [string, LocalCheckout][];
  discoveredRepos: string[];
}

const COMMAND_TIMEOUT_MS = 2_000;

async function command(args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
    const completed = Promise.all([proc.exited, new Response(proc.stdout).text()])
      .then(([exitCode, stdout]) => ({ exitCode, stdout }))
      .catch(() => null);
    const result = await Promise.race([completed, Bun.sleep(COMMAND_TIMEOUT_MS).then(() => null)]);
    if (result === null) {
      proc.kill();
      console.warn(`worktree scan command timed out: ${args.join(" ")}`);
      return null;
    }
    return result.exitCode === 0 ? result.stdout : null;
  } catch {
    return null;
  }
}

function git(root: string, args: string[]): Promise<string | null> {
  return command(["git", "-C", root, ...args]);
}

export async function originRepo(root: string): Promise<string | null> {
  const url = await git(root, ["remote", "get-url", "origin"]);
  const match = url?.trim().match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}

async function gitCommonDir(root: string): Promise<string | null> {
  const out = await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return out?.trim() || null;
}

async function tmuxPanes(): Promise<{ windowId: string; path: string }[]> {
  const stdout = await command(["tmux", "list-panes", "-a", "-F", "#{window_id} #{pane_current_path}"]);
  if (stdout === null) return [];
  const out: { windowId: string; path: string }[] = [];
  for (const line of stdout.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const path = line.slice(sp + 1).trim();
    if (path) out.push({ windowId: line.slice(0, sp), path });
  }
  return out;
}

function conventionalRepoRoots(matchRepos: Set<string>): string[] {
  const home = Bun.env.HOME;
  if (!home) return [];

  const roots = new Set<string>();
  for (const repo of matchRepos) {
    const name = repo.split("/")[1];
    if (!name) continue;
    for (const parent of ["Documents", "Developer", "Code", "Projects", "src"]) roots.add(join(home, parent, name));
  }
  return [...roots];
}

async function checkoutRoot(root: string): Promise<string | null> {
  const out = await git(root, ["rev-parse", "--show-toplevel"]);
  return out?.trim() || null;
}

export async function buildLocalCheckoutMap(
  overrideRoots: string[],
  conventionalRoots: string[],
  matchRepos: Set<string>,
): Promise<Map<string, LocalCheckout>> {
  const next = new Map<string, LocalCheckout>();
  const add = async (root: string) => {
    const repo = await originRepo(root);
    const checkout = await checkoutRoot(root);
    if (!repo || !checkout || !matchRepos.has(repo) || next.has(repo)) return;
    const branch = (await git(checkout, ["branch", "--show-current"]))?.trim() || null;
    next.set(repo, { path: checkout, branch });
  };
  for (const root of overrideRoots) await add(root);
  for (const root of conventionalRoots) await add(root);
  return next;
}

function parseWorktrees(porcelain: string): { path: string; branch: string | null }[] {
  const out: { path: string; branch: string | null }[] = [];
  let path: string | null = null;
  let branch: string | null = null;
  const flush = () => {
    if (path) out.push({ path, branch });
    path = null;
    branch = null;
  };
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      path = line.slice("worktree ".length);
    } else if (line.startsWith("branch refs/heads/")) {
      branch = line.slice("branch refs/heads/".length);
    }
  }
  flush();
  return out;
}

export async function buildWorktreeMap(
  overrideRoots: string[],
  tmuxRoots: string[],
  matchRepos: Set<string>,
): Promise<Map<string, string>> {
  const next = new Map<string, string>();
  const seenCommonDirs = new Set<string>();

  const addRoot = async (root: string, requireMatch: boolean) => {
    const repo = await originRepo(root);
    if (!repo || (requireMatch && !matchRepos.has(repo))) return;
    const commonDir = await gitCommonDir(root);
    if (commonDir) {
      if (seenCommonDirs.has(commonDir)) return;
      seenCommonDirs.add(commonDir);
    }
    const porcelain = await git(root, ["worktree", "list", "--porcelain"]);
    if (!porcelain) return;
    for (const wt of parseWorktrees(porcelain)) {
      if (!wt.branch) continue;
      const key = `${repo}\n${wt.branch}`;
      if (!next.has(key)) next.set(key, wt.path);
    }
  };

  for (const root of overrideRoots) await addRoot(root, false);
  for (const root of tmuxRoots) await addRoot(root, true);
  return next;
}

export function matchWindowIds(panes: { windowId: string; path: string }[], worktreePaths: string[]): Map<string, string> {
  const byLengthDesc = [...worktreePaths].sort((a, b) => b.length - a.length);
  const result = new Map<string, string>();
  for (const { windowId, path } of panes) {
    const match = byLengthDesc.find((candidate) => path === candidate || path.startsWith(`${candidate}/`));
    if (match && !result.has(match)) result.set(match, windowId);
  }
  return result;
}

async function existingPaths(paths: string[]): Promise<string[]> {
  const checked = await Promise.all(
    paths.map(async (path) => {
      try {
        await access(path);
        return path;
      } catch {
        return null;
      }
    }),
  );
  return checked.filter((path): path is string => path !== null);
}

export async function scanWorktrees(input: WorktreeScanInput): Promise<WorktreeScanResult> {
  const matchRepos = new Set(input.matchRepos);
  const panes = await tmuxPanes();
  const tmuxRoots = await existingPaths([...new Set(panes.map((pane) => pane.path))]);
  const conventionalRoots = await existingPaths(conventionalRepoRoots(matchRepos));
  const overrideRoots = await existingPaths(input.overrideRoots);
  const discoveredRoots = [...new Set([...tmuxRoots, ...conventionalRoots])];
  const byBranch = await buildWorktreeMap(overrideRoots, discoveredRoots, matchRepos);
  const windowIdByPath = matchWindowIds(panes, [...byBranch.values()]);
  const localCheckoutByRepo = await buildLocalCheckoutMap(overrideRoots, conventionalRoots, matchRepos);
  const discoveredRepos = new Set<string>();
  for (const path of tmuxRoots) {
    const repo = await originRepo(path);
    if (repo) discoveredRepos.add(repo);
  }
  return {
    byBranch: [...byBranch],
    windowIdByPath: [...windowIdByPath],
    localCheckoutByRepo: [...localCheckoutByRepo],
    discoveredRepos: [...discoveredRepos],
  };
}
