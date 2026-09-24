import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const relayClientUrl = new URL("./relayClient.ts", import.meta.url).href;
const dbUrl = new URL("./db.ts", import.meta.url).href;

test("relay cursor survives restart and acknowledges only handled markers", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-relay-cursor-"));
  try {
    const script = `
      const { pollRelayOnce } = await import(${JSON.stringify(relayClientUrl)});
      const { db, getSetting, setSetting } = await import(${JSON.stringify(dbUrl)});
      const run = (id) => ({ id, attempt: 1, headSha: "a".repeat(40), headBranch: "cache", workflowName: "CI", status: "completed", conclusion: "failure", eventAt: "2026-08-24T10:00:00Z", htmlUrl: null });
      const requests = [];
      const seen = [];
      db.query("DELETE FROM settings WHERE key = 'relay_cursor'").run();
      await pollRelayOnce("https://relay.test", "token", {
        fetcher: async (input) => { requests.push(String(input)); return Response.json({ latest: 5, events: [{ seq: 5, ts: 1, repo: "acme/app", number: 7, event: "workflow_run", run: run(5) }] }); },
        ingest: async (_repo, state) => { seen.push(state.run.id); return true; },
      });
      const initialized = { cursor: getSetting("relay_cursor"), seen: [...seen] };

      setSetting("relay_cursor", "7");
      await pollRelayOnce("https://relay.test", "token", {
        fetcher: async (input) => { requests.push(String(input)); return Response.json({ latest: 10, events: [{ seq: 8, ts: 2, repo: "acme/app", number: 7, event: "workflow_run", run: run(8) }] }); },
        ingest: async (_repo, state) => { seen.push(state.run.id); return true; },
      });
      const resumed = { cursor: getSetting("relay_cursor"), seen: [...seen] };

      setSetting("relay_cursor", "20");
      let request = 0;
      const fetcher = async (input) => {
        requests.push(String(input));
        request++;
        return request === 1
          ? Response.json({ latest: 22, events: [
              { seq: 21, ts: 3, repo: "acme/app", number: 7, event: "workflow_run", run: run(21) },
              { seq: 22, ts: 4, repo: "acme/app", number: 7, event: "workflow_run", run: run(22) },
            ] })
          : Response.json({ latest: 25, events: [
              { seq: 22, ts: 4, repo: "acme/app", number: 7, event: "workflow_run", run: run(22) },
              { seq: 23, ts: 5, repo: "acme/app", number: 7, event: "workflow_run", run: run(23) },
            ] });
      };
      let failed = false;
      try {
        await pollRelayOnce("https://relay.test", "token", {
          fetcher,
          ingest: async (_repo, state) => {
            seen.push(state.run.id);
            if (state.run.id === 22) throw new Error("reconcile failed");
            return true;
          },
        });
      } catch { failed = true; }
      const afterFailure = getSetting("relay_cursor");
      await pollRelayOnce("https://relay.test", "token", {
        fetcher,
        ingest: async (_repo, state) => { seen.push(state.run.id); return true; },
      });
      console.log(JSON.stringify({ initialized, resumed, failed, afterFailure, finalCursor: getSetting("relay_cursor"), requests, seen }));
      db.close();
    `;
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr);
    const result = JSON.parse(stdout);
    expect(result.initialized).toEqual({ cursor: "5", seen: [] });
    expect(result.resumed).toEqual({ cursor: "10", seen: [8] });
    expect(result.failed).toBe(true);
    expect(result.afterFailure).toBe("21");
    expect(result.finalCursor).toBe("25");
    expect(result.requests).toEqual([
      "https://relay.test/events",
      "https://relay.test/events?since=7",
      "https://relay.test/events?since=20",
      "https://relay.test/events?since=21",
    ]);
    expect(result.seen).toEqual([8, 21, 22, 22, 23]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("events that can queue an uncached PR request a poll; uncached check noise does not", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-relay-membership-"));
  try {
    const script = `
      const { pollRelayOnce } = await import(${JSON.stringify(relayClientUrl)});
      const { db, setSetting } = await import(${JSON.stringify(dbUrl)});
      setSetting("relay_cursor", "0");
      const requested = [];
      const events = [
        { seq: 1, ts: 1, repo: "acme/app", number: 7, event: "check_run" },
        { seq: 2, ts: 2, repo: "acme/app", number: 8, event: "pull_request" },
        { seq: 3, ts: 3, repo: "acme/app", number: 9, event: "issue_comment" },
        { seq: 4, ts: 4, repo: "acme/app", number: null, event: "push" },
      ];
      await pollRelayOnce("https://relay.test", "token", {
        fetcher: async () => Response.json({ latest: 4, events }),
        requestFullPoll: () => requested.push(true),
        ingest: async () => true,
      });
      console.log(JSON.stringify({ requested: requested.length }));
      db.close();
    `;
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr);
    expect(JSON.parse(stdout).requested).toBe(3);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("relay negotiates legacy polling and creates authenticated WebSocket sessions", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-relay-negotiation-"));
  try {
    const script = `
      console.error = () => {};
      const { createRelayConnection, createRelaySession } = await import(${JSON.stringify(relayClientUrl)});
      const { db, getSetting } = await import(${JSON.stringify(dbUrl)});
      const requests = [];
      let sockets = 0;
      const fetcher = async (input, init = {}) => {
        const url = String(input);
        requests.push({ url, authorization: init.headers?.authorization, body: init.body });
        if (url.endsWith("/capabilities")) return new Response("", { status: 404 });
        if (url.endsWith("/events")) return Response.json({ latest: 3, events: [] });
        return Response.json({ ticket: "opaque-ticket", expiresAt: 1_777_580_800_000, repos: { "acme/app": false } });
      };
      const connection = createRelayConnection({
        fetcher,
        token: async () => "github-secret",
        repos: async () => ["acme/app"],
        socket: () => { sockets++; throw new Error("legacy relay opened a socket"); },
      });
      await connection.tick("https://legacy.test");
      const session = await createRelaySession("https://stream.test", "github-secret", ["acme/app"], fetcher);
      console.log(JSON.stringify({ requests, sockets, cursor: getSetting("relay_cursor"), session }));
      db.close();
    `;
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr);
    const result = JSON.parse(stdout);
    expect(result.sockets).toBe(0);
    expect(result.cursor).toBe("3");
    expect(result.requests).toEqual([
      { url: "https://legacy.test/capabilities" },
      { url: "https://legacy.test/events", authorization: "Bearer github-secret" },
      {
        url: "https://stream.test/session",
        authorization: "Bearer github-secret",
        body: JSON.stringify({ repos: ["acme/app"] }),
      },
    ]);
    expect(result.session).toEqual({
      ticket: "opaque-ticket",
      expiresAt: 1_777_580_800_000,
      repos: { "acme/app": false },
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("WebSocket frames replay markers, initialize cursors, and await reset reconciliation", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-relay-stream-"));
  try {
    const script = `
      const { streamRelayOnce } = await import(${JSON.stringify(relayClientUrl)});
      const { db, getSetting, setSetting } = await import(${JSON.stringify(dbUrl)});
      class FakeSocket {
        listeners = {};
        constructor(frames) {
          queueMicrotask(() => {
            this.emit("open");
            for (const frame of frames) this.emit("message", { data: JSON.stringify(frame) });
            this.emit("close", { code: 1000, reason: "relay restart" });
          });
        }
        addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
        emit(type, event) { for (const listener of this.listeners[type] ?? []) listener(event); }
        close() { this.emit("close"); }
      }
      const run = { id: 5, attempt: 1, headSha: "a".repeat(40), headBranch: "cache", workflowName: "CI", status: "completed", conclusion: "success", eventAt: "2026-08-30T10:00:00Z", htmlUrl: null };
      const seen = [];
      const order = [];
      const urls = [];
      setSetting("relay_cursor", "4");
      try {
        await streamRelayOnce("https://stream.test", "one-time-ticket", {
          socket: (url) => {
            urls.push(url);
            return new FakeSocket([
              { type: "ready", latest: 8 },
              { type: "marker", marker: { seq: 5, ts: 1, repo: "acme/app", number: 7, event: "workflow_run", run } },
              { type: "reset", latest: 9 },
            ]);
          },
          ingest: async (_repo, state, _fetchers, followup) => { seen.push(state.run.id + ":" + followup); return true; },
          fullPoll: async () => { order.push("poll:" + getSetting("relay_cursor")); },
        });
      } catch (error) {
        if (error.message !== "relay WebSocket closed (code=1000, reason=relay restart)") throw error;
      }
      order.push("done:" + getSetting("relay_cursor"));
      db.query("DELETE FROM settings WHERE key = 'relay_cursor'").run();
      try {
        await streamRelayOnce("http://stream.test:4821", "fresh-ticket", {
          socket: (url) => {
            urls.push(url);
            return new FakeSocket([{ type: "ready", latest: 12 }]);
          },
        });
      } catch (error) {
        if (error.message !== "relay WebSocket closed (code=1000, reason=relay restart)") throw error;
      }
      const initialized = getSetting("relay_cursor");
      setSetting("relay_cursor", "20");
      try {
        await streamRelayOnce("https://stream.test", "rewind-ticket", {
          socket: (url) => {
            urls.push(url);
            return new FakeSocket([{ type: "reset", latest: 9 }]);
          },
          fullPoll: async () => { order.push("rewind:" + getSetting("relay_cursor")); },
        });
      } catch (error) {
        if (error.message !== "relay WebSocket closed (code=1000, reason=relay restart)") throw error;
      }
      console.log(JSON.stringify({ seen, order, urls, initialized, rewound: getSetting("relay_cursor") }));
      db.close();
    `;
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr);
    const result = JSON.parse(stdout);
    expect(result.seen).toEqual(["5:background"]);
    expect(result.order).toEqual(["poll:5", "done:9", "rewind:20"]);
    expect(result.urls).toEqual([
      "wss://stream.test/stream?ticket=one-time-ticket&since=4",
      "ws://stream.test:4821/stream?ticket=fresh-ticket",
      "wss://stream.test/stream?ticket=rewind-ticket&since=20",
    ]);
    expect(result.initialized).toBe("12");
    expect(result.rewound).toBe("9");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a stream that stops answering pings is abandoned; one that answers stays open", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-relay-keepalive-"));
  try {
    const script = `
      const { streamRelayOnce } = await import(${JSON.stringify(relayClientUrl)});
      const { db, setSetting } = await import(${JSON.stringify(dbUrl)});
      setSetting("relay_cursor", "1");
      class SilentSocket {
        listeners = {};
        pings = 0;
        closed = false;
        constructor(answers) {
          this.answers = answers;
          queueMicrotask(() => this.emit("open"));
        }
        addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
        emit(type, event) { for (const listener of this.listeners[type] ?? []) listener(event); }
        ping() { this.pings++; if (this.answers) queueMicrotask(() => this.emit("pong")); }
        // a half-open TCP connection never delivers the close event
        close() { this.closed = true; }
      }
      const keepalive = { pingIntervalMs: 10, silenceTimeoutMs: 40 };
      const dead = new SilentSocket(false);
      const startedAt = Date.now();
      let deadError = null;
      try {
        await streamRelayOnce("https://stream.test", "ticket", { socket: () => dead, keepalive });
      } catch (error) {
        deadError = error.message;
      }
      const deadMs = Date.now() - startedAt;

      const live = new SilentSocket(true);
      let liveSettled = false;
      const liveStream = streamRelayOnce("https://stream.test", "ticket", { socket: () => live, keepalive })
        .catch(() => {}).finally(() => { liveSettled = true; });
      await Bun.sleep(150);
      const liveOpen = !liveSettled && !live.closed;
      live.emit("close", { code: 1000, reason: "done" });
      await liveStream;
      console.log(JSON.stringify({ deadError, deadMs, deadClosed: dead.closed, deadPings: dead.pings, liveOpen, livePings: live.pings }));
      db.close();
    `;
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr);
    const result = JSON.parse(stdout);
    expect(result.deadError).toMatch(/^relay WebSocket went silent for \d+s$/);
    expect(result.deadMs).toBeLessThan(1_000);
    expect(result.deadClosed).toBe(true);
    expect(result.deadPings).toBeGreaterThan(0);
    expect(result.liveOpen).toBe(true);
    expect(result.livePings).toBeGreaterThan(3);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("reconnect after a wake replaces a stream that never reported closing", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-relay-wake-"));
  try {
    const script = `
      const { createRelayConnection } = await import(${JSON.stringify(relayClientUrl)});
      const { db, setSetting } = await import(${JSON.stringify(dbUrl)});
      setSetting("relay_cursor", "3");
      class HalfOpenSocket {
        listeners = {};
        closed = false;
        constructor() { queueMicrotask(() => this.emit("open")); }
        addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
        emit(type, event) { for (const listener of this.listeners[type] ?? []) listener(event); }
        ping() { this.emit("pong"); }
        close() { this.closed = true; }
      }
      const sockets = [];
      let sessions = 0;
      const connection = createRelayConnection({
        fetcher: async (input) => String(input).endsWith("/capabilities")
          ? Response.json({ stream: "websocket-v1" })
          : Response.json({ ticket: "ticket-" + ++sessions, expiresAt: 1_777_580_800_000, repos: { "acme/app": true } }),
        token: async () => "token",
        repos: async () => ["acme/app"],
        socket: () => { const socket = new HalfOpenSocket(); sockets.push(socket); return socket; },
      });
      void connection.tick("https://relay.test");
      await Bun.sleep(20);
      void connection.tick("https://relay.test");
      await Bun.sleep(20);
      const beforeWake = sessions;
      connection.reconnect();
      void connection.tick("https://relay.test");
      await Bun.sleep(20);
      console.log(JSON.stringify({ beforeWake, sessions, firstClosed: sockets[0].closed, sockets: sockets.length }));
      db.close();
      process.exit(0);
    `;
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr);
    expect(JSON.parse(stdout)).toEqual({ beforeWake: 1, sessions: 2, firstClosed: true, sockets: 2 });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("advertised WebSocket failures reconnect without polling and URL changes renegotiate", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-relay-reconnect-"));
  try {
    const script = `
      console.error = () => {};
      const { createRelayConnection } = await import(${JSON.stringify(relayClientUrl)});
      const { db } = await import(${JSON.stringify(dbUrl)});
      class FailingSocket {
        listeners = {};
        constructor() { queueMicrotask(() => { this.emit("error"); this.emit("close"); }); }
        addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
        emit(type, event) { for (const listener of this.listeners[type] ?? []) listener(event); }
        close() { this.emit("close"); }
      }
      let now = 1_000;
      let sessions = 0;
      const requests = [];
      const socketUrls = [];
      const fetcher = async (input, init = {}) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith("/capabilities")) return Response.json({ stream: "websocket-v1" });
        if (url.endsWith("/events")) throw new Error("advertised stream silently fell back to polling");
        sessions++;
        return Response.json({ ticket: "ticket-" + sessions, expiresAt: 1_777_580_800_000, repos: { "acme/app": false } });
      };
      const connection = createRelayConnection({
        fetcher,
        token: async () => "github-secret",
        repos: async () => ["acme/app"],
        now: () => now,
        socket: (url) => { socketUrls.push(url); return new FailingSocket(); },
      });
      await connection.tick("https://first.test");
      await connection.tick("https://first.test");
      const beforeBackoff = sessions;
      now = 2_000;
      await connection.tick("https://first.test");
      const afterReconnect = sessions;
      await connection.tick("https://second.test");
      console.log(JSON.stringify({ requests, socketUrls, beforeBackoff, afterReconnect, sessions }));
      db.close();
    `;
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr);
    const result = JSON.parse(stdout);
    expect(result.beforeBackoff).toBe(1);
    expect(result.afterReconnect).toBe(2);
    expect(result.sessions).toBe(3);
    expect(result.requests).toEqual([
      "https://first.test/capabilities",
      "https://first.test/session",
      "https://first.test/session",
      "https://second.test/capabilities",
      "https://second.test/session",
    ]);
    expect(result.socketUrls).toEqual([
      "wss://first.test/stream?ticket=ticket-1",
      "wss://first.test/stream?ticket=ticket-2",
      "wss://second.test/stream?ticket=ticket-3",
    ]);
    expect(result.socketUrls.join(" ")).not.toContain("github-secret");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("an expired session ticket renews on the next tick without backoff", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-relay-expiry-"));
  try {
    const script = `
      const errors = [];
      console.error = console.warn = (...args) => errors.push(args.map(String).join(" "));
      const { createRelayConnection } = await import(${JSON.stringify(relayClientUrl)});
      const { db } = await import(${JSON.stringify(dbUrl)});
      class ExpiringSocket {
        listeners = {};
        constructor() {
          queueMicrotask(() => {
            this.emit("open");
            this.emit("close", { code: 1008, reason: "authorization expired" });
          });
        }
        addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
        emit(type, event) { for (const listener of this.listeners[type] ?? []) listener(event); }
        close() { this.emit("close"); }
      }
      let sessions = 0;
      const fetcher = async (input) => {
        const url = String(input);
        if (url.endsWith("/capabilities")) return Response.json({ stream: "websocket-v1" });
        sessions++;
        return Response.json({ ticket: "ticket-" + sessions, expiresAt: 1_777_580_800_000, repos: { "acme/app": false } });
      };
      const connection = createRelayConnection({
        fetcher,
        token: async () => "github-secret",
        repos: async () => ["acme/app"],
        now: () => 1_000,
        socket: () => new ExpiringSocket(),
      });
      await connection.tick("https://stream.test");
      await connection.tick("https://stream.test");
      console.log(JSON.stringify({ sessions, errors }));
      db.close();
    `;
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr);
    const result = JSON.parse(stdout);
    expect(result.sessions).toBe(2);
    expect(result.errors).toEqual([]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("active WebSocket sessions reconfigure locally without hiding a later peer close", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-relay-repos-"));
  try {
    const script = `
      const errors = [];
      console.error = console.warn = (...args) => errors.push(args.map((arg) => arg instanceof Error ? arg.message : String(arg)).join(" "));
      const { createRelayConnection } = await import(${JSON.stringify(relayClientUrl)});
      const { db } = await import(${JSON.stringify(dbUrl)});
      class ActiveSocket {
        listeners = {};
        constructor() { queueMicrotask(() => this.emit("open")); }
        addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
        emit(type, event) { for (const listener of this.listeners[type] ?? []) listener(event); }
        close() { this.emit("close", { code: 1000, reason: "client reconfigure" }); }
      }
      let repos = ["acme/app"];
      const sessionRepos = [];
      const sockets = [];
      const created = [Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers(), Promise.withResolvers()];
      const fetcher = async (input, init = {}) => {
        const url = String(input);
        if (url.endsWith("/capabilities")) return Response.json({ stream: "websocket-v1" });
        const requested = JSON.parse(init.body).repos;
        sessionRepos.push(requested);
        return Response.json({
          ticket: "ticket-" + sessionRepos.length,
          expiresAt: 1_777_580_800_000,
          repos: Object.fromEntries(requested.map((repo) => [repo, true])),
        });
      };
      const connection = createRelayConnection({
        fetcher,
        token: async () => "github-secret",
        repos: async () => [...repos],
        socket: () => {
          const socket = new ActiveSocket();
          sockets.push(socket);
          created[sockets.length - 1].resolve();
          return socket;
        },
      });
      const ticks = [connection.tick("https://stream.test")];
      await created[0].promise;
      repos = ["acme/app", "acme/tools"];
      ticks.push(connection.tick("https://stream.test"));
      await created[1].promise;
      repos = ["acme/tools"];
      ticks.push(connection.tick("https://stream.test"));
      await created[2].promise;
      ticks.push(connection.tick("https://other-stream.test"));
      await created[3].promise;
      sockets[3].emit("close", { code: 1000, reason: "server maintenance" });
      await Promise.all(ticks);
      console.log(JSON.stringify({ sessionRepos, socketCount: sockets.length, errors }));
      db.close();
    `;
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr);
    const result = JSON.parse(stdout);
    expect(result.sessionRepos).toEqual([
      ["acme/app"],
      ["acme/app", "acme/tools"],
      ["acme/tools"],
      ["acme/tools"],
    ]);
    expect(result.socketCount).toBe(4);
    expect(result.errors).toEqual(["relay stream ended: relay WebSocket closed (code=1000, reason=server maintenance); reconnecting in 1s"]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("WebSocket relay stays idle with zero repos and closes when the last repo is removed", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-relay-empty-repos-"));
  try {
    const script = `
      console.error = () => {};
      const { createRelayConnection } = await import(${JSON.stringify(relayClientUrl)});
      const { db } = await import(${JSON.stringify(dbUrl)});
      class ActiveSocket {
        listeners = {};
        constructor(opened) { queueMicrotask(() => { this.emit("open"); opened.resolve(); }); }
        addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
        emit(type, event) { for (const listener of this.listeners[type] ?? []) listener(event); }
        close() { this.emit("close"); }
      }
      let repos = [];
      let tokenRequests = 0;
      let sessionRequests = 0;
      let socketCount = 0;
      const opened = Promise.withResolvers();
      const fetcher = async (input) => {
        const url = String(input);
        if (url.endsWith("/capabilities")) return Response.json({ stream: "websocket-v1" });
        sessionRequests++;
        return Response.json({
          ticket: "ticket",
          expiresAt: 1_777_580_800_000,
          repos: { "acme/app": true },
        });
      };
      const connection = createRelayConnection({
        fetcher,
        token: async () => { tokenRequests++; return "github-secret"; },
        repos: async () => [...repos],
        socket: () => { socketCount++; return new ActiveSocket(opened); },
      });
      await connection.tick("https://stream.test");
      const empty = { tokenRequests, sessionRequests, socketCount };
      repos = ["acme/app"];
      const activeTick = connection.tick("https://stream.test");
      await opened.promise;
      const active = { tokenRequests, sessionRequests, socketCount };
      repos = [];
      await connection.tick("https://stream.test");
      await activeTick;
      console.log(JSON.stringify({ empty, active, final: { tokenRequests, sessionRequests, socketCount } }));
      db.close();
    `;
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr);
    const result = JSON.parse(stdout);
    expect(result.empty).toEqual({ tokenRequests: 0, sessionRequests: 0, socketCount: 0 });
    expect(result.active).toEqual({ tokenRequests: 1, sessionRequests: 1, socketCount: 1 });
    expect(result.final).toEqual({ tokenRequests: 1, sessionRequests: 1, socketCount: 1 });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("unchanged repos do not invalidate a pending WebSocket session", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-relay-pending-session-"));
  try {
    const script = `
      console.error = () => {};
      const { createRelayConnection } = await import(${JSON.stringify(relayClientUrl)});
      const { db } = await import(${JSON.stringify(dbUrl)});
      class ActiveSocket {
        listeners = {};
        constructor(opened) { queueMicrotask(() => { this.emit("open"); opened.resolve(); }); }
        addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
        emit(type, event) { for (const listener of this.listeners[type] ?? []) listener(event); }
        close() { this.emit("close"); }
      }
      const sessionRequested = Promise.withResolvers();
      const sessionResponse = Promise.withResolvers();
      const opened = Promise.withResolvers();
      let sessionRequests = 0;
      let socketCount = 0;
      let socket;
      const fetcher = async (input) => {
        const url = String(input);
        if (url.endsWith("/capabilities")) return Response.json({ stream: "websocket-v1" });
        sessionRequests++;
        sessionRequested.resolve();
        await sessionResponse.promise;
        return Response.json({
          ticket: "ticket",
          expiresAt: 1_777_580_800_000,
          repos: { "acme/app": true, "acme/tools": true },
        });
      };
      const connection = createRelayConnection({
        fetcher,
        token: async () => "github-secret",
        repos: async () => ["acme/tools", "acme/app"],
        socket: () => {
          socketCount++;
          socket = new ActiveSocket(opened);
          return socket;
        },
      });
      const initialTick = connection.tick("https://stream.test");
      await sessionRequested.promise;
      await connection.tick("https://stream.test");
      sessionResponse.resolve();
      await opened.promise;
      socket.close();
      await initialTick;
      console.log(JSON.stringify({ sessionRequests, socketCount }));
      db.close();
    `;
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr);
    expect(JSON.parse(stdout)).toEqual({ sessionRequests: 1, socketCount: 1 });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
