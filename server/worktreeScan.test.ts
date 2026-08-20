import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLocalCheckoutMap, buildWorktreeMap, matchWindowIds, originRepo } from "./worktreeProbe.ts";
import { createWorktreeScanRunner } from "./worktreeScanRunner.ts";

function git(root: string, args: string[]): void {
  const proc = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "ignore", stderr: "ignore" });
  if (!proc.success) throw new Error(`git ${args.join(" ")} failed in ${root}`);
}

function makeCheckout(root: string, originUrl: string | null): void {
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-q"]);
  git(root, ["commit", "--allow-empty", "-q", "-m", "init"]);
  git(root, ["checkout", "-q", "-B", "main"]);
  if (originUrl) git(root, ["remote", "add", "origin", originUrl]);
}

function addWorktree(root: string, path: string, branch: string): void {
  git(root, ["worktree", "add", "-q", "-b", branch, path]);
}

describe("originRepo", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("parses owner/repo from an ssh origin url", async () => {
    dir = mkdtempSync(join(tmpdir(), "wtscan-origin-"));
    makeCheckout(dir, "git@github.com:acme/widgets.git");
    expect(await originRepo(dir)).toBe("acme/widgets");
  });

  test("parses owner/repo from an https origin url", async () => {
    dir = mkdtempSync(join(tmpdir(), "wtscan-origin-"));
    makeCheckout(dir, "https://github.com/acme/widgets.git");
    expect(await originRepo(dir)).toBe("acme/widgets");
  });

  test("returns null when there is no origin remote", async () => {
    dir = mkdtempSync(join(tmpdir(), "wtscan-origin-"));
    makeCheckout(dir, null);
    expect(await originRepo(dir)).toBeNull();
  });
});

describe("buildWorktreeMap", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("enumerates every linked worktree of a tmux-seeded repo", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "wtscan-map-")));
    const primary = join(dir, "widgets");
    makeCheckout(primary, "git@github.com:acme/widgets.git");
    addWorktree(primary, join(dir, "widgets-feature"), "feature-a");

    const map = await buildWorktreeMap([], [primary], new Set(["acme/widgets"]));
    expect(map.get("acme/widgets\nmain")).toBe(primary);
    expect(map.get("acme/widgets\nfeature-a")).toBe(join(dir, "widgets-feature"));
  });

  test("resolves a nested subdirectory pane path to the same repo, not just the worktree root", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "wtscan-map-")));
    const primary = join(dir, "widgets");
    makeCheckout(primary, "git@github.com:acme/widgets.git");
    const nested = join(primary, "src", "nested");
    mkdirSync(nested, { recursive: true });

    const map = await buildWorktreeMap([], [nested], new Set(["acme/widgets"]));
    expect(map.get("acme/widgets\nmain")).toBe(primary);
  });

  test("filters tmux-seeded roots to repos with tracked PRs", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "wtscan-map-")));
    const untracked = join(dir, "untracked");
    makeCheckout(untracked, "git@github.com:acme/untracked.git");

    const map = await buildWorktreeMap([], [untracked], new Set(["acme/widgets"]));
    expect(map.size).toBe(0);
  });

  test("override roots bypass the tracked-repo filter", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "wtscan-map-")));
    const untracked = join(dir, "untracked");
    makeCheckout(untracked, "git@github.com:acme/untracked.git");

    const map = await buildWorktreeMap([untracked], [], new Set(["acme/widgets"]));
    expect(map.get("acme/untracked\nmain")).toBe(untracked);
  });

  test("multiple pane paths into the same clone still produce every worktree exactly once", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "wtscan-map-")));
    const primary = join(dir, "widgets");
    makeCheckout(primary, "git@github.com:acme/widgets.git");
    addWorktree(primary, join(dir, "widgets-feature"), "feature-a");

    const map = await buildWorktreeMap([], [primary, join(dir, "widgets-feature")], new Set(["acme/widgets"]));
    expect(map.size).toBe(2);
  });
});

describe("buildLocalCheckoutMap", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("records the branch checked out in the primary local checkout", async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "wtscan-local-")));
    const primary = join(dir, "widgets");
    makeCheckout(primary, "git@github.com:acme/widgets.git");
    git(primary, ["checkout", "-q", "-b", "feature-a"]);

    const checkouts = await buildLocalCheckoutMap([], [primary], new Set(["acme/widgets"]));

    expect(checkouts.get("acme/widgets")).toEqual({ path: primary, branch: "feature-a" });
  });
});

describe("matchWindowIds", () => {
  test("matches a pane cwd exactly at the worktree root", () => {
    const result = matchWindowIds([{ windowId: "@1", path: "/repo/widgets" }], ["/repo/widgets"]);
    expect(result.get("/repo/widgets")).toBe("@1");
  });

  test("matches a pane cwd nested under the worktree root", () => {
    const result = matchWindowIds([{ windowId: "@1", path: "/repo/widgets/src/lib" }], ["/repo/widgets"]);
    expect(result.get("/repo/widgets")).toBe("@1");
  });

  test("picks the most specific (longest) worktree path, not a shorter prefix", () => {
    const result = matchWindowIds(
      [{ windowId: "@1", path: "/repo/widgets/.claude/worktrees/agent-a/src" }],
      ["/repo/widgets", "/repo/widgets/.claude/worktrees/agent-a"],
    );
    expect(result.get("/repo/widgets/.claude/worktrees/agent-a")).toBe("@1");
    expect(result.has("/repo/widgets")).toBe(false);
  });

  test("first pane wins when two panes land in the same worktree", () => {
    const result = matchWindowIds(
      [
        { windowId: "@1", path: "/repo/widgets" },
        { windowId: "@2", path: "/repo/widgets" },
      ],
      ["/repo/widgets"],
    );
    expect(result.get("/repo/widgets")).toBe("@1");
  });

  test("unmatched panes are dropped", () => {
    const result = matchWindowIds([{ windowId: "@1", path: "/somewhere/else" }], ["/repo/widgets"]);
    expect(result.size).toBe(0);
  });
});

test("a hung scanner is killed without blocking HTTP", async () => {
  const workerUrl = URL.createObjectURL(new Blob(["onmessage = () => { while (true) {} };"], { type: "text/javascript" }));
  const runScan = createWorktreeScanRunner(() => new Worker(workerUrl), 100);
  const server = Bun.serve({ port: 0, fetch: () => new Response("healthy") });
  try {
    const scan = runScan({ overrideRoots: [], matchRepos: [] });
    const response = await fetch(server.url);
    expect(await response.text()).toBe("healthy");
    expect(await scan).toBeNull();
  } finally {
    server.stop(true);
    URL.revokeObjectURL(workerUrl);
  }
});
