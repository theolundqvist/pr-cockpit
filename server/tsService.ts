import ts from "typescript";

// Language service over a virtual FS pinned to a git sha. Content is immutable
// per key, so snapshots never version and caches never invalidate.
//
// Everything here is synchronous (the LS host API is sync, and readFile shells
// out per file), so this module must only run inside the AST worker - never on
// the HTTP event loop. See tsWorker.ts / astResolve.ts.
export interface ShaSource {
  key: string;
  paths: () => string[];
  readFile: (path: string) => string | null;
}

export interface AstDefinition {
  path: string;
  line: number;
  text: string;
  symbol: string;
}

interface PathsRule {
  baseDir: string;
  patterns: [pattern: string, targets: string[]][];
}

interface ServiceEntry {
  service: ts.LanguageService;
  roots: Set<string>;
  content: Map<string, string | null>;
  pathSet: Set<string>;
}

const SERVICE_CAP = 2;
const services = new Map<string, ServiceEntry>();

const SCRIPT_RE = /<script[^>]*>([\s\S]*?)<\/script>/g;

// Blank out markup so the virtual module keeps the .svelte file's exact line
// and column numbering in both directions. Template expressions are out of
// scope; clicks there fail the token guard and fall back to grep.
export function svelteScriptOnly(source: string): string {
  let out = "";
  let cursor = 0;
  for (const match of source.matchAll(SCRIPT_RE)) {
    const bodyStart = match.index + match[0].indexOf(">") + 1;
    out += blankPreservingLines(source.slice(cursor, bodyStart));
    out += match[1];
    cursor = bodyStart + match[1]!.length;
  }
  out += blankPreservingLines(source.slice(cursor));
  return out;
}

function blankPreservingLines(chunk: string): string {
  return chunk.replace(/[^\n]/g, " ");
}

const VIRTUAL_SVELTE_SUFFIX = ".svelte.ts";

function toVirtual(path: string): string {
  return path.endsWith(".svelte") ? `/${path}.ts` : `/${path}`;
}

function fromVirtual(fileName: string): string {
  const bare = fileName.replace(/^\//, "");
  return bare.endsWith(VIRTUAL_SVELTE_SUFFIX) ? bare.slice(0, -3) : bare;
}

const FILE_EXTS = [".ts", ".tsx", ".d.ts", ".svelte", ".js", ".jsx", ".mjs", ".cjs"];

const COMPILER_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: false,
  noLib: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
};

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function extensionOf(path: string): ts.Extension {
  if (path.endsWith(".d.ts")) return ts.Extension.Dts;
  if (path.endsWith(".tsx")) return ts.Extension.Tsx;
  if (path.endsWith(".jsx")) return ts.Extension.Jsx;
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) return ts.Extension.Js;
  return ts.Extension.Ts;
}

function parseTsconfigPaths(
  configPath: string,
  readFile: (path: string) => string | null,
  visited: Set<string>,
): PathsRule | null {
  if (visited.has(configPath)) return null;
  visited.add(configPath);
  const raw = readFile(configPath);
  if (raw === null) return null;
  const { config } = ts.parseConfigFileTextToJson(configPath, raw);
  if (!config) return null;
  const options = config.compilerOptions ?? {};
  const configDir = dirname(configPath);
  let rule: PathsRule | null = null;
  if (options.paths && typeof options.paths === "object") {
    const baseDir = options.baseUrl ? normalize(`${configDir}/${options.baseUrl}`) : configDir;
    const patterns: PathsRule["patterns"] = [];
    for (const [pattern, targets] of Object.entries(options.paths)) {
      if (Array.isArray(targets)) patterns.push([pattern, targets.filter((t): t is string => typeof t === "string")]);
    }
    if (patterns.length) rule = { baseDir, patterns };
  }
  if (!rule && typeof config.extends === "string" && config.extends.startsWith(".")) {
    const parent = normalize(`${configDir}/${config.extends}`);
    rule = parseTsconfigPaths(parent.endsWith(".json") ? parent : `${parent}.json`, readFile, visited);
  }
  return rule;
}

function matchPaths(rule: PathsRule, specifier: string): string[] {
  const out: string[] = [];
  for (const [pattern, targets] of rule.patterns) {
    const star = pattern.indexOf("*");
    let captured: string | null = null;
    if (star === -1) {
      if (specifier !== pattern) continue;
      captured = "";
    } else {
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix) || specifier.length < prefix.length + suffix.length) continue;
      captured = specifier.slice(prefix.length, specifier.length - suffix.length);
    }
    for (const target of targets) {
      out.push(normalize(`${rule.baseDir}/${target.replace("*", captured)}`));
    }
  }
  return out;
}

