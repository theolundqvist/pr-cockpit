import { posix } from "node:path";
import { astDefinitions } from "./astResolve.ts";
import { showFile } from "./gitShow.ts";
import { fetchMirror, mirrorDir } from "./mirror.ts";

const MAX_MATCHES = 2000;

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}
export interface DefinitionMatch extends GrepMatch {
  symbol: string;
}
export interface DefinitionResult {
  definition: DefinitionMatch | null;
  candidates: DefinitionMatch[];
}
export interface DefinitionQuery {
  repo: string;
  position: { line: number; character: number };
}


function shaPresent(checkout: string, sha: string): boolean {
  return Bun.spawnSync(["git", "-C", checkout, "cat-file", "-e", `${sha}^{commit}`], {
    stdout: "ignore",
    stderr: "ignore",
  }).success;
}

const inflightFetch = new Set<string>();
const attemptedFetch = new Set<string>();
const failedFetch = new Set<string>();

type RefFetch = (checkout: string, headRef: string, repo: string) => { exited: Promise<number> };

function fetchRef(_checkout: string, _headRef: string, repo: string): { exited: Promise<number> } {
  return { exited: fetchMirror(repo).then(() => 0, () => 1) };
}

// Cache a successful fetch that still misses the sha; retry failed fetches.
export function ensureShaLocal(
  checkout: string,
  repo: string,
  headRef: string,
  sha: string,
  fetch: RefFetch = fetchRef,
): "ready" | "fetching" | "fetch-failed" | "not-found" {
  if (shaPresent(checkout, sha)) return "ready";
  const key = `${repo}\n${sha}`;
  if (inflightFetch.has(key)) return "fetching";
  if (failedFetch.delete(key)) return "fetch-failed";
  if (attemptedFetch.has(key)) return "not-found";
  const proc = fetch(checkout, headRef, repo);
  inflightFetch.add(key);
  proc.exited
    .then((exitCode) => {
      if (exitCode !== 0) failedFetch.add(key);
      else if (!shaPresent(checkout, sha)) attemptedFetch.add(key);
    })
    .finally(() => inflightFetch.delete(key));
  return "fetching";
}

export type SearchCtx =
  | { status: "ok"; checkout: string }
  | { status: "fetching" }
  | { status: "fetch-failed" }
  | { status: "not-found" };

export function searchCtx(repo: string, headRef: string, sha: string): SearchCtx {
  const checkout = mirrorDir(repo);
  const local = ensureShaLocal(checkout, repo, headRef, sha);
  if (local !== "ready") return { status: local };
  return { status: "ok", checkout };
}

function parseGrepLine(line: string, prefix: string): GrepMatch | null {
  if (!line.startsWith(prefix)) return null;
  const rest = line.slice(prefix.length);
  const m = rest.match(/^(.*?):(\d+):(.*)$/);
  return m ? { path: m[1]!, line: Number(m[2]), text: m[3]! } : null;
}

export function parseGrepOutput(stdout: string, sha: string): GrepMatch[] {
  const prefix = `${sha}:`;
  const out: GrepMatch[] = [];
  for (const raw of stdout.split("\n")) {
    const m = parseGrepLine(raw, prefix);
    if (m) out.push(m);
    if (out.length >= MAX_MATCHES) break;
  }
  return out;
}

// Streamed + killed at the cap so a broad query can't block the single-threaded server; abortable on supersession.
export async function grep(checkout: string, sha: string, query: string, signal?: AbortSignal): Promise<GrepMatch[]> {
  const args = ["-C", checkout, "grep", "-n", "-I", "-F"];
  if (!/[A-Z]/.test(query)) args.push("-i");
  args.push("-e", query, sha);
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "ignore" });
  const onAbort = () => proc.kill();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) proc.kill();

  const prefix = `${sha}:`;
  const matches: GrepMatch[] = [];
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const m = parseGrepLine(buf.slice(0, nl), prefix);
        buf = buf.slice(nl + 1);
        if (m) matches.push(m);
        if (matches.length >= MAX_MATCHES) return matches;
      }
    }
    const tail = parseGrepLine(buf, prefix);
    if (tail && matches.length < MAX_MATCHES) matches.push(tail);
    return matches;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    proc.kill();
  }
}

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function definitionScore(match: GrepMatch, symbol: string): number {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`\\b(?:function|class|interface|type|enum|const|let|var)\\s+${escaped}\\b`).test(match.text)) return 100;
  if (new RegExp(`^\\s*(?:(?:public|private|protected|static|abstract|async|get|set|readonly)\\s+)*${escaped}\\s*(?:<[^>]*>)?\\([^)]*\\)\\s*(?:\\{|:)`).test(match.text)) return 90;
  if (new RegExp(`^\\s*${escaped}\\s*[:=]`).test(match.text)) return 75;
  return 0;
}

interface ImportedBinding {
  imported: string;
  module: string;
}

