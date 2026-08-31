import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "install-linux-tools");
const cleanups: string[] = [];
interface ToolFixture {
  root: string;
  home: string;
  dataHome: string;
  bin: string;
  log: string;
  script: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}
afterEach(() => {
  for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});
function executable(path: string, body: string): void {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path, 0o755);
}
async function fixture(archiveAttack = "", args: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "pr-cockpit-linux-tools-"));
  cleanups.push(root);
  const home = join(root, "home");
  const dataHome = join(home, ".local/share");
  const bin = join(root, "bin");
  const log = join(root, "downloads");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(bin, { recursive: true });
  executable(join(bin, "uname"), `if [[ "\${1:-}" == "-s" ]]; then printf 'Linux\\n'; else printf '%s\\n' "\${TEST_ARCH:-x86_64}"; fi`);
  const statUid = process.platform === "darwin" ? "/usr/bin/stat -f %u" : "/usr/bin/stat -c %u";
  const statMode = process.platform === "darwin" ? "/usr/bin/stat -f %Lp" : "/usr/bin/stat -c %a";
  executable(join(bin, "curl"), `[[ -z "\${CURL_DELAY:-}" ]] || sleep "$CURL_DELAY"; printf '%s\\n' "$*" >> ${JSON.stringify(log)}; while [[ "$1" != "-o" ]]; do shift; done; printf payload > "$2"`);
  executable(join(bin, "sha256sum"), `if [[ "\${1:-}" == "-c" ]]; then cat >/dev/null; elif /usr/bin/grep -q changed "$1"; then printf '%s  %s\\n' "${"b".repeat(64)}" "$1"; else printf '%s  %s\\n' "${"a".repeat(64)}" "$1"; fi`);
  executable(join(bin, "realpath"), `case "\${1:-}" in -ms) path="$2"; case "$path" in */bin/../versions/*) prefix="\${path%%/bin/../versions/*}"; suffix="\${path#*/bin/../versions/}"; printf '%s/versions/%s\\n' "$prefix" "$suffix";; *) printf '%s\\n' "$path";; esac;; -e|-m) printf '%s\\n' "$2";; *) printf '%s\\n' "$1";; esac`);
  executable(join(bin, "stat"), `case "$2" in %F) [[ -L "$3" ]] && printf 'symbolic link\\n' || { [[ -d "$3" ]] && printf 'directory\\n' || printf 'regular file\\n'; };; %u) ${statUid} "$3";; %a) ${statMode} "$3";; *) exit 2;; esac`);
  executable(join(bin, "unzip"), `if [[ "$1" == "-Z1" ]]; then printf 'bun-linux-x64/bun\\n'; if [[ "\${ARCHIVE_ATTACK:-}" == "duplicate" ]]; then printf 'bun-linux-x64/bun\\n'; fi; exit 0; elif [[ "$1" == "-Z" && "$2" == "-l" ]]; then if [[ "\${ARCHIVE_ATTACK:-}" == "zip-symlink" ]]; then printf 'lrwxrwxrwx 1 x x 4 Jan 1 00:00 bun-linux-x64/bun\\n'; else printf '%s\\n' '-rwxr-xr-x 1 x x 4 Jan 1 00:00 bun-linux-x64/bun'; fi; printf '2 files, 4 bytes uncompressed, 4 bytes compressed: 0.0%%\\n'; elif [[ "$1" == "-p" ]]; then printf '#!/usr/bin/env bash\\nexit 0\\n'; else exit 2; fi`);
  executable(join(bin, "tar"), `if [[ "$1" == "-tzf" ]]; then printf 'gh_2.76.2_linux_amd64/bin/gh\\n'; elif [[ "$1" == "-tvzf" ]]; then [[ "\${ARCHIVE_ATTACK:-}" == "symlink" ]] && printf 'lrwxrwxrwx target\\n' || printf '%s\\n' '-rwxr-xr-x target'; elif [[ "$1" == "-xOzf" ]]; then printf '#!/usr/bin/env bash\\nexit 0\\n'; else exit 2; fi`);
  executable(join(bin, "mv"), `if [[ "\${1:-}" == "-T" || "\${1:-}" == "-Tn" || "\${1:-}" == "-Tf" ]]; then /bin/mv "$2" "$3"; else /bin/mv "$@"; fi`);
  const script = join(root, "install-linux-tools");
  writeFileSync(script, readFileSync(SCRIPT, "utf8").replaceAll("/usr/bin/uname", join(bin, "uname")), { mode: 0o755 });
  const proc = Bun.spawn([script, ...args], {
    env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome, PATH: `${bin}:/usr/bin:/bin`, ARCHIVE_ATTACK: archiveAttack },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { root, home, dataHome, bin, log, script, stdout, stderr, exitCode };
}
async function runFixture(f: ToolFixture, env: Record<string, string> = {}, args: string[] = []) {
  const proc = Bun.spawn([f.script, ...args], {
    env: { ...process.env, HOME: f.home, XDG_DATA_HOME: f.dataHome, PATH: `${f.dataHome}/pr-cockpit-tools/bin:${f.bin}:/usr/bin:/bin`, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

function processStart(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19] || "";
  } catch {
    return "";
  }
}

test.skipIf(process.getuid?.() === 0)("rejects non-Linux before dry-run network or filesystem mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "pr-cockpit-linux-tools-platform-"));
  cleanups.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const network = join(root, "network");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(bin);
  executable(join(bin, "uname"), `printf 'Darwin\\n'`);
  executable(join(bin, "curl"), `touch ${JSON.stringify(network)}`);
  const script = join(root, "install-linux-tools");
  writeFileSync(script, readFileSync(SCRIPT, "utf8").replaceAll("/usr/bin/uname", join(bin, "uname")), { mode: 0o755 });
  const proc = Bun.spawn([script], {
    env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, ".local/share"), COCKPIT_BOOTSTRAP_DRY_RUN: "1", PATH: `${bin}:/usr/bin:/bin` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(1);
  expect(stderr).toContain("require Linux");
  expect(existsSync(network)).toBe(false);
  expect(existsSync(join(home, ".local"))).toBe(false);
});

test("supports an explicit mutation-free dry run", async () => {
  const f = await fixture("", ["--dry-run"]);
  expect(f.exitCode).toBe(0);
  expect(existsSync(join(f.dataHome, "pr-cockpit-tools"))).toBe(false);
  expect(existsSync(f.log)).toBe(false);
});

test("dry run plans both unconditional private pins even with external tools", async () => {
  const f = await fixture();
  const tools = join(f.dataHome, "pr-cockpit-tools");
  rmSync(tools, { recursive: true });
  executable(join(f.bin, "bun"), "exit 0");
  executable(join(f.bin, "gh"), "exit 0");
  const downloadsBefore = readFileSync(f.log);
  const result = await runFixture(f, {}, ["--dry-run"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("would install pinned private Bun 1.2.22");
  expect(result.stdout).toContain("would install pinned private GitHub CLI 2.76.2");
  expect(readFileSync(f.log)).toEqual(downloadsBefore);
  expect(existsSync(tools)).toBe(false);
});

test("rejects unknown arguments before publishing tools", async () => {
  const f = await fixture("", ["--unknown"]);
  expect(f.exitCode).toBe(2);
  expect(f.stderr).toContain("usage: scripts/install-linux-tools [--dry-run | --paths]");
  expect(existsSync(join(f.dataHome, "pr-cockpit-tools"))).toBe(false);
});

test("installs verified pinned Bun and GitHub CLI into the owned user tool root", async () => {
  const f = await fixture();
  expect(f.exitCode).toBe(0);
  expect(f.stderr).toBe("");
  const tools = join(f.dataHome, "pr-cockpit-tools");
  expect(lstatSync(join(tools, "bin/bun")).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(tools, "bin/bun"))).toBe("../versions/bun-1.2.22/bun");
  expect(readlinkSync(join(tools, "bin/gh"))).toBe("../versions/gh-2.76.2/gh");
  expect(statSync(join(tools, "versions/bun-1.2.22/bun")).mode & 0o777).toBe(0o755);
  expect(statSync(join(tools, "versions/gh-2.76.2/gh")).mode & 0o777).toBe(0o755);
  const downloads = readFileSync(f.log, "utf8");
  expect(downloads).toContain("--proto =https --tlsv1.2 -fL");
  expect(downloads).toContain("--connect-timeout 10 --max-time 300");
  expect(downloads).toContain("--retry 3 --retry-delay 2 --retry-max-time 300 --retry-all-errors");
  expect(downloads).toContain("bun-v1.2.22/bun-linux-x64.zip");
  expect(downloads).toContain("v2.76.2/gh_2.76.2_linux_amd64.tar.gz");
});

test("normal mode provisions private pins without changing external tools", async () => {
  const f = await fixture();
  const tools = join(f.dataHome, "pr-cockpit-tools");
  rmSync(tools, { recursive: true });
  executable(join(f.bin, "bun"), "printf external-bun");
  executable(join(f.bin, "gh"), "printf external-gh");
  const bunBefore = readFileSync(join(f.bin, "bun"));
  const ghBefore = readFileSync(join(f.bin, "gh"));
  const result = await runFixture(f);
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(f.bin, "bun"))).toEqual(bunBefore);
  expect(readFileSync(join(f.bin, "gh"))).toEqual(ghBefore);
  expect(readlinkSync(join(tools, "bin/bun"))).toBe("../versions/bun-1.2.22/bun");
  expect(readlinkSync(join(tools, "bin/gh"))).toBe("../versions/gh-2.76.2/gh");
});

test("validation-only paths mode ignores a newer managed link and returns its embedded verified binaries", async () => {
  const f = await fixture();
  const tools = join(f.dataHome, "pr-cockpit-tools");
  const newer = join(tools, "versions/bun-9.9.9");
  mkdirSync(newer, { mode: 0o700 });
  executable(join(newer, "bun"), "exit 0");
  writeFileSync(join(newer, ".pr-cockpit-tool"), `archive=${"c".repeat(64)}\nbinary=${"a".repeat(64)}\n`, { mode: 0o600 });
  const bunLink = join(tools, "bin/bun");
  rmSync(bunLink);
  symlinkSync("../versions/bun-9.9.9/bun", bunLink);
  const result = await runFixture(f, {}, ["--paths"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe(`${tools}/versions/bun-1.2.22/bun\t${tools}/versions/gh-2.76.2/gh`);
  expect(result.stderr).toBe("");
  for (const path of result.stdout.trim().split("\t")) {
    expect(lstatSync(path).isFile()).toBe(true);
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
  }
  expect(readlinkSync(bunLink)).toBe("../versions/bun-9.9.9/bun");
});

test("validation-only paths mode fails without mutation when an embedded pin is missing", async () => {
  const f = await fixture();
  const tools = join(f.dataHome, "pr-cockpit-tools");
  rmSync(join(tools, "versions/bun-1.2.22"), { recursive: true });
  const sentinel = join(tools, "sentinel");
  writeFileSync(sentinel, "keep");
  const downloadsBefore = readFileSync(f.log);
  const entriesBefore = readdirSync(tools).sort();
  const result = await runFixture(f, {}, ["--paths"]);
  expect(result.exitCode).toBe(1);
  expect(readFileSync(sentinel, "utf8")).toBe("keep");
  expect(readFileSync(f.log)).toEqual(downloadsBefore);
  expect(readdirSync(tools).sort()).toEqual(entriesBefore);
  expect(existsSync(join(f.dataHome, ".pr-cockpit-tools.lock"))).toBe(false);
});

test.each(["missing", "symlink", "mode"] as const)(
  "validation-only paths mode rejects a %s ancestor without mutation",
  async (attack) => {
    const f = await fixture();
    const tools = join(f.dataHome, "pr-cockpit-tools");
    const versions = join(tools, "versions");
    if (attack === "missing") rmSync(versions, { recursive: true });
    else if (attack === "symlink") {
      const outside = join(f.root, "outside-versions");
      rmSync(versions, { recursive: true });
      mkdirSync(outside);
      symlinkSync(outside, versions);
    } else chmodSync(f.dataHome, 0o777);
    const downloadsBefore = readFileSync(f.log);
    const result = await runFixture(f, {}, ["--paths"]);
    expect(result.exitCode).toBe(1);
    expect(readFileSync(f.log)).toEqual(downloadsBefore);
    expect(existsSync(join(f.dataHome, ".pr-cockpit-tools.lock"))).toBe(false);
  },
);

test("atomically repoints an exact prior managed pin and retains the old version", async () => {
  const f = await fixture();
  const tools = join(f.dataHome, "pr-cockpit-tools");
  const prior = join(tools, "versions/bun-1.2.21");
  mkdirSync(prior, { recursive: true, mode: 0o700 });
  executable(join(prior, "bun"), "exit 0");
  writeFileSync(join(prior, ".pr-cockpit-tool"), `archive=594f454d51ce57199d4320c85cbd495be9c054ef17aaebca5e6c908abfda6179\nbinary=${"a".repeat(64)}\n`, { mode: 0o600 });
  const link = join(tools, "bin/bun");
  rmSync(link);
  symlinkSync("../versions/bun-1.2.21/bun", link);
  const proc = Bun.spawn([f.script], {
    env: { ...process.env, HOME: f.home, XDG_DATA_HOME: f.dataHome, PATH: `${tools}/bin:${f.bin}:/usr/bin:/bin` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(0);
  expect(stderr).toBe("");
  expect(readlinkSync(link)).toBe("../versions/bun-1.2.22/bun");
  expect(readFileSync(join(prior, ".pr-cockpit-tool"), "utf8")).toContain("archive=594f454");
});

(process.getuid?.() === 0 ? test : test.skip)("rejects UID zero before network or filesystem mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "pr-cockpit-linux-tools-root-"));
  cleanups.push(root);
  const network = join(root, "network");
  const bin = join(root, "bin");
  const home = join(root, "home");
  const dataHome = join(home, ".local/share");
  mkdirSync(dataHome, { recursive: true, mode: 0o700 });
  mkdirSync(bin, { recursive: true });
  executable(join(bin, "curl"), `touch ${JSON.stringify(network)}`);
  const privateFile = join(dataHome, "private");
  writeFileSync(privateFile, "untouched", { mode: 0o600 });
  const proc = Bun.spawn([SCRIPT], {
    env: { ...process.env, HOME: home, XDG_DATA_HOME: dataHome, PATH: `${bin}:/usr/bin:/bin` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(1);
  expect(stderr).toContain("must not be installed as root");
  expect(await Bun.file(network).exists()).toBe(false);
  expect(await Bun.file(join(dataHome, "pr-cockpit-tools")).exists()).toBe(false);
  expect(readFileSync(privateFile, "utf8")).toBe("untouched");
});

test("rejects a duplicated exact archive member without publishing Bun", async () => {
  const f = await fixture("duplicate");
  expect(f.exitCode).toBe(1);
  expect(f.stderr).toContain("does not contain exactly one bun-linux-x64/bun");
  expect(await Bun.file(join(f.dataHome, "pr-cockpit-tools/bin/bun")).exists()).toBe(false);
  expect(await Bun.file(join(f.dataHome, "pr-cockpit-tools/versions/bun-1.2.22")).exists()).toBe(false);
});


test("rejects a zip symlink member without publishing Bun", async () => {
  const f = await fixture("zip-symlink");
  expect(f.exitCode).toBe(1);
  expect(f.stderr).toContain("archive member is not regular");
  expect(await Bun.file(join(f.dataHome, "pr-cockpit-tools/bin/bun")).exists()).toBe(false);
});
test("rejects a symlink archive member without publishing GitHub CLI", async () => {
  const f = await fixture("symlink");
  expect(f.exitCode).toBe(1);
  expect(f.stderr).toContain("archive member is not regular");
  expect(await Bun.file(join(f.dataHome, "pr-cockpit-tools/bin/gh")).exists()).toBe(false);
  expect(await Bun.file(join(f.dataHome, "pr-cockpit-tools/versions/gh-2.76.2")).exists()).toBe(false);
});

test("rejects a self-declared marker for an unrecognized prior pin", async () => {
  const f = await fixture();
  const tools = join(f.dataHome, "pr-cockpit-tools");
  const forged = join(tools, "versions/bun-9.9.9");
  mkdirSync(forged, { mode: 0o700 });
  executable(join(forged, "bun"), "exit 0");
  writeFileSync(join(forged, ".pr-cockpit-tool"), `archive=${"c".repeat(64)}\nbinary=${"a".repeat(64)}\n`, { mode: 0o600 });
  const link = join(tools, "bin/bun");
  rmSync(link);
  symlinkSync("../versions/bun-9.9.9/bun", link);
  const proc = Bun.spawn([f.script], {
    env: { ...process.env, HOME: f.home, XDG_DATA_HOME: f.dataHome, PATH: `${tools}/bin:${f.bin}:/usr/bin:/bin` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(1);
  expect(stderr).toContain("refusing unrecognized managed tool pin");
  expect(readlinkSync(link)).toBe("../versions/bun-9.9.9/bun");
});

test("refuses a changed owned tool version", async () => {
  const f = await fixture();
  const binary = join(f.dataHome, "pr-cockpit-tools/versions/bun-1.2.22/bun");
  writeFileSync(binary, "#!/usr/bin/env bash\nchanged\n");
  chmodSync(binary, 0o755);
  const proc = Bun.spawn([f.script], {
    env: { ...process.env, HOME: f.home, XDG_DATA_HOME: f.dataHome, PATH: `${f.bin}:/usr/bin:/bin` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(1);
  expect(stderr).toContain("refusing to reuse changed tool directory");
});

test("refuses to replace a foreign owned-tool leaf", async () => {
  const f = await fixture();
  const bun = join(f.dataHome, "pr-cockpit-tools/bin/bun");
  rmSync(bun);
  writeFileSync(bun, "foreign");
  const proc = Bun.spawn([f.script], {
    env: { ...process.env, HOME: f.home, XDG_DATA_HOME: f.dataHome, PATH: `${f.bin}:/usr/bin:/bin` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(1);
  expect(stderr).toContain("refusing to replace foreign tool");
  expect(readFileSync(bun, "utf8")).toBe("foreign");
});

test("rejects a foreign owned leaf even when a legitimate external tool resolves first", async () => {
  const f = await fixture();
  const tools = join(f.dataHome, "pr-cockpit-tools");
  const bun = join(tools, "bin/bun");
  rmSync(bun);
  writeFileSync(bun, "foreign");
  executable(join(f.bin, "bun"), "exit 0");
  const proc = Bun.spawn([f.script], {
    env: { ...process.env, HOME: f.home, XDG_DATA_HOME: f.dataHome, PATH: `${f.bin}:${tools}/bin:/usr/bin:/bin` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited).toBe(1);
  expect(stderr).toContain("refusing to replace foreign tool");
  expect(readFileSync(bun, "utf8")).toBe("foreign");
});

test("serializes concurrent installers and leaves exact managed links", async () => {
  const f = await fixture();
  rmSync(join(f.dataHome, "pr-cockpit-tools"), { recursive: true, force: true });
  const first = runFixture(f, { CURL_DELAY: "0.1" });
  const second = runFixture(f, { CURL_DELAY: "0.1" });
  const results = await Promise.all([first, second]);
  expect(results.map((result) => result.exitCode)).toEqual([0, 0]);
  const bin = join(f.dataHome, "pr-cockpit-tools/bin");
  expect(readlinkSync(join(bin, "bun"))).toBe("../versions/bun-1.2.22/bun");
  expect(readlinkSync(join(bin, "gh"))).toBe("../versions/gh-2.76.2/gh");
  expect(() => lstatSync(join(f.dataHome, ".pr-cockpit-tools.lock"))).toThrow();
});

test("refuses a live tool lock without changing its ownership record", async () => {
  const f = await fixture();
  const lock = join(f.dataHome, ".pr-cockpit-tools.lock");
  const owner = `${process.pid}:${processStart(process.pid) ?? "-"}:${"a".repeat(16)}`;
  symlinkSync(owner, lock);
  const result = await runFixture(f);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("another Linux tool installation is active");
  expect(readlinkSync(lock)).toBe(owner);
});

test("reclaims a stale exact lock before revalidating managed versions", async () => {
  const f = await fixture();
  const lock = join(f.dataHome, ".pr-cockpit-tools.lock");
  symlinkSync(`999999999:1:${"b".repeat(16)}`, lock);
  const result = await runFixture(f);
  expect(result.exitCode).toBe(0);
  expect(() => lstatSync(lock)).toThrow();
});

test("waits out invalid interrupted-equivalent tool lock leaves without replacing them", async () => {
  const f = await fixture();
  const lock = join(f.dataHome, ".pr-cockpit-tools.lock");
  writeFileSync(lock, "interrupted");
  const invalidFile = await runFixture(f);
  expect(invalidFile.exitCode).toBe(1);
  expect(invalidFile.stderr).toContain("another Linux tool installation is active");
  expect(readFileSync(lock, "utf8")).toBe("interrupted");
  rmSync(lock);
  symlinkSync("incomplete", lock);
  const invalidLink = await runFixture(f);
  expect(invalidLink.exitCode).toBe(1);
  expect(invalidLink.stderr).toContain("another Linux tool installation is active");
  expect(readlinkSync(lock)).toBe("incomplete");
});

test("rolls both managed links back when the second atomic replacement fails", async () => {
  const f = await fixture();
  const tools = join(f.dataHome, "pr-cockpit-tools");
  const bun = join(tools, "bin/bun");
  const gh = join(tools, "bin/gh");
  rmSync(bun);
  rmSync(gh);
  symlinkSync("../versions/bun-1.2.21/bun", bun);
  symlinkSync("../versions/gh-2.75.0/gh", gh);
  const failedOnce = join(f.root, "failed-once");
  executable(join(f.bin, "mv"), `if [[ "\${1:-}" == "-Tf" && "\${3:-}" == */gh && ! -e ${JSON.stringify(failedOnce)} ]]; then touch ${JSON.stringify(failedOnce)}; exit 1; fi; if [[ "\${1:-}" == "-T" || "\${1:-}" == "-Tn" || "\${1:-}" == "-Tf" ]]; then /bin/mv "$2" "$3"; else /bin/mv "$@"; fi`);
  const result = await runFixture(f);
  expect(result.exitCode).toBe(1);
  expect(readlinkSync(bun)).toBe("../versions/bun-1.2.21/bun");
  expect(readlinkSync(gh)).toBe("../versions/gh-2.75.0/gh");
});
