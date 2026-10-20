import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const relayClientUrl = new URL("./relayClient.ts", import.meta.url).href;
const dbUrl = new URL("./db.ts", import.meta.url).href;
const mockGithubUrl = new URL("./mockGithub.ts", import.meta.url).href;
const invalidationUrl = new URL("./rendererInvalidation.ts", import.meta.url).href;
const recentPrViewsUrl = new URL("./recentPrViews.ts", import.meta.url).href;
const relayAnchorsUrl = new URL("./relayAnchors.ts", import.meta.url).href;

const A1 = "a".repeat(40);
const A2 = "b".repeat(40);
const A3 = "1".repeat(40);
const T1 = "c".repeat(40);
const TREES: Record<string, string> = { [A1]: "d".repeat(40), [A2]: "f".repeat(40), [A3]: "2".repeat(40), [T1]: "e".repeat(40) };
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const anchorIdOf = (repo: string, repoId: number, after: string) => sha256(`pr-cockpit-relay anchor\n${repo}\n${repoId}\n${after}`);
const proofOf = (repo: string, repoId: number, after: string) => sha256(`pr-cockpit-relay proof\n${repo}\n${repoId}\n${after}\n${TREES[after]}`);

// Fakes shared by the anchor scripts: GitHub answers with the push activity in `activity`, the relay matches
// the anchorId at `relayIndex[repo]` among those sent, and sockets replay their frames and then
// close as an expired ticket unless told to stay open.
const ANCHOR_FAKES = `
  console.warn = console.error = () => {};
  const A1 = ${JSON.stringify(A1)}, A2 = ${JSON.stringify(A2)}, A3 = ${JSON.stringify(A3)}, T1 = ${JSON.stringify(T1)};
  const TREES = ${JSON.stringify(TREES)};
  let clock = 0;
  const githubCalls = [];
  const activity = {
    "acme/app": [{ after: A2, activity_type: "push" }, { after: "0".repeat(40), activity_type: "branch_deletion" }, { after: A1, activity_type: "pr_merge" }],
    "acme/tools": [{ after: T1, activity_type: "push" }],
  };
  const github = {
    repository: async (repo) => repo === "acme/app" ? { id: 101, defaultBranch: "main" } : { id: 202, defaultBranch: "trunk" },
    activity: async (repo, ref) => {
      githubCalls.push("activity " + repo + " " + ref);
      return [...activity[repo]];
    },
    tree: async (repo, sha) => { githubCalls.push("tree " + repo + " " + sha); return TREES[sha]; },
  };
  const requests = [];
  const relayIndex = { "acme/app": 1, "acme/tools": 0 };
  let refused = new Set();
  const fetcher = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ path: url.pathname, authorization: new Headers(init.headers).get("authorization"), body });
    if (url.pathname === "/capabilities") return Response.json({ stream: "websocket-v1", anchors: "v1" });
    if (url.pathname === "/anchors") {
      return Response.json({ repos: Object.fromEntries(Object.entries(body.repos).map(([repo, ids]) => [repo, ids[relayIndex[repo]] ?? null])) });
    }
    const repos = Object.fromEntries(Object.keys(body.proofs).map((repo) => [repo, !refused.has(repo)]));
    if (!Object.values(repos).some(Boolean)) return new Response("", { status: 403 });
    return Response.json({ ticket: "ticket-" + requests.length, expiresAt: 1_777_580_800_000, repos });
  };
  class ScriptedSocket {
    listeners = {};
    closed = false;
    constructor(frames, expire = true) {
      queueMicrotask(() => {
        this.emit("open");
        for (const frame of frames) this.emit("message", { data: JSON.stringify(frame) });
        if (expire) this.emit("close", { code: 1008, reason: "authorization expired" });
      });
    }
    addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
    emit(type, event) { for (const listener of this.listeners[type] ?? []) listener(event); }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.emit("close", { code: 1000, reason: "client closed" });
    }
  }
`;

