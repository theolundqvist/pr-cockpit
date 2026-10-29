import { describe, expect, test } from "bun:test";
import { MAX_TIMEOUT_MS, nextReminderDelay, pruneDue, recordActivity, reminderDue, undoChanges } from "./setAsideReminders.js";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const pr = (number, fields = {}) => ({ repo: "acme/app", number, title: `PR ${number}`, author: "octo", ...fields });

describe("reminderDue", () => {
  test("indefinite entries never expire", () => {
    expect(reminderDue(pr(1), NOW, new Map([["acme/app#1", NOW]]))).toBe(false);
  });

  test("a reminder is due at its time, not before", () => {
    expect(reminderDue(pr(1, { remindAt: NOW }), NOW, new Map())).toBe(true);
    expect(reminderDue(pr(1, { remindAt: NOW + 1 }), NOW, new Map())).toBe(false);
  });

  test("newer activity than the snapshot returns it early", () => {
    const item = pr(1, { remindAt: NOW + 60_000, reminderActivityAt: NOW - 1000 });
    expect(reminderDue(item, NOW, new Map([["acme/app#1", NOW - 1000]]))).toBe(false);
    expect(reminderDue(item, NOW, new Map([["acme/app#1", NOW - 999]]))).toBe(true);
    expect(reminderDue(item, NOW, new Map([["acme/app#2", NOW]]))).toBe(false);
  });

  test("a reminder without a snapshot waits for its time", () => {
    expect(reminderDue(pr(1, { remindAt: NOW + 60_000 }), NOW, new Map([["acme/app#1", NOW]]))).toBe(false);
  });
});

test("pruneDue keeps indefinite and future entries in order", () => {
  const items = [pr(1, { remindAt: NOW - 1 }), pr(2), pr(3, { remindAt: NOW + 1 }), pr(4, { remindAt: NOW })];
  expect(pruneDue(items, NOW, new Map()).map((item) => item.number)).toEqual([2, 3]);
});

describe("nextReminderDelay", () => {
  test("no reminders schedules nothing", () => {
    expect(nextReminderDelay([pr(1)], NOW)).toBeNull();
    expect(nextReminderDelay([], NOW)).toBeNull();
  });

  test("waits only for the earliest reminder", () => {
    expect(nextReminderDelay([pr(1, { remindAt: NOW + 5000 }), pr(2, { remindAt: NOW + 2000 }), pr(3)], NOW)).toBe(2000);
  });

  test("past reminders fire immediately and far ones wake within the timer limit", () => {
    expect(nextReminderDelay([pr(1, { remindAt: NOW - 5000 })], NOW)).toBe(0);
    expect(nextReminderDelay([pr(1, { remindAt: NOW + 2 ** 31 + 10_000 })], NOW)).toBe(MAX_TIMEOUT_MS);
    expect(MAX_TIMEOUT_MS).toBe(2 ** 31 - 1);
  });
});

test("recordActivity keeps the newest valid updatedAt per PR", () => {
  const activity = new Map();
  recordActivity(activity, [
    pr(1, { updatedAt: "2026-10-29T12:00:00Z" }),
    pr(1, { updatedAt: "2026-10-29T11:00:00Z" }),
    pr(2, { updatedAt: "not a date" }),
    pr(3),
  ]);
  expect([...activity]).toEqual([["acme/app#1", NOW]]);
  recordActivity(activity, [pr(4, { updatedAt: "2026-10-29T11:00:00Z" }), pr(4, { updatedAt: "2026-10-29T12:00:00Z" })]);
  expect(activity.get("acme/app#4")).toBe(NOW);
});

describe("undoChanges", () => {
  test("undoing a new reminder removes it", () => {
    const before = [pr(1)];
    const after = [pr(1), pr(2, { remindAt: NOW + 1000 })];
    expect(undoChanges([...after, pr(3)], before, after)).toEqual([pr(1), pr(3)]);
  });

  test("undoing a reminder over an existing entry restores its earlier metadata in place", () => {
    const before = [pr(1), pr(2, { remindAt: NOW + 1000, reminderActivityAt: NOW - 5 })];
    const after = [pr(1), pr(2, { remindAt: NOW + 9000, reminderActivityAt: NOW })];
    expect(undoChanges(after, before, after)).toEqual(before);
    const indefinite = [pr(2)];
    expect(undoChanges([pr(2, { remindAt: NOW + 9000 })], indefinite, [pr(2, { remindAt: NOW + 9000 })])).toEqual(indefinite);
  });

  test("undoing a bring-back restores the reminder with its metadata", () => {
    const reminded = pr(2, { remindAt: NOW + 1000, reminderActivityAt: NOW - 5 });
    expect(undoChanges([pr(1)], [pr(1), reminded], [pr(1)])).toEqual([pr(1), reminded]);
  });

  test("entries the action did not touch keep their current state", () => {
    const before = [pr(1), pr(2)];
    const after = [pr(1)];
    const current = [pr(1, { remindAt: NOW + 1000 })];
    expect(undoChanges(current, before, after)).toEqual([pr(1, { remindAt: NOW + 1000 }), pr(2)]);
  });
});
