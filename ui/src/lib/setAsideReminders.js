import { prKey } from "./prKey.js";
import { timestamp } from "./prTime.js";

// Browsers fire a longer setTimeout delay immediately, so a far reminder wakes early and reschedules.
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

// A reminder returns at its time, or earlier once its PR shows activity newer than the snapshot
// taken when it was set aside. Entries without a reminder stay until brought back.
export function reminderDue(item, now, activity) {
  if (item.remindAt === undefined) return false;
  if (item.remindAt <= now) return true;
  const latest = activity.get(prKey(item));
  return item.reminderActivityAt !== undefined && latest !== undefined && latest > item.reminderActivityAt;
}

export const pruneDue = (items, now, activity) => items.filter((item) => !reminderDue(item, now, activity));

export function nextReminderDelay(items, now) {
  let next = Infinity;
  for (const item of items) if (item.remindAt !== undefined && item.remindAt < next) next = item.remindAt;
  return next === Infinity ? null : Math.min(Math.max(next - now, 0), MAX_TIMEOUT_MS);
}

// Keeps the newest `updatedAt` seen per PR; lists may repeat a PR with older copies.
export function recordActivity(activity, prs) {
  for (const pr of prs) {
    const at = timestamp(pr.updatedAt);
    const key = prKey(pr);
    if (at !== null && !(activity.get(key) >= at)) activity.set(key, at);
  }
}

// Undo puts back the earlier version of every entry an action added, removed, or changed, and
// leaves entries the action did not touch as they are now.
export function undoChanges(current, before, after) {
  const beforeByKey = new Map(before.map((item) => [prKey(item), item]));
  const afterByKey = new Map(after.map((item) => [prKey(item), item]));
  const changed = new Set([...beforeByKey.keys(), ...afterByKey.keys()]
    .filter((key) => JSON.stringify(beforeByKey.get(key)) !== JSON.stringify(afterByKey.get(key))));
  const restored = current.flatMap((item) => {
    const key = prKey(item);
    if (!changed.has(key)) return [item];
    return beforeByKey.has(key) ? [beforeByKey.get(key)] : [];
  });
  const keys = new Set(restored.map(prKey));
  return [...restored, ...before.filter((item) => changed.has(prKey(item)) && !keys.has(prKey(item)))];
}
