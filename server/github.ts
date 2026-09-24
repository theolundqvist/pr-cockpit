import { validateCodeScanningDismissal } from "../shared/codeScanning.js";
import type { MergeMethod } from "./mergeMethod.ts";
import { mockGithub, MOCK_FIXTURE_CLOCK } from "./mockGithub.ts";
import {
  githubAuthStatus as liveGithubAuthStatus,
  liveGithubToken,
  startGithubSetup as startLiveGithubSetup,
  type GithubAuthStatus,
} from "./githubAuth.ts";
import {
  instrumentGithubGraphql,
  RATE_LIMIT_ALIAS,
  recordGithubGraphqlUsage,
  type GithubUsageSource,
} from "./githubUsage.ts";
import { readSettings } from "./settings.ts";
import {
  clearRepositoryUnavailable,
  reportRepositoryUnavailable,
  repositoryAvailable,
} from "./systemIssues.ts";
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type GithubGraphqlError = { type?: string; message?: string };
export type GithubQuotaResourceName = "core" | "search" | "graphql";
export type GithubRequestErrorKind = "http" | "graphql" | "quota" | "transport";

export class GithubRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly graphqlErrors: readonly GithubGraphqlError[] = [],
    readonly kind: GithubRequestErrorKind = "http",
    readonly resource: GithubQuotaResourceName | null = null,
    readonly resetAt: string | null = null,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GithubRequestError";
  }
}

type QuotaDeadline = { status: number; resetAt: string; until: number };
type QuotaBlocks = { primary?: QuotaDeadline; secondary?: QuotaDeadline };
const blockedQuotas = new Map<GithubQuotaResourceName, QuotaBlocks>();
const responseQuotaResources = new WeakMap<Response, GithubQuotaResourceName>();
const responseQuotaGenerations = new WeakMap<Response, number>();
const quotaProbeInFlight = new Map<GithubQuotaResourceName, {
  generation: number;
  primary: QuotaDeadline;
  promise: Promise<void>;
}>();
const lastQuotaProbeAt = new Map<GithubQuotaResourceName, number>();
const QUOTA_PROBE_INTERVAL_MS = 30_000;
// A socket that dies silently (sleep, network change) never settles its fetch, and one hung
// request stalls the poll loop until restart, so every GitHub request carries a deadline.
const GITHUB_REQUEST_TIMEOUT_MS = 60_000;
const SECONDARY_RATE_LIMIT_FALLBACK_MS = 5 * 60_000;
let activeQuotaToken: string | null = null;
let activeQuotaGeneration = 0;

function quotaGeneration(token: string): number {
  if (activeQuotaToken !== token) {
    activeQuotaToken = token;
    activeQuotaGeneration++;
    blockedQuotas.clear();
    quotaProbeInFlight.clear();
    lastQuotaProbeAt.clear();
    cachedQuota = null;
  }
  return activeQuotaGeneration;
}
function responseHasActiveQuota(response: Response): boolean {
  return responseQuotaGenerations.get(response) === activeQuotaGeneration;
}

function quotaState(resource: GithubQuotaResourceName): QuotaBlocks {
  const existing = blockedQuotas.get(resource);
  if (existing) return existing;
  const state: QuotaBlocks = {};
  blockedQuotas.set(resource, state);
  return state;
}

function removeEmptyQuotaState(resource: GithubQuotaResourceName, state: QuotaBlocks): void {
  if (!state.primary && !state.secondary && blockedQuotas.get(resource) === state) blockedQuotas.delete(resource);
}

function updatePrimaryQuota(
  resource: GithubQuotaResourceName,
  remaining: number,
  resetAt: string | null,
  status = 403,
): void {
  if (remaining > 0) {
    const state = blockedQuotas.get(resource);
    if (!state) return;
    delete state.primary;
    removeEmptyQuotaState(resource, state);
    return;
  }
  const until = resetAt === null ? Number.NaN : Date.parse(resetAt);
  if (remaining === 0 && resetAt !== null && Number.isFinite(until)) {
    quotaState(resource).primary = { status, resetAt, until };
  }
}

function updateSecondaryQuota(resource: GithubQuotaResourceName, deadline: QuotaDeadline): void {
  const state = quotaState(resource);
  if (!state.secondary || deadline.until > state.secondary.until) state.secondary = deadline;
}

function quotaResource(path: string): GithubQuotaResourceName {
  if (path === "/graphql") return "graphql";
  return path.startsWith("/search/") ? "search" : "core";
}

function retryAfterDeadline(response: Response): QuotaDeadline | null {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter === null) return null;
  const seconds = Number(retryAfter);
  const until = Number.isFinite(seconds)
    ? Date.now() + Math.max(0, seconds) * 1_000
    : Date.parse(retryAfter);
  return Number.isFinite(until)
    ? { status: response.ok ? 403 : response.status, until, resetAt: new Date(until).toISOString() }
    : null;
}

function primaryResetDeadline(response: Response): QuotaDeadline | null {
  const rawReset = response.headers.get("x-ratelimit-reset");
  if (rawReset === null) return null;
  const reset = Number(rawReset);
  if (!Number.isFinite(reset)) return null;
  const until = reset * 1_000;
  return { status: response.ok ? 403 : response.status, until, resetAt: new Date(until).toISOString() };
}

function responseQuotaResource(response: Response, fallback: GithubQuotaResourceName): GithubQuotaResourceName {
  const value = response.headers.get("x-ratelimit-resource");
  return value === "core" || value === "search" || value === "graphql"
    ? value
    : responseQuotaResources.get(response) ?? fallback;
}

function accountQuota(response: Response, fallback: GithubQuotaResourceName, generation: number): void {
  if (generation !== activeQuotaGeneration) return;
  const resource = responseQuotaResource(response, fallback);
  const rawRemaining = response.headers.get("x-ratelimit-remaining");
  const remaining = rawRemaining === null ? Number.NaN : Number(rawRemaining);
  const primary = primaryResetDeadline(response);
  if (remaining === 0 && primary) {
    updatePrimaryQuota(resource, 0, primary.resetAt, primary.status);
  } else if (Number.isFinite(remaining) && remaining > 0) {
    updatePrimaryQuota(resource, remaining, null);
  }
  if ((response.status === 403 || response.status === 429) && response.headers.has("retry-after")) {
    const secondary = retryAfterDeadline(response);
    if (secondary) updateSecondaryQuota(resource, secondary);
  }
}

function activeQuotaBlock(resource: GithubQuotaResourceName): QuotaDeadline | null {
  const state = blockedQuotas.get(resource);
  if (!state) return null;
  const now = Date.now();
  if (state.primary && now >= state.primary.until) delete state.primary;
  if (state.secondary && now >= state.secondary.until) delete state.secondary;
  const blocked = !state.primary
    ? state.secondary
    : !state.secondary || state.primary.until >= state.secondary.until
      ? state.primary
      : state.secondary;
  removeEmptyQuotaState(resource, state);
  return blocked ?? null;
}

