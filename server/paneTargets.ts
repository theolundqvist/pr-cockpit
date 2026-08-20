const HOST_ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SOCKET_PATH_RE = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const SESSION_ID_RE = /^\$(?:0|[1-9][0-9]*)$/;
const WINDOW_ID_RE = /^@(?:0|[1-9][0-9]*)$/;
const PANE_ID_RE = /^%(?:0|[1-9][0-9]*)$/;
const CLIENT_NAME_RE = /^\/[A-Za-z0-9._/-]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const LOCAL_STATUS_URL = Bun.env.COCKPIT_DAEMON_URL ?? "http://127.0.0.1:47291/status";
const REMOTE_STATUS_URL = "http://127.0.0.1:47291/status";
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_CACHE_MS = 1_000;

export type PaneTargetSource = "explicit" | "worktree";
export type PaneHost = string | null;

export interface PaneTarget {
  repo: string;
  number: number;
  socketPath: string;
  sessionId: string;
  windowId: string;
  paneId: string;
  clientName: string | null;
  cwd: string;
  source: PaneTargetSource;
  observedAt: string;
  attached: boolean;
  active: boolean;
  windowActivityAt: number;
}

export interface PaneTargetStatus {
  paneTargetsVersion: 1;
  paneTargets: PaneTarget[];
}

export interface HostedPaneTarget extends PaneTarget {
  host: PaneHost;
}

export interface PaneHostDiagnostic {
  host: PaneHost;
  status: "current" | "cached" | "unavailable";
}

export interface PaneTargetCollection {
  targets: HostedPaneTarget[];
  hosts: PaneHostDiagnostic[];
}

export type PaneStatusFetcher = (url: string, signal: AbortSignal) => Promise<unknown>;
export type RemotePaneStatusRunner = (host: string, signal: AbortSignal) => Promise<unknown>;

export interface PaneTargetCollectorOptions {
  hosts?: readonly string[];
  localStatusUrl?: string;
  timeoutMs?: number;
  cacheMs?: number;
  fetchStatus?: PaneStatusFetcher;
  runRemoteStatus?: RemotePaneStatusRunner;
  now?: () => number;
}

interface HostSnapshot {
  targets: HostedPaneTarget[];
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE_RE.test(value) && Number.isFinite(Date.parse(value));
}

function isSocketPath(value: unknown): value is string {
  return typeof value === "string" && SOCKET_PATH_RE.test(value) && !value.split("/").some((segment) => segment === "." || segment === "..");
}

function isCwd(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && !value.includes("\0");
}

function isClientName(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && CLIENT_NAME_RE.test(value));
}

function validateTarget(value: unknown): PaneTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const target = value as Record<string, unknown>;
  if (
    typeof target.repo !== "string" ||
    !REPO_RE.test(target.repo) ||
    typeof target.number !== "number" ||
    !Number.isSafeInteger(target.number) ||
    target.number <= 0 ||
    !isSocketPath(target.socketPath) ||
    typeof target.sessionId !== "string" ||
    !SESSION_ID_RE.test(target.sessionId) ||
    typeof target.windowId !== "string" ||
    !WINDOW_ID_RE.test(target.windowId) ||
    typeof target.paneId !== "string" ||
    !PANE_ID_RE.test(target.paneId) ||
    !isClientName(target.clientName) ||
    !isCwd(target.cwd) ||
    (target.source !== "explicit" && target.source !== "worktree") ||
    !isIsoDate(target.observedAt) ||
    typeof target.attached !== "boolean" ||
    typeof target.active !== "boolean" ||
    typeof target.windowActivityAt !== "number" ||
    !Number.isFinite(target.windowActivityAt) ||
    target.windowActivityAt < 0
  ) {
    return null;
  }

  return {
    repo: target.repo,
    number: target.number,
    socketPath: target.socketPath,
    sessionId: target.sessionId,
    windowId: target.windowId,
    paneId: target.paneId,
    clientName: target.clientName,
    cwd: target.cwd,
    source: target.source,
    observedAt: target.observedAt,
    attached: target.attached,
    active: target.active,
    windowActivityAt: target.windowActivityAt,
  };
}

export function validatePaneTargetsStatus(value: unknown): PaneTargetStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = value as Record<string, unknown>;
  if (status.paneTargetsVersion !== 1 || !Array.isArray(status.paneTargets)) return null;

  const targets: PaneTarget[] = [];
  for (const target of status.paneTargets) {
    const validated = validateTarget(target);
    if (!validated) return null;
    targets.push(validated);
  }
  return { paneTargetsVersion: 1, paneTargets: targets };
}

