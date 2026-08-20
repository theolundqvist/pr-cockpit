import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "scripts", "update-pull");

function git(cwd: string, args: string[]): void {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
  if (!proc.success) throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
}

function commit(cwd: string, file: string, body: string): void {
  writeFileSync(join(cwd, file), body);
  git(cwd, ["add", "-A"]);
  git(cwd, ["commit", "-q", "-m", body]);
}

// a checkout that runs the real update-pull against a local "origin", exercised offline via file remotes
function makeCheckout(): { work: string; origin: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "update-pull-"));
  const origin = join(dir, "origin.git");
  const work = join(dir, "work");
  git(dir, ["init", "-q", "--bare", "-b", "main", origin]);

  const seed = join(dir, "seed");
  mkdirSync(seed);
  git(seed, ["init", "-q", "-b", "main"]);
  git(seed, ["config", "user.email", "t@t.t"]);
  git(seed, ["config", "user.name", "t"]);
  commit(seed, "app.ts", "v1");
  git(seed, ["remote", "add", "origin", origin]);
  git(seed, ["push", "-q", "origin", "main"]);

  git(dir, ["clone", "-q", origin, work]);
  git(work, ["config", "user.email", "t@t.t"]);
  git(work, ["config", "user.name", "t"]);
  mkdirSync(join(work, "scripts"));
  cpSync(SCRIPT, join(work, "scripts", "update-pull"), { mode: 0o755 });

  return { work, origin, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(work: string): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync([join(work, "scripts", "update-pull")], { cwd: work, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, stdout: proc.stdout.toString().trim(), stderr: proc.stderr.toString().trim() };
}

describe("update-pull", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });
  const checkout = () => {
    const c = makeCheckout();
    cleanups.push(c.cleanup);
    return c;
  };

  function advanceOrigin(origin: string): void {
    const dir = mkdtempSync(join(tmpdir(), "update-pull-push-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    git(dir, ["clone", "-q", origin, "."]);
    git(dir, ["config", "user.email", "t@t.t"]);
    git(dir, ["config", "user.name", "t"]);
    commit(dir, "app.ts", "v2-remote");
    git(dir, ["push", "-q", "origin", "main"]);
  }

  test("up-to-date is a clean no-op", () => {
    const { work } = checkout();
    const r = run(work);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("noop");
  });

  test("local ahead of origin is a clean no-op", () => {
    const { work } = checkout();
    commit(work, "local.ts", "local-only");
    const r = run(work);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("noop");
  });

  test("behind origin fast-forwards", () => {
    const { work, origin } = checkout();
    advanceOrigin(origin);
    const before = Bun.spawnSync(["git", "-C", work, "rev-parse", "HEAD"]).stdout.toString().trim();
    const r = run(work);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("updated");
    const after = Bun.spawnSync(["git", "-C", work, "rev-parse", "HEAD"]).stdout.toString().trim();
    expect(after).not.toBe(before);
  });

  test("diverged history fails without touching the working tree", () => {
    const { work, origin } = checkout();
    commit(work, "local.ts", "local-diverge");
    advanceOrigin(origin);
    const before = Bun.spawnSync(["git", "-C", work, "rev-parse", "HEAD"]).stdout.toString().trim();
    const r = run(work);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("diverged");
    const after = Bun.spawnSync(["git", "-C", work, "rev-parse", "HEAD"]).stdout.toString().trim();
    expect(after).toBe(before);
  });
});
