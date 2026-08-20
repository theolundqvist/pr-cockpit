import { scanWorktrees, type WorktreeScanInput, type WorktreeScanResult } from "./worktreeProbe.ts";

export interface WorktreeWorkerRequest extends WorktreeScanInput {
  id: number;
}

export interface WorktreeWorkerResponse {
  id: number;
  result: WorktreeScanResult | null;
}

declare const self: Worker;

self.onmessage = async (event: MessageEvent<WorktreeWorkerRequest>) => {
  const { id, ...input } = event.data;
  try {
    self.postMessage({ id, result: await scanWorktrees(input) } satisfies WorktreeWorkerResponse);
  } catch (error) {
    console.error("worktree scan failed", error);
    self.postMessage({ id, result: null } satisfies WorktreeWorkerResponse);
  }
};
