import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UPDATE_SCRIPT = join(import.meta.dir, "..", "scripts", "update");
const COCKPIT_SCRIPT = join(import.meta.dir, "..", "scripts", "cockpit");

function git(cwd: string, args: string[]): void {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "ignore", stderr: "ignore" });
  if (!proc.success) throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
}

describe("update handoff", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  test("exits non-zero with UPDATE_FAILED and never relaunches when update-pull fails", () => {
    const root = mkdtempSync(join(tmpdir(), "update-handoff-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "t@t.t"]);
    git(root, ["config", "user.name", "t"]);
    writeFileSync(join(root, "app.ts"), "seed\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "seed"]);

    mkdirSync(join(root, "scripts"));
    cpSync(UPDATE_SCRIPT, join(root, "scripts", "update"), { mode: 0o755 });
    writeFileSync(join(root, "scripts", "update-pull"), '#!/usr/bin/env bash\necho "boom reason" >&2\nexit 1\n');
    chmodSync(join(root, "scripts", "update-pull"), 0o755);
    // a relaunch would exec this - the sentinel proves whether it ran
    const relaunchMarker = join(root, "relaunched");
    writeFileSync(join(root, "scripts", "cockpit"), `#!/usr/bin/env bash\ntouch ${JSON.stringify(relaunchMarker)}\n`);
    chmodSync(join(root, "scripts", "cockpit"), 0o755);

    const proc = Bun.spawnSync([join(root, "scripts", "update")], {
      cwd: root,
      env: { ...process.env, COCKPIT_DATA_DIR: join(root, "data") },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr.toString()).toContain("UPDATE_FAILED boom reason");
    expect(existsSync(relaunchMarker)).toBe(false);
  });

  test("reconciles the full install before relaunching after a successful pull", () => {
    const root = mkdtempSync(join(tmpdir(), "update-handoff-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "t@t.t"]);
    git(root, ["config", "user.name", "t"]);
    writeFileSync(join(root, "app.ts"), "seed\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "seed"]);

    mkdirSync(join(root, "scripts"));
    cpSync(UPDATE_SCRIPT, join(root, "scripts", "update"), { mode: 0o755 });
    writeFileSync(join(root, "scripts", "update-pull"), "#!/usr/bin/env bash\necho noop\n");
    chmodSync(join(root, "scripts", "update-pull"), 0o755);
    const order = join(root, "order");
    writeFileSync(join(root, "scripts", "install"), `#!/usr/bin/env bash\necho install >> ${JSON.stringify(order)}\n`);
    chmodSync(join(root, "scripts", "install"), 0o755);
    writeFileSync(join(root, "scripts", "cockpit"), `#!/usr/bin/env bash\necho cockpit >> ${JSON.stringify(order)}\n`);
    chmodSync(join(root, "scripts", "cockpit"), 0o755);

    const proc = Bun.spawnSync([join(root, "scripts", "update")], {
      cwd: root,
      env: { ...process.env, COCKPIT_DATA_DIR: join(root, "data") },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(proc.exitCode).toBe(0);
    expect(readFileSync(order, "utf8")).toBe("install\ncockpit\n");
  });

  test("relaunches last-good without retrying a failed reconciliation", () => {
    const root = mkdtempSync(join(tmpdir(), "update-handoff-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "t@t.t"]);
    git(root, ["config", "user.name", "t"]);
    writeFileSync(join(root, "app.ts"), "seed\n");
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "seed"]);

    mkdirSync(join(root, "scripts"));
    cpSync(UPDATE_SCRIPT, join(root, "scripts", "update"), { mode: 0o755 });
    writeFileSync(join(root, "scripts", "update-pull"), "#!/usr/bin/env bash\necho noop\n");
    chmodSync(join(root, "scripts", "update-pull"), 0o755);
    const order = join(root, "order");
    writeFileSync(join(root, "scripts", "install"), `#!/usr/bin/env bash
echo install >> ${JSON.stringify(order)}
exit 1
`);
    chmodSync(join(root, "scripts", "install"), 0o755);
    writeFileSync(
      join(root, "scripts", "cockpit"),
      `#!/usr/bin/env bash\necho "cockpit:\${COCKPIT_SKIP_RECONCILE:-0}" >> ${JSON.stringify(order)}\n`,
    );
    chmodSync(join(root, "scripts", "cockpit"), 0o755);

    const proc = Bun.spawnSync([join(root, "scripts", "update")], {
      cwd: root,
      env: { ...process.env, COCKPIT_DATA_DIR: join(root, "data") },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(proc.exitCode).toBe(0);
    expect(readFileSync(order, "utf8")).toBe("install\ncockpit:1\n");
  });

  test("accepts only servers owned by this checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "cockpit-port-owner-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const fakeBin = join(root, "bin");
    const home = join(root, "home");
    const opened = join(root, "opened");
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "static"));
    mkdirSync(fakeBin);
    mkdirSync(home);
    writeFileSync(join(root, "static", "index.html"), "ready\n");
    cpSync(COCKPIT_SCRIPT, join(root, "scripts", "cockpit"), { mode: 0o755 });
    writeFileSync(join(fakeBin, "launchctl"), "#!/usr/bin/env bash\necho 'pid = 111'\n");
    writeFileSync(join(fakeBin, "lsof"), "#!/usr/bin/env bash\necho 222\n");
    writeFileSync(join(fakeBin, "open"), `#!/usr/bin/env bash\ntouch ${JSON.stringify(opened)}\n`);
    for (const command of ["launchctl", "lsof", "open"]) chmodSync(join(fakeBin, command), 0o755);
    const env = {
      ...process.env,
      HOME: home,
      COCKPIT_ROOT: root,
      COCKPIT_PORT: "49876",
      COCKPIT_NO_BUILD: "1",
      COCKPIT_SKIP_RECONCILE: "1",
      PATH: `${fakeBin}:${process.env.PATH}`,
    };

    for (const health of ['{"root":"/another/checkout"}', '{"lastPollAt":null,"prCount":1}']) {
      writeFileSync(join(fakeBin, "curl"), `#!/usr/bin/env bash\nprintf '%s' ${JSON.stringify(health)}\n`);
      chmodSync(join(fakeBin, "curl"), 0o755);
      const proc = Bun.spawnSync([join(root, "scripts", "cockpit"), "--show"], {
        cwd: root,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(proc.exitCode).toBe(1);
      expect(proc.stderr.toString()).toContain("port 49876 is serving a different instance");
      expect(existsSync(opened)).toBe(false);
    }

    writeFileSync(join(fakeBin, "lsof"), "#!/usr/bin/env bash\necho 111\n");
    writeFileSync(join(fakeBin, "curl"), '#!/usr/bin/env bash\nprintf \'{"lastPollAt":null,"prCount":1}\'\n');
    const owned = Bun.spawnSync([join(root, "scripts", "cockpit"), "--show"], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(owned.exitCode).toBe(0);
    expect(existsSync(opened)).toBe(true);
  });

  test("new source launcher finishes an old updater's installation handoff once", () => {
    const root = mkdtempSync(join(tmpdir(), "update-bootstrap-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const canonicalRoot = realpathSync(root);
    const home = join(root, "home");
    const fakeBin = join(root, "bin");
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "static"));
    mkdirSync(home);
    mkdirSync(fakeBin);
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "t@t.t"]);
    git(root, ["config", "user.name", "t"]);
    writeFileSync(join(root, "app.ts"), "seed\n");
    writeFileSync(join(root, "static", "index.html"), "ready\n");
    cpSync(COCKPIT_SCRIPT, join(root, "scripts", "cockpit"), { mode: 0o755 });
    git(root, ["add", "-A"]);
    git(root, ["commit", "-q", "-m", "seed"]);

    const order = join(root, "order");
    writeFileSync(join(root, "scripts", "install"), `#!/usr/bin/env bash
set -e
echo install >> ${JSON.stringify(order)}
if [[ -f ${JSON.stringify(join(root, "fail-install"))} ]]; then exit 1; fi
mkdir -p "$HOME/Library/Application Support/PR Cockpit"
git -C ${JSON.stringify(root)} rev-parse HEAD > "$HOME/Library/Application Support/PR Cockpit/installed-rev"
`);
    chmodSync(join(root, "scripts", "install"), 0o755);
    writeFileSync(join(fakeBin, "gh"), "#!/usr/bin/env bash\nexit 0\n");
    writeFileSync(join(fakeBin, "bun"), `#!/usr/bin/env bash\ntouch ${JSON.stringify(join(root, "healthy"))}\n`);
    writeFileSync(join(fakeBin, "curl"), `#!/usr/bin/env bash
if [[ -f ${JSON.stringify(join(root, "health-down"))} && ! -f ${JSON.stringify(join(root, "healthy"))} ]]; then exit 1; fi
printf '{"root":"%s"}' ${JSON.stringify(canonicalRoot)}
`);
    writeFileSync(join(fakeBin, "launchctl"), "#!/usr/bin/env bash\nexit 1\n");
    writeFileSync(join(fakeBin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
    for (const command of ["bun", "gh", "curl", "launchctl", "sleep"]) chmodSync(join(fakeBin, command), 0o755);
    writeFileSync(join(fakeBin, "open"), `#!/usr/bin/env bash\necho open >> ${JSON.stringify(order)}\n`);
    chmodSync(join(fakeBin, "open"), 0o755);
    const env = {
      ...process.env,
      HOME: home,
      COCKPIT_ROOT: `${root}/.`,
      PATH: `${fakeBin}:${process.env.PATH}`,
      COCKPIT_DATA_DIR: join(root, "data"),
    };

    const first = Bun.spawnSync([join(root, "scripts", "cockpit"), "--managed-server", "--show"], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (first.exitCode !== 0) throw new Error(first.stderr.toString() || first.stdout.toString());
    expect(first.exitCode).toBe(0);
    expect(readFileSync(order, "utf8")).toBe("install\nopen\n");

    const second = Bun.spawnSync([join(root, "scripts", "cockpit"), "--managed-server", "--show"], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(second.exitCode).toBe(0);
    expect(readFileSync(order, "utf8")).toBe("install\nopen\nopen\n");

    const runtimeDir = join(home, "Library", "Application Support", "PR Cockpit");
    const runtimeLauncher = join(runtimeDir, "launch");
    cpSync(COCKPIT_SCRIPT, runtimeLauncher, { mode: 0o755 });
    writeFileSync(join(runtimeDir, "installed-rev"), "stale\n");
    const runtime = Bun.spawnSync([runtimeLauncher, "--managed-server", "--show"], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(runtime.exitCode).toBe(0);
    expect(readFileSync(order, "utf8")).toBe("install\nopen\nopen\nopen\n");

    const noFlagHandoff = Bun.spawnSync([join(root, "scripts", "cockpit")], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(noFlagHandoff.exitCode).toBe(0);
    expect(readFileSync(order, "utf8")).toBe("install\nopen\nopen\nopen\ninstall\nopen\n");

    writeFileSync(join(runtimeDir, "installed-rev"), "stale\n");
    const electronDir = join(root, "shell", "PR Cockpit.app", "Contents", "MacOS");
    mkdirSync(electronDir, { recursive: true });
    writeFileSync(join(electronDir, "PR Cockpit"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(electronDir, "PR Cockpit"), 0o755);
    const launchAgents = join(home, "Library", "LaunchAgents");
    mkdirSync(launchAgents, { recursive: true });
    writeFileSync(join(launchAgents, "app.pr-cockpit.plist"), "existing\n");
    writeFileSync(join(root, "fail-install"), "");
    writeFileSync(join(root, "health-down"), "");
    const failedReconciliation = Bun.spawnSync([join(root, "scripts", "cockpit"), "--managed-server", "--show"], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(failedReconciliation.exitCode).toBe(0);
    expect(failedReconciliation.stderr.toString()).toContain("installation reconciliation failed");
    expect(failedReconciliation.stderr.toString()).toContain("managed server unavailable");
    expect(failedReconciliation.stderr.toString()).toContain("managed desktop app unavailable");
    expect(readFileSync(order, "utf8")).toBe("install\nopen\nopen\nopen\ninstall\nopen\ninstall\n");
  });
});
