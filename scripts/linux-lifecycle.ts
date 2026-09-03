#!/usr/bin/env bun
import { chmodSync, constants, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { reportInstallFailure } from "./installFailure.ts";
async function exitLifecycleFailure(error: unknown): Promise<never> {
  const messages = errorMessages(error);
  for (const message of messages) console.error(`pr-cockpit: ${message}`);
  if (Bun.env.COCKPIT_INSTALL_REPORT_CHILD !== "1") {
    await reportInstallFailure({
      stage: process.argv[2] ?? "Initialize",
      status: 1,
      platform: process.platform,
    });
  }
  process.exit(1);
}
if (import.meta.main) process.once("uncaughtException", (error) => void exitLifecycleFailure(error));
if (process.getuid?.() === 0) throw new Error("Linux lifecycle must not run as root");
process.umask(0o077);

const uid = process.getuid?.();
function secureDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o022) !== 0) {
    throw new Error(`insecure owned directory component: ${path}`);
  }
}
const configuredHome = process.env.HOME;
if (!configuredHome || !isAbsolute(configuredHome) || resolve(configuredHome) === "/") throw new Error("HOME must name a non-root absolute user home");
const configuredHomePath = resolve(configuredHome);
if (!existsSync(configuredHomePath)) throw new Error("HOME must exist");
secureDirectory(configuredHomePath);
const home = realpathSync(configuredHomePath);

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  while (!existsSync(existing) && !lstatSafe(existing) && dirname(existing) !== existing) existing = dirname(existing);
  if (!existsSync(existing) && !lstatSafe(existing)) throw new Error(`path has no existing ancestor: ${path}`);
  const suffix = absolute.slice(existing.length).replace(/^\/+/, "");
  return suffix ? join(realpathSync(existing), suffix) : realpathSync(existing);
}

function ownedPath(path: string): string {
  const absolute = resolve(path);
  const canonical = absolute === configuredHomePath
    ? home
    : absolute.startsWith(`${configuredHomePath}/`)
      ? join(home, relative(configuredHomePath, absolute))
      : absolute;
  if (!canonical.startsWith(`${home}/`)) throw new Error(`lifecycle root must be beneath HOME: ${canonical}`);
  let current = home;
  for (const component of relative(home, canonical).split("/").filter(Boolean)) {
    current = join(current, component);
    if (!existsSync(current) && !lstatSafe(current)) break;
    secureDirectory(current);
  }
  return canonical;
}
function ensureOwnedDirectory(path: string): void {
  const canonical = ownedPath(path);
  let current = home;
  for (const component of relative(home, canonical).split("/").filter(Boolean)) {
    current = join(current, component);
    if (!existsSync(current) && !lstatSafe(current)) {
      try { mkdirSync(current, { mode: 0o700 }); } catch {}
    }
    secureDirectory(current);
  }
  chmodSync(canonical, 0o700);
}

const dataHome = ownedPath(process.env.XDG_DATA_HOME || join(home, ".local/share"));
const configHome = ownedPath(process.env.XDG_CONFIG_HOME || join(home, ".config"));
const stateHome = ownedPath(process.env.XDG_STATE_HOME || join(home, ".local/state"));
const configuredRuntime = process.env.XDG_RUNTIME_DIR;
if (!configuredRuntime || !isAbsolute(configuredRuntime) || !existsSync(configuredRuntime)) throw new Error("XDG_RUNTIME_DIR must name an existing absolute directory");
secureDirectory(configuredRuntime);
const sessionRuntime = realpathSync(configuredRuntime);
const runtimeLauncher = join(sessionRuntime, "pr-cockpit/launch");
const runtimeRoot = ownedPath(join(dataHome, "pr-cockpit-runtime"));
const releasesDir = ownedPath(join(runtimeRoot, "releases"));
const currentLink = join(runtimeRoot, "current");
const stateDir = ownedPath(join(stateHome, "pr-cockpit"));
const toolsRoot = ownedPath(join(dataHome, "pr-cockpit-tools"));
const manifestPath = join(stateDir, "install-manifest.json");
const configDir = ownedPath(join(configHome, "pr-cockpit"));
const envFile = join(configDir, "server.env");
const persistentData = ownedPath(join(dataHome, "pr-cockpit"));
const ownedRoots = [runtimeRoot, persistentData, configDir, stateDir, toolsRoot];
for (let left = 0; left < ownedRoots.length; left++) {
  for (let right = left + 1; right < ownedRoots.length; right++) {
    if (ownedRoots[left] === ownedRoots[right] || ownedRoots[left].startsWith(`${ownedRoots[right]}/`) || ownedRoots[right].startsWith(`${ownedRoots[left]}/`)) {
      throw new Error(`lifecycle roots must be disjoint: ${ownedRoots[left]} and ${ownedRoots[right]}`);
    }
  }
}

type LockOwner = { token: string; pid: number; start: string | null };
const lifecycleLock = join(stateHome, ".pr-cockpit-lifecycle.lock");
function lockOwner(path: string): { raw: string; value: LockOwner } | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) return null;
    const raw = readlinkSync(path);
    const match = raw.match(/^([1-9][0-9]*):([0-9]+|-):([0-9a-f]{32})$/);
    if (!match) return null;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid)) return null;
    return { raw, value: { pid, start: match[2] === "-" ? null : match[2], token: match[3] } };
  } catch {
    return null;
  }
}
function processIdentityIsLive(owner: LockOwner): boolean {
  try { process.kill(owner.pid, 0); } catch { return false; }
  const start = linuxProcessStart(owner.pid);
  return start === null ? owner.start === null : owner.start === start;
}
function withLifecycleLock<T>(operation: () => T): T {
  ensureOwnedDirectory(stateHome);
  const token = randomBytes(16).toString("hex");
  const owner: LockOwner = { token, pid: process.pid, start: linuxProcessStart(process.pid) };
  const ownerRaw = `${owner.pid}:${owner.start ?? "-"}:${owner.token}`;
  let acquired = false;
  for (let attempt = 0; attempt < 20 && !acquired; attempt++) {
    try {
      symlinkSync(ownerRaw, lifecycleLock);
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const observed = lockOwner(lifecycleLock);
      if (!observed || processIdentityIsLive(observed.value)) {
        Bun.sleepSync(25);
        continue;
      }
      if (lockOwner(lifecycleLock)?.raw !== observed.raw) continue;
      const stale = `${lifecycleLock}.stale-${token}`;
      try {
        renameSync(lifecycleLock, stale);
        if (lockOwner(stale)?.raw !== observed.raw) throw new Error("lifecycle lock changed during stale reclaim");
        rmSync(stale);
      } catch (reclaimError) {
        if (lstatSafe(stale) && !lstatSafe(lifecycleLock)) renameSync(stale, lifecycleLock);
        if ((reclaimError as NodeJS.ErrnoException).code !== "ENOENT") throw reclaimError;
      }
    }
  }
  if (!acquired) throw new Error("another Linux lifecycle operation is active");
  try {
    return operation();
  } finally {
    const released = `${lifecycleLock}.unlock-${token}`;
    try {
      renameSync(lifecycleLock, released);
    } catch {
      throw new Error("lifecycle lock ownership changed");
    }
    if (lockOwner(released)?.raw !== ownerRaw) {
      if (!lstatSafe(lifecycleLock)) renameSync(released, lifecycleLock);
      throw new Error("lifecycle lock ownership changed");
    }
    rmSync(released);
  }
}
function integrationPath(path: string): string {
  const parent = ownedPath(dirname(path));
  return join(parent, basename(path));
}
const desktopFile = integrationPath(join(dataHome, "applications/app.pr-cockpit.desktop"));
const autostartFile = integrationPath(join(configHome, "autostart/app.pr-cockpit.desktop"));
const iconFile = integrationPath(join(dataHome, "icons/hicolor/512x512/apps/app.pr-cockpit.png"));
const unitFile = integrationPath(join(configHome, "systemd/user/pr-cockpit.service"));
const wantsLink = integrationPath(join(configHome, "systemd/user/default.target.wants/pr-cockpit.service"));
const cliFile = integrationPath(join(home, ".local/bin/pr-cockpit"));
const mimeType = "x-scheme-handler/prcockpit";
const shellProcessFile = join(persistentData, "shell-process");
const desktopId = "app.pr-cockpit.desktop";

