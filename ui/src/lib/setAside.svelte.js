import { prKey } from "./prKey.js";
import { showFlash } from "./flash.svelte.js";

const STORAGE_KEY = "cockpit:set-aside:v1";

function readItems() {
  const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  if (!Array.isArray(value)) throw new Error("Invalid set-aside list");
  return value.filter((pr) => pr && typeof pr.repo === "string" && /^[^/]+\/[^/]+$/.test(pr.repo)
    && Number.isSafeInteger(pr.number) && pr.number > 0 && typeof pr.title === "string");
}

function initialItems() {
  try { return readItems(); } catch { return []; }
}

export const setAside = $state({ items: initialItems(), open: false });
export const isSetAside = (pr) => setAside.items.some((item) => prKey(item) === prKey(pr));
const undoHistory = [];

// Read before writing so another window's latest changes are retained. A failed
// write never hides a PR: the persisted list is the source of truth.
function updateItems(transform, recordUndo = true) {
  try {
    const before = readItems();
    const items = transform(before);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    setAside.items = items;
    if (recordUndo) {
      const oldKeys = new Set(before.map(prKey));
      const newKeys = new Set(items.map(prKey));
      const added = items.filter((item) => !oldKeys.has(prKey(item)));
      const removed = before.filter((item) => !newKeys.has(prKey(item)));
      if (added.length || removed.length) undoHistory.push({ added, removed });
    }
    return true;
  } catch {
    showFlash("Couldn't save Set Aside. Your PRs haven't moved. Please try again.");
    return false;
  }
}

export function putAside(pr) {
  const item = {
    repo: pr.repo, number: pr.number, title: pr.title,
    author: typeof pr.author === "string" ? pr.author : pr.author?.login ?? "",
  };
  return updateItems((items) => items.some((entry) => prKey(entry) === prKey(item)) ? items : [...items, item]);
}

export function bringBack(pr) {
  return updateItems((items) => items.filter((entry) => prKey(entry) !== prKey(pr)));
}

export function bringBackAll() {
  return updateItems(() => []);
}

export function undoSetAside() {
  const change = undoHistory.at(-1);
  if (!change) return false;
  const { added, removed } = change;
  const addedKeys = new Set(added.map(prKey));
  if (!updateItems((items) => {
    const remaining = items.filter((item) => !addedKeys.has(prKey(item)));
    const keys = new Set(remaining.map(prKey));
    return [...remaining, ...removed.filter((item) => !keys.has(prKey(item)))];
  }, false)) return false;
  undoHistory.pop();
  return true;
}

export function syncSetAside(event) {
  if (event.storageArea === localStorage && (event.key === STORAGE_KEY || event.key === null)) {
    try { setAside.items = readItems(); undoHistory.length = 0; } catch { /* Keep the current list on corrupt storage. */ }
  }
}
