import { ensureTheme, getHighlighter } from "./highlight.js";

// Syntax highlighting runs in a worker: compiling a grammar's rules or matching one long line
// can hold the main thread for 100 ms, which stalled the first Files paint, diff scrolling,
// and opening PRs whose conversation has fenced code. If the worker cannot start, the same
// work falls back to the main thread.
const pending = new Map();
let worker = null;
let workerFailed = false;
let nextId = 0;

function failWorker(error) {
  workerFailed = true;
  worker?.terminate();
  worker = null;
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

function highlightWorker() {
  if (worker || workerFailed) return worker;
  try {
    worker = new Worker(new URL("./highlight.worker.js", import.meta.url), { type: "module" });
  } catch (error) {
    failWorker(error);
    return null;
  }
  worker.onmessage = ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.tokens);
  };
  worker.onerror = (event) => failWorker(event.error ?? new Error(event.message || "highlight worker failed"));
  return worker;
}

async function tokenizeOnMainThread({ lang, theme, lines, code }) {
  const highlighter = await getHighlighter();
  await ensureTheme(highlighter, theme);
  if (!highlighter.getLoadedLanguages().includes(lang)) return null;
  if (code !== undefined) return highlighter.codeToTokensBase(code, { lang, theme });
  return lines.map((line) => highlighter.codeToTokensBase(line, { lang, theme })[0] ?? []);
}

// Resolves to one token list per line, or null when the language cannot be highlighted.
function tokenize(request) {
  const target = highlightWorker();
  if (!target) return tokenizeOnMainThread(request);
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    target.postMessage({ id, ...request });
  }).catch(() => (workerFailed ? tokenizeOnMainThread(request) : null));
}

// Diff lines are tokenized one by one and cached per theme, language, and text, so revisits
// and repeated lines are free.
const lineCache = new Map();

function lineKey(text, lang, theme) {
  return `${theme}\n${lang}\n${text}`;
}

export function cachedLineTokens(text, lang, theme) {
  return lineCache.get(lineKey(text, lang, theme));
}

export async function tokenizeLines(lines, lang, theme) {
  const tokens = await tokenize({ lang, theme, lines });
  if (!tokens) return null;
  tokens.forEach((lineTokens, index) => lineCache.set(lineKey(lines[index], lang, theme), lineTokens));
  return tokens;
}

// A code block keeps grammar state across its lines, so it is tokenized as one text.
export function tokenizeCodeBlock(code, lang, theme) {
  return tokenize({ lang, theme, code });
}

// A cold worker needs ~250 ms to load grammars and another ~130 ms of JIT and rule compilation
// on its first real batch. Paying that ahead of time lets the first code block or Files view
// colour its lines almost at once.
const WARM_LINES = [
  'import { readFile } from "node:fs/promises";',
  "export async function load<T extends object>(path: string, fallback?: T): Promise<T | null> {",
  "  const items = (await list(path)).filter((item) => item.id !== undefined).map(({ name }) => name);",
  "  return items.length ? { ...fallback, value: `${items[0]}` } as T : null; // comment",
  "}",
  "export default class Store { private readonly cache = new Map<string, number[]>(); }",
];
const warmed = new Set();

export function warmHighlightWorker(theme) {
  for (const lang of ["typescript", "tsx"]) {
    const key = `${theme}\n${lang}`;
    if (warmed.has(key)) continue;
    warmed.add(key);
    void tokenizeLines(WARM_LINES, lang, theme);
  }
}
