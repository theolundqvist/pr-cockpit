import { describe, expect, test } from "bun:test";
import { fuzzyMatch, fuzzyRank, fuzzyRankWithPriority } from "./fuzzy.js";

describe("fuzzyMatch", () => {
  test("matches a subsequence and records positions", () => {
    const m = fuzzyMatch("app", "src/app.ts");
    expect(m).not.toBeNull();
    expect(m.positions.map((i) => "src/app.ts"[i]).join("")).toBe("app");
  });

  test("returns null when the query is not a subsequence", () => {
    expect(fuzzyMatch("xyz", "src/app.ts")).toBeNull();
  });

  test("is case-insensitive", () => {
    expect(fuzzyMatch("APP", "src/app.ts")).not.toBeNull();
  });

  test("empty query matches anything with zero score", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
  });
});

describe("fuzzyRank", () => {
  test("ranks a basename boundary hit above a scattered one", () => {
    const ranked = fuzzyRank("app", ["src/mapper/wrap.ts", "app.ts"]);
    expect(ranked[0].path).toBe("app.ts");
  });

  test("drops non-matching paths", () => {
    const ranked = fuzzyRank("zzz", ["a.ts", "b.ts"]);
    expect(ranked).toHaveLength(0);
  });

  test("consecutive-run hit outranks a gapped hit", () => {
    const ranked = fuzzyRank("index", ["i/n/d/e/x.ts", "index.ts"]);
    expect(ranked[0].path).toBe("index.ts");
  });
});

describe("fuzzyRankWithPriority", () => {
  test("keeps matching priority paths first and omits duplicate tree paths", () => {
    const ranked = fuzzyRankWithPriority("main", ["src/main.ts"], ["src/main.ts", "src/domain.ts"]);
    expect(ranked.map(({ path, priority }) => ({ path, priority }))).toEqual([
      { path: "src/main.ts", priority: true },
      { path: "src/domain.ts", priority: false },
    ]);
  });
});