async function revalidateQuota(
  resource: GithubQuotaResourceName,
  token: string,
  generation: number,
): Promise<void> {
  activeQuotaBlock(resource);
  const state = blockedQuotas.get(resource);
  if (generation !== activeQuotaGeneration || !state?.primary || state.secondary) return;
  const primary = state.primary;
  const existing = quotaProbeInFlight.get(resource);
  if (existing?.generation === generation && existing.primary === primary) {
    await existing.promise;
    return;
  }
  const now = Date.now();
  if (now - (lastQuotaProbeAt.get(resource) ?? Number.NEGATIVE_INFINITY) < QUOTA_PROBE_INTERVAL_MS) return;
  lastQuotaProbeAt.set(resource, now);
  const entry: {
    generation: number;
    primary: QuotaDeadline;
    promise: Promise<void>;
  } = { generation, primary, promise: Promise.resolve() };
  entry.promise = (async () => {
    try {
      const response = await fetch("https://api.github.com/rate_limit", {
        signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
        headers: {
          Authorization: `bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      });
      if (generation !== activeQuotaGeneration) return;
      const secondary = retryAfterDeadline(response);
      if ((response.status === 403 || response.status === 429) && secondary) {
        updateSecondaryQuota(resource, secondary);
      }
      if (!response.ok) return;
      const body = (await response.json()) as {
        resources?: Record<string, { remaining?: number } | undefined>;
      };
      const remaining = body.resources?.[resource]?.remaining;
      const current = blockedQuotas.get(resource);
      if (
        typeof remaining === "number"
        && remaining > 0
        && generation === activeQuotaGeneration
        && current?.primary === primary
      ) {
        delete current.primary;
        removeEmptyQuotaState(resource, current);
      }
    } catch {
      // Keep the recorded block when the probe is unreachable or malformed.
    }
  })().finally(() => {
    if (quotaProbeInFlight.get(resource) === entry) quotaProbeInFlight.delete(resource);
  });
  quotaProbeInFlight.set(resource, entry);
  await entry.promise;
}

function assertQuotaAvailable(resource: GithubQuotaResourceName): void {
  const blocked = activeQuotaBlock(resource);
  if (!blocked) return;
  throw new GithubRequestError(
    `GitHub ${resource} quota exhausted until ${blocked.resetAt}`,
    blocked.status,
    [],
    "quota",
    resource,
    blocked.resetAt,
  );
}

async function githubApiResponse(
  method: string,
  path: string,
  options: {
    body?: unknown;
    accept?: string;
    redirect?: RequestRedirect;
    authentication?: { token: string; generation: number };
  } = {},
): Promise<Response> {
  const resource = quotaResource(path);
  const token = options.authentication?.token ?? await ghToken();
  const generation = options.authentication?.generation ?? quotaGeneration(token);
  await revalidateQuota(resource, token, generation);
  assertQuotaAvailable(resource);
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `bearer ${token}`,
        Accept: options.accept ?? "application/vnd.github+json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: options.redirect,
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new GithubRequestError(
      `GitHub ${resource} transport unavailable: ${error instanceof Error ? error.message : String(error)}`,
      503,
      [],
      "transport",
      resource,
      null,
      error,
    );
  }
  responseQuotaResources.set(response, resource);
  responseQuotaGenerations.set(response, generation);
  accountQuota(response, resource, generation);
  return response;
}

async function githubResponseError(label: string, response: Response): Promise<GithubRequestError> {
  const resource = responseQuotaResource(response, quotaResource(new URL(response.url || "https://api.github.com").pathname));
  const body = await response.text();
  const secondaryWithoutDeadline = response.status === 403
    && !response.headers.has("retry-after")
    && /secondary rate limit/i.test(body);
  if (secondaryWithoutDeadline && responseHasActiveQuota(response)) {
    const until = Date.now() + SECONDARY_RATE_LIMIT_FALLBACK_MS;
    updateSecondaryQuota(resource, {
      status: response.status,
      until,
      resetAt: new Date(until).toISOString(),
    });
  }
  const quota = response.status === 429
    || (response.status === 403 && (
      response.headers.get("x-ratelimit-remaining") === "0"
      || response.headers.has("retry-after")
      || /rate limit/i.test(body)
    ));
  const resetAt = quota && responseHasActiveQuota(response)
    ? activeQuotaBlock(resource)?.resetAt ?? null
    : null;
  return new GithubRequestError(
    `${label}: ${response.status}${body ? ` ${body}` : ""}`,
    response.status,
    [],
    quota ? "quota" : "http",
    resource,
    resetAt,
  );
}

export class StalePrHeadError extends Error {
  constructor(message = "PR head changed; reload before committing") {
    super(message);
    this.name = "StalePrHeadError";
  }
}


export async function githubAuthStatus(scopes: readonly string[] = ["repo", "workflow"]): Promise<GithubAuthStatus> {
  if (!mockGithub) return liveGithubAuthStatus(scopes);
  return {
    ok: true,
    state: "ready",
    login: mockGithub.viewerLogin,
    error: null,
    requiredScopes: [...scopes],
    missingScopes: [],
  };
}

export async function startGithubSetup(scopes: readonly string[] = ["repo", "workflow"]): Promise<GithubAuthStatus> {
  if (!mockGithub) return startLiveGithubSetup(scopes);
  return githubAuthStatus(scopes);
}

export async function ghToken(): Promise<string> {
  if (mockGithub) return "fixture-token";
  if (readSettings().replica_ssh_host) throw new Error("GitHub access is disabled while PR Cockpit uses an SSH replica");
  return liveGithubToken();
}

let cachedViewerLogin: string | null = null;

export async function getViewerLogin(): Promise<string> {
  if (mockGithub) return mockGithub.viewerLogin;
  if (cachedViewerLogin) return cachedViewerLogin;
  const viewer = await restJson<{ login: string }>("/user");
  cachedViewerLogin = viewer.login;
  return cachedViewerLogin;
}

async function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
  source: GithubUsageSource,
  operation: string,
): Promise<T> {
  const instrumented = instrumentGithubGraphql(query);
  let res: Response;
  try {
    res = await githubApiResponse("POST", "/graphql", {
      body: { query: instrumented.document, variables },
    });
  } catch (error) {
    if (!(error instanceof GithubRequestError && error.kind === "quota")) {
      recordGithubGraphqlUsage({
        occurredAt: new Date().toISOString(),
        source,
        operation,
        cost: instrumented.fixedCost,
        used: null,
        remaining: null,
        resetAt: null,
        status: "error",
      });
    }
    throw error;
  }
  const headerNumber = (name: string): number | null => {
    const raw = res.headers.get(name);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const headerReset = headerNumber("x-ratelimit-reset");
  const record = (
    rateLimit: { cost: number; used: number; remaining: number; resetAt: string } | null,
    status: "ok" | "error",
  ) => {
    if (!responseHasActiveQuota(res)) return;
    const used = rateLimit?.used ?? headerNumber("x-ratelimit-used");
    const remaining = rateLimit?.remaining ?? headerNumber("x-ratelimit-remaining");
    const resetAt = rateLimit?.resetAt ?? (headerReset === null ? null : new Date(headerReset * 1_000).toISOString());
    updateCachedGraphqlQuota(
      headerNumber("x-ratelimit-limit"),
      used,
      remaining,
      resetAt,
    );
    recordGithubGraphqlUsage({
      occurredAt: new Date().toISOString(),
      source,
      operation,
      cost: rateLimit?.cost ?? instrumented.fixedCost,
      used,
      remaining,
      resetAt,
      status,
    });
  };
  if (!res.ok) {
    record(null, "error");
    throw await githubResponseError("GraphQL request failed", res);
  }
  const body = (await res.json()) as {
    data?: T & Record<string, unknown>;
    errors?: GithubGraphqlError[];
  };
  const rateLimit = body.data?.[RATE_LIMIT_ALIAS] as {
    cost: number;
    used: number;
    remaining: number;
    resetAt: string;
  } | undefined;
  if (rateLimit && responseHasActiveQuota(res)) updatePrimaryQuota("graphql", rateLimit.remaining, rateLimit.resetAt);
  if (body.data) delete body.data[RATE_LIMIT_ALIAS];
  record(rateLimit ?? null, body.errors?.length ? "error" : "ok");
  if (body.errors?.length) {
    const missing = body.errors.every((error) => error.type === "NOT_FOUND");
    const exhausted = body.errors.some((error) => error.type === "RATE_LIMIT" || error.type === "RATE_LIMITED");
    const resetAt = rateLimit?.resetAt
      ?? (headerReset === null ? cachedQuota?.graphql.resetAt ?? null : new Date(headerReset * 1_000).toISOString());
    if (exhausted && responseHasActiveQuota(res)) updatePrimaryQuota("graphql", 0, resetAt);
    throw new GithubRequestError(
      `GraphQL errors: ${JSON.stringify(body.errors)}`,
      missing ? 404 : exhausted ? 403 : 502,
      body.errors,
      exhausted ? "quota" : "graphql",
      "graphql",
      exhausted ? resetAt : null,
    );
  }
  if (!body.data) throw new GithubRequestError("GraphQL response missing data", 502, [], "graphql", "graphql");
  return body.data;
}

export const MAX_MERGED_PR_ANALYTICS_DAYS = 180;

export interface MergedPrAnalyticsPullRequest {
  number: number;
  title: string;
  url: string;
  author: string;
  mergedAt: string;
}

export interface MergedPrAnalytics {
  repo: string;
  base: string;
  asOf: string;
  pullRequests: MergedPrAnalyticsPullRequest[];
}


const MERGED_PRS_QUERY = `
query($owner: String!, $name: String!, $base: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(
      states: MERGED
      baseRefName: $base
      first: 100
      after: $cursor
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      nodes {
        number
        title
        url
        mergedAt
        updatedAt
        author { login }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;


// Always fetches the full analytics window; the HTTP layer owns caching.
export async function fetchMergedPrAnalytics(repo: string, base: string): Promise<MergedPrAnalytics> {
  const asOf = mockGithub ? MOCK_FIXTURE_CLOCK : new Date().toISOString();
  const cutoff = Date.parse(asOf) - MAX_MERGED_PR_ANALYTICS_DAYS * 24 * 60 * 60_000;
  let pullRequests: MergedPrAnalyticsPullRequest[];

  if (mockGithub) {
    pullRequests = base === "main"
      ? mockGithub.searchRecentPrs(repo)
        .filter((entry) => entry.state === "MERGED")
        .flatMap((entry) => {
          const mergedAt = entry.mergedAt ?? entry.updatedAt;
          return Date.parse(mergedAt) >= cutoff
            ? [{
                number: entry.number,
                title: entry.title,
                url: `https://github.com/${repo}/pull/${entry.number}`,
                author: entry.author,
                mergedAt,
              }]
            : [];
        })
      : [];
  } else {
    const [owner, name] = repo.split("/");
    if (!owner || !name) throw new GithubRequestError(`Invalid repository: ${repo}`, 404);
    pullRequests = [];
    let cursor: string | null = null;
    while (true) {
      const data = await graphql<{
        repository: {
          pullRequests: {
            nodes: Array<{
              number: number;
              title: string;
              url: string;
              mergedAt: string | null;
              updatedAt: string;
              author: { login: string } | null;
            }>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        } | null;
      }>(MERGED_PRS_QUERY, { owner, name, base, cursor }, "user action", "merged-pr-analytics");
      if (!data.repository) throw new GithubRequestError(`Repository not found: ${repo}`, 404);

      const nodes = data.repository.pullRequests.nodes;
      const reachedCutoff = nodes.length > 0 && nodes.every((entry) => Date.parse(entry.updatedAt) < cutoff);
      for (const entry of nodes) {
        if (!entry.mergedAt) continue;
        if (Date.parse(entry.mergedAt) < cutoff) continue;
        pullRequests.push({
          number: entry.number,
          title: entry.title,
          url: entry.url,
          author: entry.author?.login ?? "unknown",
          mergedAt: entry.mergedAt,
        });
      }

      const { hasNextPage, endCursor } = data.repository.pullRequests.pageInfo;
      if (reachedCutoff || !hasNextPage) break;
      if (!endCursor) throw new GithubRequestError("GraphQL response missing pull request cursor", 502);
      cursor = endCursor;
    }
  }

  pullRequests.sort((left, right) => right.mergedAt.localeCompare(left.mergedAt));
  return { repo, base, asOf, pullRequests };
}

export interface GithubQuotaResource {
  limit: number;
  used: number;
  remaining: number;
  resetAt: string;
}

export interface GithubQuota {
  rest: GithubQuotaResource;
  graphql: GithubQuotaResource;
  fetchedAt: string;
}

let cachedQuota: GithubQuota | null = null;
const QUOTA_TTL_MS = 60_000;


function updateCachedGraphqlQuota(
  limit: number | null,
  used: number | null,
  remaining: number | null,
  resetAt: string | null,
): void {
  if (!cachedQuota || limit === null || used === null || remaining === null || resetAt === null) return;
  cachedQuota = {
    ...cachedQuota,
    graphql: { limit, used, remaining, resetAt },
    fetchedAt: new Date().toISOString(),
  };
}
export async function fetchGithubQuota(): Promise<GithubQuota> {
  if (mockGithub) {
    const resetAt = new Date(Date.now() + 60 * 60_000).toISOString();
    return { rest: { limit: 5_000, used: 10, remaining: 4_990, resetAt }, graphql: { limit: 5_000, used: 20, remaining: 4_980, resetAt }, fetchedAt: new Date().toISOString() };
  }
  const token = await ghToken();
  const generation = quotaGeneration(token);
  if (cachedQuota && Date.now() - Date.parse(cachedQuota.fetchedAt) < QUOTA_TTL_MS) return cachedQuota;
  if (quotaFetchInFlight?.generation === generation) return quotaFetchInFlight.promise;
  const entry = { generation, promise: fetchRateLimit(token, generation) };
  quotaFetchInFlight = entry;
  try {
    return await entry.promise;
  } finally {
    if (quotaFetchInFlight === entry) quotaFetchInFlight = null;
  }
}

let quotaFetchInFlight: { generation: number; promise: Promise<GithubQuota> } | null = null;

// The last quota reading if it is at most maxAgeMs old and its windows have not reset since,
// without a network call. Background pacing uses this so a relay-triggered refresh after a
// quiet minute does not first wait on /rate_limit.
export function recentGithubQuota(maxAgeMs: number, now = Date.now()): GithubQuota | null {
  if (mockGithub || !cachedQuota) return null;
  if (now - Date.parse(cachedQuota.fetchedAt) > maxAgeMs) return null;
  if (Date.parse(cachedQuota.graphql.resetAt) <= now || Date.parse(cachedQuota.rest.resetAt) <= now) return null;
  return cachedQuota;
}

async function fetchRateLimit(token: string, generation: number): Promise<GithubQuota> {
  const res = await githubApiResponse("GET", "/rate_limit", { authentication: { token, generation } });
  if (!res.ok) throw await githubResponseError("GitHub quota request failed", res);
  const body = (await res.json()) as {
    resources: Record<"core" | "graphql", { limit: number; used: number; remaining: number; reset: number }>;
  };
  const resource = (name: "core" | "graphql"): GithubQuotaResource => {
    const value = body.resources[name];
    return { limit: value.limit, used: value.used, remaining: value.remaining, resetAt: new Date(value.reset * 1_000).toISOString() };
  };
  const quota = { rest: resource("core"), graphql: resource("graphql"), fetchedAt: new Date().toISOString() };
  if (responseHasActiveQuota(res)) {
    cachedQuota = quota;
    updatePrimaryQuota("core", quota.rest.remaining, quota.rest.resetAt);
    updatePrimaryQuota("graphql", quota.graphql.remaining, quota.graphql.resetAt);
  }
  return quota;
}

export interface SearchHit {
  repo: string;
  number: number;
  title: string;
  updatedAt: string;
  headRefOid: string;
  ciState: string;
}

const SEARCH_QUERY = `
query($searchQuery: String!) {
  search(query: $searchQuery, type: ISSUE, first: 50) {
    nodes {
      ... on PullRequest {
        number
        title
        updatedAt
        headRefOid
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

function repositorySearchUnavailable(error: unknown): error is GithubRequestError {
  if (!(error instanceof GithubRequestError) || error.kind === "quota" || error.kind === "transport") return false;
  return error.status === 404
    || error.status === 422
    || (error.status === 403 && /permission|resource not accessible/i.test(error.message))
    || /repositories cannot be searched/i.test(error.message);
}

async function searchOpenPrBatch(repos: string[]): Promise<SearchHit[]> {
  const repoFilter = repos.map((repo) => `repo:${repo}`).join(" ");
  const searchQuery = `is:open is:pr archived:false involves:@me ${repoFilter}`;
  try {
    const data = await graphql<{
      search: {
        nodes: Array<{
          number: number;
          title: string;
          updatedAt: string;
          headRefOid: string;
          repository: { nameWithOwner: string };
          commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> };
        }>;
      };
    }>(SEARCH_QUERY, { searchQuery }, "background poll", "open PR search");
    for (const repo of repos) clearRepositoryUnavailable(repo);
    if (data.search.nodes.length === 50) {
      console.warn(`search hit the 50-result cap, PRs may be missing: ${searchQuery}`);
    }
    return data.search.nodes.map((node) => ({
      repo: node.repository.nameWithOwner,
      number: node.number,
      title: node.title,
      updatedAt: node.updatedAt,
      headRefOid: node.headRefOid,
      ciState: node.commits.nodes[0]?.commit.statusCheckRollup?.state ?? "NONE",
    }));
  } catch (error) {
    if (!repositorySearchUnavailable(error)) throw error;
    if (repos.length === 1) {
      const repo = repos.at(0);
      if (repo) reportRepositoryUnavailable(repo);
      return [];
    }
    const midpoint = Math.ceil(repos.length / 2);
    const searches = await Promise.allSettled([
      searchOpenPrBatch(repos.slice(0, midpoint)),
      searchOpenPrBatch(repos.slice(midpoint)),
    ]);
    const hits: SearchHit[] = [];
    for (const search of searches) {
      if (search.status === "rejected") throw search.reason;
      hits.push(...search.value);
    }
    return hits;
  }
}

export async function searchOpenPrs(repos: string[]): Promise<SearchHit[]> {
  if (mockGithub) return mockGithub.searchOpenPrs(repos);
  const available = repos.filter(repositoryAvailable);
  return available.length === 0 ? [] : searchOpenPrBatch(available);
}

export interface RepositoryOpenPr {
  repo: string;
  number: number;
  title: string;
  author: string;
  state: "OPEN";
  isDraft: boolean;
  updatedAt: string;
}

const REPOSITORY_OPEN_PRS_QUERY = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(
      states: OPEN
      first: 100
      after: $cursor
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      nodes { number title author { login } isDraft updatedAt }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export async function fetchRepositoryOpenPrs(repo: string): Promise<RepositoryOpenPr[]> {
  const [owner, name, extra] = repo.split("/");
  if (!owner || !name || extra !== undefined) throw new GithubRequestError(`Invalid repository: ${repo}`, 404);
  if (mockGithub) {
    return mockGithub.searchRecentPrs(repo)
      .filter((entry) => entry.state === "OPEN")
      .map((entry) => ({
        repo, number: entry.number, title: entry.title, author: entry.author,
        state: "OPEN", isDraft: entry.isDraft, updatedAt: entry.updatedAt,
      }));
  }

  const prs = new Map<number, RepositoryOpenPr>();
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  while (true) {
    const data: {
      repository: {
        pullRequests: {
          nodes: Array<{
            number: number;
            title: string;
            author: { login: string } | null;
            isDraft: boolean;
            updatedAt: string;
          }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null;
    } = await graphql(REPOSITORY_OPEN_PRS_QUERY, { owner, name, cursor }, "user action", "all PRs");
    if (!data.repository) throw new GithubRequestError(`Repository not found: ${repo}`, 404);
    const { nodes, pageInfo } = data.repository.pullRequests;
    for (const entry of nodes) {
      const previous = prs.get(entry.number);
      if (!previous || entry.updatedAt > previous.updatedAt) {
        prs.set(entry.number, {
          repo, number: entry.number, title: entry.title, author: entry.author?.login ?? "unknown",
          state: "OPEN", isDraft: entry.isDraft, updatedAt: entry.updatedAt,
        });
      }
    }
    if (!pageInfo.hasNextPage) return [...prs.values()];
    if (!pageInfo.endCursor) throw new GithubRequestError("GraphQL response missing pull request cursor", 502);
    if (seenCursors.has(pageInfo.endCursor)) throw new GithubRequestError("GraphQL response repeated pull request cursor", 502);
    seenCursors.add(pageInfo.endCursor);
    cursor = pageInfo.endCursor;
  }
}

export interface PaletteHit {
  repo: string;
  number: number;
  title: string;
  state: string;
}


export async function searchPrs(repos: string[], q: string): Promise<PaletteHit[]> {
  if (mockGithub) return mockGithub.searchPrs(repos, q);
  const repoFilter = repos.map((repo) => `repo:${repo}`).join(" ");
  const searchQuery = `is:pr ${repoFilter} in:title ${q}`;
  const items = await restSearchPrs(searchQuery, 15);
  return items.map((item) => ({
    repo: restSearchRepo(item),
    number: item.number,
    title: item.title,
    state: restSearchState(item),
  }));
}

type RawPrIndexEntry = {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  updatedAt: string;
  author: { login: string } | null;
  mergedAt?: string | null;
  closedAt?: string | null;
};

type RestPrSearchItem = {
  number: number;
  title: string;
  state: "open" | "closed";
  draft: boolean;
  updated_at: string;
  closed_at: string | null;
  user: { login: string } | null;
  repository_url: string;
  pull_request: { merged_at: string | null };
};

async function restSearchPrs(query: string, perPage: number): Promise<RestPrSearchItem[]> {
  const result = await restJson<{ items: RestPrSearchItem[] }>(
    `/search/issues?q=${encodeURIComponent(query)}&per_page=${perPage}`,
  );
  return result.items;
}

function restSearchRepo(item: RestPrSearchItem): string {
  return item.repository_url.split("/").slice(-2).join("/");
}

function restSearchState(item: RestPrSearchItem): PrState {
  return item.pull_request.merged_at ? "MERGED" : item.state.toUpperCase() as PrState;
}

const PR_INDEX_LOOKUP_CAP = 100;

export async function lookupPrIndexes(repo: string, numbers: number[]): Promise<PrIndexEntry[]> {
  const unique = [...new Set(numbers)]
    .filter((number) => Number.isSafeInteger(number) && number > 0)
    .slice(0, PR_INDEX_LOOKUP_CAP);
  if (unique.length === 0) return [];
  if (mockGithub) {
    const wanted = new Set(unique);
    return mockGithub.searchRecentPrs(repo).filter((entry) => wanted.has(entry.number));
  }

  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new GithubRequestError(`Invalid repository: ${repo}`, 404);
  const selections = unique
    .map((number, index) => `pr${index}: pullRequest(number: ${number}) {
      number title state isDraft updatedAt author { login }
    }`)
    .join("\n");
  const data = await graphql<{
    repository: (Record<string, RawPrIndexEntry | null>) | null;
  }>(`query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      ${selections}
    }
  }`, { owner, name }, "search", "PR lookup");

  return unique.flatMap((number, index) => {
    const entry = data.repository?.[`pr${index}`];
    return entry ? [{
      repo,
      number,
      title: entry.title,
      state: entry.state,
      isDraft: entry.isDraft,
      author: entry.author?.login ?? "unknown",
      updatedAt: entry.updatedAt,
    }] : [];
  });
}

export async function lookupPr(repo: string, number: number): Promise<PaletteHit | null> {
  try {
    const entry = (await lookupPrIndexes(repo, [number]))[0];
    return entry ? { repo, number: entry.number, title: entry.title, state: entry.state } : null;
  } catch (error) {
    if (error instanceof GithubRequestError && error.status === 404) return null;
    throw error;
  }
}

export interface PrIndexEntry {
  repo: string;
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  author: string;
  updatedAt: string;
  mergedAt?: string | null;
  closedAt?: string | null;
  involvesMe?: boolean;
}


export async function searchRecentPrs(repo: string): Promise<PrIndexEntry[]> {
  if (mockGithub) return mockGithub.searchRecentPrs(repo);
  if (!repositoryAvailable(repo)) return [];
  const searchQuery = `repo:${repo} is:pr sort:updated-desc`;
  try {
    const items = await restSearchPrs(searchQuery, 100);
    clearRepositoryUnavailable(repo);
    return items.map((item) => ({
      repo: restSearchRepo(item),
      number: item.number,
      title: item.title,
      state: restSearchState(item),
      isDraft: item.draft,
      author: item.user?.login ?? "unknown",
      updatedAt: item.updated_at,
      mergedAt: item.pull_request.merged_at,
      closedAt: item.closed_at,
    }));
  } catch (error) {
    if (!repositorySearchUnavailable(error)) throw error;
    reportRepositoryUnavailable(repo);
    return [];
  }
}

export interface ClosedPrSearchFailure {
  repo: string;
  error: GithubRequestError;
}

export interface ClosedPrSearchResult {
  items: PrIndexEntry[];
  failures: ClosedPrSearchFailure[];
}

const CLOSED_SEARCH_PAGE = 100;

// Without a lower bound the search always matches every closed PR the viewer ever touched, so
// it capped on every sweep and the cap said nothing. A sweep bounded by the previous one only
// caps when more PRs than one page really closed or changed in between.
export async function searchClosedPrs(repos: string[], updatedSince: string | null = null): Promise<ClosedPrSearchResult> {
  const items: PrIndexEntry[] = [];
  const failures: ClosedPrSearchFailure[] = [];
  for (const repo of repos) {
    if (mockGithub) {
      items.push(...mockGithub.searchRecentPrs(repo)
        .filter((entry) => entry.state === "MERGED" || entry.state === "CLOSED")
        .map((entry) => ({ ...entry, involvesMe: true })));
      continue;
    }
    if (!repositoryAvailable(repo)) continue;
    const updatedFilter = updatedSince === null ? "" : ` updated:>=${updatedSince.replace(/\.\d{3}Z$/, "Z")}`;
    const searchQuery = `is:pr is:closed involves:@me archived:false repo:${repo}${updatedFilter} sort:updated-desc`;
    try {
      const repoItems = await restSearchPrs(searchQuery, CLOSED_SEARCH_PAGE);
      if (updatedSince !== null && repoItems.length === CLOSED_SEARCH_PAGE) {
        console.warn(`search hit the ${CLOSED_SEARCH_PAGE}-result cap, PRs may be missing: ${searchQuery}`);
      }
      items.push(...repoItems.map((item) => ({
        repo: restSearchRepo(item),
        number: item.number,
        title: item.title,
        state: restSearchState(item),
        isDraft: item.draft,
        author: item.user?.login ?? "unknown",
        updatedAt: item.updated_at,
        mergedAt: item.pull_request.merged_at,
        closedAt: item.closed_at,
        involvesMe: true,
      })));
      clearRepositoryUnavailable(repo);
    } catch (error) {
      if (repositorySearchUnavailable(error)) {
        reportRepositoryUnavailable(repo);
        continue;
      }
      failures.push({
        repo,
        error: error instanceof GithubRequestError
          ? error
          : new GithubRequestError(
            `GitHub search unavailable for ${repo}: ${error instanceof Error ? error.message : String(error)}`,
            503,
            [],
            "transport",
            "search",
            null,
            error,
          ),
      });
    }
  }
  return { items, failures };
}

export interface ViewerRepo {
  nameWithOwner: string;
  pushedAt: string | null;
  isPrivate: boolean;
}


export async function viewerRepos(): Promise<ViewerRepo[]> {
  if (mockGithub) return mockGithub.viewerRepos();
  const repos = await restJson<Array<{ full_name: string; pushed_at: string | null; private: boolean }>>(
    "/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&direction=desc&per_page=30",
  );
  return repos.map((repo) => ({
    nameWithOwner: repo.full_name,
    pushedAt: repo.pushed_at,
    isPrivate: repo.private,
  }));
}

export interface ReviewItem {
  repo: string;
  number: number;
  url: string;
  title: string;
  branch: string;
  bucket: "review-requested" | "assigned" | "mentioned";
  isDraft: boolean;
  state: string;
}

interface ReviewSearchNode {
  number: number;
  url: string;
  title: string | null;
  isDraft: boolean;
  repository: { nameWithOwner: string } | null;
  headRefName: string;
  reviewDecision: string | null;
  statusCheckRollup: { state: string } | null;
}

function reviewStateFor(node: Pick<ReviewSearchNode, "isDraft" | "reviewDecision" | "statusCheckRollup">): string {
  if (node.isDraft) return "draft";
  const ci = node.statusCheckRollup?.state;
  const run = ci === "FAILURE" || ci === "ERROR" ? "failing" : ci === "PENDING" || ci === "EXPECTED" ? "running" : "passing";
  return `open.${run}.${node.reviewDecision === "APPROVED" ? "approved" : "none"}`;
}

function nodeToReviewItem(node: ReviewSearchNode | null, bucket: ReviewItem["bucket"]): ReviewItem | null {
  if (!node || typeof node.number !== "number" || !node.repository?.nameWithOwner) return null;
  return {
    repo: node.repository.nameWithOwner,
    number: node.number,
    url: node.url,
    title: node.title ?? `#${node.number}`,
    branch: node.headRefName,
    bucket,
    isDraft: node.isDraft,
    state: reviewStateFor(node),
  };
}

const BUCKET_RANK: Record<ReviewItem["bucket"], number> = {
  "review-requested": 0,
  assigned: 1,
  mentioned: 2,
};

const REVIEW_SEARCH_FIELDS = "number url title isDraft repository { nameWithOwner } headRefName reviewDecision statusCheckRollup { state }";

export interface ReviewsPollResult {
  items: ReviewItem[];
  cost: number | null;
  remaining: number | null;
}

export async function fetchReviewItems(): Promise<ReviewsPollResult> {
  if (mockGithub) return { items: [], cost: 0, remaining: 5_000 };
  const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const query = `
query {
  rateLimit { cost remaining }
  reviewRequested: search(query: "is:pr is:open review-requested:@me archived:false", type: ISSUE, first: 50) {
    nodes { ... on PullRequest { ${REVIEW_SEARCH_FIELDS} } }
  }
  assigned: search(query: "is:pr is:open assignee:@me archived:false", type: ISSUE, first: 50) {
    nodes { ... on PullRequest { ${REVIEW_SEARCH_FIELDS} } }
  }
  mentioned: search(query: "is:pr is:open mentions:@me archived:false updated:>=${since}", type: ISSUE, first: 50) {
    nodes { ... on PullRequest { ${REVIEW_SEARCH_FIELDS} } }
  }
}`;
  const data = await graphql<{
    rateLimit: { cost: number; remaining: number } | null;
    reviewRequested: { nodes: ReviewSearchNode[] };
    assigned: { nodes: ReviewSearchNode[] };
    mentioned: { nodes: ReviewSearchNode[] };
  }>(query, {}, "review inbox", "review inbox");

  const merged = new Map<string, ReviewItem>();
  const addBucket = (nodes: ReviewSearchNode[], bucket: ReviewItem["bucket"]) => {
    for (const node of nodes) {
      const item = nodeToReviewItem(node, bucket);
      if (!item) continue;
      const key = `${item.repo}#${item.number}`;
      const previous = merged.get(key);
      if (!previous || BUCKET_RANK[item.bucket] < BUCKET_RANK[previous.bucket]) merged.set(key, item);
    }
  };
  addBucket(data.reviewRequested.nodes, "review-requested");
  addBucket(data.assigned.nodes, "assigned");
  addBucket(data.mentioned.nodes, "mentioned");

  return {
    items: [...merged.values()],
    cost: data.rateLimit?.cost ?? null,
    remaining: data.rateLimit?.remaining ?? null,
  };
}



export interface AssignableUser {
  id: string;
  login: string;
  avatarUrl: string;
}


export async function fetchAssignableUsers(repo: string): Promise<AssignableUser[]> {
  if (mockGithub) return mockGithub.assignableUsers(repo);
  const users = await restJson<Array<{ node_id: string; login: string; avatar_url: string }>>(
    `/repos/${repo}/assignees?per_page=100`,
  );
  return users.map((user) => ({
    id: user.node_id,
    login: user.login,
    avatarUrl: user.avatar_url,
  }));
}


export async function addAssignees(repo: string, number: number, logins: string[]): Promise<void> {
  if (mockGithub) return;
  await restRequest("POST", `/repos/${repo}/issues/${number}/assignees`, { assignees: logins });
}


export async function requestReviewers(repo: string, number: number, logins: string[]): Promise<void> {
  if (mockGithub) return;
  await restRequest("POST", `/repos/${repo}/pulls/${number}/requested_reviewers`, { reviewers: logins });
}

const RESOLVE_REVIEW_THREAD_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { id isResolved }
  }
}`;

export async function resolveReviewThread(threadId: string): Promise<void> {
  if (mockGithub) return;
  await graphql(RESOLVE_REVIEW_THREAD_MUTATION, { threadId }, "user action", "resolve review thread");
}

export async function removeAssignees(repo: string, number: number, logins: string[]): Promise<void> {
  if (mockGithub) return;
  await restRequest("DELETE", `/repos/${repo}/issues/${number}/assignees`, { assignees: logins });
}

export async function removeRequestedReviewers(repo: string, number: number, logins: string[]): Promise<void> {
  if (mockGithub) return;
  await restRequest("DELETE", `/repos/${repo}/pulls/${number}/requested_reviewers`, { reviewers: logins });
}


const REACTION_GROUPS_FIELD = `reactionGroups { content viewerHasReacted reactors { totalCount } }`;

const CHECK_CONTEXT_FIELDS = `
  __typename
  ... on CheckRun {
    databaseId
    name
    status
    conclusion
    detailsUrl
    startedAt
    completedAt
    isRequired(pullRequestNumber: $number)
    checkSuite { app { databaseId } workflowRun { databaseId workflow { databaseId name } } }
  }
  ... on StatusContext {
    context
    state
    targetUrl
    createdAt
    isRequired(pullRequestNumber: $number)
  }
`;

const THREAD_COMMENT_FIELDS = `
  id
  databaseId
  diffHunk
  author { __typename login avatarUrl }
  body
  createdAt
  pullRequestReview { state }
  ${REACTION_GROUPS_FIELD}
`;

// commitList deliberately omits additions/deletions: GitHub computes them per commit, which
// took the query from ~0.7s to ~1.8s on a 48-commit PR. They never change for an oid, so
// completeCommitLineCounts carries them over and asks only about commits it has not seen.
const DETAIL_CHECKS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      lastCommit: commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
              contexts(first: 100) {
                pageInfo { hasNextPage endCursor }
                nodes { ${CHECK_CONTEXT_FIELDS} }
              }
            }
          }
        }
      }
      commitList: commits(last: 100) {
        nodes {
          commit {
            oid
            abbreviatedOid
            messageHeadline
            committedDate
            statusCheckRollup { state }
            author { name user { login avatarUrl } }
            parents(first: 1) { nodes { oid } }
          }
        }
      }
    }
  }
}`;

const DETAIL_REVIEW_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      ${REACTION_GROUPS_FIELD}
      viewerCanMergeAsAdmin
      reviewDecision
      reviews(first: 50) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          author { __typename login avatarUrl }
          state
          body
          submittedAt
          ${REACTION_GROUPS_FIELD}
        }
      }
      comments(last: 100) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          author { __typename login avatarUrl }
          body
          createdAt
          ${REACTION_GROUPS_FIELD}
        }
      }
      reviewThreads(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          diffSide
          comments(first: 50) {
            pageInfo { hasNextPage endCursor }
            nodes { ${THREAD_COMMENT_FIELDS} }
          }
        }
      }
      author { __typename login avatarUrl }
    }
  }
}`;

interface RawReactionGroup {
  content: string;
  viewerHasReacted: boolean;
  reactors: { totalCount: number };
}

export interface Reaction {
  content: string;
  count: number;
  viewerReacted: boolean;
}

function mapReactions(groups: RawReactionGroup[]): Reaction[] {
  return groups
    .filter((g) => g.reactors.totalCount > 0)
    .map((g) => ({ content: g.content, count: g.reactors.totalCount, viewerReacted: g.viewerHasReacted }));
}

type Author = { __typename?: string; login: string; avatarUrl: string };
type ReviewNode = { id: string; author: Author | null; state: string; body: string; submittedAt: string };
type CommentNode = { id: string; author: Author | null; body: string; createdAt: string };
type ThreadCommentNode = { id: string; databaseId: number | null; diffHunk: string; author: Author | null; body: string; createdAt: string; pullRequestReview?: { state: string } | null };

export function reviewHunkTail(hunk: string): string {
  return hunk
    .split("\n")
    .filter((line) => !line.startsWith("@@"))
    .slice(-4)
    .join("\n");
}

export function compactReviewHunks<T extends {
  reviewThreads?: { nodes?: Array<{ comments?: { nodes?: Array<{ diffHunk?: unknown }> } }> };
}>(detail: T): T {
  for (const thread of detail.reviewThreads?.nodes ?? []) {
    for (const comment of thread.comments?.nodes ?? []) {
      if (typeof comment.diffHunk === "string") comment.diffHunk = reviewHunkTail(comment.diffHunk);
    }
  }
  return detail;
}

export type PrState = "OPEN" | "CLOSED" | "MERGED";

type PrDetailShape<Rx> = {
  id: string;
  title: string;
  number: number;
  state: PrState;
  mergedAt: string | null;
  closedAt: string | null;
  isDraft: boolean;
  author: Author | null;
  baseRefName: string;
  baseRefOid: string;
  headRefName: string;
  headRefOid: string;
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: { totalCount: number; nodes: Array<{ path: string; additions: number; deletions: number }> };
  mergeable: string;
  mergeStateStatus: string;
  viewerCanMergeAsAdmin: boolean;
  autoMergeRequest: { mergeMethod: string; enabledBy: { login: string } | null } | null;
  reviewDecision: string | null;
  createdAt?: string;
  updatedAt: string;
  url: string;
  commitCount: { totalCount: number };
  lastCommit: {
    nodes: Array<{
      commit: {
        statusCheckRollup: {
          state: string;
          contexts: {
            pageInfo?: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<
              | {
                  __typename: "CheckRun";
                  databaseId?: number | null;
                  name: string;
                  status: string;
                  conclusion: string | null;
                  detailsUrl: string | null;
                  startedAt: string | null;
                  completedAt: string | null;
                  isRequired: boolean;
                  checkSuite: { app?: { databaseId: number | null } | null; workflowRun: { databaseId: number | null; workflow: { databaseId?: number | null; name: string } } | null } | null;
                }
              | {
                  __typename: "StatusContext";
                  context: string;
                  state: string;
                  targetUrl: string | null;
                  createdAt: string;
                  isRequired: boolean;
                }
            >;
          };
        } | null;
      };
    }>;
  };
  commitList: {
    nodes: Array<{
      commit: {
        oid: string;
        abbreviatedOid: string;
        messageHeadline: string;
        committedDate: string;
        additions?: number;
        deletions?: number;
        statusCheckRollup?: { state: string } | null;
        author: { name: string | null; user: { login: string; avatarUrl: string } | null } | null;
        parents: { nodes: Array<{ oid: string }> };
      };
    }>;
  };
  labels: { nodes: Array<{ name: string }> };
  assignees: { nodes: Array<{ login: string }> };
  reviewRequests: {
    nodes: Array<{ requestedReviewer: { __typename: string; login?: string; avatarUrl?: string; name?: string } | null }>;
  };
  reviews: { pageInfo?: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<ReviewNode & Rx> };
  comments: { pageInfo?: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<CommentNode & Rx> };
  reviewThreads: {
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{
      id: string;
      isResolved: boolean;
      isOutdated: boolean;
      path: string;
      line: number | null;
      diffSide: string;
      comments: { pageInfo?: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<ThreadCommentNode & Rx> };
    }>;
  };
} & Rx;

type RawPrDetail = PrDetailShape<{ reactionGroups: RawReactionGroup[] }>;

type RawPrDetailChecks = Pick<RawPrDetail, "lastCommit" | "commitList">;
type RawPrDetailReview = Pick<
  RawPrDetail,
  "author" | "reactionGroups" | "viewerCanMergeAsAdmin" | "reviewDecision" | "reviews" | "comments" | "reviewThreads"
>;
type RawPrDetailResidual = RawPrDetailChecks & RawPrDetailReview;
type RestPrDetailBase = Omit<RawPrDetail, keyof RawPrDetailResidual> & Pick<RawPrDetail, "author">;

type RestUser = { node_id: string; login: string; avatar_url: string; type?: string };
type RestPullRequest = {
  node_id: string;
  title: string;
  number: number;
  state: "open" | "closed";
  merged_at: string | null;
  closed_at: string | null;
  draft: boolean;
  user: RestUser | null;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  body: string | null;
  additions: number;
  deletions: number;
  changed_files: number;
  mergeable: boolean | null;
  mergeable_state: string;
  auto_merge: { merge_method: string; enabled_by: Pick<RestUser, "login"> | null } | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  commits: number;
  labels: Array<{ name: string }>;
  assignees: Array<Pick<RestUser, "login">>;
  requested_reviewers: RestUser[];
  requested_teams: Array<{ name: string }>;
};

type RestPullRequestFile = { filename: string; additions: number; deletions: number };

export function mapRestPrDetailBase(pullRequest: RestPullRequest, files: RestPullRequestFile[]): RestPrDetailBase {
  return {
    id: pullRequest.node_id,
    title: pullRequest.title,
    number: pullRequest.number,
    state: pullRequest.merged_at ? "MERGED" : pullRequest.state.toUpperCase() as PrState,
    mergedAt: pullRequest.merged_at,
    closedAt: pullRequest.closed_at,
    isDraft: pullRequest.draft,
    author: pullRequest.user ? { ...(pullRequest.user.type ? { __typename: pullRequest.user.type } : {}), login: pullRequest.user.login, avatarUrl: pullRequest.user.avatar_url } : null,
    baseRefName: pullRequest.base.ref,
    baseRefOid: pullRequest.base.sha,
    headRefName: pullRequest.head.ref,
    headRefOid: pullRequest.head.sha,
    body: pullRequest.body ?? "",
    additions: pullRequest.additions,
    deletions: pullRequest.deletions,
    changedFiles: pullRequest.changed_files,
    files: {
      totalCount: pullRequest.changed_files,
      nodes: files.map((file) => ({
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
      })),
    },
    mergeable: pullRequest.mergeable === null ? "UNKNOWN" : pullRequest.mergeable ? "MERGEABLE" : "CONFLICTING",
    mergeStateStatus: pullRequest.mergeable_state.toUpperCase(),
    autoMergeRequest: pullRequest.auto_merge
      ? {
          mergeMethod: pullRequest.auto_merge.merge_method.toUpperCase(),
          enabledBy: pullRequest.auto_merge.enabled_by,
        }
      : null,
    createdAt: pullRequest.created_at,
    updatedAt: pullRequest.updated_at,
    url: pullRequest.html_url,
    commitCount: { totalCount: pullRequest.commits },
    labels: { nodes: pullRequest.labels.map(({ name }) => ({ name })) },
    assignees: { nodes: pullRequest.assignees.map(({ login }) => ({ login })) },
    reviewRequests: {
      nodes: [
        ...pullRequest.requested_reviewers.map((reviewer) => ({
          requestedReviewer: {
            ...(reviewer.type ? { __typename: reviewer.type } : {}),
            login: reviewer.login,
            avatarUrl: reviewer.avatar_url,
          },
        })),
        ...pullRequest.requested_teams.map((team) => ({
          requestedReviewer: {
            __typename: "Team",
            name: team.name,
          },
        })),
      ],
    },
  };
}

async function fetchRestPrDetailBase(repo: string, number: number): Promise<RestPrDetailBase> {
  const [pullRequest, files] = await Promise.all([
    restJson<RestPullRequest>(`/repos/${repo}/pulls/${number}`),
    restJson<RestPullRequestFile[]>(`/repos/${repo}/pulls/${number}/files?per_page=100`),
  ]);
  return mapRestPrDetailBase(pullRequest, files);
}

export type PrDetail = PrDetailShape<{ reactions: Reaction[] }> & {
  viewerLogin: string;
  viewerIsAuthor: boolean;
  viewerReviewRequested: boolean;
  viewerReviewState: string | null;
};

type RawCheckConnection = NonNullable<RawPrDetail["lastCommit"]["nodes"][number]["commit"]["statusCheckRollup"]>["contexts"];
type RawThreadConnection = RawPrDetail["reviewThreads"];
type RawThread = RawThreadConnection["nodes"][number];
type RawThreadCommentConnection = RawThread["comments"];

const CHECK_CONTEXTS_PAGE_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      lastCommit: commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes { ${CHECK_CONTEXT_FIELDS} }
              }
            }
          }
        }
      }
    }
  }
}`;

