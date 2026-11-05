import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { countPrs, getSetting, setSetting } from "./db.ts";
import { isMockGithub } from "./mockGithub.ts";
import { configuredReplicaSshHost, relayConfig, settingsRepos, usageStatsForcedOff } from "./settings.ts";
import { runningRev } from "./version.ts";

// Usage statistics carry only names, enums, random ids, numbers and timestamps, never user data.
const NAME_RE = /^[a-z0-9][a-z0-9:._/+-]{0,63}$/;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const VERSION_RE = /^[A-Za-z0-9._-]{1,40}$/;
const QUEUE_LIMIT = 2000;
const BATCH_EVENTS = 200;
// The relay accepts 64 KiB per batch; this leaves room for the envelope.
const BATCH_BYTES = 60_000;
const FLUSH_INTERVAL_MS = 60_000;
const FIRST_FLUSH_MS = 5_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const UI_BATCH_LIMIT = 50;
const CLI_RUN_LIMIT = 500;
const RELAY_INSTALL_KEY = "relay_install_id";
const FIRST_LAUNCH_KEY = "usage_first_launch_at";
const SIGNED_IN_KEY = "usage_signed_in_at";
const REPOS_CONFIGURED_KEY = "usage_repos_configured_at";
const UI_KINDS: Record<string, true> = { screen: true, ui: true, key: true, step: true };
const UI_CLIENTS: Record<string, true> = { electron: true, browser: true };
// Static segments of /api/agent/ routes; owners, repositories, numbers and ids never match.
const AGENT_ROUTE_SEGMENTS: Record<string, true> = {
  diff: true,
  jobs: true,
  logs: true,
  file: true,
  runs: true,
  cache: true,
  "actions-lease": true,
  mutations: true,
  "review-handoff": true,
  threads: true,
};

export type UsageKind = "screen" | "ui" | "key" | "step" | "cli";
export type UsageClient = "electron" | "browser" | "cli" | "server";

export interface UsageEvent {
  at: number;
  session?: string;
  kind: UsageKind;
  screen?: string;
  action: string;
  value?: string;
  client?: UsageClient;
}

let queue: UsageEvent[] = [];
let timer: Timer | null = null;
let flushing: Promise<void> | null = null;
let nextFlushAt = Date.now() + FLUSH_INTERVAL_MS;
let failedFlushes = 0;
let installRef: string | null | undefined;
const reportedAuthStates = new Set<string>();
const countedCliRuns = new Set<string>();

function validName(value: unknown): value is string {
  return typeof value === "string" && NAME_RE.test(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value);
}

// The relay's stream limits key on this rather than on the changing proof set; usage batches reuse it.
export function relayInstallId(): string {
  const stored = getSetting(RELAY_INSTALL_KEY);
  if (stored) return stored;
  const created = crypto.randomUUID();
  setSetting(RELAY_INSTALL_KEY, created);
  return created;
}

// Replicas report nothing: their source install counts every request they forward.
export function usageStatsEnabled(): boolean {
  return !isMockGithub
    && !usageStatsForcedOff()
    && getSetting("usage_stats") !== "off"
    && relayConfig().url !== ""
    && configuredReplicaSshHost() === "";
}

function scheduleFlush(): void {
  if (timer || flushing) return;
  timer = setTimeout(() => {
    timer = null;
    void flushUsageStats();
  }, Math.max(0, nextFlushAt - Date.now()));
  timer.unref();
}

function enqueue(events: UsageEvent[]): void {
  if (events.length === 0) return;
  queue.push(...events);
  if (queue.length > QUEUE_LIMIT) queue.splice(0, queue.length - QUEUE_LIMIT);
  scheduleFlush();
}

function record(event: UsageEvent): void {
  try {
    if (!validName(event.action) || (event.value !== undefined && !validName(event.value))) return;
    if (event.session !== undefined && !validId(event.session)) return;
    if (!usageStatsEnabled()) return;
    enqueue([event]);
  } catch (error) {
    console.warn("usage statistics event dropped:", error);
  }
}