type Artifact = { path: string; kind: "file" | "symlink"; sha256?: string; target?: string };
type ReleaseEntry = { path: string; kind: "directory" | "file" | "symlink"; mode: number; sha256?: string; target?: string };
type Manifest = {
  version: 1;
  sourceRoot: string;
  revision: string;
  currentRelease: string;
  priorRelease: string | null;
  priorMimeHandler: string | null;
  artifacts: Artifact[];
  releaseFiles: ReleaseEntry[];
  priorReleaseFiles: ReleaseEntry[] | null;
};

function run(argv: string[], options: { cwd?: string; stdout?: "pipe" | "inherit"; stderr?: "pipe" | "inherit" } = {}): string {
  const proc = Bun.spawnSync(argv, { cwd: options.cwd, stdout: options.stdout ?? "pipe", stderr: options.stderr ?? "pipe", env: process.env });
  if (proc.exitCode !== 0) {
    const detail = proc.stderr.toString().trim() || proc.stdout.toString().trim();
    throw new Error(`${argv[0]} failed${detail ? `: ${detail}` : ""}`);
  }
  return proc.stdout.toString().trim();
}
function command(name: string): string {
  const value = Bun.which(name);
  if (!value) throw new Error(`${name} not found`);
  return realpathSync(value);
}
function failAt(gate: string): void {
  if (process.env.COCKPIT_LINUX_FAIL_AT === gate) throw new Error(`injected failure at ${gate}`);
}
function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function exactKeys(value: unknown, expected: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) throw new Error(`${label} has unknown or missing fields`);
}
function validateReleaseEntries(value: unknown, label: string): asserts value is ReleaseEntry[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const paths = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || !("kind" in entry)) throw new Error(`${label} entry must be an object with a kind`);
    const kind = entry.kind;
    const keys = kind === "file" ? ["path", "kind", "mode", "sha256"] : kind === "symlink" ? ["path", "kind", "mode", "target"] : kind === "directory" ? ["path", "kind", "mode"] : [];
    if (!keys.length) throw new Error(`${label} entry kind is invalid`);
    exactKeys(entry, keys, `${label} entry`);
    const item = entry as unknown as ReleaseEntry;
    if (typeof item.path !== "string" || !item.path || isAbsolute(item.path) || item.path.split("/").includes("..") || paths.has(item.path)) throw new Error(`${label} entry path is invalid or duplicated`);
    if (!Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0o777) throw new Error(`${label} entry mode is invalid`);
    if (item.kind === "file" && !/^[0-9a-f]{64}$/.test(item.sha256)) throw new Error(`${label} file hash is invalid`);
    if (item.kind === "symlink" && typeof item.target !== "string") throw new Error(`${label} symlink target is invalid`);
    paths.add(item.path);
  }
}

function readManifest(): Manifest | null {
  if (!lstatSafe(stateDir)) return null;
  ensureOwnedDirectory(stateDir);
  if (!lstatSafe(manifestPath)) return null;
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || (uid !== undefined && manifestStat.uid !== uid) || (manifestStat.mode & 0o777) !== 0o600) {
    throw new Error(`install manifest has insecure ownership or mode at ${manifestPath}`);
  }
  const value: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  exactKeys(value, ["version", "sourceRoot", "revision", "currentRelease", "priorRelease", "priorMimeHandler", "artifacts", "releaseFiles", "priorReleaseFiles"], "install manifest");
  if (value.version !== 1 || typeof value.sourceRoot !== "string" || !isAbsolute(value.sourceRoot) || typeof value.revision !== "string" || !/^[0-9a-f]{40,64}$/.test(value.revision) || typeof value.currentRelease !== "string" || !isAbsolute(value.currentRelease) || (value.priorRelease !== null && (typeof value.priorRelease !== "string" || !isAbsolute(value.priorRelease))) || (value.priorMimeHandler !== null && typeof value.priorMimeHandler !== "string")) {
    throw new Error(`install manifest scalar field is invalid at ${manifestPath}`);
  }
  validateReleaseEntries(value.releaseFiles, "current release manifest");
  if (value.priorReleaseFiles !== null) validateReleaseEntries(value.priorReleaseFiles, "prior release manifest");
  if (!Array.isArray(value.artifacts)) throw new Error(`install manifest artifacts must be an array at ${manifestPath}`);
  const expected = new Map<string, Artifact["kind"]>([
    [currentLink, "symlink"], [desktopFile, "file"], [autostartFile, "file"], [iconFile, "file"], [unitFile, "file"], [wantsLink, "symlink"], [cliFile, "symlink"],
  ]);
  if (value.artifacts.length !== expected.size) throw new Error(`manifest artifact allowlist mismatch at ${manifestPath}`);
  const seen = new Set<string>();
  for (const artifact of value.artifacts as unknown[]) {
    if (!artifact || typeof artifact !== "object" || !("kind" in artifact)) throw new Error(`manifest artifact must be an object with a kind at ${manifestPath}`);
    const kind = artifact.kind;
    exactKeys(artifact, kind === "file" ? ["path", "kind", "sha256"] : kind === "symlink" ? ["path", "kind", "target"] : [], "manifest artifact");
    const item = artifact as Artifact;
    if (seen.has(item.path) || expected.get(item.path) !== item.kind) throw new Error(`manifest contains duplicate, foreign, or wrongly typed artifact: ${item.path}`);
    if (item.kind === "file" ? !/^[0-9a-f]{64}$/.test(item.sha256 || "") : typeof item.target !== "string") throw new Error(`manifest artifact ownership value is invalid: ${item.path}`);
    seen.add(item.path);
  }
  const manifest = value as Manifest;
  const currentRelease = canonicalPath(manifest.currentRelease);
  if (dirname(currentRelease) !== releasesDir || basename(currentRelease) !== manifest.revision) {
    throw new Error(`install manifest current release is outside the owned release root at ${manifestPath}`);
  }
  if ((manifest.priorRelease === null) !== (manifest.priorReleaseFiles === null)) {
    throw new Error(`install manifest prior release fields disagree at ${manifestPath}`);
  }
  if (manifest.priorRelease) {
    const priorRelease = canonicalPath(manifest.priorRelease);
    if (dirname(priorRelease) !== releasesDir || priorRelease === currentRelease || !/^[0-9a-f]{40,64}$/.test(basename(priorRelease))) {
      throw new Error(`install manifest prior release is outside the owned release root at ${manifestPath}`);
    }
  }
  const artifacts = manifest.artifacts;
  const currentArtifact = artifacts.find((item) => item.path === currentLink);
  const cliArtifact = artifacts.find((item) => item.path === cliFile);
  const wantsArtifact = artifacts.find((item) => item.path === wantsLink);
  if (currentArtifact?.kind !== "symlink" || canonicalPath(resolve(dirname(currentLink), currentArtifact.target!)) !== currentRelease) {
    throw new Error(`install manifest current link target is invalid at ${manifestPath}`);
  }
  if (cliArtifact?.kind !== "symlink" || cliArtifact.target !== `${currentLink}/scripts/pr-cockpit`) {
    throw new Error(`install manifest CLI target is invalid at ${manifestPath}`);
  }
  if (wantsArtifact?.kind !== "symlink" || canonicalPath(resolve(dirname(wantsLink), wantsArtifact.target!)) !== canonicalPath(unitFile)) {
    throw new Error(`install manifest systemd target is invalid at ${manifestPath}`);
  }
  return manifest;
}