const REVIEW_THREADS_PAGE_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          diffSide
          comments(first: 50) {
            pageInfo { hasNextPage endCursor }
            nodes { ${THREAD_COMMENT_FIELDS} }
          }
        }
      }
    }
  }
}`;

const THREAD_COMMENTS_PAGE_QUERY = `
query($threadId: ID!, $after: String!) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      comments(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${THREAD_COMMENT_FIELDS} }
      }
    }
  }
}`;


async function completeCheckContexts(
  owner: string,
  name: string,
  number: number,
  connection: RawCheckConnection,
  source: GithubUsageSource,
): Promise<void> {
  const cursors = new Set<string>();
  while (connection.pageInfo?.hasNextPage) {
    const after = connection.pageInfo.endCursor;
    if (!after || cursors.has(after)) throw new GithubRequestError("Check pagination returned an invalid cursor", 502);
    cursors.add(after);
    const data = await graphql<{
      repository: {
        pullRequest: {
          lastCommit: {
            nodes: Array<{ commit: { statusCheckRollup: { contexts: RawCheckConnection } | null } }>;
          };
        } | null;
      } | null;
    }>(CHECK_CONTEXTS_PAGE_QUERY, { owner, name, number, after }, source, "PR check pagination");
    const next = data.repository?.pullRequest?.lastCommit.nodes[0]?.commit.statusCheckRollup?.contexts;
    if (!next?.pageInfo) throw new GithubRequestError("Check pagination returned no page", 502);
    connection.nodes.push(...next.nodes);
    connection.pageInfo = next.pageInfo;
  }
}


type RawCommitList = RawPrDetail["commitList"];
type CommitLineCounts = { additions: number; deletions: number };

const COMMIT_OID_RE = /^[0-9a-f]{40}$/;
const COMMIT_LINE_COUNTS_BATCH = 100;

function commitLineCountsQuery(oids: string[]): string {
  const fields = oids.map((oid, index) => `c${index}: object(oid: "${oid}") { ... on Commit { additions deletions } }`);
  return `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    ${fields.join("\n    ")}
  }
}`;
}

const COMMIT_LIST_LINE_COUNTS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(last: 100) { nodes { commit { oid additions deletions } } }
    }
  }
}`;

