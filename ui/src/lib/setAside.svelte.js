import { prKey } from "./prKey.js";
import { showFlash } from "./flash.svelte.js";
import { recordUndo, clearUndo } from "./undo.js";
import { nextReminderDelay, pruneDue, recordActivity, undoChanges } from "./setAsideReminders.js";

const STORAGE_KEY = "cockpit:set-aside:v1";

function readItems() {
  const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  if (!Array.isArray(value)) throw new Error("Invalid set-aside list");
  return value.filter((pr) => pr && typeof pr.repo === "string" && /^[^/]+\/[^/]+$/.test(pr.repo)
    && Number.isSafeInteger(pr.number) && pr.number > 0 && typeof pr.title === "string"
    && (pr.remindAt === undefined || Number.isSafeInteger(pr.remindAt))
    && (pr.asideAt === undefined || Number.isSafeInteger(pr.asideAt))
    && (pr.reminderActivityAt === undefined || Number.isFinite(pr.reminderActivityAt)));
}

export const setAside = $state({ items: [], open: false });
export const isSetAside = (pr) => setAside.items.some((item) => prKey(item) === prKey(pr));

// Newest PR activity and ready-for-review mark this window has seen, so a restored or re-read
// entry still returns early.
const activity = new Map();
const marks = new Map();
let timer = null;

// Only the earliest reminder holds a timer; each refresh reschedules from the remaining list. An
// unchanged list keeps its identity so frequent PR reconciles don't re-render the inbox.
function setItems(items) {
  if (JSON.stringify(items) !== JSON.stringify(setAside.items)) setAside.items = items;
  clearTimeout(timer);
  const delay = nextReminderDelay(items, Date.now());
  timer = delay === null ? null : setTimeout(refreshItems, delay);
}

// Due reminders leave storage, not just the view. If that write fails they still return here
// rather than staying hidden.
function refreshItems() {
  const now = Date.now();
  let stored;
  try { stored = readItems(); } catch {
    setItems(pruneDue(setAside.items, now, activity, marks));
    return false;
  }
  const items = pruneDue(stored, now, activity, marks);
  let saved = true;
  if (items.length !== stored.length) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch {
      showFlash("Couldn't save Set Aside. Reminded PRs are back here, but other windows may still hide them.");
      saved = false;
    }
  }
  setItems(items);
  return saved;
}

// Read before writing so another window's latest changes are retained. A failed
// write never hides a PR: the persisted list is the source of truth.
function updateItems(transform, remember = true) {
  try {
    const now = Date.now();
    const before = pruneDue(readItems(), now, activity, marks);
    const items = pruneDue(transform(before), now, activity, marks);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    setItems(items);
    if (remember && JSON.stringify(items) !== JSON.stringify(before)) {
      recordUndo(STORAGE_KEY, () => updateItems((current) => undoChanges(current, before, items), false));
    }
    return true;
  } catch {
    showFlash("Couldn't save Set Aside. Your PRs haven't moved. Please try again.");
    return false;
  }
}

function asideItem(pr) {
  return {
    repo: pr.repo, number: pr.number, title: pr.title,
    author: typeof pr.author === "string" ? pr.author : pr.author?.login ?? "",
    asideAt: Date.now(),
  };
}

export function putAside(pr) {
  const item = asideItem(pr);
  return updateItems((items) => items.some((entry) => prKey(entry) === prKey(item)) ? items : [...items, item]);
}

// Replaces any existing entry for the PR, so a reminder can follow an indefinite set-aside or
// another reminder. The activity snapshot is the newest `updatedAt` known for the PR.
export function remindLater(pr, remindAt) {
  if (!Number.isSafeInteger(remindAt) || remindAt <= Date.now()) {
    showFlash("Choose a reminder time in the future.");
    return false;
  }
  recordActivity(activity, [pr]);
  const item = { ...asideItem(pr), remindAt };
  const activityAt = activity.get(prKey(pr));
  if (activityAt !== undefined) item.reminderActivityAt = activityAt;
  return updateItems((items) => items.some((entry) => prKey(entry) === prKey(item))
    ? items.map((entry) => prKey(entry) === prKey(item) ? item : entry)
    : [...items, item]);
}

// Brings set-aside PRs back early once they are marked ready for review after being set aside, and
// reminded PRs once they show newer activity; not an undoable action. False when storage couldn't
// be read or the removal couldn't be saved.
export function reconcileReminders(prs) {
  recordActivity(activity, prs);
  recordActivity(marks, prs, "readyForReviewAt");
  return refreshItems();
}

export function bringBack(pr) {
  return updateItems((items) => items.filter((entry) => prKey(entry) !== prKey(pr)));
}

export function bringBackAll() {
  return updateItems(() => []);
}

export function syncSetAside(event) {
  if (event.storageArea === localStorage && (event.key === STORAGE_KEY || event.key === null)) {
    // Another window's reminder expiry matches this window's own; only a different list voids undo.
    const previous = JSON.stringify(pruneDue(setAside.items, Date.now(), activity, marks));
    refreshItems();
    if (JSON.stringify(setAside.items) !== previous) clearUndo(STORAGE_KEY);
  }
}

// Background timers are throttled, so a returning window checks immediately.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshItems();
});

refreshItems();
