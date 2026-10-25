import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type GithubAppAuthentication = {
  token: string;
  identity: string;
  installationId: number;
  permissions: Record<string, string>;
};

type GithubAppErrorOptions = {
  status?: number;
  installationId?: number;
  headers?: Headers;
  secondaryRateLimited?: boolean;
};

export class GithubAppError extends Error {
  readonly status?: number;
  readonly installationId?: number;
  readonly headers: Headers;
  readonly secondaryRateLimited: boolean;

  constructor(message: string, options: GithubAppErrorOptions = {}) {
    super(message);
    this.name = "GithubAppError";
    this.status = options.status;
    this.installationId = options.installationId;
    this.headers = sanitizedResponseHeaders(options.headers);
    this.secondaryRateLimited = options.secondaryRateLimited ?? false;
  }
}

type Installation = { id: number; expiresAt: number };
type CachedToken = { authentication: GithubAppAuthentication; expiresAt: number };
type CachedFailure = { error: GithubAppError; expiresAt: number };
type Configuration = {
  path: string;
  stamp: string;
  appId: string;
  keyPath: string;
  keyStamp: string;
  key: KeyObject;
  jwt?: { token: string; expiresAt: number };
  installations: Map<string, Installation>;
  discovery: Map<string, Promise<number | null>>;
  tokens: Map<string, CachedToken>;
  issuance: Map<string, Promise<CachedToken>>;
  failures: Map<string, CachedFailure>;
  requestFailure?: CachedFailure;
};

const REQUEST_TIMEOUT_MS = 10_000;
const REFRESH_MARGIN_MS = 60_000;
const DISCOVERY_TTL_MS = 5 * 60_000;
const MISSING_INSTALLATION_TTL_MS = 60_000;
const CONFIGURATION_TTL_MS = 30_000;
const FAILURE_TTL_MS = 30_000;
const CACHE_LIMIT = 256;
let configuration: Configuration | null = null;
let configurationLoad: { path: string; promise: Promise<Configuration | null> } | null = null;
let configurationPath: string | null = null;
let configurationExpiresAt = 0;
let configurationFailure: GithubAppError | null = null;

function homePath(value: string): string {
  if (isAbsolute(value)) return value;
  return join(homedir(), value.startsWith("~/") ? value.slice(2) : value);
}

export function githubAppConfigPath(): string {
  return homePath(process.env.COCKPIT_GITHUB_APP_CONFIG || ".config/pr-cockpit/github-app.json");
}

async function fileStamp(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Not a regular file");
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

async function loadConfiguration(path: string, previous: Configuration | null): Promise<Configuration | null> {
  let stamp: string;
  try {
    stamp = await fileStamp(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new GithubAppError("GitHub App configuration could not be read.");
  }

  try {
    if (previous?.path === path && previous.stamp === stamp
      && previous.keyStamp === await fileStamp(previous.keyPath)) return previous;
    const parsed = JSON.parse(await readFile(path, "utf8")) as { appId?: unknown; privateKeyPath?: unknown } | null;
    if (!parsed || typeof parsed.appId !== "string" || !/^[A-Za-z0-9_-]+$/.test(parsed.appId)
      || typeof parsed.privateKeyPath !== "string" || !parsed.privateKeyPath.trim()) {
      throw new Error("Invalid configuration");
    }
    const keyPath = homePath(parsed.privateKeyPath);
    const keyStamp = await fileStamp(keyPath);
    const key = createPrivateKey(await readFile(keyPath));
    if (key.asymmetricKeyType !== "rsa") throw new Error("RSA key required");
    return {
      path, stamp, appId: parsed.appId, keyPath, keyStamp, key,
      installations: new Map(), discovery: new Map(), tokens: new Map(), issuance: new Map(), failures: new Map(),
    };
  } catch {
    throw new GithubAppError("GitHub App configuration must contain an appId and a readable RSA privateKeyPath.");
  }
}

function currentConfiguration(): Promise<Configuration | null> {
  const path = githubAppConfigPath();
  if (configurationPath === path && configurationExpiresAt > Date.now()) {
    return configurationFailure ? Promise.reject(configurationFailure) : Promise.resolve(configuration);
  }
  if (configurationLoad?.path === path) return configurationLoad.promise;
  const pending: { path: string; promise: Promise<Configuration | null> } = {
    path,
    promise: loadConfiguration(path, configuration?.path === path ? configuration : null).then((config) => {
      if (configurationLoad === pending) {
        configuration = config;
        configurationPath = path;
        configurationExpiresAt = Date.now() + CONFIGURATION_TTL_MS;
        configurationFailure = null;
      }
      return config;
    }, (error: GithubAppError) => {
      if (configurationLoad === pending) {
        configuration = null;
        configurationPath = path;
        configurationExpiresAt = Date.now() + CONFIGURATION_TTL_MS;
        configurationFailure = error;
      }
      throw error;
    }).finally(() => {
      if (configurationLoad === pending) configurationLoad = null;
    }),
  };
  configurationLoad = pending;
  return pending.promise;
}

export function invalidateGithubAppConfig(): void {
  configuration = null;
  configurationLoad = null;
  configurationPath = null;
  configurationExpiresAt = 0;
  configurationFailure = null;
}

function appJwt(config: Configuration): string {
  const now = Date.now();
  if (config.jwt && config.jwt.expiresAt > now + REFRESH_MARGIN_MS) return config.jwt.token;
  const seconds = Math.floor(now / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: config.appId })).toString("base64url");
  const message = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(message), config.key).toString("base64url");
  config.jwt = { token: `${message}.${signature}`, expiresAt: (seconds + 540) * 1000 };
  return config.jwt.token;
}

