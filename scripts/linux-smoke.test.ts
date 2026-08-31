import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SMOKE_STATES, hasSandboxDisablingArgument, isFixtureUsername, isRendererCommand, parseSmokeArgs, prepareRuntimeRootForRemoval, serializePublicManifest } from "./linux-smoke";

const script = join(import.meta.dirname, "linux-smoke.ts");

describe("Linux installed-product smoke harness", () => {
  test("requires explicit absolute source and output roots", () => {
    expect(() => parseSmokeArgs([])).toThrow("usage:");
    expect(() => parseSmokeArgs(["--source", "candidate", "--output", "/proof"])).toThrow("must be absolute");
    expect(parseSmokeArgs(["--source", "/candidate", "--output", "/proof"])).toEqual({
      source: "/candidate",
      output: "/proof",
      printPlan: false,
    });
  });

  test("accepts either established fixture account spelling", () => {
    expect(isFixtureUsername("pr-cockpit-smoke")).toBe(true);
    expect(isFixtureUsername("prcockpit-smoke")).toBe(true);
    expect(isFixtureUsername("pr-cockpit-smoke-ci2")).toBe(true);
    expect(isFixtureUsername("prcockpit")).toBe(false);
    expect(isFixtureUsername("root")).toBe(false);
  });

  test("makes only the owned sealed runtime tree removable without following symlinks", () => {
    const temp = mkdtempSync(join(tmpdir(), "pr-cockpit-runtime-cleanup-"));
    const runtimeRoot = join(temp, "pr-cockpit-runtime");
    const nested = join(runtimeRoot, "release", "server");
    const sealedFile = join(nested, "main.ts");
    const target = join(temp, "symlink-target");
    const link = join(nested, "outside");
    try {
      mkdirSync(nested, { recursive: true });
      writeFileSync(sealedFile, "sealed");
      writeFileSync(target, "outside");
      chmodSync(sealedFile, 0o444);
      chmodSync(target, 0o640);
      symlinkSync(target, link);
      chmodSync(nested, 0o555);
      chmodSync(join(runtimeRoot, "release"), 0o555);
      chmodSync(runtimeRoot, 0o555);
      const targetMode = lstatSync(target).mode & 0o777;

      prepareRuntimeRootForRemoval(runtimeRoot, process.getuid!());
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("outside");
      expect(lstatSync(target).mode & 0o777).toBe(targetMode);

      rmSync(runtimeRoot, { recursive: true });
      expect(existsSync(runtimeRoot)).toBe(false);
      expect(readFileSync(target, "utf8")).toBe("outside");
      expect(lstatSync(target).mode & 0o777).toBe(targetMode);
    } finally {
      if (existsSync(runtimeRoot)) chmodSync(runtimeRoot, 0o700);
      if (existsSync(join(runtimeRoot, "release"))) chmodSync(join(runtimeRoot, "release"), 0o700);
      if (existsSync(nested)) chmodSync(nested, 0o700);
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("rejects missing, non-directory, symlink, and foreign-owned runtime roots", () => {
    const temp = mkdtempSync(join(tmpdir(), "pr-cockpit-runtime-gates-"));
    const file = join(temp, "file");
    const link = join(temp, "link");
    try {
      writeFileSync(file, "outside");
      symlinkSync(file, link);
      const uid = process.getuid!();
      expect(() => prepareRuntimeRootForRemoval(join(temp, "missing"), uid)).toThrow("runtime root is missing");
      expect(() => prepareRuntimeRootForRemoval(file, uid)).toThrow("runtime root must be a directory");
      expect(() => prepareRuntimeRootForRemoval(link, uid)).toThrow("runtime root must not be a symlink");
      expect(() => prepareRuntimeRootForRemoval(temp, uid + 1)).toThrow("runtime root belongs to foreign UID");
      expect(readFileSync(file, "utf8")).toBe("outside");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("prints the complete side-effect-free proof contract", () => {
    const result = Bun.spawnSync([
      process.execPath,
      script,
      "--source",
      "/candidate",
      "--output",
      "/proof",
      "--print-plan",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const plan = JSON.parse(result.stdout.toString());
    expect(plan).toMatchObject({
      version: 1,
      states: SMOKE_STATES,
      preflight: {
        fixtureAttestation: ["COCKPIT_SMOKE_FIXTURE_USER", "COCKPIT_SMOKE_FIXTURE_UID", "COCKPIT_SMOKE_FIXTURE_HOME"],
        realHome: true,
        defaultXdg: true,
        cleanRoots: true,
        authEnvironment: "allowlist",
      },
      transport: { candidateRemote: "shallow-local-bare", gitNetwork: "denied", credentials: "absent" },
      install: { repetitions: 2, artifactPaths: "complete", byteStable: true, autostart: "gio launch --hidden without protocol fields" },
      native: {
        X11: true,
        windowManager: "Openbox",
        trayHost: "stalonetray-XEmbed",
        trayInteraction: ["menu-Show", "Escape-close"],
        sandbox: "NoNewPrivs=1 Seccomp=2 no disabling argv",
        singletonProcessRecord: "tray=ready",
        shortcut: "non-viewable to IsViewable transition",
        protocol: ["cold", "warm-distinct-transition", "invalid-exact-preservation"],
        routeObservation: "renderer clipboard",
        integratedFrame: "zero extents",
        trayScreenshot: true,
      },
      lifecycle: {
        updatePayloads: ["B", "C"],
        priorOwnerExit: true,
        windowOwnerBinding: true,
        rollbackGate: "health",
        uninstallRepetitions: 2,
        protocolOwnerRestoration: "owned-foreign-byte-exact",
        preservedSentinels: ["data", "config", "checkout", "adjacent", "foreign-desktop-handler"],
      },
      cleanup: {
        ownership: ["uid", "pid", "start", "exe", "ancestry", "run-id"],
        service: ["manifest", "fragment", "pid", "cgroup"],
        escalation: ["TERM", "bounded wait", "KILL"],
        final: ["all teardown gates before roots", "retry on error", "tray host and icon gone", "empty cgroup", "removed X socket", "owned roots only", "partial output removed"],
      },
      fixture: { port: 14820, repo: "rust-lang/rust", pr: 160859 },
      display: { width: 1600, height: 1200 },
      manifest: { deterministic: true, absolutePaths: false, secrets: false, timestamps: false, screenshots: ["main", "palette", "pr-files", "settings", "tray"] },
    });
  });

  test("serializes deterministic public metadata and rejects paths, secrets, and timestamps", () => {
    const manifest = { candidateCommit: "abc", capture: { width: 1600, height: 1200 }, screenshots: [{ file: "main.png", sha256: "def" }] };
    expect(serializePublicManifest(manifest, ["/private/source", "fixture-secret"])).toBe(`${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => serializePublicManifest({ source: "/home/fixture/source" }, [])).toThrow("absolute path");
    expect(() => serializePublicManifest({ value: "fixture-secret" }, ["fixture-secret"])).toThrow("private value");
    expect(() => serializePublicManifest({ generatedAt: "2026-01-01" }, [])).toThrow("nondeterministic field");
  });

  test("rejects unknown flags instead of silently weakening proof", () => {
    expect(() => parseSmokeArgs(["--source", "/candidate", "--output", "/proof", "--browser-only"]))
      .toThrow("unknown argument: --browser-only");
  });

  test("recognizes Chromium options in both split and rewritten argv", () => {
    expect(isRendererCommand(["electron", "--type=renderer", "--enable-sandbox"])).toBe(true);
    expect(isRendererCommand(["electron --type=renderer --enable-sandbox"])).toBe(true);
    expect(isRendererCommand(["electron", "--type=renderer-helper"])).toBe(false);
    expect(hasSandboxDisablingArgument(["electron", "--no-sandbox"])).toBe(true);
    expect(hasSandboxDisablingArgument(["electron --disable-seccomp-filter-sandbox --type=renderer"])).toBe(true);
    expect(hasSandboxDisablingArgument(["electron", "--no-sandboxed"])).toBe(false);
  });
});
