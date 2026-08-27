import type { GithubUsageSource } from "./githubUsage.ts";

import { prKeyOf } from "./prKey.ts";

export type PrRefresh = (
  repo: string,
  number: number,
  source?: GithubUsageSource,
) => Promise<unknown>;

interface RefreshState {
  trailing: boolean;
  trailingSource: GithubUsageSource | null;
  promise: Promise<void>;
}

export function createPrRefreshScheduler(refresh: PrRefresh): PrRefresh {
  const refreshes = new Map<string, RefreshState>();

  return (repo, number, source = "app detail") => {
    const key = prKeyOf(repo, number);
    const running = refreshes.get(key);
    if (running) {
      running.trailing = true;
      running.trailingSource = source;
      return running.promise;
    }

    const state: RefreshState = {
      trailing: false,
      trailingSource: null,
      promise: Promise.resolve(),
    };
    state.promise = (async () => {
      let failed = false;
      let failure: unknown;
      let nextSource = source;
      do {
        failed = false;
        failure = undefined;
        state.trailing = false;
        state.trailingSource = null;
        try {
          await refresh(repo, number, nextSource);
        } catch (error) {
          failed = true;
          failure = error;
        }
        nextSource = state.trailingSource ?? nextSource;
      } while (state.trailing);
      if (failed) throw failure;
    })().finally(() => {
      if (refreshes.get(key) === state) refreshes.delete(key);
    });
    refreshes.set(key, state);
    return state.promise;
  };
}
