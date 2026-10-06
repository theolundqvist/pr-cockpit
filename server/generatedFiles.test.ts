import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { generatedFilesFromGitDir, generatedPathsFromGitDir } from "./generatedFiles.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    await Bun.write(join(root, path), content);
  }
}

const sorted = (paths: Iterable<string>) => [...paths].sort();

// base: the PR's fork point; head: the PR, which rewrites rules and deletes files; main: base branch moved on
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pr-cockpit-generated-"));
  cleanup.push(root);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "PR Cockpit Test");
  git(root, "config", "user.email", "pr-cockpit@example.test");
  await write(root, {
    ".gitattributes": [
      "[attr]generated-code linguist-generated",
      "*.snap generated-code",
      "vendor/** linguist-generated=true",
      "api/*.ts linguist-generated",
      "old/** linguist-generated",
      "",
    ].join("\n"),
    "vendor/keep/.gitattributes": "*.js -linguist-generated\n",
    "api/.gitattributes": "handwritten.ts linguist-generated=false\n",
    "src/main.ts": "main\n",
    "src/legacy.ts": "legacy\n",
    "src/space name ü.snap": "snapshot\n",
    "line\nbreak.snap": "snapshot\n",
    "vendor/lib/a.js": "vendored\n",
    "vendor/keep/patched.js": "patched\n",
    "api/client.ts": "client\n",
    "api/handwritten.ts": "handwritten\n",
    "old/schema.gen.ts": "schema\n",
  });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  const base = git(root, "rev-parse", "HEAD").trim();

  git(root, "switch", "-q", "-c", "topic");
  await write(root, {
    ".gitattributes": [
      "[attr]generated-code linguist-generated",
      "*.snap generated-code",
      "vendor/** linguist-generated=true",
      "api/*.ts linguist-generated",
      "src/main.ts linguist-generated=true",
      "",
    ].join("\n"),
    "api/.gitattributes": "handwritten.ts linguist-generated=false\nclient.ts -linguist-generated\n",
    "vendor/lib/.gitattributes": "b.js !linguist-generated\n",
    "vendor/lib/b.js": "vendored but reviewed\n",
  });
  git(root, "rm", "-q", "old/schema.gen.ts", "src/legacy.ts");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "head");
  const head = git(root, "rev-parse", "HEAD").trim();

  git(root, "switch", "-q", "main");
  await write(root, { ".gitattributes": `${readFileSync(join(root, ".gitattributes"), "utf8")}src/legacy.ts linguist-generated\n` });
  git(root, "commit", "-q", "-am", "main marks legacy generated");
  git(root, "switch", "-q", "topic");

  return { root, gitDir: join(root, ".git"), base, head };
}

const BASE_GENERATED = [
  "line\nbreak.snap",
  "src/space name ü.snap",
  "vendor/lib/a.js",
  "vendor/keep/.gitattributes",
  "api/client.ts",
  "old/schema.gen.ts",
];
const HEAD_GENERATED = [
  "line\nbreak.snap",
  "src/space name ü.snap",
  "vendor/lib/a.js",
  "vendor/keep/.gitattributes",
  "vendor/lib/.gitattributes",
  "src/main.ts",
];

