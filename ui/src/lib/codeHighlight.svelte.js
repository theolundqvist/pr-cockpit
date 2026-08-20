import { getHighlighter, ensureTheme, tokenizeCode } from "./highlight.js";

export const codeHl = $state({ ready: false });

let highlighter = null;

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

export function initCodeHighlight() {
  getHighlighter()
    .then(async (h) => {
      await Promise.all([
        ensureTheme(h, "github-dark-default"),
        ensureTheme(h, "github-light-default"),
        ensureTheme(h, "catppuccin-latte"),
        ensureTheme(h, "catppuccin-mocha"),
      ]);
      highlighter = h;
      codeHl.ready = true;
    })
    .catch(() => {});
}

export function highlightFencedCode(code, fenceLang, themeName) {
  if (!codeHl.ready || !highlighter) return null;
  const lang = FENCE_LANG[fenceLang?.toLowerCase()];
  if (!lang) return null;
  return tokenizeCode(highlighter, code, lang, themeName);
}
