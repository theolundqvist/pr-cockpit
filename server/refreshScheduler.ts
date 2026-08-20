import { prKeyOf } from "./prKey.ts";

export type PrRefresh = (repo: string, number: number) => Promise<unknown>;

type RefreshState = {
  trailing: boolean;
  promise: Promise<void>;
};

export function createPrRefreshScheduler(refresh: PrRefresh): PrRefresh {
  const refreshes = new Map<string, RefreshState>();

  return (repo, number) => {
    const key = prKeyOf(repo, number);
    const running = refreshes.get(key);
    if (running) {
      running.trailing = true;
      return running.promise;
    }

    const state: RefreshState = { trailing: false, promise: Promise.resolve() };
    state.promise = (async () => {
      let failed = false;
      let failure: unknown;
      do {
        state.trailing = false;
        failed = false;
        try {
          await refresh(repo, number);
        } catch (err) {
          failed = true;
          failure = err;
        }
      } while (state.trailing);
      if (failed) throw failure;
    })().finally(() => {
      if (refreshes.get(key) === state) refreshes.delete(key);
    });
    refreshes.set(key, state);
    return state.promise;
  };
}
