import { expect, test } from "bun:test";
import { cacheGeneratedPaths, cachedGeneratedPaths, diffCacheKey, prDiffRange } from "./detailCache.js";

test("the PR diff and an explicit range over the same commits keep separate generated paths", () => {
  const base = "b".repeat(40);
  const head = "c".repeat(40);
  const detail = { baseRefOid: base, headRefOid: head };
  const own = diffCacheKey("example/widgets", 7, prDiffRange(detail));
  const explicit = diffCacheKey("example/widgets", 7, { base, head, mode: "two-dot" });
  cacheGeneratedPaths(own, new Set(["merge-base.lock"]));

  expect(cachedGeneratedPaths(explicit)).toBeNull();
  expect(cachedGeneratedPaths(diffCacheKey("example/widgets", 7, prDiffRange({ ...detail, baseRefOid: "d".repeat(40) })))).toBeNull();
  expect(cachedGeneratedPaths(diffCacheKey("example/widgets", 7, prDiffRange({ headRefOid: head })))).toBeNull();
  expect([...cachedGeneratedPaths(own)]).toEqual(["merge-base.lock"]);
});
