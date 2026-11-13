// Subsequence matching rewards consecutive runs and path boundaries.
export function fuzzyMatch(query, str) {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return { score: 0, positions: [] };
  const s = str.toLowerCase();
  const positions = new Set();
  let score = 0;
  for (const term of terms) {
    let best = null;
    for (let start = 0; start < s.length; start++) {
      if (s[start] !== term[0]) continue;
      const hits = [];
      let qi = 0;
      let prev = -2;
      let run = 0;
      let termScore = 0;
      for (let si = start; si < s.length && qi < term.length; si++) {
        if (s[si] !== term[qi]) continue;
        let bonus = 1;
        if (si === prev + 1) bonus += ++run * 3;
        else run = 0;
        const before = si === 0 ? "/" : s[si - 1];
        if (before === "/" || before === "." || before === "_" || before === "-") bonus += 5;
        termScore += bonus;
        hits.push(si);
        prev = si;
        qi++;
      }
      if (qi === term.length && (!best || termScore > best.score)) best = { score: termScore, positions: hits };
    }
    if (!best) return null;
    score += best.score;
    for (const position of best.positions) positions.add(position);
  }
  return { score: score - s.length * 0.01, positions: [...positions].sort((a, b) => a - b) };
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
