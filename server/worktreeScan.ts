import { distinctPrRepos } from "./db.ts";
import { settingsRepoRoots } from "./settings.ts";
import type { LocalCheckout } from "./worktreeProbe.ts";
import { createWorktreeScanRunner } from "./worktreeScanRunner.ts";

let byBranch = new Map<string, string>();
let windowIdByPath = new Map<string, string>();
let localCheckoutByRepo = new Map<string, LocalCheckout>();
let discovered = new Set<string>();
let hasScanned = false;

const runScan = createWorktreeScanRunner();

export async function refreshWorktreeScan(): Promise<void> {
  const result = await runScan({ overrideRoots: settingsRepoRoots(), matchRepos: distinctPrRepos() });
  if (!result) return;
  byBranch = new Map(result.byBranch);
  windowIdByPath = new Map(result.windowIdByPath);
  localCheckoutByRepo = new Map(result.localCheckoutByRepo);
  discovered = new Set(result.discoveredRepos);
  hasScanned = true;
}

export function worktreePathFor(repo: string, headRef: string): string | null {
  return byBranch.get(`${repo}\n${headRef}`) ?? null;
}

export function localCheckoutPathFor(repo: string): string | null {
  return localCheckoutByRepo.get(repo)?.path ?? null;
}

export function localCheckoutBranchFor(repo: string): string | null {
  return localCheckoutByRepo.get(repo)?.branch ?? null;
}

export function setLocalCheckoutBranch(repo: string, branch: string): void {
  const checkout = localCheckoutByRepo.get(repo);
  if (checkout) localCheckoutByRepo.set(repo, { ...checkout, branch });
}

export function worktreeWindowIdFor(repo: string, headRef: string): string | null {
  const path = worktreePathFor(repo, headRef);
  return path ? windowIdByPath.get(path) ?? null : null;
}

export interface DiscoveredWorktree {
  repo: string;
  branch: string;
  path: string;
  windowId: string | null;
}

export function listWorktrees(): DiscoveredWorktree[] {
  return [...byBranch.entries()].map(([key, path]) => {
    const [repo, branch] = key.split("\n") as [string, string];
    return { repo, branch, path, windowId: windowIdByPath.get(path) ?? null };
  });
}

export async function discoveredRepos(): Promise<string[]> {
  if (!hasScanned) await refreshWorktreeScan();
  return [...discovered];
}