type CommitLineCountSource = { commitList: { nodes: Array<{ commit: { oid: string } & Partial<CommitLineCounts> }> } };

function knownLineCounts(previous: CommitLineCountSource | null): Map<string, CommitLineCounts> {
  const known = new Map<string, CommitLineCounts>();
  for (const { commit } of previous?.commitList?.nodes ?? []) {
    if (typeof commit.additions === "number" && typeof commit.deletions === "number") {
      known.set(commit.oid, { additions: commit.additions, deletions: commit.deletions });
    }
  }
  return known;
}

// With no earlier snapshot every commit is unknown, so the counts for the whole list are asked
// for beside the checks query rather than after it.
async function fetchCommitListLineCounts(owner: string, name: string, number: number, source: GithubUsageSource): Promise<Map<string, CommitLineCounts>> {
  const data = await graphql<{
    repository: { pullRequest: { commits: { nodes: Array<{ commit: { oid: string } & CommitLineCounts }> } } | null } | null;
  }>(COMMIT_LIST_LINE_COUNTS_QUERY, { owner, name, number }, source, "PR commit line counts");
  return knownLineCounts({ commitList: data.repository?.pullRequest?.commits ?? { nodes: [] } });
}

// Line counts are a fallback for commits the local mirror cannot count, so a failed lookup
// leaves them unset rather than failing the whole detail.
async function completeCommitLineCounts(
  owner: string,
  name: string,
  commitList: RawCommitList,
  known: Map<string, CommitLineCounts>,
  source: GithubUsageSource,
): Promise<void> {
  const missing: RawCommitList["nodes"][number]["commit"][] = [];
  for (const { commit } of commitList.nodes) {
    const counts = known.get(commit.oid);
    if (counts) Object.assign(commit, counts);
    else if (COMMIT_OID_RE.test(commit.oid)) missing.push(commit);
  }
  for (let start = 0; start < missing.length; start += COMMIT_LINE_COUNTS_BATCH) {
    const batch = missing.slice(start, start + COMMIT_LINE_COUNTS_BATCH);
    try {
      const data = await graphql<{ repository: Record<string, Partial<CommitLineCounts> | null> | null }>(
        commitLineCountsQuery(batch.map((commit) => commit.oid)),
        { owner, name },
        source,
        "PR commit line counts",
      );
      batch.forEach((commit, index) => {
        const counts = data.repository?.[`c${index}`];
        if (typeof counts?.additions === "number" && typeof counts.deletions === "number") {
          commit.additions = counts.additions;
          commit.deletions = counts.deletions;
        }
      });
    } catch (error) {
      console.warn(`commit line counts unavailable for ${owner}/${name}:`, error);
      return;
    }
  }
}

