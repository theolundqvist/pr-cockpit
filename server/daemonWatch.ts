import { fetchDaemonStatus, type DaemonStatus } from "./daemon.ts";
import { backgroundPollAllowed, refreshPr } from "./poller.ts";
import { prKey, prKeyOf } from "./prKey.ts";
import { refreshPrFromEvent } from "./eventRefresh.ts";

const POLL_INTERVAL_MS = 10_000;
export interface Signal {
  repo: string;
  number: number;
  state: string;
}

const lastSeenState = new Map<string, string>();

function signalState(
  value: Pick<
    DaemonStatus["worktrees"][number],
    "state" | "lastWebhookAt" | "headRefOid" | "baseRefOid" | "mergeable" | "mergeStateStatus"
  >,
): string {
  return [
    value.state,
    value.lastWebhookAt ?? "",
    value.headRefOid ?? "",
    value.baseRefOid ?? "",
    value.mergeable ?? "",
    value.mergeStateStatus ?? "",
  ].join("|");
}

export function collectSignals(status: DaemonStatus): Signal[] {
  const byKey = new Map<string, Signal>();
  for (const wt of status.worktrees) {
    if (wt.prNumber !== null) {
      byKey.set(prKeyOf(wt.repo, wt.prNumber), {
        repo: wt.repo,
        number: wt.prNumber,
        state: signalState(wt),
      });
    }
  }
  for (const reg of Object.values(status.registrations ?? {})) {
    byKey.set(prKey(reg), { repo: reg.repo, number: reg.number, state: signalState(reg) });
  }
  return [...byKey.values()];
}

export function changedSignals(
  signals: Signal[],
  seen: Map<string, string> = lastSeenState,
): Signal[] {
  const changed: Signal[] = [];
  for (const signal of signals) {
    const key = prKeyOf(signal.repo, signal.number);
    const previous = seen.get(key);
    seen.set(key, signal.state);
    if (previous !== signal.state) changed.push(signal);
  }
  return changed;
}

async function tick(): Promise<void> {
  const status = await fetchDaemonStatus();
  if (!status) return;

  for (const { repo, number } of changedSignals(collectSignals(status))) {
    const key = prKeyOf(repo, number);
    void refreshPrFromEvent(repo, number, async (targetRepo, targetNumber) => {
      if (await backgroundPollAllowed()) await refreshPr(targetRepo, targetNumber, "daemon");
    }).catch((err) => console.error(`daemon-triggered refresh failed for ${key}:`, err));
  }
}

export function startDaemonWatch(): void {
  setInterval(() => {
    tick().catch((err) => console.error("daemon watch tick failed:", err));
  }, POLL_INTERVAL_MS);
}
