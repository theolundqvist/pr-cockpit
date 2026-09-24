import { getPr, getSetting, setSetting } from "./db.ts";
import { ghToken } from "./github.ts";
import { backgroundPollAllowed, pollOnce, refreshPr, trackedRepos } from "./poller.ts";
import { createPollRequester, prDetailScopeForEvent, refreshPrFromEvent } from "./eventRefresh.ts";
import { relayConfig } from "./settings.ts";
import { ingestActionsState, type CompactJob, type CompactRun } from "./runLogs.ts";
import { watchForWake } from "./wake.ts";
import { refreshCachedPrDetail } from "./cachedPrDetail.ts";
import { prViewedRecently } from "./recentPrViews.ts";

const POLL_MS = 5_000;
const ERROR_BACKOFF_MS = 60_000;
const FULL_POLL_DEBOUNCE_MS = 30_000;
const STREAM_BACKOFF_MAX_MS = 30_000;
const RELAY_PING_INTERVAL_MS = 20_000;
const RELAY_SILENCE_TIMEOUT_MS = 45_000;

export interface RelayMarker {
  seq: number;
  ts: number;
  repo: string;
  number: number | null;
  event: string;
  run?: CompactRun;
  job?: CompactJob;
}

interface RelayPollDependencies {
  fetcher?: typeof fetch;
  ingest?: typeof ingestActionsState;
  requestFullPoll?: () => void;
  viewedRecently?: typeof prViewedRecently;
  refreshViewedPr?: typeof refreshCachedPrDetail;
  backgroundAllowed?: typeof backgroundPollAllowed;
}

interface RelayWebSocket {
  addEventListener(type: "open", listener: () => void, options?: { once?: boolean }): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "close", listener: (event: { code: number; reason: string }) => void, options?: { once?: boolean }): void;
  addEventListener(type: "error", listener: () => void, options?: { once?: boolean }): void;
  addEventListener(type: "pong", listener: () => void): void;
  close(): void;
  ping?(): void;
}

interface RelayStreamDependencies extends RelayPollDependencies {
  fullPoll?: typeof pollOnce;
  keepalive?: { pingIntervalMs: number; silenceTimeoutMs: number };
  socket?: (url: string) => RelayWebSocket;
  onOpen?: () => void;
  expectedClose?: () => boolean;
}

interface RelayClientDependencies extends RelayStreamDependencies {
  token?: typeof ghToken;
  repos?: typeof trackedRepos;
  now?: () => number;
}

type RelayFrame =
  | { type: "ready"; latest: number }
  | { type: "marker"; marker: RelayMarker }
  | { type: "reset"; latest: number };

const RELAY_CURSOR_KEY = "relay_cursor";
let backoffUntil = 0;
let lastOkAt: number | null = null;
let lastEventAt: number | null = null;
let lastError: string | null = null;

export function relayStatus(): { lastOkAt: number | null; lastEventAt: number | null; lastError: string | null } {
  return { lastOkAt, lastEventAt, lastError };
}

const requestFullPoll = createPollRequester(
  () => pollOnce(),
  FULL_POLL_DEBOUNCE_MS,
  (error) => console.error("relay-triggered poll failed:", error),
);

// Events that can put a PR into the viewer's queue: opening it, requesting a review, assigning,
// or mentioning. The PR is not cached yet, so only the involves:@me search can place it.
const QUEUE_MEMBERSHIP_EVENTS = new Set([
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_review_thread",
  "issue_comment",
]);

