import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = (file: string) => JSON.stringify(new URL(file, import.meta.url).href);
const cli = JSON.stringify(join(import.meta.dir, "..", "scripts", "pr-cockpit"));

test("an agent's ready-for-review mark covers only the open head it was set at and is independent of pins and approval", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-review-handoff-"));
  const scenario = `
    import { mock } from "bun:test";
    const repo = "acme/app";
    const details = new Map();
    const detail = (number, overrides = {}) => ({
      number, title: "feat(api): hand off #" + number, body: "", url: "https://github.com/acme/app/pull/" + number,
      state: "OPEN", isDraft: false, author: { login: "theo" }, baseRefName: "main", headRefName: "feature-" + number,
      headRefOid: String(number % 10).repeat(40), createdAt: "2026-09-24T07:00:00Z", updatedAt: "2026-09-24T07:00:00Z",
      mergedAt: null, closedAt: null, additions: 1, deletions: 0, changedFiles: 1, commitCount: { totalCount: 1 },
      mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: null, viewerIsAuthor: true,
      viewerReviewRequested: false, viewerReviewState: null, reviews: { nodes: [] }, reviewRequests: { nodes: [] },
      comments: { nodes: [] }, reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      lastCommit: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [] } } } }] },
      ...overrides,
    });
    // Dynamic imports let mock.module replace GitHub, mirror, and Actions I/O before the isolated child opens SQLite.
    const github = await import(${url("./github.ts")});
    mock.module(${url("./github.ts")}, () => ({
      ...github,
      fetchPrDetail: async (_repo, number) => details.get(number),
      getViewerLogin: async () => "theo",
    }));
    const mirror = await import(${url("./mirror.ts")});
    mock.module(${url("./mirror.ts")}, () => ({ ...mirror, fetchMirror: async () => {} }));
    const runLogs = await import(${url("./runLogs.ts")});
    mock.module(${url("./runLogs.ts")}, () => ({ ...runLogs, cacheGithubActionsForCommit: async () => {} }));
    const { refreshPr } = await import(${url("./poller.ts")});
    const { buildFetchHandler } = await import(${url("./http.ts")});
    const handler = buildFetchHandler(0, {
      fetchGithubQuota: async () => { throw new Error("offline fixture"); },
      fetchPrCommentsSince: async () => [],
    });
    // Resolves once the listener holds its baseline, so the mark below is a change it must observe.
    const { promise: listenBaseline, resolve: listenRead } = Promise.withResolvers();
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const response = await handler(request);
        if (request.method === "GET" && new URL(request.url).pathname === "/api/agent/pr/acme/app/8") listenRead();
        return response;
      },
    });
    const base = "http://127.0.0.1:" + server.port;
    const post = async (path, body, method = "POST") => {
      const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const inbox = async () => Object.fromEntries((await (await fetch(base + "/api/inbox")).json()).prs
      .map((pr) => [pr.number, { ready: pr.readyForReview, approved: pr.approvedForSafeMerge, rank: pr.rank }]));
    const detailReady = async (number) => (await (await fetch(base + "/api/pr/acme/app/" + number + "?prefetch=1")).json()).readyForReview;
    const refresh = async (number, overrides) => {
      details.set(number, detail(number, overrides));
      await refreshPr(repo, number, "relay", "all");
    };
    const run = async (...args) => {
      const child = Bun.spawn([${cli}, ...args], {
        env: { ...process.env, COCKPIT_PORT: String(server.port), COCKPIT_LISTEN_INTERVAL: "0.2" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { code, stdout, stderr: stderr.trim() };
    };
    const cli = async (...args) => {
      const { code, stdout, stderr } = await run(...args);
      if (code !== 0) throw new Error(stderr);
      return stdout;
    };
    const cliState = async (number) => ({
      text: (await cli("acme/app#" + number)).split("\\n").find((line) => line.startsWith("Review handoff:")),
      json: JSON.parse(await cli("acme/app#" + number, "--json")).readyForReview,
    });

    await refresh(7);
    await refresh(8);
    await post("/api/settings", { safe_merge_approval_enabled: true }, "PUT");
    await post("/api/pr/acme/app/7/merge-approval", { approved: true });
    await post("/api/inbox/reorder", { repo, number: 8, position: 10 });
    const result = { before: await inbox() };

    // Listen wakes on the handoff even when scoped to merge state.
    const listener = run("listen", "acme/app#8", "--conflicts-only");
    await listenBaseline;
    result.mark8 = JSON.parse(await cli("mark-ready", "acme/app#8"));
    const woke = await listener;
    result.listen = { code: woke.code, line: woke.stdout.split("\\n").find((line) => line.startsWith("Review handoff:")) };
    result.marked = { inbox: await inbox(), detail: await detailReady(8), cli8: await cliState(8), cli7: await cliState(7) };

    // The mark records the head GitHub has now, not a lagging cached one.
    details.set(7, detail(7, { headRefOid: "a".repeat(40), updatedAt: "2026-09-24T08:00:00Z" }));
    result.mark7 = JSON.parse(await cli("mark-ready", "acme/app#7"));
    result.marked7 = (await inbox())[7];

    await refresh(7, { headRefOid: "b".repeat(40), updatedAt: "2026-09-24T09:00:00Z" });
    result.afterPush = { inbox: (await inbox())[7], detail: await detailReady(7), cli: await cliState(7) };
    // A force-push back to the verified head does not revive the mark.
    await refresh(7, { headRefOid: "a".repeat(40), updatedAt: "2026-09-24T09:30:00Z" });
    result.afterPushBack = (await inbox())[7];

    result.appMark = await post("/api/pr/acme/app/7/review-handoff", { ready: true });
    await cli("mark-ready", "acme/app#7");
    result.appClear = await post("/api/pr/acme/app/7/review-handoff", { ready: false });
    result.afterAppClear = { inbox: (await inbox())[7], cli: await cliState(7) };

    await refresh(8, { state: "CLOSED", closedAt: "2026-09-24T10:00:00Z" });
    result.afterClose = { inbox: (await inbox())[8], detail: await detailReady(8), cli: await cliState(8) };
    result.closedMark = await run("mark-ready", "acme/app#8");
    await refresh(8, { state: "OPEN", closedAt: null });
    result.afterReopen = (await inbox())[8];

    await cli("mark-ready", "acme/app#8");
    result.unmark8 = JSON.parse(await cli("unmark-ready", "acme/app#8"));
    result.afterUnmark = { inbox: await inbox(), cli: await cliState(8) };

    server.stop(true);
    console.log(JSON.stringify(result));
    process.exit(0);
  `;
  try {
    const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", scenario], {
      env: { ...Bun.env, COCKPIT_DATA_DIR: dataDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    const ready = { text: "Review handoff: ready for review", json: true };
    const notMarked = { text: "Review handoff: not marked", json: false };

    expect(result.before).toEqual({
      7: { ready: false, approved: true, rank: null },
      8: { ready: false, approved: false, rank: 10 },
    });
    expect(result.mark8).toEqual({ readyForReview: true, headSha: "8".repeat(40) });
    expect(result.listen).toEqual({ code: 0, line: "Review handoff: ready for review" });
    expect(result.marked).toEqual({
      inbox: { 7: { ready: false, approved: true, rank: null }, 8: { ready: true, approved: false, rank: 10 } },
      detail: true,
      cli8: ready,
      cli7: notMarked,
    });
    expect(result.mark7).toEqual({ readyForReview: true, headSha: "a".repeat(40) });
    expect(result.marked7).toEqual({ ready: true, approved: true, rank: null });
    expect(result.afterPush).toEqual({ inbox: { ready: false, approved: true, rank: null }, detail: false, cli: notMarked });
    expect(result.afterPushBack).toEqual({ ready: false, approved: true, rank: null });
    expect(result.appMark).toEqual({ status: 403, body: { error: "only an agent marks a PR ready for review" } });
    expect(result.appClear).toEqual({ status: 200, body: { readyForReview: false, headSha: null } });
    expect(result.afterAppClear).toEqual({ inbox: { ready: false, approved: true, rank: null }, cli: notMarked });
    expect(result.afterClose).toEqual({ inbox: { ready: false, approved: false, rank: 10 }, detail: false, cli: notMarked });
    expect(result.closedMark).toMatchObject({ code: 1, stderr: "pr-cockpit: acme/app#8 is not an open inbox PR" });
    expect(result.afterReopen).toEqual({ ready: false, approved: false, rank: 10 });
    expect(result.unmark8).toEqual({ readyForReview: false, headSha: null });
    expect(result.afterUnmark).toEqual({
      inbox: { 7: { ready: false, approved: true, rank: null }, 8: { ready: false, approved: false, rank: 10 } },
      cli: notMarked,
    });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 60_000);
