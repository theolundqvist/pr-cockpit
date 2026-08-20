import type { WorktreeScanInput, WorktreeScanResult } from "./worktreeProbe.ts";
import type { WorktreeWorkerResponse } from "./worktreeWorker.ts";

const SCAN_TIMEOUT_MS = 15_000;

type WorkerFactory = () => Worker;

export function createWorktreeScanRunner(
  workerFactory: WorkerFactory = () => new Worker(new URL("./worktreeWorker.ts", import.meta.url).href),
  timeoutMs = SCAN_TIMEOUT_MS,
): (input: WorktreeScanInput) => Promise<WorktreeScanResult | null> {
  let worker: Worker | null = null;
  let sequence = 0;
  let inflight: Promise<WorktreeScanResult | null> | null = null;

  const terminate = (target: Worker) => {
    target.terminate();
    if (worker === target) worker = null;
  };

  return (input) => {
    if (inflight) return inflight;
    const id = ++sequence;
    const activeWorker = worker ?? (worker = workerFactory());
    inflight = new Promise<WorktreeScanResult | null>((resolve) => {
      const timer = setTimeout(() => {
        console.warn(`worktree scan exceeded ${timeoutMs}ms; restarting scanner`);
        terminate(activeWorker);
        resolve(null);
      }, timeoutMs);

      const finish = (result: WorktreeScanResult | null) => {
        clearTimeout(timer);
        resolve(result);
      };

      activeWorker.onmessage = (event: MessageEvent<WorktreeWorkerResponse>) => {
        if (event.data.id === id) finish(event.data.result);
      };
      activeWorker.onerror = (event) => {
        console.error("worktree scanner crashed", event.message);
        terminate(activeWorker);
        finish(null);
      };
      activeWorker.postMessage({ id, ...input });
    }).finally(() => {
      inflight = null;
    });
    return inflight;
  };
}
