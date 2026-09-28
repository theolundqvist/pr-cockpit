// "51" and "#51" both name the digits; five-digit PR numbers are typed by their tail
export function paletteTokens(query) {
  const q = query.trim().toLowerCase();
  return q ? q.split(/\s+/).map((t) => t.replace(/^#(?=\d+$)/, "")) : [];
}

export function isOpenState(state) {
  const s = state.toUpperCase();
  return s !== "MERGED" && s !== "CLOSED";
}

// exact number first, then numbers containing the digits (open, then highest); everything else keeps its order
export function rankByNumber(rows, tokens) {
  const digits = tokens.find((t) => /^\d+$/.test(t));
  if (!digits) return rows;
  const tier = (row) => {
    const n = String(row.number);
    return n === digits ? 0 : n.includes(digits) ? 1 : 2;
  };
  return rows.toSorted((a, b) => {
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    if (ta !== 1) return 0;
    if (a.open !== b.open) return a.open ? -1 : 1;
    return b.number - a.number;
  });
}
