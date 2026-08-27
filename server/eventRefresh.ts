import { prKeyOf } from "./prKey.ts";

// CI emits one check event per job transition; one trailing refresh keeps the cache current
// without spending GraphQL points on every marker.
const EVENT_REFRESH_THROTTLE_MS = 30_000;

type Refresh = (repo: string, number: number) => Promise<void>;
type EventRefresh = (repo: string, number: number, refresh: Refresh) => Promise<void>;

export function createEventRefreshThrottle(intervalMs = EVENT_REFRESH_THROTTLE_MS): EventRefresh {
  const lastRefreshAt = new Map<string, number>();
  const pendingRefresh = new Map<string, Promise<void>>();

  return (repo, number, refresh) => {
    const key = prKeyOf(repo, number);
    const run = async () => {
      lastRefreshAt.set(key, Date.now());
      await refresh(repo, number);
    };
    const sinceLast = Date.now() - (lastRefreshAt.get(key) ?? 0);
    if (sinceLast >= intervalMs) return run();

    const pending = pendingRefresh.get(key);
    if (pending) return pending;
    let trailing: Promise<void>;
    trailing = new Promise<void>((resolve, reject) => {
      setTimeout(() => void run().then(resolve, reject), intervalMs - sinceLast);
    }).finally(() => {
      if (pendingRefresh.get(key) === trailing) pendingRefresh.delete(key);
    });
    pendingRefresh.set(key, trailing);
    return trailing;
  };
}

export const refreshPrFromEvent = createEventRefreshThrottle();
