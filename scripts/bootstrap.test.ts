import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bootstrapPath = join(import.meta.dir, "bootstrap");
const expectBootstrap = `set timeout 10
spawn -noecho [lindex $argv 0]
set reply [lindex $argv 1]
if {$reply ne ""} {
  send -- "$reply\\r"
}
expect eof
exit [lindex [wait] 3]`;
const instructionBlock = `<!-- pr-cockpit-agent-instructions -->
## PR Cockpit
For pull-request reads, use \`pr-cockpit owner/repo#N\` instead of \`gh pr view\`, \`gh api\`, or direct GitHub API reads. Use \`--json\` only for automation, \`--diff\` for the cached diff, and \`--file PATH\` for a file at the PR head. Whenever progress depends on CI, reviews, comments, or PR state changing, always run \`pr-cockpit listen owner/repo#N\`; never sleep, poll, use a harness pause, or wait any other way. Resolve settled review threads with \`pr-cockpit resolve owner/repo#N HANDLE\`.
<!-- /pr-cockpit-agent-instructions -->`;

function executable(path: string, body: string) {
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
}

function stubbedPath(dir: string, platform: "Darwin" | "Linux" = "Darwin", ghExit = 0, gitVersion = "2.39.5") {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  executable(join(bin, "uname"), `if [[ "\${1:-}" == "-m" ]]; then printf "x86_64\\n"; else printf "${platform}\\n"; fi`);
  executable(
    join(bin, "git"),
    `if [[ "\${1:-}" == "--version" ]]; then
  printf "git version ${gitVersion}\\n"
elif [[ "\${1:-}" == "-C" && "\${3:-}" == "rev-parse" ]]; then
  cd "$2" && pwd -P
elif [[ "\${1:-}" == "-C" && "\${3:-}" == "remote" ]]; then
  printf "https://github.com/theolundqvist/pr-cockpit.git\\n"
fi`,
  );
  executable(join(bin, "bun"), "exit 0");
  executable(join(bin, "gh"), `exit ${ghExit}`);
  executable(join(bin, "curl"), "exit 0");
  executable(join(bin, "systemctl"), "exit 0");
  executable(join(bin, "xdg-mime"), "exit 0");
  executable(join(bin, "tar"), "exit 0");
  executable(join(bin, "unzip"), "exit 0");
  executable(join(bin, "sha256sum"), "cat >/dev/null");
  executable(join(bin, "realpath"), `[[ "\${1:-}" == "-m" ]] && printf '%s\n' "$2" || printf '%s\n' "$1"`);
  return `${bin}:/usr/bin:/bin`;
}

function installedFixture(installExit = 0) {
  const root = mkdtempSync(join(tmpdir(), "cockpit-bootstrap-"));
  const home = join(root, "home");
  const target = join(root, "checkout");
  const instructions = join(home, ".config", "AGENTS.md");
  mkdirSync(join(target, "scripts"), { recursive: true });
  mkdirSync(join(home, ".config"), { recursive: true });
  writeFileSync(instructions, "# Existing instructions\n");
  executable(join(target, "scripts", "update-pull"), "exit 0");
  executable(
    join(target, "scripts", "install"),
    `printf "PR Cockpit is ready\\n"
exit ${installExit}`,
  );
  return { root, home, target, instructions, path: stubbedPath(root) };
}