function importedBindings(source: string, symbol: string): ImportedBinding[] {
  const bindings: ImportedBinding[] = [];
  const named = /\b(?:import|export)\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(named)) {
    const names = match[1]!.split(",").map((part) => part.trim().replace(/^type\s+/, ""));
    for (const name of names) {
      const [imported, local = imported] = name.split(/\s+as\s+/);
      if (local === symbol && imported) bindings.push({ imported, module: match[2]! });
    }
  }
  const defaultImport = /\bimport\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,\s*\{[\s\S]*?\})?\s+from\s+["']([^"']+)["']/g;
  for (const match of source.matchAll(defaultImport)) {
    if (match[1] === symbol) bindings.push({ imported: symbol, module: match[2]! });
  }
  return bindings;
}

function resolvesModule(path: string, fromPath: string, module: string): boolean {
  if (!module.startsWith(".")) return false;
  const stem = posix.normalize(posix.join(posix.dirname(fromPath), module));
  return path === stem || path.replace(/\.(?:[cm]?[jt]sx?|svelte)$/, "") === stem || path.replace(/\/index\.(?:[cm]?[jt]sx?|svelte)$/, "") === stem;
}
function declarationCandidates(matches: GrepMatch[], symbol: string): DefinitionMatch[] {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ranked = matches
    .filter((match) => new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`).test(match.text))
    .map((match) => ({ match, score: definitionScore(match, symbol) }))
    .filter(({ score }) => score > 0);
  const topScore = Math.max(0, ...ranked.map(({ score }) => score));
  return ranked.filter(({ score }) => score === topScore).map(({ match }) => ({ ...match, symbol }));
}


export async function findDefinition(
  checkout: string,
  sha: string,
  symbol: string,
  fromPath: string,
  signal?: AbortSignal,
  query?: DefinitionQuery,
): Promise<DefinitionResult> {
  if (!IDENTIFIER_RE.test(symbol)) return { definition: null, candidates: [] };

  // Checker-backed resolution when the click carries an exact source position.
  // Runs in the AST worker; grep ranking below stays as the fallback for
  // unresolvable clicks (svelte templates, unresolved packages, non-JS/TS files).
  if (query) {
    const defs = await astDefinitions(
      {
        checkout,
        repo: query.repo,
        sha,
        fromPath,
        symbol,
        line: query.position.line,
        character: query.position.character,
      },
      signal,
    );
    if (defs?.length === 1) return { definition: defs[0]!, candidates: defs };
    if (defs && defs.length > 1) return { definition: null, candidates: defs };
  }

  const source = showFile(checkout, sha, fromPath) ?? "";
  const candidates = declarationCandidates(await grep(checkout, sha, symbol, signal), symbol);

  const sameFile = candidates.filter((match) => match.path === fromPath);
  if (sameFile.length === 1) return { definition: sameFile[0]!, candidates };
  if (sameFile.length > 1) return { definition: null, candidates: sameFile };

  for (const binding of importedBindings(source, symbol)) {
    const importedCandidates = declarationCandidates(await grep(checkout, sha, binding.imported, signal), binding.imported)
      .filter((match) => resolvesModule(match.path, fromPath, binding.module));
    if (importedCandidates.length === 1) return { definition: importedCandidates[0]!, candidates: importedCandidates };
    if (importedCandidates.length > 1) return { definition: null, candidates: importedCandidates };
  }

  if (candidates.length === 1) return { definition: candidates[0]!, candidates };
  return { definition: null, candidates };
}

export interface SymbolMentionCommit {
  sha: string;
  subject: string;
  author: string;
  date: string;
  prNumber: number | null;
}

async function gitText(checkout: string, args: string[], signal: AbortSignal | undefined, operation: string): Promise<string> {
  const proc = Bun.spawn(["git", "-C", checkout, ...args], { stdout: "pipe", stderr: "pipe" });
  const onAbort = () => proc.kill();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) proc.kill();
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(`${operation} failed: ${stderr.trim() || `exit ${exitCode}`}`);
    return stdout;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function symbolMentionHistory(
  checkout: string,
  sha: string,
  path: string,
  symbol: string,
  signal?: AbortSignal,
): Promise<SymbolMentionCommit[]> {
  if (!IDENTIFIER_RE.test(symbol)) return [];
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = `(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`;
  const stdout = await gitText(
    checkout,
    ["log", "-n", "30", "--format=%H%x1f%an%x1f%aI%x1f%s%x1e", `-G${pattern}`, sha, "--", path],
    signal,
    "git log",
  );
  return stdout
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [commitSha = "", author = "unknown", date = "", subject = ""] = record.split("\x1f");
      const prMatch = subject.match(/\(#(\d+)\)\s*$/);
      return { sha: commitSha, subject, author, date, prNumber: prMatch ? Number(prMatch[1]) : null };
    });
}

export async function localFileHistoryPatch(
  checkout: string,
  sha: string,
  path: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const patch = await gitText(
    checkout,
    ["diff-tree", "--root", "--first-parent", "-p", "--find-renames", "--no-commit-id", "-r", sha, "--", path],
    signal,
    "git diff-tree",
  );
  return patch || null;
}
