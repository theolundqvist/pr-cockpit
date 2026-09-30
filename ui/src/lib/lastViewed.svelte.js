import { prKeyOf } from "./prKey.js";

const KEY = "pr-cockpit:last-viewed";

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? {};
  } catch {
    return {};
  }
}

// Reactive copy so inbox rows follow reads recorded by the open PR or another window.
export const lastViewed = $state({ all: readAll() });

// The commit anchor exists only once a head was recorded; a description-only entry is not a visit.
export function readLastViewed(repo, number) {
  const entry = readAll()[prKeyOf(repo, number)];
  return entry?.headSha ? entry : null;
}

// Head and description reads are recorded independently, so each write keeps the other's fields.
function updateLastViewed(repo, number, fields) {
  const all = readAll();
  const key = prKeyOf(repo, number);
  all[key] = { ...all[key], ...fields };
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {}
  lastViewed.all = all;
}

export function writeLastViewed(repo, number, headSha) {
  updateLastViewed(repo, number, { headSha, viewedAt: new Date().toISOString() });
}

export function writeDescriptionViewed(repo, number, descriptionDigest) {
  updateLastViewed(repo, number, { descriptionDigest });
}

// Registered for the page's lifetime: an inbox mounted later must not miss another window's reads.
window.addEventListener("storage", (event) => {
  if (event.storageArea === localStorage && (event.key === KEY || event.key === null)) lastViewed.all = readAll();
});
