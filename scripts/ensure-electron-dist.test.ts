import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ensureScript = join(import.meta.dir, "ensure-electron-dist.sh");

test("repairs an extract-zip Electron.app missing Info.plist", async () => {
  const root = mkdtempSync(join(tmpdir(), "ensure-electron-"));
  try {
    const electronDir = join(root, "shell/node_modules/electron");
    const version = "1.2.3";
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const cache = join(root, "Library/Caches/electron/test");
    const bin = join(root, "bin");
    mkdirSync(join(electronDir, "dist/Electron.app/Contents/MacOS"), { recursive: true });
    mkdirSync(cache, { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(electronDir, "package.json"), JSON.stringify({ version }));
    writeFileSync(join(electronDir, "dist/Electron.app/Contents/MacOS/Electron"), "");
    writeFileSync(join(cache, `electron-v${version}-darwin-${arch}.zip`), "");
    writeFileSync(
      join(bin, "ditto"),
      `#!/usr/bin/env bash
set -euo pipefail
destination="\${@: -1}"
mkdir -p "$destination/Electron.app/Contents/Frameworks"
mkdir -p "$destination/Electron.app/Contents/MacOS"
touch "$destination/Electron.app/Contents/Info.plist"
touch "$destination/Electron.app/Contents/MacOS/Electron"
`,
      { mode: 0o755 },
    );

    const proc = Bun.spawn(["bash", ensureScript, root], {
      env: { ...process.env, HOME: root, PATH: `${bin}:/usr/bin:/bin` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("repairing incomplete Electron.app");
    expect(existsSync(join(electronDir, "dist/Electron.app/Contents/Info.plist"))).toBe(true);
    expect(existsSync(join(electronDir, "dist/Electron.app/Contents/Frameworks"))).toBe(true);
    expect(readFileSync(join(electronDir, "path.txt"), "utf8")).toBe("Electron.app/Contents/MacOS/Electron\n");
    expect(readFileSync(join(electronDir, "dist/version"), "utf8")).toBe(`v${version}\n`);
    expect(stderr).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
