import { expect, test } from "bun:test";
import { appendFileSync, chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function writeExecutable(path: string, body: string) {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path, 0o755);
}

async function runInstaller(script: string, env: Record<string, string>) {
  const proc = Bun.spawn([script], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("installs and safely refreshes a loopback systemd user service", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "pr-cockpit-linux-install-"));
  try {
    const home = join(fixture, "home");
    const root = join(fixture, "checkout");
    const bin = join(fixture, "bin");
    const bunCalls = join(fixture, "bun-calls");
    const systemctlCalls = join(fixture, "systemctl-calls");
    const activeMarker = join(fixture, "active");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "server"), { recursive: true });
    mkdirSync(join(root, "ui"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    copyFileSync(join(import.meta.dir, "install-linux"), join(root, "scripts/install-linux"));
    chmodSync(join(root, "scripts/install-linux"), 0o755);

    writeExecutable(join(bin, "uname"), 'printf "Linux\\n"');
    writeExecutable(join(bin, "bun"), `printf '%s | %s\\n' "$PWD" "$*" >> ${JSON.stringify(bunCalls)}`);
    writeExecutable(join(bin, "git"), "exit 0");
    writeExecutable(join(bin, "gh"), "exit 0");
    writeExecutable(join(bin, "curl"), `printf '{"root":"${realpathSync(root)}"}'`);
    writeExecutable(join(bin, "loginctl"), '[[ "$1" == "show-user" ]] && printf "no\\n"');
    writeExecutable(join(bin, "systemctl"), `
      printf '%s\\n' "$*" >> ${JSON.stringify(systemctlCalls)}
      if [[ "$2" == "is-active" ]]; then
        [[ -f ${JSON.stringify(activeMarker)} ]]
      elif [[ "$2" == "enable" ]]; then
        touch ${JSON.stringify(activeMarker)}
      fi
    `);

    const script = join(root, "scripts/install-linux");
    const env = {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      USER: "cockpit-test",
      COCKPIT_REPOS: "acme/app,acme/api",
      COCKPIT_ALLOWED_ORIGINS: "https://cockpit.example.ts.net,https://cockpit.example.com",
    };
    const first = await runInstaller(script, env);
    expect(first.exitCode).toBe(0);
    expect(first.stderr).toBe("");
    expect(first.stdout).toContain("user lingering is disabled");

    const configuredHome = home;
    const resolvedRoot = realpathSync(root);
    const envFile = join(configuredHome, ".config/pr-cockpit/server.env");
    const originalEnv = readFileSync(envFile, "utf8");
    expect(originalEnv).toBe(
      `COCKPIT_DATA_DIR="${configuredHome}/.local/share/pr-cockpit"\n` +
      "COCKPIT_PORT=4820\n" +
      'COCKPIT_REPOS="acme/app,acme/api"\n' +
      'COCKPIT_ALLOWED_ORIGINS="https://cockpit.example.ts.net,https://cockpit.example.com"\n' +
      "COCKPIT_UPDATE_DISABLED=1\n",
    );

    const unit = readFileSync(join(configuredHome, ".config/systemd/user/pr-cockpit.service"), "utf8");
    expect(unit).toContain(`WorkingDirectory=${resolvedRoot}`);
    expect(unit).toContain(`EnvironmentFile=${envFile}`);
    expect(unit).toContain(`Environment="COCKPIT_ROOT=${resolvedRoot}"`);
    expect(unit).toContain(`Environment="COCKPIT_GH_BIN=${bin}/gh"`);
    expect(unit).toContain(`ExecStart="${bin}/bun" "${resolvedRoot}/server/main.ts"`);
    expect(unit).toContain("Environment=\"COCKPIT_UPDATE_DISABLED=1\"");
    expect(unit).toContain("StandardOutput=journal\nStandardError=journal");

    const bunLog = readFileSync(bunCalls, "utf8");
    expect(bunLog).toContain(`${resolvedRoot} | install`);
    expect(bunLog).toContain(`${resolvedRoot}/ui | install`);
    expect(bunLog).toContain(`${resolvedRoot}/ui | run build`);
    expect(bunLog).not.toContain("shell");

    appendFileSync(envFile, "CUSTOM_SETTING=preserved\n");
    const preservedEnv = readFileSync(envFile, "utf8");
    const second = await runInstaller(script, {
      ...env,
      COCKPIT_REPOS: "replacement/ignored",
      COCKPIT_ALLOWED_ORIGINS: "https://replacement.invalid",
    });
    expect(second.exitCode).toBe(0);
    expect(readFileSync(envFile, "utf8")).toBe(preservedEnv);

    expect(readFileSync(systemctlCalls, "utf8")).toBe(
      "--user daemon-reload\n" +
      "--user is-active --quiet pr-cockpit.service\n" +
      "--user enable --now pr-cockpit.service\n" +
      "--user daemon-reload\n" +
      "--user is-active --quiet pr-cockpit.service\n" +
      "--user restart pr-cockpit.service\n",
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