function installGeneration(): string {
  const manifest = readManifest();
  const manifestBytes = manifest ? readFileSync(manifestPath) : Buffer.from("absent");
  let currentTarget = "absent";
  if (lstatSafe(currentLink)) {
    const stat = lstatSync(currentLink);
    if (!stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) throw new Error(`active runtime link is insecure: ${currentLink}`);
    let resolvedCurrent: string;
    try {
      resolvedCurrent = realpathSync(currentLink);
    } catch {
      throw new Error(`active runtime link is insecure: ${currentLink}`);
    }
    if (dirname(resolvedCurrent) !== releasesDir) throw new Error(`active runtime link is insecure: ${currentLink}`);
    currentTarget = readlinkSync(currentLink);
  }
  return createHash("sha256")
    .update(manifestBytes)
    .update("\0")
    .update(currentTarget)
    .update("\0")
    .update(manifest?.revision ?? "absent")
    .digest("hex");
}
function observed(path: string): Artifact | null {
  if (!existsSync(path) && !lstatSafe(path)) return null;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return { path, kind: "symlink", target: readlinkSync(path) };
  if (stat.isFile()) return { path, kind: "file", sha256: sha(path) };
  throw new Error(`artifact path has unsupported type: ${path}`);
}
function lstatSafe(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}
function same(a: Artifact | null, b: Artifact): boolean {
  return !!a && a.kind === b.kind && (b.kind === "file" ? a.sha256 === b.sha256 : a.target === b.target);
}
function unchanged(before: Artifact | null, path: string): boolean {
  const after = observed(path);
  return before === null ? after === null : same(after, before);
}
function assertOwnedOrAbsent(path: string, old: Manifest | null): void {
  const actual = observed(path);
  if (!actual) return;
  const recorded = old?.artifacts.find((item) => item.path === path);
  if (!recorded || !same(actual, recorded)) throw new Error(`refusing to replace foreign or changed artifact: ${path}`);
}
function tempDirectory(path: string): string {
  const parent = dirname(path);
  ensureOwnedDirectory(parent);
  const temp = mkdtempSync(join(parent, ".pr-cockpit-publish-"));
  chmodSync(temp, 0o700);
  return temp;
}
function publishFile(temp: string, path: string, before: Artifact | null): void {
  if (!unchanged(before, path)) throw new Error(`artifact changed during publication: ${path}`);
  if (before) renameSync(temp, path);
  else {
    linkSync(temp, path);
    rmSync(temp);
  }
}
function atomicFile(path: string, content: string, mode = 0o644): Artifact {
  const before = observed(path);
  const tempDir = tempDirectory(path);
  const temp = join(tempDir, "file");
  try {
    writeFileSync(temp, content, { mode, flag: "wx" });
    chmodSync(temp, mode);
    publishFile(temp, path, before);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  return { path, kind: "file", sha256: sha(path) };
}
function atomicCopy(source: string, path: string): Artifact {
  const before = observed(path);
  const tempDir = tempDirectory(path);
  const temp = join(tempDir, "file");
  try {
    copyFileSync(source, temp, constants.COPYFILE_EXCL);
    chmodSync(temp, 0o644);
    publishFile(temp, path, before);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  return { path, kind: "file", sha256: sha(path) };
}
function atomicSymlink(target: string, path: string): Artifact {
  const before = observed(path);
  ensureOwnedDirectory(dirname(path));
  if (!unchanged(before, path)) throw new Error(`artifact changed during publication: ${path}`);
  if (!before) symlinkSync(target, path);
  else {
    const tempDir = tempDirectory(path);
    const temp = join(tempDir, "link");
    try {
      symlinkSync(target, temp);
      if (!unchanged(before, path)) throw new Error(`artifact changed during publication: ${path}`);
      renameSync(temp, path);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
  return { path, kind: "symlink", target };
}
function quoteEnv(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
function port(): string {
  if (!existsSync(envFile)) return "4820";
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const match = line.match(/^COCKPIT_PORT=["']?([0-9]+)["']?$/);
    if (match) return match[1];
  }
  return "4820";
}
function graphical(): boolean {
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) && !!process.env.DBUS_SESSION_BUS_ADDRESS;
}
function currentRelease(): string | null {
  if (!lstatSafe(currentLink) || !lstatSync(currentLink).isSymbolicLink()) return null;
  const target = resolve(dirname(currentLink), readlinkSync(currentLink));
  return existsSync(target) ? realpathSync(target) : null;
}
function health(expectedRoot: string, expectedRevision: string): boolean {
  const url = `http://127.0.0.1:${port()}`;
  try {
    const rootBody = run([command("curl"), "--noproxy", "*", "--max-time", "2", "-fsS", `${url}/healthz`]);
    const versionBody = run([command("curl"), "--noproxy", "*", "--max-time", "2", "-fsS", `${url}/api/version`]);
    return JSON.parse(rootBody).root === expectedRoot && JSON.parse(versionBody).rev === expectedRevision;
  } catch { return false; }
}
function waitHealth(root: string, revision: string): void {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (health(root, revision)) return;
    Bun.sleepSync(200);
  }
  throw new Error(`service did not prove release root and revision ${revision}`);
}
function releaseTree(root: string): ReleaseEntry[] {
  const entries: ReleaseEntry[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (directory === root && name === ".pr-cockpit-release.json") continue;
      const absolute = join(directory, name);
      const path = relative(root, absolute);
      const stat = lstatSync(absolute);
      if (uid !== undefined && stat.uid !== uid) throw new Error(`release entry has foreign owner: ${absolute}`);
      const mode = stat.mode & 0o777;
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        const resolvedTarget = resolve(dirname(absolute), target);
        if (isAbsolute(target) || (resolvedTarget !== root && !resolvedTarget.startsWith(`${root}/`))) throw new Error(`release symlink escapes immutable root: ${absolute}`);
        entries.push({ path, kind: "symlink", mode, target });
      } else if (stat.isDirectory()) {
        entries.push({ path, kind: "directory", mode });
        visit(absolute);
      } else if (stat.isFile()) entries.push({ path, kind: "file", mode, sha256: sha(absolute) });
      else throw new Error(`unsupported release entry: ${absolute}`);
    }
  };
  visit(root);
  return entries;
}
function sealRelease(root: string): void {
  const entries = releaseTree(root).sort((left, right) => right.path.length - left.path.length);
  for (const entry of entries) {
    if (entry.kind !== "symlink") chmodSync(join(root, entry.path), entry.mode & ~0o222);
  }
}
function releaseMetadata(root: string): { version: 1; revision: string; files: ReleaseEntry[] } {
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (uid !== undefined && rootStat.uid !== uid) || (rootStat.mode & 0o777) !== 0o555) {
    throw new Error(`release root ownership or mode is invalid: ${root}`);
  }
  const marker = join(root, ".pr-cockpit-release.json");
  if (!existsSync(marker) || lstatSync(marker).isSymbolicLink()) throw new Error(`release ownership marker is missing: ${root}`);
  const markerStat = lstatSync(marker);
  if (!markerStat.isFile() || (uid !== undefined && markerStat.uid !== uid) || (markerStat.mode & 0o777) !== 0o444) throw new Error(`release ownership marker is insecure: ${root}`);
  const metadata: unknown = JSON.parse(readFileSync(marker, "utf8"));
  exactKeys(metadata, ["version", "revision", "files"], "release ownership marker");
  if (metadata.version !== 1 || typeof metadata.revision !== "string" || !/^[0-9a-f]{40,64}$/.test(metadata.revision) || metadata.revision !== basename(root)) {
    throw new Error(`release ownership marker is invalid: ${root}`);
  }
  validateReleaseEntries(metadata.files, "release ownership marker files");
  const actual = releaseTree(root);
  if (actual.some((entry) => entry.kind !== "symlink" && (entry.mode & 0o222) !== 0)) throw new Error(`release tree is writable: ${root}`);
  if (JSON.stringify(actual) !== JSON.stringify(metadata.files)) throw new Error(`release tree differs from ownership manifest: ${root}`);
  return metadata;
}
function makeReleaseWritable(root: string): void {
  for (const entry of releaseTree(root)) {
    if (entry.kind === "directory") chmodSync(join(root, entry.path), entry.mode | 0o700);
  }
  chmodSync(root, 0o700);
}
function stage(source: string, expectedGeneration: string): { release: string; revision: string } {
  if (!/^[0-9a-f]{64}$/.test(expectedGeneration)) throw new Error("expected install generation is invalid");
  if (installGeneration() !== expectedGeneration) throw new Error("Linux installation changed before release staging");
  ensureOwnedDirectory(dataHome);
  ensureOwnedDirectory(stateHome);
  const sourceRoot = realpathSync(source);
  const git = command("git");
  const revision = run([git, "-C", sourceRoot, "rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40,64}$/.test(revision)) throw new Error("source HEAD is not a full Git object id");
  ensureOwnedDirectory(releasesDir);
  const release = join(releasesDir, revision);
  if (existsSync(release) || lstatSafe(release)) {
    const metadata = releaseMetadata(release);
    if (metadata.revision !== revision) throw new Error(`release revision marker does not match: ${release}`);
    return { release, revision };
  }
  const transaction = mkdtempSync(join(releasesDir, ".stage-"));
  chmodSync(transaction, 0o700);
  const staged = join(transaction, "candidate");
  const archive = join(transaction, "source.tar");
  mkdirSync(staged, { mode: 0o700 });
  let published = false;
  try {
    failAt("copy");
    run([git, "-C", sourceRoot, "archive", "--format=tar", `--output=${archive}`, revision]);
    const archiveStat = lstatSync(archive);
    if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || (uid !== undefined && archiveStat.uid !== uid) || (archiveStat.mode & 0o077) !== 0) throw new Error("Git archive temporary is insecure");
    run([command("tar"), "-xf", archive, "-C", staged]);
    rmSync(archive, { force: true });
    const bun = command("bun");
    failAt("root-deps"); run([bun, "install", "--frozen-lockfile"], { cwd: staged });
    failAt("ui-deps"); run([bun, "install", "--frozen-lockfile"], { cwd: join(staged, "ui") });
    failAt("shell-deps"); run([bun, "install", "--frozen-lockfile"], { cwd: join(staged, "shell") });
    failAt("electron-install"); run([bun, "node_modules/electron/install.js"], { cwd: join(staged, "shell") });
    failAt("release-check"); run([bun, "scripts/check-release.ts"], { cwd: staged });
    failAt("runtime-check"); run([bun, "scripts/check-worktree-runtime.ts"], { cwd: staged });
    failAt("ui-build"); run([bun, "run", "build"], { cwd: join(staged, "ui") });
    failAt("validate");
    for (const path of ["server/main.ts", "scripts/cockpit", "scripts/pr-cockpit", "scripts/linux-lifecycle.ts", "shell/main.js", "shell/node_modules/electron/dist/electron", "static/index.html"]) {
      if (!existsSync(join(staged, path))) throw new Error(`staged release is missing ${path}`);
    }
    chmodSync(join(staged, "scripts/cockpit"), 0o755);
    chmodSync(join(staged, "scripts/pr-cockpit"), 0o755);
    chmodSync(join(staged, "scripts/linux-lifecycle.ts"), 0o755);
    const files = releaseTree(staged).map((entry) => entry.kind === "symlink" ? entry : { ...entry, mode: entry.mode & ~0o222 });
    atomicFile(join(staged, ".pr-cockpit-release.json"), `${JSON.stringify({ version: 1, revision, files }, null, 2)}\n`, 0o444);
    run([command("mv"), "-Tn", staged, release]);
    published = !existsSync(staged);
    if (!published) {
      const concurrent = releaseMetadata(release);
      if (concurrent.revision !== revision) throw new Error(`concurrent release publication differs: ${release}`);
      rmSync(staged, { recursive: true, force: true });
    } else {
      sealRelease(release);
      chmodSync(release, 0o555);
    }
    releaseMetadata(release);
    return { release, revision };
  } catch (error) {
    if (published && existsSync(release)) {
      try {
        makeReleaseWritable(release);
        rmSync(release, { recursive: true, force: true });
      } catch {}
    } else if (existsSync(staged)) {
      rmSync(staged, { recursive: true, force: true });
    }
    throw error;
  } finally {
    rmSync(transaction, { recursive: true, force: true });
  }
}
function assertOwnedRelease(path: string): string {
  const release = canonicalPath(path);
  if (!release.startsWith(`${releasesDir}/`) || dirname(release) !== releasesDir) {
    throw new Error(`refusing to remove release outside runtime root: ${path}`);
  }
  const metadata = releaseMetadata(release);
  if (metadata.revision !== release.split("/").at(-1)) throw new Error(`release revision marker does not match: ${path}`);
  return release;
}
function removeOwnedRelease(path: string, expected?: ReleaseEntry[] | null): void {
  const release = assertOwnedRelease(path);
  if (expected && JSON.stringify(releaseMetadata(release).files) !== JSON.stringify(expected)) {
    throw new Error(`release does not match external ownership manifest: ${path}`);
  }
  makeReleaseWritable(release);
  rmSync(release, { recursive: true });
}
function desktopExec(exec: string): string {
  if (!/^\/[A-Za-z0-9_./+@-]+$/.test(exec)) throw new Error(`desktop launcher path is not compatible with xdg-open: ${exec}`);
  return exec;
}
function quotedDesktopExec(exec: string): string {
  return `\"${exec.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}\"`;
}
function desktop(exec: string): string {
  return `[Desktop Entry]\nType=Application\nName=PR Cockpit\nComment=Pull request cockpit\nExec=${desktopExec(exec)} %u\nIcon=app.pr-cockpit\nTerminal=false\nCategories=Development;\nStartupWMClass=app.pr-cockpit\nMimeType=${mimeType};\n`;
}
function autostart(exec: string): string {
  return `[Desktop Entry]\nType=Application\nName=PR Cockpit\nComment=Start PR Cockpit in the background\nExec=${quotedDesktopExec(exec)} --hidden\nIcon=app.pr-cockpit\nTerminal=false\nNoDisplay=true\nStartupWMClass=app.pr-cockpit\nX-GNOME-Autostart-enabled=true\nX-KDE-autostart-after=panel\n`;
}
function unitQuote(value: string): string {
  return `\"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}\"`;
}
function unitAbsolutePath(value: string): string {
  if (!isAbsolute(value)) throw new Error(`systemd scalar path must be absolute: ${value}`);
  let encoded = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const character = String.fromCharCode(byte);
    encoded += /[A-Za-z0-9/_.-]/.test(character) ? character : `\\x${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}
function stopUnmanagedServer(): void {
  const curl = command("curl");
  const url = `http://127.0.0.1:${port()}`;
  const health = Bun.spawnSync([curl, "--noproxy", "*", "--max-time", "2", "-fsS", `${url}/healthz`], { stdout: "pipe", stderr: "ignore" });
  if (health.exitCode !== 0) return;
  let status: { root?: unknown; supervisor?: unknown };
  try {
    status = JSON.parse(health.stdout.toString());
  } catch {
    return;
  }
  if (typeof status.root !== "string" || status.supervisor === "systemd-system" || status.supervisor === "systemd-user") return;
  const stopped = Bun.spawnSync([curl, "--noproxy", "*", "--max-time", "2", "-fsS", "-X", "POST", `${url}/api/shutdown`], { stdout: "ignore", stderr: "pipe" });
  if (stopped.exitCode !== 0) {
    throw new Error(stopped.stderr.toString().trim() || `unmanaged server on port ${port()} could not be stopped`);
  }
  Bun.sleepSync(200);
}

function service(bun: string, gh: string, linker: string, source: string, revision: string): string {
  const path = [dirname(bun), dirname(gh), "/usr/local/bin", "/usr/bin", "/bin"].join(":");
  const launcher = `${currentLink}/scripts/cockpit`;
  return `[Unit]\nDescription=PR Cockpit\nWants=network-online.target\nAfter=network-online.target\n\n[Service]\nType=simple\nRuntimeDirectory=pr-cockpit\nRuntimeDirectoryMode=0700\nWorkingDirectory=${unitAbsolutePath(currentLink)}\nEnvironmentFile=${unitAbsolutePath(envFile)}\nEnvironment=${unitQuote("COCKPIT_SUPERVISOR=systemd-user")}\nEnvironment=${unitQuote(`COCKPIT_ROOT=${currentLink}`)}\nEnvironment=${unitQuote(`COCKPIT_SOURCE_ROOT=${source}`)}\nEnvironment=${unitQuote(`COCKPIT_RELEASE_REVISION=${revision}`)}\nEnvironment=${unitQuote(`COCKPIT_GH_BIN=${gh}`)}\nEnvironment=${unitQuote(`PATH=${path}`)}\nEnvironment=${unitQuote(`XDG_DATA_HOME=${dataHome}`)}\nEnvironment=${unitQuote(`XDG_CONFIG_HOME=${configHome}`)}\nEnvironment=${unitQuote(`XDG_STATE_HOME=${stateHome}`)}\nExecStartPre=${unitQuote(linker)} -sfnT ${unitQuote(launcher)} ${unitQuote(runtimeLauncher)}\nExecStart=${unitQuote(bun)} ${unitQuote(`${currentLink}/server/main.ts`)}\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`;
}
function installConfig(): void {
  if (existsSync(envFile)) {
    const line = readFileSync(envFile, "utf8").split("\n").find((entry) => entry.startsWith("COCKPIT_DATA_DIR="));
    if (!line) throw new Error(`existing ${envFile} does not declare COCKPIT_DATA_DIR`);
    const encoded = line.slice("COCKPIT_DATA_DIR=".length);
    let configuredData: string;
    try {
      configuredData = encoded.startsWith("\"") ? JSON.parse(encoded) : encoded.startsWith("'") && encoded.endsWith("'") ? encoded.slice(1, -1) : encoded.replace(/\\(.)/g, "$1");
    } catch {
      throw new Error(`existing ${envFile} has an invalid COCKPIT_DATA_DIR`);
    }
    if (!isAbsolute(configuredData) || canonicalPath(configuredData) !== persistentData) {
      throw new Error(`existing COCKPIT_DATA_DIR must equal ${persistentData}`);
    }
    return;
  }
  ensureOwnedDirectory(configDir);
  ensureOwnedDirectory(persistentData);
  const configuredPort = process.env.COCKPIT_PORT || "4820";
  if (!/^[0-9]+$/.test(configuredPort)) throw new Error("COCKPIT_PORT must be numeric");
  const lines = [`COCKPIT_DATA_DIR=${quoteEnv(persistentData)}`, `COCKPIT_PORT=${configuredPort}`];
  if (process.env.COCKPIT_REPOS) lines.push(`COCKPIT_REPOS=${quoteEnv(process.env.COCKPIT_REPOS)}`);
  if (process.env.COCKPIT_ALLOWED_ORIGINS) lines.push(`COCKPIT_ALLOWED_ORIGINS=${quoteEnv(process.env.COCKPIT_ALLOWED_ORIGINS)}`);
  if (process.env.COCKPIT_TAILSCALE_SERVE === "1") lines.push("COCKPIT_TAILSCALE_SERVE=1");
  if (process.env.COCKPIT_TAILSCALE_HTTPS_PORT) lines.push(`COCKPIT_TAILSCALE_HTTPS_PORT=${quoteEnv(process.env.COCKPIT_TAILSCALE_HTTPS_PORT)}`);
  atomicFile(envFile, `${lines.join("\n")}\n`, 0o600);
}
function queryMime(): string | null {
  const value = run([command("xdg-mime"), "query", "default", mimeType]).trim();
  return value || null;
}
function activate(release: string, source: string, launchGui: boolean, actor: string): void {
  ensureOwnedDirectory(dataHome);
  ensureOwnedDirectory(configHome);
  ensureOwnedDirectory(stateHome);
  const releaseRoot = realpathSync(release);
  const actorRoot = realpathSync(actor);
  if (actorRoot !== releaseRoot) throw new Error(`activation must run from the verified immutable release: ${releaseRoot}`);
  const metadata = releaseMetadata(releaseRoot);
  const revision = metadata.revision;
  const oldManifest = readManifest();
  const oldRelease = currentRelease();
  const guiPlan = launchGui && oldManifest ? planGuiStop(oldManifest) : null;
  const mimeBefore = queryMime();
  const priorMime = oldManifest ? oldManifest.priorMimeHandler : mimeBefore;
  const artifactPaths = [desktopFile, autostartFile, iconFile, unitFile, wantsLink, cliFile];
  for (const path of artifactPaths) assertOwnedOrAbsent(path, oldManifest);
  if (oldRelease && (!oldManifest || canonicalPath(oldManifest.currentRelease) !== oldRelease)) {
    throw new Error(`refusing to replace unowned active runtime: ${currentLink}`);
  }
  const activeArtifact = observed(currentLink);
  if (activeArtifact) {
    const recordedCurrent = oldManifest?.artifacts.find((item) => item.path === currentLink);
    if (!recordedCurrent || !same(activeArtifact, recordedCurrent) || activeArtifact.kind !== "symlink" || !oldRelease) {
      throw new Error(`refusing to replace foreign, changed, or dangling active runtime: ${currentLink}`);
    }
  }
  const systemctl = command("systemctl");
  const loadedFragment = run([systemctl, "--user", "show", "pr-cockpit.service", "--property=FragmentPath", "--value"]);
  if (loadedFragment && (!oldManifest || !unitIsOurs(oldManifest))) throw new Error(`refusing to replace unverified loaded service ${loadedFragment}`);
  const oldServiceActive = Bun.spawnSync([systemctl, "--user", "is-active", "--quiet", "pr-cockpit.service"]).exitCode === 0;
  if (oldServiceActive && (!oldManifest || !unitIsOurs(oldManifest, true))) throw new Error(`refusing to replace unverified active service ${unitFile}`);
  if (oldManifest && oldRelease && JSON.stringify(releaseMetadata(oldRelease).files) !== JSON.stringify(oldManifest.releaseFiles)) {
    throw new Error(`active release differs from install manifest: ${oldRelease}`);
  }
  const snapshots = new Map<string, { kind: "file"; content: Buffer; mode: number } | { kind: "symlink"; target: string }>();
  for (const path of artifactPaths) {
    if (!lstatSafe(path)) continue;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) snapshots.set(path, { kind: "symlink", target: readlinkSync(path) });
    else snapshots.set(path, { kind: "file", content: readFileSync(path), mode: stat.mode & 0o777 });
  }
  let envSnapshot: { content: Buffer; mode: number } | null = null;
  if (lstatSafe(envFile)) {
    const stat = lstatSync(envFile);
    if (!stat.isFile() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o777) !== 0o600) {
      throw new Error(`existing environment file has insecure ownership or mode: ${envFile}`);
    }
    envSnapshot = { content: readFileSync(envFile), mode: stat.mode & 0o777 };
  }

  const wasEnabled = Bun.spawnSync([systemctl, "--user", "is-enabled", "--quiet", "pr-cockpit.service"]).exitCode === 0;
  const manageMime = !oldManifest || !oldRelease || mimeBefore === desktopId;
  if (manageMime) {
    assertEditableMimeEntry(join(configHome, "mimeapps.list"));
    assertEditableMimeEntry(join(dataHome, "applications/mimeapps.list"));
  }
  ensureOwnedDirectory(runtimeRoot);
  let switchedCurrent = false;
  let mimeChanged = false;
  let desktopReplaced = false;
  const rollback = () => {
    if (lstatSafe(unitFile)) {
      const stopped = Bun.spawnSync([systemctl, "--user", "stop", "pr-cockpit.service"], { env: process.env, stdout: "pipe", stderr: "pipe" });
      if (stopped.exitCode !== 0) {
        const mainPid = run([systemctl, "--user", "show", "pr-cockpit.service", "--property=MainPID", "--value"]);
        if (mainPid !== "0") {
          const detail = stopped.stderr.toString().trim() || stopped.stdout.toString().trim();
          throw new Error(detail || `systemd stop failed while service remained live with PID ${mainPid}`);
        }
      }
    }
    for (const path of artifactPaths) {
      const snapshot = snapshots.get(path);
      if (!snapshot) rmSync(path, { force: true });
      else if (snapshot.kind === "symlink") atomicSymlink(snapshot.target, path);
      else atomicFile(path, snapshot.content, snapshot.mode);
    }
    if (switchedCurrent) {
      if (oldRelease) atomicSymlink(oldRelease, currentLink);
      else rmSync(currentLink, { force: true });
    }
    if (envSnapshot) atomicFile(envFile, envSnapshot.content, envSnapshot.mode);
    else rmSync(envFile, { force: true });
    if (desktopReplaced) run([command("update-desktop-database"), dirname(desktopFile)]);
    if (manageMime && mimeChanged) {
      if (mimeBefore) run([command("xdg-mime"), "default", mimeBefore, mimeType]);
      else {
        removeOwnedMimeEntry(join(configHome, "mimeapps.list"));
        removeOwnedMimeEntry(join(dataHome, "applications/mimeapps.list"));
      }
      const restoredMime = queryMime();
      if (mimeBefore ? restoredMime !== mimeBefore : restoredMime === desktopId) throw new Error("prior MIME handler rollback could not be verified");
    }
    run([systemctl, "--user", "daemon-reload"]);
    if (oldRelease) {
      run([systemctl, "--user", wasEnabled ? "enable" : "disable", "pr-cockpit.service"]);
      if (oldServiceActive) {
        run([systemctl, "--user", "restart", "pr-cockpit.service"]);
        waitHealth(oldRelease, releaseMetadata(oldRelease).revision);
      } else {
        run([systemctl, "--user", "stop", "pr-cockpit.service"]);
      }
    }
  };
  let obsoleteRelease: string | null = null;
  let retainedPreviousRelease: string | null = null;
  try {
    installConfig();
    failAt("artifact-ownership");
    failAt("activate");
    stopGui(guiPlan);
    atomicSymlink(releaseRoot, currentLink);
    switchedCurrent = true;
    const launcher = `${currentLink}/scripts/cockpit`;
    const generated: Artifact[] = [{ path: currentLink, kind: "symlink", target: releaseRoot }];
    generated.push(atomicFile(desktopFile, desktop(runtimeLauncher)));
    desktopReplaced = true;
    generated.push(atomicFile(autostartFile, autostart(launcher)));
    generated.push(atomicCopy(join(releaseRoot, "assets/icon.png"), iconFile));
    generated.push(atomicFile(unitFile, service(command("bun"), command("gh"), command("ln"), realpathSync(source), revision)));
    generated.push(atomicSymlink(`${currentLink}/scripts/pr-cockpit`, cliFile));
    failAt("desktop-validate");
    if (Bun.which("desktop-file-validate")) run([command("desktop-file-validate"), desktopFile]);
    run([command("update-desktop-database"), dirname(desktopFile)]);
    if (manageMime) {
      run([command("xdg-mime"), "default", desktopId, mimeType]);
      mimeChanged = true;
      const selectedMime = queryMime();
      if (selectedMime !== desktopId) throw new Error(`xdg-mime selected ${selectedMime ?? "no handler"} instead of ${desktopId}`);
    }
    failAt("mime");
    run([systemctl, "--user", "daemon-reload"]);
    run([systemctl, "--user", "enable", "pr-cockpit.service"]);
    const enabledLink = observed(wantsLink);
    if (!enabledLink || enabledLink.kind !== "symlink" || canonicalPath(resolve(dirname(wantsLink), enabledLink.target!)) !== canonicalPath(unitFile)) {
      throw new Error(`systemd enablement link does not target owned unit: ${wantsLink}`);
    }
    generated.push(enabledLink);
    stopUnmanagedServer();
    run([systemctl, "--user", "restart", "pr-cockpit.service"]);
    failAt("unit");
    const fragment = run([systemctl, "--user", "show", "pr-cockpit.service", "--property=FragmentPath", "--value"]);
    if (canonicalPath(fragment) !== canonicalPath(unitFile)) throw new Error(`systemd loaded foreign unit fragment: ${fragment}`);
    failAt("health");
    waitHealth(releaseRoot, revision);
    ensureOwnedDirectory(stateDir);
    const previousRelease = oldRelease === releaseRoot ? oldManifest?.priorRelease ?? null : oldRelease;
    retainedPreviousRelease = previousRelease;
    const previousReleaseFiles = previousRelease === null ? null : previousRelease === oldRelease ? oldManifest?.releaseFiles ?? null : oldManifest?.priorReleaseFiles ?? null;
    const manifest: Manifest = { version: 1, sourceRoot: realpathSync(source), revision, currentRelease: releaseRoot, priorRelease: previousRelease, priorMimeHandler: priorMime === desktopId ? null : priorMime, artifacts: generated, releaseFiles: metadata.files, priorReleaseFiles: previousReleaseFiles };
    failAt("manifest");
    atomicFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    obsoleteRelease = oldManifest?.priorRelease ?? null;
  } catch (error) {
    try {
      rollback();
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "activation failed and prior release rollback could not be proved");
    }
    if (launchGui && graphical() && oldRelease) {
      try { Bun.spawn([`${currentLink}/scripts/cockpit`, "--show"], { env: process.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref(); } catch {}
    }
    throw error;
  }
  const retainedReleases = new Set([releaseRoot, retainedPreviousRelease].filter((path): path is string => path !== null).map(canonicalPath));
  if (obsoleteRelease && !retainedReleases.has(canonicalPath(obsoleteRelease))) {
    try { removeOwnedRelease(obsoleteRelease, oldManifest?.priorReleaseFiles); } catch (error) { console.warn(`pr-cockpit: retained old release: ${error}`); }
  }
  if (launchGui && graphical()) {
    try { Bun.spawn([`${currentLink}/scripts/cockpit`, "--show"], { env: process.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref(); } catch (error) { console.warn(`pr-cockpit: GUI relaunch failed: ${error}`); }
  }
}
function activateCandidate(release: string, source: string, launchGui: boolean, actorRoot: string, expectedGeneration: string, candidateRevision: string): void {
  if (!/^[0-9a-f]{64}$/.test(expectedGeneration)) throw new Error("expected install generation is invalid");
  if (!/^[0-9a-f]{40,64}$/.test(candidateRevision)) throw new Error("candidate revision is invalid");
  const candidate = realpathSync(release);
  try {
    if (installGeneration() !== expectedGeneration) throw new Error("Linux installation changed before activation");
    const metadata = releaseMetadata(candidate);
    if (metadata.revision !== candidateRevision) throw new Error("staged release revision changed before activation");
    const sourceRoot = realpathSync(source);
    if (run([command("git"), "-C", sourceRoot, "rev-parse", "HEAD"]) !== candidateRevision) throw new Error("source HEAD changed after release staging");
    activate(candidate, sourceRoot, launchGui, realpathSync(actorRoot));
  } catch (error) {
    const installed = readManifest();
    const retained = new Set([installed?.currentRelease, installed?.priorRelease].filter((path): path is string => !!path).map(canonicalPath));
    if (currentRelease() !== candidate && !retained.has(candidate) && existsSync(candidate)) removeOwnedRelease(candidate);
    throw error;
  }
}
function desktopExists(id: string): boolean {
  if (id.includes("/") || id.includes("\\")) return false;
  return [join(dataHome, "applications", id), "/usr/local/share/applications/" + id, "/usr/share/applications/" + id].some(existsSync);
}
function assertEditableMimeEntry(path: string): void {
  if (!existsSync(path) && !lstatSafe(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o022) !== 0) {
    throw new Error(`refusing to edit insecure MIME applications file: ${path}`);
  }
}

function removeOwnedMimeEntry(path: string): void {
  if (!existsSync(path) && !lstatSafe(path)) return;
  assertEditableMimeEntry(path);
  const lines = readFileSync(path, "utf8").split("\n");
  let section = "";
  const kept = lines.filter((line) => {
    const heading = line.match(/^\[([^\]]+)\]$/);
    if (heading) section = heading[1];
    return !(["Default Applications", "Added Associations"].includes(section) && line === `${mimeType}=${desktopId};`);
  });
  if (kept.length !== lines.length) atomicFile(path, kept.join("\n"), lstatSync(path).mode & 0o777);
}
function unitIsOurs(manifest: Manifest, requireProcess = false): boolean {
  const recorded = manifest.artifacts.find((item) => item.path === unitFile);
  if (!recorded) return false;
  const unitArtifact = observed(unitFile);
  if (unitArtifact && !same(unitArtifact, recorded)) return false;
  const systemctl = command("systemctl");
  const fragment = run([systemctl, "--user", "show", "pr-cockpit.service", "--property=FragmentPath", "--value"]);
  if (canonicalPath(fragment) !== canonicalPath(unitFile)) return false;
  const pid = run([systemctl, "--user", "show", "pr-cockpit.service", "--property=MainPID", "--value"]);
  if (pid && pid !== "0") {
    if (!/^[1-9][0-9]*$/.test(pid)) return false;
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    if (!argv.includes(`${currentLink}/server/main.ts`) && !argv.includes(`${manifest.currentRelease}/server/main.ts`)) return false;
    const controlGroup = run([systemctl, "--user", "show", "pr-cockpit.service", "--property=ControlGroup", "--value"]);
    const processGroups = readFileSync(`/proc/${pid}/cgroup`, "utf8").split("\n").map((line) => line.slice(line.lastIndexOf(":") + 1));
    if (!controlGroup || !processGroups.some((group) => group === controlGroup || group.startsWith(`${controlGroup}/`))) return false;
  }
  if (requireProcess && (!pid || pid === "0")) return false;
  return true;
}
function bounded(path: string): string {
  const canonical = canonicalPath(path);
  if (!canonical.startsWith(`${home}/`) || canonical === home) {
    throw new Error(`refusing to purge path outside HOME: ${path}`);
  }
  return canonical;
}
function linuxProcessStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19] || null;
  } catch {
    return null;
  }
}
function planGuiStop(manifest: Manifest): { pid: number; start: string } | "stale" | null {
  if (!existsSync(shellProcessFile) && !lstatSafe(shellProcessFile)) return null;
  const recordStat = lstatSync(shellProcessFile);
  if (!recordStat.isFile() || recordStat.isSymbolicLink() || (uid !== undefined && recordStat.uid !== uid) || (recordStat.mode & 0o777) !== 0o600) {
    throw new Error("Linux GUI ownership record has insecure ownership or mode");
  }
  const values = new Map<string, string>();
  for (const line of readFileSync(shellProcessFile, "utf8").trim().split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0 || values.has(line.slice(0, separator))) throw new Error("Linux GUI ownership record is invalid");
    values.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const ownerKeys = ["pid", "start", "executable", "release"];
  const hasOwners = ownerKeys.every((key) => values.has(key));
  const preTrayRecord = values.size === 4 && hasOwners;
  const trayReadyRecord = values.size === 5 && hasOwners && values.get("tray") === "ready";
  if (!preTrayRecord && !trayReadyRecord) throw new Error("Linux GUI ownership record is invalid");
  const pid = Number(values.get("pid"));
  const start = values.get("start") || "";
  if (!Number.isSafeInteger(pid) || pid <= 0 || !start) throw new Error("Linux GUI ownership record is invalid");
  const actualStart = linuxProcessStart(pid);
  if (!actualStart) return "stale";
  const release = canonicalPath(values.get("release") || "");
  const allowedReleases = new Set([manifest.currentRelease, manifest.priorRelease].filter(Boolean).map((path) => canonicalPath(path!)));
  const executable = canonicalPath(values.get("executable") || "");
  let actualExecutable: string;
  try { actualExecutable = realpathSync(`/proc/${pid}/exe`); } catch { throw new Error("refusing to stop process whose executable cannot be verified"); }
  if (actualStart !== start || !allowedReleases.has(release) || executable !== actualExecutable || executable !== join(release, "shell/node_modules/electron/dist/electron")) {
    throw new Error("refusing to stop unverified Linux GUI process");
  }
  return { pid, start };
}
function stopGui(plan: { pid: number; start: string } | "stale" | null): void {
  if (!plan) return;
  if (plan === "stale") {
    rmSync(shellProcessFile, { force: true });
    return;
  }
  try {
    process.kill(plan.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      rmSync(shellProcessFile, { force: true });
      return;
    }
    throw error;
  }
  for (let attempt = 0; attempt < 50; attempt++) {
    const start = linuxProcessStart(plan.pid);
    if (!start || start !== plan.start) {
      rmSync(shellProcessFile, { force: true });
      return;
    }
    Bun.sleepSync(100);
  }
  throw new Error("owned Linux GUI did not exit after SIGTERM");
}
function uninstall(purge: boolean): void {
  const manifest = readManifest();
  if (!manifest) {
    if (purge) throw new Error("refusing to purge without an install ownership manifest");
    return;
  }
  for (const artifact of manifest.artifacts) {
    const actual = observed(artifact.path);
    if (actual && !same(actual, artifact)) throw new Error(`refusing to remove changed artifact: ${artifact.path}`);
  }
  if (existsSync(manifest.currentRelease)) {
    const currentFiles = releaseMetadata(manifest.currentRelease).files;
    if (JSON.stringify(currentFiles) !== JSON.stringify(manifest.releaseFiles)) throw new Error("current release differs from install manifest");
  }
  if (manifest.priorRelease && existsSync(manifest.priorRelease)) {
    const priorFiles = releaseMetadata(manifest.priorRelease).files;
    if (!manifest.priorReleaseFiles || JSON.stringify(priorFiles) !== JSON.stringify(manifest.priorReleaseFiles)) throw new Error("prior release differs from install manifest");
  }
  const purgeRoots = purge ? [persistentData, configDir, stateDir, runtimeRoot].map(bounded) : [];
  const systemctl = command("systemctl");
  const serviceActive = Bun.spawnSync([systemctl, "--user", "is-active", "--quiet", "pr-cockpit.service"]).exitCode === 0;
  const verifiedUnit = unitIsOurs(manifest, serviceActive);
  if (serviceActive && !verifiedUnit) throw new Error(`refusing to stop unverified service ${unitFile}`);
  const mimeBefore = queryMime();
  const priorMimeExists = !!manifest.priorMimeHandler && desktopExists(manifest.priorMimeHandler);
  const guiPlan = planGuiStop(manifest);
  if (mimeBefore === desktopId) {
    assertEditableMimeEntry(join(configHome, "mimeapps.list"));
    assertEditableMimeEntry(join(dataHome, "applications/mimeapps.list"));
  }

  stopGui(guiPlan);
  if (verifiedUnit) {
    if (!unitIsOurs(manifest, serviceActive)) throw new Error(`service ownership changed before disable: ${unitFile}`);
    run([systemctl, "--user", "disable", "--now", "pr-cockpit.service"]);
  }
  if (mimeBefore === desktopId) {
    if (manifest.priorMimeHandler && priorMimeExists) {
      run([command("xdg-mime"), "default", manifest.priorMimeHandler, mimeType]);
    } else {
      removeOwnedMimeEntry(join(configHome, "mimeapps.list"));
      removeOwnedMimeEntry(join(dataHome, "applications/mimeapps.list"));
    }
  }
  let desktopRemoved = false;
  for (const artifact of manifest.artifacts) {
    const actual = observed(artifact.path);
    if (!actual) continue;
    if (!same(actual, artifact)) throw new Error(`artifact changed before removal: ${artifact.path}`);
    rmSync(artifact.path, { force: true });
    if (artifact.path === desktopFile) desktopRemoved = true;
  }
  if (desktopRemoved) run([command("update-desktop-database"), dirname(desktopFile)]);
  if (mimeBefore === desktopId) {
    const expectedMime = manifest.priorMimeHandler && priorMimeExists ? manifest.priorMimeHandler : null;
    const mimeAfter = queryMime();
    if (expectedMime ? mimeAfter !== expectedMime : mimeAfter === desktopId) throw new Error("MIME handler rollback could not be verified");
  }
  run([systemctl, "--user", "daemon-reload"]);
  if (existsSync(manifest.currentRelease)) removeOwnedRelease(manifest.currentRelease, manifest.releaseFiles);
  if (manifest.priorRelease && existsSync(manifest.priorRelease)) removeOwnedRelease(manifest.priorRelease, manifest.priorReleaseFiles);
  if (purge) {
    for (const root of [persistentData, configDir, stateDir, runtimeRoot]) {
      if (!root.startsWith(`${home}/`)) throw new Error(`refusing to purge path outside HOME: ${root}`);
      rmSync(root, { recursive: true, force: true });
    }
  }
}

