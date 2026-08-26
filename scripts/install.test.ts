import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const uid = process.getuid?.() ?? 0;

// The installer only reaches its LaunchAgent logic through the real script, so the
// harness fakes a checkout plus the binaries it shells out to.
function fakeInstall(home: string, loadedRoot: string | null) {
  const root = join(home, "checkout");
  const bin = join(home, "bin");
  const calls = join(home, "launchctl-calls");
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "ui"), { recursive: true });
  mkdirSync(join(root, "shell"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  copyFileSync(join(import.meta.dir, "install"), join(root, "scripts/install"));
  for (const name of ["cockpit", "make-app.sh", "pr-cockpit"]) {
    writeFileSync(join(root, "scripts", name), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(root, "scripts", name), 0o755);
  }
  chmodSync(join(root, "scripts/install"), 0o755);

  // the installer resolves its own root with pwd -P, and compares that string
  const resolved = loadedRoot === "__ROOT__" ? realpathSync(root) : loadedRoot;
  const rendererPrint = resolved === null
    ? "exit 1"
    : `printf 'gui/${uid}/app.pr-cockpit = {\\n\\tstate = running\\n\\targuments = {\\n\\t\\tCOCKPIT_ROOT=${resolved}\\n\\t}\\n}\\n'`;
  for (const [name, body] of [
    ["bun", "exit 0"],
    ["gh", "exit 0"],
    // the readiness probe needs the server agent to own the listening port
    ["lsof", 'printf "4242\\n"'],
    ["curl", `printf '{"root":"${realpathSync(root)}"}'`],
    [
      "launchctl",
      `printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
if [[ "$1" == print && "$2" == */app.pr-cockpit.server ]]; then
  printf '\\tpid = 4242\\n'
  exit 0
fi
if [[ "$1" == print && "$2" == */app.pr-cockpit ]]; then
  ${rendererPrint}
fi
exit 0`,
    ],
  ] as const) {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path, 0o755);
  }
  return { root, calls, path: `${bin}:/usr/bin:/bin:/usr/sbin` };
}

async function install(loadedRoot: string | null) {
  const home = mkdtempSync(join(tmpdir(), "cockpit-install-"));
  try {
    const fake = fakeInstall(home, loadedRoot);
    const proc = Bun.spawn([join(fake.root, "scripts/install")], {
      env: { PATH: fake.path, HOME: join(home, "home"), COCKPIT_PORT: "4820" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const calls = readFileSync(fake.calls, "utf8");
    const serverPlist = readFileSync(join(home, "home", "Library/LaunchAgents/app.pr-cockpit.server.plist"), "utf8");
    return { stdout, stderr, exitCode, calls, root: fake.root, serverPlist, localBin: join(home, "home/.local/bin") };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("an app registration left behind by another root is replaced", async () => {
  const result = await install("/tmp/some-other-checkout");
  expect(result.exitCode).toBe(0);
  // a loaded job keeps its own environment, so the stale one must be booted out
  expect(result.stdout).toContain("replacing the app registration for /tmp/some-other-checkout");
  expect(result.calls).toContain(`bootout gui/${uid}/app.pr-cockpit\n`);
  expect(result.calls).toContain(`bootstrap gui/${uid} `);
  expect(result.calls).toContain("Library/LaunchAgents/app.pr-cockpit.plist");
  expect(result.serverPlist).toContain(`<string>PATH=${result.localBin}:`);
});

test("no loaded registration bootstraps the app", async () => {
  const result = await install(null);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).not.toContain("replacing the app registration");
  expect(result.calls).not.toContain(`bootout gui/${uid}/app.pr-cockpit\n`);
  expect(result.calls).toContain("Library/LaunchAgents/app.pr-cockpit.plist");
});

test("a registration for this root keeps the running window", async () => {
  const result = await install("__ROOT__");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("preserving running app");
  // an update restarts the server only; the live window reloads its assets itself
  expect(result.calls).not.toContain(`bootout gui/${uid}/app.pr-cockpit\n`);
  expect(result.calls).not.toContain("LaunchAgents/app.pr-cockpit.plist");
  expect(result.calls).toContain("app.pr-cockpit.server.plist");
});
