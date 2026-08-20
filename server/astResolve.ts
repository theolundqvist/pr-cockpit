import type { AstDefinition } from "./tsService.ts";
import type { AstRequest } from "./tsWorker.ts";

// Client for the AST worker. Keeps the HTTP loop responsive: all sync
// LanguageService and git-show work happens in the worker. Requests run one
// at a time (client-side FIFO); the timeout arms only at dispatch, so queue
// wait can never expire a lookup. A wedged request kills and respawns the
// worker, resolving that lookup null (grep fallback) while queued jobs retry
// on the fresh worker.
const WORKER_TIMEOUT_MS = 20_000;

interface Job {
  req: Omit<AstRequest, "id">;
  resolve: (defs: AstDefinition[] | null) => void;
}

interface Inflight {
  id: number;
  resolve: (defs: AstDefinition[] | null) => void;
  timer: Timer;
}

let worker: Worker | null = null;
let seq = 0;
let inflight: Inflight | null = null;
const queue: Job[] = [];

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./tsWorker.ts", import.meta.url).href);
  worker.onmessage = (event: MessageEvent<{ id: number; defs: AstDefinition[] | null }>) => {
    if (inflight?.id !== event.data.id) return;
    clearTimeout(inflight.timer);
    inflight.resolve(event.data.defs);
    inflight = null;
    dispatch();
  };
  worker.onerror = (err) => {
    console.error("ast worker crashed:", err.message);
    resetWorker();
  };
  return worker;
}

function resetWorker(): void {
  worker?.terminate();
  worker = null;
  if (inflight) {
    clearTimeout(inflight.timer);
    inflight.resolve(null);
    inflight = null;
  }
  dispatch();
}

function dispatch(): void {
  if (inflight) return;
  const job = queue.shift();
  if (!job) return;
  const id = ++seq;
  const timer = setTimeout(() => {
    console.error("ast worker timed out; respawning");
    resetWorker();
  }, WORKER_TIMEOUT_MS);
  inflight = { id, resolve: job.resolve, timer };
  ensureWorker().postMessage({ id, ...job.req });
}

// Aborting drops the job if it is still queued; a dispatched job runs to
// completion (the worker is sync) bounded by the dispatch timeout.
export function astDefinitions(req: Omit<AstRequest, "id">, signal?: AbortSignal): Promise<AstDefinition[] | null> {
  if (signal?.aborted) return Promise.resolve(null);
  const { promise, resolve } = Promise.withResolvers<AstDefinition[] | null>();
  const job: Job = { req, resolve };
  queue.push(job);
  signal?.addEventListener(
    "abort",
    () => {
      const i = queue.indexOf(job);
      if (i < 0) return;
      queue.splice(i, 1);
      resolve(null);
    },
    { once: true },
  );
  dispatch();
  return promise;
}