async function runRelayScript(prefix: string, script: string) {
  const dataDir = mkdtempSync(join(tmpdir(), prefix));
  try {
    const process = Bun.spawn([Bun.which("bun") ?? "bun", "-e", script], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir, COCKPIT_MOCK: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    if (exitCode !== 0) throw new Error(stderr);
    return JSON.parse(stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

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

test("events refresh an uncached PR the user recently viewed, with the event's scope", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-relay-viewed-"));
  try {
    const script = `
      const { pollRelayOnce } = await import(${JSON.stringify(relayClientUrl)});
      const { db, setSetting } = await import(${JSON.stringify(dbUrl)});
      setSetting("relay_cursor", "0");
      const refreshed = [];
      const requested = [];
      const events = [
        { seq: 1, ts: 1, repo: "acme/app", number: 7, event: "check_run" },
        { seq: 2, ts: 2, repo: "acme/app", number: 8, event: "check_run" },
        { seq: 3, ts: 3, repo: "acme/app", number: 9, event: "issue_comment" },
      ];
      await pollRelayOnce("https://relay.test", "token", {
        fetcher: async () => Response.json({ latest: 3, events }),
        requestFullPoll: () => requested.push(true),
        ingest: async () => true,
        viewedRecently: (_repo, number) => number !== 8,
        backgroundAllowed: async () => true,
        refreshViewedPr: async (repo, number, source, scope) => { refreshed.push([repo, number, source, scope]); },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      console.log(JSON.stringify({ refreshed, requested: requested.length }));
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
    expect(result.refreshed).toEqual([
      ["acme/app", 7, "relay", "checks"],
      ["acme/app", 9, "relay", "review"],
    ]);
    // A viewed PR can still enter the queue through the event, so membership polls continue.
    expect(result.requested).toBe(1);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a pushed branch refreshes the tracked open PRs based on or headed by it, and only those", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-relay-push-"));
  try {
    const script = `
      const { pollRelayOnce } = await import(${JSON.stringify(relayClientUrl)});
      const { db, getPr, getSetting, setSetting } = await import(${JSON.stringify(dbUrl)});
      const { seedMockDatabase } = await import(${JSON.stringify(mockGithubUrl)});
      const { setRendererInvalidationPublisher } = await import(${JSON.stringify(invalidationUrl)});
      seedMockDatabase(db, ${JSON.stringify(dataDir)});
      // Resolves once each PR's detail and Actions catalog have been published.
      const settledFor = (keys) => new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("refreshes did not settle: " + JSON.stringify(invalidated))), 4_000);
        setRendererInvalidationPublisher((event) => {
          if (event.type !== "pr") return;
          invalidated.push(event.repo + "#" + event.number);
          if (keys.every((key) => invalidated.filter((entry) => entry === key).length >= 2)) {
            clearTimeout(deadline);
            resolve();
          }
        });
      });
      // #103 alone is open on main, and its snapshot predates main moving: GitHub now reports it
      // conflicting, yet its head, updated time, and CI are unchanged, so only the push reveals it.
      const stale = { ...JSON.parse(getPr("fixture/cockpit", 103).detail_json), mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" };
      db.run("UPDATE prs SET fetched_at = '2026-01-01T00:00:00.000Z'");
      db.run("UPDATE prs SET base_ref = 'develop' WHERE repo = 'fixture/cockpit' AND state NOT IN ('MERGED', 'CLOSED')");
      db.run("UPDATE prs SET base_ref = 'main', mergeable = 'MERGEABLE', merge_state_status = 'CLEAN', detail_json = ? WHERE repo = 'fixture/cockpit' AND number = 103", [JSON.stringify(stale)]);
      const before = getPr("fixture/cockpit", 103);
      const invalidated = [];
      const refreshed = settledFor(["fixture/cockpit#101", "fixture/cockpit#103"]);
      const requested = [];
      setSetting("relay_cursor", "0");
      await pollRelayOnce("https://relay.test", "token", {
        fetcher: async () => Response.json({ latest: 6, events: [
          { seq: 1, ts: 1, repo: "fixture/cockpit", number: null, event: "push", ref: "refs/heads/main" },
          { seq: 2, ts: 2, repo: "fixture/cockpit", number: null, event: "push", ref: "refs/heads/fixture/pr-101" },
          { seq: 3, ts: 3, repo: "fixture/cockpit", number: null, event: "push", ref: "refs/tags/main" },
          { seq: 4, ts: 4, repo: "fixture/cockpit", number: null, event: "push", ref: "refs/heads/" },
          { seq: 5, ts: 5, repo: "fixture/elsewhere", number: null, event: "push", ref: "refs/heads/main" },
          { seq: 6, ts: 6, repo: "fixture/cockpit", number: null, event: "push" },
        ] }),
        requestFullPoll: () => requested.push(true),
        backgroundAllowed: async () => true,
      });
      await refreshed;
      const after = getPr("fixture/cockpit", 103);
      console.log(JSON.stringify({
        invalidated: [...new Set(invalidated)].sort(),
        before: { head: before.head_sha, updatedAt: before.updated_at },
        after: { head: after.head_sha, updatedAt: after.updated_at, mergeable: after.mergeable, mergeState: after.merge_state_status, detail: JSON.parse(after.detail_json).mergeable },
        activity: db.query("SELECT repo, number FROM pr_webhook_activity ORDER BY repo, number").all(),
        requested: requested.length,
        cursor: getSetting("relay_cursor"),
      }));
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
    // The merged PR on main, the admin repository's PR on main, and every other branch stay put.
    expect(result.invalidated).toEqual(["fixture/cockpit#101", "fixture/cockpit#103"]);
    expect(result.after).toEqual({ ...result.before, mergeable: "CONFLICTING", mergeState: "DIRTY", detail: "CONFLICTING" });
    expect(result.activity).toEqual([{ repo: "fixture/cockpit", number: 101 }, { repo: "fixture/cockpit", number: 103 }]);
    // Only the marker from a relay that does not forward refs still falls back to a poll.
    expect(result.requested).toBe(1);
    expect(result.cursor).toBe("6");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a streamed branch push also refreshes recently viewed untracked PRs from their cached detail", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-relay-push-viewed-"));
  try {
    const script = `
      const { streamRelayOnce } = await import(${JSON.stringify(relayClientUrl)});
      const { db, getCachedPrDetail, getPr, setSetting, upsertCachedPrDetail } = await import(${JSON.stringify(dbUrl)});
      const { seedMockDatabase } = await import(${JSON.stringify(mockGithubUrl)});
      const { setRendererInvalidationPublisher } = await import(${JSON.stringify(invalidationUrl)});
      const { notePrViewed } = await import(${JSON.stringify(recentPrViewsUrl)});
      seedMockDatabase(db, ${JSON.stringify(dataDir)});
      // Resolves once each PR's detail and Actions catalog have been published.
      const settledFor = (keys) => new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("refreshes did not settle: " + JSON.stringify(invalidated))), 4_000);
        setRendererInvalidationPublisher((event) => {
          if (event.type !== "pr") return;
          invalidated.push(event.repo + "#" + event.number);
          if (keys.every((key) => invalidated.filter((entry) => entry === key).length >= 2)) {
            clearTimeout(deadline);
            resolve();
          }
        });
      });
      db.run("UPDATE prs SET fetched_at = '2026-01-01T00:00:00.000Z'");
      db.run("UPDATE prs SET base_ref = 'develop' WHERE state NOT IN ('MERGED', 'CLOSED')");
      db.run("UPDATE prs SET base_ref = 'main' WHERE repo = 'fixture/cockpit' AND number = 102");
      // Outside the inbox, known only from a detail the user opened before main moved.
      const cache = (repo, number, overrides) => {
        const detail = { ...JSON.parse(getPr(repo, number).detail_json), ...overrides };
        db.run("DELETE FROM prs WHERE repo = ? AND number = ?", [repo, number]);
        upsertCachedPrDetail({ repo, number, head_sha: detail.headRefOid, detail_json: JSON.stringify(detail), fetched_at: "2026-01-01T00:00:00.000Z" });
        return detail;
      };
      const stale = cache("fixture/cockpit", 103, { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" });
      cache("fixture/cockpit", 104, {});
      cache("fixture/cockpit", 105, { baseRefName: "develop" });
      cache("fixture/cockpit", 106, {});
      cache("fixture/admin-cockpit", 112, {});
      for (const [repo, number] of [["fixture/cockpit", 103], ["fixture/cockpit", 105], ["fixture/cockpit", 106], ["fixture/admin-cockpit", 112]]) notePrViewed(repo, number);
      const invalidated = [];
      const refreshed = settledFor(["fixture/cockpit#102", "fixture/cockpit#103"]);
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
      setSetting("relay_cursor", "0");
      try {
        await streamRelayOnce("https://stream.test", "ticket", {
          socket: () => new FakeSocket([{ type: "marker", marker: { seq: 1, ts: 1, repo: "fixture/cockpit", number: null, event: "push", ref: "refs/heads/main" } }]),
          requestFullPoll: () => { throw new Error("a branch push must not poll"); },
          backgroundAllowed: async () => true,
        });
      } catch (error) {
        if (error.message !== "relay WebSocket closed (code=1000, reason=relay restart)") throw error;
      }
      await refreshed;
      const cached = getCachedPrDetail("fixture/cockpit", 103);
      const fresh = JSON.parse(cached.detail_json);
      console.log(JSON.stringify({
        invalidated: [...new Set(invalidated)].sort(),
        before: { head: stale.headRefOid, updatedAt: stale.updatedAt },
        after: { head: fresh.headRefOid, updatedAt: fresh.updatedAt, mergeable: fresh.mergeable, mergeState: fresh.mergeStateStatus },
        tracked: { 102: getPr("fixture/cockpit", 102) !== null, 103: getPr("fixture/cockpit", 103) !== null },
        activity: db.query("SELECT repo, number FROM pr_webhook_activity ORDER BY repo, number").all(),
      }));
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
    // Unviewed #104, #105 on another base, merged #106, and the other repository's #112 stay put.
    expect(result.invalidated).toEqual(["fixture/cockpit#102", "fixture/cockpit#103"]);
    expect(result.after).toEqual({ ...result.before, mergeable: "CONFLICTING", mergeState: "DIRTY" });
    // The viewed PR refreshes in place rather than joining the inbox.
    expect(result.tracked).toEqual({ 102: true, 103: false });
    expect(result.activity).toEqual([{ repo: "fixture/cockpit", number: 102 }, { repo: "fixture/cockpit", number: 103 }]);
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
    // Every token session re-reads capabilities first, so a relay that adds anchors never gets it again.
    expect(result.requests).toEqual([
      "https://first.test/capabilities",
      "https://first.test/session",
      "https://first.test/capabilities",
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

test("anchor relays get proofs and never the token; refused proofs re-resolve at most every ten minutes", async () => {
  const result = await runRelayScript("pr-cockpit-relay-anchors-", `
    ${ANCHOR_FAKES}
    const { createRelayConnection } = await import(${JSON.stringify(relayClientUrl)});
    const { RelayAnchors } = await import(${JSON.stringify(relayAnchorsUrl)});
    const { db, getSetting } = await import(${JSON.stringify(dbUrl)});
    let tokenRequests = 0;
    const connection = createRelayConnection({
      fetcher,
      anchors: new RelayAnchors({ fetcher, github, now: () => clock }),
      token: async () => { tokenRequests++; return "github-secret"; },
      viewer: () => ({ id: 7, login: "octo" }),
      repos: async () => ["acme/app", "acme/tools"],
      now: () => clock,
      socket: () => new ScriptedSocket([]),
    });
    const steps = [];
    const tick = async (at) => {
      clock = at;
      const before = requests.length;
      await connection.tick("https://relay.test");
      steps.push({
        at,
        github: githubCalls.splice(0),
        anchors: requests.slice(before).filter((request) => request.path === "/anchors").map((request) => Object.keys(request.body.repos)),
        sessions: requests.slice(before).filter((request) => request.path === "/session").map((request) => Object.keys(request.body.proofs)),
      });
    };
    refused = new Set(["acme/tools"]);
    await tick(0);
    await tick(60_000);
    refused = new Set();
    await tick(11 * 60_000);
    refused = new Set(["acme/app"]);
    await tick(30 * 60_000);
    await tick(31 * 60_000);
    console.log(JSON.stringify({ tokenRequests, requests, steps, install: getSetting("relay_install_id") }));
    db.close();
  `);
  expect(result.tokenRequests).toBe(0);
  expect(result.requests.filter((request: { authorization: string | null }) => request.authorization !== null)).toEqual([]);
  const [firstAnchors, firstSession] = result.requests.filter((request: { path: string }) => request.path !== "/capabilities");
  expect(firstAnchors.body).toEqual({ repos: {
    "acme/app": [anchorIdOf("acme/app", 101, A2), anchorIdOf("acme/app", 101, A1)],
    "acme/tools": [anchorIdOf("acme/tools", 202, T1)],
  } });
  expect(firstSession.body).toEqual({
    proofs: { "acme/app": proofOf("acme/app", 101, A1), "acme/tools": proofOf("acme/tools", 202, T1) },
    install: result.install,
    user: { id: 7, login: "octo" },
  });
  expect(result.install).toMatch(/^[0-9a-f-]{36}$/);
  expect(result.steps).toEqual([
    {
      at: 0,
      github: ["activity acme/app refs/heads/main", "activity acme/tools refs/heads/trunk", "tree acme/app " + A1, "tree acme/tools " + T1],
      anchors: [["acme/app", "acme/tools"]],
      sessions: [["acme/app", "acme/tools"]],
    },
    // The refused repository waits out its ten minutes; the accepted one keeps its cached proof.
    { at: 60_000, github: [], anchors: [], sessions: [["acme/app"]] },
    // Re-resolved from fresh activity; the unchanged anchor commit needs no second tree read.
    { at: 11 * 60_000, github: ["activity acme/tools refs/heads/trunk"], anchors: [["acme/tools"]], sessions: [["acme/app", "acme/tools"]] },
    // A cached proof refused long after it resolved is re-resolved once, then the session goes ahead without it.
    {
      at: 30 * 60_000,
      github: ["activity acme/app refs/heads/main"],
      anchors: [["acme/app"]],
      sessions: [["acme/app", "acme/tools"], ["acme/app", "acme/tools"]],
    },
    { at: 31 * 60_000, github: [], anchors: [], sessions: [["acme/tools"]] },
  ]);
});

test("a rotate frame reconnects from the cursor and re-resolves only the rotated repository", async () => {
  const result = await runRelayScript("pr-cockpit-relay-rotate-", `
    ${ANCHOR_FAKES}
    const { createRelayConnection } = await import(${JSON.stringify(relayClientUrl)});
    const { RelayAnchors } = await import(${JSON.stringify(relayAnchorsUrl)});
    const { db, setSetting } = await import(${JSON.stringify(dbUrl)});
    setSetting("relay_cursor", "3");
    const socketUrls = [];
    const sockets = [];
    const scripts = [
      [
        { type: "marker", marker: { seq: 4, ts: 1, repo: "acme/tools", number: 5, event: "check_run" } },
        { type: "rotate", repo: "Acme/App" },
      ],
      [],
    ];
    const connection = createRelayConnection({
      fetcher,
      anchors: new RelayAnchors({ fetcher, github, now: () => clock }),
      token: async () => { throw new Error("token requested"); },
      viewer: () => null,
      viewedRecently: () => false,
      repos: async () => ["acme/app", "acme/tools"],
      now: () => clock,
      socket: (url) => {
        socketUrls.push(url);
        // The first stream never expires, so only the rotate frame can end it.
        const socket = new ScriptedSocket(scripts[sockets.length], sockets.length > 0);
        sockets.push(socket);
        return socket;
      },
    });
    await connection.tick("https://relay.test");
    const firstGithub = githubCalls.splice(0);
    relayIndex["acme/app"] = 0;
    clock = 1_000;
    const before = requests.length;
    await connection.tick("https://relay.test");
    console.log(JSON.stringify({
      firstGithub,
      secondGithub: githubCalls,
      rotatedClosed: sockets[0].closed,
      socketUrls,
      relay: requests.slice(before).map((request) => ({ path: request.path, body: request.body })),
    }));
    db.close();
  `);
  expect(result.firstGithub).toHaveLength(4);
  expect(result.rotatedClosed).toBe(true);
  expect(result.socketUrls).toEqual([
    "wss://relay.test/stream?ticket=ticket-3&since=3",
    "wss://relay.test/stream?ticket=ticket-5&since=4",
  ]);
  expect(result.secondGithub).toEqual(["activity acme/app refs/heads/main", "tree acme/app " + A2]);
  expect(result.relay).toEqual([
    { path: "/anchors", body: { repos: { "acme/app": [anchorIdOf("acme/app", 101, A2), anchorIdOf("acme/app", 101, A1)] } } },
    {
      path: "/session",
      body: {
        proofs: { "acme/app": proofOf("acme/app", 101, A2), "acme/tools": proofOf("acme/tools", 202, T1) },
        install: expect.any(String),
      },
    },
  ]);
});

test("after a rotate the previous proof is still presented until activity shows the new push", async () => {
  const result = await runRelayScript("pr-cockpit-relay-rotate-lag-", `
    ${ANCHOR_FAKES}
    const { createRelayConnection } = await import(${JSON.stringify(relayClientUrl)});
    const { RelayAnchors } = await import(${JSON.stringify(relayAnchorsUrl)});
    const { db } = await import(${JSON.stringify(dbUrl)});
    let sockets = 0;
    const connection = createRelayConnection({
      fetcher,
      anchors: new RelayAnchors({ fetcher, github, now: () => clock }),
      token: async () => { throw new Error("token requested"); },
      viewer: () => null,
      repos: async () => ["acme/app", "acme/tools"],
      now: () => clock,
      // The first stream stays open until its rotate frame; later ones end as expired tickets.
      socket: () => sockets++ === 0 ? new ScriptedSocket([{ type: "rotate", repo: "acme/app" }], false) : new ScriptedSocket([]),
    });
    const steps = [];
    const tick = async (at) => {
      clock = at;
      const before = requests.length;
      await connection.tick("https://relay.test");
      steps.push({
        at,
        github: githubCalls.splice(0),
        proofs: requests.slice(before).filter((request) => request.path === "/session").map((request) => request.body.proofs["acme/app"]),
      });
    };
    await tick(0);
    // The relay rotated onto A3, which GitHub's activity list does not show yet. Within the grace
    // it still matches the previous anchor A1 (index 1), as the real relay does.
    await tick(1_000);
    await tick(30_000);
    activity["acme/app"].unshift({ after: A3, activity_type: "push" });
    relayIndex["acme/app"] = 0;
    await tick(61_000);
    console.log(JSON.stringify(steps));
    db.close();
  `);
  const previous = proofOf("acme/app", 101, A1);
  expect(result).toEqual([
    {
      at: 0,
      github: ["activity acme/app refs/heads/main", "activity acme/tools refs/heads/trunk", "tree acme/app " + A1, "tree acme/tools " + T1],
      proofs: [previous],
    },
    { at: 1_000, github: ["activity acme/app refs/heads/main"], proofs: [previous] },
    // Still within a minute of the unmatched read: no GitHub request, the previous proof again.
    { at: 30_000, github: [], proofs: [previous] },
    { at: 61_000, github: ["activity acme/app refs/heads/main", "tree acme/app " + A3], proofs: [proofOf("acme/app", 101, A3)] },
  ]);
});

test("a relay URL that offered anchors, or the hosted relay, never falls back to the token", async () => {
  const result = await runRelayScript("pr-cockpit-relay-downgrade-", `
    ${ANCHOR_FAKES}
    const { createRelayConnection, relayStatus } = await import(${JSON.stringify(relayClientUrl)});
    const { RelayAnchors, relayCapability } = await import(${JSON.stringify(relayAnchorsUrl)});
    const { db, getSetting } = await import(${JSON.stringify(dbUrl)});
    const answers = { "relay.test": "anchors", "relay.prcockpit.com": 404, "self.test": 404 };
    const relayRequests = [];
    let tokenRequests = 0;
    const relay = async (input, init = {}) => {
      const url = new URL(String(input));
      relayRequests.push(url.host + url.pathname + " " + new Headers(init.headers).get("authorization"));
      if (url.pathname === "/capabilities") {
        const answer = answers[url.host];
        if (answer === 404) return new Response("", { status: 404 });
        return Response.json(answer === "anchors" ? { stream: "websocket-v1", anchors: "v1" } : { stream: "websocket-v1" });
      }
      if (url.pathname === "/events") return Response.json({ latest: 0, events: [] });
      return fetcher(input, init);
    };
    const connect = () => createRelayConnection({
      fetcher: relay,
      anchors: new RelayAnchors({ fetcher: relay, github, now: () => clock }),
      token: async () => { tokenRequests++; return "github-secret"; },
      viewer: () => null,
      repos: async () => ["acme/app"],
      now: () => clock,
      socket: () => new ScriptedSocket([]),
    });
    const steps = [];
    const tick = async (connection, url) => {
      relayRequests.length = 0;
      clock += 60_000;
      await connection.tick(url);
      steps.push({ requests: [...relayRequests], tokenRequests, error: relayStatus().lastError });
    };
    await tick(connect(), "https://relay.test");
    const remembered = JSON.parse(getSetting("relay_anchor_urls"));

    const downgraded = connect();
    answers["relay.test"] = "websocket";
    await tick(downgraded, "https://relay.test");
    answers["relay.test"] = 404;
    await tick(downgraded, "https://relay.test");
    await tick(connect(), "https://relay.prcockpit.com");

    const selfHosted = connect();
    await tick(selfHosted, "https://self.test");
    answers["self.test"] = "anchors";
    await relayCapability("https://self.test", relay);
    answers["self.test"] = 404;
    await tick(selfHosted, "https://self.test");
    console.log(JSON.stringify({ remembered, steps }));
    db.close();
  `);
  expect(result.remembered).toEqual(["https://relay.test"]);
  expect(result.steps).toEqual([
    {
      requests: ["relay.test/capabilities null", "relay.test/anchors null", "relay.test/session null"],
      tokenRequests: 0,
      error: null,
    },
    { requests: ["relay.test/capabilities null"], tokenRequests: 0, error: "relay no longer advertises token-free access" },
    { requests: ["relay.test/capabilities null"], tokenRequests: 0, error: "relay capabilities responded 404" },
    { requests: ["relay.prcockpit.com/capabilities null"], tokenRequests: 0, error: "relay capabilities responded 404" },
    // A self-hosted relay that never offered anchors keeps the token flow...
    { requests: ["self.test/capabilities null", "self.test/events Bearer github-secret"], tokenRequests: 1, error: null },
    // ...until it does once; a later 404 is then an error, not a reason to send the token again.
    { requests: ["self.test/capabilities null"], tokenRequests: 1, error: "relay capabilities responded 404" },
  ]);
});
