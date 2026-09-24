// Runs task over items with at most `limit` in flight. Rejects with the first failure only after
// every started task settles, so no task keeps writing to the cache after the caller moved on.
export async function forEachWithConcurrency<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await task(items[next++]!);
  });
  const results = await Promise.allSettled(workers);
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw (failure as PromiseRejectedResult).reason;
}
