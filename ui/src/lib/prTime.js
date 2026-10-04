// Opened-date filters and timestamp ordering for PR lists. Rows carry GitHub's own `createdAt` and
// `updatedAt`; a missing or unparseable timestamp never borrows another field's value.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ROLLING_MS = { "24h": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS };

export const OPENED_RANGES = [
  { value: "all", label: "All time" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "custom", label: "Custom range" },
];

export const TIME_ORDERS = [
  { value: "queue", label: "Queue order" },
  { value: "newest", label: "Newest opened" },
  { value: "oldest", label: "Oldest opened" },
  { value: "updated", label: "Recently updated" },
  { value: "stale", label: "Least recently updated" },
];

const ORDER_KEYS = {
  newest: { field: "createdAt", direction: -1 },
  oldest: { field: "createdAt", direction: 1 },
  updated: { field: "updatedAt", direction: -1 },
  stale: { field: "updatedAt", direction: 1 },
};

export function isRollingRange(range) {
  return typeof range === "string" && Object.hasOwn(ROLLING_MS, range);
}

export function timestamp(value) {
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

// `range` is a preset name or an applied custom range `{ from, to }` of inclusive epoch-ms bounds
// (either may be null). Rolling presets end open so a PR opened after the last clock tick still shows.
export function openedBounds(range, now) {
  if (isRollingRange(range)) return { from: now - ROLLING_MS[range], to: null };
  if (range && typeof range === "object") return { from: range.from, to: range.to };
  return null;
}

// No bounds returns the input array itself, so the default list keeps its identity and order.
export function filterByOpened(prs, bounds) {
  if (!bounds) return prs;
  return prs.filter((pr) => {
    const opened = timestamp(pr.createdAt);
    return opened !== null && (bounds.from === null || opened >= bounds.from) && (bounds.to === null || opened <= bounds.to);
  });
}

// Queue order returns the input array itself. Timestamp orders return a new array; rows without the
// timestamp go last and ties keep their incoming order.
export function sortByTime(prs, order) {
  const key = ORDER_KEYS[order];
  if (!key) return prs;
  return prs
    .map((pr, index) => ({ pr, index, time: timestamp(pr[key.field]) }))
    .sort((a, b) => {
      if (a.time === null || b.time === null) return (a.time === null) - (b.time === null) || a.index - b.index;
      return (a.time - b.time) * key.direction || a.index - b.index;
    })
    .map(({ pr }) => pr);
}

const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

// Parses a `datetime-local` value as local time. The bound spans the precision the value was written
// at, so an inclusive end of 10:00 covers that whole minute. Calendar overflow (Feb 30) and local
// times skipped by a DST change are rejected rather than normalized.
export function parseLocalDateTime(value) {
  const match = LOCAL_DATETIME.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, frac] = match;
  const parts = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0), Number((frac ?? "").padEnd(3, "0"))];
  const date = new Date(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], parts[6]);
  date.setFullYear(parts[0]);
  const actual = [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()];
  if (actual.some((part, index) => part !== parts[index])) return null;
  const start = date.getTime();
  const span = frac !== undefined ? 1 : s !== undefined ? 1000 : 60 * 1000;
  return { start, end: start + span - 1 };
}

// Validates draft From/To input values. Returns `{ range }` ready to commit, or `{ error }`.
export function customOpenedRange(fromValue, toValue) {
  const fromText = fromValue.trim();
  const toText = toValue.trim();
  if (!fromText && !toText) return { error: "Choose a From or To time." };
  const from = fromText ? parseLocalDateTime(fromText) : null;
  const to = toText ? parseLocalDateTime(toText) : null;
  if ((fromText && !from) || (toText && !to)) return { error: "Enter a valid date and time." };
  if (from && to && from.start > to.end) return { error: "From must not be after To." };
  return { range: { from: from?.start ?? null, to: to?.end ?? null } };
}
