import { prKeyOf } from "./prKey.js";

const KEY = "pr-cockpit:last-viewed";

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? {};
  } catch {
    return {};
  }
}

export function readLastViewed(repo, number) {
  return readAll()[prKeyOf(repo, number)] ?? null;
}

export function writeLastViewed(repo, number, headSha) {
  const all = readAll();
  all[prKeyOf(repo, number)] = { headSha, viewedAt: new Date().toISOString() };
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {}
}
