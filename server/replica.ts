import type { Subprocess } from "bun";
import { readInboxReplica, replaceInboxReplica, type InboxReplica } from "./db.ts";
import { setLastPollAt, lastPollAt } from "./poller.ts";
import { invalidateInbox, publishPollCompleted } from "./rendererInvalidation.ts";
import { readSettings } from "./settings.ts";

const SOURCE_PORT = Number(Bun.env.COCKPIT_PROXY_PORT ?? 4820);
const TUNNEL_PORT = Number(Bun.env.COCKPIT_REPLICA_LOCAL_PORT ?? 48203);
const SYNC_INTERVAL_MS = 5_000;
const LOCAL_API_PATHS = new Set([
  "/api/inbox",
  "/api/closed",
  "/api/pr-details",
  "/api/pr-index",
  "/api/repo-users",
  "/api/search-prs",
  "/api/settings",
  "/api/version",
  "/api/update",
  "/api/shutdown",
  "/api/image",
  "/api/replica/inbox",
  "/api/replica/status",
]);

type ReplicaSnapshot = {
  revision: string;
  lastPollAt: string | null;
  viewerLogin: string | null;
  tables: InboxReplica;
};

type ReplicaState = {
  host: string;
  connected: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  viewerLogin: string | null;
  revision: string | null;
};

let state: ReplicaState = {
  host: "",
  connected: false,
  lastSyncedAt: null,
  lastError: null,
  viewerLogin: null,
  revision: null,
};

function isReplicaRows(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every((row) => row !== null && typeof row === "object" && !Array.isArray(row));
}

function parseReplicaSnapshot(value: unknown): ReplicaSnapshot {
  if (!value || typeof value !== "object" || !("revision" in value) || typeof value.revision !== "string"
    || !("lastPollAt" in value) || !(value.lastPollAt === null || typeof value.lastPollAt === "string")
    || !("viewerLogin" in value) || !(value.viewerLogin === null || typeof value.viewerLogin === "string")
    || !("tables" in value) || !value.tables || typeof value.tables !== "object") {
    throw new Error("Replica source returned an invalid snapshot");
  }
  const tables = value.tables;
  if (!("prs" in tables) || !isReplicaRows(tables.prs)
    || !("archived_prs" in tables) || !isReplicaRows(tables.archived_prs)
    || !("pr_index" in tables) || !isReplicaRows(tables.pr_index)
    || !("pr_rank" in tables) || !isReplicaRows(tables.pr_rank)
    || !("repo_users" in tables) || !isReplicaRows(tables.repo_users)
    || !("review_rescores" in tables) || !isReplicaRows(tables.review_rescores)
    || !("review_scores" in tables) || !isReplicaRows(tables.review_scores)
    || !("fixer_agents" in tables) || !isReplicaRows(tables.fixer_agents)) {
    throw new Error("Replica source returned invalid table rows");
  }
  return {
    revision: value.revision,
    lastPollAt: value.lastPollAt,
    viewerLogin: value.viewerLogin,
    tables: {
      prs: tables.prs,
      archived_prs: tables.archived_prs,
      pr_index: tables.pr_index,
      pr_rank: tables.pr_rank,
      repo_users: tables.repo_users,
      review_rescores: tables.review_rescores,
      review_scores: tables.review_scores,
      fixer_agents: tables.fixer_agents,
    },
  };
}
let tunnel: Subprocess<"ignore", "ignore", "pipe"> | null = null;
let syncTimer: Timer | null = null;
let syncInFlight: Promise<void> | null = null;

export function replicaSshHost(): string {
  return readSettings().replica_ssh_host;
}

export function replicaEnabled(): boolean {
  return replicaSshHost().length > 0;
}

export function replicaViewerLogin(): string | null {
  return state.viewerLogin;
}

export function replicaStatus(): ReplicaState {
  return { ...state };
}

function sourceUrl(path: string): string {
  return `http://127.0.0.1:${TUNNEL_PORT}${path}`;
}