export function parsePaneHosts(raw = Bun.env.COCKPIT_TMUX_HOSTS ?? ""): string[] {
  const hosts: string[] = [];
  for (const alias of raw.split(",").map((value) => value.trim())) {
    if (!alias || !HOST_ALIAS_RE.test(alias) || hosts.includes(alias)) continue;
    hosts.push(alias);
  }
  return hosts;
}

async function defaultFetchStatus(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("status request failed");
  return response.json();
}

async function defaultRunRemoteStatus(host: string, signal: AbortSignal): Promise<unknown> {
  const child = Bun.spawn(
    [
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=2",
      host,
      "curl",
      "--fail",
      "--silent",
      "--show-error",
      "--max-time",
      "2",
      REMOTE_STATUS_URL,
    ],
    { stdout: "pipe", stderr: "ignore" },
  );
  const abort = () => child.kill();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error("remote status request failed");
    return JSON.parse(await new Response(child.stdout).text());
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

function withTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("pane target request timed out"));
    }, timeoutMs);
    Promise.resolve()
      .then(() => run(controller.signal))
      .then(resolve, reject)
      .finally(() => clearTimeout(timeout));
  });
}


export function paneTargetKey(target: Pick<HostedPaneTarget, "host" | "socketPath" | "sessionId" | "windowId" | "paneId">): string {
  return [target.host ?? "local", target.socketPath, target.sessionId, target.windowId, target.paneId].join("\u0000");
}

export function candidatesForPr(
  collection: Pick<PaneTargetCollection, "targets">,
  repo: string,
  number: number,
  configuredHosts: readonly string[] = [],
): HostedPaneTarget[] {
  const hostOrder = new Map<PaneHost, number>([[null, 0]]);
  configuredHosts.forEach((host, index) => hostOrder.set(host, index + 1));
  return collection.targets
    .filter((target) => target.repo === repo && target.number === number)
    .toSorted((left, right) => {
      const source = Number(left.source !== "explicit") - Number(right.source !== "explicit");
      if (source) return source;
      const active = Number(right.active) - Number(left.active);
      if (active) return active;
      const activity = right.windowActivityAt - left.windowActivityAt;
      if (activity) return activity;
      const attached = Number(right.attached) - Number(left.attached);
      if (attached) return attached;
      const observed = Date.parse(right.observedAt) - Date.parse(left.observedAt);
      if (observed) return observed;
      const host = (hostOrder.get(left.host) ?? Number.MAX_SAFE_INTEGER) - (hostOrder.get(right.host) ?? Number.MAX_SAFE_INTEGER);
      if (host) return host;
      return paneTargetKey(left).localeCompare(paneTargetKey(right));
    });
}

export function createPaneTargetCollector(options: PaneTargetCollectorOptions = {}) {
  const hosts = (options.hosts ? [...options.hosts] : parsePaneHosts()).filter((host, index, values) => HOST_ALIAS_RE.test(host) && values.indexOf(host) === index);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheMs = options.cacheMs ?? DEFAULT_CACHE_MS;
  const fetchStatus = options.fetchStatus ?? defaultFetchStatus;
  const runRemoteStatus = options.runRemoteStatus ?? defaultRunRemoteStatus;
  const now = options.now ?? Date.now;
  const lastGood = new Map<PaneHost, HostSnapshot>();
  let cached: { at: number; collection: PaneTargetCollection } | null = null;
  let inFlight: Promise<PaneTargetCollection> | null = null;

  const refreshHost = async (host: PaneHost): Promise<PaneHostDiagnostic> => {
    try {
      const raw = await withTimeout(timeoutMs, (signal) => host === null
        ? fetchStatus(options.localStatusUrl ?? LOCAL_STATUS_URL, signal)
        : runRemoteStatus(host, signal));
      const status = validatePaneTargetsStatus(raw);
      if (!status) throw new Error("invalid pane target status");
      lastGood.set(host, { targets: status.paneTargets.map((target) => ({ ...target, host })) });
      return { host, status: "current" };
    } catch {
      return { host, status: lastGood.has(host) ? "cached" : "unavailable" };
    }
  };

  const collect = (): Promise<PaneTargetCollection> => {
    const current = cached;
    if (current && now() - current.at < cacheMs) return Promise.resolve(current.collection);
    if (inFlight) return inFlight;
    inFlight = Promise.allSettled([refreshHost(null), ...hosts.map((host) => refreshHost(host))])
      .then((results) => {
        const diagnostics = results.map((result, index) => result.status === "fulfilled"
          ? result.value
          : { host: index === 0 ? null : hosts[index - 1]!, status: "unavailable" as const });
        const targets = diagnostics.flatMap((diagnostic) => lastGood.get(diagnostic.host)?.targets ?? []);
        const collection = { targets, hosts: diagnostics };
        cached = { at: now(), collection };
        return collection;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return { collect, hosts: [...hosts] };
}