async function fetchDetailChecks(
  owner: string,
  name: string,
  number: number,
  previous: Pick<PrDetail, "commitList"> | null,
  source: GithubUsageSource,
): Promise<RawPrDetailChecks | null> {
  const listCounts = previous
    ? null
    : fetchCommitListLineCounts(owner, name, number, source).catch((error) => {
      console.warn(`commit line counts unavailable for ${owner}/${name}#${number}:`, error);
      return new Map<string, CommitLineCounts>();
    });
  const data = await graphql<{
    repository: { pullRequest: RawPrDetailChecks | null } | null;
  }>(DETAIL_CHECKS_QUERY, { owner, name, number }, source, "PR checks");
  const checks = data.repository?.pullRequest;
  if (!checks) return null;
  const rollup = checks.lastCommit.nodes[0]?.commit.statusCheckRollup;
  const completeLineCounts = async () => {
    const known = listCounts ? await listCounts : knownLineCounts(previous);
    await completeCommitLineCounts(owner, name, checks.commitList, known, source);
  };
  await Promise.all([
    rollup ? completeCheckContexts(owner, name, number, rollup.contexts, source) : undefined,
    completeLineCounts(),
  ]);
  return checks;
}

async function fetchDetailReview(
  owner: string,
  name: string,
  number: number,
  source: GithubUsageSource,
): Promise<RawPrDetailReview | null> {
  const data = await graphql<{
    repository: { pullRequest: RawPrDetailReview | null } | null;
  }>(DETAIL_REVIEW_QUERY, { owner, name, number }, source, "PR review detail");
  const review = data.repository?.pullRequest;
  if (!review) return null;
  await completeReviewThreads(owner, name, number, review.reviewThreads, source);
  return review;
}

async function completeThreadComments(thread: RawThread, source: GithubUsageSource): Promise<void> {
  const cursors = new Set<string>();
  while (thread.comments.pageInfo?.hasNextPage) {
    const after = thread.comments.pageInfo.endCursor;
    if (!after || cursors.has(after)) throw new GithubRequestError("Review comment pagination returned an invalid cursor", 502);
    cursors.add(after);
    const data = await graphql<{ node: { comments: RawThreadCommentConnection } | null }>(
      THREAD_COMMENTS_PAGE_QUERY,
      { threadId: thread.id, after },
      source,
      "PR review comment pagination",
    );
    if (!data.node?.comments.pageInfo) throw new GithubRequestError("Review comment pagination returned no page", 502);
    thread.comments.nodes.push(...data.node.comments.nodes);
    thread.comments.pageInfo = data.node.comments.pageInfo;
  }
}

async function completeReviewThreads(
  owner: string,
  name: string,
  number: number,
  connection: RawThreadConnection,
  source: GithubUsageSource,
): Promise<void> {
  const cursors = new Set<string>();
  while (connection.pageInfo?.hasNextPage) {
    const after = connection.pageInfo.endCursor;
    if (!after || cursors.has(after)) throw new GithubRequestError("Review thread pagination returned an invalid cursor", 502);
    cursors.add(after);
    const data = await graphql<{
      repository: { pullRequest: { reviewThreads: RawThreadConnection } | null } | null;
    }>(REVIEW_THREADS_PAGE_QUERY, { owner, name, number, after }, source, "PR review thread pagination");
    const next = data.repository?.pullRequest?.reviewThreads;
    if (!next?.pageInfo) throw new GithubRequestError("Review thread pagination returned no page", 502);
    connection.nodes.push(...next.nodes);
    connection.pageInfo = next.pageInfo;
  }
  for (const thread of connection.nodes) {
    if (!thread.isResolved) await completeThreadComments(thread, source);
  }
}

