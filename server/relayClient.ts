import { getPr } from "./db.ts";
import { ghToken } from "./github.ts";
import { pollOnce, refreshPr } from "./poller.ts";
import { relayConfig } from "./settings.ts";

const POLL_MS = 5_000;
const ERROR_BACKOFF_MS = 60_000;
const FULL_POLL_DEBOUNCE_MS = 30_000;

interface Marker {
  seq: number;
  ts: number;
  repo: string;
  number: number | null;
  event: string;
}

let cursor: number | null = null;
let backoffUntil = 0;
let lastFullPollAt = 0;
let lastOkAt: number | null = null;
let lastEventAt: number | null = null;
let lastError: string | null = null;

export function relayStatus(): { lastOkAt: number | null; lastEventAt: number | null; lastError: string | null } {
  return { lastOkAt, lastEventAt, lastError };
}

async function tick(): Promise<void> {
  const { url } = relayConfig();
  if (!url) return;
  if (Date.now() < backoffUntil) return;

  let latest: number;
  let events: Marker[];
  try {
    const token = await ghToken();
    const since = cursor === null ? "" : `?since=${cursor}`;
    const res = await fetch(`${url}/events${since}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) throw new Error(`relay responded ${res.status}`);
    ({ latest, events } = (await res.json()) as { latest: number; events: Marker[] });
  } catch (e) {
    backoffUntil = Date.now() + ERROR_BACKOFF_MS;
    lastError = e instanceof Error ? e.message : String(e);
    console.error("relay poll failed:", e);
    return;
  }
  lastOkAt = Date.now();
  lastError = null;

  const firstContact = cursor === null;
  cursor = latest;
  if (firstContact) return; // boot poll already covers anything older
  if (events.length > 0) lastEventAt = Date.now();

  let needFullPoll = false;
  const refreshed = new Set<string>();
  for (const m of events) {
    if (m.number === null) {
      needFullPoll = true;
      continue;
    }
    const key = `${m.repo}#${m.number}`;
    if (refreshed.has(key)) continue;
    refreshed.add(key);
    // only PRs already tracked: refreshPr upserts, and relay carries the whole team's events
    if (getPr(m.repo, m.number) === null) continue;
    refreshPr(m.repo, m.number).catch((err) => console.error(`relay-triggered refresh failed for ${key}:`, err));
  }

  if (needFullPoll && Date.now() - lastFullPollAt > FULL_POLL_DEBOUNCE_MS) {
    lastFullPollAt = Date.now();
    pollOnce().catch((err) => console.error("relay-triggered poll failed:", err));
  }
}

export function startRelayClient(): void {
  setInterval(() => {
    tick().catch((err) => console.error("relay tick failed:", err));
  }, POLL_MS);
}
