import { describe, expect, test } from "bun:test";
import { GRAPHQL_BACKGROUND_RESERVE, quotaImpact, quotaLimitedLabel, quotaOutLabel } from "./quotaImpact.js";

const EARLY = "2026-08-21T14:00:00.000Z";
const LATE = "2026-08-21T14:40:00.000Z";

function quota(overrides = {}) {
  return {
    graphql: { limit: 5000, remaining: 5000, resetAt: EARLY },
    rest: { limit: 5000, remaining: 5000, resetAt: LATE },
    ...overrides,
  };
}

describe("quotaImpact", () => {
  test("healthy quota reports nothing and blocks nothing", () => {
    const impact = quotaImpact(quota());
    expect(impact.level).toBe("ok");
    expect(impact.pools).toEqual([]);
    expect(impact.mergeBlocked).toBe(false);
    expect(impact.restoresAt).toBe(null);
  });

  test("missing quota is inert", () => {
    expect(quotaImpact(null).level).toBe("ok");
    expect(quotaImpact(undefined).mergeBlocked).toBe(false);
  });

  test("graphql at the polling reserve degrades without blocking merges", () => {
    const impact = quotaImpact(quota({ graphql: { limit: 5000, remaining: GRAPHQL_BACKGROUND_RESERVE, resetAt: EARLY } }));
    expect(impact.level).toBe("reserved");
    expect(impact.pools.map((p) => [p.api, p.level])).toEqual([["graphql", "reserved"]]);
    expect(impact.mergeBlocked).toBe(false);
    expect(impact.restoresAt).toBe(EARLY);
  });

  test("one point above the reserve is still healthy", () => {
    expect(quotaImpact(quota({ graphql: { limit: 5000, remaining: GRAPHQL_BACKGROUND_RESERVE + 1, resetAt: EARLY } })).level).toBe("ok");
  });

  test("an empty rest pool blocks merging even while graphql is healthy", () => {
    const impact = quotaImpact(quota({ rest: { limit: 5000, remaining: 0, resetAt: LATE } }));
    expect(impact.level).toBe("out");
    expect(impact.mergeBlocked).toBe(true);
    expect(impact.restoresAt).toBe(LATE);
    expect(quotaOutLabel(impact)).toBe("GitHub REST quota exhausted");
  });

  test("both pools empty restore at the later reset and name both", () => {
    const impact = quotaImpact({
      graphql: { limit: 5000, remaining: 0, resetAt: EARLY },
      rest: { limit: 5000, remaining: 0, resetAt: LATE },
    });
    expect(impact.pools.map((p) => p.level)).toEqual(["out", "out"]);
    expect(impact.restoresAt).toBe(LATE);
    expect(quotaOutLabel(impact)).toBe("GitHub GraphQL and REST quota exhausted");
  });

  test("every reported pool carries the numbers and copy the banner shows", () => {
    const impact = quotaImpact(quota({ graphql: { limit: 5000, remaining: 0, resetAt: EARLY } }));
    const [pool] = impact.pools;
    expect(pool).toMatchObject({ api: "graphql", label: "GraphQL", remaining: 0, limit: 5000, resetAt: EARLY });
    expect(pool.effect).toContain("stop refreshing");
  });

  test("with the REST fallback an empty graphql pool keeps merging available", () => {
    const empty = quota({ graphql: { limit: 5000, remaining: 0, resetAt: EARLY } });
    const impact = quotaImpact(empty, { restFallback: true });
    expect(impact.level).toBe("out");
    expect(impact.mergeBlocked).toBe(false);
    expect(impact.pools[0].effect).toContain("over REST");
    expect(quotaImpact(empty).mergeBlocked).toBe(true);
    const bothEmpty = quotaImpact({ ...empty, rest: { limit: 5000, remaining: 0, resetAt: LATE } }, { restFallback: true });
    expect(bothEmpty.mergeBlocked).toBe(true);
  });

  test("an empty search window is limited while GraphQL can search, and out once GraphQL cannot", () => {
    const now = Date.parse(EARLY) - 60_000;
    const searchSpent = quota({ search: { limit: 30, remaining: 0, resetAt: EARLY } });
    const limited = quotaImpact(searchSpent, { now });
    expect(limited.level).toBe("reserved");
    expect(limited.mergeBlocked).toBe(false);
    expect(quotaLimitedLabel(limited)).toBe("GitHub Search quota limited");
    const bothGone = quotaImpact({ ...searchSpent, graphql: { limit: 5000, remaining: 0, resetAt: LATE } }, { now, restFallback: true });
    expect(bothGone.pools.map((p) => [p.api, p.level])).toEqual([["graphql", "out"], ["search", "out"]]);
    expect(bothGone.mergeBlocked).toBe(false);
  });

  test("a cooldown makes a pool unavailable whatever its count and restores when the cooldown ends", () => {
    const now = Date.parse(EARLY) - 60_000;
    const cooldownEnds = new Date(now + 30_000).toISOString();
    const cooling = quota({ rest: { limit: 5000, remaining: 4999, resetAt: LATE, blockedUntil: cooldownEnds } });
    const impact = quotaImpact(cooling, { now });
    expect(impact.level).toBe("out");
    expect(impact.mergeBlocked).toBe(true);
    expect(impact.restoresAt).toBe(cooldownEnds);
    expect(quotaOutLabel(impact)).toBe("GitHub REST rate limited");
    expect(quotaImpact(cooling, { now: now + 30_000 }).level).toBe("ok");
  });
});
