import { prKey } from "./prKey.js";
import { timestamp } from "./prTime.js";

// Browsers fire a longer setTimeout delay immediately, so a far reminder wakes early and reschedules.
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

const NO_MARKS = new Map();

// Any entry returns once an agent marks its PR ready for review after it was set aside; legacy
// entries without `asideAt` predate every mark. A reminder also returns at its time, or earlier
// once its PR shows activity newer than the snapshot taken when it was set aside. Other entries
// stay until brought back.
export function reminderDue(item, now, activity, marks = NO_MARKS) {
  const markedAt = marks.get(prKey(item));
  if (markedAt !== undefined && (item.asideAt === undefined || markedAt > item.asideAt)) return true;
  if (item.remindAt === undefined) return false;
  if (item.remindAt <= now) return true;
  const latest = activity.get(prKey(item));
  return item.reminderActivityAt !== undefined && latest !== undefined && latest > item.reminderActivityAt;
}

export const pruneDue = (items, now, activity, marks) => items.filter((item) => !reminderDue(item, now, activity, marks));

export function nextReminderDelay(items, now) {
  let next = Infinity;
  for (const item of items) if (item.remindAt !== undefined && item.remindAt < next) next = item.remindAt;
  return next === Infinity ? null : Math.min(Math.max(next - now, 0), MAX_TIMEOUT_MS);
}

// Keeps the newest timestamp in `field` seen per PR; lists may repeat a PR with older copies.
export function recordActivity(activity, prs, field = "updatedAt") {
  for (const pr of prs) {
    const at = timestamp(pr[field]);
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
