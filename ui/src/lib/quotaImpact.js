// GitHub bills Cockpit against independent pools and each one takes a different part of the
// app down when it runs dry, so degradation is described per pool.
// GraphQL: inbox search, PR state, checks, review threads, and every GraphQL mutation.
// REST: diffs, file contents and history, comment/review posting, and the merge PUT.
// Search: REST's per-minute search window; PR searches move to GraphQL while it is empty.
// 15% of a 5,000 pool stays with the screen and the other tools that share the GitHub token.
export const GRAPHQL_BACKGROUND_RESERVE = 750;

const POOLS = {
  graphql: {
    label: "GraphQL",
    out: "PR state, checks, threads, and search stop refreshing; assigning, resolving, and editing fail",
    reserved: "background polling is paused, so only the PR you open still refreshes",
  },
  // With the REST fallback setting on, PR reads move to the REST pool instead of stopping.
  graphqlOverRest: {
    label: "GraphQL",
    out: "PRs refresh over REST; resolving threads, auto-merge, and marking ready fail",
    reserved: "background polling reads over REST",
  },
  rest: {
    label: "REST",
    out: "diffs, file views, and file history stop loading; commenting, reviewing, and merging fail",
    reserved: "",
  },
  search: {
    label: "Search",
    out: "PR search and closed-PR history stop refreshing",
    reserved: "PR searches run over GraphQL",
  },
};

// An active block or secondary cooldown refuses requests whatever the remaining count says.
function unavailable(resource, now) {
  return resource.remaining === 0 || (!!resource.blockedUntil && Date.parse(resource.blockedUntil) > now);
}

function poolState(api, quota, restFallback, now) {
  const resource = quota?.[api];
  if (!resource) return null;
  const pool = api === "graphql" && restFallback ? POOLS.graphqlOverRest : POOLS[api];
  if (api === "search") {
    if (!unavailable(resource, now)) return null;
    // Searches fall back to GraphQL, so an empty search window only stops them when GraphQL is gone too.
    return quota.graphql && unavailable(quota.graphql, now)
      ? { api, level: "out", effect: pool.out }
      : { api, level: "reserved", effect: pool.reserved };
  }
  if (unavailable(resource, now)) return { api, level: "out", effect: pool.out };
  if (api === "graphql" && resource.remaining <= GRAPHQL_BACKGROUND_RESERVE) {
    return { api, level: "reserved", effect: pool.reserved };
  }
  return null;
}

// level "out": a pool is unavailable and the actions it powers fail outright.
// level "reserved": background work slowed or moved to another pool; the screen still works.
// restFallback: GraphQL reads fall back to REST, so an empty GraphQL pool no longer blocks merges.
function credentialImpact(quota, { restFallback = false, now = Date.now() } = {}) {
  const pools = [];
  for (const api of ["graphql", "rest", "search"]) {
    const state = poolState(api, quota, restFallback, now);
    if (!state) continue;
    const resource = quota[api];
    const blocked = !!resource.blockedUntil && Date.parse(resource.blockedUntil) > now;
    pools.push({
      ...state,
      label: POOLS[api].label,
      remaining: resource.remaining,
      limit: resource.limit,
      resetAt: blocked ? resource.blockedUntil : resource.resetAt,
      cooldown: blocked && resource.remaining > 0,
    });
  }
  const out = pools.filter((p) => p.level === "out");
  return {
    level: out.length > 0 ? "out" : pools.length > 0 ? "reserved" : "ok",
    pools,
    // a merge refreshes the PR over GraphQL, then merges over REST: either pool being
    // empty means the merge cannot happen, so Cockpit refuses instead of queueing a failure
    mergeBlocked: out.some((p) => p.api === "rest" || (p.api === "graphql" && !restFallback)),
    restoresAt: pools.reduce((latest, p) => (latest && latest > p.resetAt ? latest : p.resetAt), null),
  };
}

export function quotaIdentityLabel(identity) {
  if (identity.kind !== "app") return "User";
  const owners = [...new Set((identity.repositories ?? []).map((repo) => repo.split("/")[0]).filter(Boolean))];
  return owners.length ? `GitHub App (${owners.join(", ")})` : "GitHub App";
}

function identityEffect(identity, pool) {
  if (identity.kind === "app") {
    const state = pool.level === "reserved" ? "limited" : "unavailable";
    return `installation ${pool.api === "search" ? "search" : pool.label} quota is ${state}; User quota is independent`;
  }
  if (pool.api === "rest") {
    return "commenting, reviewing, and merging fail; installation reads have separate quotas";
  }
  if (pool.api === "graphql") {
    return pool.level === "reserved"
      ? "personal background polling is paused or uses REST; installation reads have separate quotas"
      : "personal GraphQL actions are unavailable; installation reads have separate quotas";
  }
  return pool.level === "reserved"
    ? "personal PR searches use GraphQL; installation search has a separate quota"
    : "personal PR searches are unavailable; installation search has a separate quota";
}

export function quotaImpact(quota, options = {}) {
  const appDetailRead = !!options.repo && quota?.identities?.some((identity) =>
    identity.kind === "app" && identity.repositories?.some((repo) => repo.toLowerCase() === options.repo.toLowerCase()));
  // An opted-in repository's detail uses app-first REST even when the general fallback is off.
  // Only its read protocol changes: merging and viewer permissions still require User quota.
  const personal = credentialImpact(quota, { ...options, restFallback: options.restFallback || appDetailRead });
  if (!quota?.identities) return personal;
  const pools = [];
  for (const identity of quota.identities) {
    for (const pool of credentialImpact(identity, options).pools) {
      pools.push({
        ...pool,
        identity: identity.identity,
        kind: identity.kind,
        label: `${quotaIdentityLabel(identity)} ${pool.label}`,
        effect: identityEffect(identity, pool),
      });
    }
  }
  return {
    ...personal,
    independent: true,
    level: pools.some((pool) => pool.level === "out") ? "out" : pools.length ? "reserved" : "ok",
    pools,
    // Mutations and their viewer/permission preflights always use the personal credential.
    // Its merge block and restoration must never inherit an installation's quota window.
  };
}

export function quotaOutLabel(impact) {
  const out = impact.pools.filter((p) => p.level === "out");
  if (out.length === 0) return "";
  const names = out.map((p) => p.label).join(" and ");
  if (impact.independent) {
    return out.every((p) => p.cooldown)
      ? `GitHub rate limited for ${names}`
      : `GitHub quota exhausted for ${names}`;
  }
  return out.every((p) => p.cooldown) ? `GitHub ${names} rate limited` : `GitHub ${names} quota exhausted`;
}

export function quotaLimitedLabel(impact) {
  const names = impact.pools.map((p) => p.label).join(" and ");
  if (impact.independent) return `GitHub quota limited for ${names}`;
  return names === "GraphQL" ? "GitHub GraphQL quota nearly exhausted" : `GitHub ${names} quota limited`;
}
