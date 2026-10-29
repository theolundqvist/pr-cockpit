import { expect, test } from "bun:test";
import { nlQueryToDateSuggestions } from "./reminderDate.ts";

const presetLabels = ["Tomorrow", "In 3 Days", "Next Week", "In 2 Weeks", "Next Month"];

test("defaults preserve order and cross the year boundary at local eight", () => {
  const now = new Date(2026, 11, 31, 23, 59, 59);
  const suggestions = nlQueryToDateSuggestions("", { now });
  expect(suggestions.map(({ label }) => label)).toEqual(presetLabels);
  expect(suggestions.map(({ date }) => date)).toEqual([
    new Date(2027, 0, 1, 8),
    new Date(2027, 0, 3, 8),
    new Date(2027, 0, 4, 8),
    new Date(2027, 0, 14, 8),
    new Date(2027, 0, 1, 8),
  ]);
});

test("default presets retain Scape's chrono adjustment across daylight-saving weekends", () => {
  for (const now of [new Date(2026, 2, 7, 23, 30), new Date(2026, 2, 28, 23, 30), new Date(2026, 9, 24, 23, 30)]) {
    const suggestions = nlQueryToDateSuggestions("", { now });
    expect(suggestions[0].date).toEqual(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8));
    for (const [index, offset] of [[1, 3], [3, 14]]) {
      const expected = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, 8);
      // Scape's default duration presets go through chrono 2.9.0, unlike typed durations:
      // its relative-day parser carries the reference offset across a DST transition.
      expected.setMinutes(expected.getMinutes() + now.getTimezoneOffset() - expected.getTimezoneOffset());
      expect(suggestions[index].date).toEqual(expected);
    }
  }
});

test("next week means the following Monday even when today is Monday", () => {
  for (const now of [new Date(2026, 9, 25, 23, 59), new Date(2026, 9, 26, 7), new Date(2026, 9, 26, 20)]) {
    const expected = now.getDay() === 0 ? new Date(2026, 9, 26, 8) : new Date(2026, 10, 2, 8);
    expect(nlQueryToDateSuggestions("", { now })[2].date).toEqual(expected);
    expect(nlQueryToDateSuggestions("next week", { now })[0].date).toEqual(expected);
  }
});

test("next month is its first day, including leap February and the year rollover", () => {
  for (const [now, expected] of [
    [new Date(2028, 0, 31, 23), new Date(2028, 1, 1, 8)],
    [new Date(2028, 1, 29, 23), new Date(2028, 2, 1, 8)],
    [new Date(2026, 11, 31, 23), new Date(2027, 0, 1, 8)],
  ]) {
    expect(nlQueryToDateSuggestions("", { now })[4].date).toEqual(expected);
    expect(nlQueryToDateSuggestions("next month", { now })[0].date).toEqual(expected);
  }
});

test("typed weekend periods resolve Saturday, not Sunday or an extra week", () => {
  for (const query of ["this weekend", "next weekend", "this weeke"]) {
    expect(nlQueryToDateSuggestions(query, { now: new Date(2026, 9, 30, 16) })[0].date).toEqual(new Date(2026, 9, 31, 8));
    expect(nlQueryToDateSuggestions(query, { now: new Date(2026, 10, 1, 16) })[0].date).toEqual(new Date(2026, 10, 7, 8));
  }
});

test("partial month and time input resolves a custom calendar date", () => {
  const suggestions = nlQueryToDateSuggestions("dec 31 3:3p", { now: new Date(2026, 9, 29, 12) });
  expect(suggestions).toEqual([
    { label: "December 31st at 3:30 PM", value: "december 31 at 3:30 pm", date: new Date(2026, 11, 31, 15, 30), timezone: null },
  ]);
  expect(nlQueryToDateSuggestions("tom", { now: new Date(2026, 11, 31, 23) })[0].date).toEqual(new Date(2027, 0, 1, 8));
});

test("partial digits keep future times only and order today before tomorrow", () => {
  const suggestions = nlQueryToDateSuggestions("3", { now: new Date(2026, 9, 29, 12) });
  expect(suggestions.map(({ date }) => date)).toEqual([
    new Date(2026, 9, 29, 15),
    new Date(2026, 9, 30, 3),
    new Date(2026, 9, 30, 15),
  ]);
});

test("ambiguous partial times are ordered by specificity then date and limited to five", () => {
  const now = new Date(2026, 9, 29, 0);
  const suggestions = nlQueryToDateSuggestions("1:", { now });
  expect(suggestions.map(({ date }) => date)).toEqual([
    new Date(2026, 9, 29, 1),
    new Date(2026, 9, 29, 1, 30),
    new Date(2026, 9, 29, 13),
    new Date(2026, 9, 29, 13, 30),
    new Date(2026, 9, 30, 1),
  ]);
});

test("duration alternatives resolving to the same minute produce one suggestion", () => {
  const suggestions = nlQueryToDateSuggestions("in 0", { now: new Date(2026, 9, 29, 7, 30) });
  expect(suggestions).toEqual([
    { label: "In 0 Days", value: "in 0 days", date: new Date(2026, 9, 29, 8), timezone: null },
  ]);
});

test("duration hours retain the current minute while calendar days reset to eight", () => {
  const now = new Date(2026, 11, 31, 23, 45, 12, 345);
  expect(nlQueryToDateSuggestions("in 2 hrs", { now })[0].date).toEqual(new Date(2027, 0, 1, 1, 45, 12, 345));
  expect(nlQueryToDateSuggestions("in 3 d", { now })[0].date).toEqual(new Date(2027, 0, 3, 8));
  expect(nlQueryToDateSuggestions("in 2 w", { now })[0].date).toEqual(new Date(2027, 0, 14, 8));
  expect(nlQueryToDateSuggestions("in 1 month", { now: new Date(2026, 0, 31, 12) })[0].date).toEqual(new Date(2026, 2, 3, 8));
});

test("business-day durations cross weekends without counting Saturday or Sunday", () => {
  for (const now of [new Date(2026, 9, 30, 16), new Date(2026, 9, 31, 16), new Date(2026, 10, 1, 16)]) {
    expect(nlQueryToDateSuggestions("in 1 business day", { now })[0].date).toEqual(new Date(2026, 10, 2, 8));
  }
});

test("custom city times use that city's tomorrow rather than the local date", () => {
  const suggestions = nlQueryToDateSuggestions("tomorrow 9am Tokyo", { now: new Date("2026-10-29T23:00:00Z") });
  expect(suggestions[0].date.toISOString()).toBe("2026-10-31T00:00:00.000Z");
  expect(suggestions[0].timezone).toBe("Asia/Tokyo");
});
