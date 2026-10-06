import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mirrorDir, withMirrorOperation } from "./mirror.ts";

export type GeneratedFilesResult =
  | { status: "ok"; paths: readonly string[] }
  | { status: "no-mirror" }
  | { status: "missing-commit" };

export type GeneratedCommitsResult =
  | { status: "ok"; generatedByCommit: ReadonlyMap<string, ReadonlySet<string>> }
  | { status: "no-mirror" | "missing-commit" };

type Mode = "two-dot" | "three-dot";
type Commits = { base: string; head: string };
type GitRun = { exitCode: number; stdout: string; stderr: string };

// No ambient GIT_* steering (GIT_DIR, GIT_INDEX_FILE, GIT_ATTR_SOURCE, GIT_OBJECT_DIRECTORY,
// GIT_CONFIG_PARAMETERS), no refs/replace substitution, and no lazy fetch from a partial clone's
// promisor remote in the middle of a request.
function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (value !== undefined && (!key.startsWith("GIT_") || key === "GIT_EXEC_PATH")) env[key] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  return env;
}

async function runGit(argv: string[], env: Record<string, string>, cwd?: string, input?: Uint8Array): Promise<GitRun> {
  const proc = Bun.spawn(["git", ...argv], { cwd, env, stdin: input ?? "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode: await proc.exited, stdout, stderr };
}

function gitFailure(command: string, result: GitRun): Error {
  return new Error(`git ${command} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
}

async function resolveCommit(gitDir: string, revision: string): Promise<string | null> {
  if (revision === "" || revision.startsWith("-")) throw new Error(`invalid revision ${JSON.stringify(revision)}`);
  const result = await runGit(["--git-dir", resolve(gitDir), "rev-parse", "--verify", "-q", `${revision}^{commit}`], gitEnv());
  if (result.exitCode !== 0) return null;
  return result.stdout.trim();
}

async function resolveCommits(gitDir: string, base: string, head: string): Promise<Commits | null> {
  const [baseSha, headSha] = await Promise.all([resolveCommit(gitDir, base), resolveCommit(gitDir, head)]);
  return baseSha === null || headSha === null ? null : { base: baseSha, head: headSha };
}

// GIT_ALTERNATE_OBJECT_DIRECTORIES splits on ':' unless the entry is C-quoted.
function cQuote(path: string): string {
  return `"${path.replace(/[\\"\x00-\x1f\x7f]/g, (char) =>
    char === "\\" || char === '"' ? `\\${char}` : `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`)}"`;
}

type PrivateGit = {
  run(args: string[], options?: { index?: string; input?: Uint8Array }): Promise<string>;
  newIndex(): string;
};

/**
 * Runs `use` against a throwaway bare repository that borrows the source's object store read-only.
 * Commit data and attributes are read only there: the source's info/attributes, config (attr.tree,
 * core.*), index, replace refs, grafts and shallow boundaries cannot steer them, and nothing is
 * written into the source. Attribute lookups also skip system and global attribute files and match
 * case-sensitively, as linguist does on GitHub.
 */
