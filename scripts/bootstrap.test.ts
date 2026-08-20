import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function stubbedPath(dir: string) {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of [
    ["uname", 'printf "Darwin\\n"'],
    ["git", "exit 0"],
    ["bun", "exit 0"],
    ["gh", "exit 0"],
  ] as const) {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path, 0o755);
  }
  return `${bin}:/usr/bin:/bin`;
}

test("a fresh install reaches the install stage", async () => {
  const home = mkdtempSync(join(tmpdir(), "cockpit-bootstrap-"));
  try {
    const bootstrap = Bun.spawn([join(import.meta.dir, "bootstrap")], {
      env: {
        PATH: stubbedPath(home),
        HOME: join(home, "home"),
        COCKPIT_HOME: join(home, "checkout"),
        COCKPIT_BOOTSTRAP_DRY_RUN: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, error, exitCode] = await Promise.all([
      new Response(bootstrap.stdout).text(),
      new Response(bootstrap.stderr).text(),
      bootstrap.exited,
    ]);
    expect(error).toBe("");
    expect(exitCode).toBe(0);
    expect(output).toContain("[3/3] Install PR Cockpit");
    expect(output).toContain(join(home, "checkout", "scripts/install"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
