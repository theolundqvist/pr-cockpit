// Splits a row's segments (plain text, or one line's highlight tokens) into runs, each flagged
// whether it falls inside one of the sorted, non-overlapping [start, end) ranges. Text before `from` is dropped.
export function matchRuns(segments, ranges, from = 0) {
  const runs = [];
  let offset = 0;
  let next = 0;
  for (const segment of segments) {
    const end = offset + segment.content.length;
    let at = Math.max(offset, from);
    while (at < end) {
      while (next < ranges.length && ranges[next][1] <= at) next++;
      const range = ranges[next];
      const hit = range !== undefined && range[0] <= at;
      const stop = hit ? Math.min(range[1], end) : Math.min(range?.[0] ?? end, end);
      runs.push({ ...segment, content: segment.content.slice(at - offset, stop - offset), hit });
      at = stop;
    }
    offset = end;
  }
  return runs;
}

// Fuzzy match positions at or after `from` as ranges relative to it, adjacent positions merged.
export function positionRanges(positions, from = 0) {
  const ranges = [];
  for (const position of positions ?? []) {
    if (position < from) continue;
    const last = ranges[ranges.length - 1];
    if (last && last[1] === position - from) last[1] += 1;
    else ranges.push([position - from, position - from + 1]);
  }
  return ranges;
}

// Every occurrence of a content-search query, ignoring case unless it has a capital, as the server's grep does.
export function queryRanges(text, query) {
  if (!query) return [];
  const exact = /[A-Z]/.test(query);
  const haystack = exact ? text : text.toLowerCase();
  const needle = exact ? query : query.toLowerCase();
  const ranges = [];
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    ranges.push([at, at + needle.length]);
  }
  return ranges;
}