async function withPrivateGit<T>(sourceGitDir: string, use: (git: PrivateGit) => Promise<T>): Promise<T> {
  const layout = await runGit(
    ["--git-dir", resolve(sourceGitDir), "rev-parse", "--show-object-format", "--path-format=absolute", "--git-path", "objects"],
    gitEnv(),
  );
  const [format, objects, ...rest] = layout.stdout.split("\n");
  if (layout.exitCode !== 0 || !format || !objects || rest.join("\n") !== "") throw gitFailure("rev-parse", layout);
  const scratch = await mkdtemp(join(tmpdir(), "pr-cockpit-attrs-"));
  try {
    const gitDir = join(scratch, "git");
    const env = {
      ...gitEnv(),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: cQuote(objects),
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_LITERAL_PATHSPECS: "1",
    };
    // an empty template keeps a configured init.templateDir from seeding info/attributes
    const init = await runGit(["init", "--bare", "-q", "--template=", `--object-format=${format}`, gitDir], env, scratch);
    if (init.exitCode !== 0) throw gitFailure("init", init);
    // init records ignoreCase and precomposeUnicode for the filesystem it runs on, and Git always
    // falls back to $XDG_CONFIG_HOME/git/attributes when core.attributesFile is unset
    const overrides = ["core.attributesFile=/dev/null", "core.ignoreCase=false", "core.precomposeUnicode=false"]
      .flatMap((setting) => ["-c", setting]);
    let indexes = 0;
    return await use({
      async run(args, options = {}) {
        const result = await runGit(
          [...overrides, "--git-dir", gitDir, ...args],
          options.index ? { ...env, GIT_INDEX_FILE: options.index } : env,
          scratch,
          options.input,
        );
        if (result.exitCode !== 0) throw gitFailure(args[0]!, result);
        return result.stdout;
      },
      newIndex: () => join(scratch, `index-${++indexes}`),
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const ATTRIBUTES_FILE = ".gitattributes";

// ls-tree -z records are `<mode> SP <type> SP <oid> TAB <path>` with the path unquoted; Git reads
// in-tree attributes only from blobs, the same records update-index --index-info accepts.
function isAttributesBlob(record: string): boolean {
  const tab = record.indexOf("\t");
  const path = record.slice(tab + 1);
  return record.slice(0, tab).split(" ")[1] === "blob"
    && (path === ATTRIBUTES_FILE || path.endsWith(`/${ATTRIBUTES_FILE}`));
}

/**
 * The ls-tree records of the .gitattributes blobs Git consults for `paths` at `sha`: the one in each
 * ancestor directory. Only those are looked up, so classifying a few changed paths never reads the
 * rest of a large tree.
 */
async function attributesAlong(git: PrivateGit, sha: string, paths: readonly string[]): Promise<string[]> {
  const candidates = new Set<string>([ATTRIBUTES_FILE]);
  for (const path of paths) {
    for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
      candidates.add(`${path.slice(0, slash)}/${ATTRIBUTES_FILE}`);
    }
  }
  const records: string[] = [];
  // candidates travel as literal pathspecs on argv, so stay well below every platform's ARG_MAX
  let batch: string[] = [];
  let bytes = 0;
  const flush = async () => {
    const output = await git.run(["ls-tree", "-z", "--full-tree", sha, "--", ...batch]);
    records.push(...output.split("\0").filter((record) => record !== "" && isAttributesBlob(record)));
    batch = [];
    bytes = 0;
  };
  for (const candidate of candidates) {
    batch.push(candidate);
    bytes += candidate.length + 1;
    if (bytes > 65536) await flush();
  }
  if (batch.length > 0) await flush();
  return records;
}

/**
 * Returns the subset of `paths` that the given .gitattributes blobs mark linguist-generated. Git
 * resolves nested files, macros and overrides itself: the blobs are staged into a private index and
 * queried with check-attr --cached.
 */
async function generatedAmong(git: PrivateGit, paths: readonly string[], attributes: readonly string[]): Promise<Set<string>> {
  const generated = new Set<string>();
  if (paths.length === 0) return generated;
  // a missing index file reads as empty: no in-tree attributes apply
  const index = git.newIndex();
  if (attributes.length > 0) {
    await git.run(["update-index", "-z", "--index-info"], {
      index,
      input: new TextEncoder().encode(`${attributes.join("\0")}\0`),
    });
  }
  const output = await git.run(["check-attr", "--cached", "-z", "--stdin", "linguist-generated"], {
    index,
    input: new TextEncoder().encode(`${paths.join("\0")}\0`),
  });
  // -z output is <path> NUL <attribute> NUL <value> NUL per input path, in input order
  const fields = output.split("\0");
  if (fields.length !== paths.length * 3 + 1) {
    throw new Error(`git check-attr returned ${Math.floor(fields.length / 3)} results for ${paths.length} paths`);
  }
  for (let index = 0; index < paths.length; index++) {
    // `path linguist-generated` reports "set"; only an explicit true value otherwise counts, so
    // false, unset (-linguist-generated) and unspecified leave the path in review.
    const value = fields[index * 3 + 2];
    if (value === "set" || value === "true") generated.add(paths[index]!);
  }
  return generated;
}

/**
 * Returns the subset of `paths` that the committed .gitattributes at `revision` (resolved in the
 * repository at `gitDir`) mark linguist-generated. Throws when the revision is not a known commit.
 */
export async function generatedPathsFromGitDir(
  gitDir: string,
  revision: string,
  paths: readonly string[],
): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  const sha = await resolveCommit(gitDir, revision);
  if (sha === null) throw new Error(`unknown commit ${JSON.stringify(revision)}`);
  return withPrivateGit(gitDir, async (git) => generatedAmong(git, paths, await attributesAlong(git, sha, paths)));
}

async function treeListing(git: PrivateGit, sha: string): Promise<{ paths: string[]; attributes: string[] }> {
  const records = (await git.run(["ls-tree", "-r", "-z", "--full-tree", sha])).split("\0").filter((record) => record !== "");
  return {
    paths: records.map((record) => record.slice(record.indexOf("\t") + 1)),
    attributes: records.filter(isAttributesBlob),
  };
}

// Every head path the head commit marks generated, plus every path the diff deletes that the diff's
// old side marked generated: the base itself for a two-dot range, the merge base for a pull request's
// three-dot diff. Head-present paths follow the head's rules even when the old side disagreed.
async function generatedFilesForRange(git: PrivateGit, mode: Mode, commits: Commits): Promise<string[]> {
  const old = mode === "two-dot" ? commits.base : (await git.run(["merge-base", commits.base, commits.head])).trim();
  const [head, oldTree] = await Promise.all([
    treeListing(git, commits.head),
    old === commits.head ? Promise.resolve({ paths: [], attributes: [] }) : treeListing(git, old),
  ]);
  const present = new Set(head.paths);
  const deleted = oldTree.paths.filter((path) => !present.has(path));
  const [headGenerated, deletedGenerated] = await Promise.all([
    generatedAmong(git, head.paths, head.attributes),
    generatedAmong(git, deleted, oldTree.attributes),
  ]);
  return [...headGenerated, ...deletedGenerated];
}

export async function generatedFilesFromGitDir(
  gitDir: string,
  base: string,
  head: string,
  mode: Mode,
): Promise<Exclude<GeneratedFilesResult, { status: "no-mirror" }>> {
  const commits = await resolveCommits(gitDir, base, head);
  if (commits === null) return { status: "missing-commit" };
  return { status: "ok", paths: await withPrivateGit(gitDir, (git) => generatedFilesForRange(git, mode, commits)) };
}

// The interactive range cache: keyed by resolved commit OIDs (a merge base is fixed by its two
// commits), so entries never go stale. Failures are not retained.
type CacheEntry = { paths: readonly string[]; set: ReadonlySet<string> };
const RESULT_CACHE_LIMIT = 64;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const resultCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CacheEntry>>();

function cachedEntry(key: string): CacheEntry | undefined {
  const entry = resultCache.get(key);
  if (entry) {
    resultCache.delete(key);
    resultCache.set(key, entry);
  }
  return entry;
}

/**
 * The cached generated paths for a full-SHA range, or null until generatedFilesFromMirror has
 * computed them. Never runs Git, so callers on a hot path can read it synchronously.
 */
export function cachedGeneratedPathsFromMirror(repo: string, base: string, head: string, mode: Mode): ReadonlySet<string> | null {
  if (!FULL_SHA.test(base) || !FULL_SHA.test(head)) return null;
  return cachedEntry(`${repo}\0${mode}\0${base}\0${head}`)?.set ?? null;
}

export async function generatedFilesFromMirror(
  repo: string,
  base: string,
  head: string,
  mode: Mode,
): Promise<GeneratedFilesResult> {
  if (FULL_SHA.test(base) && FULL_SHA.test(head)) {
    const entry = cachedEntry(`${repo}\0${mode}\0${base}\0${head}`);
    if (entry) return { status: "ok", paths: entry.paths };
  }
  return withMirrorOperation(repo, async () => {
    const dir = mirrorDir(repo);
    if (!(await Bun.file(`${dir}/HEAD`).exists())) return { status: "no-mirror" };
    const commits = await resolveCommits(dir, base, head);
    if (commits === null) return { status: "missing-commit" };
    const key = `${repo}\0${mode}\0${commits.base}\0${commits.head}`;
    const entry = cachedEntry(key);
    if (entry) return { status: "ok", paths: entry.paths };
    let computation = inFlight.get(key);
    if (!computation) {
      computation = withPrivateGit(dir, (git) => generatedFilesForRange(git, mode, commits))
        .then((paths) => {
          const computed = { paths, set: new Set(paths) };
          resultCache.set(key, computed);
          while (resultCache.size > RESULT_CACHE_LIMIT) resultCache.delete(resultCache.keys().next().value!);
          return computed;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, computation);
    }
    return { status: "ok", paths: (await computation).paths };
  });
}

// Per-commit classifications for commit line counts, kept apart from the interactive range cache so
// long histories cannot evict it. A commit's classification never changes; an entry is reused when
// it covers every requested path, and the cache is bounded by the paths it holds.
type CommitEntry = { classified: ReadonlySet<string>; generated: ReadonlySet<string> };
const COMMIT_CACHE_PATH_LIMIT = 100_000;
const commitCache = new Map<string, CommitEntry>();
let commitCachePaths = 0;

function cachedCommit(key: string, paths: readonly string[]): ReadonlySet<string> | undefined {
  const entry = commitCache.get(key);
  if (!entry || !paths.every((path) => entry.classified.has(path))) return undefined;
  commitCache.delete(key);
  commitCache.set(key, entry);
  return entry.generated;
}

function rememberCommit(key: string, entry: CommitEntry): void {
  const previous = commitCache.get(key);
  if (previous) {
    commitCache.delete(key);
    commitCachePaths -= previous.classified.size;
  }
  if (entry.classified.size > COMMIT_CACHE_PATH_LIMIT) return;
  commitCache.set(key, entry);
  commitCachePaths += entry.classified.size;
  while (commitCachePaths > COMMIT_CACHE_PATH_LIMIT) {
    const [oldestKey, oldest] = commitCache.entries().next().value!;
    commitCache.delete(oldestKey);
    commitCachePaths -= oldest.classified.size;
  }
}

/**
 * Classifies only each commit's own changed `files`: paths the commit keeps follow its own
 * .gitattributes, paths it deletes follow its first parent's. Commits are worked through one at a
 * time, and an aborted `signal` stops the work between commits by throwing its reason. The result
 * covers every requested commit or reports why none could be classified; Git failures throw.
 */
export async function generatedPathsForCommitsFromMirror(
  repo: string,
  commits: readonly { sha: string; files: readonly { path: string }[] }[],
  signal?: AbortSignal,
): Promise<GeneratedCommitsResult> {
  signal?.throwIfAborted();
  const generatedByCommit = new Map<string, ReadonlySet<string>>();
  const pending = new Map<string, string[]>();
  for (const commit of commits) {
    if (!FULL_SHA.test(commit.sha)) throw new Error(`invalid commit ${JSON.stringify(commit.sha)}`);
    const paths = [...new Set(commit.files.map((file) => file.path))];
    const cached = paths.length === 0 ? new Set<string>() : cachedCommit(`${repo}\0${commit.sha}`, paths);
    if (cached) generatedByCommit.set(commit.sha, cached);
    else pending.set(commit.sha, paths);
  }
  if (pending.size === 0) return { status: "ok", generatedByCommit };

  return withMirrorOperation(repo, async () => {
    const dir = mirrorDir(repo);
    if (!(await Bun.file(`${dir}/HEAD`).exists())) return { status: "no-mirror" };
    return withPrivateGit(dir, async (git): Promise<GeneratedCommitsResult> => {
      const parents = new Map<string, string[]>();
      const listing = await git.run(["rev-list", "--no-walk=unsorted", "--parents", "--ignore-missing", "--stdin"], {
        input: new TextEncoder().encode(`${[...pending.keys()].join("\n")}\n`),
      });
      for (const line of listing.split("\n")) {
        const [sha, ...parentShas] = line.split(" ");
        if (sha) parents.set(sha, parentShas);
      }
      if ([...pending.keys()].some((sha) => !parents.has(sha))) return { status: "missing-commit" };

      for (const [sha, paths] of pending) {
        signal?.throwIfAborted();
        const parent = parents.get(sha)![0];
        const deleted = new Set<string>();
        if (parent !== undefined) {
          const output = await git.run(["diff-tree", "-r", "-z", "--no-renames", "--diff-filter=D", "--name-only", parent, sha]);
          for (const path of output.split("\0")) if (path !== "") deleted.add(path);
        }
        const kept = paths.filter((path) => !deleted.has(path));
        const gone = paths.filter((path) => deleted.has(path));
        const generated = await generatedAmong(git, kept, await attributesAlong(git, sha, kept));
        if (gone.length > 0) {
          for (const path of await generatedAmong(git, gone, await attributesAlong(git, parent!, gone))) generated.add(path);
        }
        rememberCommit(`${repo}\0${sha}`, { classified: new Set(paths), generated });
        generatedByCommit.set(sha, generated);
      }
      return { status: "ok", generatedByCommit };
    });
  });
}