function normalizeReviewDetail(
  review: RawPrDetailReview,
  viewerLogin: string,
  author: Author | null,
  reviewRequests: RestPrDetailBase["reviewRequests"],
) {
  const { reactionGroups, reviews, comments, reviewThreads, ...scalars } = review;
  const visibleReviews = reviews.nodes.filter((item) => item.state !== "PENDING");
  const viewerReviews = visibleReviews
    .filter((item) => item.author?.login === viewerLogin && item.submittedAt)
    .sort((a, b) => b.submittedAt!.localeCompare(a.submittedAt!));
  return {
    ...scalars,
    reactions: mapReactions(reactionGroups),
    viewerIsAuthor: author?.login === viewerLogin,
    viewerReviewRequested: reviewRequests.nodes.some((request) => request.requestedReviewer?.login === viewerLogin),
    viewerReviewState: viewerReviews[0]?.state ?? null,
    reviews: {
      pageInfo: reviews.pageInfo,
      nodes: visibleReviews.map(({ reactionGroups, ...item }) => ({
        ...item,
        reactions: mapReactions(reactionGroups),
      })),
    },
    comments: {
      pageInfo: comments.pageInfo,
      nodes: comments.nodes.map(({ reactionGroups, ...item }) => ({
        ...item,
        reactions: mapReactions(reactionGroups),
      })),
    },
    reviewThreads: {
      pageInfo: reviewThreads.pageInfo,
      nodes: reviewThreads.nodes.flatMap((thread) => {
        const visibleComments = thread.comments.nodes.filter(
          (comment) => comment.pullRequestReview?.state !== "PENDING",
        );
        if (visibleComments.length === 0) return [];
        return [{
          ...thread,
          comments: {
            pageInfo: thread.comments.pageInfo,
            nodes: visibleComments.map(({ reactionGroups, pullRequestReview: _review, ...item }) => ({
              ...item,
              diffHunk: reviewHunkTail(item.diffHunk),
              reactions: mapReactions(reactionGroups),
            })),
          },
        }];
      }),
    },
  };
}

export async function fetchPrDetail(
  repo: string,
  number: number,
  source: GithubUsageSource = "app detail",
  previous: Pick<PrDetail, "commitList"> | null = null,
): Promise<PrDetail> {
  if (mockGithub) return mockGithub.detail(repo, number);
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new GithubRequestError(`Invalid repository: ${repo}`, 404);
  const [checks, review, rest, viewerLogin] = await Promise.all([
    fetchDetailChecks(owner, name, number, previous, source),
    fetchDetailReview(owner, name, number, source),
    fetchRestPrDetailBase(repo, number),
    getViewerLogin(),
  ]);
  if (!checks || !review) throw new GithubRequestError(`${repo}#${number} was not found`, 404);
  return {
    ...rest,
    ...checks,
    viewerLogin,
    ...normalizeReviewDetail(review, viewerLogin, review.author, rest.reviewRequests),
  };
}

export type PrDetailScope = "all" | "checks" | "review";

export async function fetchPrDetailPart(
  repo: string,
  number: number,
  current: PrDetail,
  scope: Exclude<PrDetailScope, "all">,
  source: GithubUsageSource,
): Promise<PrDetail> {
  if (mockGithub) return mockGithub.detail(repo, number);
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new GithubRequestError(`Invalid repository: ${repo}`, 404);

  if (scope === "checks") {
    const checks = await fetchDetailChecks(owner, name, number, current, source);
    if (!checks) throw new GithubRequestError(`${repo}#${number} was not found`, 404);
    return {
      ...current,
      ...checks,
    };
  }

  const [review, viewerLogin] = await Promise.all([
    fetchDetailReview(owner, name, number, source),
    getViewerLogin(),
  ]);
  if (!review) throw new GithubRequestError(`${repo}#${number} was not found`, 404);
  return {
    ...current,
    viewerLogin,
    ...normalizeReviewDetail(review, viewerLogin, review.author, current.reviewRequests),
  };
}

export interface PrCommentSince {
  kind: "comment" | "review" | "review comment" | "thread";
  author: string;
  body: string;
  createdAt: string;
  path: string | null;
  line: number | null;
  state: string | null;
  url: string | null;
}

async function fetchRestPages<T>(initialUrl: string, label = "GitHub comments request failed"): Promise<T[]> {
  const pages: T[] = [];
  const seen = new Set<string>();
  let url: string | null = initialUrl;
  while (url !== null) {
    if (seen.has(url)) throw new GithubRequestError("GitHub REST pagination repeated a page", 502);
    seen.add(url);
    const parsed = new URL(url);
    const response = await githubApiResponse("GET", `${parsed.pathname}${parsed.search}`);
    if (!response.ok) throw await githubResponseError(label, response);
    pages.push(...await response.json() as T[]);
    const next: string | undefined = response.headers
      .get("link")
      ?.split(",")
      .find((part: string) => part.includes('rel="next"'))
      ?.match(/<([^>]+)>/)?.[1];
    url = next ?? null;
  }
  return pages;
}

export async function fetchPrCommentsSince(repo: string, number: number, since: string): Promise<PrCommentSince[]> {
  if (mockGithub) {
    const detail = mockGithub.detail(repo, number);
    return [
      ...detail.comments.nodes.map((comment) => ({
        kind: "comment" as const,
        author: comment.author?.login ?? "unknown",
        body: comment.body,
        createdAt: comment.createdAt,
        path: null,
        line: null,
        state: null,
        url: detail.url,
      })),
      ...detail.reviews.nodes.filter((review) => review.body.trim()).map((review) => ({
        kind: "review" as const,
        author: review.author?.login ?? "unknown",
        body: review.body,
        createdAt: review.submittedAt,
        path: null,
        line: null,
        state: review.state,
        url: detail.url,
      })),
      ...detail.reviewThreads.nodes.flatMap((thread) => thread.comments.nodes.map((comment) => ({
        kind: "thread" as const,
        author: comment.author?.login ?? "unknown",
        body: comment.body,
        createdAt: comment.createdAt,
        path: thread.path,
        line: thread.line,
        state: null,
        url: detail.url,
      }))),
    ]
      .filter((comment) => Date.parse(comment.createdAt) >= Date.parse(since))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  const baseUrl = `https://api.github.com/repos/${repo}`;
  const encodedSince = encodeURIComponent(since);
  const [issueComments, reviewComments, reviews] = await Promise.all([
    fetchRestPages<{
      user: { login: string } | null;
      body: string;
      created_at: string;
      html_url: string;
    }>(`${baseUrl}/issues/${number}/comments?since=${encodedSince}&per_page=100`),
    fetchRestPages<{
      user: { login: string } | null;
      body: string;
      created_at: string;
      html_url: string;
      path: string;
      line: number | null;
      original_line: number | null;
      pull_request_review_id: number | null;
    }>(`${baseUrl}/pulls/${number}/comments?since=${encodedSince}&per_page=100`),
    fetchRestPages<{
      id: number;
      user: { login: string } | null;
      body: string;
      submitted_at: string | null;
      state: string;
      html_url: string;
    }>(`${baseUrl}/pulls/${number}/reviews?per_page=100`),
  ]);
  const pendingReviewIds = new Set(
    reviews.filter((review) => review.state === "PENDING").map((review) => review.id),
  );
  const sinceMs = Date.parse(since);
  return [
    ...issueComments.map((comment) => ({
      kind: "comment" as const,
      author: comment.user?.login ?? "unknown",
      body: comment.body,
      createdAt: comment.created_at,
      path: null,
      line: null,
      state: null,
      url: comment.html_url,
    })),
    ...reviewComments
      .filter((comment) =>
        comment.pull_request_review_id === null || !pendingReviewIds.has(comment.pull_request_review_id)
      )
      .map((comment) => ({
        kind: "review comment" as const,
        author: comment.user?.login ?? "unknown",
        body: comment.body,
        createdAt: comment.created_at,
        path: comment.path,
        line: comment.line ?? comment.original_line,
        state: null,
        url: comment.html_url,
      })),
    ...reviews
      .filter((review) => review.state !== "PENDING" && typeof review.submitted_at === "string" && review.body.trim())
      .map((review) => ({
        kind: "review" as const,
        author: review.user?.login ?? "unknown",
        body: review.body,
        createdAt: review.submitted_at!,
        path: null,
        line: null,
        state: review.state,
        url: review.html_url,
      })),
  ]
    .filter((comment) => Date.parse(comment.createdAt) >= sinceMs)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

export async function fetchDiff(repo: string, number: number, base?: string, head?: string): Promise<string> {
  if (mockGithub) return mockGithub.diff(repo, number);
  const path = base && head
    ? `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`
    : `/repos/${repo}/pulls/${number}`;
  const res = await githubApiResponse("GET", path, { accept: "application/vnd.github.v3.diff" });
  if (!res.ok) throw await githubResponseError("diff fetch failed", res);
  return res.text();
}

export interface RunJobStep {
  name: string;
  number: number;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface RunJob {
  id: number;
  run_id: number;
  run_attempt: number;
  head_sha: string;
  head_branch?: string;
  workflow_name?: string;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
  runner_name?: string | null;
  runner_group_name?: string | null;
  labels?: string[];
  steps: RunJobStep[];
}

export interface ActionWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
}

export async function fetchActionWorkflows(repo: string): Promise<ActionWorkflow[]> {
  if (mockGithub) return mockGithub.actionWorkflows(repo);
  const workflows: ActionWorkflow[] = [];
  for (let page = 1;; page++) {
    const payload = await githubRestJson<{ workflows?: ActionWorkflow[] }>(
      "GET",
      `/repos/${repo}/actions/workflows?per_page=100&page=${page}`,
    );
    const batch = payload.workflows ?? [];
    workflows.push(...batch);
    if (batch.length < 100) return workflows;
  }
}

export async function rerunFailedJobs(repo: string, runId: number): Promise<void> {
  if (mockGithub) return mockGithub.rerunFailedJobs(repo, runId);
  if (!/^[^/]+\/[^/]+$/.test(repo) || !Number.isSafeInteger(runId) || runId <= 0) {
    throw new RestRequestError("Invalid repository or workflow run", 400);
  }
  const response = await githubRestResponse(
    "POST",
    `/repos/${encodedRepo(repo)}/actions/runs/${runId}/rerun-failed-jobs`,
  );
  if (response.ok) return;
  const responseCopy = response.clone();
  const generation = responseQuotaGenerations.get(response);
  if (generation !== undefined) responseQuotaGenerations.set(responseCopy, generation);
  const resource = responseQuotaResources.get(response);
  if (resource !== undefined) responseQuotaResources.set(responseCopy, resource);
  const classified = await githubResponseError("GitHub REST request failed", responseCopy);
  const body = await response.text();
  let detail = body;
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.message === "string") detail = parsed.message;
  } catch {
    // GitHub occasionally returns a plain-text proxy response.
  }
  throw new RestRequestError(
    `Could not re-run failed jobs${detail ? `: ${detail}` : ` (GitHub ${response.status})`}`,
    response.status,
    classified.kind,
    classified.resource,
    classified.resetAt,
    classified,
  );
}

export interface WorkflowRun {
  id: number;
  run_attempt: number;
  head_sha: string;
  head_branch: string;
  name: string;
  path: string;
  display_title?: string;
  event?: string;
  actor?: { login?: string } | null;
  status: string;
  conclusion: string | null;
  created_at?: string;
  updated_at: string;
  run_started_at?: string;
  run_number?: number;
  pull_requests?: Array<{ number?: number }>;
  html_url: string | null;
}
export async function fetchWorkflowRun(repo: string, runId: number): Promise<WorkflowRun> {
  if (mockGithub) return mockGithub.workflowRun(repo, runId);
  return githubRestJson<WorkflowRun>("GET", `/repos/${repo}/actions/runs/${runId}`);
}


