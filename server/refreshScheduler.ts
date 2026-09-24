import type { GithubUsageSource } from "./githubUsage.ts";
import type { PrDetailScope } from "./github.ts";

import { prKeyOf } from "./prKey.ts";

export type PrRefresh = (
  repo: string,
  number: number,
  source?: GithubUsageSource,
  scope?: PrDetailScope,
) => Promise<unknown>;

// Resolves once the PR's detail is stored and published. `followUp` is the rest of the
// refresh (the Actions catalog), which the next refresh of the same PR does not wait for.
export type PrRefreshPhases = (
  repo: string,
  number: number,
  source?: GithubUsageSource,
  scope?: PrDetailScope,
) => Promise<{ followUp: Promise<void> } | void>;

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

// One detail refresh per PR at a time; signals that arrive meanwhile coalesce into a single
// trailing refresh, which starts once the running one's detail phase is done. The returned
// promise settles after every detail phase and follow-up it covers.
export function createPrRefreshScheduler(refresh: PrRefreshPhases): PrRefresh {
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
      const followUps: Promise<void>[] = [];
      do {
        failed = false;
        failure = undefined;
        state.trailing = false;
        state.trailingSource = null;
        state.trailingScope = null;
        try {
          const phases = await refresh(repo, number, nextSource, nextScope);
          if (phases) followUps.push(phases.followUp);
        } catch (error) {
          failed = true;
          failure = error;
        }
        nextSource = state.trailingSource ?? nextSource;
        nextScope = state.trailingScope ?? nextScope;
      } while (state.trailing);
      // A signal from here on starts a fresh refresh rather than waiting on these follow-ups.
      if (refreshes.get(key) === state) refreshes.delete(key);
      await Promise.all(followUps);
      if (failed) throw failure;
    })().finally(() => {
      if (refreshes.get(key) === state) refreshes.delete(key);
    });
    refreshes.set(key, state);
    return state.promise;
  };
}
