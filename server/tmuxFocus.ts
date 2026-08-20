import { candidatesForPr, createPaneTargetCollector } from "./paneTargets.ts";
import type { HostedPaneTarget, PaneTargetCollection } from "./paneTargets.ts";

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

type FocusError = "target-not-found" | "snapshot-unavailable" | "host-unreachable" | "server-missing" | "stale-pane" | "no-client" | "launch-failed" | "invalid-request";

export interface TmuxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type TmuxCommandRunner = (argv: string[]) => Promise<TmuxCommandResult>;

export interface PaneTargetCollector {
  collect(): Promise<PaneTargetCollection>;
  hosts: readonly string[];
}

export interface TmuxFocusDependencies {
  collector: PaneTargetCollector;
  runCommand: TmuxCommandRunner;
}

export type TmuxFocusResult =
  | { status: 200; body: { ok: true; host: string | null } }
  | { status: 400; body: { error: "invalid-request" } }
  | { status: 404; body: { error: "target-not-found" } }
  | { status: 409; body: { error: "stale-pane" | "no-client" } }
  | { status: 500; body: { error: "launch-failed" } }
  | { status: 503; body: { error: "snapshot-unavailable" | "host-unreachable" | "server-missing" } };
export type TmuxFocusHandler = (req: Request) => Promise<Response>;



async function defaultRunCommand(argv: string[]): Promise<TmuxCommandResult> {
  const process = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function runCommand(runner: TmuxCommandRunner, argv: string[]): Promise<TmuxCommandResult> {
  try {
    return await runner(argv);
  } catch {
    return { exitCode: -1, stdout: "", stderr: "" };
  }
}


function commandForTarget(target: HostedPaneTarget, args: readonly string[]): string[] {
  const tmux = ["tmux", "-S", target.socketPath, ...args];
  if (target.host === null) return tmux;
  return [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    target.host,
    tmux.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" "),
  ];
}

function isHostUnreachable(target: HostedPaneTarget, result: TmuxCommandResult): boolean {
  return target.host !== null && (result.exitCode === 255 || result.exitCode < 0);
}

function error(status: 400, code: "invalid-request"): TmuxFocusResult;
function error(status: 404, code: "target-not-found"): TmuxFocusResult;
function error(status: 409, code: "stale-pane" | "no-client"): TmuxFocusResult;
function error(status: 500, code: "launch-failed"): TmuxFocusResult;
function error(status: 503, code: "snapshot-unavailable" | "host-unreachable" | "server-missing"): TmuxFocusResult;
function error(status: TmuxFocusResult["status"], code: FocusError): TmuxFocusResult {
  return { status, body: { error: code } } as TmuxFocusResult;
}

async function focusSucceeded(deps: TmuxFocusDependencies): Promise<"focused" | "launch-failed"> {
  const activated = await runCommand(deps.runCommand, ["open", "-a", "Alacritty"]);
  return activated.exitCode === 0 ? "focused" : "launch-failed";
}

async function focusCandidate(deps: TmuxFocusDependencies, target: HostedPaneTarget): Promise<"focused" | FocusError> {
  const verified = await runCommand(deps.runCommand, commandForTarget(target, ["display-message", "-p", "-t", target.paneId, "#{pane_id}"]));
  if (isHostUnreachable(target, verified)) return "host-unreachable";
  if (verified.exitCode !== 0 || verified.stdout.trim() !== target.paneId) {
    if (verified.exitCode < 0 || /no server running|failed to connect|error connecting/i.test(verified.stderr)) return "server-missing";
    return "stale-pane";
  }

  for (const args of [["select-window", "-t", target.windowId], ["select-pane", "-t", target.paneId]]) {
    const selected = await runCommand(deps.runCommand, commandForTarget(target, args));
    if (isHostUnreachable(target, selected)) return "host-unreachable";
    if (selected.exitCode !== 0) return "server-missing";
  }

  if (target.clientName !== null && target.attached) {
    const switched = await runCommand(deps.runCommand, commandForTarget(target, ["switch-client", "-c", target.clientName, "-t", target.paneId]));
    if (isHostUnreachable(target, switched)) return "host-unreachable";
    return switched.exitCode === 0 ? focusSucceeded(deps) : "no-client";
  }

  if (target.host !== null) return "no-client";

  const attach = ["-e", "tmux", "-S", target.socketPath, "attach-session", "-t", target.sessionId];
  const launched = await runCommand(deps.runCommand, ["alacritty", "msg", "create-window", ...attach]);
  if (launched.exitCode === 0) return focusSucceeded(deps);
  const opened = await runCommand(deps.runCommand, ["alacritty", ...attach]);
  return opened.exitCode === 0 ? focusSucceeded(deps) : "launch-failed";
}

export async function focusPrPane(deps: TmuxFocusDependencies, repo: unknown, number: unknown): Promise<TmuxFocusResult> {
  if (
    typeof repo !== "string" ||
    !REPO_RE.test(repo) ||
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number <= 0
  ) return error(400, "invalid-request");

  let collection: PaneTargetCollection;
  try {
    collection = await deps.collector.collect();
  } catch {
    return error(503, "snapshot-unavailable");
  }

  const candidates = candidatesForPr(collection, repo, number, deps.collector.hosts);
  if (!candidates.length) {
    return collection.hosts.every((host) => host.status === "unavailable")
      ? error(503, "snapshot-unavailable")
      : error(404, "target-not-found");
  }

  let lastHardError: Exclude<FocusError, "stale-pane"> | null = null;
  for (const candidate of candidates) {
    const outcome = await focusCandidate(deps, candidate);
    if (outcome === "focused") return { status: 200, body: { ok: true, host: candidate.host } };
    if (outcome !== "stale-pane") lastHardError = outcome;
  }

  if (lastHardError === null) return error(409, "stale-pane");
  return lastHardError === "host-unreachable" || lastHardError === "server-missing"
    ? error(503, lastHardError)
    : lastHardError === "no-client"
      ? error(409, lastHardError)
      : error(500, "launch-failed");
}

export function createTmuxFocusHandler(overrides: Partial<TmuxFocusDependencies> = {}): TmuxFocusHandler {
  const collector = overrides.collector ?? createPaneTargetCollector();
  const deps: TmuxFocusDependencies = { collector, runCommand: overrides.runCommand ?? defaultRunCommand };
  return async (req) => {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid-request" }), { status: 400, headers: { "content-type": "application/json" } });
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 2 ||
      !("repo" in body) ||
      !("number" in body)
    ) {
      return new Response(JSON.stringify({ error: "invalid-request" }), { status: 400, headers: { "content-type": "application/json" } });
    }
    const result = await focusPrPane(deps, body.repo, body.number);
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
  };
}
