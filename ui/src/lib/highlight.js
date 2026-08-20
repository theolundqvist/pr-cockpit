const THEME_IMPORT = {
  "github-dark-default": () => import("shiki/themes/github-dark-default.mjs"),
  "github-light-default": () => import("shiki/themes/github-light-default.mjs"),
  "catppuccin-latte": () => import("shiki/themes/catppuccin-latte.mjs"),
  "catppuccin-mocha": () => import("shiki/themes/catppuccin-mocha.mjs"),
};

const LANG_BY_EXT = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  svelte: "svelte",
  rs: "rust",
  go: "go",
  py: "python",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  css: "css",
  html: "html",
  sql: "sql",
  sh: "bash",
  bash: "bash",
};

export function langForPath(path) {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext ? (LANG_BY_EXT[ext] ?? null) : null;
}

let highlighterPromise;
const loadedThemes = new Set();

export function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
      ]);
      const langs = await Promise.all([
        import("shiki/langs/typescript.mjs"),
        import("shiki/langs/tsx.mjs"),
        import("shiki/langs/javascript.mjs"),
        import("shiki/langs/svelte.mjs"),
        import("shiki/langs/rust.mjs"),
        import("shiki/langs/go.mjs"),
        import("shiki/langs/python.mjs"),
        import("shiki/langs/json.mjs"),
        import("shiki/langs/yaml.mjs"),
        import("shiki/langs/markdown.mjs"),
        import("shiki/langs/css.mjs"),
        import("shiki/langs/html.mjs"),
        import("shiki/langs/sql.mjs"),
        import("shiki/langs/bash.mjs"),
        import("shiki/langs/diff.mjs"),
      ]);
      return createHighlighterCore({
        themes: [],
        langs,
        engine: createJavaScriptRegexEngine(),
      });
    })();
  }
  return highlighterPromise;
}

export async function ensureTheme(highlighter, themeName) {
  if (loadedThemes.has(themeName)) return;
  const mod = await THEME_IMPORT[themeName]();
  await highlighter.loadTheme(mod.default ?? mod);
  loadedThemes.add(themeName);
}

const tokenCache = new Map();

export function tokenizeLine(highlighter, code, lang, themeName) {
  const key = themeName + "\n" + lang + "\n" + code;
  let tokens = tokenCache.get(key);
  if (tokens === undefined) {
    tokens = highlighter.codeToTokensBase(code, { lang, theme: themeName })[0] ?? [];
    tokenCache.set(key, tokens);
  }
  return tokens;
}

export function tokenizeCode(highlighter, code, lang, themeName) {
  return highlighter.codeToTokensBase(code, { lang, theme: themeName });
}
