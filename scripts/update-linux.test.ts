import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "update-linux");
const cleanups: string[] = [];

afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path, 0o755);
}

async function invoke(gui: boolean, fail: "pull" | "stage" | "activate" | null = null, pullResult = "updated", env: Record<string, string> = {}, args: string[] = []) {
  const fixture = mkdtempSync(join(tmpdir(), "pr-cockpit-update-linux-"));
  cleanups.push(fixture);
  const home = join(fixture, "home");
  const source = join(fixture, "source");
  const bin = join(fixture, "bin");
  const calls = join(fixture, "calls");
  const manifest = join(home, ".local/state/pr-cockpit/install-manifest.json");
  mkdirSync(join(source, ".git"), { recursive: true });
  mkdirSync(join(source, "scripts"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  executable(join(bin, "uname"), `printf 'Linux\\n'`);
  executable(join(bin, "git"), `printf '%s\n' ${JSON.stringify("a".repeat(40))}`);
  const script = join(fixture, "update-linux");
  writeFileSync(script, readFileSync(SCRIPT, "utf8").replaceAll("/usr/bin/uname", join(bin, "uname")), { mode: 0o755 });
  mkdirSync(join(manifest, ".."), { recursive: true });
  const currentScripts = join(home, ".local/share/pr-cockpit-runtime/current/scripts");
  mkdirSync(currentScripts, { recursive: true });
  const activeBun = join(home, ".local/share/pr-cockpit-tools/versions/bun-1.2.22/bun");
  const activeGh = join(home, ".local/share/pr-cockpit-tools/versions/gh-2.76.2/gh");
  executable(join(currentScripts, "install-linux-tools"), `printf 'verify\n' >> ${JSON.stringify(calls)}; [[ "\${1:-}" == "--paths" ]] && printf '%s\t%s\n' ${JSON.stringify(activeBun)} ${JSON.stringify(activeGh)}`);
  writeFileSync(join(currentScripts, "linux-lifecycle.ts"), "// invoked through the fake bun");
  writeFileSync(manifest, JSON.stringify({ sourceRoot: source }));
  executable(join(source, "scripts/update-pull"), fail === "pull" ? `printf 'pull\n' >> ${JSON.stringify(calls)}; echo pull-broke >&2; exit 1` : `printf 'pull\n' >> ${JSON.stringify(calls)}; echo ${pullResult}`);
  executable(join(source, "scripts/install-linux-tools"), `printf 'tools\n' >> ${JSON.stringify(calls)}; if [[ "\${PUBLISH_NEWER:-0}" == "1" ]]; then mkdir -p ${JSON.stringify(join(home, ".local/share/pr-cockpit-tools/bin"))}; ln -sfn ../versions/bun-9.9.9/bun ${JSON.stringify(join(home, ".local/share/pr-cockpit-tools/bin/bun"))}; fi`);
  writeFileSync(join(source, "scripts/linux-lifecycle.ts"), "// invoked through the fake bun");
  executable(join(bin, "bun"), `
if [[ "$2" == "source" ]]; then
  printf '%s\t%s' ${JSON.stringify(source)} ${JSON.stringify("1".repeat(64))}
elif [[ "$2" == "revision" ]]; then
  printf '%s' ${JSON.stringify("a".repeat(40))}
elif [[ "$2" == "stage" ]]; then
  printf 'stage %s\n' "$*" >> ${JSON.stringify(calls)}
  ${fail === "stage" ? "exit 1" : `printf '%s\t%s' ${JSON.stringify(join(fixture, "staged"))} ${JSON.stringify("b".repeat(40))}`}
elif [[ "$2" == "activate" ]]; then
  printf 'activate %s\n' "$*" >> ${JSON.stringify(calls)}
  ${fail === "activate" ? `if [[ ! -e ${JSON.stringify(join(fixture, "activation-failed"))} ]]; then touch ${JSON.stringify(join(fixture, "activation-failed"))}; exit 1; fi` : "exit 0"}
+fi`.replaceAll("\n+", "\n"));
  mkdirSync(join(activeBun, ".."), { recursive: true });
  mkdirSync(join(activeGh, ".."), { recursive: true });
  copyFileSync(join(bin, "bun"), activeBun);
  chmodSync(activeBun, 0o755);
  executable(activeGh, "exit 0");
  const newerBun = join(home, ".local/share/pr-cockpit-tools/versions/bun-9.9.9/bun");
  mkdirSync(join(newerBun, ".."), { recursive: true });
  copyFileSync(join(bin, "bun"), newerBun);
  chmodSync(newerBun, 0o755);
  const processEnv = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local/state"),
    PATH: `${bin}:/usr/bin:/bin`,
    ...(gui ? { COCKPIT_UPDATE_GUI: "1", DISPLAY: ":99", DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/fake" } : { COCKPIT_UPDATE_GUI: "0" }),
    ...env,
  };
  const execute = async () => {
    const proc = Bun.spawn([script, ...args], { env: processEnv, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  };
  const result = await execute();
  const retry = env.RETRY_AFTER_FAILURE === "1" ? await execute() : null;
  return { ...result, retry, source, calls: await Bun.file(calls).exists() ? await Bun.file(calls).text() : "" };
}

test("stages before graphical handoff and requests GUI relaunch only for the in-app invocation", async () => {
  const graphical = await invoke(true);
  expect(graphical.exitCode).toBe(0);
  expect(graphical.stdout).toBe("PULL_OK\n");
  expect(graphical.calls.trim().split("\n").map((line) => line.split(" ")[0])).toEqual(["verify", "pull", "tools", "stage", "activate"]);
  expect(graphical.calls).toContain("--gui");
  expect(graphical.calls).toContain("1".repeat(64));
  expect(graphical.calls).toContain("b".repeat(40));
  expect(graphical.calls).toContain(`stage ${graphical.source}/scripts/linux-lifecycle.ts stage ${graphical.source} ${"1".repeat(64)}\n`);

  const headless = await invoke(false);
  expect(headless.exitCode).toBe(0);
  expect(headless.stdout).toBe("PULL_OK\n");
  expect(headless.calls).not.toContain("--gui");
  expect(headless.calls.trim().split("\n").map((line) => line.split(" ")[0])).toEqual(["verify", "pull", "tools", "stage", "activate"]);
});

test("auto-update remains non-graphical even when graphical session variables are present", async () => {
  const automatic = await invoke(true, null, "updated", { COCKPIT_AUTO_UPDATE: "1" });
  expect(automatic.exitCode).toBe(0);
  expect(automatic.calls).not.toContain("--gui");
});

test("rejects unknown update arguments before lifecycle mutation", async () => {
  const invalid = await invoke(false, null, "updated", {}, ["--unknown"]);
  expect(invalid.exitCode).toBe(2);
  expect(invalid.stderr).toContain("usage: scripts/update-linux [--open]");
  expect(invalid.calls).toBe("");
});

test("returns a clean no-op when the source and active revisions already match", async () => {
  const current = await invoke(false, null, "noop");
  expect(current.exitCode).toBe(0);
  expect(current.stdout).toBe("update: noop\n");
  expect(current.calls.trim().split("\n")).toEqual(["verify", "pull"]);
});

test("does not hand off before pull or staging succeeds and reports activation rollback", async () => {
  const pull = await invoke(false, "pull");
  expect(pull.exitCode).toBe(1);
  expect(pull.stdout).not.toContain("PULL_OK");
  expect(pull.stderr).toContain("UPDATE_FAILED pull-broke");
  expect(pull.calls.trim().split("\n")).toEqual(["verify", "pull"]);

  const stage = await invoke(false, "stage");
  expect(stage.exitCode).toBe(1);
  expect(stage.calls.trim().split("\n").map((line) => line.split(" ")[0])).toEqual(["verify", "pull", "tools", "stage"]);
  expect(stage.calls).toContain(`stage ${stage.source}/scripts/linux-lifecycle.ts stage ${stage.source} ${"1".repeat(64)}\n`);
  expect(stage.stderr).toContain("UPDATE_FAILED release staging failed");


  const activation = await invoke(true, "activate");
  expect(activation.exitCode).toBe(1);
  expect(activation.stdout).toContain("PULL_OK");
  expect(activation.calls.trim().split("\n").map((line) => line.split(" ")[0])).toEqual(["verify", "pull", "tools", "stage", "activate"]);
  expect(activation.stderr).toContain("prior release was restored");
});
test("retries the old updater after a failed update published newer tool links", async () => {
  const result = await invoke(false, "activate", "updated", { PUBLISH_NEWER: "1", RETRY_AFTER_FAILURE: "1" });
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("prior release was restored");
  expect(result.retry?.exitCode).toBe(0);
  expect(result.retry?.stdout).toBe("PULL_OK\n");
  expect(result.calls.trim().split("\n").filter((line) => line === "verify")).toHaveLength(2);
});
