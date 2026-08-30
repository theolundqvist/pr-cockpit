import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { commitsFromGitDir, commitStatsFromGitDir, conflictFilesFromGitDir, diffFromGitDir, fileFromGitDir, summarizeCommitStats } from "./mirror.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(result.stderr.toString());
}

describe("conflictFilesFromGitDir", () => {
  test("returns Git's exact conflicted paths without modifying a checkout", async () => {
    const root = mkdtempSync(join(tmpdir(), "pr-cockpit-conflicts-"));
    cleanup.push(root);
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "PR Cockpit Test");
    git(root, "config", "user.email", "pr-cockpit@example.test");
    await Bun.write(join(root, "navigation.ts"), "export const route = 'home';\n");
    git(root, "add", "navigation.ts");
    git(root, "commit", "-m", "base");
    git(root, "switch", "-c", "topic");
    await Bun.write(join(root, "navigation.ts"), "export const route = 'settings';\n");
    git(root, "commit", "-am", "change topic route");
    git(root, "switch", "main");
    await Bun.write(join(root, "navigation.ts"), "export const route = 'inbox';\n");
    git(root, "commit", "-am", "change base route");

    const before = Bun.spawnSync(["git", "-C", root, "status", "--porcelain"]).stdout.toString();
    const result = await conflictFilesFromGitDir(join(root, ".git"), "main", "topic");
    const after = Bun.spawnSync(["git", "-C", root, "status", "--porcelain"]).stdout.toString();

    expect(result).toEqual({ status: "conflicts", files: ["navigation.ts"] });
    expect(after).toBe(before);
  });
});

describe("diffFromGitDir", () => {
  test("returns every file when a pull request exceeds GitHub's 300-file diff limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "pr-cockpit-large-diff-"));
    cleanup.push(root);
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "PR Cockpit Test");
    git(root, "config", "user.email", "pr-cockpit@example.test");
    git(root, "commit", "--allow-empty", "-m", "base");
    await Promise.all(
      Array.from({ length: 301 }, (_, index) => Bun.write(join(root, `file-${index}.txt`), `change ${index}\n`)),
    );
    git(root, "add", ".");
    git(root, "commit", "-m", "large change");

    const result = await diffFromGitDir(join(root, ".git"), "HEAD^", "HEAD", "three-dot");

    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.patch.match(/^diff --git /gm)).toHaveLength(301);
  });
});

describe("fileFromGitDir", () => {
  test("reads a blob at the requested commit without a checkout", async () => {
    const root = mkdtempSync(join(tmpdir(), "pr-cockpit-file-"));
    cleanup.push(root);
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "PR Cockpit Test");
    git(root, "config", "user.email", "pr-cockpit@example.test");
    await Bun.write(join(root, "source.ts"), "export const value = 42;\n");
    git(root, "add", "source.ts");
    git(root, "commit", "-m", "add source");

    expect(await fileFromGitDir(join(root, ".git"), "HEAD", "source.ts")).toEqual({
      status: "ok",
      content: "export const value = 42;\n",
    });
    expect(await fileFromGitDir(join(root, ".git"), "HEAD", "missing.ts")).toEqual({
      status: "not-found",
    });
  });
});

describe("commitsFromGitDir", () => {
  test("lists every pull request commit beyond GitHub's 250-commit API limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "pr-cockpit-commits-"));
    cleanup.push(root);
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "PR Cockpit Test");
    git(root, "config", "user.email", "pr-cockpit@example.test");
    git(root, "commit", "--allow-empty", "-m", "base");
    const base = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"]).stdout.toString().trim();
    const commands: string[] = [];
    for (let index = 1; index <= 251; index++) {
      const message = `change ${index}`;
      commands.push(
        "commit refs/heads/topic",
        `mark :${index}`,
        `committer PR Cockpit Test <pr-cockpit@example.test> ${1_700_000_000 + index} +0000`,
        `data ${message.length}`,
        message,
        `from ${index === 1 ? base : `:${index - 1}`}`,
        "",
      );
    }
    commands.push("done", "");
    const imported = Bun.spawnSync(["git", "-C", root, "fast-import", "--quiet"], {
      stdin: Buffer.from(commands.join("\n")),
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!imported.success) throw new Error(imported.stderr.toString());

    const result = await commitsFromGitDir(join(root, ".git"), base, "topic");

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.commits).toHaveLength(251);
      expect(result.commits[0]?.headline).toBe("change 1");
      expect(result.commits.at(-1)?.headline).toBe("change 251");
    }
  });
});