describe("generatedPathsFromGitDir", () => {
  test("applies each commit's nested, macro, false, unset and unspecified rules", async () => {
    const { gitDir, base, head } = await fixture();
    const basePaths = git(gitDir, "ls-tree", "-r", "-z", "--name-only", base).split("\0").filter(Boolean);
    const headPaths = git(gitDir, "ls-tree", "-r", "-z", "--name-only", head).split("\0").filter(Boolean);

    expect(sorted(await generatedPathsFromGitDir(gitDir, base, basePaths))).toEqual(sorted(BASE_GENERATED));
    expect(sorted(await generatedPathsFromGitDir(gitDir, head, headPaths))).toEqual(sorted(HEAD_GENERATED));
    expect(await generatedPathsFromGitDir(gitDir, head, [])).toEqual(new Set());
  });

  test("reads only the committed tree, never the checkout, index, global or ambient attributes", async () => {
    const { root, gitDir, head } = await fixture();
    await write(root, { ".gitattributes": "* -linguist-generated\n" });
    git(root, "add", ".gitattributes");
    await write(root, { ".gitattributes": "* linguist-generated\n", "info.snap": "untracked\n" });
    const config = mkdtempSync(join(tmpdir(), "pr-cockpit-generated-config-"));
    cleanup.push(config);
    await write(config, { "git/attributes": "* linguist-generated\n" });
    const index = readFileSync(join(gitDir, "index"));
    const status = git(root, "status", "--porcelain", "-z");
    const scratchBefore = readdirSync(tmpdir()).filter((name) => name.startsWith("pr-cockpit-attrs-"));
    const ambient = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
    process.env.XDG_CONFIG_HOME = config;
    process.env.GIT_INDEX_FILE = join(gitDir, "index");
    try {
      const generated = await generatedPathsFromGitDir(gitDir, head, ["src/main.ts", "api/client.ts", "info.snap", "README.md"]);
      expect(sorted(generated)).toEqual(["info.snap", "src/main.ts"]);
      await expect(generatedPathsFromGitDir(gitDir, "0".repeat(40), ["src/main.ts"])).rejects.toThrow("unknown commit");
    } finally {
      for (const [key, value] of Object.entries(ambient)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    expect(readFileSync(join(gitDir, "index")).equals(index)).toBe(true);
    expect(git(root, "status", "--porcelain", "-z")).toBe(status);
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith("pr-cockpit-attrs-"))).toEqual(scratchBefore);
  });

  test("reads commit data and attributes outside the source's local Git metadata", async () => {
    const { root, gitDir, base, head } = await fixture();
    const main = git(root, "rev-parse", "main").trim();
    const headPaths = git(gitDir, "ls-tree", "-r", "-z", "--name-only", head).split("\0").filter(Boolean);
    const gitInput = (input: string, ...args: string[]) =>
      Bun.spawnSync(["git", "-C", root, ...args], { stdin: new TextEncoder().encode(input) }).stdout.toString().trim();
    const orphan = git(root, "commit-tree", gitInput("", "mktree"), "-m", "unrelated root").trim();
    const allTree = gitInput(`100644 blob ${gitInput("* linguist-generated\n", "hash-object", "-w", "--stdin")}\t.gitattributes\n`, "mktree");
    const allGenerated = git(root, "commit-tree", allTree, "-p", orphan, "-m", "everything generated").trim();
    git(root, "replace", head, allGenerated);
    git(root, "replace", base, allGenerated);
    git(root, "config", "attr.tree", allTree);
    await write(gitDir, { "info/attributes": "* linguist-generated\n", "info/grafts": `${head} ${main}\n` });

    const status = git(root, "status", "--porcelain", "-z");
    const snapshot = () => readdirSync(gitDir, { recursive: true, encoding: "utf8" })
      .filter((path) => statSync(join(gitDir, path)).isFile())
      .sort()
      .map((path) => [path, readFileSync(join(gitDir, path)).toString("base64")]);
    const before = snapshot();
    const scratchBefore = readdirSync(tmpdir()).filter((name) => name.startsWith("pr-cockpit-attrs-"));

    expect(sorted(await generatedPathsFromGitDir(gitDir, head, headPaths))).toEqual(sorted(HEAD_GENERATED));
    expect(sorted(await generatedPathsFromGitDir(gitDir, "topic", ["README.md"]))).toEqual([]);
    const threeDot = await generatedFilesFromGitDir(gitDir, "main", "topic", "three-dot");
    expect(threeDot.status === "ok" && sorted(threeDot.paths)).toEqual(sorted([...HEAD_GENERATED, "old/schema.gen.ts"]));
    const twoDot = await generatedFilesFromGitDir(gitDir, main, head, "two-dot");
    expect(twoDot.status === "ok" && sorted(twoDot.paths)).toEqual(sorted([...HEAD_GENERATED, "old/schema.gen.ts", "src/legacy.ts"]));
    // an unrelated root has no merge base: the failure surfaces and the scratch repository still goes
    await expect(generatedFilesFromGitDir(gitDir, orphan, head, "three-dot")).rejects.toThrow("merge-base");

    expect(snapshot()).toEqual(before);
    expect(git(root, "status", "--porcelain", "-z")).toBe(status);
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith("pr-cockpit-attrs-"))).toEqual(scratchBefore);
  });
});