export async function fetchWorkflowRuns(repo: string, headSha: string): Promise<WorkflowRun[]> {
  if (mockGithub) return [];
  const runs: WorkflowRun[] = [];
  for (let page = 1;; page++) {
    const payload = await githubRestJson<{ workflow_runs?: WorkflowRun[] }>(
      "GET",
      `/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100&page=${page}`,
    );
    const batch = payload.workflow_runs ?? [];
    runs.push(...batch);
    if (batch.length < 100) return runs;
  }
}
export async function fetchRecentWorkflowRuns(repo: string, maxPages = 2): Promise<WorkflowRun[]> {
  if (mockGithub) return [];
  const runs: WorkflowRun[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const payload = await githubRestJson<{ workflow_runs?: WorkflowRun[] }>(
      "GET",
      `/repos/${repo}/actions/runs?per_page=100&page=${page}`,
    );
    const batch = payload.workflow_runs ?? [];
    runs.push(...batch);
    if (batch.length < 100) break;
  }
  return runs;
}

export async function fetchWorkflowRunsForWorkflow(repo: string, workflowId: number, maxPages = 1): Promise<WorkflowRun[]> {
  if (mockGithub) return [];
  const runs: WorkflowRun[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const payload = await githubRestJson<{ workflow_runs?: WorkflowRun[] }>(
      "GET",
      `/repos/${repo}/actions/workflows/${workflowId}/runs?per_page=100&page=${page}`,
    );
    const batch = payload.workflow_runs ?? [];
    runs.push(...batch);
    if (batch.length < 100) break;
  }
  return runs;
}


export async function fetchRunJobs(repo: string, runId: number, attempt?: number): Promise<RunJob[]> {
  if (mockGithub) return mockGithub.runJobs(repo, runId);
  const jobs: RunJob[] = [];
  for (let page = 1;; page++) {
    const endpoint = attempt === undefined
      ? `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100&filter=latest&page=${page}`
      : `/repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`;
    const payload = await githubRestJson<{ jobs?: RunJob[] }>("GET", endpoint);
    const batch = payload.jobs ?? [];
    jobs.push(...batch);
    if (batch.length < 100) return jobs;
  }
}

// The logs endpoint answers 302 with a Location that expires after a minute, and that storage host
// rejects a request carrying GitHub's Authorization header, so the download is a second bare fetch.
export async function fetchJobLog(repo: string, jobId: number): Promise<string> {
  if (mockGithub) return mockGithub.jobLog(repo, jobId);
  const res = await githubApiResponse("GET", `/repos/${repo}/actions/jobs/${jobId}/logs`, { redirect: "manual" });
  const location = res.headers.get("location");
  if (!location) throw await githubResponseError("job log fetch failed", res);
  let download: Response;
  try {
    download = await fetch(location, { signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new GithubRequestError(
      `GitHub job log transport unavailable: ${error instanceof Error ? error.message : String(error)}`,
      503,
      [],
      "transport",
      null,
      null,
      error,
    );
  }
  if (!download.ok) throw new GithubRequestError(`job log download failed: ${download.status}`, download.status);
  return download.text();
}

export interface FileHistoryCommit {
  sha: string;
  subject: string;
  author: string;
  date: string;
  prNumber: number | null;
}

export async function fetchFileHistory(repo: string, path: string, base: string): Promise<FileHistoryCommit[]> {
  if (mockGithub) return mockGithub.fileHistory(repo, path, base);
  const params = new URLSearchParams({ sha: base, path, per_page: "30" });
  const res = await githubApiResponse("GET", `/repos/${repo}/commits?${params}`);
  if (!res.ok) throw await githubResponseError("file history fetch failed", res);
  const commits = (await res.json()) as Array<{
    sha: string;
    commit: { message: string; author: { name: string; date: string } | null };
    author: { login: string } | null;
  }>;
  return commits.map((c) => {
    const subject = c.commit.message.split("\n", 1)[0] ?? "";
    const prMatch = subject.match(/\(#(\d+)\)\s*$/);
    return {
      sha: c.sha,
      subject,
      author: c.author?.login ?? c.commit.author?.name ?? "unknown",
      date: c.commit.author?.date ?? "",
      prNumber: prMatch ? Number(prMatch[1]) : null,
    };
  });
}

export interface FileHistoryDiff {
  patch: string | undefined;
  additions: number;
  deletions: number;
  status: string;
  previous_filename: string | null;
}

export async function fetchFileHistoryDiff(repo: string, sha: string, path: string): Promise<FileHistoryDiff | null> {
  if (mockGithub) return mockGithub.fileHistoryDiff(repo, sha, path);
  const res = await githubApiResponse("GET", `/repos/${repo}/commits/${sha}`);
  if (!res.ok) throw await githubResponseError("commit fetch failed", res);
  const body = (await res.json()) as {
    files?: Array<{
      filename: string;
      previous_filename?: string;
      patch?: string;
      additions: number;
      deletions: number;
      status: string;
    }>;
  };
  const files = body.files ?? [];
  const entry = files.find((f) => f.filename === path) ?? files.find((f) => f.previous_filename === path);
  if (!entry) return null;
  return {
    patch: entry.patch,
    additions: entry.additions,
    deletions: entry.deletions,
    status: entry.status,
    previous_filename: entry.previous_filename ?? null,
  };
}

export type FileContents = { content: string } | { tooLarge: true };

export async function fetchFileContents(repo: string, path: string, sha: string): Promise<FileContents> {
  if (mockGithub) return mockGithub.fileContents(repo, path, sha);
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const res = await githubApiResponse("GET", `/repos/${repo}/contents/${encodedPath}?ref=${sha}`);
  if (!res.ok) throw await githubResponseError("file fetch failed", res);
  const body = (await res.json()) as { content?: string; encoding?: string };
  if (Array.isArray(body) || body.encoding !== "base64") return { tooLarge: true };
  return { content: strictUtf8Decoder.decode(Buffer.from(body.content ?? "", "base64")) };
}

export type PrFileEdit = {
  repo: string;
  number: number;
  path: string;
  expectedHeadOid: string;
  content: string;
  message: string;
};

type RestPull = {
  state: string;
  head: {
    sha: string;
    ref: string;
    repo: { full_name: string } | null;
  };
};

type RestTreeEntry = {
  path: string;
  mode: string;
  type: string;
  sha: string;
};

async function githubRestResponse(method: string, path: string, body?: unknown): Promise<Response> {
  return githubApiResponse(method, path, { body });
}

async function githubRestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await githubRestResponse(method, path, body);
  if (!response.ok) throw await githubResponseError("GitHub REST request failed", response);
  return response.json() as Promise<T>;
}

function encodedRepo(repo: string): string {
  return repo.split("/").map(encodeURIComponent).join("/");
}

function isRefUpdateRace(error: unknown): boolean {
  return error instanceof GithubRequestError
    && /REST request failed: (?:409|422)\b/i.test(error.message)
    && /(?:fast.?forward|reference update|expected|stale)/i.test(error.message);
}

export async function commitPrFileEdit(input: PrFileEdit): Promise<{ commitOid: string }> {
  const [owner, name] = input.repo.split("/");
  if (!owner || !name) throw new GithubRequestError(`Invalid repository: ${input.repo}`, 404);
  const expectedHeadOid = input.expectedHeadOid.toLowerCase();
  const baseRepo = encodedRepo(input.repo);
  const pullRequest = await githubRestJson<RestPull>("GET", `/repos/${baseRepo}/pulls/${input.number}`);
  if (pullRequest.state !== "open") throw new StalePrHeadError("PR is no longer open");
  if (!pullRequest.head?.ref || !pullRequest.head.repo?.full_name) {
    throw new StalePrHeadError("PR head is unavailable");
  }
  if (pullRequest.head.sha.toLowerCase() !== expectedHeadOid) throw new StalePrHeadError();

  const headRepo = encodedRepo(pullRequest.head.repo.full_name);
  const commit = await githubRestJson<{ tree: { sha: string } }>(
    "GET",
    `/repos/${headRepo}/git/commits/${expectedHeadOid}`,
  );
  const segments = input.path.split("/");
  let treeSha = commit.tree.sha;
  for (let index = 0; index < segments.length; index += 1) {
    const tree = await githubRestJson<{ tree: RestTreeEntry[] }>(
      "GET",
      `/repos/${headRepo}/git/trees/${encodeURIComponent(treeSha)}`,
    );
    const entry = tree.tree.find((candidate) => candidate.path === segments[index]);
    const isFile = index === segments.length - 1;
    if (!entry || (isFile ? entry.type !== "blob" || entry.mode !== "100644" : entry.type !== "tree")) {
      throw new StalePrHeadError("PR file is no longer editable");
    }
    treeSha = entry.sha;
  }
  const currentBlob = await githubRestJson<{ content: string; encoding: string }>(
    "GET",
    `/repos/${headRepo}/git/blobs/${encodeURIComponent(treeSha)}`,
  );
  if (currentBlob.encoding !== "base64") throw new StalePrHeadError("PR file is no longer editable");
  try {
    if (strictUtf8Decoder.decode(Buffer.from(currentBlob.content, "base64")).includes("\0")) {
      throw new StalePrHeadError("PR file is no longer editable");
    }
  } catch (error) {
    if (error instanceof StalePrHeadError) throw error;
    throw new StalePrHeadError("PR file is no longer editable");
  }

  const blob = await githubRestJson<{ sha: string }>("POST", `/repos/${headRepo}/git/blobs`, {
    content: Buffer.from(input.content).toString("base64"),
    encoding: "base64",
  });
  const nextTree = await githubRestJson<{ sha: string }>("POST", `/repos/${headRepo}/git/trees`, {
    base_tree: commit.tree.sha,
    tree: [{ path: input.path, mode: "100644", type: "blob", sha: blob.sha }],
  });
  const nextCommit = await githubRestJson<{ sha: string }>("POST", `/repos/${headRepo}/git/commits`, {
    message: input.message,
    tree: nextTree.sha,
    parents: [expectedHeadOid],
  });
  const encodedRef = pullRequest.head.ref.split("/").map(encodeURIComponent).join("/");
  try {
    await githubRestJson("PATCH", `/repos/${headRepo}/git/refs/heads/${encodedRef}`, {
      sha: nextCommit.sha,
      force: false,
    });
  } catch (error) {
    if (isRefUpdateRace(error)) throw new StalePrHeadError();
    throw error;
  }
  return { commitOid: nextCommit.sha };
}

export class RestRequestError extends GithubRequestError {
  constructor(
    message: string,
    status: number,
    kind: GithubRequestErrorKind = "http",
    resource: GithubQuotaResourceName | null = null,
    resetAt: string | null = null,
    cause?: unknown,
  ) {
    super(message, status, [], kind, resource, resetAt, cause);
    this.name = "RestRequestError";
  }
}

async function restRequest(method: string, path: string, body: unknown): Promise<void> {
  if (mockGithub) return;
  const response = await githubRestResponse(method, path, body);
  if (!response.ok) {
    const error = await githubResponseError(`${method} ${path} failed`, response);
    throw new RestRequestError(error.message, error.status, error.kind, error.resource, error.resetAt, error);
  }
}

async function restJson<T>(path: string): Promise<T> {
  return githubRestJson<T>("GET", path);
}

export interface PendingReviewComment {
  id: number;
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
  body: string;
}

export interface PendingReview {
  id: number;
  headSha: string;
  body: string;
  comments: PendingReviewComment[];
}

type RestPendingReview = {
  id: number;
  node_id: string;
  user: { login: string } | null;
  state: string;
  body: string | null;
  commit_id: string;
};

type RestPendingReviewComment = {
  id: number;
  path: string;
  line?: number | null;
  original_line?: number | null;
  side?: string | null;
  original_side?: string | null;
  start_line?: number | null;
  original_start_line?: number | null;
  start_side?: string | null;
  original_start_side?: string | null;
  body: string;
};

function pendingComment(comment: RestPendingReviewComment): PendingReviewComment {
  const line = comment.line ?? comment.original_line;
  const side = comment.side ?? comment.original_side;
  const startLine = comment.start_line ?? comment.original_start_line;
  const startSide = comment.start_side ?? comment.original_start_side;
  if (!Number.isSafeInteger(line) || line! <= 0 || (side !== "LEFT" && side !== "RIGHT")) {
    throw new GithubRequestError("GitHub returned a pending review comment without a valid diff location", 502);
  }
  if (startLine != null && (!Number.isSafeInteger(startLine) || startLine <= 0 || (startSide !== "LEFT" && startSide !== "RIGHT"))) {
    throw new GithubRequestError("GitHub returned a pending review comment without a valid diff range", 502);
  }
  const pending: PendingReviewComment = {
    id: comment.id,
    path: comment.path,
    line: line!,
    side,
    body: comment.body,
  };
  if (startLine != null) {
    pending.startLine = startLine;
    pending.startSide = startSide === "LEFT" ? "LEFT" : "RIGHT";
  }
  return pending;
}

async function viewerPendingReviewRecord(
  repo: string,
  number: number,
  includeComments = true,
): Promise<(PendingReview & { nodeId: string }) | null> {
  if (mockGithub) return mockGithub.pendingReview(repo, number);
  const encoded = encodedRepo(repo);
  const [viewer, reviews] = await Promise.all([
    getViewerLogin(),
    fetchRestPages<RestPendingReview>(
      `https://api.github.com/repos/${encoded}/pulls/${number}/reviews?per_page=100`,
      "GitHub pending reviews request failed",
    ),
  ]);
  const review = reviews.find((candidate) =>
    candidate.state === "PENDING" && candidate.user?.login.toLowerCase() === viewer.toLowerCase()
  );
  if (!review) return null;
  const comments = includeComments
    ? await fetchRestPages<RestPendingReviewComment>(
        `https://api.github.com/repos/${encoded}/pulls/${number}/reviews/${review.id}/comments?per_page=100`,
        "GitHub pending review comments request failed",
      )
    : [];
  return {
    id: review.id,
    nodeId: review.node_id,
    headSha: review.commit_id,
    body: review.body ?? "",
    comments: comments.map(pendingComment),
  };
}

export async function fetchPendingReview(repo: string, number: number): Promise<PendingReview | null> {
  const review = await viewerPendingReviewRecord(repo, number);
  if (!review) return null;
  const { nodeId: _nodeId, ...pending } = review;
  return pending;
}

async function latestPrHead(repo: string, number: number): Promise<string> {
  if (mockGithub) return mockGithub.detail(repo, number).headRefOid;
  const pull = await githubRestJson<{ state: string; head?: { sha?: string } }>(
    "GET",
    `/repos/${encodedRepo(repo)}/pulls/${number}`,
  );
  if (pull.state !== "open" || !pull.head?.sha) throw new StalePrHeadError("PR head is unavailable because the pull request is no longer open");
  return pull.head.sha;
}

function stalePendingReview(draftHead: string, currentHead: string): StalePrHeadError {
  return new StalePrHeadError(
    `PR head changed from pending review ${draftHead} to current ${currentHead}; edit, remove, or discard the pending review before submitting`,
  );
}

type PendingCommentInput = Omit<PendingReviewComment, "id">;

export async function addPendingInlineComment(
  repo: string,
  number: number,
  headSha: string,
  comment: PendingCommentInput,
): Promise<void> {
  const review = await viewerPendingReviewRecord(repo, number, false);
  const currentHead = await latestPrHead(repo, number);
  if (currentHead.toLowerCase() !== headSha.toLowerCase()) throw stalePendingReview(headSha, currentHead);
  if (review && review.headSha.toLowerCase() !== headSha.toLowerCase()) throw stalePendingReview(review.headSha, currentHead);
  if (mockGithub) {
    mockGithub.addPendingComment(repo, number, headSha, comment);
    return;
  }
  if (!review) {
    await restRequest("POST", `/repos/${encodedRepo(repo)}/pulls/${number}/reviews`, {
      commit_id: headSha,
      comments: [{
        body: comment.body,
        path: comment.path,
        line: comment.line,
        side: comment.side,
        ...(comment.startLine === undefined
          ? {}
          : { start_line: comment.startLine, start_side: comment.startSide ?? comment.side }),
      }],
    });
    return;
  }
  await graphql(
    `mutation($input: AddPullRequestReviewThreadInput!) {
      addPullRequestReviewThread(input: $input) { thread { id } }
    }`,
    {
      input: {
        pullRequestReviewId: review.nodeId,
        body: comment.body,
        path: comment.path,
        line: comment.line,
        side: comment.side,
        ...(comment.startLine === undefined
          ? {}
          : { startLine: comment.startLine, startSide: comment.startSide ?? comment.side }),
      },
    },
    "user action",
    "add pending review thread",
  );
}

async function requirePendingReview(
  repo: string,
  number: number,
  reviewId: number,
  includeComments = false,
): Promise<PendingReview & { nodeId: string }> {
  const review = await viewerPendingReviewRecord(repo, number, includeComments);
  if (!review || review.id !== reviewId) throw new RestRequestError("Pending review not found", 404);
  return review;
}

export async function editPendingReviewComment(
  repo: string,
  number: number,
  reviewId: number,
  commentId: number,
  body: string,
): Promise<void> {
  const review = await requirePendingReview(repo, number, reviewId, true);
  if (!review.comments.some((comment) => comment.id === commentId)) throw new RestRequestError("Pending review comment not found", 404);
  if (mockGithub) return mockGithub.editPendingComment(repo, number, reviewId, commentId, body);
  await restRequest("PATCH", `/repos/${encodedRepo(repo)}/pulls/comments/${commentId}`, { body });
}

export async function deletePendingReviewComment(
  repo: string,
  number: number,
  reviewId: number,
  commentId: number,
): Promise<void> {
  const review = await requirePendingReview(repo, number, reviewId, true);
  if (!review.comments.some((comment) => comment.id === commentId)) throw new RestRequestError("Pending review comment not found", 404);
  if (mockGithub) return mockGithub.deletePendingComment(repo, number, reviewId, commentId);
  await restRequest("DELETE", `/repos/${encodedRepo(repo)}/pulls/comments/${commentId}`, undefined);
}

export async function discardPendingReview(repo: string, number: number, reviewId: number): Promise<void> {
  await requirePendingReview(repo, number, reviewId);
  if (mockGithub) return mockGithub.discardPendingReview(repo, number, reviewId);
  await restRequest("DELETE", `/repos/${encodedRepo(repo)}/pulls/${number}/reviews/${reviewId}`, undefined);
}

export async function submitPendingReview(
  repo: string,
  number: number,
  reviewId: number,
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  body: string,
): Promise<void> {
  const review = await requirePendingReview(repo, number, reviewId);
  const currentHead = await latestPrHead(repo, number);
  if (review.headSha.toLowerCase() !== currentHead.toLowerCase()) throw stalePendingReview(review.headSha, currentHead);
  if (mockGithub) return mockGithub.submitPendingReview(repo, number, reviewId, event, body);
  await restRequest("POST", `/repos/${encodedRepo(repo)}/pulls/${number}/reviews/${reviewId}/events`, { event, body });
}

export async function postIssueComment(repo: string, number: number, body: string): Promise<string> {
  if (mockGithub) return "mock-comment";
  const path = `/repos/${repo}/issues/${number}/comments`;
  const response = await githubRestResponse("POST", path, { body });
  if (!response.ok) {
    const error = await githubResponseError(`POST ${path} failed`, response);
    throw new RestRequestError(error.message, error.status, error.kind, error.resource, error.resetAt, error);
  }
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || !("node_id" in result) || typeof result.node_id !== "string") {
    throw new Error(`POST ${path} returned no comment node ID`);
  }
  return result.node_id;
}

export async function postReviewCommentReply(
  repo: string,
  number: number,
  rootCommentId: number,
  body: string,
): Promise<void> {
  await restRequest("POST", `/repos/${repo}/pulls/${number}/comments/${rootCommentId}/replies`, { body });
}

export async function postInlineComment(
  repo: string,
  number: number,
  commitId: string,
  comment: {
    path: string;
    line: number;
    side: "LEFT" | "RIGHT";
    startLine?: number;
    startSide?: "LEFT" | "RIGHT";
    body: string;
  },
): Promise<void> {
  await restRequest("POST", `/repos/${repo}/pulls/${number}/comments`, {
    body: comment.body,
    commit_id: commitId,
    path: comment.path,
    line: comment.line,
    side: comment.side,
    ...(comment.startLine === undefined
      ? {}
      : { start_line: comment.startLine, start_side: comment.startSide ?? comment.side }),
  });
}

export async function postReview(repo: string, number: number, event: string, body: string): Promise<void> {
  await restRequest("POST", `/repos/${repo}/pulls/${number}/reviews`, { event, body });
}

export async function mergePullRequest(repo: string, number: number, method: MergeMethod, sha?: string): Promise<void> {
  await restRequest("PUT", `/repos/${repo}/pulls/${number}/merge`, sha ? { merge_method: method, sha } : { merge_method: method });
}

const ENABLE_AUTO_MERGE_MUTATION = `
mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: $mergeMethod }) { pullRequest { id } }
}`;

const DISABLE_AUTO_MERGE_MUTATION = `
mutation($pullRequestId: ID!) {
  disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) { pullRequest { id } }
}`;

// method null disables GitHub's native auto-merge; the enum is the REST method upper-cased
export async function setGithubAutoMerge(pullRequestId: string, method: MergeMethod | null): Promise<void> {
  if (mockGithub) return mockGithub.setAutoMerge(pullRequestId, method);
  if (method) await graphql(ENABLE_AUTO_MERGE_MUTATION, { pullRequestId, mergeMethod: method.toUpperCase() }, "user action", "enable auto-merge");
  else await graphql(DISABLE_AUTO_MERGE_MUTATION, { pullRequestId }, "user action", "disable auto-merge");
}

const RESOLVE_THREAD_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}`;

const UNRESOLVE_THREAD_MUTATION = `
mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}`;

export async function findCodeScanningAlert(repo: string, number: number, path: string, line: number | null): Promise<number> {
  type Alert = { number: number; most_recent_instance: { location: { path: string; start_line: number; end_line?: number } } };
  const alerts = await fetchRestPages<Alert>(`https://api.github.com/repos/${encodedRepo(repo)}/code-scanning/alerts?ref=${encodeURIComponent(`refs/pull/${number}/merge`)}&tool_name=CodeQL&per_page=100`);
  const matches = alerts.filter((alert) => {
    const location = alert.most_recent_instance.location;
    return location.path === path && line !== null && line >= location.start_line && line <= (location.end_line ?? location.start_line);
  });
  if (matches.length !== 1) throw new Error("Could not uniquely identify the CodeQL alert. Open the finding on GitHub to choose its dismissal reason.");
  return matches[0]!.number;
}