function sanitizedResponseHeaders(source?: Headers): Headers {
  const headers = new Headers();
  if (!source) return headers;
  const retryAfter = source.get("retry-after");
  if (retryAfter !== null) {
    if (/^\d+(?:\.\d+)?$/.test(retryAfter) && Number.isFinite(Number(retryAfter))) {
      headers.set("retry-after", String(Number(retryAfter)));
    } else {
      const deadline = Date.parse(retryAfter);
      if (Number.isFinite(deadline)) headers.set("retry-after", new Date(deadline).toUTCString());
    }
  }
  for (const name of ["limit", "remaining", "used", "reset"]) {
    const value = source.get(`x-ratelimit-${name}`);
    if (value !== null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) {
      headers.set(`x-ratelimit-${name}`, String(Number(value)));
    }
  }
  const resource = source.get("x-ratelimit-resource");
  if (resource !== null && /^[a-z][a-z0-9_]{0,63}$/.test(resource)) headers.set("x-ratelimit-resource", resource);
  return headers;
}

async function appRequest(
  config: Configuration, path: string, method: "GET" | "POST", allowMissing = false, installationId?: number,
): Promise<unknown> {
  if (config.requestFailure && config.requestFailure.expiresAt > Date.now()) throw config.requestFailure.error;
  config.requestFailure = undefined;
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${appJwt(config)}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    const error = new GithubAppError("GitHub App authentication request failed or timed out.", { installationId });
    config.requestFailure = { error, expiresAt: Date.now() + FAILURE_TTL_MS };
    throw error;
  }
  if (allowMissing && response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return undefined;
  }
  if (!response.ok) {
    const limited = response.status === 403 || response.status === 429;
    let secondaryRateLimited = limited && (response.headers.has("retry-after")
      || (response.status === 429 && response.headers.get("x-ratelimit-remaining") !== "0"));
    if (limited && !secondaryRateLimited) {
      try {
        secondaryRateLimited = /secondary rate limit|abuse detection/i.test(await response.text());
      } catch {
        // Only classification survives; response bodies and transport details are never exposed.
      }
    } else {
      await response.body?.cancel().catch(() => {});
    }
    const error = new GithubAppError(`GitHub App authentication request failed (HTTP ${response.status}).`, {
      status: response.status, installationId, headers: response.headers, secondaryRateLimited,
    });
    if (response.status === 401 || response.status === 429 || response.status >= 500
      || secondaryRateLimited || (response.status === 403 && error.headers.get("x-ratelimit-remaining") === "0")) {
      config.requestFailure = { error, expiresAt: Date.now() + FAILURE_TTL_MS };
    }
    throw error;
  }
  try {
    return await response.json();
  } catch {
    throw new GithubAppError("GitHub App authentication returned an invalid response.", { installationId });
  }
}

function boundedSet<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}

function cachedFailure(config: Configuration, key: string): GithubAppError | null {
  const failure = config.failures.get(key);
  if (!failure) return null;
  if (failure.expiresAt > Date.now()) return failure.error;
  config.failures.delete(key);
  return null;
}

function rememberFailure(config: Configuration, key: string, error: GithubAppError): void {
  boundedSet(config.failures, key, { error, expiresAt: Date.now() + FAILURE_TTL_MS });
}