describe("generatedFilesFromGitDir", () => {
  test("uses head rules for present paths and the diff's old side for deleted paths", async () => {
    const { gitDir, base, head } = await fixture();

    // the PR's three-dot diff deletes from the fork point, which marked old/ generated but not legacy.ts
    const threeDot = await generatedFilesFromGitDir(gitDir, "refs/heads/main", head, "three-dot");
    expect(threeDot.status).toBe("ok");
    if (threeDot.status !== "ok") return;
    expect(sorted(threeDot.paths)).toEqual(sorted([...HEAD_GENERATED, "old/schema.gen.ts"]));

    const fromBase = await generatedFilesFromGitDir(gitDir, base, head, "two-dot");
    expect(fromBase.status === "ok" && sorted(fromBase.paths)).toEqual(sorted(threeDot.paths));

    // a range from the moved base branch deletes legacy.ts from a tree that marks it generated
    const fromMain = await generatedFilesFromGitDir(gitDir, "main", head, "two-dot");
    expect(fromMain.status === "ok" && sorted(fromMain.paths)).toEqual(sorted([...HEAD_GENERATED, "old/schema.gen.ts", "src/legacy.ts"]));
  });

  test("reports commits the repository has not seen", async () => {
    const { gitDir, head } = await fixture();
    expect(await generatedFilesFromGitDir(gitDir, "0".repeat(40), head, "two-dot")).toEqual({ status: "missing-commit" });
    expect(await generatedFilesFromGitDir(gitDir, "refs/heads/absent", head, "three-dot")).toEqual({ status: "missing-commit" });
  });
});

