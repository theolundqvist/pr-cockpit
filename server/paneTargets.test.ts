import { describe, expect, test } from "bun:test";
import {
  candidatesForPr,
  createPaneTargetCollector,
  paneTargetKey,
  parsePaneHosts,
  validatePaneTargetsStatus,
  type PaneTarget,
} from "./paneTargets.ts";

function target(overrides: Partial<PaneTarget> = {}): PaneTarget {
  return {
    repo: "example-org/webapp",
    number: 6058,
    socketPath: "/private/tmp/tmux-501/default",
    sessionId: "$1",
    windowId: "@1",
    paneId: "%1",
    clientName: "/dev/ttys001",
    cwd: "/tmp/workspace/webapp",
    source: "worktree",
    observedAt: "2026-07-28T19:00:00.000Z",
    attached: true,
    active: false,
    windowActivityAt: 1,
    ...overrides,
  };
}

function status(...targets: PaneTarget[]): { paneTargetsVersion: 1; paneTargets: PaneTarget[] } {
  return { paneTargetsVersion: 1, paneTargets: targets };
}

describe("pane target collection", () => {
  test("accepts only safe host aliases and rejects malformed watcher status", () => {
    expect(parsePaneHosts("builder, bad host,;builder,worker-2,_invalid")).toEqual(["builder", "worker-2"]);
    expect(validatePaneTargetsStatus(status(target()))).toEqual(status(target()));
    expect(validatePaneTargetsStatus(status(target({ socketPath: "/tmp/tmux-501/../default" })))).toBeNull();
    expect(validatePaneTargetsStatus({ paneTargetsVersion: 2, paneTargets: [] })).toBeNull();
    expect(validatePaneTargetsStatus(status(target({ paneId: "pane-1" })))).toBeNull();
    const zeroIds = { sessionId: "$0", windowId: "@0", paneId: "%0" };
    expect(validatePaneTargetsStatus(status(target(zeroIds)))).toEqual(status(target(zeroIds)));
    expect(validatePaneTargetsStatus(status(target({ sessionId: "$01" })))).toBeNull();
  });

  test("aggregates local and remote targets while injecting configured host identity", async () => {
    const collector = createPaneTargetCollector({
      hosts: ["builder"],
      fetchStatus: async () => status(target({ paneId: "%1" })),
      runRemoteStatus: async () => ({ ...status(target({ paneId: "%2" })), host: "attacker" }),
    });

    const collection = await collector.collect();
    expect(collection.hosts).toEqual([
      { host: null, status: "current" },
      { host: "builder", status: "current" },
    ]);
    expect(collection.targets.map(({ host, paneId }) => ({ host, paneId }))).toEqual([
      { host: null, paneId: "%1" },
      { host: "builder", paneId: "%2" },
    ]);
  });

  test("keeps independent host results when another host times out or fails", async () => {
    const collector = createPaneTargetCollector({
      hosts: ["slow", "down", "ready"],
      timeoutMs: 10,
      fetchStatus: async () => status(target({ paneId: "%1" })),
      runRemoteStatus: async (host) => {
        if (host === "slow") return new Promise<never>(() => {});
        if (host === "down") throw new Error("connection refused");
        return status(target({ paneId: "%4" }));
      },
    });

    const collection = await collector.collect();
    expect(collection.hosts).toEqual([
      { host: null, status: "current" },
      { host: "slow", status: "unavailable" },
      { host: "down", status: "unavailable" },
      { host: "ready", status: "current" },
    ]);
    expect(collection.targets.map((value) => value.paneId)).toEqual(["%1", "%4"]);
  });

  test("retains a remote host's last good target after a transient refresh failure", async () => {
    let healthy = true;
    const collector = createPaneTargetCollector({
      hosts: ["builder"],
      cacheMs: 0,
      fetchStatus: async () => {
        throw new Error("local unavailable");
      },
      runRemoteStatus: async () => {
        if (!healthy) throw new Error("remote unavailable");
        return status(target({ paneId: "%2" }));
      },
    });

    expect((await collector.collect()).hosts).toEqual([
      { host: null, status: "unavailable" },
      { host: "builder", status: "current" },
    ]);
    healthy = false;
    const retained = await collector.collect();
    expect(retained.hosts).toEqual([
      { host: null, status: "unavailable" },
      { host: "builder", status: "cached" },
    ]);
    expect(retained.targets.map(({ host, paneId }) => ({ host, paneId }))).toEqual([{ host: "builder", paneId: "%2" }]);
  });

  test("keeps alternate sockets distinct even when tmux object IDs match", async () => {
    const collector = createPaneTargetCollector({
      fetchStatus: async () => status(
        target(),
        target({ socketPath: "/private/tmp/tmux-502/default" }),
      ),
    });

    const collection = await collector.collect();
    const candidates = candidatesForPr(collection, "example-org/webapp", 6058, collector.hosts);
    expect(candidates).toHaveLength(2);
    expect(paneTargetKey(candidates[0]!)).not.toBe(paneTargetKey(candidates[1]!));
  });

  test("deduplicates an in-flight collection and its short last-good cache", async () => {
    let calls = 0;
    let release: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const collector = createPaneTargetCollector({
      fetchStatus: async () => {
        calls += 1;
        await pending;
        return status(target());
      },
    });

    const first = collector.collect();
    const second = collector.collect();
    expect(second).toBe(first);
    release!();
    await first;
    await collector.collect();
    expect(calls).toBe(1);
  });

  test("orders candidates by explicitness, activity, attachment, observation, host, then pane identity", () => {
    const collection = {
      targets: [
        { ...target({ paneId: "%1", source: "worktree", active: true, windowActivityAt: 99 }), host: null },
        { ...target({ paneId: "%2", source: "explicit", active: false, windowActivityAt: 999 }), host: null },
        { ...target({ paneId: "%3", source: "explicit", active: true, windowActivityAt: 10 }), host: null },
        { ...target({ paneId: "%4", source: "explicit", active: true, windowActivityAt: 20, attached: false }), host: null },
        { ...target({ paneId: "%5", source: "explicit", active: true, windowActivityAt: 20, observedAt: "2026-07-28T20:00:00.000Z" }), host: "alpha" },
        { ...target({ paneId: "%6", source: "explicit", active: true, windowActivityAt: 20, observedAt: "2026-07-28T20:00:00.000Z" }), host: "beta" },
        { ...target({ paneId: "%7", source: "explicit", active: true, windowActivityAt: 20, observedAt: "2026-07-28T19:30:00.000Z" }), host: null },
      ],
    };

    expect(candidatesForPr(collection, "example-org/webapp", 6058, ["alpha", "beta"]).map((value) => value.paneId)).toEqual([
      "%5",
      "%6",
      "%7",
      "%4",
      "%3",
      "%2",
      "%1",
    ]);
  });
});
