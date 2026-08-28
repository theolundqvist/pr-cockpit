import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const uid = process.getuid?.() ?? 0;

// The installer only reaches its LaunchAgent logic through the real script, so the
// harness fakes a checkout plus the binaries it shells out to.
function fakeInstall(
  home: string,
  loadedRoot: string | null,
  platform: "Darwin" | "Linux",
  healthRoot?: string,
) {
  const root = join(home, "checkout");
  const bin = join(home, "bin");
  const calls = join(home, "launchctl-calls");
  writeFileSync(calls, "");
  const curlCalls = join(home, "curl-calls");
  writeFileSync(curlCalls, "");
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
    ["uname", `printf '${platform}\\n'`],
    ["gh", "exit 0"],
    // the readiness probe needs the server agent to own the listening port
    ["lsof", 'printf "4242\\n"'],
    ["curl", `printf '%s\\n' "$*" >> ${JSON.stringify(curlCalls)}; printf '{"root":"${healthRoot ?? realpathSync(root)}"}'`],
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
  return { root, calls, curlCalls, path: `${bin}:/usr/bin:/bin:/usr/sbin` };
}

async function install(
  loadedRoot: string | null,
  options: { platform?: "Darwin" | "Linux"; proxy?: string; healthRoot?: string } = {},
) {
  const home = mkdtempSync(join(tmpdir(), "cockpit-install-"));
  try {
    const fake = fakeInstall(home, loadedRoot, options.platform ?? "Darwin", options.healthRoot);
    const installHome = join(home, "home");
    const proc = Bun.spawn([join(fake.root, "scripts/install")], {
      env: {
        PATH: fake.path,
        HOME: installHome,
        COCKPIT_PORT: "4820",
        ...(options.proxy ? { COCKPIT_PROXY: options.proxy } : {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const calls = readFileSync(fake.calls, "utf8");
    const curlCalls = readFileSync(fake.curlCalls, "utf8");
    const serverPlistPath = join(installHome, "Library/LaunchAgents/app.pr-cockpit.server.plist");
    const serverPlist = existsSync(serverPlistPath) ? readFileSync(serverPlistPath, "utf8") : "";
    return {
      stdout,
      stderr,
      exitCode,
      calls,
      curlCalls,
      root: fake.root,
      serverPlist,
      localBin: join(installHome, ".local/bin"),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("headless Linux install builds server assets without macOS registration", async () => {
  const result = await install(null, { platform: "Linux" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("[3/3] Build UI");
  expect(result.stdout).toContain("headless server build is ready");
  expect(result.calls).toBe("");
  expect(result.serverPlist).toBe("");
});

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

test("replica installation restarts the local server", async () => {
  const result = await install("__ROOT__", {
    proxy: "root@dev-vm",
  });
  expect(result.exitCode).toBe(0);
  expect(result.curlCalls).toContain("-X POST http://127.0.0.1:4820/api/shutdown");
  expect(result.serverPlist).toContain("<key>KeepAlive</key>");
  expect(result.serverPlist).toContain("<string>--server-only</string>");
  expect(result.serverPlist).toContain("<string>COCKPIT_REPLICA_SSH_HOST=root@dev-vm</string>");
  expect(result.serverPlist).toMatch(/<string>COCKPIT_LAUNCHER=.*\/Library\/Application Support\/PR Cockpit\/launch<\/string>/);
});
