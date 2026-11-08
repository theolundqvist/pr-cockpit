import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { startCockpitServer } from "./cockpitServer.ts";
import { recordProfile } from "./profile.ts";

// The native CPU sampler needs real elapsed time; fake timers cannot produce CPU samples.
test("profiles live requests and restores all inactive hooks", async () => {
  const db = new Database(":memory:");
  const statement = db.query("SELECT 42 AS value");
  const originalGet = Object.getPrototypeOf(statement.native).get;
  const originalFetch = globalThis.fetch;
  const originalSpawn = Bun.spawn;
  const originalSpawnSync = Bun.spawnSync;
  const server = startCockpitServer(0, () => {
    statement.get();
    Bun.spawnSync(["true"]);
    return Response.json({ value: 42 });
  });
  const origin = `http://127.0.0.1:${server.port}`;
  let directory: string | undefined;
  try {
    expect(globalThis.fetch).toBe(originalFetch);
    expect(Bun.spawn).toBe(originalSpawn);
    expect(Object.getPrototypeOf(statement.native).get).toBe(originalGet);
    expect((await fetch(`${origin}/api/debug/profile`, { method: "POST", headers: { origin: "https://example.com" } })).status).toBe(403);
    expect((await fetch(`${origin}/api/debug/profile?seconds=121`, { method: "POST" })).status).toBe(400);
    const recording = fetch(`${origin}/api/debug/profile?seconds=1`, { method: "POST" });
    while (globalThis.fetch === originalFetch) await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await fetch(`${origin}/api/debug/profile?seconds=1`, { method: "POST" })).status).toBe(400);
    for (let i = 0; i < 5; i++) await fetch(`${origin}/api/test`);
    const response = await recording;
    expect(response.status).toBe(200);
    const result = await response.json();
    directory = result.directory;
    const summary = await Bun.file(join(result.directory, "summary.json")).json();
    expect(summary.routes.find((route: { route: string }) => route.route === "GET /api/test").count).toBe(5);
    expect(summary.sqlite.some((query: { sql: string; count: number }) => query.sql.includes("SELECT 42") && query.count === 5)).toBe(true);
    expect(summary.eventLoopLag.samples.length).toBeGreaterThan(0);
    expect(summary.children.filter((child: { command: string }) => child.command === "true").length).toBe(5);
    const profile = await Bun.file(join(result.directory, "server.cpuprofile")).json();
    expect(profile.nodes.length).toBeGreaterThan(1);
    expect(profile.samples.length).toBeGreaterThan(0);
    expect(profile.samples.length).toBe(profile.timeDeltas.length);
    expect(globalThis.fetch).toBe(originalFetch);
    expect(Bun.spawn).toBe(originalSpawn);
    expect(Bun.spawnSync).toBe(originalSpawnSync);
    expect(Object.getPrototypeOf(statement.native).get).toBe(originalGet);
    await fetch(`${origin}/api/test`);
  } finally {
    server.stop(true);
    db.close();
    if (directory) rmSync(directory, { recursive: true });
  }
});

test("includes unfinished GitHub requests and subprocess elapsed durations", async () => {
  const originalFetch = globalThis.fetch;
  const pending = Promise.withResolvers<Response>();
  const fakeFetch = Object.assign(() => pending.promise, originalFetch);
  globalThis.fetch = fakeFetch;
  let directory: string | undefined;
  let child: Bun.Subprocess | undefined;
  try {
    const recording = recordProfile(1, () => new Response(), () => {});
    while (globalThis.fetch === fakeFetch) await new Promise<void>((resolve) => setImmediate(resolve));
    const request = fetch("https://api.github.com/zen");
    child = Bun.spawn(["cat"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    const result = await recording;
    directory = result.directory;
    const summary = await Bun.file(join(result.directory, "summary.json")).json();
    expect(summary.github.count).toBe(1);
    expect(summary.github.requests[0].running).toBe(true);
    expect(summary.github.requests[0].ms).toBeGreaterThan(0);
    expect(summary.children[0].command).toBe("cat");
    expect(summary.children[0].running).toBe(true);
    expect(summary.children[0].ms).toBeGreaterThan(0);
    pending.resolve(new Response());
    await request;
    expect(globalThis.fetch).toBe(fakeFetch);
  } finally {
    pending.resolve(new Response());
    child?.kill();
    globalThis.fetch = originalFetch;
    if (directory) rmSync(directory, { recursive: true });
  }
});
