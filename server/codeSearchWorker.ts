import type { GrepMatch } from "./repoSearch.ts";
import { type CaseFold, caseSensitive, foldedLiteral, snippet, SNIPPET_CHARS } from "./codeSearchText.ts";

export type CodeSearchRequest =
  | { type: "build"; id: number; key: string; checkout: string; sha: string }
  | { type: "search"; id: number; key: string; query: string; fold: CaseFold; limit: number; cancel: Int32Array };

export type CodeSearchResponse =
  | { type: "built"; id: number; evicted: string[] }
  | { type: "build-failed"; id: number; error: string; evicted: string[] }
  | { type: "searched"; id: number; matches: GrepMatch[] | null }
  | { type: "evicted"; keys: string[] };

const CACHE_BYTES = 1024 * 1024 * 1024;
const BUILD_TIMEOUT_MS = 120_000;
const IDLE_EVICT_MS = 10 * 60_000;
const CAT_FILE_PROCESSES = 4;
// Non-ASCII characters whose simple case folding is an ASCII letter: KELVIN SIGN → k, LONG S → s.
const ASCII_FOLDING_CHARS = [Buffer.from("\u212A"), Buffer.from("\u017F")];

interface Snapshot {
  paths: string[];
  // byte offset of each file in `content`, plus a final end offset; every file is followed by "\n"
  starts: Float64Array;
  content: Buffer;
  lower: Buffer;
  // files containing ASCII_FOLDING_CHARS, which a Unicode-folding Git matches against "k" or "s"
  foldFiles: Int32Array;
  bytes: number;
  usedAt: number;
}

declare var self: Worker;

const cache = new Map<string, Snapshot>();
let cachedBytes = 0;
let sweepTimer: Timer | null = null;
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

function evict(key: string): void {
  const snap = cache.get(key);
  if (!snap) return;
  cache.delete(key);
  cachedBytes -= snap.bytes;
}

function touch(key: string, snap: Snapshot): void {
  cache.delete(key);
  cache.set(key, snap);
  snap.usedAt = Date.now();
  sweepTimer ??= setTimeout(sweep, IDLE_EVICT_MS);
}

function sweep(): void {
  sweepTimer = null;
  const cutoff = Date.now() - IDLE_EVICT_MS;
  const evicted: string[] = [];
  for (const [key, snap] of cache) {
    if (snap.usedAt > cutoff) continue;
    evict(key);
    evicted.push(key);
  }
  if (evicted.length) postMessage({ type: "evicted", keys: evicted } satisfies CodeSearchResponse);
  if (cache.size) sweepTimer = setTimeout(sweep, IDLE_EVICT_MS);
}

async function gitOutput(checkout: string, args: string[], signal: AbortSignal, okCodes = [0]): Promise<Uint8Array> {
  const proc = Bun.spawn(["git", "-C", checkout, ...args], { stdout: "pipe", stderr: "pipe", signal });
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).bytes(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    signal.throwIfAborted();
    if (!okCodes.includes(code)) throw new Error(`git ${args[0]} exited ${code}: ${stderr.trim()}`);
    return stdout;
  } finally {
    proc.kill();
    await proc.exited;
  }
}

async function readBlobs(checkout: string, oids: string[], sizes: number[], offsets: number[], content: Buffer, lower: Buffer, signal: AbortSignal): Promise<void> {
  if (!oids.length) return;
  const proc = Bun.spawn(["git", "-C", checkout, "cat-file", "--batch"], {
    stdin: new Blob([`${oids.join("\n")}\n`]),
    stdout: "pipe",
    stderr: "pipe",
    signal,
  });
  const stderr = new Response(proc.stderr).text();
  let file = 0;
  let header: Uint8Array[] = [];
  let remaining = -1;
  let at = 0;
  try {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      let i = 0;
      while (i < chunk.length) {
        if (file >= oids.length) throw new Error("git cat-file returned more objects than requested");
        if (remaining < 0) {
          const nl = chunk.indexOf(10, i);
          header.push(chunk.subarray(i, nl < 0 ? chunk.length : nl));
          if (nl < 0) break;
          i = nl + 1;
          const line = decoder.decode(Buffer.concat(header));
          header = [];
          if (line !== `${oids[file]} blob ${sizes[file]}`) throw new Error(`git cat-file returned "${line}" for ${oids[file]}`);
          remaining = sizes[file]!;
          at = offsets[file]!;
        }
        const n = Math.min(remaining, chunk.length - i);
        content.set(chunk.subarray(i, i + n), at);
        for (let k = at, end = at + n; k < end; k++) {
          const c = content[k]!;
          lower[k] = c >= 65 && c <= 90 ? c | 32 : c;
        }
        at += n;
        remaining -= n;
        i += n;
        if (remaining === 0 && i < chunk.length) {
          content[at] = 10;
          lower[at] = 10;
          i++;
          remaining = -1;
          file++;
        }
      }
    }
    const code = await proc.exited;
    signal.throwIfAborted();
    if (code !== 0) throw new Error(`git cat-file exited ${code}: ${(await stderr).trim()}`);
    if (file !== oids.length) throw new Error(`git cat-file returned ${file} of ${oids.length} objects`);
  } finally {
    proc.kill();
    await Promise.allSettled([proc.exited, stderr]);
  }
}