export function trackStep(action: string, value?: string, extra: { client?: UsageClient; session?: string } = {}): void {
  record({
    at: Date.now(),
    ...(extra.session === undefined ? {} : { session: extra.session }),
    kind: "step",
    action,
    ...(value === undefined ? {} : { value }),
    ...(extra.client === undefined ? {} : { client: extra.client }),
  });
}

export function trackCli(command: string, ok: boolean, session?: string): void {
  record({
    at: Date.now(),
    ...(session === undefined ? {} : { session }),
    kind: "cli",
    action: command,
    value: ok ? "ok" : "failed",
    client: "cli",
  });
}

function uiEvent(input: unknown, session: string, client: UsageClient): UsageEvent | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const { at, kind, screen, action, value } = input as Record<string, unknown>;
  if (typeof kind !== "string" || UI_KINDS[kind] !== true) return null;
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return null;
  if (!validName(action) || (value !== undefined && !validName(value)) || (screen !== undefined && !validName(screen))) return null;
  return {
    at: Math.round(at),
    session,
    kind: kind as UsageKind,
    ...(screen === undefined ? {} : { screen }),
    action,
    ...(value === undefined ? {} : { value }),
    client,
  };
}

// False for a malformed batch; malformed events inside a valid batch are dropped silently.
export function trackUiBatch(session: unknown, client: unknown, events: unknown): boolean {
  if (!validId(session) || typeof client !== "string" || UI_CLIENTS[client] !== true) return false;
  if (!Array.isArray(events) || events.length > UI_BATCH_LIMIT) return false;
  try {
    if (!usageStatsEnabled()) return true;
    enqueue(events.flatMap((input) => uiEvent(input, session, client as UsageClient) ?? []));
  } catch (error) {
    console.warn("usage statistics batch dropped:", error);
  }
  return true;
}

// Older CLIs name no command; count them by route shape with every owner, repository, number and id removed.
function legacyCliCommand(method: string, pathname: string): string {
  const parts = pathname.split("/").filter(Boolean).slice(2);
  const resource = parts[0] === "pr" || parts[0] === "repo" ? parts[0] : "other";
  const skip = resource === "pr" ? 4 : resource === "repo" ? 3 : 1;
  const segments = parts.slice(skip).filter((part) => AGENT_ROUTE_SEGMENTS[part] === true);
  return [`${method.toLowerCase()}:${resource}`, ...segments].join("/");
}

// One CLI run polls repeatedly, so its run id counts each outcome of its command once.
export function trackCliRequest(request: Request, status: number): void {
  try {
    const command = request.headers.get("x-pr-cockpit-command");
    const pathname = new URL(request.url).pathname;
    if (command === null && !pathname.startsWith("/api/agent/")) return;
    if (!usageStatsEnabled()) return;
    const ok = status < 400;
    if (command === null) {
      trackCli(legacyCliCommand(request.method, pathname), ok);
      return;
    }
    const session = request.headers.get("x-pr-cockpit-session") || undefined;
    if (!validName(command) || (session !== undefined && !validId(session))) return;
    if (session !== undefined) {
      const key = `${session} ${command} ${ok}`;
      if (countedCliRuns.has(key)) return;
      countedCliRuns.add(key);
      if (countedCliRuns.size > CLI_RUN_LIMIT) countedCliRuns.delete(countedCliRuns.values().next().value!);
    }
    trackCli(command, ok, session);
  } catch (error) {
    console.warn("usage statistics CLI event dropped:", error);
  }
}

function trackMilestone(settingKey: string, action: string): void {
  if (getSetting(settingKey) !== null) return;
  setSetting(settingKey, new Date().toISOString());
  trackStep(action);
}

export function trackGithubAuth(state: string): void {
  try {
    if (!usageStatsEnabled()) return;
    if (state === "ready") {
      trackMilestone(SIGNED_IN_KEY, "signed-in");
      return;
    }
    if (reportedAuthStates.has(state)) return;
    reportedAuthStates.add(state);
    trackStep("auth", state);
  } catch (error) {
    console.warn("usage statistics auth step dropped:", error);
  }
}

