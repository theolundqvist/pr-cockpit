import { getPr, getSetting, setSetting } from "./db.ts";
import { ghToken } from "./github.ts";
import { backgroundPollAllowed, pollOnce, refreshPr, trackedRepos } from "./poller.ts";
import { prDetailScopeForEvent, refreshPrFromEvent } from "./eventRefresh.ts";
import { relayConfig } from "./settings.ts";
import { ingestActionsState, type CompactJob, type CompactRun } from "./runLogs.ts";

const POLL_MS = 5_000;
const ERROR_BACKOFF_MS = 60_000;
const FULL_POLL_DEBOUNCE_MS = 30_000;
const STREAM_BACKOFF_MAX_MS = 30_000;

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
}

interface RelayWebSocket {
  addEventListener(type: "open", listener: () => void, options?: { once?: boolean }): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "close", listener: () => void, options?: { once?: boolean }): void;
  addEventListener(type: "error", listener: () => void, options?: { once?: boolean }): void;
  close(): void;
}

interface RelayStreamDependencies extends RelayPollDependencies {
  fullPoll?: typeof pollOnce;
  socket?: (url: string) => RelayWebSocket;
  onOpen?: () => void;
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
let lastFullPollAt = 0;
let lastOkAt: number | null = null;
let lastEventAt: number | null = null;
let lastError: string | null = null;

export function relayStatus(): { lastOkAt: number | null; lastEventAt: number | null; lastError: string | null } {
  return { lastOkAt, lastEventAt, lastError };
}

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
    await ingest(marker.repo, { run: marker.run, job: marker.job });
  } else if (marker.number === null) {
    if (Date.now() - lastFullPollAt > FULL_POLL_DEBOUNCE_MS) {
      lastFullPollAt = Date.now();
      pollOnce().catch((error) => console.error("relay-triggered poll failed:", error));
    }
  } else {
    const key = `${marker.repo}#${marker.number}`;
    if (getPr(marker.repo, marker.number) !== null) {
      void refreshPrFromEvent(marker.repo, marker.number, prDetailScopeForEvent(marker.event), async (repo, number, scope) => {
        if (await backgroundPollAllowed()) await refreshPr(repo, number, "relay", scope);
      }).catch((error) => console.error(`relay-triggered refresh failed for ${key}:`, error));
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

  return await new Promise<void>((resolve, reject) => {
    let opened = false;
    let settled = false;
    let queue = Promise.resolve();
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      queue.then(() => error ? reject(error) : resolve(), reject);
    };

    socket.addEventListener("open", () => {
      opened = true;
      lastOkAt = Date.now();
      lastError = null;
      deps.onOpen?.();
    }, { once: true });
    socket.addEventListener("message", (event) => {
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
    socket.addEventListener("error", () => settle(new Error("relay WebSocket failed")), { once: true });
    socket.addEventListener("close", () => settle(opened ? new Error("relay WebSocket closed") : new Error("relay WebSocket failed to open")), { once: true });
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

  async tick(url: string): Promise<void> {
    const now = this.deps.now ?? Date.now;
    let sessionRepos: string[] | null = null;
    if (url !== this.url) {
      this.url = url;
      this.mode = "unknown";
      this.stream?.close();
      this.stream = null;
      this.running = false;
      this.repoSignature = "";
      this.reconnectAt = 0;
      this.reconnectAttempt = 0;
      this.generation++;
    }
    if (!url) return;
    if (this.mode === "websocket" && this.running) {
      sessionRepos = await (this.deps.repos ?? trackedRepos)();
      const signature = [...new Set(sessionRepos)].sort().join("\n");
      if (signature === this.repoSignature) return;
      this.generation++;
      this.stream?.close();
      this.stream = null;
      this.running = false;
      this.repoSignature = "";
      this.reconnectAt = 0;
      this.reconnectAttempt = 0;
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
        this.mode = await relayCapability(url, this.deps.fetcher);
        if (this.mode === "legacy") {
          this.running = false;
          await this.tick(url);
          return;
        }
      }
      const repos = sessionRepos ?? await (this.deps.repos ?? trackedRepos)();
      this.repoSignature = [...new Set(repos)].sort().join("\n");
      if (repos.length === 0) return;
      const token = await (this.deps.token ?? ghToken)();
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
      });
    } catch (error) {
      if (generation !== this.generation) return;
      lastError = error instanceof Error ? error.message : String(error);
      console.error("relay stream failed:", error);
      this.reconnectAttempt++;
      this.reconnectAt = now() + Math.min(1_000 * 2 ** (this.reconnectAttempt - 1), STREAM_BACKOFF_MAX_MS);
    } finally {
      if (generation === this.generation) this.running = false;
    }
  }
}

export function createRelayConnection(deps: RelayClientDependencies = {}): { tick(url: string): Promise<void> } {
  return new RelayConnection(deps);
}

const connection = new RelayConnection();

export function startRelayClient(): void {
  setInterval(() => {
    connection.tick(relayConfig().url).catch((error) => console.error("relay tick failed:", error));
  }, POLL_MS);
}
