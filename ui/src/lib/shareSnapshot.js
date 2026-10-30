// API snapshots are plain JSON. Retain unchanged branches so a metadata refresh
// doesn't invalidate every comment, diff hunk, and reaction in a long discussion.
export function shareSnapshot(previous, next) {
  if (previous === next) return previous;
  if (!previous || !next || typeof previous !== "object" || typeof next !== "object"
    || Array.isArray(previous) !== Array.isArray(next)) return next;
  const keys = Object.keys(next);
  let unchanged = keys.length === Object.keys(previous).length;
  let shared;
  for (const key of keys) {
    const value = shareSnapshot(previous[key], next[key]);
    if (value !== next[key]) {
      shared ??= Array.isArray(next) ? next.slice() : { ...next };
      Object.defineProperty(shared, key, { value, enumerable: true, writable: true, configurable: true });
    }
    if (!Object.hasOwn(previous, key) || value !== previous[key]) unchanged = false;
  }
  return unchanged ? previous : shared ?? next;
}