export function trackReposConfigured(): void {
  try {
    if (usageStatsEnabled() && settingsRepos().length > 0) trackMilestone(REPOS_CONFIGURED_KEY, "repos-configured");
  } catch (error) {
    console.warn("usage statistics repository step dropped:", error);
  }
}

// Runs once per source-install server start.
export function startUsageStats(): void {
  try {
    if (!usageStatsEnabled()) return;
    nextFlushAt = Date.now() + FIRST_FLUSH_MS;
    if (getSetting(FIRST_LAUNCH_KEY) === null) {
      // An install that predates statistics is past onboarding; its milestones must not count as new.
      const existing = getSetting(RELAY_INSTALL_KEY) !== null || countPrs() > 0;
      const now = new Date().toISOString();
      setSetting(FIRST_LAUNCH_KEY, now);
      if (existing) {
        if (getSetting(SIGNED_IN_KEY) === null) setSetting(SIGNED_IN_KEY, now);
        if (getSetting(REPOS_CONFIGURED_KEY) === null && settingsRepos().length > 0) setSetting(REPOS_CONFIGURED_KEY, now);
      }
      trackStep("first-launch", existing ? "existing" : "new");
    }
    trackStep("launch");
  } catch (error) {
    console.warn("usage statistics startup failed:", error);
  }
}

// Settings saves call this: turning statistics or the relay off discards everything queued.
export function applyUsageStatsSetting(): void {
  if (usageStatsEnabled()) {
    if (queue.length > 0) scheduleFlush();
    return;
  }
  queue = [];
  clearTimeout(timer ?? undefined);
  timer = null;
}

function readInstallRef(): string | null {
  if (installRef !== undefined) return installRef;
  try {
    const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    const value = readFileSync(join(configHome, "pr-cockpit", "install-ref"), "utf8").trim();
    installRef = ID_RE.test(value) ? value : null;
  } catch {
    installRef = null;
  }
  return installRef;
}

function usageBatch(events: UsageEvent[]) {
  const ref = readInstallRef();
  const version = runningRev().slice(0, 7);
  return {
    install: relayInstallId(),
    ...(ref === null ? {} : { ref }),
    surface: "app",
    ...(VERSION_RE.test(version) ? { version } : {}),
    platform: process.platform === "darwin" || process.platform === "linux" ? process.platform : "other",
    events,
  };
}

function chunked(events: UsageEvent[]): UsageEvent[][] {
  const chunks: UsageEvent[][] = [];
  let chunk: UsageEvent[] = [];
  let bytes = 0;
  for (const event of events) {
    const size = JSON.stringify(event).length + 1;
    if (chunk.length === BATCH_EVENTS || (chunk.length > 0 && bytes + size > BATCH_BYTES)) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(event);
    bytes += size;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

async function sendQueued(fetcher: typeof fetch): Promise<void> {
  if (!usageStatsEnabled()) {
    applyUsageStatsSetting();
    return;
  }
  const url = relayConfig().url;
  try {
    for (const chunk of chunked(queue.slice())) {
      const response = await fetcher(`${url}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(usageBatch(chunk)),
        signal: AbortSignal.timeout(10_000),
      });
      // Retrying a batch the relay rejected can never succeed.
      const rejected = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
      if (!response.ok && !rejected) throw new Error(`relay events responded ${response.status}`);
      if (rejected) console.warn(`relay rejected ${chunk.length} usage events (${response.status})`);
      const sent = new Set(chunk);
      queue = queue.filter((event) => !sent.has(event));
    }
    failedFlushes = 0;
    nextFlushAt = Date.now() + FLUSH_INTERVAL_MS;
  } catch {
    failedFlushes += 1;
    nextFlushAt = Date.now() + Math.min(FLUSH_INTERVAL_MS * 2 ** failedFlushes, MAX_BACKOFF_MS);
  }
}

export function flushUsageStats(fetcher: typeof fetch = fetch): Promise<void> {
  clearTimeout(timer ?? undefined);
  timer = null;
  flushing ??= sendQueued(fetcher).finally(() => {
    flushing = null;
    if (queue.length > 0) scheduleFlush();
  });
  return flushing;
}
