// GitHub bills Cockpit against two independent hourly pools and each one takes a
// different half of the app down when it runs dry, so degradation is described per pool.
// GraphQL: inbox search, PR state, checks, review threads, and every GraphQL mutation.
// REST: diffs, file contents and history, comment/review posting, and the merge PUT.
export const GRAPHQL_BACKGROUND_RESERVE = 200;

const POOLS = {
  graphql: {
    label: "GraphQL",
    out: "PR state, checks, threads, and search stop refreshing; assigning, resolving, and editing fail",
    reserved: "background polling is paused, so only the PR you open still refreshes",
  },
  rest: {
    label: "REST",
    out: "diffs, file views, and file history stop loading; commenting, reviewing, and merging fail",
    reserved: "",
  },
};

function poolState(api, resource) {
  if (!resource) return null;
  if (resource.remaining === 0) return { api, level: "out", effect: POOLS[api].out };
  if (api === "graphql" && resource.remaining <= GRAPHQL_BACKGROUND_RESERVE) {
    return { api, level: "reserved", effect: POOLS[api].reserved };
  }
  return null;
}

// level "out": a pool is empty and the actions it powers fail outright.
// level "reserved": GraphQL is below the polling reserve, so only background refresh stopped.
export function quotaImpact(quota) {
  const pools = [];
  for (const api of ["graphql", "rest"]) {
    const state = poolState(api, quota?.[api]);
    if (!state) continue;
    const resource = quota[api];
    pools.push({ ...state, label: POOLS[api].label, remaining: resource.remaining, limit: resource.limit, resetAt: resource.resetAt });
  }
  const out = pools.filter((p) => p.level === "out");
  return {
    level: out.length > 0 ? "out" : pools.length > 0 ? "reserved" : "ok",
    pools,
    // a merge refreshes the PR over GraphQL, then merges over REST: either pool being
    // empty means the merge cannot happen, so Cockpit refuses instead of queueing a failure
    mergeBlocked: out.length > 0,
    restoresAt: pools.reduce((latest, p) => (latest && latest > p.resetAt ? latest : p.resetAt), null),
  };
}

export function quotaOutLabel(impact) {
  const names = impact.pools.filter((p) => p.level === "out").map((p) => p.label);
  return names.length === 0 ? "" : `GitHub ${names.join(" and ")} quota exhausted`;
}