function fileOf(snap: Snapshot, pos: number): number {
  let lo = 0;
  let hi = snap.paths.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (snap.starts[mid]! <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

async function build(checkout: string, sha: string, evicted: string[], signal: AbortSignal): Promise<Snapshot> {
  const listed = decoder.decode(await gitOutput(checkout, ["grep", "-I", "-l", "-z", "-e", "", sha], signal, [0, 1]));
  const prefix = `${sha}:`;
  const paths = listed.split("\0").filter(Boolean).map((entry) => entry.slice(prefix.length));
  const blobs = new Map<string, { oid: string; size: number }>();
  for (const entry of decoder.decode(await gitOutput(checkout, ["ls-tree", "-r", "-l", "-z", sha], signal)).split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [, type, oid, size] = entry.slice(0, tab).split(/ +/);
    if (type === "blob") blobs.set(entry.slice(tab + 1), { oid: oid!, size: Number(size) });
  }
  const oids: string[] = [];
  const sizes: number[] = [];
  const starts = new Float64Array(paths.length + 1);
  let total = 0;
  for (const [i, path] of paths.entries()) {
    const blob = blobs.get(path);
    if (!blob) throw new Error(`git grep listed ${path}, which ls-tree does not have as a blob`);
    oids.push(blob.oid);
    sizes.push(blob.size);
    starts[i] = total;
    total += blob.size + 1;
  }
  starts[paths.length] = total;
  const bytes = total * 2;
  if (bytes > CACHE_BYTES) throw new Error(`text snapshot needs ${bytes} bytes, over the ${CACHE_BYTES}-byte code-search cache`);
  for (const key of cache.keys()) {
    if (cachedBytes + bytes <= CACHE_BYTES) break;
    evict(key);
    evicted.push(key);
  }
  if (evicted.length) Bun.gc(true);
  const content = Buffer.allocUnsafeSlow(total);
  const lower = Buffer.allocUnsafeSlow(total);
  const offsets = Array.from(starts.subarray(0, paths.length));
  const readers = await Promise.allSettled(Array.from({ length: CAT_FILE_PROCESSES }, (_, p) => {
    const from = Math.floor((p * paths.length) / CAT_FILE_PROCESSES);
    const to = Math.floor(((p + 1) * paths.length) / CAT_FILE_PROCESSES);
    return readBlobs(checkout, oids.slice(from, to), sizes.slice(from, to), offsets.slice(from, to), content, lower, signal);
  }));
  for (const result of readers) if (result.status === "rejected") throw result.reason;
  const snap: Snapshot = { paths, starts, content, lower, foldFiles: new Int32Array(), bytes, usedAt: Date.now() };
  const foldFiles = new Set<number>();
  for (const needle of ASCII_FOLDING_CHARS) {
    for (let pos = content.indexOf(needle); pos >= 0;) {
      const file = fileOf(snap, pos);
      foldFiles.add(file);
      pos = content.indexOf(needle, snap.starts[file + 1]!);
    }
  }
  snap.foldFiles = Int32Array.from([...foldFiles].sort((a, b) => a - b));
  return snap;
}

function byteLineSnippet(content: Buffer, lineStart: number, lineEnd: number, matchStart: number, matchEnd: number): string {
  const span = SNIPPET_CHARS * 4;
  let from = lineStart;
  let to = lineEnd;
  if (lineEnd - lineStart > span * 2) {
    from = Math.max(lineStart, matchStart - span);
    to = Math.min(lineEnd, matchEnd + span);
    while (from > lineStart && (content[from]! & 0xc0) === 0x80) from--;
    while (to < lineEnd && (content[to]! & 0xc0) === 0x80) to++;
  }
  const start = decoder.decode(content.subarray(from, matchStart)).length;
  const end = start + decoder.decode(content.subarray(matchStart, matchEnd)).length;
  return snippet(decoder.decode(content.subarray(from, to)), { start, end }, from > lineStart, to < lineEnd);
}

function scanDecodedFile(snap: Snapshot, file: number, re: RegExp, limit: number, out: GrepMatch[]): void {
  const text = decoder.decode(snap.content.subarray(snap.starts[file]!, snap.starts[file + 1]! - 1));
  let line = 1;
  let cursor = 0;
  re.lastIndex = 0;
  for (let match = re.exec(text); match && out.length < limit; match = re.exec(text)) {
    for (let nl = text.indexOf("\n", cursor); nl >= 0 && nl < match.index; nl = text.indexOf("\n", nl + 1)) {
      line++;
      cursor = nl + 1;
    }
    const end = text.indexOf("\n", match.index);
    const lineEnd = end < 0 ? text.length : end;
    const start = match.index - cursor;
    out.push({ path: snap.paths[file]!, line, text: snippet(text.slice(cursor, lineEnd), { start, end: start + match[0].length }) });
    if (end < 0) break;
    re.lastIndex = lineEnd + 1;
  }
}

function search(snap: Snapshot, query: string, fold: CaseFold, limit: number, cancel: Int32Array): GrepMatch[] | null {
  const sensitive = caseSensitive(query);
  const hay = sensitive ? snap.content : snap.lower;
  const needle = Buffer.from(query);
  if (!sensitive) for (let i = 0; i < needle.length; i++) needle[i] = needle[i]! >= 65 && needle[i]! <= 90 ? needle[i]! | 32 : needle[i]!;
  const decoded = !sensitive && fold === "unicode" && /[ks]/.test(query) ? snap.foldFiles : new Int32Array();
  const re = decoded.length ? foldedLiteral(query, fold) : null;
  const out: GrepMatch[] = [];
  let next = 0;
  let file = -1;
  let line = 0;
  let lineStart = 0;
  let pos = hay.indexOf(needle);
  while (out.length < limit) {
    if (Atomics.load(cancel, 0)) return null;
    const hitFile = pos < 0 ? snap.paths.length : fileOf(snap, pos);
    while (next < decoded.length && decoded[next]! < hitFile && out.length < limit) scanDecodedFile(snap, decoded[next++]!, re!, limit, out);
    if (pos < 0 || out.length >= limit) break;
    if (next < decoded.length && decoded[next] === hitFile) {
      scanDecodedFile(snap, decoded[next++]!, re!, limit, out);
      pos = hay.indexOf(needle, snap.starts[hitFile + 1]!);
      continue;
    }
    if (hitFile !== file) {
      file = hitFile;
      line = 1;
      lineStart = snap.starts[file]!;
    }
    for (let nl = snap.content.indexOf(10, lineStart); nl < pos; nl = snap.content.indexOf(10, nl + 1)) {
      line++;
      lineStart = nl + 1;
    }
    const lineEnd = snap.content.indexOf(10, pos);
    out.push({ path: snap.paths[file]!, line, text: byteLineSnippet(snap.content, lineStart, lineEnd, pos, pos + needle.length) });
    line++;
    lineStart = lineEnd + 1;
    pos = hay.indexOf(needle, lineStart);
  }
  return out;
}

self.onmessage = async (event: MessageEvent<CodeSearchRequest>) => {
  const request = event.data;
  if (request.type === "search") {
    const snap = cache.get(request.key);
    if (snap) touch(request.key, snap);
    const matches = snap ? search(snap, request.query, request.fold, request.limit, request.cancel) : null;
    postMessage({ type: "searched", id: request.id, matches } satisfies CodeSearchResponse);
    return;
  }
  const evicted: string[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`code search snapshot exceeded ${BUILD_TIMEOUT_MS}ms`)), BUILD_TIMEOUT_MS);
  try {
    evict(request.key);
    const snap = await build(request.checkout, request.sha, evicted, controller.signal);
    cache.set(request.key, snap);
    cachedBytes += snap.bytes;
    touch(request.key, snap);
    postMessage({ type: "built", id: request.id, evicted } satisfies CodeSearchResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    postMessage({ type: "build-failed", id: request.id, error: message, evicted } satisfies CodeSearchResponse);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
};
