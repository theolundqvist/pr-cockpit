import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reportInstallFailure } from "./installFailure.ts";

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
  const reportCalls = join(home, "sentry-report-calls");
  writeFileSync(reportCalls, "");
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "ui"), { recursive: true });
  mkdirSync(join(root, "shell"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  copyFileSync(join(import.meta.dir, "install"), join(root, "scripts/install"));
  for (const name of ["cockpit", "ensure-electron-dist.sh", "install-linux", "make-app.sh", "pr-cockpit"]) {
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
    ["bun", `if [[ "\${1:-}" == */scripts/installFailure.ts ]]; then printf '%s\\n' "$*" >> ${JSON.stringify(reportCalls)}; [[ "\${COCKPIT_TEST_HANG_SENTRY_REPORTER:-0}" != "1" ]] || sleep 60; exit 0; fi
if [[ "\${COCKPIT_TEST_FAIL_BUN_INSTALL:-0}" == "1" && "\${1:-}" == "install" ]]; then exit 7; fi
exit 0`],
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
  return { root, calls, curlCalls, reportCalls, path: `${bin}:/usr/bin:/bin:/usr/sbin` };
}

async function install(
  loadedRoot: string | null,
  options: { platform?: "Darwin" | "Linux"; proxy?: string; healthRoot?: string; tailscalePort?: string; failInstall?: boolean; hangReporter?: boolean } = {},
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
        ...(options.tailscalePort ? {
          COCKPIT_TAILSCALE_SERVE: "1",
          COCKPIT_TAILSCALE_HTTPS_PORT: options.tailscalePort,
        } : {}),
        ...(options.failInstall ? { COCKPIT_TEST_FAIL_BUN_INSTALL: "1" } : {}),
        ...(options.hangReporter ? { COCKPIT_TEST_HANG_SENTRY_REPORTER: "1" } : {}),
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
    const reportCalls = readFileSync(fake.reportCalls, "utf8");
    const serverPlistPath = join(installHome, "Library/LaunchAgents/app.pr-cockpit.server.plist");
    const serverPlist = existsSync(serverPlistPath) ? readFileSync(serverPlistPath, "utf8") : "";
    const configPath = join(installHome, ".config/pr-cockpit/config");
    const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
    return {
      stdout,
      stderr,
      exitCode,
      calls,
      curlCalls,
      reportCalls,
      root: fake.root,
      serverPlist,
      config,
      localBin: join(installHome, ".local/bin"),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("Linux install delegates before any macOS registration or checkout build", async () => {
  const result = await install(null, { platform: "Linux" });
  expect(result.exitCode).toBe(0);
  expect(result.calls).toBe("");
  expect(result.serverPlist).toBe("");
});

test("new config is a commented inert example", async () => {
  const result = await install(null);
  expect(result.exitCode).toBe(0);
  expect(result.config).toContain('# COCKPIT_PROXY="build-server"');
  expect(result.config).not.toContain("Agents mutate existing PRs");
  expect(result.config).not.toMatch(/^[^#\n]*COCKPIT_PROXY=/m);
  expect(result.serverPlist).not.toContain("COCKPIT_TAILSCALE");
});

test("a failed macOS installation reports its stage without delaying exit", async () => {
  const startedAt = performance.now();
  const result = await install(null, { failInstall: true, hangReporter: true });
  expect(result.exitCode).toBe(7);
  expect(result.reportCalls).toContain("scripts/installFailure.ts Install dependencies 7 Darwin");
  expect(performance.now() - startedAt).toBeLessThan(3_000);
}, 10_000);

test("installer failure reporting sends one Sentry envelope unless disabled", async () => {
  let endpoint = "";
  let envelope = "";
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      endpoint = new URL(request.url).pathname;
      envelope = await request.text();
      return new Response(null, { status: 200 });
    },
  });
  try {
    await reportInstallFailure({ stage: "Build UI", status: 7, platform: "Darwin" }, "");
    expect(envelope).toBe("");
    await reportInstallFailure(
      { stage: "Build UI", status: 7, platform: "Darwin" },
      `http://public@127.0.0.1:${server.port}/42`,
    );
    const [header, item, event] = envelope.split("\n").map((line) => JSON.parse(line));
    expect(endpoint).toBe("/api/42/envelope/");
    expect(header.dsn).toBe(`http://public@127.0.0.1:${server.port}/42`);
    expect(item).toEqual({ type: "event" });
    expect(event.message).toBe("Installation failed during Build UI (exit 7)");
    expect(event.tags).toEqual({
      component: "installer",
      install_stage: "Build UI",
      install_status: "7",
      install_platform: "Darwin",
    });
  } finally {
    server.stop(true);
  }
});

test("Linux lifecycle reports initialization failures without their raw error", async () => {
  let envelope = "";
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      envelope = await request.text();
      return new Response(null, { status: 200 });
    },
  });
  try {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "linux-lifecycle.ts"), "install", "/tmp/source"], {
      env: {
        ...process.env,
        HOME: "",
        COCKPIT_SENTRY_DSN: `http://public@127.0.0.1:${server.port}/42`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const event = JSON.parse(envelope.split("\n")[2]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Linux lifecycle must not run as root|HOME must name a non-root absolute user home/);
    expect(event.message).toBe("Installation failed during install (exit 1)");
    expect(event.message).not.toContain("HOME");
  } finally {
    server.stop(true);
  }
});

test("a Tailscale Serve install persists the opt-in launch environment", async () => {
  const result = await install(null, { tailscalePort: "8443" });
  expect(result.exitCode).toBe(0);
  expect(result.serverPlist).toContain("<string>COCKPIT_TAILSCALE_SERVE=1</string>");
  expect(result.serverPlist).toContain("<string>COCKPIT_TAILSCALE_HTTPS_PORT=8443</string>");
}, 10_000);

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
