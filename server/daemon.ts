export interface Worktree {
  path: string;
  repo: string;
  branch: string;
  windowId: string;
  state: string;
  prNumber: number | null;
  prUrl: string | null;
  lastWebhookAt?: number | null;
  headRefOid?: string | null;
  baseRefName?: string | null;
  baseRefOid?: string | null;
  mergeable?: string | null;
  mergeStateStatus?: string | null;
  lastWebhookEvent?: string | null;
}

export interface Registration {
  repo: string;
  number: number;
  state: string;
  lastWebhookAt?: number | null;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  baseRefOid?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  lastWebhookEvent?: string;
}

export interface DaemonStatus {
  repos: string[];
  worktrees: Worktree[];
  registrations?: Record<string, Registration>;
}

const DAEMON_URL = Bun.env.COCKPIT_DAEMON_URL ?? "http://127.0.0.1:47291/status";

export async function fetchDaemonStatus(): Promise<DaemonStatus | null> {
  try {
    const res = await fetch(DAEMON_URL, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return (await res.json()) as DaemonStatus;
  } catch {
    return null;
  }
}
