import { expect, test } from "bun:test";
import { paletteTokens, rankByNumber } from "./paletteRank.js";

const row = (number, open = true, title = "") => ({ repo: "acme/app", number, open, title });

test("a typed number ranks the exact PR, then open and higher numbers containing it, then the rest", () => {
  const rows = [row(7, true, "title mentions 51"), row(10151, false), row(10051), row(51, false), row(10510), row(9, true, "also 51")];
  for (const query of ["51", "#51"]) {
    expect(rankByNumber(rows, paletteTokens(query)).map((r) => r.number)).toEqual([51, 10510, 10051, 10151, 7, 9]);
  }
});

test("queries without a number keep their order", () => {
  const rows = [row(3), row(10051), row(1)];
  expect(rankByNumber(rows, paletteTokens("fix login"))).toBe(rows);
});
