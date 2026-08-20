import { describe, expect, test } from "bun:test";
import { createTmuxFocusHandler, focusPrPane } from "./tmuxFocus.ts";
import type { HostedPaneTarget, PaneTargetCollection } from "./paneTargets.ts";
import type { TmuxCommandResult, TmuxFocusDependencies } from "./tmuxFocus.ts";

const socketPath = "/private/tmp/tmux-501/default";
const paneId = "%31";

function pane(overrides: Partial<HostedPaneTarget> = {}): HostedPaneTarget {
  return {
    repo: "example-org/webapp",
    number: 6058,
    socketPath,
    sessionId: "$1",
    windowId: "@12",
    paneId,
    clientName: "/dev/ttys003",
    cwd: "/tmp/workspace/webapp",
    source: "explicit",
    observedAt: "2026-07-28T20:00:00.000Z",
    attached: true,
    active: true,
    windowActivityAt: 10,
    host: null,
    ...overrides,
  };
}

function collection(targets: HostedPaneTarget[], statuses: PaneTargetCollection["hosts"] = [{ host: null, status: "current" }]): PaneTargetCollection {
  return { targets, hosts: statuses };
}

function success(argv: readonly string[]): TmuxCommandResult {
  return {
    exitCode: 0,
    stdout: argv.includes("display-message") ? `${argv[argv.length - 2]}\n` : "",
    stderr: "",
  };
}

function dependencies(targets: HostedPaneTarget[], runCommand: TmuxFocusDependencies["runCommand"], statuses?: PaneTargetCollection["hosts"]): TmuxFocusDependencies {
  return {
    collector: { collect: async () => collection(targets, statuses), hosts: ["builder"] },
    runCommand,
  };
}

