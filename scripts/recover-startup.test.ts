import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtures: { root: string; pidFile: string }[] = [];
afterEach(() => {
  for (const { root, pidFile } of fixtures.splice(0)) {
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM"); } catch { /* Backend already exited. */ }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function executable(path: string, contents: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${contents}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync([Bun.which("git")!, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.toString().trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cockpit-recover-startup-"));
  const source = join(root, "source");
  const origin = join(root, "origin.git");
  const upstream = join(root, "upstream");
  const home = join(root, "home");
  const state = join(root, "state");
  const bin = join(root, "bin");
  const pidFile = join(state, "backend.pid");
  mkdirSync(join(source, "server"), { recursive: true });
  fixtures.push({ root, pidFile });
  for (const dir of [source, home, state, bin]) mkdirSync(dir, { recursive: true });

  git(root, "init", "--bare", origin);
  git(root, "init", "-b", "main", source);
  git(source, "config", "user.email", "fixture@example.test");
  git(source, "config", "user.name", "Fixture");
  for (const name of ["cockpit", "recover-startup", "auto-update", "update", "update-pull"]) {
    const content = readFileSync(join(import.meta.dir, name), "utf8");
    executable(join(source, "scripts", name), content.replace(/^#![^\n]*\n/, ""));
  }
  // The external installation boundary installs/restarts the backend, never the renderer.
  executable(join(source, "scripts", "install"), `
    printf 'installed\\n' >> "$COCKPIT_TEST_STATE/installs"
    "$COCKPIT_TEST_BIN/launchctl" kickstart "gui/$(id -u)/app.pr-cockpit.server"
  `);
  executable(join(bin, "uname"), "printf 'Darwin\\n'");
  // Keep the launcher's gh lookup from prepending a system directory ahead of the Git observer.
  executable(join(bin, "gh"), "exit 0");
  executable(join(bin, "git"), `
    if [[ "\${1:-}" == fetch ]]; then
      printf 'fetch\\n' >> "$COCKPIT_TEST_STATE/fetches"
      [[ "\${COCKPIT_TEST_SLOW_FETCH:-0}" != 1 ]] || sleep 0.6
    fi
    exec "$COCKPIT_TEST_REAL_GIT" "$@"
  `);
  executable(join(bin, "launchctl"), `
    agent="$COCKPIT_TEST_STATE/loaded"
    pid_file="$COCKPIT_TEST_STATE/backend.pid"
    case "\${1:-}" in
      print)
        [[ "\${2:-}" == */app.pr-cockpit.server && -f "$agent" ]] || exit 1
        if [[ -f "$pid_file" ]]; then
          pid="$(cat "$pid_file")"
          if kill -0 "$pid" 2>/dev/null && [[ "$(ps -o stat= -p "$pid" 2>/dev/null || true)" != *Z* ]]; then
            printf 'state = running\\npid = %s\\n' "$pid"
            exit 0
          fi
        fi
        printf 'state = not running\\n'
        ;;
      bootstrap)
        touch "$agent"
        "$0" kickstart "gui/$(id -u)/app.pr-cockpit.server"
        ;;
      kickstart)
        [[ -f "$agent" ]] || exit 1
        (
          cd "$COCKPIT_ROOT"
          nohup "$COCKPIT_TEST_BUN" server/main.ts > "$COCKPIT_TEST_STATE/backend.log" 2>&1 < /dev/null &
          echo "$!" > "$pid_file"
        )
        ;;
      *) exit 1 ;;
    esac
  `);
  writeFileSync(join(source, "server/main.ts"), `
    import "./whiteboard.ts";
    Bun.serve({ hostname: "127.0.0.1", port: Number(Bun.env.COCKPIT_PORT), fetch(req) {
      return Response.json(new URL(req.url).pathname === "/healthz" ? {root: process.cwd()} : {status: "repaired"});
    }});
  `);
  executable(join(source, "shell/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), `
    printf 'ELECTRON_STARTED %s\\n' "$COCKPIT_URL"
    printf 'ARG %s\\n' "$@"
  `);
  mkdirSync(join(home, "Library/LaunchAgents"), { recursive: true });
  writeFileSync(join(home, "Library/LaunchAgents/app.pr-cockpit.server.plist"), "fixture launch agent");
  git(source, "add", ".");
  git(source, "commit", "-m", "broken backend cannot import whiteboard");
  git(source, "remote", "add", "origin", origin);
  git(source, "push", "-u", "origin", "main");
  git(origin, "symbolic-ref", "HEAD", "refs/heads/main");
  const broken = git(source, "rev-parse", "HEAD");
  git(root, "clone", origin, upstream);
  git(upstream, "checkout", "main");
  git(upstream, "config", "user.email", "fixture@example.test");
  git(upstream, "config", "user.name", "Fixture");
  const portServer = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("reserved") });
  const port = portServer.port!;
  portServer.stop(true);
  const env: Record<string, string> = {
    ...Bun.env,
    COCKPIT_TEST_BIN: bin,
    HOME: home,
    PATH: `${bin}:${Bun.env.PATH}`,
    COCKPIT_ROOT: realpathSync(source),
    COCKPIT_DATA_DIR: join(root, "data"),
    COCKPIT_PORT: String(port),
    COCKPIT_NO_BUILD: "1",
    COCKPIT_SKIP_RECONCILE: "1",
    COCKPIT_UPDATE_DISABLED: "0",
    COCKPIT_TEST_REAL_GIT: Bun.which("git")!,
    COCKPIT_TEST_BUN: Bun.which("bun")!,
    COCKPIT_TEST_STATE: state,
    GIT_TERMINAL_PROMPT: "0",
  };
  const script = join(source, "scripts/cockpit");
  const launches = async () => {
    const proc = Bun.spawn([Bun.env.COCKPIT_TEST_LAUNCHER || script, "--managed-server", "--foreground-shell", "owner/repo#42"], {
      cwd: source, env, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  };
  return {
    root, source, origin, upstream, env, state, port, broken, launches,
    fix() {
      writeFileSync(join(upstream, "server/whiteboard.ts"), "export const ready = true;\n");
      git(upstream, "add", ".");
      git(upstream, "commit", "-m", "repair missing backend module");
      git(upstream, "push", "origin", "main");
      return git(upstream, "rev-parse", "HEAD");
    },
    calls(name: string) {
      const path = join(state, name);
      return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
    },
  };
}


async function health(f: { port: number }) {
  // Readiness belongs to a separate real Bun process; fake timers cannot drive its socket binding.
  for (let n = 0; n < 50; n++) {
    try {
      const response = await fetch(`http://127.0.0.1:${f.port}/healthz`);
      if (response.ok) return response.json();
    } catch { /* Process has not bound the port yet. */ }
    await Bun.sleep(100);
  }
  throw new Error("Backend never became healthy");
}

test("failed installed backend repairs via Git update and serves HTTP without losing the original deep link", async () => {
  const f = fixture();
  const repaired = f.fix();
  const result = await f.launches();
  expect(result.exitCode).toBe(0);
  expect(git(f.source, "rev-parse", "HEAD")).toBe(repaired);
  expect(await health(f)).toEqual({ root: realpathSync(f.source) });
  expect(await (await fetch(`http://127.0.0.1:${f.port}/`)).json()).toEqual({ status: "repaired" });
  expect(result.stdout).toContain(`ELECTRON_STARTED http://127.0.0.1:${f.port}/#/pr/owner/repo/42`);
  expect(f.calls("fetches")).toHaveLength(1);
  expect(f.calls("installs")).toHaveLength(1);
}, 30_000);

test("healthy installed backend launches without attempting an update", async () => {
  const f = fixture();
  f.fix();
  git(f.source, "fetch", "origin", "main");
  git(f.source, "merge", "--ff-only", "origin/main");
  const server = Bun.spawnSync([join(f.root, "bin/launchctl"), "bootstrap", "gui/1", "fixture"], { cwd: f.source, env: f.env, stdout: "pipe", stderr: "pipe" });
  expect(server.exitCode).toBe(0);
  expect(await health(f)).toEqual({ root: realpathSync(f.source) });
  const result = await f.launches();
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(`ELECTRON_STARTED http://127.0.0.1:${f.port}/#/pr/owner/repo/42`);
  expect(f.calls("fetches")).toEqual([]);
  expect(f.calls("installs")).toEqual([]);
}, 20_000);

test("disabled updates, unavailable origin, and unchanged upstream keep failed backend failed", async () => {
  for (const reason of ["disabled", "network", "unchanged"] as const) {
    const f = fixture();
    if (reason === "disabled") {
      f.fix();
      f.env.COCKPIT_UPDATE_DISABLED = "1";
    } else if (reason === "network") {
      git(f.source, "remote", "set-url", "origin", join(f.root, "offline-origin.git"));
    }
    const result = await f.launches();
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("ELECTRON_STARTED");
    expect(git(f.source, "rev-parse", "HEAD")).toBe(f.broken);
    expect(f.calls("fetches")).toHaveLength(reason === "disabled" ? 0 : 1);
    if (reason === "network") expect(result.stderr).toContain("UPDATE_FAILED");
  }
}, 40_000);

test("automatic repair preserves staged and unstaged tracked edits instead of updating checkout", async () => {
  const f = fixture();
  f.fix();
  writeFileSync(join(f.source, "server/main.ts"), `${readFileSync(join(f.source, "server/main.ts"), "utf8")}\n// staged user change\n`);
  git(f.source, "add", "server/main.ts");
  writeFileSync(join(f.source, "server/main.ts"), `${readFileSync(join(f.source, "server/main.ts"), "utf8")}\n// unstaged user change\n`);
  const before = git(f.source, "status", "--porcelain=v1");
  const result = await f.launches();
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout).not.toContain("ELECTRON_STARTED");
  expect(git(f.source, "rev-parse", "HEAD")).toBe(f.broken);
  expect(git(f.source, "status", "--porcelain=v1")).toBe(before);
  expect(readFileSync(join(f.source, "server/main.ts"), "utf8")).toContain("// unstaged user change");
  expect(git(f.source, "branch", "--list", "local-edits-*")).toBe("");
  expect(f.calls("installs")).toEqual([]);
}, 20_000);

test("recovery preserves a local branch and divergent commits rather than resetting history", async () => {
  for (const mode of ["local branch", "diverged main"] as const) {
    const f = fixture();
    f.fix();
    if (mode === "local branch") {
      git(f.source, "checkout", "-b", "local-work");
    } else {
      writeFileSync(join(f.source, "notes.txt"), "local commit must survive recovery\n");
      git(f.source, "add", "notes.txt");
      git(f.source, "commit", "-m", "local work");
    }
    const head = git(f.source, "rev-parse", "HEAD");
    const branch = git(f.source, "branch", "--show-current");
    const result = await f.launches();
    expect(result.exitCode).not.toBe(0);
    expect(git(f.source, "rev-parse", "HEAD")).toBe(head);
    expect(git(f.source, "branch", "--show-current")).toBe(branch);
    expect(git(f.source, "branch", "--list", "local-edits-*")).toBe("");
    expect(f.calls("installs")).toEqual([]);
  }
}, 30_000);

test("simultaneous failed launches and a respawn make only one network update attempt", async () => {
  const f = fixture();
  git(f.source, "remote", "set-url", "origin", join(f.root, "offline-origin.git"));
  f.env.COCKPIT_TEST_SLOW_FETCH = "1";
  const [first, second] = await Promise.all([f.launches(), f.launches()]);
  const third = await f.launches();
  for (const result of [first, second, third]) {
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("ELECTRON_STARTED");
  }
  expect(f.calls("fetches")).toHaveLength(1);
  expect(f.calls("installs")).toEqual([]);
  expect(git(f.source, "rev-parse", "HEAD")).toBe(f.broken);
}, 30_000);

test("foreign HTTP server cannot trigger recovery or be signaled as the managed backend", async () => {
  const f = fixture();
  const foreign = Bun.serve({ port: f.port, hostname: "127.0.0.1", fetch: () => Response.json({ root: "/other/installation" }) });
  try {
    const result = await f.launches();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("serving a different instance");
    expect(f.calls("fetches")).toEqual([]);
    expect(f.calls("installs")).toEqual([]);
    expect(await (await fetch(`http://127.0.0.1:${f.port}/healthz`)).json()).toEqual({ root: "/other/installation" });
  } finally {
    foreign.stop(true);
  }
}, 20_000);
