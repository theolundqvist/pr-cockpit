// stale-while-revalidate store: last-seen detail per PR, shown instantly while a fetch refreshes
const DETAIL_CACHE_MAX = 100;
const DIFF_CACHE_BYTES = 50 * 1024 * 1024;
const details = new Map();
const diffs = new Map();
const diffIndexes = new Map();
let diffBytes = 0;

export function getDetail(key) {
  return details.get(key) ?? null;
}

export function cacheDetail(key, detail) {
  details.delete(key);
  details.set(key, detail);
  if (details.size > DETAIL_CACHE_MAX) details.delete(details.keys().next().value);
}

export function cachedHeadSha(key) {
  return details.get(key)?.headRefOid ?? null;
}

// A PR diff at one head never changes, so cached bytes and their file index need no revalidation.
export function diffCacheKey(repo, number, base, head) {
  return `${repo}#${number}#${base}#${head}`;
}

export function cachedDiff(key) {
  const bytes = diffs.get(key);
  if (!bytes) return null;
  diffs.delete(key);
  diffs.set(key, bytes);
  return bytes;
}

export function cachedDiffIndex(key, bytes) {
  return diffs.get(key) === bytes ? (diffIndexes.get(key) ?? null) : null;
}

export function cacheDiffIndex(key, bytes, files) {
  if (diffs.get(key) === bytes) diffIndexes.set(key, files);
}

export function cacheDiff(key, bytes) {
  if (bytes.byteLength > DIFF_CACHE_BYTES) return;
  diffBytes -= diffs.get(key)?.byteLength ?? 0;
  diffs.delete(key);
  diffIndexes.delete(key);
  diffs.set(key, bytes);
  diffBytes += bytes.byteLength;
  while (diffBytes > DIFF_CACHE_BYTES) {
    const [oldest, evicted] = diffs.entries().next().value;
    diffs.delete(oldest);
    diffIndexes.delete(oldest);
    diffBytes -= evicted.byteLength;
  }
}

// last response per remounting view, painted on mount while the view refetches
const VIEW_CACHE_MAX = 50;
const views = new Map();

export function cachedView(key) {
  return views.get(key) ?? null;
}

export function cacheView(key, value) {
  views.delete(key);
  views.set(key, value);
  if (views.size > VIEW_CACHE_MAX) views.delete(views.keys().next().value);
}
