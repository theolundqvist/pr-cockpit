import { expect, test } from "bun:test";
import { customOpenedRange, filterByOpened, openedBounds, parseLocalDateTime, sortByTime } from "./prTime.js";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const at = (ms) => new Date(ms).toISOString();
const numbers = (prs) => prs.map((pr) => pr.number);

test("rolling 24 hours keeps the exact boundary and drops unknown or older opens", () => {
  const prs = [
    { number: 1, createdAt: at(NOW - 24 * HOUR) },
    { number: 2, createdAt: at(NOW - 24 * HOUR - 1) },
    { number: 3, createdAt: null },
    { number: 4, createdAt: "not a date" },
    { number: 5, createdAt: at(NOW) },
  ];
  expect(numbers(filterByOpened(prs, openedBounds("24h", NOW)))).toEqual([1, 5]);
  expect(filterByOpened(prs, openedBounds("all", NOW))).toBe(prs);
});

test("custom bounds include both endpoints through the chosen minute", () => {
  const { range } = customOpenedRange("2026-10-01T09:00", "2026-10-01T10:00");
  const start = new Date(2026, 9, 1, 9, 0).getTime();
  const end = new Date(2026, 9, 1, 10, 0).getTime();
  const prs = [
    { number: 1, createdAt: at(start - 1) },
    { number: 2, createdAt: at(start) },
    { number: 3, createdAt: at(end + 59_999) },
    { number: 4, createdAt: at(end + 60_000) },
  ];
  expect(numbers(filterByOpened(prs, openedBounds(range, NOW)))).toEqual([2, 3]);
});

test("custom ranges may be open-ended on either side", () => {
  const from = customOpenedRange("2026-10-01T09:00", "").range;
  const to = customOpenedRange("", "2026-10-01T09:00").range;
  expect(from).toEqual({ from: new Date(2026, 9, 1, 9, 0).getTime(), to: null });
  expect(to).toEqual({ from: null, to: new Date(2026, 9, 1, 9, 0).getTime() + 59_999 });
});

test("invalid, empty and reversed custom ranges never produce a range", () => {
  expect(customOpenedRange("", "").range).toBeUndefined();
  expect(customOpenedRange("2026-02-30T10:00", "").range).toBeUndefined();
  expect(customOpenedRange("2026-10-01", "").range).toBeUndefined();
  expect(customOpenedRange("2026-10-01T10:01", "2026-10-01T10:00").range).toBeUndefined();
  expect(customOpenedRange("2026-10-01T10:00", "2026-10-01T10:00").range).toBeDefined();
  expect(parseLocalDateTime("2026-10-01T10:00:30")).toEqual({
    start: new Date(2026, 9, 1, 10, 0, 30).getTime(),
    end: new Date(2026, 9, 1, 10, 0, 30).getTime() + 999,
  });
});

test("timestamp orders put unknown times last and keep ties in incoming order", () => {
  const prs = [
    { number: 10, createdAt: null, updatedAt: at(NOW - 3 * HOUR) },
    { number: 11, createdAt: at(NOW - 2 * HOUR), updatedAt: at(NOW - HOUR) },
    { number: 12, createdAt: at(NOW - 5 * HOUR), updatedAt: null },
    { number: 13, createdAt: at(NOW - 2 * HOUR), updatedAt: at(NOW - 4 * HOUR) },
    { number: 14, createdAt: null, updatedAt: at(NOW - HOUR) },
  ];
  expect(numbers(sortByTime(prs, "newest"))).toEqual([11, 13, 12, 10, 14]);
  expect(numbers(sortByTime(prs, "oldest"))).toEqual([12, 11, 13, 10, 14]);
  expect(numbers(sortByTime(prs, "updated"))).toEqual([11, 14, 10, 13, 12]);
  expect(numbers(sortByTime(prs, "stale"))).toEqual([13, 10, 11, 14, 12]);
  expect(numbers(prs)).toEqual([10, 11, 12, 13, 14]);
  expect(sortByTime(prs, "queue")).toBe(prs);
});