async function waitForTunnel(process: Subprocess<"ignore", "ignore", "pipe">): Promise<void> {
  let failure: unknown = null;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (process.exitCode !== null) throw new Error(`SSH tunnel exited with code ${process.exitCode}`);
    try {
      const response = await fetch(sourceUrl("/healthz"), { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      failure = new Error(`source health returned ${response.status}`);
    } catch (error) {
      failure = error;
    }
    await Bun.sleep(100);
  }
  throw failure instanceof Error ? failure : new Error("SSH tunnel did not become ready");
}

async function ensureTunnel(): Promise<void> {
  if (tunnel?.exitCode === null) return;
  const host = replicaSshHost();
  if (!host) throw new Error("No replica SSH host configured");
  const process = Bun.spawn([
    "ssh",
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-N",
    "-L", `127.0.0.1:${TUNNEL_PORT}:127.0.0.1:${SOURCE_PORT}`,
    host,
  ], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  tunnel = process;
  process.exited.then(async (code) => {
    const error = (await new Response(process.stderr).text()).trim();
    if (tunnel !== process) return;
    state = { ...state, connected: false, lastError: error || `SSH tunnel exited with code ${code}` };
    tunnel = null;
  });
  await waitForTunnel(process);
  state = { ...state, host, connected: true, lastError: null };
}

async function syncReplica(): Promise<void> {
  if (syncInFlight) return syncInFlight;
  syncInFlight = (async () => {
    try {
      await ensureTunnel();
      const headers = new Headers();
      if (state.revision) headers.set("if-none-match", state.revision);
      const response = await fetch(sourceUrl("/api/replica/inbox"), {
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 304) {
        const sourceLastPollAt = response.headers.get("x-pr-cockpit-last-poll-at") || null;
        setLastPollAt(sourceLastPollAt);
        state = { ...state, connected: true, lastSyncedAt: new Date().toISOString(), lastError: null };
        if (sourceLastPollAt) publishPollCompleted(sourceLastPollAt);
        return;
      }
      if (!response.ok) throw new Error(`replica source returned ${response.status}: ${await response.text()}`);
      const snapshot = parseReplicaSnapshot(await response.json());
      replaceInboxReplica(snapshot.tables);
      setLastPollAt(snapshot.lastPollAt);
      state = {
        host: replicaSshHost(),
        connected: true,
        lastSyncedAt: new Date().toISOString(),
        lastError: null,
        viewerLogin: snapshot.viewerLogin,
        revision: snapshot.revision,
      };
      invalidateInbox();
      if (snapshot.lastPollAt) publishPollCompleted(snapshot.lastPollAt);
    } catch (error) {
      state = { ...state, connected: false, lastError: error instanceof Error ? error.message : String(error) };
      console.error(`replica sync failed for ${replicaSshHost()}:`, error);
    }
  })().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

export async function startReplicaSync(): Promise<() => void> {
  const host = replicaSshHost();
  state = { ...state, host };
  await syncReplica();
  syncTimer = setInterval(() => void syncReplica(), SYNC_INTERVAL_MS);
  return () => {
    if (syncTimer) clearInterval(syncTimer);
    syncTimer = null;
    tunnel?.kill();
    tunnel = null;
  };
}

function snapshotViewerLogin(tables: InboxReplica): string | null {
  for (const row of tables.prs) {
    try {
      const parsed: unknown = JSON.parse(String(row.detail_json));
      if (parsed && typeof parsed === "object" && "viewerLogin" in parsed) {
        const login = parsed.viewerLogin;
        if (typeof login === "string" && login) return login;
      }
    } catch {}
  }
  return null;
}

export function replicaSnapshotResponse(request: Request): Response {
  if (replicaEnabled()) return Response.json({ error: "A replica cannot serve as a replica source" }, { status: 409 });
  const tables = readInboxReplica();
  const viewerLogin = snapshotViewerLogin(tables);
  const revision = `"${Bun.hash(JSON.stringify({ tables, viewerLogin })).toString(16)}"`;
  const headers = {
    etag: revision,
    "x-pr-cockpit-last-poll-at": lastPollAt ?? "",
  };
  if (request.headers.get("if-none-match") === revision) return new Response(null, { status: 304, headers });
  const snapshot: ReplicaSnapshot = {
    revision,
    lastPollAt,
    viewerLogin,
    tables,
  };
  const body = new Blob([JSON.stringify(snapshot)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(body, {
    headers: {
      ...headers,
      "content-encoding": "gzip",
    },
  });
}

export function isLocalReplicaRequest(request: Request, url: URL): boolean {
  if (LOCAL_API_PATHS.has(url.pathname)) return true;
  if (url.pathname.startsWith("/api/tmux/")) return true;
  if (url.pathname === "/api/switch-branch") return true;
  return request.method === "OPTIONS";
}

export async function proxyReplicaRequest(request: Request, url: URL): Promise<Response | null> {
  if (!replicaEnabled() || !url.pathname.startsWith("/api/") || isLocalReplicaRequest(request, url)) return null;
  try {
    await ensureTunnel();
    const headers = new Headers(request.headers);
    headers.delete("host");
    const upstream = await fetch(sourceUrl(`${url.pathname}${url.search}`), {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
    const response = new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    if (upstream.ok && request.method !== "GET" && request.method !== "HEAD") void syncReplica();
    return response;
  } catch (error) {
    state = { ...state, connected: false, lastError: error instanceof Error ? error.message : String(error) };
    return Response.json({ error: `PR Cockpit source ${replicaSshHost()} is unavailable` }, { status: 503 });
  }
}
