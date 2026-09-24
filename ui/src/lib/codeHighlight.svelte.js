import { tokenizeCodeBlock } from "./offThreadHighlight.js";

// Rendered markdown reads revision, so blocks that were pending re-render once their tokens land.
export const codeHl = $state({ revision: 0 });

// values must stay a subset of getHighlighter's loaded langs — an unloaded grammar throws and kills the whole render
const FENCE_LANG = {
  ts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
  js: "javascript",
  javascript: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  svelte: "svelte",
  rust: "rust",
  rs: "rust",
  go: "go",
  py: "python",
  python: "python",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  markdown: "markdown",
  css: "css",
  html: "html",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  shell: "bash",
  diff: "diff",
};

// Fenced code is tokenized off the main thread. Until a block's tokens arrive it renders as
// plain text, and the caller must not cache that rendering.
export const HIGHLIGHT_PENDING = Symbol("highlight pending");

const BLOCK_CACHE_MAX = 500;
const blocks = new Map();
let revisionQueued = false;

function publishBlock(key, tokens) {
  blocks.set(key, tokens);
  if (blocks.size > BLOCK_CACHE_MAX) blocks.delete(blocks.keys().next().value);
  if (revisionQueued) return;
  revisionQueued = true;
  // Blocks from one conversation land together; re-render markdown once for the batch.
  requestAnimationFrame(() => {
    revisionQueued = false;
    codeHl.revision++;
  });
}

// Returns tokens per line, null when the block cannot be highlighted, or HIGHLIGHT_PENDING.
export function highlightFencedCode(code, fenceLang, themeName) {
  const lang = FENCE_LANG[fenceLang?.toLowerCase()];
  if (!lang) return null;
  const key = `${themeName}\n${lang}\n${code}`;
  if (blocks.has(key)) return blocks.get(key);
  blocks.set(key, HIGHLIGHT_PENDING);
  tokenizeCodeBlock(code, lang, themeName).then(
    (tokens) => publishBlock(key, tokens),
    () => publishBlock(key, null),
  );
  return HIGHLIGHT_PENDING;
}
