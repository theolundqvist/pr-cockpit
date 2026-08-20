// subsequence match; rewards consecutive runs and boundary hits (after / . _ -) so basenames rank first
export function fuzzyMatch(query, str) {
  if (!query) return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const s = str.toLowerCase();
  const positions = [];
  let qi = 0;
  let score = 0;
  let prev = -2;
  let run = 0;
  for (let si = 0; si < s.length && qi < q.length; si++) {
    if (s[si] !== q[qi]) continue;
    let bonus = 1;
    if (si === prev + 1) bonus += ++run * 3;
    else run = 0;
    const before = si === 0 ? "/" : s[si - 1];
    if (before === "/" || before === "." || before === "_" || before === "-") bonus += 5;
    score += bonus;
    positions.push(si);
    prev = si;
    qi++;
  }
  if (qi < q.length) return null;
  return { score: score - s.length * 0.01, positions };
}

export function fuzzyRank(query, paths) {
  const scored = [];
  for (const path of paths) {
    const m = fuzzyMatch(query, path);
    if (m) scored.push({ path, score: m.score, positions: m.positions });
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return scored;
}

export function fuzzyRankWithPriority(query, priorityPaths, paths) {
  const priority = new Set(priorityPaths);
  return [
    ...fuzzyRank(query, priority).map((result) => ({ ...result, priority: true })),
    ...fuzzyRank(
      query,
      paths.filter((path) => !priority.has(path)),
    ).map((result) => ({ ...result, priority: false })),
  ];
}