export async function setCodeScanningAlertResolved(repo: string, alertNumber: number, resolved: boolean, dismissal?: { reason: string; comment?: string }): Promise<void> {
  const choice = resolved ? validateCodeScanningDismissal(dismissal) : undefined;
  await restRequest("PATCH", `/repos/${encodedRepo(repo)}/code-scanning/alerts/${alertNumber}`,
    choice ? { state: "dismissed", dismissed_reason: choice.reason, ...(choice.comment !== undefined ? { dismissed_comment: choice.comment } : {}) } : { state: "open" });
}

export async function setThreadResolved(threadId: string, resolved: boolean): Promise<void> {
  if (mockGithub) return;
  await graphql(resolved ? RESOLVE_THREAD_MUTATION : UNRESOLVE_THREAD_MUTATION, { threadId }, "user action", resolved ? "resolve review thread" : "unresolve review thread");
}


export async function updatePullRequestBranch(repo: string, number: number): Promise<void> {
  if (mockGithub) return;
  await restRequest("PUT", `/repos/${repo}/pulls/${number}/update-branch`, {});
}

const MARK_READY_MUTATION = `
mutation($pullRequestId: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) { pullRequest { isDraft } }
}`;

export async function markPullRequestReadyForReview(pullRequestId: string): Promise<void> {
  if (mockGithub) return;
  await graphql(MARK_READY_MUTATION, { pullRequestId }, "user action", "mark PR ready");
}


export async function closePullRequest(repo: string, number: number): Promise<void> {
  if (mockGithub) return;
  await restRequest("PATCH", `/repos/${repo}/pulls/${number}`, { state: "closed" });
}


export async function updatePullRequestBody(repo: string, number: number, body: string): Promise<void> {
  if (mockGithub) return;
  await restRequest("PATCH", `/repos/${repo}/pulls/${number}`, { body });
}


export async function updatePullRequestTitle(repo: string, number: number, title: string): Promise<void> {
  if (mockGithub) return;
  await restRequest("PATCH", `/repos/${repo}/pulls/${number}`, { title });
}