describe("summarizeCommitStats", () => {
  test("excludes test files while preserving test-only commits", () => {
    const counts = summarizeCommitStats([
      {
        sha: "mixed",
        files: [
          { path: "src/app.ts", additions: 5, deletions: 2 },
          { path: "src/app.test.ts", additions: 3, deletions: 1 },
        ],
      },
      {
        sha: "tests",
        files: [{ path: "src/__tests__/app.ts", additions: 4, deletions: 0 }],
      },
    ], /\.test\.ts$|\/__tests__\//);

    expect(counts).toEqual({
      mixed: { additions: 5, deletions: 2, skippedTests: true, testsOnly: false },
      tests: { additions: 4, deletions: 0, skippedTests: false, testsOnly: true },
    });
  });
});

describe("commitStatsFromGitDir", () => {
  test("attributes per-file counts to each commit and skips merges", async () => {
    const root = mkdtempSync(join(tmpdir(), "pr-cockpit-commit-stats-"));
    cleanup.push(root);
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "PR Cockpit Test");
    git(root, "config", "user.email", "pr-cockpit@example.test");
    await Bun.write(join(root, "app.ts"), "one\n");
    git(root, "add", "app.ts");
    git(root, "commit", "-m", "base");
    const base = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"]).stdout.toString().trim();

    git(root, "switch", "-c", "topic");
    await Bun.write(join(root, "app.ts"), "one\ntwo\nthree\n");
    await Bun.write(join(root, "app.test.ts"), "spec\n");
    git(root, "add", "app.test.ts");
    git(root, "commit", "-am", "grow app and add spec");
    const first = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"]).stdout.toString().trim();

    await Bun.write(join(root, "app.ts"), "one\n");
    git(root, "commit", "-am", "shrink app");
    const second = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"]).stdout.toString().trim();

    git(root, "switch", "main");
    await Bun.write(join(root, "readme.md"), "docs\n");
    git(root, "add", "readme.md");
    git(root, "commit", "-m", "base moves on");
    git(root, "switch", "topic");
    git(root, "merge", "--no-edit", "main");
    const merge = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"]).stdout.toString().trim();

    const result = await commitStatsFromGitDir(join(root, ".git"), base, "topic");

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const bySha = new Map(result.commits.map((commit) => [commit.sha, commit.files]));

    expect(bySha.get(first)).toEqual([
      { path: "app.test.ts", additions: 1, deletions: 0 },
      { path: "app.ts", additions: 2, deletions: 0 },
    ]);
    expect(bySha.get(second)).toEqual([{ path: "app.ts", additions: 0, deletions: 2 }]);
    expect(bySha.has(merge)).toBe(false);
  });

  test("reports a missing commit instead of guessing", async () => {
    const root = mkdtempSync(join(tmpdir(), "pr-cockpit-commit-stats-missing-"));
    cleanup.push(root);
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "PR Cockpit Test");
    git(root, "config", "user.email", "pr-cockpit@example.test");
    await Bun.write(join(root, "app.ts"), "one\n");
    git(root, "add", "app.ts");
    git(root, "commit", "-m", "base");

    const result = await commitStatsFromGitDir(join(root, ".git"), "main", "0".repeat(40));
    expect(result).toEqual({ status: "missing-commit" });
  });
});

