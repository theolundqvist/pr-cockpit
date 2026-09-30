import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = (file: string) => JSON.stringify(new URL(file, import.meta.url).href);
const cli = JSON.stringify(join(import.meta.dir, "..", "scripts", "pr-cockpit"));

test("safe-merge approval is explicit, pin-independent, survives head changes, and ends on revoke, close, or disable", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "pr-cockpit-merge-approval-"));
  const scenario = `
    import { mock } from "bun:test";
    const repo = "acme/app";
    const details = new Map();
    const detail = (number, overrides = {}) => ({
      number, title: "feat(api): approve #" + number, body: "", url: "https://github.com/acme/app/pull/" + number,
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
    const handler = buildFetchHandler(0, { fetchGithubQuota: async () => { throw new Error("offline fixture"); } });
    const server = Bun.serve({ port: 0, fetch: handler });
    const base = "http://127.0.0.1:" + server.port;
    const post = async (path, body, method = "POST") => {
      const response = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    };
    const approve = (number, approved) => post("/api/pr/acme/app/" + number + "/merge-approval", { approved });
    const inbox = async () => Object.fromEntries((await (await fetch(base + "/api/inbox")).json()).prs
      .map((pr) => [pr.number, { approved: pr.approvedForSafeMerge, rank: pr.rank }]));
    const detailApproval = async (number) => (await (await fetch(base + "/api/pr/acme/app/" + number + "?prefetch=1")).json()).approvedForSafeMerge;
    const refresh = async (number, overrides) => {
      details.set(number, detail(number, overrides));
      await refreshPr(repo, number, "relay", "all");
    };
    const read = async (...args) => {
      const child = Bun.spawn([${cli}, ...args], { env: { ...process.env, COCKPIT_PORT: String(server.port) }, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0) throw new Error(stderr);
      return stdout;
    };
    const cliState = async (number) => ({
      text: (await read("acme/app#" + number)).split("\\n").find((line) => line.startsWith("Merge approval:")),
      json: JSON.parse(await read("acme/app#" + number, "--json")).approvedForSafeMerge,
    });

    await refresh(7);
    await refresh(8);
    const result = {};
    const settings = await (await fetch(base + "/api/settings")).json();
    result.defaults = { approval: settings.safe_merge_approval_enabled, drag: settings.group_drag_enabled };
    result.disabledGrant = await approve(7, true);
    result.disabledInbox = await inbox();

    result.enabled = (await post("/api/settings", { safe_merge_approval_enabled: true, group_drag_enabled: true }, "PUT")).body;
    await post("/api/inbox/reorder", { repo, number: 8, position: 10 });
    result.pinOnly = await inbox();
    result.grant = await approve(7, true);
    await post("/api/inbox/reorder", { repo, number: 7, position: 5 });
    await post("/api/inbox/reorder", { repo, number: 7, position: null });
    result.afterPinCycle = { inbox: await inbox(), detail: await detailApproval(7), cli7: await cliState(7), cli8: await cliState(8) };

    await refresh(7, { headRefOid: "f".repeat(40), mergeStateStatus: "BEHIND", updatedAt: "2026-09-24T08:00:00Z" });
    result.afterHeadChange = (await inbox())[7];

    result.revoke = await approve(7, false);
    result.afterRevoke = { inbox: (await inbox())[7], cli: await cliState(7) };

    await approve(7, true);
    await refresh(7, { state: "CLOSED", closedAt: "2026-09-24T09:00:00Z" });
    result.closedGrant = await approve(7, true);
    await refresh(7, { state: "OPEN", closedAt: null });
    result.afterReopen = (await inbox())[7];

    await approve(7, true);
    await post("/api/settings", { safe_merge_approval_enabled: false }, "PUT");
    await post("/api/settings", { safe_merge_approval_enabled: true }, "PUT");
    result.afterReenable = { inbox: (await inbox())[7], cli: await cliState(7) };

    await refresh(8, { isDraft: true, state: "CLOSED", closedAt: "2026-09-24T09:00:00Z" });
    result.closedDraftGrant = await approve(8, true);

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
    const granted = { text: "Merge approval: approved for safe merge", json: true };
    const notGranted = { text: "Merge approval: not granted", json: false };

    expect(result.defaults).toEqual({ approval: false, drag: false });
    expect(result.disabledGrant).toEqual({ status: 409, body: { error: "safe merge approval is disabled" } });
    expect(result.disabledInbox).toEqual({ 7: { approved: false, rank: null }, 8: { approved: false, rank: null } });
    expect(result.enabled).toMatchObject({ safe_merge_approval_enabled: true, group_drag_enabled: true });
    expect(result.pinOnly).toEqual({ 7: { approved: false, rank: null }, 8: { approved: false, rank: 10 } });
    expect(result.grant).toEqual({ status: 200, body: { approvedForSafeMerge: true } });
    expect(result.afterPinCycle).toEqual({
      inbox: { 7: { approved: true, rank: null }, 8: { approved: false, rank: 10 } },
      detail: true,
      cli7: granted,
      cli8: notGranted,
    });
    expect(result.afterHeadChange).toEqual({ approved: true, rank: null });
    expect(result.revoke).toEqual({ status: 200, body: { approvedForSafeMerge: false } });
    expect(result.afterRevoke).toEqual({ inbox: { approved: false, rank: null }, cli: notGranted });
    expect(result.closedGrant).toEqual({ status: 409, body: { error: "acme/app#7 is not an open inbox PR" } });
    expect(result.afterReopen).toEqual({ approved: false, rank: null });
    expect(result.afterReenable).toEqual({ inbox: { approved: false, rank: null }, cli: notGranted });
    expect(result.closedDraftGrant).toEqual({ status: 409, body: { error: "acme/app#8 is not an open inbox PR" } });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 30_000);
