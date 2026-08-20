import { describe, expect, test } from "bun:test";
import type { DaemonStatus, Registration } from "./daemon.ts";
import { changedSignals, collectSignals } from "./daemonWatch.ts";

function status(registration: Registration): DaemonStatus {
  return {
    repos: [registration.repo],
    worktrees: [],
    registrations: { "@1": registration },
  };
}

describe("daemon watch signals", () => {
  test("refreshes the first observation and every base or mergeability change", () => {
    const seen = new Map<string, string>();
    const initial = status({
      repo: "example-org/webapp",
      number: 6058,
      state: "open.passing.none",
      baseRefOid: "base-a",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
    });

    expect(changedSignals(collectSignals(initial), seen)).toHaveLength(1);
    expect(changedSignals(collectSignals(initial), seen)).toEqual([]);

    const advanced = status({
      ...initial.registrations!["@1"]!,
      baseRefOid: "base-b",
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
    });
    expect(changedSignals(collectSignals(advanced), seen)).toHaveLength(1);

    const conflicting = status({
      ...advanced.registrations!["@1"]!,
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
    });
    expect(changedSignals(collectSignals(conflicting), seen)).toHaveLength(1);
  });

  test("deduplicates worktree and registration signals for the same PR", () => {
    const signal = collectSignals({
      repos: ["example-org/webapp"],
      worktrees: [
        {
          path: "/tmp/zod4",
          repo: "example-org/webapp",
          branch: "zod4",
          windowId: "@14",
          state: "open.passing.none",
          prNumber: 6058,
          prUrl: "https://github.com/example-org/webapp/pull/6058",
          baseRefOid: "worktree-base",
        },
      ],
      registrations: {
        "@14": {
          repo: "example-org/webapp",
          number: 6058,
          state: "open.passing.none",
          baseRefOid: "registration-base",
        },
      },
    });

    expect(signal).toHaveLength(1);
    expect(signal[0]?.state).toContain("registration-base");
  });
});