function dropInstallation(config: Configuration, installationId: number, error: GithubAppError): void {
  for (const [repo, installation] of config.installations) {
    if (installation.id !== installationId) continue;
    config.installations.delete(repo);
    rememberFailure(config, `repo:${repo}`, error);
  }
}

async function installationFor(config: Configuration, repo: string): Promise<number | null> {
  const failure = cachedFailure(config, `repo:${repo}`);
  if (failure) throw failure;
  const cached = config.installations.get(repo);
  if (cached && cached.expiresAt > Date.now()) return cached.id || null;
  const pending = config.discovery.get(repo);
  if (pending) return pending;
  const discovery = (async () => {
    const [owner, name] = repo.split("/");
    const result = await appRequest(config, `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}/installation`, "GET", true) as { id?: unknown } | null | undefined;
    if (result === undefined) {
      boundedSet(config.installations, repo, { id: 0, expiresAt: Date.now() + MISSING_INSTALLATION_TTL_MS });
      return null;
    }
    if (!result || !Number.isSafeInteger(result.id) || (result.id as number) <= 0) {
      throw new GithubAppError("GitHub App installation discovery returned an invalid response.");
    }
    const id = result.id as number;
    boundedSet(config.installations, repo, { id, expiresAt: Date.now() + DISCOVERY_TTL_MS });
    return id;
  })();
  config.discovery.set(repo, discovery);
  try {
    return await discovery;
  } catch (error) {
    rememberFailure(config, `repo:${repo}`, error as GithubAppError);
    throw error;
  } finally {
    config.discovery.delete(repo);
  }
}

async function installationToken(config: Configuration, installationId: number): Promise<GithubAppAuthentication> {
  const identity = `app:${config.appId}:installation:${installationId}`;
  const failure = cachedFailure(config, identity);
  if (failure) {
    if (failure.status === 403 || failure.status === 404) dropInstallation(config, installationId, failure);
    throw failure;
  }
  const cached = config.tokens.get(identity);
  if (cached && cached.expiresAt > Date.now() + REFRESH_MARGIN_MS) {
    return { ...cached.authentication, permissions: { ...cached.authentication.permissions } };
  }
  let issuance = config.issuance.get(identity);
  if (!issuance) {
    issuance = (async () => {
      const result = await appRequest(config, `/app/installations/${installationId}/access_tokens`, "POST", false, installationId) as {
        token?: unknown; expires_at?: unknown; permissions?: Record<string, unknown>;
      } | null;
      if (!result || typeof result.token !== "string" || !result.token
        || typeof result.expires_at !== "string" || !result.permissions || typeof result.permissions !== "object"
        || Array.isArray(result.permissions) || Object.values(result.permissions).some((value) => typeof value !== "string")) {
        throw new GithubAppError("GitHub App token issuance returned an invalid response.", { installationId });
      }
      const expiresAt = Date.parse(result.expires_at);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + REFRESH_MARGIN_MS) {
        throw new GithubAppError("GitHub App token issuance returned an expired or imminently expiring token.", { installationId });
      }
      return {
        authentication: { token: result.token, identity, installationId, permissions: result.permissions as Record<string, string> },
        expiresAt,
      };
    })();
    config.issuance.set(identity, issuance);
  }
  try {
    const token = await issuance;
    // An invalidated in-flight request must not repopulate the cache.
    if (config.issuance.get(identity) === issuance) boundedSet(config.tokens, identity, token);
    return { ...token.authentication, permissions: { ...token.authentication.permissions } };
  } catch (error) {
    if (config.issuance.get(identity) === issuance) {
      const failure = error as GithubAppError;
      rememberFailure(config, identity, failure);
      if (failure.status === 403 || failure.status === 404) dropInstallation(config, installationId, failure);
    }
    throw error;
  } finally {
    if (config.issuance.get(identity) === issuance) config.issuance.delete(identity);
  }
}

export async function githubAppAuthentication(repo: string): Promise<GithubAppAuthentication | null> {
  const config = await currentConfiguration();
  if (!config) return null;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split("/").some((part) => part === "." || part === "..")) {
    throw new GithubAppError("GitHub App authentication requires an owner/repository name.");
  }
  const installationId = await installationFor(config, repo.toLowerCase());
  return installationId === null ? null : installationToken(config, installationId);
}

export function invalidateGithubAppToken(identity: string): void {
  configuration?.tokens.delete(identity);
  configuration?.issuance.delete(identity);
}
