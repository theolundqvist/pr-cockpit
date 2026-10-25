import { describe, expect, test } from "bun:test";
import { GRAPHQL_BACKGROUND_RESERVE, quotaIdentityLabel, quotaImpact, quotaLimitedLabel, quotaOutLabel } from "./quotaImpact.js";

const EARLY = "2026-08-21T14:00:00.000Z";
const LATE = "2026-08-21T14:40:00.000Z";

function quota(overrides = {}) {
  return {
    graphql: { limit: 5000, remaining: 5000, resetAt: EARLY },
    rest: { limit: 5000, remaining: 5000, resetAt: LATE },
    ...overrides,
  };
}

function appQuota(overrides = {}) {
  return {
    ...quota(),
    identity: "app:1:42",
    kind: "app",
    installationId: 42,
    repositories: ["owner/repo"],
    ...overrides,
  };
}

function independentQuota(personal, apps) {
  return {
    ...personal,
    identities: [{ ...personal, identity: "user:opaque-id", kind: "user", repositories: [] }, ...apps],
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

  test("identity labels distinguish personal and installation credentials without exposing keys", () => {
    expect(quotaIdentityLabel({ identity: "user:opaque-id", kind: "user" })).toBe("User");
    expect(quotaIdentityLabel(appQuota())).toBe("GitHub App (owner)");
    expect(quotaIdentityLabel({ kind: "app", installationId: 9876 })).toBe("GitHub App");
    expect(quotaIdentityLabel(appQuota({ repositories: ["owner/one", "owner/two", "other/repo"] }))).toBe("GitHub App (owner, other)");
  });

  test("personal exhaustion is scoped without claiming installation reads stopped or enabling writes", () => {
    const impact = quotaImpact(independentQuota(
      quota({ rest: { limit: 5000, remaining: 0, resetAt: EARLY } }),
      [appQuota({ rest: { limit: 15000, remaining: 14000, resetAt: LATE } })],
    ));
    expect(impact.mergeBlocked).toBe(true);
    expect(impact.restoresAt).toBe(EARLY);
    expect(impact.pools).toHaveLength(1);
    expect(impact.pools[0]).toMatchObject({
      identity: "user:opaque-id", label: "User REST", remaining: 0, limit: 5000, resetAt: EARLY,
    });
    expect(impact.pools[0].effect).toContain("installation reads have separate quotas");
    expect(quotaOutLabel(impact)).toBe("GitHub quota exhausted for User REST");
  });

  test("installation exhaustion does not block personal mutations or inherit its reset", () => {
    const impact = quotaImpact(independentQuota(quota(), [
      appQuota({ graphql: { limit: 15000, remaining: 0, resetAt: LATE } }),
    ]));
    expect(impact.level).toBe("out");
    expect(impact.mergeBlocked).toBe(false);
    expect(impact.restoresAt).toBe(null);
    expect(impact.pools[0]).toMatchObject({
      identity: "app:1:42", label: "GitHub App (owner) GraphQL",
      remaining: 0, limit: 15000, resetAt: LATE,
    });
    expect(impact.pools[0].effect).toContain("User quota is independent");
  });

  test("installation GraphQL cannot pay personal merge permission preflights", () => {
    const personal = quota({ graphql: { limit: 5000, remaining: 0, resetAt: EARLY } });
    const impact = quotaImpact(independentQuota(personal, [appQuota()]));
    expect(impact.mergeBlocked).toBe(true);
    expect(quotaImpact(independentQuota(personal, [appQuota()]), { restFallback: true }).mergeBlocked).toBe(false);
    expect(quotaImpact(independentQuota(personal, [appQuota()]), { repo: "owner/repo" }).mergeBlocked).toBe(false);
    expect(quotaImpact(independentQuota(personal, [appQuota()]), { repo: "elsewhere/repo" }).mergeBlocked).toBe(true);
    expect(quotaImpact(independentQuota(
      quota({ rest: { limit: 5000, remaining: 0, resetAt: EARLY } }),
      [appQuota()],
    ), { repo: "owner/repo" }).mergeBlocked).toBe(true);
  });

  test("separate installations retain independent limits and reset windows", () => {
    const impact = quotaImpact(independentQuota(quota(), [
      appQuota({ rest: { limit: 10000, remaining: 0, resetAt: EARLY } }),
      appQuota({
        identity: "app:1:43", installationId: 43, repositories: ["owner/other"],
        rest: { limit: 15000, remaining: 0, resetAt: LATE },
      }),
    ]));
    expect(impact.pools.map((pool) => [pool.identity, pool.remaining, pool.limit, pool.resetAt])).toEqual([
      ["app:1:42", 0, 10000, EARLY],
      ["app:1:43", 0, 15000, LATE],
    ]);
    expect(impact.mergeBlocked).toBe(false);
  });

  test("unknown installation resources are not invented full or exhausted", () => {
    const impact = quotaImpact(independentQuota(quota(), [
      appQuota({ graphql: null, rest: null, search: null }),
    ]));
    expect(impact.level).toBe("ok");
    expect(impact.pools).toEqual([]);
    expect(impact.mergeBlocked).toBe(false);
  });

  test("installation reserve and cooldown copy stays scoped to that credential", () => {
    const now = Date.parse(EARLY) - 60_000;
    const limited = quotaImpact(independentQuota(quota(), [
      appQuota({ graphql: { limit: 5000, remaining: GRAPHQL_BACKGROUND_RESERVE, resetAt: EARLY } }),
    ]));
    expect(quotaLimitedLabel(limited)).toBe("GitHub quota limited for GitHub App (owner) GraphQL");
    const cooling = quotaImpact(independentQuota(quota(), [
      appQuota({ rest: { limit: 10000, remaining: 9999, resetAt: LATE, blockedUntil: EARLY } }),
    ]), { now });
    expect(quotaOutLabel(cooling)).toBe("GitHub rate limited for GitHub App (owner) REST");
    expect(cooling.pools[0].resetAt).toBe(EARLY);
    expect(cooling.mergeBlocked).toBe(false);
  });
});
