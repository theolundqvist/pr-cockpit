import { fetchActionCommits, fetchActionGraph, fetchActions, fetchPrDetailSnapshot, fetchPrDiff } from "./api.js";
import { cachePrActionData, cachedPrActionData, prActionKey } from "./actionPrefetch.js";
import { cacheDetail, cacheDiff, cachedDiff, diffCacheKey, getDetail } from "./detailCache.js";
import { prKeyOf } from "./prKey.js";

// Warms the SWR caches behind each PR tab. One request at a time, in idle time unless a row is
// hovered or selected, and always `prefetch` so the server answers from local data only.
const EAGER_DIFF_BYTES = 2 * 1024 * 1024;
const MISS_RETRY_MS = 60_000;
let queue = [];
const misses = new Map();
let running = null;
let wake = 0;

export function whenIdle(run) {
  if (typeof requestIdleCallback !== "function") {
    const timer = setTimeout(run, 50);
    return () => clearTimeout(timer);
  }
  const handle = requestIdleCallback(run, { timeout: 2_000 });
  return () => cancelIdleCallback(handle);
}

function estimatedDiffBytes(pr) {
  const lines = (pr.rawAdditions ?? pr.additions ?? 0) + (pr.rawDeletions ?? pr.deletions ?? 0);
  return lines * 64 + (pr.changedFiles ?? 0) * 256;
}

function task(key, eager, loaded, load) {
  return { key, eager, loaded, load, urgent: false };
}

function tasksFor({ repo, number, headSha, ...size }, diff) {
  const detailKey = prKeyOf(repo, number);
  const tasks = [
    task(`detail:${detailKey}`, false, () => getDetail(detailKey) !== null, async () => {
      const snapshot = await fetchPrDetailSnapshot(repo, number, { prefetch: true });
      if (snapshot && !getDetail(detailKey)) cacheDetail(detailKey, snapshot.detail);
      return !!snapshot;
    }),
  ];
  if (!headSha) return tasks;
  if (diff) {
    const key = diffCacheKey(repo, number, headSha, headSha);
    tasks.push(task(`diff:${key}`, estimatedDiffBytes(size) <= EAGER_DIFF_BYTES, () => cachedDiff(key) !== null, async () => {
      const res = await fetchPrDiff(repo, number, { head: headSha }, null, true);
      if (res.ok) cacheDiff(key, res.bytes);
      return res.ok;
    }));
  }
  const actionKey = prActionKey(repo, number, headSha);
  const actionTask = (kind, load) =>
    task(`${kind}:${actionKey}`, true, () => cachedPrActionData(kind, actionKey) !== null, async () => {
      const value = await load();
      if (value && !cachedPrActionData(kind, actionKey)) cachePrActionData(kind, actionKey, value);
      return !!value;
    });
  tasks.push(
    actionTask("actions", () => fetchActions(repo, number, headSha, null, true)),
    actionTask("graph", () => fetchActionGraph(repo, number, headSha, null, true)),
    actionTask("commits", () => fetchActionCommits(repo, number, null, true)),
  );
  return tasks;
}

function wanted(candidate, now) {
  return candidate.key !== running && !candidate.loaded() && !(now - (misses.get(candidate.key) ?? -Infinity) < MISS_RETRY_MS);
}

// `urgent` is a hovered, selected, or open PR: it jumps the queue, runs without waiting for idle,
// and includes diffs too large to warm eagerly. Earlier urgent work drops back to idle priority.
export function preloadPr(pr, { urgent = false, diff = true } = {}) {
  const now = Date.now();
  const fresh = tasksFor(pr, diff).filter((candidate) => (urgent || candidate.eager) && wanted(candidate, now));
  const keys = new Set(fresh.map((candidate) => candidate.key));
  if (urgent) {
    queue = queue.filter((queued) => !keys.has(queued.key) && (queued.eager || !queued.urgent));
    for (const queued of queue) queued.urgent = false;
    for (const candidate of fresh) candidate.urgent = true;
    queue.unshift(...fresh);
  } else {
    const queued = new Set(queue.map((candidate) => candidate.key));
    queue.push(...fresh.filter((candidate) => !queued.has(candidate.key)));
  }
  pump();
}

function pump() {
  if (running !== null || queue.length === 0) return;
  const ticket = ++wake;
  const start = () => {
    if (ticket !== wake || running !== null) return;
    const next = queue.shift();
    if (!next) return;
    if (next.loaded()) return pump();
    running = next.key;
    next.load().then(
      (loaded) => (loaded ? misses.delete(next.key) : misses.set(next.key, Date.now())),
      () => misses.set(next.key, Date.now()),
    ).finally(() => {
      running = null;
      pump();
    });
  };
  if (queue[0].urgent) setTimeout(start);
  else whenIdle(start);
}
