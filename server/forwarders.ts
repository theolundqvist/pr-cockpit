import type { Subprocess } from "bun";
import { listWebhookRegistrations } from "./db.ts";
import { cockpitWebhooksEnabled, settingsRepos } from "./settings.ts";

const WEBHOOK_EVENTS =
  "pull_request,pull_request_review,pull_request_review_comment,pull_request_review_thread,issue_comment,check_run,check_suite,status,push,workflow_run,workflow_job";

interface Forwarder {
  repo: string;
  proc: Subprocess | null;
  backoffMs: number;
  restartTimer: Timer | null;
  stopped: boolean;
}
const forwarders = new Map<string, Forwarder>();
let boundPort: number | null = null;

function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), "[forwarders]", ...args);
}

function failureDetail(stderr: string): string {
  return stderr
    .trim()
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+\b/g, "[redacted]")
    .replace(/(authorization:\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/([?&](?:access_token|token|secret)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 1024);
}

function spawnForwarder(repo: string, port: number): void {
  const f = forwarders.get(repo);
  if (!f) return;
  const proc = Bun.spawn(
    ["gh", "webhook", "forward", "--repo", repo, "--events", WEBHOOK_EVENTS, "--url", `http://127.0.0.1:${port}/hook`],
    { stdout: "inherit", stderr: "pipe" },
  );
  f.proc = proc;
  let errHead = "";
  let errTail = "";
  const stderrDrained = (async () => {
    const dec = new TextDecoder();
    for await (const chunk of proc.stderr) {
      const s = dec.decode(chunk);
      errHead = (errHead + s).slice(0, 2048);
      errTail = (errTail + s).slice(-2048);
    }
  })();
  const startedAt = Date.now();
  log(`forwarder up: ${repo} (pid ${proc.pid})`);
  proc.exited.then(async (code) => {
    await stderrDrained.catch(() => {});
    if (f.stopped) return;
    if (f.proc === proc) f.proc = null;
    const uptimeMs = Date.now() - startedAt;
    if (uptimeMs > 60_000) f.backoffMs = 5_000;
    const errOutput = errHead === errTail ? errHead : `${errHead}\n...\n${errTail}`;
    const detail = failureDetail(errOutput);
    if (/Hook already exists/i.test(errOutput)) {
      log(`forwarder ${repo}: another GitHub CLI forwarder owns this repository — poll-only for this repo`);
      f.stopped = true;
      return;
    }
    if (/Resource not accessible by (?:personal access token|integration)|Must have admin rights to Repository/i.test(errOutput)) {
      log(`forwarder ${repo}: cannot create webhook (no admin access) — poll-only for this repo`);
      f.stopped = true;
      return;
    }
    console.error(`forwarder ${repo} exited (code=${code})${detail ? `: ${detail}` : ""}`);
    const delay = f.backoffMs;
    f.backoffMs = Math.min(f.backoffMs * 2, 60_000);
    f.restartTimer = setTimeout(() => {
      f.restartTimer = null;
      spawnForwarder(repo, port);
    }, delay);
  });
}

export function eligibleWebhookRepos(): Set<string> {
  const repos = new Set(settingsRepos());
  for (const registration of listWebhookRegistrations()) repos.add(registration.repo);
  return repos;
}

export function wantedRepos(): Set<string> {
  return cockpitWebhooksEnabled() ? eligibleWebhookRepos() : new Set();
}

export function startForwarders(port: number): void {
  boundPort = port;
  reconcileForwarders();
  setInterval(() => reconcileForwarders(), 30_000);
}

export function reconcileForwarders(): void {
  if (boundPort === null) return;
  const port = boundPort;
  const wanted = wantedRepos();
  for (const repo of wanted) {
    if (!forwarders.has(repo)) {
      forwarders.set(repo, { repo, proc: null, backoffMs: 5_000, restartTimer: null, stopped: false });
      spawnForwarder(repo, port);
    }
  }
  for (const [repo, f] of forwarders) {
    if (!wanted.has(repo)) {
      f.stopped = true;
      clearTimeout(f.restartTimer ?? undefined);
      f.proc?.kill();
      forwarders.delete(repo);
      log(`forwarder down: ${repo}`);
    }
  }
}

export interface ForwarderStatus {
  repo: string;
  pid: number | null;
  alive: boolean;
}

export function forwarderStatuses(): ForwarderStatus[] {
  return [...forwarders.values()].map((f) => ({
    repo: f.repo,
    pid: f.proc?.pid ?? null,
    alive: f.proc != null && f.proc.killed === false && f.proc.exitCode === null,
  }));
}
