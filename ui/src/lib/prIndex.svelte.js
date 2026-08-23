import { prKey, prKeyOf } from "./prKey.js";

let records = $state(new Map());
let started = false;
let loaded = false;
let resolving = false;
let resolveTimer = null;
const missing = new Map();
const exhausted = new Set();
const MAX_RESOLVE_ATTEMPTS = 3;

function mergeRecords(prs, replace = false) {
  const next = replace ? new Map() : new Map(records);
  for (const pr of prs) {
    const key = prKey(pr);
    next.set(key, pr);
    missing.delete(key);
    exhausted.delete(key);
  }
  records = next;
}

function scheduleResolve(delay = 0) {
  if (!loaded || resolving || resolveTimer !== null || missing.size === 0) return;
  resolveTimer = setTimeout(resolveMissing, delay);
}

async function resolveMissing() {
  resolveTimer = null;
  if (resolving || missing.size === 0) return;
  resolving = true;
  const batch = [...missing.values()].slice(0, 100);
  for (const ref of batch) ref.attempts += 1;
  const params = new URLSearchParams({ keys: batch.map((ref) => ref.key).join(",") });
  try {
    const response = await fetch(`/api/pr-index?${params}`);
    if (!response.ok) throw new Error(`pr-index ${response.status}`);
    mergeRecords((await response.json()).prs);
  } catch {}
  for (const ref of batch) {
    if (ref.attempts < MAX_RESOLVE_ATTEMPTS || records.has(ref.key)) continue;
    missing.delete(ref.key);
    exhausted.add(ref.key);
  }
  resolving = false;
  scheduleResolve(2_000);
}

function rememberMissing(repo, number) {
  const key = prKeyOf(repo, number);
  if (exhausted.has(key)) return;
  if (!missing.has(key)) missing.set(key, { key, repo, number, attempts: 0 });
  scheduleResolve();
}

export function loadPrIndex() {
  if (started) return;
  started = true;
  fetch("/api/pr-index")
    .then((r) => {
      if (!r.ok) throw new Error(`pr-index ${r.status}`);
      return r.json();
    })
    .then(({ prs }) => mergeRecords(prs, true))
    .catch(() => {
      started = false;
    })
    .finally(() => {
      loaded = true;
      scheduleResolve();
    });
}

export function prTitle(repo, number) {
  const title = records.get(prKeyOf(repo, number))?.title ?? null;
  if (!title) rememberMissing(repo, number);
  return title;
}

export function prSummary(repo, number) {
  const summary = records.get(prKeyOf(repo, number)) ?? null;
  if (!summary) rememberMissing(repo, number);
  return summary;
}