async function runBootstrap({
  home,
  target,
  path,
  input = "",
  interactive = false,
  noColor = false,
  dryRun = false,
  env = {},
}: {
  home: string;
  target: string;
  path: string;
  input?: string;
  interactive?: boolean;
  noColor?: boolean;
  dryRun?: boolean;
  env?: Record<string, string>;
}) {
  const expectPath = join(home, "bootstrap.expect");
  if (interactive) {
    writeFileSync(expectPath, expectBootstrap);
  }
  const command = interactive
    ? ["/usr/bin/expect", expectPath, bootstrapPath, input.trim()]
    : [bootstrapPath];
  const bootstrap = Bun.spawn(command, {
    env: {
      PATH: path,
      HOME: home,
      COCKPIT_HOME: target,
      COCKPIT_BOOTSTRAP_DRY_RUN: dryRun ? "1" : "0",
      TERM: "xterm-256color",
      ...(noColor ? { NO_COLOR: "1" } : {}),
      ...env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [output, error, exitCode] = await Promise.all([
    new Response(bootstrap.stdout).text(),
    new Response(bootstrap.stderr).text(),
    bootstrap.exited,
  ]);
  return { output, error, exitCode };
}

test("Linux bootstrap accepts an installed but unauthenticated gh binary", async () => {
  const root = mkdtempSync(join(tmpdir(), "cockpit-bootstrap-linux-"));
  const home = join(root, "home");
  try {
    const result = await runBootstrap({
      home,
      target: join(root, "checkout"),
      path: stubbedPath(root, "Linux", 1),
      dryRun: true,
    });
    expect(result.error).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("[3/3] Install PR Cockpit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap names the Git 2.38 prerequisite before preparing a checkout", async () => {
  const root = mkdtempSync(join(tmpdir(), "cockpit-bootstrap-old-git-"));
  const home = join(root, "home");
  try {
    const result = await runBootstrap({
      home,
      target: join(root, "checkout"),
      path: stubbedPath(root, "Linux", 0, "2.34.1"),
      dryRun: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("Git 2.38 or newer is required (found git version 2.34.1)");
    expect(result.output).not.toContain("Prepare checkout");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("a non-interactive install stays plain and skips the optional follow-up", async () => {
  const root = mkdtempSync(join(tmpdir(), "cockpit-bootstrap-"));
  const home = join(root, "home");
  try {
    const result = await runBootstrap({
      home,
      target: join(root, "checkout"),
      path: stubbedPath(root),
      dryRun: true,
    });
    expect(result.error).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Welcome to PR Cockpit");
    expect(result.output).toContain("[3/3] Install PR Cockpit");
    expect(result.output).toContain("ready  Installation complete");
    expect(result.output).not.toContain("\u001b[");
    expect(result.output).not.toContain("Optional follow-up");
    expect(result.output).not.toContain("Teach assistants");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a successful interactive install offers teaching only after installation", async () => {
  const fixture = installedFixture();
  try {
    const result = await runBootstrap({
      ...fixture,
      input: "n\n",
      interactive: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("\u001b[36m");
    expect(result.output).toContain("\u001b[32m");
    const installStage = result.output.indexOf("[3/3]");
    const ready = result.output.indexOf("PR Cockpit is ready");
    const followUp = result.output.indexOf("Optional follow-up");
    const prompt = result.output.indexOf(
      "Teach assistants to use pr-cockpit instead of gh for pull-request reads?",
    );
    expect(installStage).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(installStage);
    expect(followUp).toBeGreaterThan(ready);
    expect(prompt).toBeGreaterThan(followUp);
    expect(readFileSync(fixture.instructions, "utf8")).toBe("# Existing instructions\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("accepted teaching instructions are inserted once", async () => {
  const fixture = installedFixture();
  try {
    const accepted = await runBootstrap({
      ...fixture,
      input: "y\n",
      interactive: true,
    });
    expect(accepted.exitCode).toBe(0);
    expect(accepted.output).toContain("added assistant instructions");
    expect(readFileSync(fixture.instructions, "utf8")).toBe(
      `# Existing instructions\n\n${instructionBlock}\n`,
    );

    const rerun = await runBootstrap({
      ...fixture,
      interactive: true,
      noColor: true,
    });
    expect(rerun.exitCode).toBe(0);
    expect(rerun.output).not.toContain("\u001b[");
    expect(rerun.output).not.toContain("Teach assistants");
    expect(readFileSync(fixture.instructions, "utf8")).toBe(
      `# Existing instructions\n\n${instructionBlock}\n`,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a failed install never offers or writes teaching instructions", async () => {
  const fixture = installedFixture(1);
  try {
    const result = await runBootstrap({
      ...fixture,
      input: "y\n",
      interactive: true,
    });
    expect(result.output).toContain("installer failed");
    expect(result.output).not.toContain("Optional follow-up");
    expect(result.output).not.toContain("Teach assistants");
    expect(readFileSync(fixture.instructions, "utf8")).toBe("# Existing instructions\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

/** The fixture's curl, swapped for one that logs each call's arguments, a line per call. */
function recordCurl(root: string) {
  const log = join(root, "curl.log");
  executable(join(root, "bin", "curl"), `printf '%s\\n' "$*" >>"${log}"`);
  return log;
}

/** Each logged report's JSON body; the script waits for its background reports before it exits. */
const reports = (log: string) =>
  existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").map((call) => ({ call, body: JSON.parse(call.match(/--data (\{.*\}) https:/)![1]!) }))
    : [];

test("an install reports its start and finish under one run id, which it leaves for the app's first launch", async () => {
  const fixture = installedFixture();
  const log = recordCurl(fixture.root);
  try {
    const result = await runBootstrap(fixture);
    expect(result.exitCode).toBe(0);
    const sent = reports(log);
    expect(sent.map(({ call }) => call.endsWith(" https://relay.prcockpit.com/events"))).toEqual([true, true]);
    expect(sent.map(({ body }) => body.events[0].action).sort()).toEqual(["script-done", "script-start"]);
    const run = sent[0]!.body.anon;
    expect(run).toMatch(/^[A-Za-z0-9-]{1,64}$/);
    expect(sent[1]!.body.anon).toBe(run);
    expect(sent[0]!.body).toMatchObject({ surface: "script", platform: "darwin" });
    expect(readFileSync(join(fixture.home, ".config", "pr-cockpit", "install-ref"), "utf8")).toBe(`${run}\n`);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a failed install reports the stage it failed in", async () => {
  const fixture = installedFixture(1);
  const log = recordCurl(fixture.root);
  try {
    const result = await runBootstrap(fixture);
    expect(result.exitCode).toBe(1);
    const events = reports(log).map(({ body }) => body.events[0]);
    expect(events).toContainEqual(expect.objectContaining({ action: "script-start" }));
    expect(events).toContainEqual(expect.objectContaining({ action: "script-failed", value: "install" }));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("DO_NOT_TRACK and COCKPIT_USAGE_STATS=0 install without reporting or leaving a run id", async () => {
  for (const env of [{ DO_NOT_TRACK: "1" }, { COCKPIT_USAGE_STATS: "0" }]) {
    const fixture = installedFixture();
    const log = recordCurl(fixture.root);
    try {
      const result = await runBootstrap({ ...fixture, env });
      expect(result.exitCode).toBe(0);
      expect(existsSync(log)).toBe(false);
      expect(existsSync(join(fixture.home, ".config", "pr-cockpit", "install-ref"))).toBe(false);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});