function persistedCursor(): number | null {
  const raw = getSetting(RELAY_CURSOR_KEY);
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function saveCursor(value: number): void {
  setSetting(RELAY_CURSOR_KEY, String(value));
}

async function processMarker(marker: RelayMarker, deps: RelayPollDependencies = {}): Promise<void> {
  const ingest = deps.ingest ?? ingestActionsState;
  if (marker.run || marker.job) {
    // Log downloads for a watched PR would otherwise hold every later marker, including the
    // check and review events that refresh what the user is looking at.
    await ingest(marker.repo, { run: marker.run, job: marker.job }, undefined, "background");
  } else if (marker.number === null) {
    (deps.requestFullPoll ?? requestFullPoll)();
  } else {
    const key = `${marker.repo}#${marker.number}`;
    if (getPr(marker.repo, marker.number) !== null) {
      void refreshPrFromEvent(marker.repo, marker.number, prDetailScopeForEvent(marker.event), async (repo, number, scope) => {
        if (await backgroundPollAllowed()) await refreshPr(repo, number, "relay", scope);
      }).catch((error) => console.error(`relay-triggered refresh failed for ${key}:`, error));
    } else {
      // Not in the inbox, but open (or recently opened) in the app: without this its detail
      // stayed up to five minutes stale, and a reload inside that window showed the same snapshot.
      if ((deps.viewedRecently ?? prViewedRecently)(marker.repo, marker.number)) {
        const refreshViewed = deps.refreshViewedPr ?? refreshCachedPrDetail;
        void refreshPrFromEvent(marker.repo, marker.number, prDetailScopeForEvent(marker.event), async (repo, number, scope) => {
          if (await (deps.backgroundAllowed ?? backgroundPollAllowed)()) await refreshViewed(repo, number, "relay", scope);
        }).catch((error) => console.error(`relay-triggered refresh failed for ${key}:`, error));
      }
      if (QUEUE_MEMBERSHIP_EVENTS.has(marker.event)) (deps.requestFullPoll ?? requestFullPoll)();
    }
  }
  saveCursor(marker.seq);
}

export async function pollRelayOnce(
  url: string,
  token: string,
  deps: RelayPollDependencies = {},
): Promise<number> {
  const fetcher = deps.fetcher ?? fetch;
  const cursor = persistedCursor();
  const since = cursor === null ? "" : `?since=${cursor}`;
  const res = await fetcher(`${url}/events${since}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(4_000),
  });
  if (!res.ok) throw new Error(`relay responded ${res.status}`);
  const { latest, events } = (await res.json()) as { latest: number; events: RelayMarker[] };
  if (cursor === null) {
    saveCursor(latest);
    return 0;
  }

  const refreshed = new Set<string>();
  for (const marker of events) {
    const key = !marker.run && !marker.job && marker.number !== null ? `${marker.repo}#${marker.number}` : null;
    if (key !== null && refreshed.has(key)) {
      saveCursor(marker.seq);
      continue;
    }
    if (key !== null) refreshed.add(key);
    await processMarker(marker, deps);
  }
  saveCursor(latest);
  return events.length;
}

export async function relayCapability(url: string, fetcher: typeof fetch = fetch): Promise<"legacy" | "websocket"> {
  const response = await fetcher(`${url}/capabilities`, { signal: AbortSignal.timeout(4_000) });
  if (response.status === 404) return "legacy";
  if (!response.ok) throw new Error(`relay capabilities responded ${response.status}`);
  const capabilities = (await response.json()) as { stream?: unknown };
  if (capabilities.stream !== "websocket-v1") throw new Error("relay advertised an unsupported stream");
  return "websocket";
}

export async function createRelaySession(
  url: string,
  token: string,
  repos: string[],
  fetcher: typeof fetch = fetch,
): Promise<{ ticket: string; expiresAt: number; repos: Record<string, boolean> }> {
  const response = await fetcher(`${url}/session`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ repos }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`relay session responded ${response.status}`);
  return await response.json() as { ticket: string; expiresAt: number; repos: Record<string, boolean> };
}

function streamUrl(url: string, ticket: string, cursor: number | null): string {
  const target = new URL(`${url}/stream`);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  target.searchParams.set("ticket", ticket);
  if (cursor !== null) target.searchParams.set("since", String(cursor));
  return target.href;
}

async function frameText(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return await data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  throw new Error("relay sent an unsupported WebSocket frame");
}

export async function streamRelayOnce(
  url: string,
  ticket: string,
  deps: RelayStreamDependencies = {},
): Promise<void> {
  const fullPoll = deps.fullPoll ?? pollOnce;
  const socket = (deps.socket ?? ((target) => new WebSocket(target)))(streamUrl(url, ticket, persistedCursor()));

  const keepalive = deps.keepalive ?? { pingIntervalMs: RELAY_PING_INTERVAL_MS, silenceTimeoutMs: RELAY_SILENCE_TIMEOUT_MS };

  return await new Promise<void>((resolve, reject) => {
    let opened = false;
    let socketFailed = false;
    let settled = false;
    let queue = Promise.resolve();
    let lastHeardAt = Date.now();
    const heard = () => {
      lastHeardAt = Date.now();
      lastOkAt = lastHeardAt;
    };
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(keepaliveTimer);
      queue.then(() => error ? reject(error) : resolve(), reject);
    };
    // After sleep or a network change the TCP connection can be dead without either side
    // closing it: no close event ever fires and markers silently stop. The relay answers pings,
    // so a stream that stays silent past a few ping rounds is abandoned and reopened.
    const keepaliveTimer = setInterval(() => {
      if (!opened || settled) return;
      const silentMs = Date.now() - lastHeardAt;
      if (silentMs >= keepalive.silenceTimeoutMs) {
        settle(new Error(`relay WebSocket went silent for ${Math.round(silentMs / 1000)}s`));
        socket.close();
        return;
      }
      socket.ping?.();
    }, keepalive.pingIntervalMs);

    socket.addEventListener("open", () => {
      opened = true;
      heard();
      lastError = null;
      deps.onOpen?.();
    }, { once: true });
    socket.addEventListener("pong", heard);
    socket.addEventListener("message", (event) => {
      heard();
      queue = queue.then(async () => {
        const frame = JSON.parse(await frameText(event.data)) as RelayFrame;
        if (frame.type === "ready") {
          if (persistedCursor() === null) saveCursor(frame.latest);
          return;
        }
        if (frame.type === "reset") {
          await fullPoll();
          saveCursor(frame.latest);
          return;
        }
        if (frame.type !== "marker") throw new Error("relay sent an unsupported frame");
        await processMarker(frame.marker, deps);
        lastEventAt = Date.now();
      }).catch((error) => {
        socket.close();
        throw error;
      });
    });
    socket.addEventListener("error", () => {
      socketFailed = true;
    }, { once: true });
    socket.addEventListener("close", (event) => {
      if (deps.expectedClose?.()) {
        settle();
        return;
      }
      const code = Number.isInteger(event?.code) ? event.code : 1005;
      const closeReason = event?.reason?.trim().replace(/\s+/g, " ").slice(0, 256);
      if (opened && code === 1008 && closeReason === "authorization expired") {
        settle();
        return;
      }
      const reason = closeReason ? `, reason=${closeReason}` : "";
      const state = opened ? "closed" : socketFailed ? "failed to open" : "closed before opening";
      settle(new Error(`relay WebSocket ${state} (code=${code}${reason})`));
    }, { once: true });
  });
}

