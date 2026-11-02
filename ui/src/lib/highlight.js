import { bundledLanguages, bundledLanguagesInfo } from "shiki/langs";

const THEME_IMPORT = {
  "github-dark-default": () => import("shiki/themes/github-dark-default.mjs"),
  "github-light-default": () => import("shiki/themes/github-light-default.mjs"),
  "catppuccin-latte": () => import("shiki/themes/catppuccin-latte.mjs"),
  "catppuccin-mocha": () => import("shiki/themes/catppuccin-mocha.mjs"),
};

const languages = new Map(
  bundledLanguagesInfo.flatMap(({ id, aliases = [] }) =>
    [id, ...aliases].map((name) => [name.toLowerCase(), id]),
  ),
);

const LANG_BY_EXT = {
  mts: "typescript", cts: "typescript",
  mjs: "javascript", cjs: "javascript",
  jsx: "jsx",
  h: "cpp", hh: "cpp", hpp: "cpp", hxx: "cpp", "h++": "cpp",
  cc: "cpp", cxx: "cpp", "c++": "cpp", inl: "cpp", ipp: "cpp", tpp: "cpp",
  m: "objective-c", mm: "objective-cpp",
  cu: "cpp", cuh: "cpp",
  cs: "csharp", fs: "fsharp", fsi: "fsharp", fsx: "fsharp",
  kt: "kotlin", kts: "kotlin",
  rb: "ruby", rake: "ruby", gemspec: "ruby",
  pl: "perl", pm: "perl", raku: "perl6",
  ex: "elixir", exs: "elixir", erl: "erlang", hrl: "erlang",
  hs: "haskell", lhs: "haskell", ml: "ocaml", mli: "ocaml",
  cljc: "clojure", cljs: "clojure", edn: "clojure",
  sc: "scala", pyi: "python", pyw: "python",
  ps1: "powershell", psm1: "powershell", psd1: "powershell",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript", fish: "fish",
  htm: "html", xhtml: "html", svg: "xml", xsd: "xml", xsl: "xsl",
  vue: "vue", mdx: "mdx", markdown: "markdown",
  tf: "terraform", tfvars: "terraform", hcl: "hcl",
  proto: "proto", gql: "graphql", sass: "sass", scss: "scss",
  conf: "ini", cfg: "ini", properties: "ini", xcconfig: "ini",
  env: "dotenv", ipynb: "json",
  plist: "xml", storyboard: "xml", xib: "xml", entitlements: "xml",
  f: "fortran-fixed-form", for: "fortran-fixed-form", f90: "fortran-free-form",
  f95: "fortran-free-form", f03: "fortran-free-form", f08: "fortran-free-form",
  v: "verilog", sv: "system-verilog", svh: "system-verilog", vhd: "vhdl",
  s: "asm", asm: "asm", tex: "latex", sty: "latex", cls: "latex",
  mk: "make", cmake: "cmake",
};

const LANG_BY_NAME = {
  dockerfile: "docker", containerfile: "docker",
  makefile: "make", gnumakefile: "make", justfile: "just",
  gemfile: "ruby", rakefile: "ruby", brewfile: "ruby", podfile: "ruby",
  "cmakelists.txt": "cmake", "cargo.lock": "toml",
  ".bashrc": "shellscript", ".bash_profile": "shellscript", ".profile": "shellscript",
  ".zshrc": "shellscript", ".zprofile": "shellscript",
  ".gitconfig": "ini", ".npmrc": "ini", ".editorconfig": "ini",
};

export function langForName(name) {
  const normalized = name?.toLowerCase();
  const lang = LANG_BY_EXT[normalized] ?? normalized;
  return languages.get(lang) ?? null;
}

export function langForPath(path) {
  const filename = path.split(/[\\/]/).pop();
  const lower = filename.toLowerCase();
  const exact = LANG_BY_NAME[lower];
  if (exact) return langForName(exact);
  if (filename.endsWith(".C")) return "cpp";
  if (lower.startsWith(".env.") || lower === ".env") return "dotenv";
  if (lower.startsWith("dockerfile.") || lower.endsWith(".dockerfile")) return "docker";
  const parts = lower.split(".");
  for (let index = 1; index < parts.length; index++) {
    const lang = langForName(parts.slice(index).join("."));
    if (lang) return lang;
  }
  return langForName(lower);
}

let highlighterPromise;
const loadedThemes = new Set();

// Rebuilding an embedder after another grammar loads invalidates saved continuation stacks.
function stableGrammars(mod) {
  return mod.default.map((grammar) =>
    grammar.embeddedLangsLazy ? { ...grammar, embeddedLangsLazy: undefined } : grammar,
  );
}

export function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
        import("shiki/core"),
        import("shiki/engine/javascript"),
      ]);
      const langs = await Promise.all([
        "typescript", "tsx", "javascript", "svelte", "rust", "go", "python", "json",
        "yaml", "markdown", "css", "html", "sql", "shellscript", "diff",
      ].map(async (lang) => stableGrammars(await bundledLanguages[lang]())));
      const highlighter = await createHighlighterCore({
        themes: [],
        langs,
        engine: createJavaScriptRegexEngine(),
      });
      const loaded = Promise.resolve();
      for (const lang of highlighter.getLoadedLanguages()) languageLoads.set(lang, loaded);
      return highlighter;
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

const languageLoads = new Map();

async function ensureLanguage(highlighter, lang) {
  if (!bundledLanguages[lang]) return false;
  let pending = languageLoads.get(lang);
  if (!pending) {
    pending = bundledLanguages[lang]().then((mod) => highlighter.loadLanguage(stableGrammars(mod)));
    languageLoads.set(lang, pending);
  }
  await pending;
  return true;
}

const colourOnly = (tokens) => tokens.map(({ content, color }) => ({ content, color }));

// Grammar states stay in the realm that computed them; callers continue a run by state id.
const grammarStates = new Map();
const MAX_GRAMMAR_STATES = 2000;
const stateRealm = Math.random().toString(36).slice(2, 8);
let nextStateId = 0;

// `lines` without `after` are independent lines; with `after` they continue the run whose
// previous block ended in that state ("" starts a run), so comments and strings span lines.
export async function tokenizeRequest({ lang, theme, lines, code, after }) {
  const highlighter = await getHighlighter();
  const [, supported] = await Promise.all([
    ensureTheme(highlighter, theme),
    ensureLanguage(highlighter, lang),
  ]);
  if (!supported) return null;
  if (code !== undefined) return highlighter.codeToTokensBase(code, { lang, theme }).map(colourOnly);
  if (after === undefined) return lines.map((line) => colourOnly(highlighter.codeToTokensBase(line, { lang, theme })[0] ?? []));
  const tokens = highlighter.codeToTokensBase(lines.join("\n"), { lang, theme, grammarState: grammarStates.get(after) });
  const state = `${stateRealm}:${++nextStateId}`;
  grammarStates.set(state, highlighter.getLastGrammarState(tokens));
  if (grammarStates.size > MAX_GRAMMAR_STATES) grammarStates.delete(grammarStates.keys().next().value);
  return { tokens: tokens.map(colourOnly), state };
}
