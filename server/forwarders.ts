import type { Subprocess } from "bun";
import { listWebhookRegistrations } from "./db.ts";
import { cockpitWebhooksEnabled, settingsRepos } from "./settings.ts";

const WEBHOOK_EVENTS =
  "pull_request,pull_request_review,pull_request_review_comment,pull_request_review_thread,issue_comment,check_run,check_suite,status,push,workflow_run";
const FORWARDING_HOOK_URL = "https://webhook-forwarder.github.com/hook";

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

async function run(cmd: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    return { ok: code === 0, stdout, stderr };
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e) };
  }
}

// unclean `gh webhook forward` exits orphan their repo hook (next run 422s forever); deletion assumes cockpit is the repo's only forwarder
async function cleanupForwardingHooks(repo: string): Promise<boolean> {
  const res = await run(["gh", "api", `repos/${repo}/hooks`, "--jq", `.[] | select(.config.url == "${FORWARDING_HOOK_URL}") | .id`]);
  if (!res.ok) {
    console.error(`hook cleanup: list failed for ${repo}: ${res.stderr.trim()}`);
    return false;
  }
  let deleted = 0;
  let failed = 0;
  for (const id of res.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const del = await run(["gh", "api", "-X", "DELETE", `repos/${repo}/hooks/${id}`]);
    log(del.ok ? `hook cleanup: deleted stale forwarding hook ${id} on ${repo}` : `hook cleanup: delete ${id} on ${repo} failed: ${del.stderr.trim()}`);
    del.ok ? deleted++ : failed++;
  }
  return deleted > 0 && failed === 0;
}

function spawnForwarder(repo: string, port: number): void {
  const f = forwarders.get(repo);
  if (!f) return;
  const proc = Bun.spawn(
    ["gh", "webhook", "forward", "--repo", repo, "--events", WEBHOOK_EVENTS, "--url", `http://127.0.0.1:${port}/hook`],
    { stdout: "inherit", stderr: "pipe" },
  );
  f.proc = proc;
  let errTail = "";
  const stderrDrained = (async () => {
    const dec = new TextDecoder();
    for await (const chunk of proc.stderr) {
      const s = dec.decode(chunk);
      errTail = (errTail + s).slice(-4096);
      process.stderr.write(s);
    }
  })();
  const startedAt = Date.now();
  log(`forwarder up: ${repo} (pid ${proc.pid})`);
  proc.exited.then(async (code) => {
    console.error(`forwarder ${repo} exited (code=${code})`);
    if (f.stopped) return;
    const uptimeMs = Date.now() - startedAt;
    if (uptimeMs > 60_000) f.backoffMs = 5_000; // healthy run — reset backoff
    await stderrDrained.catch(() => {});
    if (/Hook already exists/i.test(errTail)) {
      if (await cleanupForwardingHooks(repo)) f.backoffMs = 5_000; // cleaned — retry promptly; else keep backing off
    } else if (/HTTP 40[34]|Resource not accessible/i.test(errTail)) {
      log(`forwarder ${repo}: cannot create webhook (no admin access) — poll-only for this repo`);
      f.stopped = true;
      return;
    }
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
