import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RELAY = "http://127.0.0.1:9";
const REVISION = "0123456789abcdef0123456789abcdef01234567";
const moduleUrl = (name: string) => JSON.stringify(new URL(`./${name}.ts`, import.meta.url).href);
const PLATFORM = process.platform === "darwin" || process.platform === "linux" ? process.platform : "other";

// Each scenario is its own process: the database path, environment switches, and queue are per process.
async function scenario(
  body: string,
  options: { env?: Record<string, string>; installRef?: string } = {},
): Promise<any> {
  const root = mkdtempSync(join(tmpdir(), "pr-cockpit-usage-"));
  const env: Record<string, string | undefined> = {
    ...Bun.env,
    COCKPIT_DATA_DIR: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    COCKPIT_RELAY_URL: RELAY,
    COCKPIT_RELEASE_REVISION: REVISION,
    COCKPIT_REPOS: "",
  };
  for (const key of ["COCKPIT_USAGE_STATS", "DO_NOT_TRACK", "COCKPIT_MOCK", "COCKPIT_PROXY", "COCKPIT_REPLICA_SSH_HOST", "COCKPIT_REPLICA_OVERRIDE"]) {
    delete env[key];
  }
  Object.assign(env, options.env);
  if (options.installRef !== undefined) {
    mkdirSync(join(root, "config", "pr-cockpit"), { recursive: true });
    writeFileSync(join(root, "config", "pr-cockpit", "install-ref"), options.installRef);
  }
  const script = `
    const db = await import(${moduleUrl("db")});
    const settings = await import(${moduleUrl("settings")});
    const usage = await import(${moduleUrl("usageStats")});
    const posts = [];
    const ok = () => new Response(null, { status: 204 });
    let respond = ok;
    const fetcher = async (url, init) => {
      posts.push({ url: String(url), method: init.method, headers: init.headers, body: JSON.parse(init.body), timeout: init.signal instanceof AbortSignal });
      return respond();
    };
    const flushed = async () => {
      const start = posts.length;
      await usage.flushUsageStats(fetcher);
      return posts.slice(start);
    };
    const events = (sent) => sent.flatMap((post) => post.body.events).map(({ at, ...event }) => {
      if (typeof at !== "number" || at <= 0) throw new Error("event without a timestamp");
      return event;
    });
    ${body}
  `;
  try {
    const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], { env, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr);
    return JSON.parse(stdout.trim().split("\n").at(-1)!);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("statistics stay off and keep nothing when forced off, turned off, mocked, replicated, or without a relay", async () => {
  const probe = `
    usage.startUsageStats();
    usage.trackStep("launch");
    usage.trackCli("listen", true);
    const accepted = usage.trackUiBatch("tab-1", "electron", [{ at: Date.now(), kind: "screen", action: "inbox" }]);
    usage.trackGithubAuth("ready");
    const sent = await flushed();
    const current = settings.readSettings();
    console.log(JSON.stringify({
      enabled: usage.usageStatsEnabled(),
      accepted,
      posts: sent.length,
      firstLaunch: db.getSetting("usage_first_launch_at"),
      signedIn: db.getSetting("usage_signed_in_at"),
      usageStats: current.usage_stats,
      forcedOff: current.usage_stats_forced_off,
    }));
  `;
  const [forced, falseFlag, doNotTrack, mock, replica, noRelay, settingOff] = await Promise.all([
    scenario(probe, { env: { COCKPIT_USAGE_STATS: "0" } }),
    scenario(probe, { env: { COCKPIT_USAGE_STATS: "False" } }),
    scenario(probe, { env: { DO_NOT_TRACK: "1" } }),
    scenario(probe, { env: { COCKPIT_MOCK: "1" } }),
    scenario(probe, { env: { COCKPIT_REPLICA_SSH_HOST: "build-server" } }),
    scenario(probe, { env: { COCKPIT_RELAY_URL: "" } }),
    scenario(`settings.writeSettings({ usage_stats: false });\n${probe}`),
  ]);
  const off = { enabled: false, accepted: true, posts: 0, firstLaunch: null, signedIn: null };
  expect(forced).toEqual({ ...off, usageStats: true, forcedOff: true });
  expect(falseFlag).toEqual({ ...off, usageStats: true, forcedOff: true });
  expect(doNotTrack).toEqual({ ...off, usageStats: true, forcedOff: true });
  expect(mock).toEqual({ ...off, usageStats: true, forcedOff: false });
  expect(replica).toEqual({ ...off, usageStats: true, forcedOff: false });
  expect(noRelay).toEqual({ ...off, usageStats: true, forcedOff: false });
  expect(settingOff).toEqual({ ...off, usageStats: false, forcedOff: false });
}, 30_000);

test("turning statistics off discards the queue", async () => {
  const result = await scenario(`
    usage.trackStep("launch");
    settings.writeSettings({ usage_stats: false });
    usage.applyUsageStatsSetting();
    const stored = db.getSetting("usage_stats");
    settings.writeSettings({ usage_stats: true });
    usage.applyUsageStatsSetting();
    console.log(JSON.stringify({ stored, restored: db.getSetting("usage_stats"), posts: (await flushed()).length }));
  `);
  expect(result).toEqual({ stored: "off", restored: "on", posts: 0 });
});

test("first launch distinguishes new installs from installs that predate statistics", async () => {
  const fresh = await scenario(`
    usage.startUsageStats();
    usage.startUsageStats();
    usage.trackGithubAuth("missing-auth");
    usage.trackGithubAuth("missing-auth");
    usage.trackGithubAuth("ready");
    usage.trackGithubAuth("ready");
    settings.writeSettings({ repos: "owner/repo" });
    usage.trackReposConfigured();
    usage.trackReposConfigured();
    console.log(JSON.stringify(events(await flushed())));
  `);
  expect(fresh).toEqual([
    { kind: "step", action: "first-launch", value: "new" },
    { kind: "step", action: "launch" },
    { kind: "step", action: "launch" },
    { kind: "step", action: "auth", value: "missing-auth" },
    { kind: "step", action: "signed-in" },
    { kind: "step", action: "repos-configured" },
  ]);

  const existing = await scenario(`
    db.setSetting("relay_install_id", "install-existing");
    settings.writeSettings({ repos: "owner/repo" });
    usage.startUsageStats();
    usage.trackGithubAuth("ready");
    usage.trackReposConfigured();
    const sent = await flushed();
    console.log(JSON.stringify({ events: events(sent), install: sent[0].body.install }));
  `);
  expect(existing).toEqual({
    events: [
      { kind: "step", action: "first-launch", value: "existing" },
      { kind: "step", action: "launch" },
    ],
    install: "install-existing",
  });
});

test("the queue keeps the newest 2000 events and posts at most 200 events and 64 KiB at a time", async () => {
  const result = await scenario(`
    for (let index = 0; index < 2100; index++) usage.trackStep("step-" + index);
    const capped = await flushed();
    const long = (letter) => letter.repeat(64);
    for (let batch = 0; batch < 4; batch++) {
      usage.trackUiBatch("s".repeat(64), "electron", Array.from({ length: 50 }, () => ({
        at: Date.now(), kind: "screen", screen: long("a"), action: long("b"), value: long("c"),
      })));
    }
    const large = await flushed();
    const sent = events(capped);
    console.log(JSON.stringify({
      sizes: capped.map((post) => post.body.events.length),
      first: sent[0].action,
      last: sent.at(-1).action,
      largeSizes: large.map((post) => post.body.events.length),
      largeBytes: large.map((post) => JSON.stringify(post.body).length),
    }));
  `);
  expect(result.sizes).toEqual(Array(10).fill(200));
  expect(result.first).toBe("step-100");
  expect(result.last).toBe("step-2099");
  expect(result.largeSizes.reduce((sum: number, size: number) => sum + size, 0)).toBe(200);
  expect(result.largeSizes.length).toBeGreaterThan(1);
  for (const bytes of result.largeBytes) expect(bytes).toBeLessThanOrEqual(64 * 1024);
});

test("batches name the relay install, the install-script run, the short version, and the platform", async () => {
  const result = await scenario(`
    usage.trackStep("pr-opened");
    const [post] = await flushed();
    console.log(JSON.stringify({ post, install: db.getSetting("relay_install_id") }));
  `, { installRef: "run-abc-123\n" });
  expect(result.install).toMatch(/^[0-9a-f-]{36}$/);
  expect(result.post).toMatchObject({
    url: `${RELAY}/events`,
    method: "POST",
    headers: { "content-type": "application/json" },
    timeout: true,
  });
  expect(result.post.body).toEqual({
    install: result.install,
    ref: "run-abc-123",
    surface: "app",
    version: "0123456",
    platform: PLATFORM,
    events: [{ at: expect.any(Number), kind: "step", action: "pr-opened" }],
  });

  const invalidRef = await scenario(`
    usage.trackStep("launch");
    console.log(JSON.stringify((await flushed())[0].body));
  `, { installRef: "../not an id" });
  expect(invalidRef.ref).toBeUndefined();
});

test("failed deliveries keep events for retry, and rejected batches are dropped", async () => {
  const result = await scenario(`
    usage.trackStep("launch");
    respond = () => new Response("unavailable", { status: 503 });
    const unavailable = (await flushed()).length;
    respond = () => { throw new Error("offline"); };
    const offline = (await flushed()).length;
    usage.trackStep("auth-setup", "login");
    respond = ok;
    const delivered = events(await flushed());
    const afterDelivery = (await flushed()).length;
    usage.trackStep("launch");
    respond = () => new Response("invalid", { status: 400 });
    await flushed();
    respond = ok;
    console.log(JSON.stringify({ unavailable, offline, delivered, afterDelivery, afterReject: (await flushed()).length }));
  `);
  expect(result).toEqual({
    unavailable: 1,
    offline: 1,
    delivered: [
      { kind: "step", action: "launch" },
      { kind: "step", action: "auth-setup", value: "login" },
    ],
    afterDelivery: 0,
    afterReject: 0,
  });
});

test("invalid names, ids, kinds, and batches are dropped", async () => {
  const result = await scenario(`
    const now = Date.now();
    usage.trackStep("Launch");
    usage.trackStep("launch", "Has Space");
    usage.trackStep("x".repeat(65));
    usage.trackStep("launch", undefined, { session: "not an id" });
    usage.trackCli("Merge", true);
    const batches = {
      badSession: usage.trackUiBatch("not an id", "electron", []),
      badClient: usage.trackUiBatch("tab-1", "cli", []),
      tooMany: usage.trackUiBatch("tab-1", "browser", Array.from({ length: 51 }, () => ({ at: now, kind: "ui", action: "x" }))),
      notArray: usage.trackUiBatch("tab-1", "browser", "events"),
      mixed: usage.trackUiBatch("tab-1", "browser", [
        { at: now, kind: "ui", action: "open-pr", value: "typed" },
        { at: now, kind: "cli", action: "merge" },
        { at: now, kind: "constructor", action: "x" },
        { at: now, kind: "ui", action: "Fix the login page" },
        { at: now, kind: "screen", action: "detail", screen: "Detail" },
        { kind: "key", action: "m" },
        { at: now, kind: "key", action: "shift+m", label: "dropped" },
      ]),
    };
    usage.trackStep("launch");
    console.log(JSON.stringify({ batches, sent: events(await flushed()) }));
  `);
  expect(result.batches).toEqual({ badSession: false, badClient: false, tooMany: false, notArray: false, mixed: true });
  expect(result.sent).toEqual([
    { session: "tab-1", kind: "ui", action: "open-pr", value: "typed", client: "browser" },
    { session: "tab-1", kind: "key", action: "shift+m", client: "browser" },
    { kind: "step", action: "launch" },
  ]);
});

test("/api/usage accepts UI batches, validates them, and keeps nothing once turned off", async () => {
  const result = await scenario(`
    const { buildFetchHandler } = await import(${moduleUrl("http")});
    const handler = buildFetchHandler(4820);
    const now = Date.now();
    const post = (body) => handler(new Request("http://127.0.0.1:4820/api/usage", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }));
    const statuses = {
      ok: (await post({ session: "tab-1", client: "electron", events: [
        { at: now, kind: "screen", action: "detail/files" },
        { at: now, kind: "ui", action: "Bad Label" },
      ] })).status,
      invalidJson: (await post("{")).status,
      badSession: (await post({ session: "", client: "electron", events: [] })).status,
      badClient: (await post({ session: "tab-1", client: "server", events: [] })).status,
      tooMany: (await post({ session: "tab-1", client: "electron", events: Array.from({ length: 51 }, () => ({ at: now, kind: "ui", action: "x" })) })).status,
      tooLarge: (await post({ session: "tab-1", client: "electron", events: [], pad: "x".repeat(33 * 1024) })).status,
    };
    const sent = events(await flushed());
    const put = await handler(new Request("http://127.0.0.1:4820/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usage_stats: false }),
    }));
    const saved = await put.json();
    const offStatus = (await post({ session: "tab-1", client: "electron", events: [{ at: now, kind: "screen", action: "inbox" }] })).status;
    console.log(JSON.stringify({
      statuses,
      sent,
      saved: { usage_stats: saved.usage_stats, usage_stats_forced_off: saved.usage_stats_forced_off },
      offStatus,
      offPosts: (await flushed()).length,
    }));
  `);
  expect(result.statuses).toEqual({ ok: 204, invalidJson: 400, badSession: 400, badClient: 400, tooMany: 400, tooLarge: 413 });
  expect(result.sent).toEqual([{ session: "tab-1", kind: "screen", action: "detail/files", client: "electron" }]);
  expect(result.saved).toEqual({ usage_stats: false, usage_stats_forced_off: false });
  expect(result.offStatus).toBe(204);
  expect(result.offPosts).toBe(0);
}, 30_000);

test("CLI requests count once per run and outcome, and older CLIs by route shape", async () => {
  const result = await scenario(`
    const { buildFetchHandler } = await import(${moduleUrl("http")});
    const handler = buildFetchHandler(4820);
    const request = (path, headers = {}, method = "GET") => handler(new Request("http://127.0.0.1:4820" + path, { method, headers }));
    const run = { "x-pr-cockpit-command": "status", "x-pr-cockpit-session": "0a1b2c3d4e5f6071" };
    await request("/healthz", run);
    await request("/healthz", run);
    await request("/api/not-a-route", run);
    await request("/healthz", { "x-pr-cockpit-command": "listen" });
    await request("/healthz", { "x-pr-cockpit-command": "listen" });
    await request("/healthz", { "x-pr-cockpit-command": "Bad Command" });
    await request("/healthz");
    await request("/api/agent/pr/owner/repo/17/mutations", {}, "POST");
    await request("/api/agent/repo/diff/jobs/runs", {}, "POST");
    console.log(JSON.stringify(events(await flushed())));
  `);
  expect(result).toEqual([
    { session: "0a1b2c3d4e5f6071", kind: "cli", action: "status", value: "ok", client: "cli" },
    { session: "0a1b2c3d4e5f6071", kind: "cli", action: "status", value: "failed", client: "cli" },
    { kind: "cli", action: "listen", value: "ok", client: "cli" },
    { kind: "cli", action: "listen", value: "ok", client: "cli" },
    { kind: "cli", action: "post:pr/mutations", value: "failed", client: "cli" },
    { kind: "cli", action: "post:repo/runs", value: "failed", client: "cli" },
  ]);
}, 30_000);

test("processed mutations report their kind, outcome, and CLI origin", async () => {
  const result = await scenario(`
    const mutations = await import(${moduleUrl("mutations")});
    const repo = "fixture/cockpit";
    const insert = (number, payload) => {
      const id = db.insertMutation({ repo, number, kind: payload.kind, payload_json: JSON.stringify(payload), created_at: new Date().toISOString() });
      return db.listMutationsForPr(repo, number).find((row) => row.id === id);
    };
    const dependencies = (executeMutation) => ({
      executeMutation,
      refreshPr: async () => {},
      pollOnce: async () => {},
      deleteMutation: db.deleteMutation,
      setMutationRefreshing: db.setMutationRefreshing,
      setMutationState: db.setMutationState,
      scheduleRecovery: () => {},
    });
    await mutations.processMutation(insert(1, { kind: "update-branch" }), dependencies(async () => false));
    await mutations.processMutation(insert(2, { kind: "update-branch" }), dependencies(async () => { throw new Error("GitHub refused"); }));
    // An uncached PR fails before reaching GitHub.
    mutations.enqueueMutation({ repo, number: 3, payload: { kind: "convert-to-draft" }, cli: true });
    // The queue worker runs detached; yield event-loop turns until it settles the row.
    for (let turn = 0; turn < 1000 && db.listMutationsForPr(repo, 3)[0]?.state !== "failed"; turn++) {
      const { promise, resolve } = Promise.withResolvers();
      setImmediate(resolve);
      await promise;
    }
    console.log(JSON.stringify(events(await flushed())));
  `);
  expect(result).toEqual([
    { kind: "step", action: "mutation:update-branch", value: "ok" },
    { kind: "step", action: "mutation:update-branch", value: "failed" },
    { kind: "step", action: "mutation:convert-to-draft", value: "failed", client: "cli" },
  ]);
}, 30_000);