function activeManifest(actorRoot: string): Manifest {
  const manifest = readManifest();
  if (!manifest) throw new Error("Linux install manifest is missing");
  const actorRelease = releaseMetadata(actorRoot);
  if (actorRoot !== canonicalPath(manifest.currentRelease) || actorRelease.revision !== manifest.revision || JSON.stringify(actorRelease.files) !== JSON.stringify(manifest.releaseFiles) || currentRelease() !== actorRoot) throw new Error("active release does not match the install manifest");
  return manifest;
}
function usage(): never {
  throw new Error("usage: linux-lifecycle.ts source | revision | stage SOURCE GENERATION | activate RELEASE SOURCE GENERATION REVISION [--gui] | install SOURCE [--gui] | uninstall [--purge]");
}
export function runLifecycle(argv: string[], options: { platform?: NodeJS.Platform; actorRoot?: string } = {}): void {
  const [action, ...args] = argv;
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") throw new Error("Linux lifecycle requires Linux");
  const valid = (action === "source" || action === "revision")
    ? args.length === 0
    : action === "stage"
      ? args.length === 2 && !args.includes("--gui")
      : action === "activate"
        ? (args.length === 4 || (args.length === 5 && args[4] === "--gui")) && !args.slice(0, 4).includes("--gui")
        : action === "install"
          ? ((args.length === 1 || (args.length === 2 && args[1] === "--gui")) && args[0] !== "--gui")
          : action === "uninstall"
            ? (args.length === 0 || (args.length === 1 && args[0] === "--purge"))
            : false;
  if (!valid) usage();
  const prerequisites = action === "source" || action === "revision" ? [] : action === "uninstall" ? ["systemctl", "xdg-mime", "update-desktop-database"] : ["bun", "git", "gh", "curl", "mv", "systemctl", "xdg-mime", "update-desktop-database", "tar"];
  for (const required of prerequisites) command(required);
  const actorRoot = options.actorRoot ?? realpathSync(join(import.meta.dir, ".."));
  if (action === "source") withLifecycleLock(() => {
    const manifest = activeManifest(actorRoot);
    console.log(`${manifest.sourceRoot}\t${installGeneration()}`);
  });
  else if (action === "revision") console.log(activeManifest(actorRoot).revision);
  else if (action === "stage") {
    const candidate = withLifecycleLock(() => stage(args[0], args[1]));
    console.log(`${candidate.release}\t${candidate.revision}`);
  } else if (action === "activate") withLifecycleLock(() => activateCandidate(args[0], args[1], args.includes("--gui"), actorRoot, args[2], args[3]));
  else if (action === "install") {
    const source = args[0];
    const transaction = withLifecycleLock(() => {
      const generation = installGeneration();
      return { generation, ...stage(source, generation) };
    });
    const childArgs = [command("bun"), join(transaction.release, "scripts/linux-lifecycle.ts"), "activate", transaction.release, source, transaction.generation, transaction.revision];
    if (args.includes("--gui")) childArgs.push("--gui");
    const activated = Bun.spawnSync(childArgs, {
      env: { ...process.env, COCKPIT_INSTALL_REPORT_CHILD: "1" },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    if (activated.exitCode !== 0) throw new Error("immutable release activation failed");
  }
  else if (action === "uninstall") withLifecycleLock(() => uninstall(args.includes("--purge")));
  else usage();
}

export function errorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) return [error.message, ...Array.from(error.errors, (nested) => errorMessages(nested)).flat()];
  return [error instanceof Error ? error.message : String(error)];
}
if (import.meta.main) {
  try {
    runLifecycle(process.argv.slice(2));
  } catch (error) {
    await exitLifecycleFailure(error);
  }
}