class RelayConnection {
  private url = "";
  private mode: "unknown" | "legacy" | "websocket" = "unknown";
  private stream: RelayWebSocket | null = null;
  private running = false;
  private generation = 0;
  private reconnectAt = 0;
  private reconnectAttempt = 0;
  private repoSignature = "";

  constructor(private readonly deps: RelayClientDependencies = {}) {}

  private dropStream(): void {
    this.generation++;
    this.stream?.close();
    this.stream = null;
    this.running = false;
    this.repoSignature = "";
    this.reconnectAt = 0;
    this.reconnectAttempt = 0;
  }

  // A stream opened before the machine slept is presumed dead; the next tick opens a fresh one
  // and replays everything after the persisted cursor.
  reconnect(): void {
    if (this.mode === "websocket") this.dropStream();
    backoffUntil = 0;
  }

  async tick(url: string): Promise<void> {
    const now = this.deps.now ?? Date.now;
    let sessionRepos: string[] | null = null;
    if (url !== this.url) {
      this.url = url;
      this.mode = "unknown";
      this.dropStream();
    }
    if (!url) return;
    if (this.mode === "websocket" && this.running) {
      sessionRepos = await (this.deps.repos ?? trackedRepos)();
      const signature = [...new Set(sessionRepos)].sort().join("\n");
      if (signature === this.repoSignature) return;
      this.dropStream();
    } else if (this.running) {
      return;
    }

    if (this.mode === "legacy") {
      if (now() < backoffUntil) return;
      try {
        const token = await (this.deps.token ?? ghToken)();
        const eventCount = await pollRelayOnce(url, token, this.deps);
        lastOkAt = now();
        lastError = null;
        if (eventCount > 0) lastEventAt = now();
      } catch (error) {
        backoffUntil = now() + ERROR_BACKOFF_MS;
        lastError = error instanceof Error ? error.message : String(error);
        console.error("relay poll failed:", error);
      }
      return;
    }

    if (this.mode === "websocket" && now() < this.reconnectAt) return;
    const generation = this.generation;
    this.running = true;
    try {
      if (this.mode === "unknown") {
        const mode = await relayCapability(url, this.deps.fetcher);
        if (generation !== this.generation) return;
        this.mode = mode;
        if (mode === "legacy") {
          this.running = false;
          await this.tick(url);
          return;
        }
      }
      const repos = sessionRepos ?? await (this.deps.repos ?? trackedRepos)();
      if (generation !== this.generation) return;
      this.repoSignature = [...new Set(repos)].sort().join("\n");
      if (repos.length === 0) return;
      const token = await (this.deps.token ?? ghToken)();
      if (generation !== this.generation) return;
      const session = await createRelaySession(url, token, repos, this.deps.fetcher);
      if (generation !== this.generation) return;
      const createSocket = this.deps.socket ?? ((target: string) => new WebSocket(target));
      await streamRelayOnce(url, session.ticket, {
        ...this.deps,
        socket: (target) => {
          const socket = createSocket(target);
          this.stream = socket;
          return socket;
        },
        onOpen: () => {
          this.reconnectAttempt = 0;
          this.deps.onOpen?.();
        },
        expectedClose: () => generation !== this.generation,
      });
    } catch (error) {
      if (generation !== this.generation) return;
      lastError = error instanceof Error ? error.message : String(error);
      this.reconnectAttempt++;
      const delayMs = Math.min(1_000 * 2 ** (this.reconnectAttempt - 1), STREAM_BACKOFF_MAX_MS);
      this.reconnectAt = now() + delayMs;
      // Abnormal closes (1006) are routine for a long-lived stream; the stack trace says nothing.
      console.warn(`relay stream ended: ${lastError}; reconnecting in ${Math.ceil(delayMs / 1000)}s`);
    } finally {
      if (generation === this.generation) this.running = false;
    }
  }
}

export function createRelayConnection(deps: RelayClientDependencies = {}): { tick(url: string): Promise<void>; reconnect(): void } {
  return new RelayConnection(deps);
}

const connection = new RelayConnection();

export function startRelayClient(): void {
  watchForWake(() => connection.reconnect());
  setInterval(() => {
    connection.tick(relayConfig().url).catch((error) => console.error("relay tick failed:", error));
  }, POLL_MS);
}