describe("generatedFilesFromMirror", () => {
  test("caches resolved commits for synchronous reads and serves full SHAs without the mirror", async () => {
    const { root, head } = await fixture();
    const main = git(root, "rev-parse", "main").trim();
    const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-generated-data-"));
    cleanup.push(dataDir);
    const mirror = join(dataDir, "mirrors", "owner__repo");
    git(root, "clone", "-q", "--bare", root, mirror);
    const moduleUrl = pathToFileURL(join(import.meta.dir, "generatedFiles.ts")).href;
    // mirror.ts binds COCKPIT_DATA_DIR when it loads, so the scenario runs in its own process
    const scenario = `
      const { rmSync } = await import("node:fs");
      const generated = await import(${JSON.stringify(moduleUrl)});
      const [main, head, mirror] = ${JSON.stringify([main, head, mirror])};
      const peek = (base) => generated.cachedGeneratedPathsFromMirror("owner/repo", base, head, "three-dot");
      const before = peek(main);
      const named = await generated.generatedFilesFromMirror("owner/repo", "refs/heads/main", head, "three-dot");
      const cached = peek(main);
      const namedPeek = peek("refs/heads/main");
      const missing = await generated.generatedFilesFromMirror("owner/repo", "0".repeat(40), head, "two-dot");
      rmSync(mirror, { recursive: true, force: true });
      const afterEviction = await generated.generatedFilesFromMirror("owner/repo", main, head, "three-dot");
      const uncached = await generated.generatedFilesFromMirror("owner/repo", main, head, "two-dot");
      process.stdout.write(JSON.stringify({
        before, named, cached: cached && [...cached], namedPeek, missing, afterEviction, uncached,
      }));
    `;
    const result = Bun.spawnSync([process.execPath, "-e", scenario], {
      env: { ...process.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    const outcome = JSON.parse(result.stdout.toString());
    const expected = sorted([...HEAD_GENERATED, "old/schema.gen.ts"]);

    expect(outcome.before).toBeNull();
    expect(outcome.named.status).toBe("ok");
    expect(sorted(outcome.named.paths)).toEqual(expected);
    expect(sorted(outcome.cached)).toEqual(expected);
    expect(outcome.namedPeek).toBeNull();
    expect(outcome.missing).toEqual({ status: "missing-commit" });
    expect(outcome.afterEviction.status).toBe("ok");
    expect(sorted(outcome.afterEviction.paths)).toEqual(expected);
    expect(outcome.uncached).toEqual({ status: "no-mirror" });
  });
});

describe("generatedPathsForCommitsFromMirror", () => {
  test("classifies each commit's changed paths with its own or its first parent's attributes", async () => {
    const root = mkdtempSync(join(tmpdir(), "pr-cockpit-generated-commits-"));
    cleanup.push(root);
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "PR Cockpit Test");
    git(root, "config", "user.email", "pr-cockpit@example.test");
    const odd = "gen/tab\there\nnext\x1e.ts";
    const binary = new Uint8Array([0, 1, 2, 0, 255]);
    await write(root, {
      ".gitattributes": "gen/** linguist-generated\n*.bin linguist-generated\n",
      "x[y]/.gitattributes": "z.g linguist-generated\n",
      "x[y]/z.g": "z\n",
      "gen/root.ts": "root\n",
      "gen/old.ts": "old\n",
      "schéma ü.ts": "one\n",
    });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "root");
    const rootSha = git(root, "rev-parse", "HEAD").trim();

    await write(root, { [odd]: "x\n", "schéma ü.ts": "one\ntwo\n", "x[y]/z.g": "z\nz\n" });
    await Bun.write(join(root, "logo.png"), binary);
    await Bun.write(join(root, "data.bin"), binary);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "odd paths and binaries");
    const added = git(root, "rev-parse", "HEAD").trim();

    // drops the gen/** rule while deleting a gen/ file, and renames one path out of its rule and one into another
    await write(root, { ".gitattributes": "*.bin linguist-generated\n", [odd]: "x\ny\n" });
    git(root, "rm", "-q", "gen/old.ts");
    git(root, "mv", "x[y]/z.g", "x[y]/w.g");
    git(root, "mv", "schéma ü.ts", "schéma ü.bin");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "rules change");
    const changed = git(root, "rev-parse", "HEAD").trim();

    const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-generated-data-"));
    cleanup.push(dataDir);
    const mirror = join(dataDir, "mirrors", "owner__repo");
    git(root, "clone", "-q", "--bare", root, mirror);
    const scratchBefore = readdirSync(tmpdir()).filter((name) => name.startsWith("pr-cockpit-attrs-"));
    const generatedUrl = pathToFileURL(join(import.meta.dir, "generatedFiles.ts")).href;
    const mirrorUrl = pathToFileURL(join(import.meta.dir, "mirror.ts")).href;
    const scenario = `
      const { rmSync } = await import("node:fs");
      const generated = await import(${JSON.stringify(generatedUrl)});
      const { commitStatsFromGitDir } = await import(${JSON.stringify(mirrorUrl)});
      const [rootSha, changed, mirror] = ${JSON.stringify([rootSha, changed, mirror])};
      const stats = await commitStatsFromGitDir(mirror, rootSha, changed);
      if (stats.status !== "ok") throw new Error(stats.status);
      const commits = [...stats.commits, { sha: rootSha, files: [{ path: ".gitattributes" }, { path: "gen/root.ts" }] }];
      const plain = (result) => result.status !== "ok" ? result : Object.fromEntries(
        [...result.generatedByCommit].map(([sha, paths]) => [sha, [...paths].sort()]));
      const classify = (list, signal) => generated.generatedPathsForCommitsFromMirror("owner/repo", list, signal);
      const fresh = plain(await classify(commits));
      const missing = await classify([{ sha: "0".repeat(40), files: [{ path: "a" }] }]);
      const controller = new AbortController();
      controller.abort(new Error("superseded"));
      const aborted = await classify(commits, controller.signal).then(() => "resolved", (error) => error.message);
      rmSync(mirror, { recursive: true, force: true });
      const cached = plain(await classify(commits));
      const uncached = await classify([{ sha: changed, files: [{ path: "never classified" }] }]);
      process.stdout.write(JSON.stringify({
        files: stats.commits.map((commit) => [commit.sha, commit.files.map((file) => file.path).sort()]),
        fresh, missing, aborted, cached, uncached,
      }));
    `;
    const result = Bun.spawnSync([process.execPath, "-e", scenario], {
      env: { ...process.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    const outcome = JSON.parse(result.stdout.toString());
    const expected = {
      [rootSha]: ["gen/root.ts"],
      [added]: ["data.bin", odd, "x[y]/z.g"],
      // gen/old.ts is gone, so its parent's rule applies; kept and renamed paths follow the commit's own rules
      [changed]: ["gen/old.ts", "schéma ü.bin"],
    };

    expect(outcome.files).toEqual([
      [changed, sorted([".gitattributes", "gen/old.ts", odd, "schéma ü.bin", "x[y]/w.g"])],
      [added, sorted(["data.bin", odd, "logo.png", "schéma ü.ts", "x[y]/z.g"])],
    ]);
    expect(outcome.fresh).toEqual(expected);
    expect(outcome.missing).toEqual({ status: "missing-commit" });
    expect(outcome.aborted).toBe("superseded");
    expect(outcome.cached).toEqual(expected);
    expect(outcome.uncached).toEqual({ status: "no-mirror" });
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith("pr-cockpit-attrs-"))).toEqual(scratchBefore);
  });
});
