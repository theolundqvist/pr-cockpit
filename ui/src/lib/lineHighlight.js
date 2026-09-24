import { ensureTheme, getHighlighter } from "./highlight.js";

// Diff lines are tokenized in a worker: compiling a grammar's rules and matching long lines can
// hold the main thread for 100 ms at a time, which stalls the first Files paint and scrolling.
// Results are cached per theme, language, and text, so revisits and repeated lines are free.
const cache = new Map();
const pending = new Map();
let worker = null;
let workerFailed = false;
let nextId = 0;

function cacheKey(text, lang, theme) {
  return `${theme}\n${lang}\n${text}`;
}

export function cachedLineTokens(text, lang, theme) {
  return cache.get(cacheKey(text, lang, theme));
}

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

async function tokenizeOnMainThread(lines, lang, theme) {
  const highlighter = await getHighlighter();
  await ensureTheme(highlighter, theme);
  if (!highlighter.getLoadedLanguages().includes(lang)) return null;
  return lines.map((line) => highlighter.codeToTokensBase(line, { lang, theme })[0] ?? []);
}

function tokenizeInWorker(lines, lang, theme) {
  const target = highlightWorker();
  if (!target) return tokenizeOnMainThread(lines, lang, theme);
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    target.postMessage({ id, lang, theme, lines });
  }).catch(() => (workerFailed ? tokenizeOnMainThread(lines, lang, theme) : null));
}

// Resolves to one token list per line, or null when the language cannot be highlighted.
export async function tokenizeLines(lines, lang, theme) {
  const tokens = await tokenizeInWorker(lines, lang, theme);
  if (!tokens) return null;
  tokens.forEach((lineTokens, index) => cache.set(cacheKey(lines[index], lang, theme), lineTokens));
  return tokens;
}

// A cold worker needs ~250 ms to load grammars and another ~130 ms of JIT and rule compilation
// on its first real batch. Paying that while a PR's conversation is on screen lets the first
// Files view colour its lines almost at once.
const WARM_LINES = [
  'import { readFile } from "node:fs/promises";',
  "export async function load<T extends object>(path: string, fallback?: T): Promise<T | null> {",
  "  const items = (await list(path)).filter((item) => item.id !== undefined).map(({ name }) => name);",
  "  return items.length ? { ...fallback, value: `${items[0]}` } as T : null; // comment",
  "}",
  "export default class Store { private readonly cache = new Map<string, number[]>(); }",
];
const warmed = new Set();

export function warmLineHighlight(theme) {
  for (const lang of ["typescript", "tsx"]) {
    const key = `${theme}\n${lang}`;
    if (warmed.has(key)) continue;
    warmed.add(key);
    void tokenizeLines(WARM_LINES, lang, theme).catch(() => warmed.delete(key));
  }
}
