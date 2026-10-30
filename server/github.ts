import { GithubAppError, githubAppAuthentication, githubAppConfigPath, invalidateGithubAppToken, observedGithubAppId, type GithubAppAuthentication } from "./githubApp.ts";
import { validateCodeScanningDismissal } from "../shared/codeScanning.js";
import type { MergeMethod } from "./mergeMethod.ts";
import type { ResolvedMerge } from "./mirror.ts";
import { mockGithub, MOCK_FIXTURE_CLOCK } from "./mockGithub.ts";
import {
  githubAuthStatus as liveGithubAuthStatus,
  liveGithubToken,
  startGithubSetup as startLiveGithubSetup,
  type GithubAuthStatus,
} from "./githubAuth.ts";
import {
  activeGithubRestCoverage,
  beginGithubRestRequest,
  currentGithubUsageSource,
  endGithubRestCoverage,
  finishGithubRestRequest,
  githubRestCharged,
  githubRestCoverage,
  githubRestPullRequest,
  instrumentGithubGraphql,
  normalizeGithubRestEndpoint,
  RATE_LIMIT_ALIAS,
  recordGithubGraphqlUsage,
  recordGithubRestUsage,
  withGithubUsageSource,
  type GithubRestCoverage,
  type GithubUsageSource,
} from "./githubUsage.ts";
import { readSettings, restFallbackEnabled, restUsageEnabled, settingsRepos } from "./settings.ts";
import { mergeAttributionWanted } from "./notifications.ts";
import { createConcurrencyLimit } from "./concurrency.ts";
import { GRAPHQL_BACKGROUND_RESERVE } from "../ui/src/lib/quotaImpact.js";
import type { PrCheck } from "./checkState.ts";
import {
  restAuthor,
  restCheckContexts,
  restCommitList,
  restIssueComments,
  restReactionGroups,
  restReviewDecision,
  restReviews,
  restReviewThreads,
  restRollupState,
  type RestCheckRun,
  type RestCommitStatus,
  type RestIssueComment,
  type RestPrCommit,
  type RestReactions,
  type RestReview,
  type RestReviewComment,
} from "./githubRestFallback.ts";
import {
  clearRepositoryUnavailable,
  reportRepositoryUnavailable,
  repositoryAvailable,
} from "./systemIssues.ts";
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type GithubGraphqlError = { type?: string; message?: string; path?: readonly (string | number)[] };
export type GithubQuotaResourceName = "core" | "search" | "graphql";
export type GithubRequestErrorKind = "http" | "graphql" | "quota" | "transport";

export class GithubRequestError extends Error {
  credential?: string;
  // An allowed missing PR alias proves App repository access even though routing still falls back.
  appReadSucceeded?: boolean;
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
    if (cause instanceof GithubRequestError) this.credential = cause.credential;
    this.name = "GithubRequestError";
  }
}

type QuotaDeadline = { status: number; resetAt: string; until: number };
type CredentialState = {
  identity: string;
  ledgerIdentity: string;
  kind: "user" | "app";
  installationId?: number;
  repositories: Set<string>;
  token: string | null;
  observedAt: string | null;
  blockedQuotas: Map<GithubQuotaResourceName, QuotaDeadline>;
  quotaProbeInFlight: Map<GithubQuotaResourceName, { primary: QuotaDeadline; promise: Promise<void> }>;
  lastQuotaProbeAt: Map<GithubQuotaResourceName, number>;
  cachedQuota: GithubQuota | null;
  graphqlReading: GithubQuotaResource | null;
  restReadings: Map<RestQuotaResourceName, GithubQuotaResource>;
  quotaFetchInFlight: Promise<GithubQuota> | null;
};
type Authentication = { token: string; state: CredentialState };
const credentialStates = new Map<string, CredentialState>();
const userCredentials = new Map<string, CredentialState>();
const responseCredentials = new WeakMap<Response, CredentialState>();
const responseQuotaResources = new WeakMap<Response, GithubQuotaResourceName>();
const primaryExemptResponses = new WeakSet<Response>();
// A secondary limit is a request-rate signal, not another primary pool to spend.
let secondaryCooldown: QuotaDeadline | null = null;
let userQuota = credentialState("user", "user");

type GithubAppReadIssue = {
  at: string;
  kind: "quota" | "access" | "authentication" | "connection" | "request";
  resetAt: string | null;
};
export type GithubAppReadHealth = {
  repositories: { repo: string; lastSuccessAt: string | null; error: GithubAppReadIssue | null }[];
  cooldownUntil: string | null;
};
type AppReadObservation = GithubAppReadHealth["repositories"][number] & {
  configPath: string;
  appId: string | null;
  credential: string | null;
  sequence: number;
  visible: boolean;
};
const appReadObservations = new Map<string, AppReadObservation>();
// Dispatch order, not completion order, determines which completed outcome is current.
let appReadSequence = 0;

// A status snapshot is observational: no discovery, token issuance, quota fetch, or probe.
export function githubAppReadHealth(appId: string | null): GithubAppReadHealth {
  const configPath = githubAppConfigPath();
  const now = Date.now();
  return {
    repositories: [...appReadObservations.values()]
      .filter((item) => item.visible && item.configPath === configPath && (item.appId === appId || item.appId === null && item.lastSuccessAt === null))
      .map(({ repo, lastSuccessAt, error, credential }) => {
        const state = credential === null ? undefined : credentialStates.get(credential);
        let primary: QuotaDeadline | null = null;
        for (const block of state?.blockedQuotas.values() ?? []) {
          if (block.until > now && (!primary || block.until > primary.until)) primary = block;
        }
        return {
          repo, lastSuccessAt,
          error: primary
            ? { at: state?.observedAt ?? error?.at ?? lastSuccessAt ?? new Date(now).toISOString(), kind: "quota" as const, resetAt: primary.resetAt }
            : error ? { ...error } : null,
        };
      })
      .sort((a, b) => a.repo.localeCompare(b.repo)),
    cooldownUntil: activeSecondaryCooldown()?.resetAt ?? null,
  };
}

function rememberAppRead(
  repo: string, appId: string | null, credential: string | null, sequence: number,
  error: GithubAppReadIssue | null, missing = false,
): void {
  repo = repo.toLowerCase();
  const configPath = githubAppConfigPath();
  const previous = appReadObservations.get(repo);
  if (previous && previous.sequence > sequence) return;
  // Hidden missing-installation outcomes still retire older in-flight reads without adding UI rows.
  const sameApp = previous?.configPath === configPath && previous.appId === appId;
  const visible = !missing || appId !== null && (!!(sameApp && previous.visible)
    || settingsRepos().some((tracked) => tracked.toLowerCase() === repo));
  appReadObservations.delete(repo);
  appReadObservations.set(repo, {
    repo, configPath, appId, credential: missing ? null : credential, sequence, visible,
    lastSuccessAt: error === null ? new Date(Date.now()).toISOString() : !missing && sameApp ? previous.lastSuccessAt : null,
    error,
  });
  if (appReadObservations.size > 256) appReadObservations.delete(appReadObservations.keys().next().value!);
}

function rememberAppReadFailure(repo: string, error: unknown, appId: string | null, credential: string | null, sequence: number): void {
  let kind: GithubAppReadIssue["kind"] = "request";
  let resetAt: string | null = null;
  if (error instanceof GithubAppError) {
    const response = new Response(null, { status: error.status ?? 502, headers: error.headers });
    const quota = error.secondaryRateLimited || error.status === 429
      || (error.status === 403 && error.headers.get("x-ratelimit-remaining") === "0");
    kind = quota ? "quota" : error.status === 401 ? "authentication"
      : error.status === 403 || error.status === 404 ? "access" : error.kind;
    if (quota) resetAt = (retryAfterDeadline(response) ?? primaryResetDeadline(response))?.resetAt
      ?? (error.secondaryRateLimited ? new Date(Date.now() + SECONDARY_RATE_LIMIT_FALLBACK_MS).toISOString() : null);
  } else if (error instanceof GithubRequestError) {
    kind = error.kind === "quota" ? "quota" : error.status === 401 ? "authentication"
      : error.status === 403 || error.status === 404
        || error.graphqlErrors.some((item) => item.type === "FORBIDDEN" || item.type === "NOT_FOUND" || item.type === "INSUFFICIENT_SCOPES")
        ? "access" : error.kind === "transport" ? "connection" : "request";
    resetAt = error.resetAt;
  } else if (error instanceof Error && !(error instanceof SyntaxError)) {
    const code = (error as NodeJS.ErrnoException).code;
    if (error.name === "AbortError" || error.name === "TimeoutError"
      || /^(?:ECONNRESET|ECONNABORTED|ETIMEDOUT|EPIPE|ERR_STREAM|UND_ERR|ConnectionClosed)/.test(code ?? "")
      || /socket|connection|stream.*(?:closed|failed)|body.*(?:abort|closed|failed)|timed out/i.test(error.message)) {
      kind = "connection";
    }
  }
  const missing = error instanceof GithubAppError && error.status === 404;
  if (missing && credential) {
    for (const affectedRepo of credentialStates.get(credential)?.repositories ?? []) {
      rememberAppRead(affectedRepo, appId, null, sequence, { at: new Date(Date.now()).toISOString(), kind, resetAt }, true);
    }
  }
  rememberAppRead(repo, appId, credential, sequence, { at: new Date(Date.now()).toISOString(), kind, resetAt }, missing);
}

async function appRepositoryRead<T>(
  repo: string, authentication: Authentication, read: (authentication: Authentication) => Promise<T>,
): Promise<T> {
  const appId = authentication.state.identity.split(":")[1]!;
  const sequence = ++appReadSequence;
  try {
    const value = await read(authentication);
    rememberAppRead(repo, appId, authentication.state.identity, sequence, null);
    return value;
  } catch (error) {
    if (error instanceof GithubRequestError && error.appReadSucceeded) {
      rememberAppRead(repo, appId, authentication.state.identity, sequence, null);
    } else {
      rememberAppReadFailure(repo, error, appId, authentication.state.identity, sequence);
    }
    throw error;
  }
}

function credentialState(identity: string, kind: "user" | "app", installationId?: number): CredentialState {
  let state = credentialStates.get(identity);
  if (!state) {
    state = {
      identity, kind, installationId, repositories: new Set(), token: null, observedAt: null,
      ledgerIdentity: kind === "user" ? "user" : identity,
      blockedQuotas: new Map(), quotaProbeInFlight: new Map(), lastQuotaProbeAt: new Map(),
      cachedQuota: null, graphqlReading: null, restReadings: new Map(), quotaFetchInFlight: null,
    };
    credentialStates.set(identity, state);
  }
  return state;
}

async function userAuthentication(): Promise<Authentication> {
  const token = await ghToken();
  let state = userCredentials.get(token);
  if (!state) {
    // Tokens have independent live limits; personal usage keeps its durable ledger.
    state = userCredentials.size === 0 ? userQuota : credentialState(`user:${crypto.randomUUID()}`, "user");
    state.token = token;
    userCredentials.set(token, state);
  }
  if (userQuota !== state) endGithubRestCoverage("user");
  userQuota = state;
  return { token, state };
}

async function appAuthentication(repo: string): Promise<Authentication | null> {
  if (readSettings().replica_ssh_host) throw new Error("GitHub access is disabled while PR Cockpit uses an SSH replica");
  const sequence = ++appReadSequence;
  let authentication: GithubAppAuthentication | null;
  let providerFailed = false;
  try {
    authentication = await githubAppAuthentication(repo);
  } catch (error) {
    if (!(error instanceof GithubAppError)) throw error;
    providerFailed = true;
    const appId = error.appId ?? observedGithubAppId();
    const credential = appId && error.installationId ? `app:${appId}:installation:${error.installationId}` : null;
    rememberAppReadFailure(repo, error, appId, credential, sequence);
    if (!error.secondaryRateLimited && (error.status === 403 || error.status === 404)) {
      authentication = null;
    } else {
      const response = new Response(null, { status: error.status ?? 502, headers: error.headers });
      let deadline: QuotaDeadline | null = null;
      if (error.secondaryRateLimited) {
        const until = Date.now() + SECONDARY_RATE_LIMIT_FALLBACK_MS;
        deadline = retryAfterDeadline(response)
          ?? (rateLimitHeader(response, "x-ratelimit-remaining") === 0 ? primaryResetDeadline(response) : null)
          ?? { status: response.status, until, resetAt: new Date(until).toISOString() };
        updateSecondaryQuota("core", deadline);
      }
      const requestError = new GithubRequestError(
        error.message, response.status, [], deadline ? "quota" : "http",
        deadline ? "core" : null, deadline?.resetAt ?? null, error,
      );
      requestError.credential = [...credentialStates.values()]
        .find((state) => state.kind === "app" && state.installationId === error.installationId)?.identity ?? "app";
      throw requestError;
    }
  }
  for (const state of credentialStates.values()) {
    if (state.kind === "app" && state.identity !== authentication?.identity) state.repositories.delete(repo.toLowerCase());
  }
  if (!authentication) {
    if (!providerFailed) {
      const appId = observedGithubAppId();
      if (appId) rememberAppRead(repo, appId, null, sequence, { at: new Date(Date.now()).toISOString(), kind: "access", resetAt: null }, true);
      else rememberAppRead(repo, null, null, sequence, { at: new Date(Date.now()).toISOString(), kind: "access", resetAt: null }, true);
    }
    return null;
  }
  return rememberAppAuthentication(repo, authentication);
}

function rememberAppAuthentication(repo: string, authentication: GithubAppAuthentication): Authentication {
  const state = credentialState(authentication.identity, "app", authentication.installationId);
  state.repositories.add(repo.toLowerCase());
  state.token = authentication.token;
  return { token: authentication.token, state };
}
const QUOTA_PROBE_INTERVAL_MS = 30_000;
// GitHub's /rate_limit counts a different core window than the one requests are charged against:
// it reported 1 used and its own reset while charged responses reported 1,143 used and another
// reset, and it reported the full 5,000 while every charged request answered "API rate limit
// exceeded". Only a charged request's X-RateLimit headers describe the token's real core budget.
const CORE_QUOTA_PROBE_PATH = "/user";
// A socket that dies silently (sleep, network change) never settles its fetch, and one hung
// request stalls the poll loop until restart, so every GitHub request carries a deadline.
const GITHUB_REQUEST_TIMEOUT_MS = 60_000;
const SECONDARY_RATE_LIMIT_FALLBACK_MS = 5 * 60_000;
function activeSecondaryCooldown(): QuotaDeadline | null {
  if (secondaryCooldown && Date.now() >= secondaryCooldown.until) secondaryCooldown = null;
  return secondaryCooldown;
}

function updatePrimaryQuota(
  resource: GithubQuotaResourceName,
  remaining: number,
  resetAt: string | null,
  status = 403,
  credential: CredentialState = userQuota,
): void {
  if (remaining > 0) {
    const reading = resource === "graphql" ? credential.graphqlReading : credential.restReadings.get(resource);
    if (reading && reading.resetAt === resetAt && reading.remaining < remaining) return;
    credential.blockedQuotas.delete(resource);
    return;
  }
  const until = resetAt === null ? Number.NaN : Date.parse(resetAt);
  if (remaining === 0 && resetAt !== null && Number.isFinite(until)) {
    credential.blockedQuotas.set(resource, { status, resetAt, until });
  }
}

