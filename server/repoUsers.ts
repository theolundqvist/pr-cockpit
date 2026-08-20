import { getRepoUsers, setRepoUsers, type RepoUserRow } from "./db.ts";
import { fetchAssignableUsers } from "./github.ts";

const TTL_MS = 60 * 60_000;
const inFlight = new Map<string, Promise<void>>();

export function refreshRepoUsers(repo: string): Promise<void> {
  const existing = inFlight.get(repo);
  if (existing) return existing;
  const promise = fetchAssignableUsers(repo)
    .then((users) => setRepoUsers(repo, users, new Date().toISOString()))
    .finally(() => inFlight.delete(repo));
  inFlight.set(repo, promise);
  return promise;
}

// always answers instantly from cache; kicks a background refresh when stale or empty, never blocks the caller on it
export function repoUsersCached(repo: string): RepoUserRow[] {
  const rows = getRepoUsers(repo);
  const stale = rows.length === 0 || Date.now() - new Date(rows[0]!.fetched_at).getTime() > TTL_MS;
  if (stale) refreshRepoUsers(repo).catch((err) => console.error(`repo-users refresh failed for ${repo}:`, err));
  return rows;
}
