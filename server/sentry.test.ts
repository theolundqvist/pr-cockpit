import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sentryEnvironment } from "./sentry.ts";

test("Sentry separates managed, development, and test processes", () => {
  const supervisor = Bun.env.COCKPIT_SUPERVISOR;
  const nodeEnv = Bun.env.NODE_ENV;
  const mock = Bun.env.COCKPIT_MOCK;
  try {
    delete Bun.env.COCKPIT_SUPERVISOR;
    delete Bun.env.NODE_ENV;
    delete Bun.env.COCKPIT_MOCK;
    expect(sentryEnvironment()).toBe("development");

    Bun.env.COCKPIT_SUPERVISOR = "launchd";
    expect(sentryEnvironment()).toBe("production");

    Bun.env.NODE_ENV = "test";
    expect(sentryEnvironment()).toBe("test");
  } finally {
    if (supervisor === undefined) delete Bun.env.COCKPIT_SUPERVISOR;
    else Bun.env.COCKPIT_SUPERVISOR = supervisor;
    if (nodeEnv === undefined) delete Bun.env.NODE_ENV;
    else Bun.env.NODE_ENV = nodeEnv;
    if (mock === undefined) delete Bun.env.COCKPIT_MOCK;
    else Bun.env.COCKPIT_MOCK = mock;
  }
});

test("error reports stay unsent until the setting turns them on, and stop when it turns them off", async () => {
  const root = mkdtempSync(join(tmpdir(), "pr-cockpit-sentry-"));
  const moduleUrl = (name: string) => JSON.stringify(new URL(`./${name}.ts`, import.meta.url).href);
  const script = `
    const received = [];
    const ingest = Bun.serve({ port: 0, async fetch(request) {
      received.push({ path: new URL(request.url).pathname, body: await request.text() });
      return new Response("{}");
    } });
    process.env.COCKPIT_SENTRY_DSN = "http://public@127.0.0.1:" + ingest.port + "/42";
    const sentry = await import(${moduleUrl("sentry")});
    const { buildFetchHandler } = await import(${moduleUrl("http")});
    const handler = buildFetchHandler(4820);
    const save = async (enabled) => (await (await handler(new Request("http://127.0.0.1:4820/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error_reports: enabled }),
    }))).json()).error_reports;
    const report = async (label) => {
      const start = received.length;
      sentry.captureError(new Error(label + " error"), "test");
      await sentry.captureFatal(new Error(label + " fatal"));
      await Bun.sleep(200);
      return received.slice(start).map(({ path, body }) => ({ path, labels: body.match(/\\b(?:default|enabled|disabled) (?:error|fatal)\\b/g) }));
    };
    sentry.startSentry();
    const byDefault = await report("default");
    const savedOn = await save(true);
    const enabled = await report("enabled");
    const savedOff = await save(false);
    const disabled = await report("disabled");
    ingest.stop(true);
    console.log(JSON.stringify({ byDefault, savedOn, enabled, savedOff, disabled }));
    process.exit(0);
  `;
  try {
    const env: Record<string, string | undefined> = { ...Bun.env, COCKPIT_DATA_DIR: join(root, "data"), COCKPIT_REPOS: "" };
    for (const key of ["COCKPIT_MOCK", "COCKPIT_PROXY", "COCKPIT_REPLICA_SSH_HOST", "COCKPIT_REPLICA_OVERRIDE"]) delete env[key];
    const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], { env, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(result.byDefault).toEqual([]);
    expect(result.savedOn).toBe(true);
    expect(result.enabled.map((request: { labels: string[] | null }) => request.labels?.[0]).sort()).toEqual(["enabled error", "enabled fatal"]);
    expect(result.enabled.every((request: { path: string }) => request.path === "/api/42/envelope/")).toBe(true);
    expect(result.savedOff).toBe(false);
    expect(result.disabled).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
