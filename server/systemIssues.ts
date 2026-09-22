import { statfsSync } from "node:fs";

const MIN_FREE_BYTES = 256 * 1024 * 1024;
const issues = new Map<string, SystemIssue>();
const stickyIssues = new Set<string>();

export type SystemIssueKind = "missing-git" | "disk-space" | "repository-access";

export interface SystemIssue {
  id: string;
  kind: SystemIssueKind;
  title: string;
  message: string;
  detectedAt: string;
  repo?: string;
}

function setIssue(issue: Omit<SystemIssue, "detectedAt">): void {
  const previous = issues.get(issue.id);
  issues.set(issue.id, { ...issue, detectedAt: previous?.detectedAt ?? new Date().toISOString() });
}

function dataDirectory(): string {
  return Bun.env.COCKPIT_DATA_DIR ?? "data";
}

function formatMegabytes(bytes: number): string {
  return Math.max(0, Math.floor(bytes / 1024 / 1024)).toLocaleString("en-US");
}

export function checkLocalSystemIssues(): void {
  if (Bun.which("git")) {
    issues.delete("missing-git");
  } else {
    setIssue({
      id: "missing-git",
      kind: "missing-git",
      title: "Git is required",
      message: "Install Git to create local review worktrees, update Cockpit, and search repository history.",
    });
  }

  try {
    const storage = statfsSync(dataDirectory());
    const freeBytes = Number(storage.bavail) * Number(storage.bsize);
    if (freeBytes >= MIN_FREE_BYTES) {
      if (!stickyIssues.has("disk-space")) issues.delete("disk-space");
    } else {
      setIssue({
        id: "disk-space",
        kind: "disk-space",
        title: "Storage is almost full",
        message: `Cockpit's data volume has ${formatMegabytes(freeBytes)} MB free. Free space before Git mirrors and cached pull requests stop updating.`,
      });
    }
  } catch (error) {
    setIssue({
      id: "disk-space",
      kind: "disk-space",
      title: "Cockpit storage is unavailable",
      message: `Cockpit cannot inspect its data volume: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

export function reportStorageFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!/SQLITE_FULL|database or disk is full/i.test(message)) return false;
  setIssue({
    id: "disk-space",
    kind: "disk-space",
    title: "Cockpit cannot write to storage",
    message: "Cockpit's data volume is full. Free space before retrying so cached pull requests and GitHub usage can update safely.",
  });
  stickyIssues.add("disk-space");
  return true;
}

function repositoryIssueId(repo: string): string {
  return `repository-access:${repo}`;
}

export function reportRepositoryUnavailable(repo: string): void {
  setIssue({
    id: repositoryIssueId(repo),
    kind: "repository-access",
    title: "Repository access changed",
    message: `GitHub no longer permits searches for ${repo}. Cached pull requests remain available until you reconnect or remove the repository.`,
    repo,
  });
}

export function clearRepositoryUnavailable(repo: string): void {
  issues.delete(repositoryIssueId(repo));
}

export function clearRepositoryIssues(): void {
  for (const [id, issue] of issues) {
    if (issue.kind === "repository-access") issues.delete(id);
  }
}

export function repositoryAvailable(repo: string): boolean {
  return !issues.has(repositoryIssueId(repo));
}

export function retrySystemIssue(id: string): void {
  stickyIssues.delete(id);
  issues.delete(id);
  checkLocalSystemIssues();
}

export function systemIssues(): SystemIssue[] {
  checkLocalSystemIssues();
  const priority: Record<SystemIssueKind, number> = {
    "missing-git": 0,
    "disk-space": 1,
    "repository-access": 2,
  };
  return [...issues.values()].sort((left, right) => priority[left.kind] - priority[right.kind] || left.id.localeCompare(right.id));
}
