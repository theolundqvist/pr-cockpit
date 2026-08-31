import { expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ensureScript = join(import.meta.dir, "ensure-electron-dist.sh");

function electronVersion(): string {
  const pkg = readFileSync(join(import.meta.dir, "../shell/node_modules/electron/package.json"), "utf8");
  const match = pkg.match(/"version":\s*"([^"]+)"/);
  if (!match) throw new Error("electron version not found");
  return match[1];
}

function cachedZip(version: string): string | null {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const name = `electron-v${version}-darwin-${arch}.zip`;
  const proc = Bun.spawn(["bash", "-lc", `find "${process.env.HOME}/Library/Caches/electron" -name ${JSON.stringify(name)} -print -quit 2>/dev/null`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return new Response(proc.stdout).text().then((text) => text.trim() || null);
}

test("repairs an extract-zip Electron.app missing Info.plist", async () => {
  const version = electronVersion();
  const zip = await cachedZip(version);
  if (!zip) {
    console.warn(`skipping: no cached ${zip ?? "electron zip"}`);
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "ensure-electron-"));
  try {
    const electronDir = join(root, "shell/node_modules/electron");
    mkdirSync(join(electronDir, "dist/Electron.app/Contents/MacOS"), { recursive: true });
    writeFileSync(join(electronDir, "package.json"), JSON.stringify({ version }));
    writeFileSync(join(electronDir, "dist/Electron.app/Contents/MacOS/Electron"), "");

    const proc = Bun.spawn(["bash", ensureScript, root], {
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
    expect(stderr).toBe("");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("example config uses a quoted heredoc and stays commented", () => {
  const install = readFileSync(join(import.meta.dir, "install"), "utf8");
  expect(install).toContain("<<'EXAMPLE'");
  expect(install).not.toMatch(/cat > "\$config_file" <<EXAMPLE/);
  expect(install).not.toContain("Agents mutate existing PRs");
  expect(install).toContain('# COCKPIT_PROXY="build-server"');
});
