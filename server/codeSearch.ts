import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withMirrorOperation } from "./mirror.ts";
import { grep, MAX_MATCHES, type GrepMatch } from "./repoSearch.ts";
import { type CaseFold, firstMatch, snapshotCanAnswer, snippet } from "./codeSearchText.ts";
import type { CodeSearchRequest, CodeSearchResponse } from "./codeSearchWorker.ts";

let worker: Worker | null = null;
let sequence = 0;
const pending = new Map<number, (response: CodeSearchResponse | null) => void>();
const ready = new Set<string>();
const builds = new Map<string, Promise<void>>();
// A failed build is not retried by queries; the next Explorer file listing for that commit retries it.
const failures = new Map<string, string>();
let buildTail: Promise<unknown> = Promise.resolve();
let caseFold: CaseFold | "unsupported" | null = null;

// Probed rather than read from LANG: Git's folding depends on its PCRE2 build and locale setup.
function gitCaseFold(): CaseFold | "unsupported" {
  if (caseFold) return caseFold;
  const dir = mkdtempSync(join(tmpdir(), "cockpit-case-fold-"));
  try {
    writeFileSync(join(dir, "probe"), "\u212A\n");
    const proc = Bun.spawnSync(["git", "grep", "--no-index", "-q", "-P", "-i", "-e", "k", "--", "probe"], {
      cwd: dir,
      stdout: "ignore",
      stderr: "pipe",
    });
    if (proc.exitCode === 128) return (caseFold = "unsupported");
    if (proc.exitCode !== 0 && proc.exitCode !== 1) {
      throw new Error(`git grep case-fold probe exited ${proc.exitCode}: ${proc.stderr.toString().trim()}`);
    }
    caseFold = proc.exitCode === 0 ? "unicode" : "ascii";
    return caseFold;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function resetWorker(target: Worker): void {
  target.terminate();
  if (worker !== target) return;
  worker = null;
  ready.clear();
  for (const resolve of pending.values()) resolve(null);
  pending.clear();
}

function post(request: CodeSearchRequest): Promise<CodeSearchResponse | null> {
  if (!worker) {
    const created = new Worker(new URL("./codeSearchWorker.ts", import.meta.url).href);
    created.unref();
    created.onmessage = (event: MessageEvent<CodeSearchResponse>) => {
      const response = event.data;
      if (response.type === "evicted" || response.type === "built" || response.type === "build-failed") {
        for (const key of response.type === "evicted" ? response.keys : response.evicted) ready.delete(key);
      }
      if (response.type === "evicted") return;
      pending.get(response.id)?.(response);
      pending.delete(response.id);
    };
    created.onerror = (event) => {
      console.error("code search worker crashed:", event.message);
      resetWorker(created);
    };
    worker = created;
  }
  const { promise, resolve } = Promise.withResolvers<CodeSearchResponse | null>();
  pending.set(request.id, resolve);
  worker.postMessage(request);
  return promise;
}

function ensureSnapshot(checkout: string, repo: string, sha: string): Promise<void> {
  const key = `${repo}\n${sha}`;
  if (ready.has(key) || failures.has(key)) return Promise.resolve();
  const existing = builds.get(key);
  if (existing) return existing;
  const run = buildTail.then(() => withMirrorOperation(repo, async () => {
    const response = await post({ type: "build", id: ++sequence, key, checkout, sha });
    if (response?.type === "built") {
      ready.add(key);
      return;
    }
    throw new Error(response?.type === "build-failed" ? response.error : "code search worker stopped during the build");
  }));
  const tracked = run
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      failures.set(key, message);
      console.error(`code search snapshot failed for ${repo}@${sha}; queries use git grep:`, message);
    })
    .finally(() => builds.delete(key));
  buildTail = tracked;
  builds.set(key, tracked);
  return tracked;
}

export function prewarmCodeSearch(checkout: string, repo: string, sha: string): Promise<void> {
  failures.delete(`${repo}\n${sha}`);
  return ensureSnapshot(checkout, repo, sha);
}

async function searchSnapshot(key: string, query: string, fold: CaseFold, signal?: AbortSignal): Promise<GrepMatch[] | null> {
  if (signal?.aborted) return null;
  const id = ++sequence;
  const cancel = new Int32Array(new SharedArrayBuffer(4));
  const onAbort = () => {
    Atomics.store(cancel, 0, 1);
    pending.get(id)?.(null);
    pending.delete(id);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await post({ type: "search", id, key, query, fold, limit: MAX_MATCHES, cancel });
    return response?.type === "searched" ? response.matches : null;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function searchCodeSnippets(checkout: string, repo: string, sha: string, query: string, signal?: AbortSignal): Promise<GrepMatch[]> {
  const detected = gitCaseFold();
  // POSIX folding varies by libc and locale; Git must also retain the complete result line.
  if (detected === "unsupported" && !/[A-Z]/.test(query)) return grep(checkout, sha, query, signal);
  const fold = detected === "unsupported" ? "ascii" : detected;
  const key = `${repo}\n${sha}`;
  if (snapshotCanAnswer(query)) {
    if (ready.has(key)) {
      const matches = await searchSnapshot(key, query, fold, signal);
      if (matches) return matches;
      if (signal?.aborted) return [];
      ready.delete(key);
    }
    void ensureSnapshot(checkout, repo, sha);
  }
  const matches = await grep(checkout, sha, query, signal);
  return matches.map((match) => ({ ...match, text: snippet(match.text, firstMatch(match.text, query, fold)) }));
}
