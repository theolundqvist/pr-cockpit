import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const LIFECYCLE = join(import.meta.dir, "linux-lifecycle.ts");
const TEST_LIFECYCLE = join(import.meta.dir, "linux-lifecycle-test.ts");
const cleanups: string[] = [];

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path, 0o755);
}
function systemdScalar(path: string): string {
  return Array.from(Buffer.from(path, "utf8"), (byte) => {
    const character = String.fromCharCode(byte);
    return /[A-Za-z0-9/_.-]/.test(character) ? character : `\\x${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "pr-cockpit-linux-lifecycle-")));
  cleanups.push(base);
  const home = join(base, "home");
  const source = join(base, "checkout");
  const head = join(base, "head");
  const bin = join(base, "bin");
  const revisionFile = join(base, "revision");
  const mimeState = join(base, "mime");
  const runtimeHome = join(base, "run");
  const systemctlLog = join(base, "systemctl.log");
  const guiLog = join(base, "gui.log");
  const actorLog = join(base, "actor.log");
  const electronInstallLog = join(base, "electron-install.log");
  const mimeOpsLog = join(base, "mime-ops.log");
  const mimeCache = join(base, "mime-cache");
  const dataHome = join(home, "xdg data % ü");
  const configHome = join(home, "xdg config % ü");
  const stateHome = join(home, "xdg state");
  mkdirSync(runtimeHome, { recursive: true, mode: 0o700 });
  const attributes = readFileSync(join(import.meta.dir, "..", ".gitattributes"), "utf8");
  const exportIgnored = new Set(attributes.split("\n").flatMap((line) => {
    const [path, rule, extra] = line.trim().split(/\s+/);
    return path && rule === "export-ignore" && !extra ? [path] : [];
  }));
  const tracked = [
    ".gitattributes",
    "assets/icon.png",
    "server/main.ts",
    "scripts/cockpit",
    "scripts/linux-lifecycle.ts",
    "scripts/linux-lifecycle-test.ts",
    "scripts/pr-cockpit",
    "shell/main.js",
    "shared/desktopShortcuts.json",
    "ui/package.json",
  ];
  const archived = tracked.filter((relative) => !exportIgnored.has(relative));
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(source, ".git"), { recursive: true });
  for (const relative of tracked) {
    mkdirSync(dirname(join(source, relative)), { recursive: true });
    if (relative === "scripts/linux-lifecycle.ts") copyFileSync(LIFECYCLE, join(source, relative));
    else if (relative === "scripts/linux-lifecycle-test.ts") copyFileSync(TEST_LIFECYCLE, join(source, relative));
    else if (relative === ".gitattributes") writeFileSync(join(source, relative), attributes);
    else writeFileSync(join(source, relative), relative === "scripts/cockpit" ? `#!/usr/bin/env bash\necho gui >> ${JSON.stringify(guiLog)}\n` : relative);
    if (relative.includes("scripts/") || relative.endsWith("/electron")) chmodSync(join(source, relative), 0o755);
  }
  for (const relative of tracked) {
    mkdirSync(dirname(join(head, relative)), { recursive: true });
    copyFileSync(join(source, relative), join(head, relative));
    if (relative.includes("scripts/") || relative.endsWith("/electron")) chmodSync(join(head, relative), 0o755);
  }
  writeFileSync(revisionFile, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n");
  writeFileSync(mimeState, "foreign.desktop\n");
  mkdirSync(join(dataHome, "applications"), { recursive: true });
  writeFileSync(join(dataHome, "applications/foreign.desktop"), "[Desktop Entry]\n");
  executable(join(bin, "bun"), `if [[ "\${1:-}" == */scripts/linux-lifecycle.ts && "\${2:-}" == "activate" ]]; then printf '%s\n' "$1" >> ${JSON.stringify(actorLog)}; actor="$1"; shift; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(TEST_LIFECYCLE)} "$actor" "$@"; elif [[ "\${1:-}" == "install" && "$PWD" == */shell ]]; then mkdir -p node_modules/electron; printf 'installer' > node_modules/electron/install.js; elif [[ "\${1:-}" == "node_modules/electron/install.js" ]]; then [[ -f "$1" ]] || exit 1; mkdir -p node_modules/electron/dist; printf '#!/usr/bin/env bash\\nexit 0\\n' > node_modules/electron/dist/electron; chmod 0755 node_modules/electron/dist/electron; printf '%s\\n' "$PWD/$1" >> ${JSON.stringify(electronInstallLog)}; elif [[ "\${1:-}" == "run" && "\${2:-}" == "build" && "$PWD" == */ui ]]; then mkdir -p ../static; printf '<html>built</html>\\n' > ../static/index.html; fi\nexit 0`);
  executable(join(bin, "gh"), "exit 1");
  executable(join(bin, "git"), `
if [[ "$*" == *"rev-parse HEAD"* ]]; then
  cat ${JSON.stringify(revisionFile)}
elif [[ "$*" == *" archive "* ]]; then
  output=""
  for arg in "$@"; do [[ "$arg" == --output=* ]] && output="\${arg#--output=}"; done
  /usr/bin/tar -cf "$output" -C ${JSON.stringify(head)} ${archived.map((path) => JSON.stringify(path)).join(" ")}
fi`);
  executable(join(bin, "mv"), `if [[ "\${1:-}" == "-Tn" ]]; then /bin/mv "$2" "$3"; else /bin/mv "$@"; fi`);
  executable(join(bin, "curl"), `
current=${JSON.stringify(join(dataHome, "pr-cockpit-runtime/current"))}
root="$(readlink -f "$current")"
revision="$(basename "$root")"
if [[ "$*" == *"/api/version"* ]]; then
  printf '{"rev":"%s"}' "$revision"
else
  printf '{"root":"%s"}' "$root"
fi`);
  executable(join(bin, "xdg-mime"), `
if [[ "$1" == "query" ]]; then
  cat ${JSON.stringify(mimeState)}
else
  printf 'default %s\n' "$2" >> ${JSON.stringify(mimeOpsLog)}
  if [[ "$2" != "app.pr-cockpit.desktop" || "$(cat ${JSON.stringify(mimeCache)} 2>/dev/null || true)" == "app" ]]; then
    printf '%s\\n' "$2" > ${JSON.stringify(mimeState)}
  fi
fi`);
  executable(join(bin, "update-desktop-database"), `printf 'refresh %s\n' "$1" >> ${JSON.stringify(mimeOpsLog)}; if [[ -f "$1/app.pr-cockpit.desktop" ]]; then printf app > ${JSON.stringify(mimeCache)}; else printf absent > ${JSON.stringify(mimeCache)}; fi`);
  executable(join(bin, "desktop-file-validate"), "exit 0");
  executable(join(bin, "systemctl"), `
printf '%s\\n' "$*" >> ${JSON.stringify(systemctlLog)}
unit=${JSON.stringify(join(configHome, "systemd/user/pr-cockpit.service"))}
if [[ "\${SYSTEMCTL_ROLLBACK_FAIL:-0}" == "1" && "$*" == *" stop pr-cockpit.service"* ]]; then
  echo "forced rollback stop failure" >&2
  exit 9
fi
if [[ ( "$*" == *" stop pr-cockpit.service"* || "$*" == *" disable "*"pr-cockpit.service"* ) && ! -f "$unit" ]]; then
  echo "refusing absent-unit operation" >&2
  exit 8
fi
if [[ "$*" == *"is-active --quiet"* || "$*" == *"is-enabled --quiet"* ]]; then
  exit 1
elif [[ "$*" == *" enable pr-cockpit.service"* ]]; then
  mkdir -p ${JSON.stringify(join(configHome, "systemd/user/default.target.wants"))}
  ln -sfn ../pr-cockpit.service ${JSON.stringify(join(configHome, "systemd/user/default.target.wants/pr-cockpit.service"))}
elif [[ "$*" == *" disable "*"pr-cockpit.service"* ]]; then
  rm -f ${JSON.stringify(join(configHome, "systemd/user/default.target.wants/pr-cockpit.service"))}
elif [[ "$*" == *"--property=FragmentPath"* ]]; then
  if [[ -f ${JSON.stringify(join(configHome, "systemd/user/pr-cockpit.service"))} ]]; then printf '%s\\n' ${JSON.stringify(join(configHome, "systemd/user/pr-cockpit.service"))}; fi
elif [[ "$*" == *"--property=MainPID"* ]]; then
  printf '%s\\n' "\${SYSTEMCTL_MAIN_PID:-0}"
fi`);
  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: dataHome,
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: stateHome,
    XDG_RUNTIME_DIR: runtimeHome,
    PATH: `${bin}:/usr/bin:/bin`,
  };
  async function lifecycle(args: string[], extra: Record<string, string> = {}, actor = LIFECYCLE) {
    const proc = Bun.spawn([process.execPath, TEST_LIFECYCLE, actor, ...args], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  }
  return { base, home, source, revisionFile, mimeState, mimeOpsLog, systemctlLog, guiLog, actorLog, electronInstallLog, dataHome, configHome, stateHome, runtimeHome, lifecycle };
}
function makeWritable(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) makeWritable(join(path, name));
  } else if (!stat.isSymbolicLink()) chmodSync(path, 0o600);
}
afterEach(() => {
  for (const path of cleanups.splice(0)) {
    makeWritable(path);
    rmSync(path, { recursive: true, force: true });
  }
});

function processStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19] || null;
  } catch {
    return null;
  }
}

describe("transactional Linux lifecycle", () => {
  test("rejects malformed lifecycle invocations before filesystem mutation", async () => {
    const f = fixture();
    for (const args of [[], ["source", "extra"], ["stage", "--gui"], ["stage", f.source], ["activate", f.source, "--gui"], ["activate", f.source, f.source, "x"], ["install", "--gui"], ["install", f.source, "--unknown"], ["uninstall", "--unknown"]]) {
      const result = await f.lifecycle(args);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("usage: linux-lifecycle.ts");
    }
    expect(existsSync(join(f.dataHome, "pr-cockpit-runtime"))).toBe(false);
  });
  test("installs an immutable XDG release, exact desktop integration, and an ownership manifest without gh auth", async () => {
    const f = fixture();
    writeFileSync(join(f.source, "shared/desktopShortcuts.json"), "dirty worktree bytes");
    writeFileSync(join(f.source, "scripts/linux-lifecycle.ts"), `throw new Error("mutable source lifecycle must not activate");\n`);
    writeFileSync(join(f.source, "private-untracked.txt"), "secret");
    const result = await f.lifecycle(["install", f.source]);
    expect(result).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(readFileSync(f.mimeOpsLog, "utf8").trim().split("\n")).toEqual([
      `refresh ${join(f.dataHome, "applications")}`,
      "default app.pr-cockpit.desktop",
    ]);
    const revision = readFileSync(f.revisionFile, "utf8").trim();
    const release = join(f.dataHome, "pr-cockpit-runtime/releases", revision);
    const sourceState = await f.lifecycle(["source"], {}, join(release, "scripts/linux-lifecycle.ts"));
    expect(sourceState.exitCode).toBe(0);
    expect(sourceState.stderr).toBe("");
    expect(sourceState.stdout).toMatch(new RegExp(`^${f.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\t[0-9a-f]{64}\\n$`));
    expect(readFileSync(f.actorLog, "utf8").trim()).toBe(join(release, "scripts/linux-lifecycle.ts"));
    expect(readlinkSync(join(f.dataHome, "pr-cockpit-runtime/current"))).toBe(release);
    expect(readFileSync(join(release, "shared/desktopShortcuts.json"), "utf8")).toBe("shared/desktopShortcuts.json");
    expect(existsSync(join(release, "scripts/linux-lifecycle.ts"))).toBe(true);
    expect(existsSync(join(release, "static/index.html"))).toBe(true);
    expect(existsSync(join(release, "scripts/linux-lifecycle-test.ts"))).toBe(false);
    expect(existsSync(join(release, "private-untracked.txt"))).toBe(false);
    expect(statSync(join(f.dataHome, "pr-cockpit-runtime")).mode & 0o777).toBe(0o700);
    expect(statSync(join(f.dataHome, "pr-cockpit-runtime/releases")).mode & 0o777).toBe(0o700);
    expect(statSync(release).mode & 0o777).toBe(0o555);
    expect(statSync(join(release, ".pr-cockpit-release.json")).mode & 0o777).toBe(0o444);
    expect(statSync(join(f.configHome, "pr-cockpit/server.env")).mode & 0o777).toBe(0o600);
    expect(statSync(join(f.stateHome, "pr-cockpit/install-manifest.json")).mode & 0o777).toBe(0o600);
    const foregroundEntry = readFileSync(join(f.dataHome, "applications/app.pr-cockpit.desktop"), "utf8");
    expect(foregroundEntry).toContain(`Exec=${join(f.runtimeHome, "pr-cockpit/launch")} %u`);
    expect(foregroundEntry).toContain("MimeType=x-scheme-handler/prcockpit;");
    const autostartEntry = readFileSync(join(f.configHome, "autostart/app.pr-cockpit.desktop"), "utf8");
    expect(autostartEntry).toContain(`Exec=\"${join(f.dataHome, "pr-cockpit-runtime/current/scripts/cockpit")}\" --hidden`);
    expect(autostartEntry).toContain("X-GNOME-Autostart-enabled=true");
    expect(autostartEntry).toContain("X-KDE-autostart-after=panel");
    const systemdUnit = readFileSync(join(f.configHome, "systemd/user/pr-cockpit.service"), "utf8");
    expect(systemdUnit).toContain("RuntimeDirectory=pr-cockpit\nRuntimeDirectoryMode=0700");
    expect(systemdUnit).toContain(`ExecStartPre=\"/bin/ln\" -sfnT \"${join(f.dataHome, "pr-cockpit-runtime/current/scripts/cockpit").replaceAll("%", "%%")}\" \"${join(f.runtimeHome, "pr-cockpit/launch")}\"`);
    expect(autostartEntry).toContain("NoDisplay=true");
    expect(autostartEntry).toContain("StartupWMClass=app.pr-cockpit");
    expect(autostartEntry).not.toContain("%u");
    expect(autostartEntry).not.toContain("MimeType=");
    expect(readlinkSync(join(f.home, ".local/bin/pr-cockpit"))).toBe(
      join(f.dataHome, "pr-cockpit-runtime/current/scripts/pr-cockpit"),
    );
    const manifest = JSON.parse(readFileSync(join(f.stateHome, "pr-cockpit/install-manifest.json"), "utf8"));
    const wants = join(f.configHome, "systemd/user/default.target.wants/pr-cockpit.service");
    expect(lstatSync(wants).isSymbolicLink()).toBe(true);
    expect(readlinkSync(wants)).toBe("../pr-cockpit.service");
    const unit = readFileSync(join(f.configHome, "systemd/user/pr-cockpit.service"), "utf8");
    expect(unit).toContain(`WorkingDirectory=${systemdScalar(join(f.dataHome, "pr-cockpit-runtime/current"))}\n`);
    expect(unit).toContain(`EnvironmentFile=${systemdScalar(join(f.configHome, "pr-cockpit/server.env"))}\n`);
    expect(unit).not.toContain('WorkingDirectory="');
    expect(unit).not.toContain('EnvironmentFile="');
    expect(unit).toContain("\\x20");
    expect(unit).toContain("\\x25");
    expect(unit).toContain("\\xC3\\xBC");
    expect((await f.lifecycle(["install", f.source])).exitCode).toBe(0);
    expect(lstatSync(join(f.home, ".local/bin/pr-cockpit")).isSymbolicLink()).toBe(true);
    expect(lstatSync(wants).isSymbolicLink()).toBe(true);
    expect(manifest).toMatchObject({ version: 1, sourceRoot: f.source, revision, currentRelease: release, priorRelease: null, priorMimeHandler: "foreign.desktop" });
    expect(manifest.artifacts.map((artifact: { path: string }) => artifact.path)).toEqual(expect.arrayContaining([
      join(f.dataHome, "pr-cockpit-runtime/current"),
      join(f.dataHome, "applications/app.pr-cockpit.desktop"),
      join(f.configHome, "autostart/app.pr-cockpit.desktop"),
      join(f.configHome, "systemd/user/pr-cockpit.service"),
      join(f.home, ".local/bin/pr-cockpit"),
    ]));
    expect(readFileSync(f.mimeState, "utf8").trim()).toBe("app.pr-cockpit.desktop");
    expect(readFileSync(f.electronInstallLog, "utf8").trim()).toMatch(/\/candidate\/shell\/node_modules\/electron\/install\.js$/);
  });

  test("leaves no active runtime when any staging or pre-switch gate fails", async () => {
    for (const gate of ["copy", "root-deps", "ui-deps", "shell-deps", "electron-install", "release-check", "runtime-check", "ui-build", "validate", "artifact-ownership"]) {
      const f = fixture();
      const failed = await f.lifecycle(["install", f.source], { COCKPIT_LINUX_FAIL_AT: gate });
      expect(failed.exitCode).toBe(1);
      expect(existsSync(join(f.dataHome, "pr-cockpit-runtime/current"))).toBe(false);
      expect(existsSync(join(f.configHome, "pr-cockpit/server.env"))).toBe(false);
      if (gate === "electron-install") expect(existsSync(f.electronInstallLog)).toBe(false);
    }

  }, 20_000);

  test("accepts a nonzero rollback stop only after MainPID proves zero", async () => {
    const f = fixture();
    const failed = await f.lifecycle(["install", f.source], {
      COCKPIT_LINUX_FAIL_AT: "health",
      SYSTEMCTL_ROLLBACK_FAIL: "1",
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("injected failure at health");
    expect(failed.stderr).not.toContain("activation failed and prior release rollback could not be proved");
    expect(existsSync(join(f.dataHome, "pr-cockpit-runtime/current"))).toBe(false);
  });

  test("reports both activation and rollback causes when rollback leaves a live PID", async () => {
    const f = fixture();
    const failed = await f.lifecycle(["install", f.source], {
      COCKPIT_LINUX_FAIL_AT: "health",
      SYSTEMCTL_ROLLBACK_FAIL: "1",
      SYSTEMCTL_MAIN_PID: "42",
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain("activation failed and prior release rollback could not be proved");
    expect(failed.stderr).toContain("injected failure at health");
    expect(failed.stderr).toContain("forced rollback stop failure");
  });

  test("refreshes the desktop database in activation, rollback, and uninstall order", async () => {
    const f = fixture();
    const applications = join(f.dataHome, "applications");
    expect((await f.lifecycle(["install", f.source])).exitCode).toBe(0);
    writeFileSync(f.mimeOpsLog, "");
    writeFileSync(f.revisionFile, `${"b".repeat(40)}\n`);
    expect((await f.lifecycle(["install", f.source], { COCKPIT_LINUX_FAIL_AT: "health" })).exitCode).toBe(1);
    expect(readFileSync(f.mimeOpsLog, "utf8").trim().split("\n")).toEqual([
      `refresh ${applications}`,
      "default app.pr-cockpit.desktop",
      `refresh ${applications}`,
      "default app.pr-cockpit.desktop",
    ]);
    writeFileSync(f.mimeOpsLog, "");
    expect((await f.lifecycle(["uninstall"])).exitCode).toBe(0);
    expect(readFileSync(f.mimeOpsLog, "utf8").trim().split("\n")).toEqual([
      "default foreign.desktop",
      `refresh ${applications}`,
    ]);
  });

  test("rejects relative HOME and lifecycle roots outside HOME before mutation", async () => {
    const f = fixture();
    const generation = "1".repeat(64);
    const relativeHome = await f.lifecycle(["stage", f.source, generation], { HOME: "relative" });
    expect(relativeHome.stderr).toContain("HOME must name a non-root absolute user home");
    const outsideData = await f.lifecycle(["stage", f.source, generation], { XDG_DATA_HOME: join(f.base, "outside") });
    expect(outsideData.stderr).toContain("lifecycle root must be beneath HOME");
    expect(existsSync(join(f.base, "outside/pr-cockpit-runtime"))).toBe(false);
  });

  test("retains current and prior releases and rolls every post-switch gate back", async () => {
    const f = fixture();
    expect((await f.lifecycle(["install", f.source])).exitCode).toBe(0);
    const first = readlinkSync(join(f.dataHome, "pr-cockpit-runtime/current"));
    for (const [index, gate] of ["activate", "desktop-validate", "mime", "unit", "health", "manifest"].entries()) {
      const revision = (index + 1).toString(16).padStart(40, "b");
      writeFileSync(f.revisionFile, `${revision}\n`);
      const failed = await f.lifecycle(["install", f.source], { COCKPIT_LINUX_FAIL_AT: gate });
      expect(failed.exitCode).toBe(1);
      expect(readlinkSync(join(f.dataHome, "pr-cockpit-runtime/current"))).toBe(first);
      expect(readFileSync(f.mimeState, "utf8").trim()).toBe("app.pr-cockpit.desktop");
    }
    writeFileSync(f.revisionFile, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n");
    expect((await f.lifecycle(["install", f.source])).exitCode).toBe(0);
    const manifest = JSON.parse(readFileSync(join(f.stateHome, "pr-cockpit/install-manifest.json"), "utf8"));
    expect(manifest.priorRelease).toBe(first);
    expect(existsSync(first)).toBe(true);
    const second = readlinkSync(join(f.dataHome, "pr-cockpit-runtime/current"));
    writeFileSync(f.revisionFile, `${first.split("/").at(-1)}\n`);
    const failedReuse = await f.lifecycle(["install", f.source], { COCKPIT_LINUX_FAIL_AT: "health" });
    expect(failedReuse.exitCode).toBe(1);
    expect(readlinkSync(join(f.dataHome, "pr-cockpit-runtime/current"))).toBe(second);
    expect(existsSync(first)).toBe(true);
  });

  test("refuses foreign artifacts and preserves persistent sentinels", async () => {
    const f = fixture();
    const desktop = join(f.dataHome, "applications/app.pr-cockpit.desktop");
    mkdirSync(join(desktop, ".."), { recursive: true });
    writeFileSync(desktop, "foreign");
    const result = await f.lifecycle(["install", f.source]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("refusing to replace foreign or changed artifact");
    expect(readFileSync(desktop, "utf8")).toBe("foreign");
  });

  test("refuses dangling and regular active runtime paths before activation", async () => {
    for (const kind of ["dangling", "regular"] as const) {
      const f = fixture();
      const current = join(f.dataHome, "pr-cockpit-runtime/current");
      mkdirSync(dirname(current), { recursive: true });
      if (kind === "dangling") symlinkSync(join(f.dataHome, "missing-release"), current);
      else writeFileSync(current, "foreign");
      const result = await f.lifecycle(["install", f.source]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("active runtime link is insecure");
    }
  });

  test("refuses reuse and recursive deletion when the sealed release tree has changed", async () => {
    const f = fixture();
    expect((await f.lifecycle(["install", f.source])).exitCode).toBe(0);
    const release = readlinkSync(join(f.dataHome, "pr-cockpit-runtime/current"));
    chmodSync(join(release, "shared"), 0o755);
    chmodSync(join(release, "shared/desktopShortcuts.json"), 0o644);
    writeFileSync(join(release, "shared/desktopShortcuts.json"), "tampered");
    expect((await f.lifecycle(["install", f.source])).stderr).toContain("release tree is writable");
    expect((await f.lifecycle(["uninstall"])).stderr).toContain("release tree is writable");
    expect(existsSync(release)).toBe(true);
  });

  test("does not reclaim MIME ownership after the user changes handlers", async () => {
    const f = fixture();
    expect((await f.lifecycle(["install", f.source])).exitCode).toBe(0);
    writeFileSync(f.mimeState, "user-choice.desktop\n");
    writeFileSync(f.revisionFile, "cccccccccccccccccccccccccccccccccccccccc\n");
    expect((await f.lifecycle(["install", f.source])).exitCode).toBe(0);
    expect(readFileSync(f.mimeState, "utf8").trim()).toBe("user-choice.desktop");
  });

  test("rejects manifest artifact extras and mismatched persistent-data config before mutation", async () => {
    const f = fixture();
    expect((await f.lifecycle(["install", f.source])).exitCode).toBe(0);
    const manifestPath = join(f.stateHome, "pr-cockpit/install-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.artifacts.push({ path: join(f.home, "foreign"), kind: "file", sha256: "0".repeat(64) });
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    const refusedManifest = await f.lifecycle(["uninstall"]);
    expect(refusedManifest.stderr).toContain("artifact allowlist mismatch");
    expect(existsSync(join(f.dataHome, "pr-cockpit-runtime/current"))).toBe(true);
    manifest.unexpected = true;
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    const refusedSchema = await f.lifecycle(["uninstall"]);
    expect(refusedSchema.stderr).toContain("unknown or missing fields");
    delete manifest.unexpected;

    manifest.artifacts.pop();
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    writeFileSync(join(f.configHome, "pr-cockpit/server.env"), `COCKPIT_DATA_DIR=${join(f.home, "wrong-data")}\n`);
    writeFileSync(f.revisionFile, "dddddddddddddddddddddddddddddddddddddddd\n");
    const refusedConfig = await f.lifecycle(["install", f.source]);
    expect(refusedConfig.stderr).toContain("existing COCKPIT_DATA_DIR must equal");
  });

  test("rejects release paths and integration targets forged in the ownership manifest", async () => {
    const f = fixture();
    expect((await f.lifecycle(["install", f.source])).exitCode).toBe(0);
    const manifestPath = join(f.stateHome, "pr-cockpit/install-manifest.json");
    const original = JSON.parse(readFileSync(manifestPath, "utf8"));
    const forgedRelease = join(f.home, original.revision);
    const forged = structuredClone(original);
    forged.currentRelease = forgedRelease;
    forged.artifacts.find((item: { path: string }) => item.path.endsWith("/current")).target = forgedRelease;
    writeFileSync(manifestPath, `${JSON.stringify(forged)}\n`);
    expect((await f.lifecycle(["uninstall"])).stderr).toContain("current release is outside the owned release root");

    const forgedCli = structuredClone(original);
    forgedCli.artifacts.find((item: { path: string }) => item.path.endsWith("/.local/bin/pr-cockpit")).target = join(f.home, "foreign");
    writeFileSync(manifestPath, `${JSON.stringify(forgedCli)}\n`);
    expect((await f.lifecycle(["uninstall"])).stderr).toContain("CLI target is invalid");
    expect(existsSync(join(f.dataHome, "pr-cockpit-runtime/current"))).toBe(true);
  });

  test("reinstalls cleanly after default uninstall with strict null prior-release fields", async () => {
    const f = fixture();
    expect((await f.lifecycle(["install", f.source])).exitCode).toBe(0);
    expect((await f.lifecycle(["uninstall"])).exitCode).toBe(0);
    expect((await f.lifecycle(["install", f.source])).exitCode).toBe(0);
    const manifestPath = join(f.stateHome, "pr-cockpit/install-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(manifest.priorRelease).toBeNull();
    expect(manifest.priorReleaseFiles).toBeNull();
    const strictRead = await f.lifecycle(["source"], {}, join(manifest.currentRelease, "scripts/linux-lifecycle.ts"));
    expect(strictRead.exitCode).toBe(0);
    expect((await f.lifecycle(["uninstall"])).exitCode).toBe(0);
  });


  test("retains a real prior release when reinstalling the current release", async () => {
    const f = fixture();
    const revisionA = "a".repeat(40);
    const revisionB = "b".repeat(40);
    expect((await f.lifecycle(["install", f.source])).exitCode).toBe(0);
    const releaseA = readlinkSync(join(f.dataHome, "pr-cockpit-runtime/current"));
    writeFileSync(f.revisionFile, `${revisionB}\n`);
    expect((await f.lifecycle(["install", f.source])).exitCode).toBe(0);
    const releaseB = readlinkSync(join(f.dataHome, "pr-cockpit-runtime/current"));
    writeFileSync(f.revisionFile, `${revisionA}\n`);
    expect((await f.lifecycle(["install", f.source])).exitCode).toBe(0);
    expect(readlinkSync(join(f.dataHome, "pr-cockpit-runtime/current"))).toBe(releaseA);
    expect((await f.lifecycle(["install", f.source])).exitCode).toBe(0);
    const manifest = JSON.parse(readFileSync(join(f.stateHome, "pr-cockpit/install-manifest.json"), "utf8"));
    expect(manifest.priorRelease).toBe(releaseB);
    expect(Array.isArray(manifest.priorReleaseFiles)).toBe(true);
    expect(existsSync(releaseB)).toBe(true);
    expect((await f.lifecycle(["source"], {}, join(releaseA, "scripts/linux-lifecycle.ts"))).exitCode).toBe(0);
    writeFileSync(f.revisionFile, `${"c".repeat(40)}\n`);
    const failed = await f.lifecycle(["install", f.source], { COCKPIT_LINUX_FAIL_AT: "health" });
    expect(failed.exitCode).toBe(1);
    expect(readlinkSync(join(f.dataHome, "pr-cockpit-runtime/current"))).toBe(releaseA);
    expect(existsSync(releaseB)).toBe(true);
    expect((await f.lifecycle(["source"], {}, join(releaseA, "scripts/linux-lifecycle.ts"))).exitCode).toBe(0);
  }, 20_000);

  test("accepts only exact pre-tray or tray-ready GUI ownership records", async () => {
    const f = fixture();
    expect((await f.lifecycle(["install", f.source])).exitCode).toBe(0);
    const manifestPath = join(f.stateHome, "pr-cockpit/install-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const processFile = join(f.dataHome, "pr-cockpit/shell-process");
    const baseRecord = `pid=2147483647\nstart=1\nexecutable=${join(manifest.currentRelease, "shell/node_modules/electron/dist/electron")}\nrelease=${manifest.currentRelease}\n`;

    writeFileSync(processFile, `${baseRecord}tray=starting\n`);
    chmodSync(processFile, 0o600);
    expect((await f.lifecycle(["uninstall"])).stderr).toContain("ownership record is invalid");
    expect(existsSync(join(f.dataHome, "pr-cockpit-runtime/current"))).toBe(true);
    writeFileSync(processFile, `${baseRecord}extra=value\n`);
    chmodSync(processFile, 0o600);
    expect((await f.lifecycle(["uninstall"])).stderr).toContain("ownership record is invalid");

    writeFileSync(processFile, baseRecord);
    chmodSync(processFile, 0o600);
    expect((await f.lifecycle(["uninstall"])).exitCode).toBe(0);
    expect((await f.lifecycle(["install", f.source])).exitCode).toBe(0);
    const nextManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const trayRecord = `pid=2147483647\nstart=1\nexecutable=${join(nextManifest.currentRelease, "shell/node_modules/electron/dist/electron")}\nrelease=${nextManifest.currentRelease}\ntray=ready\n`;
    writeFileSync(processFile, trayRecord);
    chmodSync(processFile, 0o600);
    expect((await f.lifecycle(["uninstall"])).exitCode).toBe(0);
  });

  test("refuses an insecure install ownership manifest before uninstall mutation", async () => {
    const f = fixture();
    expect((await f.lifecycle(["install", f.source])).exitCode).toBe(0);
    const manifest = join(f.stateHome, "pr-cockpit/install-manifest.json");
    chmodSync(manifest, 0o644);

    const result = await f.lifecycle(["uninstall"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("install manifest has insecure ownership or mode");
    expect(existsSync(join(f.dataHome, "pr-cockpit-runtime/current"))).toBe(true);
  });

  test("refuses an insecure MIME applications file before activation", async () => {
    const f = fixture();
    const foreign = join(f.home, "foreign-mimeapps.list");
    writeFileSync(foreign, "[Default Applications]\n");
    mkdirSync(f.configHome, { recursive: true });
    symlinkSync(foreign, join(f.configHome, "mimeapps.list"));

    const result = await f.lifecycle(["install", f.source]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("refusing to edit insecure MIME applications file");
    expect(readFileSync(foreign, "utf8")).toBe("[Default Applications]\n");
    expect(existsSync(join(f.dataHome, "pr-cockpit-runtime/current"))).toBe(false);
  });

  test("refuses to rewrite an insecure MIME applications file during uninstall", async () => {
    const f = fixture();
    mkdirSync(join(f.dataHome, "applications"), { recursive: true });
    writeFileSync(join(f.dataHome, "applications/foreign.desktop"), "[Desktop Entry]\n");
    expect((await f.lifecycle(["install", f.source])).exitCode).toBe(0);
    const foreign = join(f.home, "foreign-mimeapps.list");
    writeFileSync(foreign, "[Default Applications]\n");
    symlinkSync(foreign, join(f.configHome, "mimeapps.list"));

    const result = await f.lifecycle(["uninstall"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("refusing to edit insecure MIME applications file");
    expect(readFileSync(foreign, "utf8")).toBe("[Default Applications]\n");
    expect(existsSync(join(f.dataHome, "pr-cockpit-runtime/current"))).toBe(true);
  });

  test("uninstalls idempotently, restores MIME only while still current, and bounds purge to XDG roots", async () => {
    const f = fixture();
    const priorDesktop = join(f.dataHome, "applications/foreign.desktop");
    mkdirSync(join(priorDesktop, ".."), { recursive: true });
    writeFileSync(priorDesktop, "[Desktop Entry]\n");
    expect((await f.lifecycle(["install", f.source])).exitCode).toBe(0);
    const ownedDesktop = join(f.dataHome, "applications/app.pr-cockpit.desktop");
    const desktopContent = readFileSync(ownedDesktop, "utf8");

    writeFileSync(ownedDesktop, `${desktopContent}\nchanged`);
    const refused = await f.lifecycle(["uninstall"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("refusing to remove changed artifact");
    writeFileSync(ownedDesktop, desktopContent);
    const toolSentinel = join(f.dataHome, "pr-cockpit-tools/versions/sentinel");
    mkdirSync(join(toolSentinel, ".."), { recursive: true });
    writeFileSync(toolSentinel, "owned tools survive app uninstall");
    const dataSentinel = join(f.dataHome, "pr-cockpit/sentinel");
    const configSentinel = join(f.configHome, "pr-cockpit/sentinel");
    writeFileSync(dataSentinel, "data");
    writeFileSync(configSentinel, "config");
    expect(lstatSync(join(f.home, ".local/bin/pr-cockpit")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(f.configHome, "systemd/user/default.target.wants/pr-cockpit.service")).isSymbolicLink()).toBe(true);
    expect((await f.lifecycle(["uninstall"])).exitCode).toBe(0);
    expect(lexists(join(f.home, ".local/bin/pr-cockpit"))).toBe(false);
    expect(lexists(join(f.configHome, "systemd/user/default.target.wants/pr-cockpit.service"))).toBe(false);
    expect(readFileSync(f.mimeState, "utf8").trim()).toBe("foreign.desktop");
    expect(readFileSync(dataSentinel, "utf8")).toBe("data");
    expect(readFileSync(configSentinel, "utf8")).toBe("config");
    expect(existsSync(join(f.stateHome, "pr-cockpit/install-manifest.json"))).toBe(true);
    expect((await f.lifecycle(["install", f.source])).exitCode).toBe(0);
    expect(readFileSync(f.mimeState, "utf8").trim()).toBe("app.pr-cockpit.desktop");
    expect((await f.lifecycle(["uninstall"])).exitCode).toBe(0);
    expect(readFileSync(f.mimeState, "utf8").trim()).toBe("foreign.desktop");
    expect((await f.lifecycle(["uninstall", "--purge"])).exitCode).toBe(0);
    expect(existsSync(join(f.dataHome, "pr-cockpit"))).toBe(false);
    expect(existsSync(join(f.configHome, "pr-cockpit"))).toBe(false);
    expect((await f.lifecycle(["install", f.source])).exitCode).toBe(0);
    writeFileSync(f.mimeState, "user-choice.desktop\n");
    expect((await f.lifecycle(["uninstall", "--purge"])).exitCode).toBe(0);
    expect(readFileSync(f.mimeState, "utf8").trim()).toBe("user-choice.desktop");
    expect(existsSync(join(f.home, ".local/bin/pr-cockpit"))).toBe(false);
    expect(existsSync(join(f.configHome, "systemd/user/default.target.wants/pr-cockpit.service"))).toBe(false);
    expect(existsSync(join(f.dataHome, "pr-cockpit"))).toBe(false);
    expect(existsSync(join(f.configHome, "pr-cockpit"))).toBe(false);
    expect(readFileSync(toolSentinel, "utf8")).toBe("owned tools survive app uninstall");
  });
  test("rejects reordered activation and an uninstall gap with the exact install generation", async () => {
    const f = fixture();
    expect((await f.lifecycle(["install", f.source])).exitCode).toBe(0);
    const releaseA = readlinkSync(join(f.dataHome, "pr-cockpit-runtime/current"));
    const stateA = (await f.lifecycle(["source"], {}, join(releaseA, "scripts/linux-lifecycle.ts"))).stdout.trim().split("\t");
    expect(stateA).toHaveLength(2);

    const revisionB = "b".repeat(40);
    writeFileSync(f.revisionFile, `${revisionB}\n`);
    const stagedBState = await f.lifecycle(["stage", f.source, stateA[1]]);
    expect(stagedBState.exitCode).toBe(0);
    const [releaseB, candidateB] = stagedBState.stdout.trim().split("\t");

    const revisionC = "c".repeat(40);
    writeFileSync(f.revisionFile, `${revisionC}\n`);
    const stagedCState = await f.lifecycle(["stage", f.source, stateA[1]]);
    expect(stagedCState.exitCode).toBe(0);
    const [releaseC, candidateC] = stagedCState.stdout.trim().split("\t");
    const activatedC = await f.lifecycle(["activate", releaseC, f.source, stateA[1], candidateC], {}, join(releaseC, "scripts/linux-lifecycle.ts"));
    expect(activatedC.exitCode).toBe(0);

    writeFileSync(f.revisionFile, `${revisionB}\n`);
    const reordered = await f.lifecycle(["activate", releaseB, f.source, stateA[1], candidateB], {}, join(releaseB, "scripts/linux-lifecycle.ts"));
    expect(reordered.exitCode).toBe(1);
    expect(reordered.stderr).toContain("Linux installation changed before activation");
    expect(readlinkSync(join(f.dataHome, "pr-cockpit-runtime/current"))).toBe(releaseC);

    const stateC = (await f.lifecycle(["source"], {}, join(releaseC, "scripts/linux-lifecycle.ts"))).stdout.trim().split("\t");
    const revisionD = "d".repeat(40);
    writeFileSync(f.revisionFile, `${revisionD}\n`);
    const stagedDState = await f.lifecycle(["stage", f.source, stateC[1]]);
    expect(stagedDState.exitCode).toBe(0);
    const [releaseD, candidateD] = stagedDState.stdout.trim().split("\t");
    expect((await f.lifecycle(["uninstall"])).exitCode).toBe(0);
    const afterUninstall = await f.lifecycle(["activate", releaseD, f.source, stateC[1], candidateD], {}, join(releaseD, "scripts/linux-lifecycle.ts"));
    expect(afterUninstall.exitCode).toBe(1);
    expect(afterUninstall.stderr).toContain("Linux installation changed before activation");
    expect(lexists(join(f.dataHome, "pr-cockpit-runtime/current"))).toBe(false);
    const afterUninstallStage = await f.lifecycle(["stage", f.source, stateC[1]]);
    expect(afterUninstallStage.exitCode).toBe(1);
    expect(afterUninstallStage.stderr).toContain("Linux installation changed before release staging");
  });

  test("waits out a live lifecycle lock and reclaims only a stale identity", async () => {
    const f = fixture();
    expect((await f.lifecycle(["install", f.source])).exitCode).toBe(0);
    const lock = join(f.stateHome, ".pr-cockpit-lifecycle.lock");
    const liveStart = processStart(process.pid);
    symlinkSync(`${process.pid}:${liveStart ?? "-"}:${"a".repeat(32)}`, lock);
    const blocked = await f.lifecycle(["uninstall"]);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.stderr).toContain("another Linux lifecycle operation is active");
    expect(readlinkSync(lock)).toBe(`${process.pid}:${liveStart || "-"}:${"a".repeat(32)}`);
    rmSync(lock);
    writeFileSync(lock, "interrupted");
    const invalidFile = await f.lifecycle(["uninstall"]);
    expect(invalidFile.exitCode).toBe(1);
    expect(invalidFile.stderr).toContain("another Linux lifecycle operation is active");
    expect(readFileSync(lock, "utf8")).toBe("interrupted");
    rmSync(lock);
    symlinkSync("incomplete", lock);
    const invalidLink = await f.lifecycle(["uninstall"]);
    expect(invalidLink.exitCode).toBe(1);
    expect(invalidLink.stderr).toContain("another Linux lifecycle operation is active");
    expect(readlinkSync(lock)).toBe("incomplete");
    rmSync(lock);
    symlinkSync(`999999999:-:${"b".repeat(32)}`, lock);
    expect((await f.lifecycle(["uninstall"])).exitCode).toBe(0);
    expect(lexists(lock)).toBe(false);
  });
});
