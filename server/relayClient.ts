import { getPr, getSetting, setSetting } from "./db.ts";
import { ghToken } from "./github.ts";
import { pollOnce, refreshPr } from "./poller.ts";
import { relayConfig } from "./settings.ts";
import { ingestActionsState, type CompactJob, type CompactRun } from "./runLogs.ts";

const POLL_MS = 5_000;
const ERROR_BACKOFF_MS = 60_000;
const FULL_POLL_DEBOUNCE_MS = 30_000;

export interface RelayMarker {
  seq: number;
  ts: number;
  repo: string;
  number: number | null;
  event: string;
  run?: CompactRun;
  job?: CompactJob;
}

const RELAY_CURSOR_KEY = "relay_cursor";
let backoffUntil = 0;
let lastFullPollAt = 0;
let lastOkAt: number | null = null;
let lastEventAt: number | null = null;
let lastError: string | null = null;

export function relayStatus(): { lastOkAt: number | null; lastEventAt: number | null; lastError: string | null } {
  return { lastOkAt, lastEventAt, lastError };
}

interface RelayPollDependencies {
  fetcher?: typeof fetch;
  ingest?: typeof ingestActionsState;
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

export async function pollRelayOnce(
  url: string,
  token: string,
  deps: RelayPollDependencies = {},
): Promise<number> {
  const fetcher = deps.fetcher ?? fetch;
  const ingest = deps.ingest ?? ingestActionsState;
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

  let needFullPoll = false;
  const refreshed = new Set<string>();
  for (const marker of events) {
    if (marker.run || marker.job) {
      await ingest(marker.repo, { run: marker.run, job: marker.job });
    } else if (marker.number === null) {
      needFullPoll = true;
    } else {
      const key = `${marker.repo}#${marker.number}`;
      if (!refreshed.has(key)) {
        refreshed.add(key);
        if (getPr(marker.repo, marker.number) !== null) {
          refreshPr(marker.repo, marker.number).catch((error) =>
            console.error(`relay-triggered refresh failed for ${key}:`, error)
          );
        }
      }
    }
    saveCursor(marker.seq);
  }

  if (needFullPoll && Date.now() - lastFullPollAt > FULL_POLL_DEBOUNCE_MS) {
    lastFullPollAt = Date.now();
    pollOnce().catch((error) => console.error("relay-triggered poll failed:", error));
  }
  saveCursor(latest);
  return events.length;
}

async function tick(): Promise<void> {
  const { url } = relayConfig();
  if (!url) return;
  if (Date.now() < backoffUntil) return;

  try {
    const token = await ghToken();
    const eventCount = await pollRelayOnce(url, token);
    lastOkAt = Date.now();
    lastError = null;
    if (eventCount > 0) lastEventAt = Date.now();
  } catch (error) {
    backoffUntil = Date.now() + ERROR_BACKOFF_MS;
    lastError = error instanceof Error ? error.message : String(error);
    console.error("relay poll failed:", error);
  }
}

export function startRelayClient(): void {
  setInterval(() => {
    tick().catch((err) => console.error("relay tick failed:", err));
  }, POLL_MS);
}