function updateSecondaryQuota(_resource: GithubQuotaResourceName, deadline: QuotaDeadline): void {
  if (!secondaryCooldown || deadline.until > secondaryCooldown.until) secondaryCooldown = deadline;
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

function rateLimitHeader(response: Response, name: string): number | null {
  const raw = response.headers.get(name);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

// null when GitHub charged the request to a budget Cockpit does not gate (code_scanning_autofix,
// dependency_snapshots, ...): exhausting one of those says nothing about core, search, or GraphQL.
function responseQuotaResource(response: Response, fallback: GithubQuotaResourceName): GithubQuotaResourceName | null {
  const value = response.headers.get("x-ratelimit-resource");
  if (value === "core" || value === "search" || value === "graphql") return value;
  if (value !== null) return null;
  return responseQuotaResources.get(response) ?? fallback;
}

function accountQuota(
  response: Response,
  fallback: GithubQuotaResourceName,
  credential: CredentialState,
  chargesPrimary: boolean,
): void {
  const resource = responseQuotaResource(response, fallback);
  if (resource !== null && chargesPrimary) {
    const remaining = rateLimitHeader(response, "x-ratelimit-remaining");
    const primary = primaryResetDeadline(response);
    if (remaining === 0 && primary) {
      updatePrimaryQuota(resource, 0, primary.resetAt, primary.status, credential);
    } else if (remaining !== null && remaining > 0) {
      updatePrimaryQuota(resource, remaining, primary?.resetAt ?? null, 403, credential);
    }
    if (resource === "core" || resource === "search") recordRestReading(resource, response, credential);
  }
  if ((response.status === 403 || response.status === 429) && response.headers.has("retry-after")) {
    const secondary = retryAfterDeadline(response);
    if (secondary) updateSecondaryQuota(resource ?? fallback, secondary);
  }
}

function activeQuotaBlock(resource: GithubQuotaResourceName, credential = userQuota): QuotaDeadline | null {
  let primary = credential.blockedQuotas.get(resource);
  if (primary && Date.now() >= primary.until) {
    credential.blockedQuotas.delete(resource);
    primary = undefined;
  }
  const secondary = activeSecondaryCooldown();
  return !primary || (secondary && secondary.until >= primary.until) ? secondary : primary;
}

async function revalidateQuota(
  resource: GithubQuotaResourceName,
  token: string,
  credential: CredentialState,
): Promise<void> {
  // App primary blocks wait for reset; /user cannot probe an installation token.
  if (resource !== "core" || credential.kind !== "user") return;
  activeQuotaBlock(resource, credential);
  const primary = credential.blockedQuotas.get(resource);
  if (!primary || activeSecondaryCooldown()) return;
  const { quotaProbeInFlight, lastQuotaProbeAt } = credential;
  const existing = quotaProbeInFlight.get(resource);
  if (existing?.primary === primary) {
    await existing.promise;
    return;
  }
  const now = Date.now();
  if (now - (lastQuotaProbeAt.get(resource) ?? Number.NEGATIVE_INFINITY) < QUOTA_PROBE_INTERVAL_MS) return;
  lastQuotaProbeAt.set(resource, now);
  const entry: {
    primary: QuotaDeadline;
    promise: Promise<void>;
  } = { primary, promise: Promise.resolve() };
  entry.promise = (async () => {
    try {
      // A charged request with the token the refused request would use, so its headers are that
      // token's own core budget (see CORE_QUOTA_PROBE_PATH). A refused probe is not charged.
      const sentAt = new Date().toISOString();
      const coverage = restCoverageAtDispatch("core", credential);
      let response: Response;
      let requestStarted = false;
      try {
        const pending = fetch(`https://api.github.com${CORE_QUOTA_PROBE_PATH}`, {
          signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
          headers: {
            Authorization: `bearer ${token}`,
            Accept: "application/vnd.github+json",
          },
        });
        requestStarted = true;
        response = await pending;
      } catch (error) {
        if (requestStarted) recordRestAttempt("GET", CORE_QUOTA_PROBE_PATH, "core", null, sentAt, coverage, credential);
        else finishGithubRestRequest(coverage, credential.ledgerIdentity);
        throw error;
      }
      recordRestAttempt("GET", CORE_QUOTA_PROBE_PATH, "core", response, sentAt, coverage, credential);
      responseCredentials.set(response, credential);
      responseQuotaResources.set(response, resource);
      if (!response.ok) await githubResponseError("GitHub quota probe failed", response);
      const secondary = retryAfterDeadline(response);
      if ((response.status === 403 || response.status === 429) && secondary) {
        updateSecondaryQuota(resource, secondary);
      }
      if (responseQuotaResource(response, resource) !== resource) return;
      recordRestReading("core", response, credential);
      const remaining = rateLimitHeader(response, "x-ratelimit-remaining");
      // A response that settled while the probe was in flight may have recorded a newer block.
      if (credential.blockedQuotas.get(resource) !== primary) return;
      const reset = primaryResetDeadline(response);
      if (remaining !== null && remaining > 0) credential.blockedQuotas.delete(resource);
      else if (remaining === 0 && reset) credential.blockedQuotas.set(resource, reset);
    } catch {
      // Keep the recorded block when the probe is unreachable or malformed.
    }
  })().finally(() => {
    if (quotaProbeInFlight.get(resource) === entry) quotaProbeInFlight.delete(resource);
  });
  quotaProbeInFlight.set(resource, entry);
  await entry.promise;
}

function gatingQuotaBlock(resource: GithubQuotaResourceName, includePrimary: boolean, credential = userQuota): QuotaDeadline | null {
  return includePrimary ? activeQuotaBlock(resource, credential) : activeSecondaryCooldown();
}

function assertQuotaAvailable(resource: GithubQuotaResourceName, includePrimary = true, credential = userQuota): void {
  const blocked = activeSecondaryCooldown() ?? gatingQuotaBlock(resource, includePrimary, credential);
  if (!blocked) return;
  const secondary = activeSecondaryCooldown() !== null;
  const error = new GithubRequestError(
    secondary
      ? `GitHub ${resource} secondary rate limit cooling down until ${blocked.resetAt}`
      : `GitHub ${resource} quota exhausted until ${blocked.resetAt}`,
    blocked.status,
    [],
    "quota",
    resource,
    blocked.resetAt,
  );
  error.credential = credential.ledgerIdentity;
  throw error;
}

async function requireQuota(
  resource: GithubQuotaResourceName,
  authentication?: Authentication,
  includePrimary = true,
): Promise<Authentication> {
  const auth = authentication ?? await userAuthentication();
  if (includePrimary) await revalidateQuota(resource, auth.token, auth.state);
  assertQuotaAvailable(resource, includePrimary, auth.state);
  return auth;
}

function restCoverageAtDispatch(resource: GithubQuotaResourceName, credential: CredentialState): GithubRestCoverage | null {
  if (resource === "graphql") return null;
  beginGithubRestRequest(credential.ledgerIdentity);
  if (!restUsageEnabled()) return null;
  return githubRestCoverage(credential.ledgerIdentity);
}

function recordRestAttempt(
  method: string,
  path: string,
  resource: GithubQuotaResourceName,
  response: Response | null,
  sentAt: string,
  coverage: GithubRestCoverage | null,
  credential: CredentialState,
): void {
  if (resource === "graphql") return;
  finishGithubRestRequest(coverage, credential.ledgerIdentity);
  if (coverage === null || activeGithubRestCoverage(credential.ledgerIdentity) !== coverage) return;
  const endpoint = normalizeGithubRestEndpoint(path);
  const reset = response === null ? null : rateLimitHeader(response, "x-ratelimit-reset");
  recordGithubRestUsage({
    occurredAt: sentAt,
    credential: credential.ledgerIdentity,
    credentialKind: credential.kind,
    source: currentGithubUsageSource(),
    method,
    endpoint,
    pr: githubRestPullRequest(path),
    resource: response?.headers.get("x-ratelimit-resource") ?? resource,
    status: response?.status ?? null,
    used: response === null ? null : rateLimitHeader(response, "x-ratelimit-used"),
    remaining: response === null ? null : rateLimitHeader(response, "x-ratelimit-remaining"),
    resetAt: reset === null ? null : new Date(reset * 1_000).toISOString(),
    charged: response?.redirected ? null : githubRestCharged(method, endpoint, response?.status ?? null),
    coverageEpoch: coverage.epoch,
  });
}
const appRefreshes = new Map<string, Promise<Authentication | null>>();

async function refreshAppAuthentication(repo: string, rejected: Authentication): Promise<Authentication | null> {
  // Concurrent 401s for an old token must neither invalidate its replacement nor mint it twice.
  if (rejected.state.token !== rejected.token) return appAuthentication(repo);
  let refresh = appRefreshes.get(rejected.state.identity);
  if (!refresh) {
    invalidateGithubAppToken(rejected.state.identity);
    refresh = appAuthentication(repo).finally(() => {
      if (appRefreshes.get(rejected.state.identity) === refresh) appRefreshes.delete(rejected.state.identity);
    });
    appRefreshes.set(rejected.state.identity, refresh);
  }
  return refresh;
}

async function withRepositoryRead<T>(
  repo: string | undefined,
  resource: GithubQuotaResourceName,
  read: (authentication: Authentication) => Promise<T>,
): Promise<T> {
  // Check before discovery/token issuance too: changing credentials cannot evade a cooldown.
  assertQuotaAvailable(resource, false);
  let app = repo === undefined ? null : await appAuthentication(repo);
  if (app && isBackgroundSource(currentGithubUsageSource())) {
    const reading = resource === "graphql" ? liveGraphqlReading(Date.now(), app.state) : liveRestReading(resource, Date.now(), app.state);
    if (reading !== null && !backgroundQuotaAvailable(reading)
      && personalBackgroundAvailable(resource) === true) app = null;
  }
  if (app && !activeQuotaBlock(resource, app.state)) {
    try {
      return await appRepositoryRead(repo!, app, read);
    } catch (firstError) {
      let error = firstError;
      if (error instanceof GithubRequestError && error.status === 401) {
        assertQuotaAvailable(resource, false, app.state);
        app = await refreshAppAuthentication(repo!, app);
        if (!app) return read(await userAuthentication());
        try {
          return await appRepositoryRead(repo!, app, read);
        } catch (refreshedError) {
          error = refreshedError;
        }
      }
      if (!(error instanceof GithubRequestError) || activeSecondaryCooldown()) throw error;
      const primary = error.kind === "quota" && error.resource === resource;
      const permission = error.kind !== "quota" && (
        error.status === 403 || error.status === 404
        || (error.graphqlErrors.length > 0 && error.graphqlErrors.every((item) =>
          item.type === "FORBIDDEN" || item.type === "NOT_FOUND" || item.type === "INSUFFICIENT_SCOPES"))
      );
      if (!primary && !permission) throw error;
    }
  }
  // One user attempt only, including after an app refresh. Transport/auth failures stay explicit.
  return read(await userAuthentication());
}

function assertRepositoryPath(repo: string, path: string): void {
  const match = /^\/repos\/([^/?#]+)\/([^/?#]+)(?:[/?]|$)/.exec(path);
  if (!match || `${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}`.toLowerCase() !== repo.toLowerCase()
    || new URL(path, "https://api.github.com").pathname !== path.split("?")[0]) {
    throw new Error("GitHub read does not match its repository scope");
  }
}

async function repositoryApiRead<T>(
  repo: string,
  path: string,
  read: (response: Response) => Promise<T>,
  options: { accept?: string; redirect?: RequestInit["redirect"] } = {},
): Promise<T> {
  assertRepositoryPath(repo, path);
  return withRepositoryRead(repo, quotaResource(path), async (authentication) => {
    const response = await githubApiResponse("GET", path, { ...options, authentication });
    if (!response.ok && response.status !== 302) throw await githubResponseError("GitHub repository read failed", response);
    return read(response);
  });
}

async function githubApiResponse(
  method: string,
  path: string,
  options: {
    body?: unknown;
    accept?: string;
    redirect?: RequestInit["redirect"];
    authentication?: Authentication;
    ifNoneMatch?: string;
  } = {},
): Promise<Response> {
  const resource = quotaResource(path);
  // GitHub does not charge GET /rate_limit, so quota stays readable while core is exhausted. Its
  // counts are not the charged window (see CORE_QUOTA_PROBE_PATH), so it neither records nor
  // clears a primary block. Secondary cooldowns still apply.
  const rateLimitRead = method === "GET" && path === "/rate_limit";
  const { token, state } = await requireQuota(resource, options.authentication, !rateLimitRead);
  let response: Response;
  const sentAt = new Date().toISOString();
  const coverage = restCoverageAtDispatch(resource, state);
  let requestStarted = false;
  try {
    const pending = fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `bearer ${token}`,
        Accept: options.accept ?? "application/vnd.github+json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.ifNoneMatch === undefined ? {} : { "If-None-Match": options.ifNoneMatch }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: options.redirect,
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
    requestStarted = true;
    response = await pending;
  } catch (error) {
    if (requestStarted) recordRestAttempt(method, path, resource, null, sentAt, coverage, state);
    else if (resource !== "graphql") finishGithubRestRequest(coverage, state.ledgerIdentity);
    const failure = new GithubRequestError(
      `GitHub ${resource} transport unavailable: ${error instanceof Error ? error.message : String(error)}`,
      503,
      [],
      "transport",
      resource,
      null,
      error,
    );
    failure.credential = state.ledgerIdentity;
    throw failure;
  }
  recordRestAttempt(method, path, resource, response, sentAt, coverage, state);
  responseQuotaResources.set(response, resource);
  responseCredentials.set(response, state);
  if (rateLimitRead) primaryExemptResponses.add(response);
  accountQuota(response, resource, state, !rateLimitRead);
  return response;
}

async function githubResponseError(label: string, response: Response): Promise<GithubRequestError> {
  const credential = responseCredentials.get(response);
  const fallback = responseQuotaResources.get(response)
    ?? quotaResource(new URL(response.url || "https://api.github.com").pathname);
  const charged = responseQuotaResource(response, fallback);
  const resource = charged ?? fallback;
  const body = await response.text();
  const secondaryWithoutDeadline = (response.status === 403 || response.status === 429)
    && !response.headers.has("retry-after")
    && ((response.status === 429 && response.headers.get("x-ratelimit-remaining") !== "0") || /secondary rate limit|abuse detection/i.test(body));
  if (secondaryWithoutDeadline && credential) {
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
  // An untracked budget has no recorded block, so its own headers carry the wait.
  const resetAt = !quota
    ? null
    : charged === null
      ? (retryAfterDeadline(response)
        ?? (response.headers.get("x-ratelimit-remaining") === "0" ? primaryResetDeadline(response) : null))?.resetAt ?? null
      : credential
        ? gatingQuotaBlock(charged, !primaryExemptResponses.has(response), credential)?.resetAt ?? null
        : null;
  const error = new GithubRequestError(
    `${label}: ${response.status}${body ? ` ${body}` : ""}`,
    response.status,
    [],
    quota ? "quota" : "http",
    charged,
    resetAt,
  );
  error.credential = credential?.ledgerIdentity;
  return error;
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
// Undefined until REST /user answered; GraphQL viewer reads carry no id.
let cachedViewerId: number | null | undefined;

const VIEWER_LOGIN_QUERY = `
query {
  viewer { login }
}`;

// REST while core has room; a fresh process with core exhausted would otherwise have no viewer
// until the core window resets, so GraphQL answers then.
export async function getViewerLogin(source: GithubUsageSource = "app detail"): Promise<string> {
  if (mockGithub) return mockGithub.viewerLogin;
  try {
    return await restViewerLogin();
  } catch (error) {
    if (!coreQuotaExhausted(error)) throw error;
  }
  if (cachedViewerLogin) return cachedViewerLogin;
  const data = await graphql<{ viewer: { login: string } }>(VIEWER_LOGIN_QUERY, {}, source, "viewer login");
  cachedViewerLogin = data.viewer.login;
  return cachedViewerLogin;
}

// A login learned through GraphQL lacks the id the relay records usage under, so REST reads the
// viewer once more when core allows.
async function restViewerLogin(): Promise<string> {
  if (cachedViewerLogin && cachedViewerId !== undefined) return cachedViewerLogin;
  const viewer = await restJson<{ login: string; id?: number }>("/user");
  cachedViewerLogin = viewer.login;
  cachedViewerId = typeof viewer.id === "number" && Number.isSafeInteger(viewer.id) ? viewer.id : null;
  return cachedViewerLogin;
}

export interface GithubViewer {
  id: number;
  login: string;
}

// The viewer as far as an earlier request already established it; never requests anything.
export function cachedViewer(): GithubViewer | null {
  return cachedViewerLogin !== null && typeof cachedViewerId === "number" ? { id: cachedViewerId, login: cachedViewerLogin } : null;
}

// The core pool's primary budget is spent, so the same read may go to GraphQL. A secondary
// cooldown is a request-rate signal GitHub applies across its APIs, so it moves nothing.
function coreQuotaExhausted(error: unknown): boolean {
  if (!(error instanceof GithubRequestError && error.kind === "quota" && error.resource === "core")) return false;
  return activeSecondaryCooldown() === null;
}

async function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
  source: GithubUsageSource,
  operation: string,
  // Opt-in for batched aliases: NOT_FOUND errors on accepted paths leave those fields null instead of rejecting siblings.
  missingAllowed?: (path: readonly (string | number)[]) => boolean,
  repo?: string,
): Promise<T> {
  if (repo !== undefined && !/^\s*query\b/.test(query)) throw new Error("Only repository queries may use GitHub App authentication");
  return withRepositoryRead(repo, "graphql", (authentication) =>
    graphqlRequest<T>(query, variables, source, operation, authentication, missingAllowed));
}

async function graphqlRequest<T>(
  query: string,
  variables: Record<string, unknown>,
  source: GithubUsageSource,
  operation: string,
  authentication: Authentication,
  missingAllowed?: (path: readonly (string | number)[]) => boolean,
): Promise<T> {
  const credential = authentication.state;
  const instrumented = instrumentGithubGraphql(query);
  let res: Response;
  try {
    res = await githubApiResponse("POST", "/graphql", {
      body: { query: instrumented.document, variables },
      authentication,
    });
  } catch (error) {
    if (!(error instanceof GithubRequestError && error.kind === "quota")) {
      recordGithubGraphqlUsage({
        occurredAt: new Date().toISOString(),
        credential: credential.ledgerIdentity,
        credentialKind: credential.kind,
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
  const headerReset = rateLimitHeader(res, "x-ratelimit-reset");
  const record = (
    rateLimit: { cost: number; used: number; remaining: number; resetAt: string } | null,
    status: "ok" | "error",
  ) => {
    const used = rateLimit?.used ?? rateLimitHeader(res, "x-ratelimit-used");
    const remaining = rateLimit?.remaining ?? rateLimitHeader(res, "x-ratelimit-remaining");
    const resetAt = rateLimit?.resetAt ?? (headerReset === null ? null : new Date(headerReset * 1_000).toISOString());
    updateCachedGraphqlQuota(
      rateLimitHeader(res, "x-ratelimit-limit"),
      used,
      remaining,
      resetAt,
      credential,
    );
    recordGithubGraphqlUsage({
      occurredAt: new Date().toISOString(),
      credential: credential.ledgerIdentity,
      credentialKind: credential.kind,
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
  } | null;
  if (!body || typeof body !== "object" || Array.isArray(body)
    || (body.data != null && (typeof body.data !== "object" || Array.isArray(body.data)))
    || (body.errors !== undefined && (!Array.isArray(body.errors)
      || body.errors.some((error) => !error || typeof error !== "object" || Array.isArray(error))))) {
    record(null, "error");
    throw new GithubRequestError("GraphQL response missing data", 502, [], "graphql", "graphql");
  }
  const rateLimit = body.data?.[RATE_LIMIT_ALIAS] as {
    cost: number;
    used: number;
    remaining: number;
    resetAt: string;
  } | undefined;
  if (rateLimit) updatePrimaryQuota("graphql", rateLimit.remaining, rateLimit.resetAt, 403, credential);
  if (body.data) delete body.data[RATE_LIMIT_ALIAS];
  const missingFields = !!missingAllowed && !!body.data && !!body.errors?.length
    && body.errors.every((error) => error.type === "NOT_FOUND" && !!error.path && missingAllowed(error.path));
  const partial = credential.kind === "user" && missingFields;
  record(rateLimit ?? null, body.errors?.length && !partial ? "error" : "ok");
  if (body.errors?.length && !partial) {
    const missing = body.errors.every((error) => error.type === "NOT_FOUND");
    const exhausted = body.errors.some((error) => error.type === "RATE_LIMIT" || error.type === "RATE_LIMITED");
    const resetAt = rateLimit?.resetAt
      ?? (headerReset === null ? credential.cachedQuota?.graphql.resetAt ?? null : new Date(headerReset * 1_000).toISOString());
    const secondary = body.errors.some((error) => /secondary rate limit|abuse detection/i.test(error.message ?? ""));
    if (secondary) {
      const until = Date.now() + SECONDARY_RATE_LIMIT_FALLBACK_MS;
      updateSecondaryQuota("graphql", { status: 403, until, resetAt: new Date(until).toISOString() });
    } else if (exhausted) updatePrimaryQuota("graphql", 0, resetAt, 403, credential);
    const error = new GithubRequestError(
      `GraphQL errors: ${JSON.stringify(body.errors)}`,
      missing ? 404 : exhausted || secondary ? 403 : 502,
      body.errors,
      exhausted || secondary ? "quota" : "graphql",
      "graphql",
      secondary ? activeSecondaryCooldown()!.resetAt : exhausted ? resetAt : null,
    );
    error.credential = credential.ledgerIdentity;
    error.appReadSucceeded = credential.kind === "app" && missingFields
      && body.data?.repository !== null && typeof body.data?.repository === "object" && !Array.isArray(body.data?.repository);
    throw error;
  }
  if (!body.data) throw new GithubRequestError("GraphQL response missing data", 502, [], "graphql", "graphql");
  if (credential.kind === "app" && body.data.repository === null) {
    const error = new GithubRequestError("Repository unavailable to GitHub App", 404, [], "graphql", "graphql");
    error.credential = credential.ledgerIdentity;
    throw error;
  }
  return body.data;
}

const GRAPHQL_WINDOW_MS = 60 * 60_000;

// Background work may spend a pool only while it stays ahead of an even pace to the reset,
// so the screen keeps a share of what is left, and never below the reserve, in either pool.
export function backgroundQuotaAvailable(quota: GithubQuotaResource, now = Date.now()): boolean {
  if (quota.blockedUntil && Date.parse(quota.blockedUntil) > now) return false;
  if (quota.remaining >= quota.limit) return true;
  const resetIn = Math.max(0, Date.parse(quota.resetAt) - now);
  const pacedReserve = Math.ceil(quota.limit * Math.min(resetIn, GRAPHQL_WINDOW_MS) / GRAPHQL_WINDOW_MS);
  return quota.remaining > Math.max(GRAPHQL_BACKGROUND_RESERVE, pacedReserve);
}

function personalBackgroundAvailable(resource: GithubQuotaResourceName): boolean | null {
  const reading = resource === "graphql"
    ? liveGraphqlReading(Date.now()) ?? userQuota.cachedQuota?.graphql
    : liveRestReading(resource, Date.now()) ?? userQuota.cachedQuota?.[resource === "core" ? "rest" : "search"];
  if (!reading || Date.parse(reading.resetAt) <= Date.now()) return null;
  return !activeQuotaBlock(resource) && backgroundQuotaAvailable(reading);
}

function assertPersonalGraphqlReserve(source: GithubUsageSource): void {
  if (!BACKGROUND_SOURCES.has(source) || personalBackgroundAvailable("graphql") !== false) return;
  const reading = liveGraphqlReading(Date.now()) ?? userQuota.cachedQuota?.graphql;
  const error = new GithubRequestError(
    "Personal GitHub GraphQL quota reserved for interactive actions", 403, [], "quota", "graphql", reading?.resetAt ?? null,
  );
  error.credential = "user";
  throw error;
}

// Reads made on Cockpit's own schedule rather than for someone looking at the screen.
const BACKGROUND_SOURCES: ReadonlySet<GithubUsageSource> = new Set([
  "background poll",
  "daemon",
  "index sync",
  "relay",
  "review inbox",
  "webhook",
]);

// With the REST fallback on, a read takes GitHub's separate REST pool while GraphQL is
// exhausted, and a background read also while GraphQL is below its background reserve.
async function graphqlReadOnRest(source: GithubUsageSource, repo?: string): Promise<boolean> {
  if (mockGithub || !restFallbackEnabled()) return false;
  assertQuotaAvailable("graphql", false);
  const app = repo === undefined ? null : await appAuthentication(repo);
  const credential = app && !activeQuotaBlock("graphql", app.state) ? app.state : (await userAuthentication()).state;
  if (activeQuotaBlock("graphql", credential)) return true;
  if (!BACKGROUND_SOURCES.has(source)) return false;
  const reading = liveGraphqlReading(Date.now(), credential);
  if (reading === null || backgroundQuotaAvailable(reading)) return false;
  return !(credential.kind === "app" && personalBackgroundAvailable("graphql") === true);
}

export function isBackgroundSource(source: GithubUsageSource | "unknown"): boolean {
  return source !== "unknown" && BACKGROUND_SOURCES.has(source);
}

async function readWithRestFallback<T>(
  source: GithubUsageSource,
  graphqlRead: () => Promise<T>,
  restRead: () => Promise<T>,
  repo?: string,
): Promise<T> {
  // REST reads, including metadata a GraphQL read takes over REST, are attributed to the same source.
  return withGithubUsageSource(source, async () => {
    if (await graphqlReadOnRest(source, repo)) return restRead();
    try {
      return await graphqlRead();
    } catch (error) {
      const graphqlExhausted = error instanceof GithubRequestError && error.kind === "quota" && error.resource === "graphql";
      if (!graphqlExhausted || activeSecondaryCooldown() || mockGithub || !restFallbackEnabled()) throw error;
      return restRead();
    }
  });
}

// Fan-out per PR for REST reads; most answers are 304s from the ETag cache and cost nothing.
const REST_FANOUT = 8;

// Pages a REST list through the ETag cache, so an unchanged page costs no quota.
async function restList<T>(
  path: string,
  maxPages = 10,
  pick: (body: unknown) => T[] = (body) => body as T[],
  repo?: string,
): Promise<T[]> {
  const items: T[] = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= maxPages; page++) {
    const batch = pick(await restJson<unknown>(`${path}${separator}per_page=100&page=${page}`, repo));
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

function restBranchPath(branch: string): string {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function restPullState(pull: { state: "open" | "closed"; merged_at: string | null }): PrState {
  return pull.merged_at ? "MERGED" : pull.state.toUpperCase() as PrState;
}

type RestChecks = { checkRuns: RestCheckRun[]; statuses: RestCommitStatus[]; workflowRuns: WorkflowRun[] };

async function fetchRestChecks(repo: string, sha: string): Promise<RestChecks> {
  const commit = encodeURIComponent(sha);
  const [checkRuns, statuses, workflowRuns] = await Promise.all([
    restList<RestCheckRun>(`/repos/${repo}/commits/${commit}/check-runs`, 10, (body) => (body as { check_runs?: RestCheckRun[] }).check_runs ?? [], repo),
    restJson<{ statuses?: RestCommitStatus[] }>(`/repos/${repo}/commits/${commit}/status?per_page=100`, repo).then((body) => body.statuses ?? []),
    fetchWorkflowRuns(repo, sha),
  ]);
  return { checkRuns, statuses, workflowRuns };
}

function restChecksRollup(checks: RestChecks, required: ReadonlySet<string> = new Set()): { contexts: PrCheck[]; rollup: string | null } {
  const contexts = restCheckContexts(checks.checkRuns, checks.statuses, checks.workflowRuns, required);
  return { contexts, rollup: restRollupState(contexts) };
}

// Required checks and approvals come from classic protection, which REST shows to readers on
// the branch, and from rulesets. Either may be hidden; that only loses the required markers.
async function fetchRestBranchRules(repo: string, branch: string): Promise<{ contexts: Set<string>; approvals: number }> {
  const path = restBranchPath(branch);
  const [protectedBranch, rules] = await Promise.all([
    restJson<{ protection?: { required_status_checks?: { contexts?: string[]; checks?: Array<{ context: string }> } } }>(
      `/repos/${repo}/branches/${path}`,
      repo,
    ).catch(() => null),
    restJson<Array<{ type: string; parameters?: { required_status_checks?: Array<{ context: string }>; required_approving_review_count?: number } }>>(
      `/repos/${repo}/rules/branches/${path}`,
      repo,
    ).catch(() => []),
  ]);
  const required = protectedBranch?.protection?.required_status_checks;
  const contexts = new Set([...required?.contexts ?? [], ...(required?.checks ?? []).map((check) => check.context)]);
  let approvals = 0;
  for (const rule of rules) {
    if (rule.type === "required_status_checks") for (const check of rule.parameters?.required_status_checks ?? []) contexts.add(check.context);
    if (rule.type === "pull_request") approvals = Math.max(approvals, rule.parameters?.required_approving_review_count ?? 0);
  }
  return { contexts, approvals };
}

// The open PR as the poll and review inbox see it: REST search has neither the head nor CI.
async function fetchRestPullWithRollup(repo: string, number: number): Promise<{ pull: RestPullRequest; rollup: string | null }> {
  const pull = await restJson<RestPullRequest>(`/repos/${repo}/pulls/${number}`, repo);
  return { pull, rollup: restChecksRollup(await fetchRestChecks(repo, pull.head.sha)).rollup };
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
    pullRequests = await readWithRestFallback(
      "user action",
      () => fetchMergedPrsGraphql(owner, name, repo, base, cutoff),
      () => fetchMergedPrsRest(repo, base, cutoff),
      repo,
    );
  }

  pullRequests.sort((left, right) => right.mergedAt.localeCompare(left.mergedAt));
  return { repo, base, asOf, pullRequests };
}

async function fetchMergedPrsRest(repo: string, base: string, cutoff: number): Promise<MergedPrAnalyticsPullRequest[]> {
  const pullRequests: MergedPrAnalyticsPullRequest[] = [];
  for (let page = 1; page <= 50; page++) {
    const batch = await restJson<RestPullRequest[]>(
      `/repos/${repo}/pulls?state=closed&base=${encodeURIComponent(base)}&sort=updated&direction=desc&per_page=100&page=${page}`,
      repo,
    );
    for (const pull of batch) {
      if (!pull.merged_at || Date.parse(pull.merged_at) < cutoff) continue;
      pullRequests.push({
        number: pull.number,
        title: pull.title,
        url: pull.html_url,
        author: restAuthor(pull.user)?.login ?? "unknown",
        mergedAt: pull.merged_at,
      });
    }
    if (batch.length < 100 || batch.every((pull) => Date.parse(pull.updated_at) < cutoff)) break;
  }
  return pullRequests;
}

async function fetchMergedPrsGraphql(
  owner: string,
  name: string,
  repo: string,
  base: string,
  cutoff: number,
): Promise<MergedPrAnalyticsPullRequest[]> {
  const pullRequests: MergedPrAnalyticsPullRequest[] = [];
  let cursor: string | null = null;
  while (true) {
    const data: {
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
    } = await graphql(MERGED_PRS_QUERY, { owner, name, base, cursor }, "user action", "merged-pr-analytics", undefined, repo);
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
  return pullRequests;
}

export interface GithubQuotaResource {
  limit: number;
  used: number;
  remaining: number;
  resetAt: string;
  // An active exhaustion block or secondary cooldown: the pool refuses requests until then
  // whatever its remaining count says.
  blockedUntil?: string | null;
}

export interface GithubQuota {
  rest: GithubQuotaResource;
  graphql: GithubQuotaResource;
  search: GithubQuotaResource;
  fetchedAt: string;
  // Top-level pools always belong to the personal credential, never a combined budget.
  identity?: string;
  identities?: GithubCredentialQuota[];
}

export interface GithubCredentialQuota {
  identity: string;
  kind: "user" | "app";
  installationId?: number;
  repositories: string[];
  rest: GithubQuotaResource | null;
  graphql: GithubQuotaResource | null;
  search: GithubQuotaResource | null;
  fetchedAt: string | null;
}
const QUOTA_TTL_MS = 60_000;
// From GraphQL responses' rateLimit and X-RateLimit headers. /rate_limit's graphql entry counts a
// different window: it reported 18 points used while GraphQL itself reported 2,446 and went on to
// answer RATE_LIMIT, so pacing on it never moved background reads to REST before exhaustion.

function liveGraphqlReading(now = Date.now(), credential = userQuota): GithubQuotaResource | null {
  const { graphqlReading } = credential;
  return graphqlReading && Date.parse(graphqlReading.resetAt) > now ? graphqlReading : null;
}

function updateCachedGraphqlQuota(
  limit: number | null,
  used: number | null,
  remaining: number | null,
  resetAt: string | null,
  credential = userQuota,
): void {
  if (limit === null || used === null || remaining === null || resetAt === null) return;
  const previous = credential.graphqlReading;
  if (previous?.resetAt === resetAt && previous.used > used) return;
  credential.graphqlReading = { limit, used, remaining, resetAt };
  credential.observedAt = new Date().toISOString();
  if (!credential.cachedQuota) return;
  credential.cachedQuota = {
    ...credential.cachedQuota,
    graphql: credential.graphqlReading,
    fetchedAt: new Date().toISOString(),
  };
}

// From charged core and search responses' X-RateLimit headers, for the same reason as
// graphqlReading: see CORE_QUOTA_PROBE_PATH for how far /rate_limit's core entry drifted.
type RestQuotaResourceName = "core" | "search";

function liveRestReading(resource: RestQuotaResourceName, now = Date.now(), credential = userQuota): GithubQuotaResource | null {
  const reading = credential.restReadings.get(resource);
  return reading && Date.parse(reading.resetAt) > now ? reading : null;
}

function recordRestReading(resource: RestQuotaResourceName, response: Response, credential = userQuota): void {
  const limit = rateLimitHeader(response, "x-ratelimit-limit");
  const used = rateLimitHeader(response, "x-ratelimit-used");
  const remaining = rateLimitHeader(response, "x-ratelimit-remaining");
  const reset = rateLimitHeader(response, "x-ratelimit-reset");
  if (limit === null || used === null || remaining === null || reset === null) return;
  const resetAt = new Date(reset * 1_000).toISOString();
  // Concurrent responses settle out of order; an earlier one must not undo a later spend.
  const previous = credential.restReadings.get(resource);
  if (previous?.resetAt === resetAt && previous.used > used) return;
  const reading = { limit, used, remaining, resetAt };
  credential.restReadings.set(resource, reading);
  credential.observedAt = new Date().toISOString();
  if (credential.cachedQuota) credential.cachedQuota = { ...credential.cachedQuota, [resource === "core" ? "rest" : "search"]: reading };
}

// Every pool as it stands now: search's window is a minute, so a reading past its reset has
// refilled, and an active block or cooldown refuses requests whatever the count says.
function currentQuota(quota: GithubQuota, now = Date.now(), credential = userQuota): GithubQuota {
  const search = liveRestReading("search", now, credential)
    ?? (Date.parse(quota.search.resetAt) > now ? quota.search : { ...quota.search, used: 0, remaining: quota.search.limit });
  const pool = (resource: GithubQuotaResourceName, reading: GithubQuotaResource): GithubQuotaResource => ({
    ...reading,
    blockedUntil: activeQuotaBlock(resource, credential)?.resetAt ?? null,
  });
  return { ...quota, identity: credential.ledgerIdentity, rest: pool("core", quota.rest), graphql: pool("graphql", quota.graphql), search: pool("search", search) };
}

function quotaWithIdentities(quota: GithubQuota, credential: CredentialState): GithubQuota {
  const apps = [...credentialStates.values()].filter((state) => state.kind === "app" && state.repositories.size > 0);
  if (apps.length === 0) return quota;
  const identities: GithubCredentialQuota[] = [{
    identity: credential.ledgerIdentity, kind: "user", repositories: [],
    rest: quota.rest, graphql: quota.graphql, search: quota.search, fetchedAt: quota.fetchedAt,
  }];
  for (const state of apps) {
    const pool = (resource: GithubQuotaResourceName, reading: GithubQuotaResource | null) => reading
      ? { ...reading, blockedUntil: activeQuotaBlock(resource, state)?.resetAt ?? null }
      : null;
    identities.push({
      identity: state.identity, kind: "app", installationId: state.installationId,
      repositories: [...state.repositories],
      rest: pool("core", liveRestReading("core", Date.now(), state)),
      graphql: pool("graphql", liveGraphqlReading(Date.now(), state)),
      search: pool("search", liveRestReading("search", Date.now(), state)),
      fetchedAt: state.observedAt,
    });
  }
  return { ...quota, identities };
}

export async function fetchGithubQuota(): Promise<GithubQuota> {
  if (mockGithub) {
    // Half a window left, so the fixture's spend is well ahead of pace and background work runs.
    const resetAt = new Date(Date.now() + 30 * 60_000).toISOString();
    return {
      rest: { limit: 5_000, used: 10, remaining: 4_990, resetAt },
      graphql: { limit: 5_000, used: 20, remaining: 4_980, resetAt },
      search: { limit: 30, used: 0, remaining: 30, resetAt: new Date(Date.now() + 60_000).toISOString() },
      fetchedAt: new Date().toISOString(),
    };
  }
  const authentication = await userAuthentication();
  const { state } = authentication;
  if (state.cachedQuota && Date.now() - Date.parse(state.cachedQuota.fetchedAt) < QUOTA_TTL_MS) {
    return quotaWithIdentities(currentQuota(state.cachedQuota, Date.now(), state), state);
  }
  if (!state.quotaFetchInFlight) {
    state.quotaFetchInFlight = fetchRateLimit(authentication).finally(() => { state.quotaFetchInFlight = null; });
  }
  return quotaWithIdentities(currentQuota(await state.quotaFetchInFlight, Date.now(), state), state);
}

// Null is unobserved; undefined means no installation pool is available for this work.
export async function repositoryReadQuota(
  repo: string,
  resource: "core" | "graphql",
  requireInstallation = false,
): Promise<GithubQuotaResource | null | undefined> {
  if (!mockGithub) {
    assertQuotaAvailable(resource, false);
    const app = await appAuthentication(repo);
    if (requireInstallation && !app) return undefined;
    if (app && !activeQuotaBlock(resource, app.state)) {
      const reading = resource === "core" ? liveRestReading("core", Date.now(), app.state) : liveGraphqlReading(Date.now(), app.state);
      if (reading === null || backgroundQuotaAvailable(reading)) return reading;
    }
    if (requireInstallation) return undefined;
  } else if (requireInstallation) {
    return undefined;
  }
  const quota = await backgroundGithubQuota();
  return resource === "core" ? quota.rest : quota.graphql;
}

export async function backgroundGithubQuota(): Promise<GithubQuota> {
  const recent = recentGithubQuota(5 * 60_000);
  if (recent) void fetchGithubQuota().catch(() => {});
  return recent ?? await fetchGithubQuota();
}

// The last quota reading if it is at most maxAgeMs old and its windows have not reset since,
// without a network call. Background pacing uses this so a relay-triggered refresh after a
// quiet minute does not first wait on /rate_limit.
export function recentGithubQuota(maxAgeMs: number, now = Date.now()): GithubQuota | null {
  const { cachedQuota } = userQuota;
  if (mockGithub || !cachedQuota) return null;
  if (now - Date.parse(cachedQuota.fetchedAt) > maxAgeMs) return null;
  if (Date.parse(cachedQuota.graphql.resetAt) <= now || Date.parse(cachedQuota.rest.resetAt) <= now) return null;
  return quotaWithIdentities(currentQuota(cachedQuota, now), userQuota);
}

async function fetchRateLimit(authentication: Authentication): Promise<GithubQuota> {
  const { state } = authentication;
  const res = await githubApiResponse("GET", "/rate_limit", { authentication });
  if (!res.ok) throw await githubResponseError("GitHub quota request failed", res);
  const body = (await res.json()) as {
    resources: Record<"core" | "graphql" | "search", { limit: number; used: number; remaining: number; reset: number }>;
  };
  const resource = (name: "core" | "graphql" | "search"): GithubQuotaResource => {
    const value = body.resources[name];
    return { limit: value.limit, used: value.used, remaining: value.remaining, resetAt: new Date(value.reset * 1_000).toISOString() };
  };
  const quota = {
    rest: liveRestReading("core", Date.now(), state) ?? resource("core"),
    graphql: liveGraphqlReading(Date.now(), state) ?? resource("graphql"),
    search: liveRestReading("search", Date.now(), state) ?? resource("search"),
    fetchedAt: new Date().toISOString(),
  };
  state.cachedQuota = quota;
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

// The poll compares ciState with the rollup state stored from the PR detail. GitHub computes
// that state differently when the rollup's contexts are not selected: with cancelled and
// queued runs it answers PENDING where the detail query sees FAILURE, and the mismatch
// refreshed such PRs on every poll. Selecting one context makes both agree at the same cost.
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
        commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 1) { totalCount } } } } }
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

async function searchOpenPrsGraphql(searchQuery: string): Promise<SearchHit[]> {
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
}

// Head and CI for a PR whose update time is unchanged, when something other than the poll keeps them current.
export type KnownSearchHit = (repo: string, number: number, updatedAt: string) => Pick<SearchHit, "headRefOid" | "ciState"> | null;

// REST search finds the PRs; each one's head and CI come from its own conditional reads, which
// cost quota whenever CI moved, so a PR the caller already knows skips them.
async function searchOpenPrsRest(searchQuery: string, known: KnownSearchHit): Promise<SearchHit[]> {
  const items = await searchPullRequests(searchQuery, 100, "background poll");
  if (items.length === 100) console.warn(`search hit the 100-result cap, PRs may be missing: ${searchQuery}`);
  const limit = createConcurrencyLimit(REST_FANOUT);
  return Promise.all(items.map((item) => limit(async () => {
    const repo = restSearchRepo(item);
    const cached = known(repo, item.number, item.updated_at);
    if (cached) return { repo, number: item.number, title: item.title, updatedAt: item.updated_at, ...cached };
    const { pull, rollup } = await fetchRestPullWithRollup(repo, item.number);
    return {
      repo,
      number: pull.number,
      title: pull.title,
      updatedAt: pull.updated_at,
      headRefOid: pull.head.sha,
      ciState: rollup ?? "NONE",
    };
  })));
}

async function searchOpenPrBatch(repos: string[], search: (searchQuery: string) => Promise<SearchHit[]>): Promise<SearchHit[]> {
  const repoFilter = repos.map((repo) => `repo:${repo}`).join(" ");
  const searchQuery = `is:open is:pr archived:false involves:@me ${repoFilter}`;
  try {
    const hits = await search(searchQuery);
    for (const repo of repos) clearRepositoryUnavailable(repo);
    return hits;
  } catch (error) {
    if (!repositorySearchUnavailable(error)) throw error;
    if (repos.length === 1) {
      const repo = repos.at(0);
      if (repo) reportRepositoryUnavailable(repo);
      return [];
    }
    const midpoint = Math.ceil(repos.length / 2);
    const searches = await Promise.allSettled([
      searchOpenPrBatch(repos.slice(0, midpoint), search),
      searchOpenPrBatch(repos.slice(midpoint), search),
    ]);
    const hits: SearchHit[] = [];
    for (const search of searches) {
      if (search.status === "rejected") throw search.reason;
      hits.push(...search.value);
    }
    return hits;
  }
}

export async function searchOpenPrs(repos: string[], known: KnownSearchHit = () => null): Promise<SearchHit[]> {
  if (mockGithub) return mockGithub.searchOpenPrs(repos);
  const available = repos.filter(repositoryAvailable);
  if (available.length === 0) return [];
  return readWithRestFallback(
    "background poll",
    () => searchOpenPrBatch(available, searchOpenPrsGraphql),
    () => searchOpenPrBatch(available, (searchQuery) => searchOpenPrsRest(searchQuery, known)),
  );
}

export interface RepositoryOpenPr {
  repo: string;
  number: number;
  title: string;
  author: string;
  state: "OPEN";
  isDraft: boolean;
  updatedAt: string;
  createdAt: string | null;
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
      nodes { number title author { login } isDraft createdAt updatedAt }
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
        state: "OPEN", isDraft: entry.isDraft, createdAt: entry.createdAt ?? null, updatedAt: entry.updatedAt,
      }));
  }
  return readWithRestFallback(
    "user action",
    () => fetchRepositoryOpenPrsGraphql(repo, owner, name),
    () => fetchRepositoryOpenPrsRest(repo),
    repo,
  );
}

async function fetchRepositoryOpenPrsRest(repo: string): Promise<RepositoryOpenPr[]> {
  const prs = new Map<number, RepositoryOpenPr>();
  for (const pull of await restList<RestPullRequest>(`/repos/${repo}/pulls?state=open&sort=updated&direction=desc`, 100, undefined, repo)) {
    const previous = prs.get(pull.number);
    if (previous && previous.updatedAt >= pull.updated_at) continue;
    prs.set(pull.number, {
      repo, number: pull.number, title: pull.title, author: restAuthor(pull.user)?.login ?? "unknown",
      state: "OPEN", isDraft: pull.draft, createdAt: pull.created_at, updatedAt: pull.updated_at,
    });
  }
  return [...prs.values()];
}

async function fetchRepositoryOpenPrsGraphql(repo: string, owner: string, name: string): Promise<RepositoryOpenPr[]> {
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
            createdAt: string;
            updatedAt: string;
          }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null;
    } = await graphql(REPOSITORY_OPEN_PRS_QUERY, { owner, name, cursor }, "user action", "all PRs", undefined, repo);
    if (!data.repository) throw new GithubRequestError(`Repository not found: ${repo}`, 404);
    const { nodes, pageInfo } = data.repository.pullRequests;
    for (const entry of nodes) {
      const previous = prs.get(entry.number);
      if (!previous || entry.updatedAt > previous.updatedAt) {
        prs.set(entry.number, {
          repo, number: entry.number, title: entry.title, author: entry.author?.login ?? "unknown",
          state: "OPEN", isDraft: entry.isDraft, createdAt: entry.createdAt, updatedAt: entry.updatedAt,
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
  const items = await searchPullRequests(searchQuery, 15, "search");
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
  createdAt: string;
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
  created_at: string;
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

// GitHub's REST search window is 30 requests a minute per user and shared with every other
// tool on the token; background searches leave this many for someone searching on screen.
const SEARCH_BACKGROUND_RESERVE = 10;
// One background search at a time, so each one is admitted on the reading the previous one left;
// a parallel index sweep otherwise spends the whole window before the first answer arrives.
const backgroundSearchLimit = createConcurrencyLimit(1);

function searchPoolAvailable(source: GithubUsageSource): boolean {
  if (activeQuotaBlock("search")) return false;
  if (!BACKGROUND_SOURCES.has(source)) return true;
  const reading = liveRestReading("search");
  return reading === null || reading.remaining > SEARCH_BACKGROUND_RESERVE;
}

function graphqlPoolAvailable(source: GithubUsageSource): boolean {
  if (activeQuotaBlock("graphql")) return false;
  if (!BACKGROUND_SOURCES.has(source)) return true;
  const reading = liveGraphqlReading();
  return reading === null || backgroundQuotaAvailable(reading);
}

const PR_SEARCH_QUERY = `
query($searchQuery: String!, $first: Int!) {
  search(query: $searchQuery, type: ISSUE, first: $first) {
    nodes {
      ... on PullRequest {
        number title state isDraft createdAt updatedAt closedAt mergedAt
        author { login }
        repository { nameWithOwner }
      }
    }
  }
}`;

type GraphqlPrSearchNode = {
  number?: number;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  author: { login: string } | null;
  repository: { nameWithOwner: string };
};

// The same search over the GraphQL pool, shaped like REST search items for the shared callers.
async function graphqlSearchPrs(query: string, perPage: number, source: GithubUsageSource): Promise<RestPrSearchItem[]> {
  const data = await graphql<{ search: { nodes: GraphqlPrSearchNode[] } }>(
    PR_SEARCH_QUERY,
    { searchQuery: query, first: perPage },
    source,
    "PR search",
  );
  return data.search.nodes.flatMap((node) => node.number === undefined ? [] : [{
    number: node.number,
    title: node.title,
    state: node.state === "OPEN" ? "open" as const : "closed" as const,
    draft: node.isDraft,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
    closed_at: node.closedAt,
    user: node.author,
    repository_url: `https://api.github.com/repos/${node.repository.nameWithOwner}`,
    pull_request: { merged_at: node.mergedAt },
  }]);
}

// REST search while its window has room for this caller, otherwise the GraphQL pool, otherwise
// a quota error naming search so background work waits for the minute to turn over.
async function searchOnAvailablePool(query: string, perPage: number, source: GithubUsageSource): Promise<RestPrSearchItem[]> {
  await userAuthentication();
  if (!searchPoolAvailable(source)) {
    if (graphqlPoolAvailable(source)) return graphqlSearchPrs(query, perPage, source);
    assertQuotaAvailable("search");
    const resetAt = liveRestReading("search")?.resetAt ?? null;
    throw new GithubRequestError(`GitHub search quota is held for interactive searches until ${resetAt}`, 429, [], "quota", "search", resetAt);
  }
  try {
    return await withGithubUsageSource(source, () => restSearchPrs(query, perPage));
  } catch (error) {
    const searchExhausted = error instanceof GithubRequestError && error.kind === "quota" && error.resource === "search";
    if (!searchExhausted || !graphqlPoolAvailable(source)) throw error;
    return graphqlSearchPrs(query, perPage, source);
  }
}

function searchPullRequests(query: string, perPage: number, source: GithubUsageSource): Promise<RestPrSearchItem[]> {
  if (!BACKGROUND_SOURCES.has(source)) return searchOnAvailablePool(query, perPage, source);
  return backgroundSearchLimit(() => searchOnAvailablePool(query, perPage, source));
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
  return readWithRestFallback(
    "search",
    () => lookupPrIndexesGraphql(repo, owner, name, unique),
    () => lookupPrIndexesRest(repo, unique),
    repo,
  );
}

async function lookupPrIndexesRest(repo: string, numbers: number[]): Promise<PrIndexEntry[]> {
  const limit = createConcurrencyLimit(REST_FANOUT);
  const pulls = await Promise.all(numbers.map((number) => limit(async () => {
    try {
      return await restJson<RestPullRequest>(`/repos/${repo}/pulls/${number}`, repo);
    } catch (error) {
      if (error instanceof GithubRequestError && error.status === 404) return null;
      throw error;
    }
  })));
  return pulls.flatMap((pull) => pull ? [{
    repo,
    number: pull.number,
    title: pull.title,
    state: restPullState(pull),
    isDraft: pull.draft,
    author: restAuthor(pull.user)?.login ?? "unknown",
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
  }] : []);
}

async function lookupPrIndexesGraphql(repo: string, owner: string, name: string, unique: number[]): Promise<PrIndexEntry[]> {
  const selections = unique
    .map((number, index) => `pr${index}: pullRequest(number: ${number}) {
      number title state isDraft createdAt updatedAt author { login }
    }`)
    .join("\n");
  const data = await graphql<{
    repository: (Record<string, RawPrIndexEntry | null>) | null;
  }>(`query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      ${selections}
    }
  }`, { owner, name }, "search", "PR lookup", (path) => (
    // Only a missing PR alias is partial; a missing repository still rejects the batch.
    path.length === 2 && path[0] === "repository" && typeof path[1] === "string" && /^pr\d+$/.test(path[1])
  ), repo);
  const repository = data.repository;
  if (!repository) throw new GithubRequestError(`Repository not found: ${repo}`, 404, [], "graphql", "graphql");

  return unique.flatMap((number, index) => {
    const entry = repository[`pr${index}`];
    return entry ? [{
      repo,
      number,
      title: entry.title,
      state: entry.state,
      isDraft: entry.isDraft,
      author: entry.author?.login ?? "unknown",
      createdAt: entry.createdAt,
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
  // GitHub's creation time; absent from producers that never read it, so the index keeps what it has.
  createdAt?: string | null;
  mergedAt?: string | null;
  closedAt?: string | null;
  involvesMe?: boolean;
}


export async function searchRecentPrs(repo: string): Promise<PrIndexEntry[]> {
  if (mockGithub) return mockGithub.searchRecentPrs(repo);
  if (!repositoryAvailable(repo)) return [];
  const searchQuery = `repo:${repo} is:pr sort:updated-desc`;
  try {
    const items = await searchPullRequests(searchQuery, 100, "index sync");
    clearRepositoryUnavailable(repo);
    return items.map((item) => ({
      repo: restSearchRepo(item),
      number: item.number,
      title: item.title,
      state: restSearchState(item),
      isDraft: item.draft,
      author: item.user?.login ?? "unknown",
      createdAt: item.created_at,
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
      const repoItems = await searchPullRequests(searchQuery, CLOSED_SEARCH_PAGE, "index sync");
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
        createdAt: item.created_at,
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

function reviewSearchSince(): string {
  return new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
}

export async function fetchReviewItems(): Promise<ReviewsPollResult> {
  if (mockGithub) return { items: [], cost: 0, remaining: 5_000 };
  return readWithRestFallback("review inbox", fetchReviewItemsGraphql, fetchReviewItemsRest);
}

// REST has no review decision outside the PR detail, so these items read as not yet approved.
async function fetchReviewItemsRest(): Promise<ReviewsPollResult> {
  const buckets: Array<[ReviewItem["bucket"], string]> = [
    ["review-requested", "is:pr is:open review-requested:@me archived:false"],
    ["assigned", "is:pr is:open assignee:@me archived:false"],
    ["mentioned", `is:pr is:open mentions:@me archived:false updated:>=${reviewSearchSince()}`],
  ];
  const results = await Promise.all(buckets.map(([, query]) => searchPullRequests(query, 50, "review inbox")));
  const found = new Map<string, { repo: string; number: number; bucket: ReviewItem["bucket"] }>();
  buckets.forEach(([bucket], index) => {
    for (const item of results[index] ?? []) {
      const repo = restSearchRepo(item);
      const key = `${repo}#${item.number}`;
      const previous = found.get(key);
      if (!previous || BUCKET_RANK[bucket] < BUCKET_RANK[previous.bucket]) found.set(key, { repo, number: item.number, bucket });
    }
  });
  const limit = createConcurrencyLimit(REST_FANOUT);
  const items = await Promise.all([...found.values()].map(({ repo, number, bucket }) => limit(async (): Promise<ReviewItem> => {
    const { pull, rollup } = await fetchRestPullWithRollup(repo, number);
    return {
      repo,
      number,
      url: pull.html_url,
      title: pull.title,
      branch: pull.head.ref,
      bucket,
      isDraft: pull.draft,
      state: reviewStateFor({ isDraft: pull.draft, reviewDecision: null, statusCheckRollup: rollup === null ? null : { state: rollup } }),
    };
  })));
  return { items, cost: null, remaining: null };
}

async function fetchReviewItemsGraphql(): Promise<ReviewsPollResult> {
  const since = reviewSearchSince();
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
    repo,
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

export type RepoLabel = { name: string; color: string };

const REPOSITORY_LABELS_QUERY = `
query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    labels(first: 100, after: $cursor) {
      nodes { name color }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

// The whole catalog, so the picker can offer a label past the first page. REST while core has
// room; GraphQL when core is exhausted, which would otherwise leave the picker empty.
export async function fetchRepoLabels(repo: string): Promise<RepoLabel[]> {
  if (mockGithub) return [];
  const [owner, name, extra] = repo.split("/");
  if (!owner || !name || extra !== undefined) throw new GithubRequestError(`Invalid repository: ${repo}`, 404);
  try {
    // The GraphQL half of this read is attributed to "user action"; the REST half matches it.
    return await withGithubUsageSource("user action", () => fetchRepoLabelsRest(repo));
  } catch (error) {
    if (!coreQuotaExhausted(error)) throw error;
  }
  return fetchRepoLabelsGraphql(repo, owner, name);
}

async function fetchRepoLabelsRest(repo: string): Promise<RepoLabel[]> {
  const labels = await fetchRestPages<RepoLabel>(
    `https://api.github.com/repos/${encodedRepo(repo)}/labels?per_page=100`,
    "GitHub labels request failed",
    repo,
  );
  return labels.map(({ name, color }) => ({ name, color }));
}

async function fetchRepoLabelsGraphql(repo: string, owner: string, name: string): Promise<RepoLabel[]> {
  const labels: RepoLabel[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  while (true) {
    const data: {
      repository: {
        labels: { nodes: RepoLabel[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } | null;
      } | null;
    } = await graphql(REPOSITORY_LABELS_QUERY, { owner, name, cursor }, "user action", "repository labels", undefined, repo);
    if (!data.repository) throw new GithubRequestError(`Repository not found: ${repo}`, 404);
    if (!data.repository.labels) throw new GithubRequestError("GraphQL response missing repository labels", 502);
    const { nodes, pageInfo } = data.repository.labels;
    labels.push(...nodes.map(({ name, color }) => ({ name, color })));
    if (!pageInfo.hasNextPage) return labels;
    if (!pageInfo.endCursor) throw new GithubRequestError("GraphQL response missing label cursor", 502);
    if (seenCursors.has(pageInfo.endCursor)) throw new GithubRequestError("GraphQL response repeated label cursor", 502);
    seenCursors.add(pageInfo.endCursor);
    cursor = pageInfo.endCursor;
  }
}

export async function addLabels(repo: string, number: number, labels: string[]): Promise<void> {
  if (mockGithub) return;
  await restRequest("POST", `/repos/${repo}/issues/${number}/labels`, { labels });
}

export async function removeLabels(repo: string, number: number, labels: string[]): Promise<void> {
  if (mockGithub) return;
  for (const label of labels) {
    await restRequest("DELETE", `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`, undefined);
  }
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
    title
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
          databaseId
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
          databaseId
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

// Keep the repository and personal documents structurally identical; only the viewer's
// fields move to the personal overlay. The PR id joins that overlay without another read.
const DETAIL_REPOSITORY_REVIEW_QUERY = DETAIL_REVIEW_QUERY
  .replace("viewerCanMergeAsAdmin", "id")
  .replaceAll("viewerHasReacted", "");

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
// databaseId is the number in GitHub's #pullrequestreview-<id> and #issuecomment-<id> permalinks; details
// cached before it was read lack it.
type ReviewNode = { id: string; databaseId?: number | null; author: Author | null; state: string; body: string; submittedAt: string };
type CommentNode = { id: string; databaseId?: number | null; author: Author | null; body: string; createdAt: string };
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
  // absent in snapshots cached before it was fetched; null until merged
  mergeCommit?: { oid: string } | null;
  // absent in snapshots cached before it was fetched; null until merged
  mergedBy?: { __typename?: string; login: string } | null;
  // Who last added the merge queue's `order` label; read only for bot merges while merge attribution is on.
  orderedBy?: { login: string } | null;
  // Latest cached `order` label addition, not a Kitchen stage transition.
  kitchenEnteredAt?: string | null;
  closedAt: string | null;
  isDraft: boolean;
  author: Author | null;
  baseRefName: string;
  baseRefOid: string;
  headRefName: string;
  // absent in snapshots cached before it was fetched; null when the head repository was deleted
  headRepository?: { nameWithOwner: string } | null;
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
                  title?: string | null;
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
  labels: { nodes: Array<{ name: string; color?: string }> };
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

export type RawPrDetail = PrDetailShape<{ reactionGroups: RawReactionGroup[] }>;

type RawPrDetailChecks = Pick<RawPrDetail, "lastCommit" | "commitList">;
type RawPrDetailReview = Pick<
  RawPrDetail,
  "author" | "reactionGroups" | "viewerCanMergeAsAdmin" | "reviewDecision" | "reviews" | "comments" | "reviewThreads"
>;
type RawPrDetailResidual = RawPrDetailChecks & RawPrDetailReview;
type PrDetailBase = Omit<RawPrDetail, keyof RawPrDetailResidual> & Pick<RawPrDetail, "author">;

type RestUser = { node_id: string; login: string; avatar_url: string; type?: string };
type RestPullRequest = {
  node_id: string;
  title: string;
  number: number;
  state: "open" | "closed";
  merged_at: string | null;
  merge_commit_sha?: string | null;
  closed_at: string | null;
  draft: boolean;
  user: RestUser | null;
  merged_by?: RestUser | null;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string; repo?: { full_name: string } | null };
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
  labels: Array<{ name: string; color?: string }>;
  assignees: Array<Pick<RestUser, "login">>;
  requested_reviewers: RestUser[];
  requested_teams: Array<{ name: string }>;
};

type RestPullRequestFile = { filename: string; additions: number; deletions: number };

export function mapRestPrDetailBase(pullRequest: RestPullRequest, files: RestPullRequestFile[]): PrDetailBase {
  return {
    id: pullRequest.node_id,
    title: pullRequest.title,
    number: pullRequest.number,
    state: pullRequest.merged_at ? "MERGED" : pullRequest.state.toUpperCase() as PrState,
    mergedAt: pullRequest.merged_at,
    // Before a merge, REST names the test-merge commit here; only a merged PR has a real one.
    mergeCommit: pullRequest.merged_at && pullRequest.merge_commit_sha ? { oid: pullRequest.merge_commit_sha } : null,
    mergedBy: pullRequest.merged_by ? { ...(pullRequest.merged_by.type ? { __typename: pullRequest.merged_by.type } : {}), login: pullRequest.merged_by.login } : null,
    closedAt: pullRequest.closed_at,
    isDraft: pullRequest.draft,
    author: pullRequest.user ? { ...(pullRequest.user.type ? { __typename: pullRequest.user.type } : {}), login: pullRequest.user.login, avatarUrl: pullRequest.user.avatar_url } : null,
    baseRefName: pullRequest.base.ref,
    baseRefOid: pullRequest.base.sha,
    headRefName: pullRequest.head.ref,
    headRepository: pullRequest.head.repo ? { nameWithOwner: pullRequest.head.repo.full_name } : null,
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
    labels: { nodes: pullRequest.labels.map(({ name, color }) => ({ name, color })) },
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

async function fetchRestPrDetailBase(repo: string, number: number): Promise<PrDetailBase> {
  const [pullRequest, files] = await Promise.all([
    restJson<RestPullRequest>(`/repos/${repo}/pulls/${number}`, repo),
    restJson<RestPullRequestFile[]>(`/repos/${repo}/pulls/${number}/files?per_page=100`, repo),
  ]);
  return mapRestPrDetailBase(pullRequest, files);
}

// The fields fetchRestPrDetailBase reads, for when core is exhausted; the viewer rides along
// because a fresh process cannot read it from REST /user either.
const DETAIL_METADATA_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      title
      number
      state
      mergedAt
      mergeCommit { oid }
      mergedBy { __typename login }
      closedAt
      isDraft
      author { __typename login avatarUrl }
      baseRefName
      baseRefOid
      headRefName
      headRepository { nameWithOwner }
      headRefOid
      body
      additions
      deletions
      changedFiles
      files(first: 100) {
        totalCount
        nodes { path additions deletions }
      }
      mergeable
      mergeStateStatus
      autoMergeRequest { mergeMethod enabledBy { login } }
      createdAt
      updatedAt
      url
      commitCount: commits { totalCount }
      labels(first: 100) { nodes { name color } }
      assignees(first: 100) { nodes { login } }
      reviewRequests(first: 100) {
        nodes {
          requestedReviewer {
            __typename
            ... on Actor { login avatarUrl }
            ... on Team { name }
          }
        }
      }
    }
  }
}`;

const DETAIL_REPOSITORY_METADATA_QUERY = DETAIL_METADATA_QUERY.replace("viewer { login }", "");

async function fetchRepositoryPrDetailMetadata(
  repo: string,
  owner: string,
  name: string,
  number: number,
  source: GithubUsageSource,
): Promise<PrDetailBase> {
  const data = await graphql<{
    repository: { pullRequest: PrDetailBase | null } | null;
  }>(DETAIL_REPOSITORY_METADATA_QUERY, { owner, name, number }, source, "PR metadata", undefined, repo);
  const base = data.repository?.pullRequest;
  if (!base) throw new GithubRequestError(`${repo}#${number} was not found`, 404);
  return withLabelHistory(base, repo, number, source);
}

type PrDetailMetadata = { base: PrDetailBase; viewerLogin: string };

async function fetchPrDetailMetadata(
  repo: string,
  owner: string,
  name: string,
  number: number,
  source: GithubUsageSource,
): Promise<PrDetailMetadata> {
  try {
    const [base, viewerLogin] = await Promise.all([fetchRestPrDetailBase(repo, number), restViewerLogin()]);
    return { base, viewerLogin };
  } catch (error) {
    if (!coreQuotaExhausted(error)) throw error;
  }
  const data = await graphql<{
    viewer: { login: string };
    repository: { pullRequest: PrDetailBase | null } | null;
  }>(DETAIL_METADATA_QUERY, { owner, name, number }, source, "PR metadata");
  const base = data.repository?.pullRequest;
  if (!base) throw new GithubRequestError(`${repo}#${number} was not found`, 404);
  cachedViewerLogin = data.viewer.login;
  return { base, viewerLogin: data.viewer.login };
}

// The label a person adds to hand a PR to the Kitchen merge queue, whose bot then merges it.
const ORDER_LABEL = "order";

const ORDER_LABEL_EVENTS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      timelineItems(itemTypes: [LABELED_EVENT], last: 100) {
        nodes { ... on LabeledEvent { createdAt actor { login } label { name } } }
      }
    }
  }
}`;

type OrderLabelEvent = { createdAt?: string; created_at?: string; actor?: { login: string } | null; label?: { name: string } | null };

// Share the ETag-cached label history between merge attribution and the opt-in order clock.
// The latest order starts the clock; stage changes, comments and pushes must not reset it.
async function withLabelHistory(base: PrDetailBase, repo: string, number: number, source: GithubUsageSource): Promise<PrDetailBase> {
  const attribution = base.mergedBy?.__typename === "Bot" && mergeAttributionWanted();
  const cooking = readSettings().cooking_section_enabled && base.state === "OPEN"
    && base.labels.nodes.some((label) => label.name.trim().toLowerCase() === ORDER_LABEL);
  if (!attribution && !cooking) return { ...base, kitchenEnteredAt: null };
  try {
    let events: OrderLabelEvent[];
    let completeHistory = true;
    try {
      const history = await restList<OrderLabelEvent & { event: string }>(`/repos/${repo}/issues/${number}/events`, 10, undefined, repo);
      // A capped REST history may hide a newer order. Never time an older visit in that case.
      completeHistory = history.length < 1000;
      events = history.filter((event) => event.event === "labeled");
    } catch (error) {
      if (!coreQuotaExhausted(error)) throw error;
      const [owner, name] = repo.split("/");
      const data = await graphql<{
        repository: { pullRequest: { timelineItems: { nodes: OrderLabelEvent[] } } | null } | null;
      }>(ORDER_LABEL_EVENTS_QUERY, { owner, name, number }, source, "PR order label", undefined, repo);
      events = data.repository?.pullRequest?.timelineItems.nodes ?? [];
    }
    const order = events.findLast((event) => event.label?.name.trim().toLowerCase() === ORDER_LABEL);
    const enteredAt = order?.created_at ?? order?.createdAt;
    return { ...base,
      ...(attribution ? { orderedBy: order?.actor?.login ? { login: order.actor.login } : null } : {}),
      kitchenEnteredAt: cooking && completeHistory && enteredAt && Number.isFinite(Date.parse(enteredAt)) ? enteredAt : null,
    };
  } catch (error) {
    if (attribution) throw error;
    console.warn(`Order time unavailable for ${repo}#${number}:`, error);
    return { ...base, kitchenEnteredAt: null };
  }
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

// The same pages as REVIEW_THREADS_PAGE_QUERY without their contents: ~0.5s where a full page
// on a PR with hundreds of threads takes ~2s, so the cursors are known before the pages land.
const REVIEW_THREAD_CURSORS_QUERY = `
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
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

const REPOSITORY_REVIEW_THREADS_PAGE_QUERY = REVIEW_THREADS_PAGE_QUERY.replaceAll("viewerHasReacted", "");
const REPOSITORY_THREAD_COMMENTS_PAGE_QUERY = THREAD_COMMENTS_PAGE_QUERY.replaceAll("viewerHasReacted", "");


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
    }>(CHECK_CONTEXTS_PAGE_QUERY, { owner, name, number, after }, source, "PR check pagination", undefined, `${owner}/${name}`);
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
  }>(COMMIT_LIST_LINE_COUNTS_QUERY, { owner, name, number }, source, "PR commit line counts", undefined, `${owner}/${name}`);
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
        undefined, `${owner}/${name}`,
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
  }>(DETAIL_CHECKS_QUERY, { owner, name, number }, source, "PR checks", undefined, `${owner}/${name}`);
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

const REVIEW_THREADS_PER_PAGE = 100;

async function fetchDetailReview(
  owner: string,
  name: string,
  number: number,
  source: GithubUsageSource,
  previousThreadCount: number,
  repositoryOnly = false,
): Promise<(RawPrDetailReview & { id?: string }) | null> {
  // A PR that already had a full first page of threads very likely has more, so its later
  // pages start beside the first instead of after it.
  const laterPages = previousThreadCount >= REVIEW_THREADS_PER_PAGE
    ? fetchReviewThreadPagesAfter(owner, name, number, null, source, repositoryOnly).catch(() => null)
    : null;
  const data = await graphql<{
    repository: { pullRequest: (RawPrDetailReview & { id?: string }) | null } | null;
  }>(
    repositoryOnly ? DETAIL_REPOSITORY_REVIEW_QUERY : DETAIL_REVIEW_QUERY,
    { owner, name, number }, source, "PR review detail", undefined,
    repositoryOnly ? `${owner}/${name}` : undefined,
  );
  const review = data.repository?.pullRequest;
  if (!review) return null;
  await completeReviewThreads(owner, name, number, review.reviewThreads, laterPages, source, repositoryOnly);
  return review;
}

type ReviewThreadPage = { after: string; connection: RawThreadConnection };

async function fetchReviewThreadPage(
  owner: string,
  name: string,
  number: number,
  after: string,
  source: GithubUsageSource,
  repositoryOnly: boolean,
): Promise<ReviewThreadPage> {
  const data = await graphql<{
    repository: { pullRequest: { reviewThreads: RawThreadConnection } | null } | null;
  }>(
    repositoryOnly ? REPOSITORY_REVIEW_THREADS_PAGE_QUERY : REVIEW_THREADS_PAGE_QUERY,
    { owner, name, number, after }, source, "PR review thread pagination", undefined,
    repositoryOnly ? `${owner}/${name}` : undefined,
  );
  const connection = data.repository?.pullRequest?.reviewThreads;
  if (!connection?.pageInfo) throw new GithubRequestError("Review thread pagination returned no page", 502);
  return { after, connection };
}

// Thread pages only page forward, and on a PR with hundreds of threads each takes ~2s, so
// following endCursor loads them one after another. A cursor-only walk (~0.5s a step) finds
// where each page starts and starts it at once. `start` is the first page's endCursor, or
// null to walk from the beginning beside the query that carries the first page.
async function fetchReviewThreadPagesAfter(
  owner: string,
  name: string,
  number: number,
  start: string | null,
  source: GithubUsageSource,
  repositoryOnly: boolean,
): Promise<ReviewThreadPage[]> {
  const pages: Promise<ReviewThreadPage>[] = [];
  const seen = new Set<string>();
  const startPage = (after: string) => {
    if (seen.has(after)) throw new GithubRequestError("Review thread pagination returned an invalid cursor", 502);
    seen.add(after);
    const page = fetchReviewThreadPage(owner, name, number, after, source, repositoryOnly);
    // Observed by Promise.all below; this keeps a failure during the walk from going unhandled.
    page.catch(() => {});
    pages.push(page);
  };
  if (start !== null) startPage(start);
  let cursor = start;
  for (;;) {
    const data = await graphql<{
      repository: { pullRequest: { reviewThreads: Pick<RawThreadConnection, "pageInfo"> } | null } | null;
    }>(REVIEW_THREAD_CURSORS_QUERY, { owner, name, number, after: cursor }, source, "PR review thread cursors", undefined, `${owner}/${name}`);
    const pageInfo = data.repository?.pullRequest?.reviewThreads.pageInfo;
    if (!pageInfo) throw new GithubRequestError("Review thread pagination returned no page", 502);
    if (!pageInfo.hasNextPage) break;
    if (!pageInfo.endCursor) throw new GithubRequestError("Review thread pagination returned an invalid cursor", 502);
    startPage(pageInfo.endCursor);
    cursor = pageInfo.endCursor;
  }
  return Promise.all(pages);
}

// Appends pages only when each starts exactly where the previous one ended and the last one
// ends the list; a walk that raced a new or deleted thread is dropped instead.
function appendReviewThreadPages(connection: RawThreadConnection, pages: ReviewThreadPage[]): boolean {
  let pageInfo = connection.pageInfo;
  for (const page of pages) {
    if (!pageInfo?.hasNextPage || pageInfo.endCursor !== page.after) return false;
    pageInfo = page.connection.pageInfo;
  }
  if (pageInfo?.hasNextPage) return false;
  for (const page of pages) connection.nodes.push(...page.connection.nodes);
  connection.pageInfo = pageInfo;
  return true;
}

async function completeReviewThreads(
  owner: string,
  name: string,
  number: number,
  connection: RawThreadConnection,
  laterPages: Promise<ReviewThreadPage[] | null> | null,
  source: GithubUsageSource,
  repositoryOnly: boolean,
): Promise<void> {
  if (connection.pageInfo?.hasNextPage) {
    const early = laterPages ? await laterPages : null;
    if (!early || !appendReviewThreadPages(connection, early)) {
      const after = connection.pageInfo.endCursor;
      if (!after) throw new GithubRequestError("Review thread pagination returned an invalid cursor", 502);
      appendReviewThreadPages(connection, await fetchReviewThreadPagesAfter(owner, name, number, after, source, repositoryOnly));
    }
  }
  // Only reached with pages left when the walk above raced a change to the thread list.
  const cursors = new Set<string>();
  while (connection.pageInfo?.hasNextPage) {
    const after = connection.pageInfo.endCursor;
    if (!after || cursors.has(after)) throw new GithubRequestError("Review thread pagination returned an invalid cursor", 502);
    cursors.add(after);
    const next = await fetchReviewThreadPage(owner, name, number, after, source, repositoryOnly);
    connection.nodes.push(...next.connection.nodes);
    connection.pageInfo = next.connection.pageInfo;
  }
  for (const thread of connection.nodes) {
    if (!thread.isResolved) await completeThreadComments(thread, source, repositoryOnly ? `${owner}/${name}` : undefined);
  }
}

async function completeThreadComments(thread: RawThread, source: GithubUsageSource, repo?: string): Promise<void> {
  const cursors = new Set<string>();
  while (thread.comments.pageInfo?.hasNextPage) {
    const after = thread.comments.pageInfo.endCursor;
    if (!after || cursors.has(after)) throw new GithubRequestError("Review comment pagination returned an invalid cursor", 502);
    cursors.add(after);
    const data = await graphql<{ node: { comments: RawThreadCommentConnection } | null }>(
      repo === undefined ? THREAD_COMMENTS_PAGE_QUERY : REPOSITORY_THREAD_COMMENTS_PAGE_QUERY,
      { threadId: thread.id, after },
      source,
      "PR review comment pagination",
      undefined,
      repo,
    );
    if (!data.node?.comments.pageInfo) throw new GithubRequestError("Review comment pagination returned no page", 502);
    thread.comments.nodes.push(...data.node.comments.nodes);
    thread.comments.pageInfo = data.node.comments.pageInfo;
  }
}

const DETAIL_VIEWER_QUERY = `
query($ids: [ID!]!) {
  viewer { login }
  nodes(ids: $ids) {
    id
    ... on Reactable { reactionGroups { content viewerHasReacted } }
    ... on PullRequest { viewerCanMergeAsAdmin }
  }
}`;
const DETAIL_VIEWER_BATCH = 100;

async function fetchRepositoryDetailReview(
  owner: string,
  name: string,
  number: number,
  source: GithubUsageSource,
  previousThreadCount: number,
): Promise<{ review: RawPrDetailReview; viewerLogin: string } | null> {
  const review = await fetchDetailReview(owner, name, number, source, previousThreadCount, true);
  if (!review) return null;
  if (!review.id) throw new GithubRequestError("PR review detail returned no id", 502);
  const targets = [
    { id: review.id, reactionGroups: review.reactionGroups },
    ...review.reviews.nodes,
    ...review.comments.nodes,
    ...review.reviewThreads.nodes.flatMap((thread) => thread.comments.nodes),
  ].filter((target) => target.id === review.id || target.reactionGroups.some((group) => group.reactors.totalCount > 0));
  let viewerLogin = "";
  for (let start = 0; start < targets.length; start += DETAIL_VIEWER_BATCH) {
    const batch = targets.slice(start, start + DETAIL_VIEWER_BATCH);
    // No repository routing here: an installation's viewer state is never the person's.
    const data = await graphql<{
      viewer: { login: string };
      nodes: Array<{
        id: string;
        reactionGroups: Array<Pick<RawReactionGroup, "content" | "viewerHasReacted">>;
        viewerCanMergeAsAdmin?: boolean;
      } | null>;
    }>(DETAIL_VIEWER_QUERY, { ids: batch.map((target) => target.id) }, source, "PR viewer state");
    if (!data.viewer?.login) throw new GithubRequestError("PR viewer state returned no viewer", 502);
    viewerLogin = data.viewer.login;
    const nodes = new Map(data.nodes.filter((node) => node !== null).map((node) => [node.id, node]));
    for (const target of batch) {
      const node = nodes.get(target.id);
      if (!node) throw new GithubRequestError("PR viewer state returned no node", 502);
      if (target.id === review.id) {
        if (typeof node.viewerCanMergeAsAdmin !== "boolean") {
          throw new GithubRequestError("PR viewer state returned no merge permission", 502);
        }
        review.viewerCanMergeAsAdmin = node.viewerCanMergeAsAdmin;
      }
      for (const group of target.reactionGroups) {
        if (group.reactors.totalCount === 0) continue;
        const personal = node.reactionGroups.find((item) => item.content === group.content);
        if (typeof personal?.viewerHasReacted !== "boolean") {
          throw new GithubRequestError("PR viewer state returned no reaction state", 502);
        }
        group.viewerHasReacted = personal.viewerHasReacted;
      }
    }
  }
  cachedViewerLogin = viewerLogin;
  return { review, viewerLogin };
}


function normalizeReviewDetail(
  review: RawPrDetailReview,
  viewerLogin: string,
  author: Author | null,
  reviewRequests: PrDetailBase["reviewRequests"],
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
  previous: Pick<PrDetail, "commitList" | "reviewThreads"> | null = null,
): Promise<PrDetail> {
  if (mockGithub) return mockGithub.detail(repo, number);
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new GithubRequestError(`Invalid repository: ${repo}`, 404);
  assertQuotaAvailable("graphql", false);
  const app = await appAuthentication(repo);
  return readWithRestFallback<PrDetail>(source, async () => {
    // The personal viewer overlay is required in either mode. Gate it before starting
    // concurrent repository reads, especially REST metadata in the no-app path.
    await requireQuota("graphql");
    if (app) {
      assertPersonalGraphqlReserve(source);
      const [checks, detailReview, base] = await Promise.all([
        fetchDetailChecks(owner, name, number, previous, source),
        fetchRepositoryDetailReview(owner, name, number, source, previous?.reviewThreads?.nodes.length ?? 0),
        fetchRepositoryPrDetailMetadata(repo, owner, name, number, source),
      ]);
      if (!checks || !detailReview) throw new GithubRequestError(`${repo}#${number} was not found`, 404);
      const { review, viewerLogin } = detailReview;
      return {
        ...base,
        ...checks,
        viewerLogin,
        ...normalizeReviewDetail(review, viewerLogin, review.author, base.reviewRequests),
      };
    }
    const [checks, review, { base, viewerLogin }] = await Promise.all([
      fetchDetailChecks(owner, name, number, previous, source),
      fetchDetailReview(owner, name, number, source, previous?.reviewThreads?.nodes.length ?? 0),
      fetchPrDetailMetadata(repo, owner, name, number, source)
        .then(async (metadata) => ({ ...metadata, base: await withLabelHistory(metadata.base, repo, number, source) })),
    ]);
    if (!checks || !review) throw new GithubRequestError(`${repo}#${number} was not found`, 404);
    return {
      ...base,
      ...checks,
      viewerLogin,
      ...normalizeReviewDetail(review, viewerLogin, review.author, base.reviewRequests),
    };
  }, () => fetchRestPrDetail(repo, number, previous, source), repo);
}

async function fetchViewerMergePermission(repo: string, number: number, source: GithubUsageSource): Promise<boolean> {
  try {
    const repository = await restJson<{ permissions?: { admin?: boolean } }>(`/repos/${repo}`);
    return repository.permissions?.admin === true;
  } catch (error) {
    if (!coreQuotaExhausted(error) || activeQuotaBlock("graphql", userQuota)) throw error;
  }
  const [owner, name] = repo.split("/");
  const data = await graphql<{
    repository: { pullRequest: { viewerCanMergeAsAdmin: boolean } | null } | null;
  }>(`query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) { viewerCanMergeAsAdmin }
    }
  }`, { owner, name, number }, source, "PR viewer merge permission");
  return data.repository?.pullRequest?.viewerCanMergeAsAdmin === true;
}

// The whole detail over REST. Every list goes through the ETag cache, so rereading an
// unchanged PR costs little, which is why a scoped refresh rereads all of it here.
async function fetchRestPrDetail(
  repo: string,
  number: number,
  previous: Pick<PrDetail, "commitList" | "reviewThreads"> | null,
  source: GithubUsageSource,
): Promise<PrDetail> {
  const base = fetchRestPrDetailBase(repo, number);
  const [rest, viewerLogin, issue, viewerCanMergeAsAdmin, commits, reviews, comments, reviewComments, checks, rules] = await Promise.all([
    base.then((pull) => withLabelHistory(pull, repo, number, source)),
    getViewerLogin(source),
    restJson<{ reactions?: RestReactions }>(`/repos/${repo}/issues/${number}`, repo),
    fetchViewerMergePermission(repo, number, source),
    restList<RestPrCommit>(`/repos/${repo}/pulls/${number}/commits`, 3, undefined, repo),
    restList<RestReview>(`/repos/${repo}/pulls/${number}/reviews`, 10, undefined, repo),
    restList<RestIssueComment>(`/repos/${repo}/issues/${number}/comments`, 10, undefined, repo),
    restList<RestReviewComment>(`/repos/${repo}/pulls/${number}/comments`, 10, undefined, repo),
    base.then((pull) => fetchRestChecks(repo, pull.headRefOid)),
    base.then((pull) => fetchRestBranchRules(repo, pull.baseRefName)),
  ]);
  const { contexts, rollup } = restChecksRollup(checks, rules.contexts);
  const review: RawPrDetailReview = {
    author: rest.author,
    reactionGroups: restReactionGroups(issue.reactions),
    viewerCanMergeAsAdmin,
    reviewDecision: restReviewDecision(reviews, rules.approvals),
    reviews: restReviews(reviews),
    comments: restIssueComments(comments),
    reviewThreads: restReviewThreads(reviewComments, reviews, previous),
  };
  return {
    ...rest,
    lastCommit: {
      nodes: [{
        commit: {
          statusCheckRollup: rollup === null
            ? null
            : { state: rollup, contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: contexts } },
        },
      }],
    },
    commitList: restCommitList(commits, rest.headRefOid, rollup, previous),
    viewerLogin,
    ...normalizeReviewDetail(review, viewerLogin, rest.author, rest.reviewRequests),
  };
}

// A check event over REST rereads only the head's checks. The pull request and repository objects
// embed repository timestamps that move with every push, so in a busy repository the full detail
// is never a 304; required markers carry over from the previous read, and a push refreshes all.
async function fetchRestPrChecks(repo: string, current: PrDetail): Promise<PrDetail> {
  const head = current.headRefOid;
  const required = new Set<string>();
  for (const check of current.lastCommit.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []) {
    if (!check.isRequired) continue;
    required.add(check.__typename === "CheckRun" ? check.name : check.context);
  }
  const { contexts, rollup } = restChecksRollup(await fetchRestChecks(repo, head), required);
  return {
    ...current,
    lastCommit: {
      nodes: [{
        commit: {
          statusCheckRollup: rollup === null
            ? null
            : { state: rollup, contexts: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: contexts } },
        },
      }],
    },
    commitList: {
      ...current.commitList,
      nodes: current.commitList.nodes.map((node) => node.commit.oid === head
        ? { ...node, commit: { ...node.commit, statusCheckRollup: rollup === null ? null : { state: rollup } } }
        : node),
    },
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
  // Mergeability comes only from the metadata read; a scoped refresh would keep UNKNOWN while
  // advancing fetched_at, postponing the retry for as long as check or review events continue.
  if (current.state === "OPEN" && !current.isDraft &&
    (current.mergeable === "UNKNOWN" || current.mergeStateStatus === "UNKNOWN")) {
    return fetchPrDetail(repo, number, source, current);
  }
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new GithubRequestError(`Invalid repository: ${repo}`, 404);
  assertQuotaAvailable("graphql", false);
  const repositoryReview = scope === "review" && await appAuthentication(repo) !== null;
  return readWithRestFallback<PrDetail>(
    source,
    () => fetchPrDetailPartGraphql(repo, owner, name, number, current, scope, source, repositoryReview),
    () => scope === "checks" ? fetchRestPrChecks(repo, current) : fetchRestPrDetail(repo, number, current, source),
    repo,
  );
}

async function fetchPrDetailPartGraphql(
  repo: string,
  owner: string,
  name: string,
  number: number,
  current: PrDetail,
  scope: Exclude<PrDetailScope, "all">,
  source: GithubUsageSource,
  repositoryReview: boolean,
): Promise<PrDetail> {
  if (scope === "checks") {
    const checks = await fetchDetailChecks(owner, name, number, current, source);
    if (!checks) throw new GithubRequestError(`${repo}#${number} was not found`, 404);
    return {
      ...current,
      ...checks,
    };
  }
  if (repositoryReview) {
    await requireQuota("graphql");
    assertPersonalGraphqlReserve(source);
    const detailReview = await fetchRepositoryDetailReview(owner, name, number, source, current.reviewThreads?.nodes.length ?? 0);
    if (!detailReview) throw new GithubRequestError(`${repo}#${number} was not found`, 404);
    const { review, viewerLogin } = detailReview;
    return {
      ...current,
      viewerLogin,
      ...normalizeReviewDetail(review, viewerLogin, review.author, current.reviewRequests),
    };
  }

  const [review, viewerLogin] = await Promise.all([
    fetchDetailReview(owner, name, number, source, current.reviewThreads?.nodes.length ?? 0),
    getViewerLogin(source),
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

async function fetchRestPages<T>(initialUrl: string, label = "GitHub comments request failed", repo?: string): Promise<T[]> {
  const pages: T[] = [];
  const seen = new Set<string>();
  const initial = new URL(initialUrl);
  let url: URL | null = initial;
  while (url !== null) {
    if (seen.has(url.href)) throw new GithubRequestError("GitHub REST pagination repeated a page", 502);
    seen.add(url.href);
    if (url.origin !== "https://api.github.com") throw new GithubRequestError("GitHub REST pagination left the API origin", 502);
    const path: string = `${url.pathname}${url.search}`;
    const readPage = async (response: Response): Promise<{ items: T[]; next: string | undefined }> => {
      if (!response.ok) throw await githubResponseError(label, response);
      const items = await response.json() as T[];
      const next = response.headers
        .get("link")
        ?.split(",")
        .find((part) => part.includes('rel="next"'))
        ?.match(/<([^>]+)>/)?.[1];
      return { items, next };
    };
    const { items, next }: { items: T[]; next: string | undefined } = repo === undefined
      ? await readPage(await githubApiResponse("GET", path))
      : await repositoryApiRead(repo, path, readPage);
    pages.push(...items);
    url = next === undefined ? null : new URL(next);
    if (url) url.pathname = initial.pathname;
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
    }>(`${baseUrl}/issues/${number}/comments?since=${encodedSince}&per_page=100`, undefined, repo),
    fetchRestPages<{
      user: { login: string } | null;
      body: string;
      created_at: string;
      html_url: string;
      path: string;
      line: number | null;
      original_line: number | null;
      pull_request_review_id: number | null;
    }>(`${baseUrl}/pulls/${number}/comments?since=${encodedSince}&per_page=100`, undefined, repo),
    fetchRestPages<{
      id: number;
      user: { login: string } | null;
      body: string;
      submitted_at: string | null;
      state: string;
      html_url: string;
    }>(`${baseUrl}/pulls/${number}/reviews?per_page=100`, undefined, repo),
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
  return repositoryApiRead(repo, path, async (res) => {
    if (!res.ok) throw await githubResponseError("diff fetch failed", res);
    return res.text();
  }, { accept: "application/vnd.github.v3.diff" });
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
      undefined, repo,
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
  const credential = responseCredentials.get(response);
  if (credential !== undefined) responseCredentials.set(responseCopy, credential);
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
  check_suite_id?: number;
  workflow_id?: number;
}
export async function fetchWorkflowRun(repo: string, runId: number): Promise<WorkflowRun> {
  if (mockGithub) return mockGithub.workflowRun(repo, runId);
  return githubRestJson<WorkflowRun>("GET", `/repos/${repo}/actions/runs/${runId}`, undefined, repo);
}

export interface RefActivity {
  after: string;
  activity_type: string;
}

export async function fetchRepositoryIdentity(repo: string): Promise<{ id: number; defaultBranch: string }> {
  if (mockGithub) throw new GithubRequestError(`${repo} has no repository identity in mock mode`, 404);
  const repository = await githubRestJson<{ id: number; default_branch: string }>("GET", `/repos/${encodedRepo(repo)}`, undefined, repo);
  return { id: repository.id, defaultBranch: repository.default_branch };
}

// The newest page only, newest first.
export async function fetchRefActivity(repo: string, ref: string): Promise<RefActivity[]> {
  return githubRestJson<RefActivity[]>("GET", `/repos/${encodedRepo(repo)}/activity?ref=${encodeURIComponent(ref)}&per_page=100`, undefined, repo);
}

export async function fetchCommitTree(repo: string, sha: string): Promise<string> {
  const commit = await githubRestJson<{ tree: { sha: string } }>("GET", `/repos/${encodedRepo(repo)}/git/commits/${sha}`, undefined, repo);
  return commit.tree.sha;
}


export async function fetchWorkflowRuns(repo: string, headSha: string): Promise<WorkflowRun[]> {
  if (mockGithub) return [];
  const runs: WorkflowRun[] = [];
  for (let page = 1;; page++) {
    const payload = await githubRestJson<{ workflow_runs?: WorkflowRun[] }>(
      "GET",
      `/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=100&page=${page}`,
      undefined, repo,
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
      undefined, repo,
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
      undefined, repo,
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
    const payload = await githubRestJson<{ jobs?: RunJob[] }>("GET", endpoint, undefined, repo);
    const batch = payload.jobs ?? [];
    jobs.push(...batch);
    if (batch.length < 100) return jobs;
  }
}

// The logs endpoint answers 302 with a Location that expires after a minute, and that storage host
// rejects a request carrying GitHub's Authorization header, so the download is a second bare fetch.
export async function fetchJobLog(repo: string, jobId: number): Promise<string> {
  if (mockGithub) return mockGithub.jobLog(repo, jobId);
  const location = await repositoryApiRead(repo, `/repos/${repo}/actions/jobs/${jobId}/logs`, async (res) => {
    const location = res.headers.get("location");
    if (!location) throw await githubResponseError("job log fetch failed", res);
    return location;
  }, { redirect: "manual" });
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
  const commits = await repositoryApiRead(repo, `/repos/${repo}/commits?${params}`, async (res) => {
    if (!res.ok) throw await githubResponseError("file history fetch failed", res);
    return await res.json() as Array<{
      sha: string;
      commit: { message: string; author: { name: string; date: string } | null };
      author: { login: string } | null;
    }>;
  });
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
  const body = await repositoryApiRead(repo, `/repos/${repo}/commits/${sha}`, async (res) => {
    if (!res.ok) throw await githubResponseError("commit fetch failed", res);
    return await res.json() as {
      files?: Array<{
        filename: string;
        previous_filename?: string;
        patch?: string;
        additions: number;
        deletions: number;
        status: string;
      }>;
    };
  });
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
  const body = await repositoryApiRead(repo, `/repos/${repo}/contents/${encodedPath}?ref=${sha}`, async (res) => {
    if (!res.ok) throw await githubResponseError("file fetch failed", res);
    return await res.json() as { content?: string; encoding?: string };
  });
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

type RestPullRepo = { full_name: string; permissions?: { push?: boolean } };

type RestPull = {
  state: string;
  maintainer_can_modify?: boolean;
  head: {
    sha: string;
    ref: string;
    repo: RestPullRepo | null;
  };
  base: { ref: string; repo: RestPullRepo };
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

// A 304 answer to a conditional request does not count against the REST rate limit.
const restEtags = new Map<string, { etag: string; text: string }>();
const REST_ETAG_TOTAL_LIMIT = 32 * 1024 * 1024;
const REST_ETAG_BODY_LIMIT = 4 * 1024 * 1024;
let restEtagBytes = 0;

function forgetRestEtag(path: string): void {
  const entry = restEtags.get(path);
  if (!entry) return;
  restEtags.delete(path);
  restEtagBytes -= entry.text.length;
}

async function githubRestJson<T>(method: string, path: string, body?: unknown, repo?: string): Promise<T> {
  if (repo !== undefined) assertRepositoryPath(repo, path);
  return withRepositoryRead(method === "GET" || method === "HEAD" ? repo : undefined, quotaResource(path), async (authentication) => {
    // Validators and bodies are credential-scoped, including the user fallback of an app read.
    const key = `${authentication.state.identity}:${path}`;
    const cached = method === "GET" ? restEtags.get(key) : undefined;
    const response = await githubApiResponse(method, path, { body, authentication, ifNoneMatch: cached?.etag });
    if (response.status === 304 && cached) {
      restEtags.delete(key);
      restEtags.set(key, cached);
      return JSON.parse(cached.text) as T;
    }
    if (!response.ok) throw await githubResponseError("GitHub REST request failed", response);
    const text = await response.text();
    const etag = method === "GET" ? response.headers.get("etag") : null;
    if (etag) {
      forgetRestEtag(key);
      if (text.length <= REST_ETAG_BODY_LIMIT) {
        restEtags.set(key, { etag, text });
        restEtagBytes += text.length;
        while (restEtagBytes > REST_ETAG_TOTAL_LIMIT) forgetRestEtag(restEtags.keys().next().value!);
      }
    }
    return JSON.parse(text) as T;
  });
}

function encodedRepo(repo: string): string {
  return repo.split("/").map(encodeURIComponent).join("/");
}

function isRefUpdateRace(error: unknown): boolean {
  return error instanceof GithubRequestError
    && /REST request failed: (?:409|422)\b/i.test(error.message)
    && /(?:fast.?forward|reference update|expected|stale)/i.test(error.message);
}

type PrFileWrite = {
  repo: string;
  number: number;
  path: string;
  // null commits on whatever the head is now.
  expectedHeadOid: string | null;
  message: string;
  // Receives the file at the head, or null where it does not exist; returning null skips the commit.
  edit: (current: string | null) => string | null;
};

async function writePrFile(input: PrFileWrite): Promise<string | null> {
  const [owner, name] = input.repo.split("/");
  if (!owner || !name) throw new GithubRequestError(`Invalid repository: ${input.repo}`, 404);
  const baseRepo = encodedRepo(input.repo);
  const pullRequest = await githubRestJson<RestPull>("GET", `/repos/${baseRepo}/pulls/${input.number}`);
  if (pullRequest.state !== "open") throw new StalePrHeadError("PR is no longer open");
  if (!pullRequest.head?.ref || !pullRequest.head.repo?.full_name) {
    throw new StalePrHeadError("PR head is unavailable");
  }
  const headOid = input.expectedHeadOid?.toLowerCase() ?? pullRequest.head.sha.toLowerCase();
  if (pullRequest.head.sha.toLowerCase() !== headOid) throw new StalePrHeadError();

  const headRepo = encodedRepo(pullRequest.head.repo.full_name);
  const commit = await githubRestJson<{ tree: { sha: string } }>(
    "GET",
    `/repos/${headRepo}/git/commits/${headOid}`,
  );
  const segments = input.path.split("/");
  let blobSha: string | null = commit.tree.sha;
  for (let index = 0; index < segments.length && blobSha !== null; index += 1) {
    const tree: { tree: RestTreeEntry[] } = await githubRestJson<{ tree: RestTreeEntry[] }>(
      "GET",
      `/repos/${headRepo}/git/trees/${encodeURIComponent(blobSha)}`,
    );
    const entry = tree.tree.find((candidate) => candidate.path === segments[index]);
    const isFile = index === segments.length - 1;
    if (entry && (isFile ? entry.type !== "blob" || entry.mode !== "100644" : entry.type !== "tree")) {
      throw new StalePrHeadError("PR file is no longer editable");
    }
    blobSha = entry?.sha ?? null;
  }
  let current: string | null = null;
  if (blobSha !== null) {
    const currentBlob = await githubRestJson<{ content: string; encoding: string }>(
      "GET",
      `/repos/${headRepo}/git/blobs/${encodeURIComponent(blobSha)}`,
    );
    if (currentBlob.encoding !== "base64") throw new StalePrHeadError("PR file is no longer editable");
    try {
      current = strictUtf8Decoder.decode(Buffer.from(currentBlob.content, "base64"));
    } catch {
      throw new StalePrHeadError("PR file is no longer editable");
    }
    if (current.includes("\0")) throw new StalePrHeadError("PR file is no longer editable");
  }
  const content = input.edit(current);
  if (content === null) return null;

  const blob = await githubRestJson<{ sha: string }>("POST", `/repos/${headRepo}/git/blobs`, {
    content: Buffer.from(content).toString("base64"),
    encoding: "base64",
  });
  const nextTree = await githubRestJson<{ sha: string }>("POST", `/repos/${headRepo}/git/trees`, {
    base_tree: commit.tree.sha,
    tree: [{ path: input.path, mode: "100644", type: "blob", sha: blob.sha }],
  });
  const nextCommit = await githubRestJson<{ sha: string }>("POST", `/repos/${headRepo}/git/commits`, {
    message: input.message,
    tree: nextTree.sha,
    parents: [headOid],
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
  return nextCommit.sha;
}

export async function commitPrFileEdit(input: PrFileEdit): Promise<{ commitOid: string }> {
  const commitOid = await writePrFile({
    ...input,
    edit: (current) => {
      if (current === null) throw new StalePrHeadError("PR file is no longer editable");
      return input.content;
    },
  });
  return { commitOid: commitOid! };
}

/** A changed file's path, or a folder as `dir/**`, as the PR tree's .gitattributes pattern. */
export function generatedAttributeLine(pattern: string): string {
  const folder = pattern.endsWith("/**");
  const path = folder ? pattern.slice(0, -3) : pattern;
  // Glob characters match literally and a leading ! or # keeps its meaning as a name.
  const literal = `${path.replace(/[*?[\\]/g, "\\$&").replace(/^[!#]/, "\\$&")}${folder ? "/**" : ""}`;
  // Whitespace ends an unquoted pattern, so such paths use Git's C-style quoting.
  const quoted = /[\s"]/.test(literal) ? `"${literal.replace(/[\\"]/g, "\\$&").replace(/\t/g, "\\t")}"` : literal;
  return `${quoted} linguist-generated=true`;
}

/** Commits a root .gitattributes rule marking `pattern` generated onto the PR head; null when it is already there. */
export async function markPrPathGenerated(repo: string, number: number, pattern: string): Promise<{ commitOid: string | null }> {
  const line = generatedAttributeLine(pattern);
  const commitOid = await writePrFile({
    repo,
    number,
    path: ".gitattributes",
    expectedHeadOid: null,
    message: `chore: mark ${pattern} as generated`,
    edit: (current) => {
      if (current === null) return `${line}\n`;
      if (current.split(/\r?\n/).some((existing) => existing.trim() === line)) return null;
      return `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}${line}\n`;
    },
  });
  return { commitOid };
}

export type PrHeadPushAccess = { allowed: boolean; reason: string | null };

/** Whether the viewer can push to the PR's head branch. Permissions GitHub leaves out defer to the push itself. */
export async function prHeadPushAccess(repo: string, number: number): Promise<PrHeadPushAccess> {
  if (mockGithub) return { allowed: true, reason: null };
  const pullRequest = await githubRestJson<RestPull>("GET", `/repos/${encodedRepo(repo)}/pulls/${number}`);
  if (pullRequest.state !== "open") return { allowed: false, reason: "This pull request is not open." };
  const head = pullRequest.head.repo;
  if (!head) return { allowed: false, reason: "The head repository was deleted." };
  if (head.permissions?.push !== false) return { allowed: true, reason: null };
  if (head.full_name === pullRequest.base.repo.full_name) return { allowed: false, reason: `You can't push to ${head.full_name}.` };
  // A fork's head branch takes pushes from base-repository writers only while it allows maintainer edits.
  if (!pullRequest.maintainer_can_modify) return { allowed: false, reason: `${head.full_name} doesn't allow edits from maintainers.` };
  if (pullRequest.base.repo.permissions?.push === false) return { allowed: false, reason: `You can't push to ${head.full_name}.` };
  return { allowed: true, reason: null };
}

export type PrMergeCommit = ResolvedMerge & {
  repo: string;
  number: number;
  expectedHeadOid: string;
  baseOid: string;
};

/** Commits `baseOid` merged into the PR head with GitHub's default merge message, as its conflict editor does. */
export async function commitPrMerge(input: PrMergeCommit): Promise<{ commitOid: string }> {
  const pullRequest = await githubRestJson<RestPull>("GET", `/repos/${encodedRepo(input.repo)}/pulls/${input.number}`);
  if (pullRequest.state !== "open") throw new StalePrHeadError("PR is no longer open");
  if (!pullRequest.head?.ref || !pullRequest.head.repo?.full_name) throw new StalePrHeadError("PR head is unavailable");
  if (pullRequest.head.sha.toLowerCase() !== input.expectedHeadOid) throw new StalePrHeadError();

  const headRepo = encodedRepo(pullRequest.head.repo.full_name);
  for (const entry of input.entries) {
    if (!entry.content) continue;
    const blob = await githubRestJson<{ sha: string }>("POST", `/repos/${headRepo}/git/blobs`, {
      content: Buffer.from(entry.content).toString("base64"),
      encoding: "base64",
    });
    if (blob.sha !== entry.sha) throw new Error(`GitHub stored ${entry.path} as ${blob.sha}, expected ${entry.sha}`);
  }
  const tree = input.entries.length === 0
    ? input.baseTree
    : (await githubRestJson<{ sha: string }>("POST", `/repos/${headRepo}/git/trees`, {
      base_tree: input.baseTree,
      tree: input.entries.map(({ path, mode, type, sha }) => ({ path, mode, type, sha })),
    })).sha;
  // Any other tree would commit something other than the merge the user resolved.
  if (tree !== input.tree) throw new Error(`GitHub built merge tree ${tree}, expected ${input.tree}`);
  const commit = await githubRestJson<{ sha: string }>("POST", `/repos/${headRepo}/git/commits`, {
    message: `Merge branch '${pullRequest.base.ref}' into ${pullRequest.head.ref}`,
    tree,
    parents: [input.expectedHeadOid, input.baseOid],
  });
  const encodedRef = pullRequest.head.ref.split("/").map(encodeURIComponent).join("/");
  try {
    await githubRestJson("PATCH", `/repos/${headRepo}/git/refs/heads/${encodedRef}`, { sha: commit.sha, force: false });
  } catch (error) {
    if (isRefUpdateRace(error)) throw new StalePrHeadError();
    throw error;
  }
  return { commitOid: commit.sha };
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

async function restJson<T>(path: string, repo?: string): Promise<T> {
  return githubRestJson<T>("GET", path, undefined, repo);
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
  const alerts = await fetchRestPages<Alert>(`https://api.github.com/repos/${encodedRepo(repo)}/code-scanning/alerts?ref=${encodeURIComponent(`refs/pull/${number}/merge`)}&tool_name=CodeQL&per_page=100`, undefined, repo);
  const matches = alerts.filter((alert) => {
    const location = alert.most_recent_instance.location;
    return location.path === path && line !== null && line >= location.start_line && line <= (location.end_line ?? location.start_line);
  });
  if (matches.length !== 1) throw new Error("Could not uniquely identify the CodeQL alert. Open the finding on GitHub to choose its dismissal reason.");
  return matches[0]!.number;
}

// GitHub rejects dismissing a dismissed alert, so an alert already in the target state is done.
export async function setCodeScanningAlertResolved(repo: string, alertNumber: number, resolved: boolean, dismissal?: { reason: string; comment?: string }): Promise<void> {
  const choice = resolved ? validateCodeScanningDismissal(dismissal) : undefined;
  const path = `/repos/${encodedRepo(repo)}/code-scanning/alerts/${alertNumber}`;
  if (!mockGithub) {
    const { state } = await restJson<{ state: string }>(path);
    if (state !== (resolved ? "open" : "dismissed")) return;
  }
  await restRequest("PATCH", path,
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

const CONVERT_TO_DRAFT_MUTATION = `
mutation($pullRequestId: ID!) {
  convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) { pullRequest { isDraft } }
}`;

export async function convertPullRequestToDraft(pullRequestId: string): Promise<void> {
  if (mockGithub) return;
  await graphql(CONVERT_TO_DRAFT_MUTATION, { pullRequestId }, "user action", "convert PR to draft");
}


export async function closePullRequest(repo: string, number: number): Promise<void> {
  if (mockGithub) return;
  await restRequest("PATCH", `/repos/${repo}/pulls/${number}`, { state: "closed" });
}


export async function fetchPullRequestBody(repo: string, number: number): Promise<string> {
  if (mockGithub) return mockGithub.pullRequestBody(repo, number);
  const pr = await restJson<{ body: string | null }>(`/repos/${repo}/pulls/${number}`, repo);
  return pr.body ?? "";
}

export async function updatePullRequestBody(repo: string, number: number, body: string): Promise<void> {
  if (mockGithub) return mockGithub.updatePullRequestBody(repo, number, body);
  await restRequest("PATCH", `/repos/${repo}/pulls/${number}`, { body });
}


export async function updatePullRequestTitle(repo: string, number: number, title: string): Promise<void> {
  if (mockGithub) return mockGithub.updatePullRequestTitle(repo, number, title);
  await restRequest("PATCH", `/repos/${repo}/pulls/${number}`, { title });
}
