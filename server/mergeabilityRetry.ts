import type { GithubUsageSource } from "./githubUsage.ts";
import { prKeyOf } from "./prKey.ts";

// GitHub answers UNKNOWN until it has computed mergeability, which it starts only once asked, and
// no event announces the answer. It usually lands within seconds, so ask again soon, then back off.
const MERGEABILITY_RETRY_DELAYS_MS = [3_000, 6_000, 12_000, 24_000, 30_000];

export type MergeabilityFields = { state?: string; isDraft?: boolean; mergeable?: string; mergeStateStatus?: string };

export function mergeabilityPending(detail: MergeabilityFields): boolean {
  return detail.state === "OPEN" && !detail.isDraft && (detail.mergeable === "UNKNOWN" || detail.mergeStateStatus === "UNKNOWN");
}

type Chain = { attempt: number; timer: ReturnType<typeof setTimeout> | null };

// Returns the observer every stored refresh reports to. A refresh that finds UNKNOWN starts one chain
// of retries; refreshes during a chain, including its own, only end it once mergeability resolves.
export function createMergeabilityRetry(
  retry: (repo: string, number: number, source: GithubUsageSource) => Promise<unknown>,
  delays: readonly number[] = MERGEABILITY_RETRY_DELAYS_MS,
): (repo: string, number: number, detail: MergeabilityFields, source: GithubUsageSource) => void {
  const chains = new Map<string, Chain>();
  const schedule = (repo: string, number: number, source: GithubUsageSource, chain: Chain) => {
    const key = prKeyOf(repo, number);
    chain.timer = setTimeout(async () => {
      chain.timer = null;
      try {
        await retry(repo, number, source);
      } catch (error) {
        console.error(`mergeability retry failed for ${key}:`, error);
        if (chains.get(key) === chain) chains.delete(key);
        return;
      }
      if (chains.get(key) !== chain) return;
      chain.attempt++;
      if (chain.attempt < delays.length) schedule(repo, number, source, chain);
      else chains.delete(key);
    }, delays[chain.attempt]);
    chain.timer.unref?.();
  };
  return (repo, number, detail, source) => {
    const key = prKeyOf(repo, number);
    const chain = chains.get(key);
    if (!mergeabilityPending(detail)) {
      if (chain?.timer) clearTimeout(chain.timer);
      chains.delete(key);
      return;
    }
    if (chain) return;
    const started: Chain = { attempt: 0, timer: null };
    chains.set(key, started);
    schedule(repo, number, source, started);
  };
}