function entryFor(source: ShaSource): ServiceEntry {
  const cached = services.get(source.key);
  if (cached) {
    // refresh LRU order
    services.delete(source.key);
    services.set(source.key, cached);
    return cached;
  }

  const roots = new Set<string>();
  const content = new Map<string, string | null>();
  const pathSet = new Set(source.paths());
  const pathsRules = new Map<string, PathsRule | null>();

  const read = (fileName: string): string | null => {
    if (content.has(fileName)) return content.get(fileName)!;
    const repoPath = fromVirtual(fileName);
    let text = pathSet.has(repoPath) ? source.readFile(repoPath) : null;
    if (text !== null && repoPath.endsWith(".svelte")) text = svelteScriptOnly(text);
    content.set(fileName, text);
    return text;
  };

  const resolveStem = (stem: string): string | null => {
    if (pathSet.has(stem)) return stem;
    const swapped = stem.replace(/\.(m|c)?js$/, ".ts");
    if (swapped !== stem) {
      for (const candidate of [swapped, stem.replace(/\.(m|c)?js$/, ".tsx")]) {
        if (pathSet.has(candidate)) return candidate;
      }
    }
    for (const base of [stem, `${stem}/index`]) {
      for (const ext of FILE_EXTS) {
        if (pathSet.has(`${base}${ext}`)) return `${base}${ext}`;
      }
    }
    return null;
  };

  // Nearest sha-pinned tsconfig with paths, walking up from the importing file.
  const pathsRuleFor = (fromRepo: string): PathsRule | null => {
    let dir = dirname(fromRepo);
    const missed: string[] = [];
    while (true) {
      if (pathsRules.has(dir)) {
        const rule = pathsRules.get(dir)!;
        for (const m of missed) pathsRules.set(m, rule);
        return rule;
      }
      missed.push(dir);
      const configPath = dir ? `${dir}/tsconfig.json` : "tsconfig.json";
      if (pathSet.has(configPath)) {
        const rule = parseTsconfigPaths(configPath, source.readFile, new Set());
        if (rule) {
          for (const m of missed) pathsRules.set(m, rule);
          return rule;
        }
      }
      if (dir === "") {
        for (const m of missed) pathsRules.set(m, null);
        return null;
      }
      dir = dirname(dir);
    }
  };

  const resolveRepoPath = (specifier: string, fromRepo: string): string | null => {
    if (specifier.startsWith(".")) {
      return resolveStem(normalize(`${dirname(fromRepo)}/${specifier}`));
    }
    const rule = pathsRuleFor(fromRepo);
    if (!rule) return null;
    for (const stem of matchPaths(rule, specifier)) {
      const resolved = resolveStem(stem);
      if (resolved) return resolved;
    }
    return null;
  };

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => [...roots],
    getScriptVersion: () => "1",
    getScriptSnapshot: (fileName) => {
      const text = read(fileName);
      return text === null ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => "/",
    getCompilationSettings: () => COMPILER_OPTIONS,
    getDefaultLibFileName: () => "lib.d.ts",
    fileExists: (fileName) => read(fileName) !== null,
    readFile: (fileName) => read(fileName) ?? undefined,
    useCaseSensitiveFileNames: () => true,
    resolveModuleNameLiterals: (literals, containingFile) =>
      literals.map((literal) => {
        const resolved = resolveRepoPath(literal.text, fromVirtual(containingFile));
        if (!resolved) return { resolvedModule: undefined };
        const virtual = toVirtual(resolved);
        return {
          resolvedModule: {
            resolvedFileName: virtual,
            extension: virtual.endsWith(VIRTUAL_SVELTE_SUFFIX) ? ts.Extension.Ts : extensionOf(virtual),
            isExternalLibraryImport: false,
          },
        };
      }),
  };

  const entry: ServiceEntry = { service: ts.createLanguageService(host), roots, content, pathSet };
  services.set(source.key, entry);
  if (services.size > SERVICE_CAP) {
    const oldest = services.keys().next().value;
    if (oldest !== undefined) {
      services.get(oldest)!.service.dispose();
      services.delete(oldest);
    }
  }
  return entry;
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;

function identifierAt(text: string, offset: number): string | null {
  if (!IDENT_CHAR.test(text[offset] ?? "")) return null;
  let start = offset;
  let end = offset;
  while (start > 0 && IDENT_CHAR.test(text[start - 1]!)) start -= 1;
  while (end < text.length && IDENT_CHAR.test(text[end]!)) end += 1;
  const word = text.slice(start, end);
  return /^[A-Za-z_$]/.test(word) ? word : null;
}

// line is 1-based, character is 0-based within the line.
export function definitionsAt(
  source: ShaSource,
  fromPath: string,
  symbol: string,
  line: number,
  character: number,
): AstDefinition[] | null {
  const entry = entryFor(source);
  const fileName = toVirtual(fromPath);
  entry.roots.add(fileName);

  const program = entry.service.getProgram();
  const sourceFile = program?.getSourceFile(fileName);
  if (!sourceFile) return null;

  let offset: number;
  try {
    offset = ts.getPositionOfLineAndCharacter(sourceFile, line - 1, character);
  } catch {
    return null;
  }
  // Guard against stale coordinates: the clicked token must actually be there.
  if (identifierAt(sourceFile.text, offset) !== symbol) return null;

  const defs = entry.service.getDefinitionAtPosition(fileName, offset);
  if (!defs?.length) return null;

  const out: AstDefinition[] = [];
  for (const def of defs) {
    const repoPath = fromVirtual(def.fileName);
    if (!entry.pathSet.has(repoPath)) continue;
    const defSource = program?.getSourceFile(def.fileName);
    if (!defSource) continue;
    const pos = ts.getLineAndCharacterOfPosition(defSource, def.textSpan.start);
    const lineText = defSource.text.split("\n")[pos.line] ?? "";
    out.push({ path: repoPath, line: pos.line + 1, text: lineText.trim(), symbol: def.name });
  }
  return out.length ? out : null;
}
