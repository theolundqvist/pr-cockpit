// stale-while-revalidate store: last-seen detail per PR, shown instantly while a fetch refreshes
const DETAIL_CACHE_MAX = 100;
const details = new Map();

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
