#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, type Stats, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type SmokeArgs = { source: string; output: string; printPlan: boolean };

export function parseSmokeArgs(argv: string[]): SmokeArgs {
  let source = "";
  let output = "";
  let printPlan = false;
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--source") source = argv[++index] ?? "";
    else if (value === "--output") output = argv[++index] ?? "";
    else if (value === "--print-plan") printPlan = true;
    else if (value === "--help" || value === "-h") throw new Error(usage());
    else throw new Error(`unknown argument: ${value}\n${usage()}`);
  }
  if (!source || !output) throw new Error(usage());
  if (!isAbsolute(source) || !isAbsolute(output)) throw new Error("--source and --output must be absolute paths");
  return { source: resolve(source), output: resolve(output), printPlan };
}

export function isFixtureUsername(value: string | undefined): value is string {
  return typeof value === "string" && /^pr-?cockpit-smoke(?:-[a-z0-9]+)?$/.test(value);
}

export function prepareRuntimeRootForRemoval(runtimeRoot: string, expectedUid: number): void {
  const root = lstatSync(runtimeRoot, { throwIfNoEntry: false });
  if (!root) throw new Error(`runtime root is missing: ${runtimeRoot}`);
  if (root.isSymbolicLink()) throw new Error(`runtime root must not be a symlink: ${runtimeRoot}`);
  if (!root.isDirectory()) throw new Error(`runtime root must be a directory: ${runtimeRoot}`);
  if (root.uid !== expectedUid) throw new Error(`runtime root belongs to foreign UID ${root.uid}: ${runtimeRoot}`);

  const nodes: Array<{ path: string; stat: Stats }> = [];
  const visit = (path: string, observed: Stats): void => {
    if (observed.uid !== expectedUid) throw new Error(`runtime descendant belongs to foreign UID ${observed.uid}: ${path}`);
    if (observed.isSymbolicLink()) return;
    if (observed.isDirectory()) {
      nodes.push({ path, stat: observed });
      for (const name of readdirSync(path)) visit(join(path, name), lstatSync(join(path, name)));
    } else if (observed.isFile()) {
      nodes.push({ path, stat: observed });
    }
  };
  visit(runtimeRoot, root);

  for (const node of nodes.reverse()) {
    const descriptor = openSync(node.path, constants.O_RDONLY | constants.O_NOFOLLOW | (node.stat.isDirectory() ? constants.O_DIRECTORY : 0));
    try {
      const current = fstatSync(descriptor);
      const changed = current.dev !== node.stat.dev || current.ino !== node.stat.ino
        || current.uid !== expectedUid
        || current.isDirectory() !== node.stat.isDirectory() || current.isFile() !== node.stat.isFile();
      if (changed) throw new Error(`runtime node changed during ownership verification: ${node.path}`);
      fchmodSync(descriptor, (current.mode & 0o7777) | (current.isDirectory() ? 0o700 : 0o600));
    } finally {
      closeSync(descriptor);
    }
  }
}
export function serializePublicManifest(manifest: unknown, forbidden: string[]): string {
  const visit = (value: unknown, key = ""): void => {
    if (/timestamp|generatedAt|createdAt|updatedAt/i.test(key)) throw new Error(`public manifest forbids nondeterministic field: ${key}`);
    if (typeof value === "string") {
      if (forbidden.some((secret) => secret && value.includes(secret))) throw new Error(`public manifest contains private value in ${key}`);
      if (/^\/(?:home|Users|private|run|tmp)\//.test(value)) throw new Error(`public manifest contains absolute path in ${key}`);
    } else if (Array.isArray(value)) value.forEach((entry) => visit(entry, key));
    else if (value && typeof value === "object") for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
  };
  visit(manifest);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function usage(): string {
  return [
    "usage: bun scripts/linux-smoke.ts --source /absolute/candidate/checkout --output /absolute/proof-directory [--print-plan]",
    "",
    "Run as the dedicated disposable fixture account attested by COCKPIT_SMOKE_FIXTURE_USER, COCKPIT_SMOKE_FIXTURE_UID, and COCKPIT_SMOKE_FIXTURE_HOME.",
    "Its real HOME and default XDG roots must be clean; its systemd user manager and session bus must be live.",
    "The harness uses fixture port 14820 and leaves only screenshots plus manifest.json in --output.",
    "--print-plan validates arguments and prints the state machine without touching the machine.",
  ].join("\n");
}

export const SMOKE_STATES = [
  "preflight",
  "candidate-remote",
  "install-a-first",
  "install-a-second",
  "native-shell",
  "protocol-and-ui",
  "update-b",
  "rollback-c",
  "uninstall-first",
  "uninstall-second",
  "reinstall-c",
  "manifest",
  "cleanup",
] as const;

const PORT = 14820;
const FIXTURE_RELATIVE = "server/mockData/rust-lang-rust";
const FIXTURE_REPO = "rust-lang/rust";
const FIXTURE_PR = 160859;
const WIDTH = 1600;
const HEIGHT = 1200;
const PUBLIC_REMOTE = "https://github.com/theolundqvist/pr-cockpit.git";
const REQUIRED_TOOLS = [
  "bash", "bun", "curl", "dbus-send", "desktop-file-validate", "file", "gio", "git", "gh", "id", "openbox", "ps", "scrot", "stalonetray",
  "systemctl", "update-desktop-database", "xclip", "xdg-mime", "xdg-open", "xdotool", "xprop", "xwininfo", "Xvfb",
];

function command(name: string, env = process.env): string {
  const found = Bun.which(name, { PATH: env.PATH });
  if (!found) throw new Error(`missing required tool: ${name}`);
  return found;
}

function run(argv: string[], options: { cwd?: string; env?: Record<string, string | undefined>; stdin?: Uint8Array; allowFailure?: boolean } = {}): string {
  const result = Bun.spawnSync(argv, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdin: options.stdin,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0 && !options.allowFailure) {
    throw new Error(`${basename(argv[0])} failed (${result.exitCode}): ${(stderr || stdout).trim()}`);
  }
  return stdout.trim();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sleep(milliseconds: number): Promise<void> {
  return Bun.sleep(milliseconds);
}
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function processUid(pid: number): number | null {
  try {
    const match = readFileSync(`/proc/${pid}/status`, "utf8").match(/^Uid:\s+(\d+)/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function processCommand(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function processStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}
function processExe(pid: number): string | null {
  try {
    return realpathSync(`/proc/${pid}/exe`);
  } catch {
    return null;
  }
}

function processEnvironment(pid: number): string[] {
  try {
    return readFileSync(`/proc/${pid}/environ`).toString("utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function processParent(pid: number): number | null {
  try {
    const match = readFileSync(`/proc/${pid}/status`, "utf8").match(/^PPid:\s+(\d+)/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}
function processStatus(pid: number, field: string): string {
  try {
    return readFileSync(`/proc/${pid}/status`, "utf8").match(new RegExp(`^${field}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

export function isRendererCommand(command: string[]): boolean {
  return /(?:^|[\s\0])--type=renderer(?:[\s\0]|$)/.test(command.join("\0"));
}

export function hasSandboxDisablingArgument(command: string[]): boolean {
  return /(?:^|[\s\0])--(?:no-sandbox|disable-setuid-sandbox|disable-seccomp-filter-sandbox|disable-namespace-sandbox|disable-gpu-sandbox)(?:=|[\s\0]|$)/.test(command.join("\0"));
}

function verifyElectronProcessTree(rootPid: number, uid: number): number[] {
  const tree = [rootPid, ...descendants(rootPid)];
  for (const pid of tree) {
    if (processUid(pid) !== uid) throw new Error(`Electron process ${pid} escaped the fixture UID`);
    if (hasSandboxDisablingArgument(processCommand(pid))) throw new Error(`Electron process ${pid} carries a sandbox-disabling argument`);
  }
  return tree;
}

function verifySandboxedRenderers(rootPid: number, uid: number): number[] {
  const renderers = verifyElectronProcessTree(rootPid, uid).filter((pid) => pid !== rootPid && isRendererCommand(processCommand(pid)));
  if (!renderers.length) throw new Error("sandboxed Electron renderer process was not observed");
  for (const pid of renderers) {
    if (processStatus(pid, "NoNewPrivs") !== "1" || processStatus(pid, "Seccomp") !== "2") {
      throw new Error(`renderer ${pid} does not prove no-new-privileges plus seccomp filtering`);
    }
  }
  return renderers;
}

function descendants(pid: number): number[] {
  const output = run([command("ps"), "-e", "-o", "pid=,ppid="], { allowFailure: true });
  const children = new Map<number, number[]>();
  for (const line of output.split("\n")) {
    const [childText, parentText] = line.trim().split(/\s+/);
    const child = Number(childText);
    const parent = Number(parentText);
    if (!Number.isInteger(child) || !Number.isInteger(parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found: number[] = [];
  const visit = (parent: number) => {
    for (const child of children.get(parent) ?? []) {
      found.push(child);
      visit(child);
    }
  };
  visit(pid);
  return found;
}

async function main(): Promise<void> {
  process.umask(0o077);
  const args = parseSmokeArgs(process.argv.slice(2));
  if (args.printPlan) {
    console.log(JSON.stringify({
      version: 1,
      states: SMOKE_STATES,
      preflight: { fixtureAttestation: ["COCKPIT_SMOKE_FIXTURE_USER", "COCKPIT_SMOKE_FIXTURE_UID", "COCKPIT_SMOKE_FIXTURE_HOME"], realHome: true, defaultXdg: true, cleanRoots: true, authEnvironment: "allowlist" },
      transport: { publicUrl: PUBLIC_REMOTE, candidateRemote: "shallow-local-bare", gitNetwork: "denied", credentials: "absent" },
      install: { repetitions: 2, artifactPaths: "complete", byteStable: true, autostart: "gio launch --hidden without protocol fields" },
      native: { X11: true, windowManager: "Openbox", trayHost: "stalonetray-XEmbed", trayInteraction: ["menu-Show", "Escape-close"], sandbox: "NoNewPrivs=1 Seccomp=2 no disabling argv", singletonProcessRecord: "tray=ready", shortcut: "non-viewable to IsViewable transition", protocol: ["cold", "warm-distinct-transition", "invalid-exact-preservation"], routeObservation: "renderer clipboard", integratedFrame: "zero extents", trayScreenshot: true },
      lifecycle: { updatePayloads: ["B", "C"], priorOwnerExit: true, windowOwnerBinding: true, rollbackGate: "health", uninstallRepetitions: 2, protocolOwnerRestoration: "owned-foreign-byte-exact", preservedSentinels: ["data", "config", "checkout", "adjacent", "foreign-desktop-handler"] },
      cleanup: { ownership: ["uid", "pid", "start", "exe", "ancestry", "run-id"], service: ["manifest", "fragment", "pid", "cgroup"], escalation: ["TERM", "bounded wait", "KILL"], final: ["all teardown gates before roots", "retry on error", "tray host and icon gone", "empty cgroup", "removed X socket", "owned roots only", "partial output removed"] },
      fixture: { port: PORT, repo: FIXTURE_REPO, pr: FIXTURE_PR },
      display: { width: WIDTH, height: HEIGHT },
      manifest: { deterministic: true, absolutePaths: false, secrets: false, timestamps: false, screenshots: ["main", "palette", "pr-files", "settings", "tray"] },
    }, null, 2));
    return;
  }
  if (process.platform !== "linux") throw new Error("Linux smoke proof requires Linux");
  if (typeof process.getuid !== "function" || process.getuid() === 0) throw new Error("Linux smoke proof must run as a dedicated non-root user");
  const uid = process.getuid();
  const fixtureUser = process.env.COCKPIT_SMOKE_FIXTURE_USER;
  const fixtureUid = process.env.COCKPIT_SMOKE_FIXTURE_UID;
  const originalHome = process.env.HOME;
  const fixtureHome = process.env.COCKPIT_SMOKE_FIXTURE_HOME;
  if (!isFixtureUsername(fixtureUser)) throw new Error("COCKPIT_SMOKE_FIXTURE_USER must attest a pr-cockpit-smoke fixture account");
  if (fixtureUid !== String(uid)) throw new Error("COCKPIT_SMOKE_FIXTURE_UID must equal the running UID");
  if (!originalHome || !fixtureHome || !isAbsolute(originalHome) || realpathSync(originalHome) !== realpathSync(fixtureHome)) throw new Error("COCKPIT_SMOKE_FIXTURE_HOME must equal the running user's real HOME");
  if (run([command("id"), "-un"]) !== fixtureUser) throw new Error("fixture username attestation does not match the running user");
  if (existsSync(args.output)) throw new Error(`--output must not already exist: ${args.output}`);
  const source = realpathSync(args.source);
  if (!existsSync(join(source, ".git"))) throw new Error("--source must be a git checkout");
  if (run([command("git"), "-C", source, "status", "--porcelain"])) throw new Error("--source must be clean so the candidate commit is exact");
  for (const tool of REQUIRED_TOOLS) command(tool);
  const release = readOsRelease();
  if (process.arch !== "x64") throw new Error("release proof requires x86_64");
  const home = realpathSync(originalHome);
  const homeStat = statSync(home);
  if (!homeStat.isDirectory() || homeStat.uid !== uid) throw new Error("fixture user HOME must belong to the fixture UID");
  if (args.output === home || args.output.startsWith(`${home}/`)) throw new Error("--output must be outside the disposable fixture HOME");
  const dataHome = join(home, ".local/share");
  const configHome = join(home, ".config");
  const stateHome = join(home, ".local/state");
  for (const [name, configured, expected] of [
    ["XDG_DATA_HOME", process.env.XDG_DATA_HOME, dataHome],
    ["XDG_CONFIG_HOME", process.env.XDG_CONFIG_HOME, configHome],
    ["XDG_STATE_HOME", process.env.XDG_STATE_HOME, stateHome],
  ] as const) {
    if (configured && resolve(configured) !== expected) throw new Error(`${name} must be unset or its default fixture-home path`);
  }
  for (const path of [".gitconfig", ".netrc", ".npmrc", ".ssh", ".config/gh", ".config/gcloud", ".docker", ".local/share/keyrings"]) {
    if (existsSync(join(home, path))) throw new Error(`fixture HOME contains an authentication channel: ${path}`);
  }
  const checkout = join(home, ".pr-cockpit");
  const applicationsDir = join(dataHome, "applications");
  const applicationsDirExisted = existsSync(applicationsDir);
  const foreignHandlerPath = join(applicationsDir, "linux-smoke-foreign.desktop");
  const mimeCachePath = join(applicationsDir, "mimeinfo.cache");
  const priorMimeCache = existsSync(mimeCachePath) ? readFileSync(mimeCachePath) : null;
  const mimeAppsPath = join(configHome, "mimeapps.list");
  const priorMimeApps = existsSync(mimeAppsPath) ? readFileSync(mimeAppsPath) : null;
  const fixtureRuntimeRoot = join(dataHome, "pr-cockpit-runtime");
  const cleanPaths = [
    checkout,
    join(dataHome, "pr-cockpit"), fixtureRuntimeRoot, join(dataHome, "applications/app.pr-cockpit.desktop"), foreignHandlerPath,
    join(dataHome, "icons/hicolor/512x512/apps/app.pr-cockpit.png"), join(configHome, "pr-cockpit"),
    join(configHome, "autostart/app.pr-cockpit.desktop"), join(configHome, "systemd/user/pr-cockpit.service"),
    join(stateHome, "pr-cockpit"), join(home, ".local/bin/pr-cockpit"),
  ];
  for (const path of cleanPaths) if (existsSync(path)) throw new Error(`fixture root is not clean: ${path}`);
  const runtimeDir = `/run/user/${uid}`;
  if (!existsSync(runtimeDir) || statSync(runtimeDir).uid !== uid) throw new Error(`${runtimeDir} must exist and belong to the fixture UID`);
  const bus = join(runtimeDir, "bus");
  if (!existsSync(bus) || statSync(bus).uid !== uid) throw new Error("fixture user session bus is missing or foreign");
  const managerEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}` };
  run([command("systemctl", managerEnv), "--user", "show-environment"], { env: managerEnv });
  run([command("dbus-send", managerEnv), "--session", "--dest=org.freedesktop.DBus", "--type=method_call", "/", "org.freedesktop.DBus.ListNames"], { env: managerEnv });
  const listener = Bun.listen({ hostname: "127.0.0.1", port: PORT, socket: { data() {} } });
  listener.stop(true);

  const scratch = mkdtempSync(join(tmpdir(), `pr-cockpit-linux-smoke-${uid}-`));
  let resourcesCleaned = false;
  let published = false;
  let cleanup = (preserveOutput = false) => {
    const errors: unknown[] = [];
    if (!resourcesCleaned) {
      try { rmSync(scratch, { recursive: true, force: true }); } catch (error) { errors.push(error); }
      resourcesCleaned = true;
    }
    if (!preserveOutput) try { rmSync(args.output, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Linux smoke cleanup failed");
  };
  process.once("SIGINT", () => { try { cleanup(false); } finally { process.exit(130); } });
  process.once("SIGTERM", () => { try { cleanup(false); } finally { process.exit(143); } });
  try {
  mkdirSync(args.output, { recursive: false, mode: 0o755 });
  const candidateRemote = join(scratch, "candidate.git");
  const gitFixtureBin = join(scratch, "bin");
  mkdirSync(gitFixtureBin, { recursive: true, mode: 0o700 });
  const realGit = command("git", managerEnv);
  const remoteUrl = pathToFileURL(candidateRemote).href;
  writeFileSync(join(gitFixtureBin, "git"), [
    "#!/bin/sh",
    "previous=",
    "for argument do",
    "  case \"$argument\" in",
    `    '${PUBLIC_REMOTE}'|'${remoteUrl}'|file://*|'') ;;`,
    "    *://*|git@*|ssh:*) echo 'linux-smoke: denied non-fixture git transport' >&2; exit 86 ;;",
    "  esac",
    "  if [ \"$previous\" = remote ] && [ \"$argument\" = get-url ]; then",
    `    exec '${realGit.replaceAll("'", "'\\''")}' \"$@\"`,
    "  fi",
    "  previous=$argument",
    "done",
    `exec '${realGit.replaceAll("'", "'\\''")}' -c 'protocol.file.allow=always' -c 'protocol.http.allow=never' -c 'protocol.https.allow=never' -c 'protocol.ssh.allow=never' -c 'url.${remoteUrl.replaceAll("'", "'\\''")}.insteadOf=${PUBLIC_REMOTE}' \"$@\"`,
    "",
  ].join("\n"), { mode: 0o755 });
  const allowedEnvironment = ["LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ"];
  const env: Record<string, string> = {};
  for (const name of allowedEnvironment) if (process.env[name]) env[name] = process.env[name]!;
  Object.assign(env, {
    HOME: home,
    USER: fixtureUser,
    LOGNAME: fixtureUser,
    XDG_DATA_HOME: dataHome,
    XDG_CONFIG_HOME: configHome,
    XDG_STATE_HOME: stateHome,
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus}`,
    COCKPIT_HOME: checkout,
    COCKPIT_PORT: String(PORT),
    COCKPIT_SMOKE_RUN_ID: createHash("sha256").update(`${process.pid}:${Date.now()}:${scratch}`).digest("hex"),
    PATH: `${gitFixtureBin}:${managerEnv.PATH}`,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GIT_SSH_COMMAND: "/bin/false",
    NO_COLOR: "1",
  });
  const manifestPath = join(stateHome, "pr-cockpit/install-manifest.json");
  const owned = new Map<number, { start: string; exe: string; label: string; runId: boolean; parent?: number }>();
  let xSocket = "";
  let trayHostWindow = "";
  let trayIconWindow = "";
  const remember = (pid: number, label: string, mode: "direct" | "manager" = "direct") => {
    const deadline = Date.now() + 2000;
    const runId = mode === "direct";
    const parent = mode === "direct" ? process.pid : undefined;
    while (true) {
      const start = processStart(pid);
      const exe = processExe(pid);
      const hasRunId = processEnvironment(pid).includes(`COCKPIT_SMOKE_RUN_ID=${env.COCKPIT_SMOKE_RUN_ID}`);
      if (start && exe && processUid(pid) === uid && (!runId || hasRunId) && (parent === undefined || processParent(pid) === parent)) {
        owned.set(pid, { start, exe, label, runId, parent });
        return;
      }
      if (Date.now() >= deadline) throw new Error(`could not prove PID/start/exe ownership of ${label} pid ${pid}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  };
  const sameOwnedProcess = (pid: number, identity: { start: string; exe: string; runId: boolean; parent?: number }) =>
    processUid(pid) === uid
    && processStart(pid) === identity.start
    && processExe(pid) === identity.exe
    && (!identity.runId || processEnvironment(pid).includes(`COCKPIT_SMOKE_RUN_ID=${env.COCKPIT_SMOKE_RUN_ID}`))
    && (identity.parent === undefined || processParent(pid) === identity.parent);
  const stopOwned = (pid: number) => {
    const identity = owned.get(pid);
    if (!identity || !sameOwnedProcess(pid, identity)) return;
    const tree = [...descendants(pid).reverse(), pid].map((treePid) => ({
      pid: treePid,
      start: processStart(treePid),
      exe: processExe(treePid),
      runId: identity.runId,
    })).filter((entry): entry is { pid: number; start: string; exe: string; runId: boolean } =>
      !!entry.start && !!entry.exe && processUid(entry.pid) === uid
      && (identity.runId
        ? processEnvironment(entry.pid).includes(`COCKPIT_SMOKE_RUN_ID=${env.COCKPIT_SMOKE_RUN_ID}`)
        : entry.exe === identity.exe));
    for (const entry of tree) if (sameOwnedProcess(entry.pid, entry)) try { process.kill(entry.pid, "SIGTERM"); } catch {}
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && tree.some((entry) => sameOwnedProcess(entry.pid, entry))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    for (const entry of tree) if (sameOwnedProcess(entry.pid, entry)) try { process.kill(entry.pid, "SIGKILL"); } catch {}
    const killDeadline = Date.now() + 1000;
    while (Date.now() < killDeadline && tree.some((entry) => sameOwnedProcess(entry.pid, entry))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    if (tree.some((entry) => sameOwnedProcess(entry.pid, entry))) throw new Error(`owned ${identity.label} process tree did not stop`);
  };
  const verifiedServiceOwnership = () => {
    if (!existsSync(manifestPath)) return false;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (realpathSync(manifest.sourceRoot) !== realpathSync(checkout)) return false;
    const unit = join(configHome, "systemd/user/pr-cockpit.service");
    const unitArtifact = manifest.artifacts.find((artifact: { path: string }) => artifact.path === unit);
    if (!unitArtifact) return false;
    const fragment = run([command("systemctl", env), "--user", "show", "pr-cockpit.service", "--property=FragmentPath", "--value"], { env, allowFailure: true });
    const servicePid = Number(run([command("systemctl", env), "--user", "show", "pr-cockpit.service", "--property=MainPID", "--value"], { env, allowFailure: true }));
    const cgroup = run([command("systemctl", env), "--user", "show", "pr-cockpit.service", "--property=ControlGroup", "--value"], { env, allowFailure: true });
    const cgroupEmpty = !cgroup || !existsSync(join("/sys/fs/cgroup", cgroup, "cgroup.procs")) || readFileSync(join("/sys/fs/cgroup", cgroup, "cgroup.procs"), "utf8").trim() === "";
    if (!existsSync(unit)) return manifest.artifacts.every((artifact: { path: string }) => !lstatSync(artifact.path, { throwIfNoEntry: false })) && !fragment && !servicePid && cgroupEmpty;
    if (sha256(unit) !== unitArtifact.sha256 || !fragment || realpathSync(fragment) !== realpathSync(unit)) return false;
    if (!servicePid) return cgroupEmpty;
    if (processUid(servicePid) !== uid || !processEnvironment(servicePid).includes(`COCKPIT_SMOKE_RUN_ID=${env.COCKPIT_SMOKE_RUN_ID}`)) return false;
    return cgroup.endsWith("/pr-cockpit.service") && readFileSync(join("/sys/fs/cgroup", cgroup, "cgroup.procs"), "utf8").split(/\s+/).map(Number).includes(servicePid);
  };
  cleanup = (preserveOutput = false) => {
    const errors: unknown[] = [];
    const attempt = (stage: () => void) => { try { stage(); } catch (error) { errors.push(error); } };
    if (!resourcesCleaned) {
      for (const pid of [...owned.keys()].reverse()) attempt(() => stopOwned(pid));
      attempt(() => {
        if (existsSync(manifestPath)) {
          if (!verifiedServiceOwnership()) {
            throw new Error("refusing service cleanup without verified manifest/fragment/PID/cgroup ownership");
          }
          if (existsSync(join(checkout, "scripts/uninstall"))) run([join(checkout, "scripts/uninstall")], { env });
        } else {
          const fragment = run([command("systemctl", env), "--user", "show", "pr-cockpit.service", "--property=FragmentPath", "--value"], { env, allowFailure: true });
          if (fragment) {
            throw new Error("refusing unmanifested loaded service cleanup");
          }
        }
      });
      attempt(() => {
        const servicePid = run([command("systemctl", env), "--user", "show", "pr-cockpit.service", "--property=MainPID", "--value"], { env, allowFailure: true });
        const cgroup = run([command("systemctl", env), "--user", "show", "pr-cockpit.service", "--property=ControlGroup", "--value"], { env, allowFailure: true });
        if (servicePid && servicePid !== "0") throw new Error("fixture service remains after cleanup");
        if (cgroup && existsSync(join("/sys/fs/cgroup", cgroup, "cgroup.procs")) && readFileSync(join("/sys/fs/cgroup", cgroup, "cgroup.procs"), "utf8").trim()) {
          throw new Error("fixture service cgroup is not empty after cleanup");
        }
      });
      attempt(() => {
        if (trayIconWindow && windowExists(env, trayIconWindow)) throw new Error("fixture tray icon remains after cleanup");
        if (trayHostWindow && windowExists(env, trayHostWindow)) throw new Error("fixture tray host remains after cleanup");
      });
      attempt(() => {
        const socketDeadline = Date.now() + 1000;
        while (xSocket && existsSync(xSocket) && Date.now() < socketDeadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        if (xSocket && existsSync(xSocket)) throw new Error("fixture X socket remains after cleanup");
      });
      if (errors.length === 0) {
        attempt(() => {
          if (lstatSync(fixtureRuntimeRoot, { throwIfNoEntry: false })) prepareRuntimeRootForRemoval(fixtureRuntimeRoot, uid);
        });
        if (errors.length === 0) for (const path of [...cleanPaths].reverse()) attempt(() => rmSync(path, { recursive: true, force: true }));
        attempt(() => rmSync(join(home, "linux-smoke-adjacent-sentinel"), { force: true }));
        attempt(() => {
          if (existsSync(applicationsDir)) run([command("update-desktop-database", env), applicationsDir], { env });
          if (priorMimeCache) writeFileSync(mimeCachePath, priorMimeCache);
          else rmSync(mimeCachePath, { force: true });
          if (!applicationsDirExisted) rmSync(applicationsDir, { recursive: true, force: true });
        });
        attempt(() => {
          if (priorMimeApps) {
            mkdirSync(configHome, { recursive: true, mode: 0o700 });
            writeFileSync(mimeAppsPath, priorMimeApps);
          } else {
            rmSync(mimeAppsPath, { force: true });
          }
        });
        attempt(() => rmSync(scratch, { recursive: true, force: true }));
        if (errors.length === 0) resourcesCleaned = true;
      }
    }
    if (!preserveOutput) attempt(() => rmSync(args.output, { recursive: true, force: true }));
    if (errors.length) throw new AggregateError(errors, "Linux smoke cleanup failed");
  };

    mkdirSync(applicationsDir, { recursive: true, mode: 0o700 });
    const foreignHandlerBytes = Buffer.from([
      "[Desktop Entry]",
      "Type=Application",
      "Name=Linux Smoke Foreign Handler",
      "Exec=/bin/true %u",
      "NoDisplay=true",
      "MimeType=x-scheme-handler/prcockpit;",
      "",
    ].join("\n"));
    writeFileSync(foreignHandlerPath, foreignHandlerBytes, { mode: 0o600 });
    run([command("desktop-file-validate", env), foreignHandlerPath], { env });
    run([command("update-desktop-database", env), applicationsDir], { env });
    run([command("xdg-mime", env), "default", "linux-smoke-foreign.desktop", "x-scheme-handler/prcockpit"], { env });
    const readProtocolOwner = () => {
      const result = Bun.spawnSync([command("xdg-mime", env), "query", "default", "x-scheme-handler/prcockpit"], { env, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(`xdg-mime query failed: ${result.stderr.toString().trim()}`);
      return result.stdout.toString();
    };
    const priorProtocolOwner = readProtocolOwner();
    if (priorProtocolOwner !== "linux-smoke-foreign.desktop\n") throw new Error("could not establish the owned foreign protocol-handler baseline");
    const candidateCommit = run([realGit, "-C", source, "rev-parse", "HEAD"], { env });
    const candidateBranch = run([realGit, "-C", source, "rev-parse", "--abbrev-ref", "HEAD"], { env });
    if (candidateBranch === "HEAD") throw new Error("candidate source must be on a branch");
    run([realGit, "clone", "--bare", "--depth=1", "--single-branch", "--no-tags", "--branch", candidateBranch, pathToFileURL(source).href, candidateRemote], { env });
    run([realGit, `--git-dir=${candidateRemote}`, "update-ref", "refs/heads/main", candidateCommit], { env });
    if (candidateBranch !== "main") run([realGit, `--git-dir=${candidateRemote}`, "update-ref", "-d", `refs/heads/${candidateBranch}`], { env });
    run([realGit, `--git-dir=${candidateRemote}`, "symbolic-ref", "HEAD", "refs/heads/main"], { env });
    run([realGit, `--git-dir=${candidateRemote}`, "config", "--remove-section", "remote.origin"], { env, allowFailure: true });
    const candidateRefs = run([realGit, `--git-dir=${candidateRemote}`, "for-each-ref", "--format=%(refname)"], { env }).split("\n").filter(Boolean);
    if (candidateRefs.length !== 1 || candidateRefs[0] !== "refs/heads/main") throw new Error("candidate remote contains non-owned refs");
    if (existsSync(join(candidateRemote, "objects/info/alternates"))) throw new Error("candidate remote depends on a foreign object store");
    run([realGit, `--git-dir=${candidateRemote}`, "fsck", "--strict", "--connectivity-only"], { env });
    const fixtureInRuntime = join(dataHome, "pr-cockpit-runtime/current", FIXTURE_RELATIVE);
    const persistentData = join(dataHome, "pr-cockpit");
    const configDir = join(configHome, "pr-cockpit");
    const serverEnv = join(configDir, "server.env");
    const adjacentSentinel = join(home, "linux-smoke-adjacent-sentinel");
    mkdirSync(persistentData, { recursive: true, mode: 0o700 });
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(persistentData, "proof-sentinel"), "preserve-across-lifecycle\n", { mode: 0o600 });
    writeFileSync(join(configDir, "proof-sentinel"), "preserve-across-lifecycle\n", { mode: 0o600 });
    writeFileSync(adjacentSentinel, "outside-owned-roots\n", { mode: 0o600 });
    writeFileSync(serverEnv, [
      `COCKPIT_DATA_DIR="${persistentData}"`,
      `COCKPIT_PORT=${PORT}`,
      "COCKPIT_MOCK=1",
      `COCKPIT_MOCK_DATA="${fixtureInRuntime}"`,
      "COCKPIT_REPO_ROOTS=",
      `COCKPIT_SMOKE_RUN_ID=${env.COCKPIT_SMOKE_RUN_ID}`,
      "",
    ].join("\n"), { mode: 0o600 });

    const bootstrap = readFileSync(join(source, "scripts/bootstrap"));
    run([command("bash", env), "-s"], { env, stdin: bootstrap });
    const firstManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const checkoutSentinel = join(checkout, "linux-smoke-checkout-sentinel");
    writeFileSync(checkoutSentinel, "preserve-checkout\n", { mode: 0o600 });
    const firstArtifacts = firstManifest.artifacts.map((artifact: { path: string; kind: string; sha256?: string; target?: string }) => ({ path: artifact.path, kind: artifact.kind, sha256: artifact.sha256 ?? null, target: artifact.target ?? null }));
    run([command("bash", env), "-s"], { env, stdin: bootstrap });
    const secondManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const secondArtifacts = secondManifest.artifacts.map((artifact: { path: string; kind: string; sha256?: string; target?: string }) => ({ path: artifact.path, kind: artifact.kind, sha256: artifact.sha256 ?? null, target: artifact.target ?? null }));
    if (JSON.stringify(firstArtifacts) !== JSON.stringify(secondArtifacts)) throw new Error("second install changed generated artifacts");
    if (secondManifest.revision !== candidateCommit) throw new Error("installed revision does not match candidate commit");
    const current = realpathSync(join(dataHome, "pr-cockpit-runtime/current"));
    const electronVersion = JSON.parse(readFileSync(join(current, "shell/node_modules/electron/package.json"), "utf8")).version;
    for (const artifact of secondManifest.artifacts) {
      const observed = lstatSync(artifact.path);
      if (artifact.kind === "file" && (!observed.isFile() || sha256(artifact.path) !== artifact.sha256)) throw new Error(`installed file artifact does not match its manifest: ${artifact.path}`);
      if (artifact.kind === "symlink" && (!observed.isSymbolicLink() || readlinkSync(artifact.path) !== artifact.target)) throw new Error(`installed link artifact does not match its manifest: ${artifact.path}`);
    }
    const desktopPath = join(dataHome, "applications/app.pr-cockpit.desktop");
    const autostartPath = join(configHome, "autostart/app.pr-cockpit.desktop");
    const iconPath = join(dataHome, "icons/hicolor/512x512/apps/app.pr-cockpit.png");
    const unitPath = join(configHome, "systemd/user/pr-cockpit.service");
    const wantsPath = join(configHome, "systemd/user/default.target.wants/pr-cockpit.service");
    const cliPath = join(home, ".local/bin/pr-cockpit");
    const expectedArtifactPaths = [join(dataHome, "pr-cockpit-runtime/current"), desktopPath, autostartPath, iconPath, unitPath, wantsPath, cliPath].sort();
    const actualArtifactPaths = secondManifest.artifacts.map((artifact: { path: string }) => artifact.path).sort();
    if (JSON.stringify(actualArtifactPaths) !== JSON.stringify(expectedArtifactPaths)) throw new Error("install manifest does not own the complete exact artifact allowlist");
    const launcherPath = join(dataHome, "pr-cockpit-runtime/current/scripts/cockpit");
    const protocolLauncher = join(runtimeDir, "pr-cockpit/launch");
    const expectedDesktop = `[Desktop Entry]\nType=Application\nName=PR Cockpit\nComment=Pull request cockpit\nExec=${protocolLauncher} %u\nIcon=app.pr-cockpit\nTerminal=false\nCategories=Development;\nStartupWMClass=app.pr-cockpit\nMimeType=x-scheme-handler/prcockpit;\n`;
    if (readFileSync(desktopPath, "utf8") !== expectedDesktop) throw new Error("desktop integration content is not exact");
    const autostart = readFileSync(autostartPath, "utf8");
    if (!autostart.includes(`Exec="${launcherPath}" --hidden`)
      || autostart.includes("%u")
      || autostart.includes("MimeType=")
      || !autostart.includes("StartupWMClass=app.pr-cockpit")) {
      throw new Error("autostart is not the distinct hidden, non-protocol launch entry");
    }
    const unitContent = readFileSync(unitPath, "utf8");
    if (!unitContent.includes("RuntimeDirectory=pr-cockpit\nRuntimeDirectoryMode=0700")
      || !unitContent.includes(`ExecStartPre="${command("ln", env)}" -sfnT "${launcherPath}" "${protocolLauncher}"`)
      || !unitContent.includes(`WorkingDirectory=${join(dataHome, "pr-cockpit-runtime/current")}`)
      || !unitContent.includes(`COCKPIT_SOURCE_ROOT=${checkout}`)
      || !unitContent.includes(`COCKPIT_RELEASE_REVISION=${candidateCommit}`)
      || !unitContent.includes(`${join(dataHome, "pr-cockpit-runtime/current/server/main.ts")}`)) {
      throw new Error("systemd unit content does not prove current-root/source/revision execution");
    }
    if (readlinkSync(cliPath) !== join(dataHome, "pr-cockpit-runtime/current/scripts/pr-cockpit")) throw new Error("CLI link target is not exact");
    if (readlinkSync(wantsPath) !== unitPath) throw new Error("systemd wants link target is not exact");
    if (!lstatSync(protocolLauncher).isSymbolicLink() || realpathSync(protocolLauncher) !== realpathSync(launcherPath)) throw new Error("runtime protocol launcher is not the active owned shell launcher");
    if (readProtocolOwner().trim() !== "app.pr-cockpit.desktop") {
      throw new Error("PR Cockpit is not the installed protocol handler");
    }
    if (current !== realpathSync(secondManifest.currentRelease)) throw new Error("active release and manifest disagree");
    const fragment = run([command("systemctl", env), "--user", "show", "pr-cockpit.service", "--property=FragmentPath", "--value"], { env });
    if (realpathSync(fragment) !== realpathSync(join(configHome, "systemd/user/pr-cockpit.service"))) throw new Error("systemd loaded an unexpected unit fragment");
    const servicePid = Number(run([command("systemctl", env), "--user", "show", "pr-cockpit.service", "--property=MainPID", "--value"], { env }));
    if (!servicePid || processUid(servicePid) !== uid) throw new Error("service does not run as the fixture UID");
    const health = JSON.parse(run([command("curl", env), "-fsS", `http://127.0.0.1:${PORT}/healthz`], { env }));
    const version = JSON.parse(run([command("curl", env), "-fsS", `http://127.0.0.1:${PORT}/api/version`], { env }));
    if (realpathSync(health.root) !== current || version.rev !== candidateCommit) throw new Error("health root and version revision do not prove candidate A");
    const controlGroup = run([command("systemctl", env), "--user", "show", "pr-cockpit.service", "--property=ControlGroup", "--value"], { env });
    if (!controlGroup.startsWith("/") || !controlGroup.endsWith("/pr-cockpit.service")) throw new Error("service has an unexpected user cgroup");
    const cgroupPids = readFileSync(join("/sys/fs/cgroup", controlGroup, "cgroup.procs"), "utf8").trim().split("\n").map(Number);
    if (!cgroupPids.includes(servicePid)) throw new Error("service MainPID is not in its user cgroup");
    run([join(home, ".local/bin/pr-cockpit"), "--help"], { env });

    let displayNumber = 90;
    while (existsSync(`/tmp/.X11-unix/X${displayNumber}`)) displayNumber++;
    if (displayNumber > 119) throw new Error("no isolated X11 display is available");
    env.DISPLAY = `:${displayNumber}`;
    const cliProof = JSON.parse(run([join(home, ".local/bin/pr-cockpit"), `${FIXTURE_REPO}#${FIXTURE_PR}`, "--json"], { env }));
    if (cliProof.ref !== `${FIXTURE_REPO}#${FIXTURE_PR}`) throw new Error("installed CLI did not return the mock pull request");
    xSocket = `/tmp/.X11-unix/X${displayNumber}`;
    const xvfb = Bun.spawn([command("Xvfb", env), env.DISPLAY, "-screen", "0", `${WIDTH}x${HEIGHT}x24`, "-nolisten", "tcp"], { env, stdout: "pipe", stderr: "pipe" });
    remember(xvfb.pid, "Xvfb");
    await waitFor(() => existsSync(xSocket), 5000, "Xvfb display socket");
    const openbox = Bun.spawn([command("openbox", env), "--sm-disable"], { env, stdout: "pipe", stderr: "pipe" });
    remember(openbox.pid, "Openbox");
    await waitFor(() => run([command("xprop", env), "-root", "_NET_SUPPORTING_WM_CHECK"], { env, allowFailure: true }).includes("window id"), 5000, "Openbox WM ownership");
    const trayWindowsBefore = new Set(rootWindows(env));
    const trayHost = Bun.spawn([
      command("stalonetray", env),
      "--geometry", "1x1-0+0",
      "--icon-size", "32",
      "--window-layer", "top",
      "--window-strut", "none",
      "--window-type", "dock",
      "--grow-gravity", "E",
      "--kludges", "force_icons_size",
    ], { env, stdout: "pipe", stderr: "pipe" });
    remember(trayHost.pid, "stalonetray");
    trayHostWindow = await waitForTrayHost(env, trayWindowsBefore);

    const launcher = join(dataHome, "pr-cockpit-runtime/current/scripts/cockpit");
    const deepLink = `prcockpit://pr/rust-lang/rust/${FIXTURE_PR}`;
    const shellProcessPath = join(persistentData, "shell-process");
    const readyShellIdentity = (): Record<string, string> | null => {
      if (!existsSync(shellProcessPath)) return null;
      const identity = Object.fromEntries(readFileSync(shellProcessPath, "utf8").trim().split("\n").map((line) => line.split("=", 2)));
      return identity.tray === "ready" ? identity : null;
    };
    const waitForReadyShellIdentity = async (label: string) => {
      let identity: Record<string, string> | null = null;
      await waitFor(() => !!(identity = readyShellIdentity()), 10000, label);
      return identity!;
    };
    const readShellIdentity = () => {
      const identity = readyShellIdentity();
      if (!identity) throw new Error("installed shell process record does not prove tray readiness");
      return identity;
    };
    const electronExecutable = join(current, "shell/node_modules/electron/dist/electron");

    run([command("gio", env), "launch", autostartPath], { env });
    const hiddenIdentity = await waitForReadyShellIdentity("hidden autostart Electron tray-ready process record");
    const hiddenPid = Number(hiddenIdentity.pid);
    if (hiddenIdentity.start !== processStart(hiddenPid) || realpathSync(hiddenIdentity.executable) !== electronExecutable || realpathSync(hiddenIdentity.release) !== current) {
      throw new Error("hidden autostart process record is not owned by the active release");
    }
    remember(hiddenPid, "hidden Electron", "manager");
    verifyElectronProcessTree(hiddenPid, uid);
    if (normalVisibleWindowsForPid(env, hiddenPid).length !== 0) throw new Error("hidden autostart exposed a viewable normal X11 window");
    trayIconWindow = await waitForTrayIcon(env, hiddenPid, trayHostWindow);
    const showMenu = await openOwnedTrayMenu(env, trayIconWindow, hiddenPid, [trayHostWindow]);
    run([command("xdotool", env), "key", "--clearmodifiers", "Home", "Return"], { env });
    await waitFor(() => !windowIsViewable(env, showMenu), 5000, "tray Show menu to close");
    const revealedHiddenWindow = await waitForWindow(env);
    await waitFor(() => {
      try { return verifySandboxedRenderers(hiddenPid, uid).length > 0; } catch { return false; }
    }, 10000, "revealed hidden Electron sandboxed renderer readiness");
    verifyWindowOwner(env, revealedHiddenWindow, hiddenPid);
    run([command("xdotool", env), "windowminimize", revealedHiddenWindow], { env });
    await waitForNotViewableWindow(env, revealedHiddenWindow);
    const closeMenu = await openOwnedTrayMenu(env, trayIconWindow, hiddenPid, [trayHostWindow, revealedHiddenWindow]);
    captureSurface(env, args.output, "tray", closeMenu, hiddenPid);
    run([command("xdotool", env), "key", "--clearmodifiers", "Escape"], { env });
    await waitFor(() => !windowIsViewable(env, closeMenu), 5000, "tray menu Escape close");
    stopOwned(hiddenPid);
    await waitFor(() => !existsSync(shellProcessPath), 5000, "hidden Electron process record removal");

    run([command("xdg-open", env), deepLink], { env });
    const shellIdentity = await waitForReadyShellIdentity("cold protocol Electron tray-ready process record");
    const shellPid = Number(shellIdentity.pid);
    if (shellPid === hiddenPid || shellIdentity.start !== processStart(shellPid) || realpathSync(shellIdentity.executable) !== electronExecutable || realpathSync(shellIdentity.release) !== current) {
      throw new Error("cold protocol singleton record does not prove PID/start/executable/release ownership");
    }
    remember(shellPid, "Electron", "manager");
    if (processUid(shellPid) !== uid || processExe(shellPid) !== electronExecutable) throw new Error("desktop entry did not launch installed Electron as the fixture UID");
    trayIconWindow = await waitForTrayIcon(env, shellPid, trayHostWindow);
    verifyElectronProcessTree(shellPid, uid);

    const windowId = await waitForWindow(env);
    await waitFor(() => {
      try { return verifySandboxedRenderers(shellPid, uid).length > 0; } catch { return false; }
    }, 10000, "cold protocol Electron sandboxed renderer readiness");
    const wmClass = run([command("xprop", env), "-id", windowId, "WM_CLASS"], { env });
    const wmPid = run([command("xprop", env), "-id", windowId, "_NET_WM_PID"], { env });
    const windowType = run([command("xprop", env), "-id", windowId, "_NET_WM_WINDOW_TYPE"], { env });
    const frameExtents = run([command("xprop", env), "-id", windowId, "_NET_FRAME_EXTENTS"], { env });
    const startupWmClass = expectedDesktop.match(/^StartupWMClass=(.+)$/m)?.[1];
    const observedClasses = [...wmClass.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    if (!startupWmClass || observedClasses.at(-1) !== startupWmClass || !wmPid.endsWith(`= ${shellPid}`)
      || !windowType.includes("_NET_WM_WINDOW_TYPE_NORMAL") || !/ = 0, 0, 0, 0$/.test(frameExtents)) {
      throw new Error("X11 WM_CLASS/owner/type or zero-decoration integrated frame invariant failed");
    }
    verifyWindowOwner(env, windowId, shellPid);
    run([command("xdotool", env), "windowactivate", "--sync", windowId], { env });
    run([command("xdotool", env), "windowsize", "--sync", windowId, "1120", "840"], { env });
    run([command("xdotool", env), "windowmove", "--sync", windowId, "240", "180"], { env });
    await observeRouteText(env, windowId, "Brain Float");
    await clearRendererSelection(env, windowId);
    captureSurface(env, args.output, "main", windowId, shellPid);

    verifyWindowOwner(env, windowId, shellPid);
    const singletonWindowCount = normalVisibleWindowsForPid(env, shellPid).length;
    run([command("xdotool", env), "key", "--clearmodifiers", "super+comma"], { env });
    const beforeWarm = await observeRouteText(env, windowId, "Control center");
    run([command("xdg-open", env), deepLink], { env });
    const afterWarm = await observeRouteText(env, windowId, "Brain Float");
    await clearRendererSelection(env, windowId);
    if (afterWarm === beforeWarm || JSON.stringify(readShellIdentity()) !== JSON.stringify(shellIdentity) || normalVisibleWindowsForPid(env, shellPid).length !== singletonWindowCount) {
      throw new Error("warm protocol did not perform an exact route transition on the existing singleton/window");
    }

    run([command("xdotool", env), "windowminimize", windowId], { env });
    await waitForNotViewableWindow(env, windowId);
    run([command("xdotool", env), "key", "--clearmodifiers", "super+ctrl+g"], { env });
    await waitForVisibleWindow(env, windowId);
    verifyWindowOwner(env, windowId, shellPid);
    run([command("xdotool", env), "key", "--clearmodifiers", "super+alt+k"], { env });
    const paletteWindow = await waitForAdditionalWindow(env, shellPid, windowId);
    run([command("xdotool", env), "windowactivate", "--sync", paletteWindow], { env });
    const paletteQuery = "Brain Float";
    run([command("xdotool", env), "type", "--clearmodifiers", paletteQuery], { env });
    verifySandboxedRenderers(shellPid, uid);
    await observeFocusedText(env, paletteQuery);
    run([command("xdotool", env), "key", "--clearmodifiers", "End"], { env });
    await sleep(100);
    captureSurface(env, args.output, "palette", paletteWindow, shellPid);
    run([command("xdotool", env), "key", "Escape"], { env });
    await waitFor(() => !normalVisibleWindowsForPid(env, shellPid).includes(paletteWindow), 5000, "palette dismissal");

    const beforeInvalid = await windowContent(env, windowId);
    const invalidTarget = "Control center";
    run([command("xdg-open", env), `prcockpit://settings/rust-lang/rust/${FIXTURE_PR}`], { env });
    await requireStableWindowContent(env, windowId, beforeInvalid, invalidTarget);
    if (JSON.stringify(readShellIdentity()) !== JSON.stringify(shellIdentity) || normalVisibleWindowsForPid(env, shellPid).length !== singletonWindowCount) {
      throw new Error("invalid raw protocol changed the singleton process or window set");
    }
    run([command("xdotool", env), "key", "--clearmodifiers", "super+2"], { env });
    await observeRouteText(env, windowId, "rustc_abi");
    await clearRendererSelection(env, windowId);
    captureSurface(env, args.output, "pr-files", windowId, shellPid);
    run([command("xdotool", env), "key", "--clearmodifiers", "super+comma"], { env });
    await observeRouteText(env, windowId, "Control center");
    await clearRendererSelection(env, windowId);
    captureSurface(env, args.output, "settings", windowId, shellPid);

    const fixtureBuilder = join(scratch, "fixture-builder");
    run([command("git", env), "clone", remoteUrl, fixtureBuilder], { env });
    run([command("git", env), "-C", fixtureBuilder, "config", "user.name", "PR Cockpit Fixture"], { env });
    run([command("git", env), "-C", fixtureBuilder, "config", "user.email", "fixture@invalid"], { env });
    const fixtureSnapshotPath = join(fixtureBuilder, FIXTURE_RELATIVE, "snapshot.json");
    const commitFixture = (label: "B" | "C") => {
      const fixture = JSON.parse(readFileSync(fixtureSnapshotPath, "utf8"));
      const detail = fixture.details.find((entry: { number?: number }) => entry.number === FIXTURE_PR);
      if (!detail) throw new Error("fixture snapshot is missing the smoke pull request detail");
      detail.title = `Linux smoke fixture ${label}`;
      writeFileSync(fixtureSnapshotPath, `${JSON.stringify(fixture, null, 2)}\n`);
      run([command("git", env), "-C", fixtureBuilder, "add", FIXTURE_RELATIVE + "/snapshot.json"], { env });
      run([command("git", env), "-C", fixtureBuilder, "commit", "-m", `Linux smoke fixture ${label}`], {
        env: { ...env, GIT_AUTHOR_DATE: label === "B" ? "2026-01-01T00:00:01Z" : "2026-01-01T00:00:02Z", GIT_COMMITTER_DATE: label === "B" ? "2026-01-01T00:00:01Z" : "2026-01-01T00:00:02Z" },
      });
      const revision = run([command("git", env), "-C", fixtureBuilder, "rev-parse", "HEAD"], { env });
      run([command("git", env), "-C", fixtureBuilder, "push", "origin", "HEAD:main"], { env });
      return revision;
    };
    const waitForShellRelease = async (expectedRelease: string, prior: Record<string, string>) => {
      let identity: Record<string, string> = {};
      await waitFor(() => {
        const observed = readyShellIdentity();
        if (!observed) return false;
        identity = observed;
        return (identity.pid !== prior.pid || identity.start !== prior.start)
          && processStart(Number(prior.pid)) !== prior.start
          && existsSync(`/proc/${identity.pid}`)
          && realpathSync(identity.release) === expectedRelease;
      }, 10000, `Electron release ${basename(expectedRelease)} with prior owner exit`);
      remember(Number(identity.pid), `Electron ${basename(expectedRelease)}`, "manager");
      return identity;
    };

    const commitB = commitFixture("B");
    run([join(checkout, "scripts/update")], { env });
    const manifestB = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifestB.revision !== commitB || realpathSync(join(dataHome, "pr-cockpit-runtime/current")) !== realpathSync(manifestB.currentRelease)) throw new Error("A to B update did not activate B atomically");
    const healthB = JSON.parse(run([command("curl", env), "-fsS", `http://127.0.0.1:${PORT}/healthz`], { env }));
    const versionB = JSON.parse(run([command("curl", env), "-fsS", `http://127.0.0.1:${PORT}/api/version`], { env }));
    const cliB = run([join(home, ".local/bin/pr-cockpit"), `${FIXTURE_REPO}#${FIXTURE_PR}`, "--json"], { env });
    if (realpathSync(healthB.root) !== realpathSync(manifestB.currentRelease) || versionB.rev !== commitB || !cliB.includes("Linux smoke fixture B")) throw new Error("updated server/CLI payload does not prove B");
    const shellB = await waitForShellRelease(realpathSync(manifestB.currentRelease), shellIdentity);
    const windowB = await waitForWindow(env);
    await waitFor(() => {
      try { return verifySandboxedRenderers(Number(shellB.pid), uid).length > 0; } catch { return false; }
    }, 10000, "updated Electron B sandboxed renderer readiness");
    run([command("xdg-open", env), deepLink], { env });
    verifyWindowOwner(env, windowB, Number(shellB.pid));
    await observeRouteText(env, windowB, "Linux smoke fixture B");

    const commitC = commitFixture("C");
    const rollback = Bun.spawnSync([join(checkout, "scripts/update")], { env: { ...env, COCKPIT_LINUX_FAIL_AT: "health" }, stdout: "pipe", stderr: "pipe" });
    if (rollback.exitCode === 0) throw new Error("injected C activation unexpectedly succeeded");
    const rollbackManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (rollbackManifest.revision !== commitB || realpathSync(join(dataHome, "pr-cockpit-runtime/current")) !== realpathSync(manifestB.currentRelease)) throw new Error("failed C activation did not restore B");
    const healthAfterRollback = JSON.parse(run([command("curl", env), "-fsS", `http://127.0.0.1:${PORT}/healthz`], { env }));
    const versionAfterRollback = JSON.parse(run([command("curl", env), "-fsS", `http://127.0.0.1:${PORT}/api/version`], { env }));
    const cliAfterRollback = run([join(home, ".local/bin/pr-cockpit"), `${FIXTURE_REPO}#${FIXTURE_PR}`, "--json"], { env });
    if (realpathSync(healthAfterRollback.root) !== realpathSync(manifestB.currentRelease) || versionAfterRollback.rev !== commitB || !cliAfterRollback.includes("Linux smoke fixture B") || cliAfterRollback.includes("Linux smoke fixture C")) {
      throw new Error("rollback server/CLI payload does not prove restored B");
    }
    const shellAfterRollback = await waitForShellRelease(realpathSync(manifestB.currentRelease), shellB);
    const rollbackWindow = await waitForWindow(env);
    await waitFor(() => {
      try { return verifySandboxedRenderers(Number(shellAfterRollback.pid), uid).length > 0; } catch { return false; }
    }, 10000, "rolled-back Electron B sandboxed renderer readiness");
    run([command("xdg-open", env), deepLink], { env });
    verifyWindowOwner(env, rollbackWindow, Number(shellAfterRollback.pid));
    await observeRouteText(env, rollbackWindow, "Linux smoke fixture B");
    const uninstallArtifacts = rollbackManifest.artifacts.map((artifact: { path: string }) => artifact.path);
    const uninstallReleases = [rollbackManifest.currentRelease, rollbackManifest.priorRelease].filter(Boolean);
    const preservedValues = new Map<string, Buffer>([
      [join(persistentData, "proof-sentinel"), Buffer.from("preserve-across-lifecycle\n")],
      [join(configDir, "proof-sentinel"), Buffer.from("preserve-across-lifecycle\n")],
      [checkoutSentinel, Buffer.from("preserve-checkout\n")],
      [adjacentSentinel, Buffer.from("outside-owned-roots\n")],
      [foreignHandlerPath, foreignHandlerBytes],
    ]);
    const assertPreserved = () => {
      for (const [path, value] of preservedValues) {
        if (!existsSync(path) || !readFileSync(path).equals(value)) throw new Error(`uninstall/reinstall changed preserved bytes: ${path}`);
      }
    };
    const assertUninstalled = () => {
      for (const path of uninstallArtifacts) if (existsSync(path)) throw new Error(`uninstall left manifest artifact: ${path}`);
      for (const path of uninstallReleases) if (existsSync(path)) throw new Error(`uninstall left owned release: ${path}`);
      if (!existsSync(manifestPath) || existsSync(join(dataHome, "pr-cockpit-runtime/current"))) throw new Error("uninstall did not retain only its purge ownership manifest");
      const retainedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (realpathSync(retainedManifest.sourceRoot) !== realpathSync(checkout) || retainedManifest.revision !== rollbackManifest.revision) throw new Error("uninstall changed its retained purge ownership manifest");
      const mainPid = run([command("systemctl", env), "--user", "show", "pr-cockpit.service", "--property=MainPID", "--value"], { env, allowFailure: true });
      const cgroup = run([command("systemctl", env), "--user", "show", "pr-cockpit.service", "--property=ControlGroup", "--value"], { env, allowFailure: true });
      if (mainPid && mainPid !== "0") throw new Error("uninstall left service MainPID");
      if (cgroup && existsSync(join("/sys/fs/cgroup", cgroup, "cgroup.procs")) && readFileSync(join("/sys/fs/cgroup", cgroup, "cgroup.procs"), "utf8").trim()) throw new Error("uninstall left service cgroup processes");
      assertPreserved();
      const restoredProtocolOwner = readProtocolOwner();
      if (!Buffer.from(restoredProtocolOwner).equals(Buffer.from(priorProtocolOwner))) throw new Error("uninstall did not byte-restore the exact pre-bootstrap protocol owner");
    };

    run([join(checkout, "scripts/uninstall")], { env });
    assertUninstalled();
    const firstUninstallState = JSON.stringify([...preservedValues].map(([path]) => [path, sha256(path)]));
    run([join(checkout, "scripts/uninstall")], { env });
    assertUninstalled();
    if (JSON.stringify([...preservedValues].map(([path]) => [path, sha256(path)])) !== firstUninstallState) throw new Error("second uninstall was not idempotent");

    run([command("bash", env), "-s"], { env, stdin: bootstrap });
    const reinstalled = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (reinstalled.revision !== commitC || realpathSync(join(dataHome, "pr-cockpit-runtime/current")) !== realpathSync(reinstalled.currentRelease)) throw new Error("reinstall did not activate current fixture commit C");
    assertPreserved();
    const healthC = JSON.parse(run([command("curl", env), "-fsS", `http://127.0.0.1:${PORT}/healthz`], { env }));
    const versionC = JSON.parse(run([command("curl", env), "-fsS", `http://127.0.0.1:${PORT}/api/version`], { env }));
    const cliC = run([join(home, ".local/bin/pr-cockpit"), `${FIXTURE_REPO}#${FIXTURE_PR}`, "--json"], { env });
    if (realpathSync(healthC.root) !== realpathSync(reinstalled.currentRelease) || versionC.rev !== commitC || !cliC.includes("Linux smoke fixture C")) throw new Error("reinstalled server/CLI payload does not prove C");
    run([command("xdg-open", env), deepLink], { env });
    const shellC = await waitForShellRelease(realpathSync(reinstalled.currentRelease), shellAfterRollback);
    const windowC = await waitForWindow(env);
    await waitFor(() => {
      try { return verifySandboxedRenderers(Number(shellC.pid), uid).length > 0; } catch { return false; }
    }, 10000, "reinstalled Electron C sandboxed renderer readiness");
    verifyWindowOwner(env, windowC, Number(shellC.pid));
    await observeRouteText(env, windowC, "Linux smoke fixture C");
    if (Number(shellC.pid) <= 0) throw new Error("reinstalled GUI process record is invalid");

    const screenshots = ["main", "palette", "pr-files", "settings", "tray"].map((name) => {
      const path = join(args.output, `${name}.png`);
      return { name, file: `${name}.png`, sha256: sha256(path) };
    });
    if (typeof electronVersion !== "string" || !electronVersion) throw new Error("installed Electron version is missing");
    const openboxVersion = run([command("openbox", env), "--version"], { env }).split("\n")[0];
    cleanup(true);
    const manifest = {
      schemaVersion: 1,
      candidateCommit,
      target: { distribution: release.name, release: release.version, architecture: "x86_64", uid: "dedicated-non-root" },
      runtime: {
        electron: electronVersion,
        displayServer: "X11",
        windowManager: openboxVersion,
        sandbox: "enabled",
        sandboxProof: "every-renderer-no-new-privileges-1-seccomp-2-no-disabling-argv",
        singleton: true,
        shortcut: "Super+Control+G",
        paletteShortcut: "Super+Alt+K",
        wmClass: startupWmClass,
        integratedTitlebar: "zero-openbox-frame-extents",
        frameExtents,
        autostart: "gio-parsed-hidden-without-protocol-registration",
        protocol: { cold: true, warmDistinctRouteTransition: true, invalidPreservedExactRoute: true },
        tray: { host: "stalonetray", protocol: "XEmbed", ownerBound: true, showFromHidden: true, menuClosedWithEscape: true, screenshot: true },
      },
      fixture: {
        kind: "offline-mock",
        repo: FIXTURE_REPO,
        pullRequest: FIXTURE_PR,
        port: PORT,
        credentials: "absent",
        snapshotSha256: sha256(join(source, FIXTURE_RELATIVE, "snapshot.json")),
        candidateTransport: "shallow-local-bare-public-url-rewrite",
        networkGit: "denied",
      },
      lifecycle: {
        installRepetitions: 2,
        artifactSetStable: true,
        update: { from: candidateCommit, to: commitB, serverAndGuiPayload: "Linux smoke fixture B" },
        rollback: { rejected: commitC, restored: commitB, injectedGate: "health", serverAndGuiPayload: "Linux smoke fixture B" },
        uninstallRepetitions: 2,
        uninstallArtifactsExhaustive: true,
        ownedForeignProtocolOwnerByteRestoredAfterEachUninstall: true,
        reinstall: commitC,
        reinstalledServerAndGuiPayload: "Linux smoke fixture C",
        dataConfigCheckoutAdjacentAndForeignHandlerBytesPreserved: true,
      },
      capture: {
        width: WIDTH,
        height: HEIGHT,
        surfaces: { main: `#/pr/${FIXTURE_REPO}/${FIXTURE_PR}`, palette: "Super+Alt+K", files: `#/pr/${FIXTURE_REPO}/${FIXTURE_PR}/files`, settings: "#/settings", tray: "stalonetray context menu" },
        screenshots,
      },
      cleanup: { ownedProcessesStopped: true, serviceCgroupEmpty: true, trayHostAndIconGone: true, x11SocketRemoved: true, ownedRootsRemoved: true },
    };
    writeFileSync(join(args.output, "manifest.json"), serializePublicManifest(manifest, [home, source, scratch, candidateRemote, fixtureUser]), { mode: 0o644 });
    published = true;
  } finally {
    cleanup(published);
  }
}

function windowExists(env: Record<string, string>, windowId: string): boolean {
  return run([command("xwininfo", env), "-id", windowId], { env, allowFailure: true }).includes("Window id:");
}

function windowIsViewable(env: Record<string, string>, windowId: string): boolean {
  return run([command("xwininfo", env), "-id", windowId], { env, allowFailure: true }).includes("Map State: IsViewable");
}

function normalVisibleWindowsForPid(env: Record<string, string>, pid: number): string[] {
  return run([command("xdotool", env), "search", "--onlyvisible", "--pid", String(pid)], { env, allowFailure: true })
    .split("\n").filter((value) => /^\d+$/.test(value))
    .filter((windowId) => run([command("xprop", env), "-id", windowId, "_NET_WM_WINDOW_TYPE"], { env, allowFailure: true }).includes("_NET_WM_WINDOW_TYPE_NORMAL"));
}

function rootWindows(env: Record<string, string>): string[] {
  return [...run([command("xwininfo", env), "-root", "-tree"], { env }).matchAll(/^\s*(0x[0-9a-f]+)\s/gmi)]
    .map((match) => String(Number.parseInt(match[1], 16)));
}


async function waitForTrayHost(env: Record<string, string>, before: Set<string>): Promise<string> {
  let host = "";
  await waitFor(() => {
    host = rootWindows(env).find((windowId) => {
      if (before.has(windowId)) return false;
      const properties = run([command("xprop", env), "-id", windowId, "WM_CLASS", "_NET_SYSTEM_TRAY_ORIENTATION"], { env, allowFailure: true });
      return properties.toLowerCase().includes("stalonetray") && properties.includes("_NET_SYSTEM_TRAY_ORIENTATION");
    }) ?? "";
    return !!host;
  }, 5000, "stalonetray XEmbed host readiness");
  return host;
}

async function waitForTrayIcon(env: Record<string, string>, pid: number, host: string): Promise<string> {
  let icon = "";
  await waitFor(() => {
    icon = run([command("xdotool", env), "search", "--onlyvisible", "--pid", String(pid)], { env, allowFailure: true })
      .split("\n").find((value) => /^\d+$/.test(value)
        && !normalVisibleWindowsForPid(env, pid).includes(value)
        && value !== host) ?? "";
    if (!icon || !windowIsViewable(env, icon) || !windowIsViewable(env, host)) return false;
    const tree = run([command("xwininfo", env), "-id", host, "-tree"], { env, allowFailure: true }).toLowerCase();
    return tree.includes(`0x${Number(icon).toString(16)}`);
  }, 10000, "owned PR Cockpit XEmbed tray icon");
  verifyWindowOwner(env, icon, pid);
  return icon;
}

async function openOwnedTrayMenu(env: Record<string, string>, icon: string, pid: number, exclude: string[]): Promise<string> {
  const before = new Set(rootWindows(env).filter((windowId) => windowIsViewable(env, windowId)));
  run([command("xdotool", env), "mousemove", "--window", icon, "16", "16", "click", "3"], { env });
  let menu = "";
  await waitFor(() => {
    menu = rootWindows(env).find((windowId) => !before.has(windowId) && !exclude.includes(windowId) && windowIsViewable(env, windowId)) ?? "";
    return !!menu;
  }, 5000, "owned PR Cockpit tray context menu");
  verifyWindowOwner(env, menu, pid);
  return menu;
}

async function waitForWindow(env: Record<string, string>): Promise<string> {
  let windowId = "";
  await waitFor(() => {
    windowId = run([command("xdotool", env), "search", "--onlyvisible", "--name", "PR Cockpit"], { env, allowFailure: true })
      .split("\n").find((candidate) => /^\d+$/.test(candidate)
        && run([command("xprop", env), "-id", candidate, "_NET_WM_WINDOW_TYPE"], { env, allowFailure: true }).includes("_NET_WM_WINDOW_TYPE_NORMAL")) ?? "";
    return !!windowId;
  }, 10000, "PR Cockpit X11 window");
  return windowId;
}

async function waitForAdditionalWindow(env: Record<string, string>, pid: number, original: string): Promise<string> {
  let added = "";
  await waitFor(() => {
    added = normalVisibleWindowsForPid(env, pid).find((window) => window !== original) ?? "";
    return !!added;
  }, 5000, "palette X11 window");
  return added;
}

async function waitForVisibleWindow(env: Record<string, string>, windowId: string): Promise<void> {
  await waitFor(() => {
    const state = run([command("xprop", env), "-id", windowId, "_NET_WM_STATE"], { env, allowFailure: true });
    const windowInfo = run([command("xwininfo", env), "-id", windowId], { env, allowFailure: true });
    return !state.includes("_NET_WM_STATE_HIDDEN") && windowInfo.includes("Map State: IsViewable");
  }, 5000, "Linux shortcut reveal to become viewable");
}
async function waitForNotViewableWindow(env: Record<string, string>, windowId: string): Promise<void> {
  await waitFor(() => {
    const windowInfo = run([command("xwininfo", env), "-id", windowId], { env, allowFailure: true });
    return windowInfo.includes("Map State:") && !windowInfo.includes("Map State: IsViewable");
  }, 5000, "minimized X11 window to become non-viewable");
}

function verifyWindowOwner(env: Record<string, string>, windowId: string, pid: number): void {
  const wmPid = run([command("xprop", env), "-id", windowId, "_NET_WM_PID"], { env });
  const windowInfo = run([command("xwininfo", env), "-id", windowId], { env });
  if (!wmPid.endsWith(`= ${pid}`) || !windowInfo.includes("Map State: IsViewable")) {
    throw new Error(`window ${windowId} is not a viewable window owned by Electron ${pid}`);
  }
}

async function windowContent(env: Record<string, string>, windowId: string): Promise<string> {
  run([command("xclip", env), "-selection", "clipboard", "-i"], { env, stdin: new Uint8Array() });
  run([command("xdotool", env), "windowactivate", "--sync", windowId], { env });
  run([command("xdotool", env), "mousemove", "--window", windowId, "450", "105", "click", "1", "key", "--clearmodifiers", "ctrl+a", "key", "ctrl+c"], { env });
  await sleep(200);
  return clipboardText(env);
}

async function requireStableWindowContent(env: Record<string, string>, windowId: string, expected: string, absent: string): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const observed = await windowContent(env, windowId);
    if (observed !== expected || observed.includes(absent)) throw new Error("invalid protocol changed the exact prior renderer route or content");
    await sleep(50);
  }
}
function clipboardText(env: Record<string, string>): string {
  return run([command("xclip", env), "-selection", "clipboard", "-o"], { env, allowFailure: true });
}

async function observeRouteText(env: Record<string, string>, windowId: string, expected: string): Promise<string> {
  let observed = "";
  await waitFor(async () => {
    run([command("xclip", env), "-selection", "clipboard", "-i"], { env, stdin: new Uint8Array() });
    run([command("xdotool", env), "windowactivate", "--sync", windowId], { env, allowFailure: true });
    run([command("xdotool", env), "mousemove", "--window", windowId, "450", "105", "click", "1", "key", "--clearmodifiers", "ctrl+a", "key", "ctrl+c"], { env, allowFailure: true });
    await sleep(200);
    observed = clipboardText(env);
    return observed.includes(expected);
  }, 10000, `renderer route text ${JSON.stringify(expected)}`);
  return observed;
}

async function observeFocusedText(env: Record<string, string>, expected: string): Promise<void> {
  await waitFor(() => {
    run([command("xclip", env), "-selection", "clipboard", "-i"], { env, stdin: new Uint8Array() });
    run([command("xdotool", env), "key", "--clearmodifiers", "ctrl+a", "key", "ctrl+c"], { env, allowFailure: true });
    return clipboardText(env) === expected;
  }, 5000, `focused renderer value ${JSON.stringify(expected)}`);
}

function captureSurface(env: Record<string, string>, output: string, name: string, windowId: string, pid: number): void {
  verifyWindowOwner(env, windowId, pid);
  const path = join(output, `${name}.png`);
  run([command("scrot", env), "-o", path], { env });
  const dimensions = run([command("file", env), "-b", path], { env });
  if (!dimensions.includes(`${WIDTH} x ${HEIGHT}`)) throw new Error(`${name} capture is not ${WIDTH}x${HEIGHT}`);
}

async function clearRendererSelection(env: Record<string, string>, windowId: string): Promise<void> {
  run([command("xdotool", env), "mousemove", "--window", windowId, "100", "500", "click", "1"], { env });
  await sleep(100);
}

function readOsRelease(): { name: string; version: string } {
  const values = Object.fromEntries(readFileSync("/etc/os-release", "utf8").split("\n").filter((line) => line.includes("=")).map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1).replace(/^"|"$/g, "")];
  }));
  if (values.ID !== "ubuntu" || values.VERSION_ID !== "22.04") throw new Error("release proof requires Ubuntu 22.04");
  return { name: values.ID, version: values.VERSION_ID };
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`linux-smoke: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
