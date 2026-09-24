import { prKeyOf } from "./prKey.ts";

// Relay events refresh untracked PRs only while the user is plausibly looking at them. The
// renderer re-reads an open PR after every change it is told about, so an active view keeps
// renewing itself; the cap bounds the GraphQL spend of a busy repository.
const VIEW_WINDOW_MS = 30 * 60_000;
const MAX_VIEWED_PRS = 5;

export function createRecentPrViews(now: () => number = Date.now, windowMs = VIEW_WINDOW_MS, maxViewed = MAX_VIEWED_PRS) {
  const viewedAt = new Map<string, number>();
  return {
    note(repo: string, number: number): void {
      const key = prKeyOf(repo, number);
      viewedAt.delete(key);
      viewedAt.set(key, now());
      for (const oldest of viewedAt.keys()) {
        if (viewedAt.size <= maxViewed) break;
        viewedAt.delete(oldest);
      }
    },
    has(repo: string, number: number): boolean {
      const at = viewedAt.get(prKeyOf(repo, number));
      return at !== undefined && now() - at < windowMs;
    },
  };
}

const recentPrViews = createRecentPrViews();

export function notePrViewed(repo: string, number: number): void {
  recentPrViews.note(repo, number);
}

export function prViewedRecently(repo: string, number: number): boolean {
  return recentPrViews.has(repo, number);
}
