import type { PrDetailScope } from "./github.ts";
import { prKeyOf } from "./prKey.ts";

// CI emits one check event per job transition; one trailing refresh keeps the cache current
// without spending GraphQL points on every marker.
const EVENT_REFRESH_THROTTLE_MS = 30_000;

type Refresh = (repo: string, number: number, scope: PrDetailScope) => Promise<void>;
type EventRefresh = (repo: string, number: number, scope: PrDetailScope, refresh: Refresh) => Promise<void>;

function combineScopes(left: PrDetailScope | undefined, right: PrDetailScope): PrDetailScope {
  if (left === undefined || left === right) return right;
  return "all";
}

export function prDetailScopeForEvent(event: string): PrDetailScope {
  if (event === "status" || event.startsWith("check_") || event.startsWith("workflow_")) return "checks";
  if (event === "issue_comment" || event.startsWith("pull_request_review")) return "review";
  return "all";
}

export function createEventRefreshThrottle(intervalMs = EVENT_REFRESH_THROTTLE_MS): EventRefresh {
  const lastRefreshAt = new Map<string, number>();
  const pendingRefresh = new Map<string, Promise<void>>();
  const pendingScope = new Map<string, PrDetailScope>();

  return (repo, number, scope, refresh) => {
    const key = prKeyOf(repo, number);
    const run = async (nextScope: PrDetailScope) => {
      lastRefreshAt.set(key, Date.now());
      await refresh(repo, number, nextScope);
    };
    const sinceLast = Date.now() - (lastRefreshAt.get(key) ?? 0);
    if (sinceLast >= intervalMs) return run(scope);

    const pending = pendingRefresh.get(key);
    if (pending) {
      pendingScope.set(key, combineScopes(pendingScope.get(key), scope));
      return pending;
    }
    pendingScope.set(key, scope);
    let trailing: Promise<void>;
    trailing = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        const nextScope = pendingScope.get(key) ?? scope;
        pendingScope.delete(key);
        void run(nextScope).then(resolve, reject);
      }, intervalMs - sinceLast);
    }).finally(() => {
      if (pendingRefresh.get(key) === trailing) pendingRefresh.delete(key);
      pendingScope.delete(key);
    });
    pendingRefresh.set(key, trailing);
    return trailing;
  };
}

export const refreshPrFromEvent = createEventRefreshThrottle();

// Repository-wide events arrive in bursts. Dropping the ones inside the debounce window left the
// last change of a burst waiting for the scheduled poll, so a request during the window or during
// a running poll earns exactly one trailing poll instead.
export function createPollRequester(
  poll: () => Promise<unknown>,
  intervalMs: number,
  onError: (error: unknown) => void,
): () => void {
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  let running = false;
  let requestedWhileRunning = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const start = () => {
    timer = null;
    running = true;
    requestedWhileRunning = false;
    lastStartedAt = Date.now();
    void poll().catch(onError).finally(() => {
      running = false;
      if (requestedWhileRunning) schedule();
    });
  };
  const schedule = () => {
    if (timer !== null) return;
    const wait = lastStartedAt + intervalMs - Date.now();
    if (wait <= 0) start();
    else timer = setTimeout(start, wait);
  };
  return () => {
    if (running) requestedWhileRunning = true;
    else schedule();
  };
}