describe("materializePrWorktree", () => {
  test("reuses worktrees and protects uncommitted and committed local edits", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-worktree-"));
    cleanup.push(dataDir);
    const moduleUrl = pathToFileURL(join(import.meta.dir, "mirror.ts")).href;
    // A fresh process binds this test's isolated COCKPIT_DATA_DIR before mirror.ts loads.
    const scenario = `
      import { mkdirSync } from "node:fs";
      import { join } from "node:path";
      const dataDir = process.env.COCKPIT_DATA_DIR;
      const source = join(dataDir, "source");
      const mirror = join(dataDir, "mirrors", "test__repo");
      function git(cwd, ...args) {
        const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
        if (!result.success) throw new Error(result.stderr.toString());
        return result.stdout.toString().trim();
      }
      mkdirSync(source, { recursive: true });
      git(source, "init", "-b", "main");
      git(source, "config", "user.name", "PR Cockpit Test");
      git(source, "config", "user.email", "pr-cockpit@example.test");
      await Bun.write(join(source, ".gitignore"), "ignored.txt\\n");
      await Bun.write(join(source, "source.ts"), "export const value = 1;\\n");
      git(source, "add", ".gitignore", "source.ts");
      git(source, "commit", "-m", "base");
      const base = git(source, "rev-parse", "HEAD");
      await Bun.write(join(source, "source.ts"), "export const value = 2;\\n");
      await Bun.write(join(source, "ignored.txt"), "tracked upstream\\n");
      git(source, "add", "-f", "ignored.txt");
      git(source, "commit", "-am", "advance PR");
      const next = git(source, "rev-parse", "HEAD");
      mkdirSync(join(dataDir, "mirrors"), { recursive: true });
      git(dataDir, "clone", "--bare", source, mirror);

      const { materializePrWorktree, pruneMirrors } = await import(${JSON.stringify(moduleUrl)});
      const worktree = await materializePrWorktree("test/repo", 7, base);
      const reused = await Promise.all([
        materializePrWorktree("test/repo", 7, base),
        materializePrWorktree("test/repo", 7, base),
      ]);
      if (reused.some((path) => path !== worktree)) throw new Error("worktree was not reused");
      await Bun.write(join(worktree, "source.ts"), "uncommitted edit\\n");
      let dirtyMessage = "";
      try {
        await materializePrWorktree("test/repo", 7, next);
      } catch (err) {
        dirtyMessage = err instanceof Error ? err.message : String(err);
      }
      if (!dirtyMessage.includes("uncommitted changes")) throw new Error(dirtyMessage || "dirty update unexpectedly succeeded");
      if ((await Bun.file(join(worktree, "source.ts")).text()) !== "uncommitted edit\\n") throw new Error("uncommitted edit was discarded");
      git(worktree, "checkout", "--", "source.ts");
      git(worktree, "config", "user.name", "PR Cockpit Test");
      git(worktree, "config", "user.email", "pr-cockpit@example.test");
      await Bun.write(join(worktree, "local.ts"), "local commit\\n");
      git(worktree, "add", "local.ts");
      git(worktree, "commit", "-m", "local work");
      const local = git(worktree, "rev-parse", "HEAD");
      let message = "";
      try {
        await materializePrWorktree("test/repo", 7, next);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      if (!message.includes("commits not present at the last materialized head")) throw new Error(message || "head update unexpectedly succeeded");
      if (git(worktree, "rev-parse", "HEAD") !== local) throw new Error("local commit was abandoned");

      const ignoredWorktree = await materializePrWorktree("test/repo", 8, base);
      await Bun.write(join(ignoredWorktree, "ignored.txt"), "local ignored content\\n");
      let ignoredMessage = "";
      try {
        await materializePrWorktree("test/repo", 8, next);
      } catch (err) {
        ignoredMessage = err instanceof Error ? err.message : String(err);
      }
      if (!ignoredMessage.includes("uncommitted changes")) throw new Error(ignoredMessage || "ignored-path update unexpectedly succeeded");
      if ((await Bun.file(join(ignoredWorktree, "ignored.txt")).text()) !== "local ignored content\\n") throw new Error("ignored local file was overwritten");

      const firstHead = materializePrWorktree("test/repo", 9, base);
      const latestHead = materializePrWorktree("test/repo", 9, next);
      const [, concurrentWorktree] = await Promise.all([firstHead, latestHead]);
      if (git(concurrentWorktree, "rev-parse", "HEAD") !== next) throw new Error("concurrent materialization did not finish at the latest requested head");

      pruneMirrors([]);
      if (git(mirror, "rev-parse", "HEAD") !== next) throw new Error("mirror with managed worktrees was pruned");
      if (git(worktree, "rev-parse", "HEAD") !== local) throw new Error("locally committed worktree became unusable after pruning");
    `;
    const result = Bun.spawnSync([process.execPath, "-e", scenario], {
      env: { ...process.env, COCKPIT_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
