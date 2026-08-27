import type { GithubUsageSource } from "./githubUsage.ts";
import type { PrDetailScope } from "./github.ts";

import { prKeyOf } from "./prKey.ts";

export type PrRefresh = (
  repo: string,
  number: number,
  source?: GithubUsageSource,
  scope?: PrDetailScope,
) => Promise<unknown>;

interface RefreshState {
  trailing: boolean;
  trailingSource: GithubUsageSource | null;
  trailingScope: PrDetailScope | null;
  promise: Promise<void>;
}


function combineScopes(left: PrDetailScope | null, right: PrDetailScope): PrDetailScope {
  if (left === null || left === right) return right;
  return "all";
}
export function createPrRefreshScheduler(refresh: PrRefresh): PrRefresh {
  const refreshes = new Map<string, RefreshState>();

  return (repo, number, source = "app detail", scope = "all") => {
    const key = prKeyOf(repo, number);
    const running = refreshes.get(key);
    if (running) {
      running.trailing = true;
      running.trailingSource = source;
      running.trailingScope = combineScopes(running.trailingScope, scope);
      return running.promise;
    }

    const state: RefreshState = {
      trailing: false,
      trailingSource: null,
      promise: Promise.resolve(),
      trailingScope: null,
    };
    state.promise = (async () => {
      let failed = false;
      let failure: unknown;
      let nextSource = source;
      let nextScope = scope;
      do {
        failed = false;
        failure = undefined;
        state.trailing = false;
        state.trailingSource = null;
        state.trailingScope = null;
        try {
          await refresh(repo, number, nextSource, nextScope);
        } catch (error) {
          failed = true;
          failure = error;
        }
        nextSource = state.trailingSource ?? nextSource;
        nextScope = state.trailingScope ?? nextScope;
      } while (state.trailing);
      if (failed) throw failure;
    })().finally(() => {
      if (refreshes.get(key) === state) refreshes.delete(key);
    });
    refreshes.set(key, state);
    return state.promise;
  };
}
