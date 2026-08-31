import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Linux desktop launcher", () => {
  test("runs through the session launcher against the active XDG runtime and preserves a raw protocol argv", () => {
    const fixture = mkdtempSync(join(tmpdir(), "cockpit-linux-launcher-"));
    roots.push(fixture);
    const source = join(fixture, "source");
    const dataHome = join(fixture, "data");
    const runtimePath = join(dataHome, "pr-cockpit-runtime", "releases", "revision");
    const protocolLauncher = join(fixture, "run", "pr-cockpit", "launch");
    const bin = join(fixture, "bin");
    mkdirSync(join(source, "scripts"), { recursive: true });
    mkdirSync(join(runtimePath, "scripts"), { recursive: true });
    mkdirSync(join(runtimePath, "shell", "node_modules", "electron", "dist"), { recursive: true });
    const runtime = realpathSync(runtimePath);
    mkdirSync(bin, { recursive: true });
    cpSync(join(import.meta.dir, "cockpit"), join(source, "scripts", "cockpit"));
    chmodSync(join(source, "scripts", "cockpit"), 0o755);
    mkdirSync(join(fixture, "run", "pr-cockpit"), { recursive: true });
    symlinkSync(join(source, "scripts", "cockpit"), protocolLauncher);
    writeFileSync(join(runtime, "scripts", "cockpit"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(runtime, "scripts", "cockpit"), 0o755);
    writeFileSync(
      join(runtime, "shell", "node_modules", "electron", "dist", "electron"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$COCKPIT_LAUNCHER" "$@"\n',
    );
    chmodSync(join(runtime, "shell", "node_modules", "electron", "dist", "electron"), 0o755);
    symlinkSync(runtime, join(dataHome, "pr-cockpit-runtime", "current"));
    writeFileSync(join(bin, "uname"), "#!/usr/bin/env bash\necho Linux\n");
    writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash\nprintf '{"root":"%s"}' ${JSON.stringify(runtime)}\n`);
    chmodSync(join(bin, "uname"), 0o755);
    chmodSync(join(bin, "curl"), 0o755);

    const protocolUrl = "prcockpit://pr/owner/repo/42";
    const result = Bun.spawnSync([protocolLauncher, "--foreground-shell", protocolUrl], {
      cwd: source,
      env: {
        ...Bun.env,
        DISPLAY: ":99",
        COCKPIT_PORT: "4820",
        HOME: fixture,
        PATH: `${bin}:${Bun.env.PATH}`,
        XDG_DATA_HOME: dataHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString().trim().split("\n")).toEqual([
      join(runtime, "scripts", "cockpit"),
      join(runtime, "shell"),
      "--cockpit-url=http://127.0.0.1:4820",
      protocolUrl,
    ]);
  });
});