describe("focusPrPane", () => {
  test("returns launch-failed when terminal activation fails after a local pane switch", async () => {
    const commands: string[][] = [];
    const result = await focusPrPane(dependencies([pane()], async (argv) => {
      commands.push([...argv]);
      return argv[0] === "open" ? { exitCode: 1, stdout: "", stderr: "not focused" } : success(argv);
    }), "example-org/webapp", 6058);

    expect(result).toEqual({ status: 500, body: { error: "launch-failed" } });
    expect(commands).toEqual([
      ["tmux", "-S", socketPath, "display-message", "-p", "-t", paneId, "#{pane_id}"],
      ["tmux", "-S", socketPath, "select-window", "-t", "@12"],
      ["tmux", "-S", socketPath, "select-pane", "-t", paneId],
      ["tmux", "-S", socketPath, "switch-client", "-c", "/dev/ttys003", "-t", paneId],
      ["open", "-a", "Alacritty"],
    ]);
  });

  test("quotes remote tmux arguments so SSH preserves the tmux format", async () => {
    const remote = pane({ host: "builder" });
    const commands: string[][] = [];
    const result = await focusPrPane(dependencies([remote], async (argv) => {
      commands.push([...argv]);
      if (argv[0] === "open") return { exitCode: 0, stdout: "", stderr: "" };
      const shell = Bun.spawnSync(["sh", "-c", `set -- ${argv[6]!}; printf '%s\n' "$@"`], { stdout: "pipe" });
      const expanded = shell.stdout.toString().trim().split("\n").filter(Boolean);
      if (expanded.includes("display-message")) {
        expect(expanded).toContain("#{pane_id}");
        return { exitCode: 0, stdout: `${expanded[expanded.indexOf("-t") + 1]}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }), "example-org/webapp", 6058);

    expect(result).toEqual({ status: 200, body: { ok: true, host: "builder" } });
    for (const command of commands.filter((command) => command[0] === "ssh")) {
      expect(command.slice(0, 6)).toEqual(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "builder"]);
      expect(command).toHaveLength(7);
    }
    expect(commands[0]![6]).toContain("'#{pane_id}'");
    expect(commands.at(-1)).toEqual(["open", "-a", "Alacritty"]);
  });

  test("returns launch-failed when terminal activation fails after a remote pane switch", async () => {
    const result = await focusPrPane(dependencies([pane({ host: "builder" })], async (argv) => {
      if (argv[0] === "open") return { exitCode: 1, stdout: "", stderr: "not focused" };
      return { exitCode: 0, stdout: argv[6]?.includes("display-message") ? `${paneId}\n` : "", stderr: "" };
    }), "example-org/webapp", 6058);

    expect(result).toEqual({ status: 500, body: { error: "launch-failed" } });
  });

  test("falls through from a stale candidate to the next ranked candidate", async () => {
    const stale = pane({ paneId: "%1", windowId: "@1", windowActivityAt: 20 });
    const current = pane({ paneId: "%2", windowId: "@2", windowActivityAt: 10 });
    const result = await focusPrPane(dependencies([current, stale], async (argv) => {
      if (argv.includes("display-message") && argv.includes("%1")) return { exitCode: 0, stdout: "%999\n", stderr: "" };
      return success(argv);
    }), "example-org/webapp", 6058);

    expect(result).toEqual({ status: 200, body: { ok: true, host: null } });
  });

  test("reports target-not-found when a current snapshot has no matching pane", async () => {
    const result = await focusPrPane(dependencies([], async () => ({ exitCode: 0, stdout: "", stderr: "" })), "example-org/webapp", 6058);
    expect(result).toEqual({ status: 404, body: { error: "target-not-found" } });
  });

  test("reports snapshot-unavailable when no host supplied a snapshot", async () => {
    const result = await focusPrPane(
      dependencies([], async () => ({ exitCode: 0, stdout: "", stderr: "" }), [{ host: null, status: "unavailable" }]),
      "example-org/webapp",
      6058,
    );
    expect(result).toEqual({ status: 503, body: { error: "snapshot-unavailable" } });
  });

  test("falls through from an unreachable remote host to a live local pane", async () => {
    const remote = pane({ host: "builder", windowActivityAt: 20 });
    const local = pane({ paneId: "%32", windowId: "@13", source: "worktree", windowActivityAt: 10 });
    const result = await focusPrPane(dependencies([local, remote], async (argv) => {
      if (argv[0] === "ssh") return { exitCode: 255, stdout: "", stderr: "connection refused" };
      return success(argv);
    }), "example-org/webapp", 6058);

    expect(result).toEqual({ status: 200, body: { ok: true, host: null } });
  });

  test("reports host-unreachable when SSH cannot connect", async () => {
    const result = await focusPrPane(dependencies([pane({ host: "builder" })], async () => ({ exitCode: 255, stdout: "", stderr: "connection refused" })), "example-org/webapp", 6058);
    expect(result).toEqual({ status: 503, body: { error: "host-unreachable" } });
  });

  test("reports no-client for an unattached remote pane", async () => {
    const result = await focusPrPane(dependencies([pane({ host: "builder", attached: false, clientName: null })], async (argv) => ({ exitCode: 0, stdout: argv.at(-1)?.includes("display-message") ? `${paneId}\n` : "", stderr: "" })), "example-org/webapp", 6058);
    expect(result).toEqual({ status: 409, body: { error: "no-client" } });
  });

  test("attaches a detached local Alacritty window to the recorded tmux session", async () => {
    const detached = pane({ socketPath: "/private/tmp/tmux-501/alternate", sessionId: "$9", attached: false, clientName: null });
    const commands: string[][] = [];
    const result = await focusPrPane(dependencies([detached], async (argv) => {
      commands.push([...argv]);
      if (argv[0] === "tmux") return success(argv);
      return { exitCode: argv[1] === "msg" ? 1 : 0, stdout: "", stderr: "" };
    }), "example-org/webapp", 6058);

    expect(result).toEqual({ status: 200, body: { ok: true, host: null } });
    expect(commands.slice(-3, -1)).toEqual([
      ["alacritty", "msg", "create-window", "-e", "tmux", "-S", "/private/tmp/tmux-501/alternate", "attach-session", "-t", "$9"],
      ["alacritty", "-e", "tmux", "-S", "/private/tmp/tmux-501/alternate", "attach-session", "-t", "$9"],
    ]);
    expect(commands.at(-1)).toEqual(["open", "-a", "Alacritty"]);
  });

  test("reports launch-failed after both local Alacritty attempts fail", async () => {
    const commands: string[][] = [];
    const result = await focusPrPane(dependencies([pane({ attached: false, clientName: null })], async (argv) => {
      commands.push([...argv]);
      return argv[0] === "tmux" ? success(argv) : { exitCode: 1, stdout: "", stderr: "not available" };
    }), "example-org/webapp", 6058);

    expect(result).toEqual({ status: 500, body: { error: "launch-failed" } });
    expect(commands.slice(-2)).toEqual([
      ["alacritty", "msg", "create-window", "-e", "tmux", "-S", socketPath, "attach-session", "-t", "$1"],
      ["alacritty", "-e", "tmux", "-S", socketPath, "attach-session", "-t", "$1"],
    ]);
  });

  test("reports server-missing without command output", async () => {
    const result = await focusPrPane(dependencies([pane()], async () => ({ exitCode: 1, stdout: "", stderr: "no server running on socket" })), "example-org/webapp", 6058);
    expect(result).toEqual({ status: 503, body: { error: "server-missing" } });
  });

  test("rejects extra browser fields and keeps every response secret", async () => {
    const handler = createTmuxFocusHandler(dependencies([pane()], async () => ({ exitCode: 1, stdout: "", stderr: "no server running on socket" })));
    const invalid = await handler(new Request("http://cockpit/api/tmux/focus", {
      method: "POST",
      body: JSON.stringify({ repo: "example-org/webapp", number: 6058, socketPath }),
    }));
    const hidden = await handler(new Request("http://cockpit/api/tmux/focus", {
      method: "POST",
      body: JSON.stringify({ repo: "example-org/webapp", number: 6058 }),
    }));
    const bodies = [await invalid.text(), await hidden.text()];

    expect(invalid.status).toBe(400);
    expect(hidden.status).toBe(503);
    for (const body of bodies) {
      expect(body).not.toContain(socketPath);
      expect(body).not.toContain(paneId);
      expect(body).not.toContain("/dev/ttys003");
    }
  });
});
