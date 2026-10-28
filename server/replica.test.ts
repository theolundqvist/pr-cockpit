import { expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import type { GithubQuota } from "./github.ts";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function reservePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  return port!;
}

async function waitForServer(port: number, process: Subprocess<"ignore", "pipe", "pipe">): Promise<void> {
  let lastError = "server did not start";
  for (let attempt = 0; attempt < 100; attempt++) {
    if (process.exitCode !== null) {
      lastError = await new Response(process.stderr).text();
      break;
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch (error) {
      lastError = String(error);
    }
    await Bun.sleep(50);
  }
  throw new Error(lastError);
}

test("a local server imports inbox state and proxies GitHub-backed APIs through its source", async () => {
  const root = mkdtempSync(join(tmpdir(), "pr-cockpit-replica-"));
  const sourcePort = reservePort();
  const replicaPort = reservePort();
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), "#!/usr/bin/env bash\nwhile kill -0 \"$PPID\" 2>/dev/null; do sleep 0.1; done\n");
  chmodSync(join(bin, "ssh"), 0o755);
  writeFileSync(join(bin, "gh"), "#!/usr/bin/env bash\nexit 1\n");
  chmodSync(join(bin, "gh"), 0o755);

  const source = Bun.spawn([Bun.which("bun") ?? "bun", "server/main.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...Bun.env,
      COCKPIT_PORT: String(sourcePort),
      COCKPIT_DATA_DIR: join(root, "source"),
      COCKPIT_MOCK: "1",
      COCKPIT_REPLICA_SSH_HOST: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let replica: Bun.Subprocess | null = null;

  try {
    await waitForServer(sourcePort, source);
    const sourceSnapshotResponse = await fetch(`http://127.0.0.1:${sourcePort}/api/replica/inbox`);
    expect(sourceSnapshotResponse.status).toBe(200);
    const etag = sourceSnapshotResponse.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
    const sourceSnapshot = await sourceSnapshotResponse.json() as { tables: Record<string, unknown[]> };
    expect(sourceSnapshot.tables.prs.length).toBeGreaterThan(0);
    expect(sourceSnapshot.tables).not.toHaveProperty("review_scores");
    expect(sourceSnapshot.tables).not.toHaveProperty("review_rescores");
    expect(sourceSnapshot.tables).not.toHaveProperty("desktop_notifications");
    expect(sourceSnapshot.tables).not.toHaveProperty("settings");
    expect((await fetch(`http://127.0.0.1:${sourcePort}/api/replica/inbox`, {
      headers: { "if-none-match": etag! },
    })).status).toBe(304);

    replica = Bun.spawn([Bun.which("bun") ?? "bun", "server/main.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...Bun.env,
        PATH: `${bin}:${Bun.env.PATH}`,
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
        COCKPIT_PORT: String(replicaPort),
        COCKPIT_DATA_DIR: join(root, "replica"),
        COCKPIT_MOCK: "",
        COCKPIT_REPLICA_SSH_HOST: "fixture-source",
        COCKPIT_REPLICA_LOCAL_PORT: String(sourcePort),
        COCKPIT_PROXY_PORT: String(sourcePort),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForServer(replicaPort, replica);

    const status = await fetch(`http://127.0.0.1:${replicaPort}/api/replica/status`).then((response) => response.json()) as { connected: boolean; lastError: string | null };
    expect(status).toEqual(expect.objectContaining({ connected: true, lastError: null }));

    // A connected renderer only refreshes its open detail on a matching PR event, not an inbox
    // event. Exercise the installed server path, including an edit with unchanged counts/timestamps.
    const livePr = sourceSnapshot.tables.prs![0] as { repo: string; number: number; detail_json: string };
    const detailPath = `/api/pr/${livePr.repo}/${livePr.number}`;
    const originalDetail = JSON.parse(livePr.detail_json);
    let socket = new WebSocket(`ws://127.0.0.1:${replicaPort}/api/events`);
    const opened = (ws: WebSocket) => new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("replica event socket failed")), { once: true });
    });
    await opened(socket);
    const publishComment = (body: string) => {
      const detail = {
        ...originalDetail,
        comments: { ...originalDetail.comments, nodes: [
          ...(originalDetail.comments?.nodes ?? []),
          { id: "synthetic-preview", body, author: { login: "preview-bot" }, createdAt: "2026-10-28T12:00:00Z" },
        ] },
      };
      const writer = new Database(join(root, "source", "cockpit.db"));
      try {
        // Deliberately leave updated_at, fetched_at, and every inbox counter unchanged.
        writer.query("UPDATE prs SET detail_json = ? WHERE repo = ? AND number = ?")
          .run(JSON.stringify(detail), livePr.repo, livePr.number);
      } finally {
        writer.close();
      }
    };
    const refreshFromEvent = async (body: string) => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      // Real server processes own the production sync timer; this deadline bounds a missing
      // event rather than sleeping to guess when replication has finished.
      const timer = setTimeout(() => reject(new Error(`No PR invalidation for ${body}`)), 7_000);
      const onMessage = (message: MessageEvent) => {
        const event = JSON.parse(String(message.data));
        if (event.type !== "pr" || event.repo !== livePr.repo || event.number !== livePr.number) return;
        // Read immediately, just as the renderer does; data must already be committed.
        void (async () => {
          const local = new Database(join(root, "replica", "cockpit.db"), { readonly: true });
          try {
            const row = local.query<{ detail_json: string }, [string, number]>(
              "SELECT detail_json FROM prs WHERE repo = ? AND number = ?",
            ).get(livePr.repo, livePr.number)!;
            expect(JSON.parse(row.detail_json).comments.nodes.at(-1).body).toBe(body);
          } finally {
            local.close();
          }
          const response = await fetch(`http://127.0.0.1:${replicaPort}${detailPath}`);
          expect(response.status).toBe(200);
          expect((await response.json() as typeof originalDetail).comments.nodes.at(-1).body).toBe(body);
        })().then(resolve, reject);
      };
      socket.addEventListener("message", onMessage);
      publishComment(body);
      try {
        await promise;
      } finally {
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
      }
    };
    try {
      await refreshFromEvent("Preview is building");
      await refreshFromEvent("Preview is ready");
    } finally {
      socket.close();
    }
    expect((await fetch(`http://127.0.0.1:${replicaPort}/api/replica/inbox`)).status).toBe(409);
    const sourceInbox = await fetch(`http://127.0.0.1:${sourcePort}/api/inbox`).then((response) => response.json()) as { prs: Array<{ repo: string; number: number }> };
    const replicaInbox = await fetch(`http://127.0.0.1:${replicaPort}/api/inbox`).then((response) => response.json()) as { prs: Array<{ repo: string; number: number }> };
    expect(replicaInbox.prs.map(({ repo, number }) => `${repo}#${number}`)).toEqual(
      sourceInbox.prs.map(({ repo, number }) => `${repo}#${number}`),
    );
    const storedDetail = sourceSnapshot.tables.prs?.[0];
    if (!storedDetail || typeof storedDetail !== "object" || !("detail_json" in storedDetail) || typeof storedDetail.detail_json !== "string") {
      throw new Error("Source fixture has no stored PR detail");
    }
    const detail = {
      ...JSON.parse(storedDetail.detail_json),
      title: "Outside the replicated inbox",
      url: "https://github.com/fixture/external/pull/901",
    };
    const sourceDb = new Database(join(root, "source", "cockpit.db"));
    try {
      sourceDb.query("INSERT INTO pr_detail_cache (repo, number, head_sha, detail_json, fetched_at) VALUES (?, ?, ?, ?, ?)").run(
        "fixture/external", 901, detail.headRefOid, JSON.stringify(detail), new Date().toISOString(),
      );
    } finally {
      sourceDb.close();
    }
    const tracked = sourceInbox.prs[0]!;
    const trackedKey = `${tracked.repo}#${tracked.number}`;
    const keys = [trackedKey, "fixture/external#901", "fixture/external#902"];
    const embedded = await fetch(`http://127.0.0.1:${replicaPort}/api/pr-details?rows=1&keys=${encodeURIComponent(keys.join(","))}`)
      .then((response) => response.json()) as { rows: Record<string, unknown> };
    expect(embedded.rows[trackedKey]).toMatchObject(tracked);
    expect(embedded.rows["fixture/external#901"]).toMatchObject({
      repo: "fixture/external", number: 901, title: "Outside the replicated inbox",
    });
    expect(embedded.rows).not.toHaveProperty("fixture/external#902");
    const sourceQuota = await fetch(`http://127.0.0.1:${sourcePort}/api/quota`).then((response) => response.json()) as GithubQuota;
    const replicaQuota = await fetch(`http://127.0.0.1:${replicaPort}/api/quota`).then((response) => response.json()) as GithubQuota;
    expect(replicaQuota).toEqual({
      ...sourceQuota,
      fetchedAt: expect.any(String),
      rest: { ...sourceQuota.rest, resetAt: expect.any(String) },
      graphql: { ...sourceQuota.graphql, resetAt: expect.any(String) },
      search: { ...sourceQuota.search, resetAt: expect.any(String) },
    });
    const allPrsPath = "/api/all-prs?repo=fixture%2Fcockpit";
    const sourceAllPrs = await fetch(`http://127.0.0.1:${sourcePort}${allPrsPath}`);
    const replicaAllPrs = await fetch(`http://127.0.0.1:${replicaPort}${allPrsPath}`);
    expect(sourceAllPrs.status).toBe(200);
    expect(replicaAllPrs.status).toBe(200);
    expect(await replicaAllPrs.json()).toEqual(await sourceAllPrs.json());
    const sourceHistory = await fetch(`http://127.0.0.1:${sourcePort}/api/kitchen-history`).then((r) => r.json());
    const replicaHistory = await fetch(`http://127.0.0.1:${replicaPort}/api/kitchen-history`).then((r) => r.json());
    expect(replicaHistory).toEqual(sourceHistory);
    source.kill();
    await source.exited;
    expect((await fetch(`http://127.0.0.1:${replicaPort}/api/kitchen-history`)).status).toBe(503);
    const offlineInbox = await fetch(`http://127.0.0.1:${replicaPort}/api/inbox`).then((response) => response.json());
    expect(offlineInbox).toEqual(replicaInbox);
    const offlineAllPrs = await fetch(`http://127.0.0.1:${replicaPort}${allPrsPath}`);
    expect(offlineAllPrs.status).toBe(503);
    expect((await offlineAllPrs.json()).prs).toBeUndefined();
    expect((await fetch(`http://127.0.0.1:${replicaPort}/api/pr-index`)).status).toBe(200);
    const cachedPr = replicaInbox.prs[0]!;
    for (const path of [
      `/api/pr-index?keys=${encodeURIComponent(`${cachedPr.repo}#${cachedPr.number}`)}`,
      "/api/search-prs?q=missing-title",
    ]) {
      const response = await fetch(`http://127.0.0.1:${replicaPort}${path}`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "PR Cockpit source fixture-source is unavailable" });
    }
  } finally {
    replica?.kill();
    source.kill();
    await Promise.all([replica?.exited, source.exited]);
    rmSync(root, { recursive: true, force: true });
  }
}, 25_000);

test("a replica mirrors the source's failed merges without touching its local mutation queue", async () => {
  const root = mkdtempSync(join(tmpdir(), "pr-cockpit-replica-merges-"));
  const sourcePort = reservePort();
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), "#!/usr/bin/env bash\nwhile kill -0 \"$PPID\" 2>/dev/null; do sleep 0.1; done\n");
  chmodSync(join(bin, "ssh"), 0o755);
  const scenario = `
    const db = await import(${JSON.stringify(new URL("./db.ts", import.meta.url).href)});
    const { replicaFailedMergeKeys, replicaStatus, startReplicaSync } = await import(${JSON.stringify(new URL("./replica.ts", import.meta.url).href)});
    const { buildFetchHandler } = await import(${JSON.stringify(new URL("./http.ts", import.meta.url).href)});
    const repo = "fixture/cockpit";
    db.setSetting("replica_ssh_host", "fixture-source");
    db.db.query(\`INSERT INTO prs (
      repo, number, state, is_draft, title, author, base_ref, head_ref, head_sha,
      updated_at, additions, deletions, changed_files, commit_count, mergeable,
      ci_status, unresolved_count, needs_me_rank, detail_json, fetched_at
    ) VALUES (?, 301, 'OPEN', 0, 'open PR', 'author', 'main', 'feature', ?, ?, 0, 0, 0, 1,
      'MERGEABLE', 'SUCCESS', 0, 0, ?, ?)\`).run(
      repo, "a".repeat(40), "2026-09-21T20:00:00Z",
      JSON.stringify({ body: "", comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] } }), "2026-09-21T20:00:00Z",
    );
    const tables = db.readInboxReplica();
    const localId = db.insertMutation({
      repo, number: 301, kind: "merge", created_at: new Date().toISOString(),
      payload_json: JSON.stringify({ kind: "merge", force: false, baseRef: "main", method: "squash", source: "default" }),
    });
    db.setMutationState(localId, "failed", "local failure");

    let snapshot = { revision: '"old"', lastPollAt: null, viewerLogin: null, tables };
    const source = Bun.serve({
      port: ${sourcePort},
      fetch: (request) => new URL(request.url).pathname === "/healthz" ? new Response("ok") : Response.json(snapshot),
    });
    const handler = buildFetchHandler(4820);
    const sync = async () => {
      (await startReplicaSync())();
      const { prs } = await (await handler(new Request("http://127.0.0.1:4820/api/inbox"))).json();
      return {
        mergeFailed: prs.find((pr) => pr.number === 301)?.mergeFailed,
        mirrored: [...replicaFailedMergeKeys()],
        localErrors: db.listMutationsForPr(repo, 301).map((row) => row.error),
        lastError: replicaStatus().lastError,
      };
    };
    const oldSource = await sync();
    snapshot = { ...snapshot, revision: '"failed"', failedMergeKeys: [repo + "#301"] };
    const failedSource = await sync();
    snapshot = { ...snapshot, revision: '"malformed"', failedMergeKeys: [301] };
    const malformedSource = await sync();
    source.stop(true);
    console.log(JSON.stringify({ oldSource, failedSource, malformedSource }));
    process.exit(0);
  `;

  try {
    const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", scenario], {
      env: {
        ...Bun.env,
        PATH: `${bin}:${Bun.env.PATH}`,
        COCKPIT_DATA_DIR: join(root, "replica"),
        COCKPIT_MOCK: "",
        COCKPIT_REPLICA_SSH_HOST: "fixture-source",
        COCKPIT_REPLICA_LOCAL_PORT: String(sourcePort),
      },
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
    expect(result.oldSource).toEqual({ mergeFailed: false, mirrored: [], localErrors: ["local failure"], lastError: null });
    expect(result.failedSource).toEqual({ mergeFailed: true, mirrored: ["fixture/cockpit#301"], localErrors: ["local failure"], lastError: null });
    expect(result.malformedSource).toEqual({
      mergeFailed: true,
      mirrored: ["fixture/cockpit#301"],
      localErrors: ["local failure"],
      lastError: "Replica source returned invalid failed merges",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a replica mirrors its source's merge-approval flag and rows, and toggles only through the source", async () => {
  const root = mkdtempSync(join(tmpdir(), "pr-cockpit-replica-approvals-"));
  const sourcePort = reservePort();
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), "#!/usr/bin/env bash\nwhile kill -0 \"$PPID\" 2>/dev/null; do sleep 0.1; done\n");
  chmodSync(join(bin, "ssh"), 0o755);
  const scenario = `
    const db = await import(${JSON.stringify(new URL("./db.ts", import.meta.url).href)});
    const { replicaStatus, startReplicaSync } = await import(${JSON.stringify(new URL("./replica.ts", import.meta.url).href)});
    const { buildFetchHandler } = await import(${JSON.stringify(new URL("./http.ts", import.meta.url).href)});
    const repo = "fixture/cockpit";
    db.setSetting("replica_ssh_host", "fixture-source");
    db.db.query(\`INSERT INTO prs (
      repo, number, state, is_draft, title, author, base_ref, head_ref, head_sha,
      updated_at, additions, deletions, changed_files, commit_count, mergeable,
      ci_status, unresolved_count, needs_me_rank, detail_json, fetched_at
    ) VALUES (?, 301, 'OPEN', 0, 'open PR', 'author', 'main', 'feature', ?, ?, 0, 0, 0, 1,
      'MERGEABLE', 'SUCCESS', 0, 0, ?, ?)\`).run(
      repo, "a".repeat(40), "2026-09-21T20:00:00Z",
      JSON.stringify({ state: "OPEN", body: "", comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] } }), "2026-09-21T20:00:00Z",
    );
    const { pr_merge_approvals: _, ...legacyTables } = db.readInboxReplica();
    const source = { legacy: true, confirms: true, enabled: false, approvals: [], settingsBodies: [] };
    const server = Bun.serve({
      port: ${sourcePort},
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/healthz") return new Response("ok");
        if (path === "/api/settings") {
          const body = await request.json();
          source.settingsBodies.push(body);
          // A source predating the flag ignores it and answers with its other settings.
          if (!source.confirms) return Response.json({ theme: "system" });
          source.enabled = body.safe_merge_approval_enabled;
          if (!source.enabled) source.approvals = [];
          return Response.json({ safe_merge_approval_enabled: source.enabled });
        }
        if (source.legacy) return Response.json({ revision: '"legacy"', lastPollAt: null, viewerLogin: null, tables: legacyTables });
        return Response.json({
          revision: '"' + source.enabled + source.approvals.length + '"',
          lastPollAt: null,
          viewerLogin: null,
          safeMergeApprovalEnabled: source.enabled,
          tables: { ...legacyTables, pr_merge_approvals: source.approvals },
        });
      },
    });
    const handler = buildFetchHandler(4820);
    const observe = async () => {
      const { prs } = await (await handler(new Request("http://127.0.0.1:4820/api/inbox"))).json();
      const settings = await (await handler(new Request("http://127.0.0.1:4820/api/settings"))).json();
      return {
        approved: prs.find((pr) => pr.number === 301)?.approvedForSafeMerge,
        flag: settings.safe_merge_approval_enabled,
        theme: settings.theme,
        lastError: replicaStatus().lastError,
      };
    };
    const sync = async () => {
      (await startReplicaSync())();
      return observe();
    };
    const put = async (body) => {
      const response = await handler(new Request("http://127.0.0.1:4820/api/settings", { method: "PUT", body: JSON.stringify(body) }));
      return { status: response.status, ...(await observe()) };
    };
    db.setSetting("safe_merge_approval_enabled", "true");
    const legacySource = await sync();
    source.legacy = false;
    source.enabled = true;
    source.approvals = [{ repo, number: 301, approved_at: "2026-09-21T20:01:00Z" }];
    const approvedSource = await sync();
    source.confirms = false;
    const unconfirmedDisable = await put({ safe_merge_approval_enabled: false, theme: "light" });
    source.confirms = true;
    const confirmedDisable = await put({ safe_merge_approval_enabled: false, theme: "light" });
    const afterDisableSync = await sync();
    // The source re-enabled and gained consent before this replica synced; an explicit disable still reaches it.
    source.enabled = true;
    source.approvals = [{ repo, number: 301, approved_at: "2026-09-21T20:02:00Z" }];
    const staleMirrorDisable = await put({ safe_merge_approval_enabled: false });
    const sourceAfterStaleDisable = { enabled: source.enabled, approvals: source.approvals.length };
    const reenabled = await put({ safe_merge_approval_enabled: true });
    server.stop(true);
    console.log(JSON.stringify({ legacySource, approvedSource, unconfirmedDisable, confirmedDisable, afterDisableSync, staleMirrorDisable, sourceAfterStaleDisable, reenabled, settingsBodies: source.settingsBodies }));
    process.exit(0);
  `;

  try {
    const child = Bun.spawn([Bun.which("bun") ?? "bun", "-e", scenario], {
      env: {
        ...Bun.env,
        PATH: `${bin}:${Bun.env.PATH}`,
        COCKPIT_DATA_DIR: join(root, "replica"),
        COCKPIT_MOCK: "",
        COCKPIT_REPLICA_SSH_HOST: "fixture-source",
        COCKPIT_REPLICA_LOCAL_PORT: String(sourcePort),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr);
    expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual({
      legacySource: { approved: false, flag: false, theme: "system", lastError: null },
      approvedSource: { approved: true, flag: true, theme: "system", lastError: null },
      unconfirmedDisable: { status: 502, approved: true, flag: true, theme: "system", lastError: null },
      confirmedDisable: { status: 200, approved: false, flag: false, theme: "light", lastError: null },
      afterDisableSync: { approved: false, flag: false, theme: "light", lastError: null },
      staleMirrorDisable: { status: 200, approved: false, flag: false, theme: "light", lastError: null },
      sourceAfterStaleDisable: { enabled: false, approvals: 0 },
      reenabled: { status: 200, approved: false, flag: true, theme: "light", lastError: null },
      settingsBodies: [
        { safe_merge_approval_enabled: false },
        { safe_merge_approval_enabled: false },
        { safe_merge_approval_enabled: false },
        { safe_merge_approval_enabled: true },
      ],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a mirrorless replica's inbox counts converge to its source's generated-file rules under its own test pattern", async () => {
  const root = mkdtempSync(join(tmpdir(), "pr-cockpit-replica-generated-"));
  const sourcePort = reservePort();
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), "#!/usr/bin/env bash\nwhile kill -0 \"$PPID\" 2>/dev/null; do sleep 0.1; done\n");
  chmodSync(join(bin, "ssh"), 0o755);

  // A native Git repository: the source's mirror answers attributes; the replica never gets one.
  const work = join(root, "work");
  mkdirSync(work);
  const git = (args: string[], date = "2026-09-21T20:00:00Z") => {
    const result = Bun.spawnSync(["git", "-C", work, ...args], {
      env: {
        PATH: Bun.env.PATH ?? "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "Example", GIT_AUTHOR_EMAIL: "example@example.com", GIT_COMMITTER_NAME: "Example",
        GIT_COMMITTER_EMAIL: "example@example.com", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
      },
    });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };
  const write = (files: Record<string, number | string>) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(work, path, ".."), { recursive: true });
      writeFileSync(join(work, path), typeof content === "string" ? content : Array.from({ length: content }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    }
    git(["add", "-A"]);
  };
  git(["init", "-q", "-b", "main"]);
  write({ ".gitattributes": "gen/** linguist-generated\nvendor/lib.js -linguist-generated\n", "README.md": 1 });
  git(["commit", "-q", "-m", "base"]);
  const base = git(["rev-parse", "HEAD"]);
  git(["checkout", "-q", "-b", "feature"]);
  write({ "src/app.ts": 10, "src/app.spec.ts": 4, "src/app.test.ts": 3, "gen/schema.json": 20, "catalog.generated.md": 5, "vendor/lib.js": 7 });
  git(["commit", "-q", "-m", "head one"]);
  const head1 = git(["rev-parse", "HEAD"]);
  write({ ".gitattributes": "gen/** linguist-generated\nvendor/** linguist-generated\n", "src/app.ts": 12 });
  git(["commit", "-q", "-m", "head two"]);
  const head2 = git(["rev-parse", "HEAD"]);
  git(["checkout", "-q", "main"]);
  write({ "README.md": 2 });
  git(["commit", "-q", "-m", "base two"]);
  const base2 = git(["rev-parse", "HEAD"]);
  mkdirSync(join(root, "source", "mirrors"), { recursive: true });
  git(["clone", "-q", "--mirror", work, join(root, "source", "mirrors", "fixture__cockpit")]);
  const prState = (baseOid: string, headOid: string, fetchedAt: string) => {
    const nodes = git(["diff", "--numstat", `${baseOid}...${headOid}`]).split("\n").map((line) => {
      const [additions, deletions, path] = line.split("\t");
      return { path: path!, additions: Number(additions), deletions: Number(deletions) };
    });
    return {
      head: headOid,
      fetchedAt,
      additions: nodes.reduce((sum, file) => sum + file.additions, 0),
      deletions: nodes.reduce((sum, file) => sum + file.deletions, 0),
      detail: { baseRefOid: baseOid, files: { totalCount: nodes.length, nodes }, body: "", comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] } },
    };
  };
  const states = {
    head1: prState(base, head1, "2026-09-21T20:00:00Z"),
    head2: prState(base, head2, "2026-09-21T20:01:00Z"),
    base2: prState(base2, head2, "2026-09-21T20:02:00Z"),
  };

  // The source is a real non-mock HTTP handler over the mirror. Its wrapper only records requests and
  // holds the first generated-files answer until the replica has served its first inbox.
  const sourceScript = `
    const db = await import(${JSON.stringify(new URL("./db.ts", import.meta.url).href)});
    const { buildFetchHandler } = await import(${JSON.stringify(new URL("./http.ts", import.meta.url).href)});
    const states = ${JSON.stringify(states)};
    const setState = (name) => {
      const state = states[name];
      db.db.query("DELETE FROM prs").run();
      db.db.query(\`INSERT INTO prs (
        repo, number, state, is_draft, title, author, base_ref, head_ref, head_sha,
        updated_at, additions, deletions, changed_files, commit_count, mergeable,
        ci_status, unresolved_count, needs_me_rank, detail_json, fetched_at
      ) VALUES ('fixture/cockpit', 301, 'OPEN', 0, 'open PR', 'author', 'main', 'feature', ?, ?, ?, ?, ?, 1,
        'MERGEABLE', 'SUCCESS', 0, 0, ?, ?)\`).run(
        state.head, state.fetchedAt, state.additions, state.deletions, state.detail.files.totalCount,
        JSON.stringify(state.detail), state.fetchedAt,
      );
    };
    setState("head1");
    const handler = buildFetchHandler(${sourcePort});
    const trace = [];
    const { promise: held, resolve: release } = Promise.withResolvers();
    Bun.serve({
      port: ${sourcePort},
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/__state") { setState(url.searchParams.get("name")); return Response.json({ ok: true }); }
        if (url.pathname === "/__release") { release(); return Response.json({ ok: true }); }
        if (url.pathname === "/__trace") return Response.json(trace);
        if (!url.pathname.endsWith("/generated-files")) return handler(request);
        const entry = { base: url.searchParams.get("base"), head: url.searchParams.get("head"), mode: url.searchParams.get("mode"), answered: false };
        trace.push(entry);
        await held;
        const response = await handler(request);
        entry.status = response.status;
        entry.paths = (await response.clone().json()).paths;
        entry.answered = true;
        return response;
      },
    });
  `;
  const replicaScript = `
    const db = await import(${JSON.stringify(new URL("./db.ts", import.meta.url).href)});
    const { startReplicaSync } = await import(${JSON.stringify(new URL("./replica.ts", import.meta.url).href)});
    const { buildFetchHandler } = await import(${JSON.stringify(new URL("./http.ts", import.meta.url).href)});
    db.setSetting("replica_ssh_host", "fixture-source");
    db.setSetting("test_path_regex", "\\\\.spec\\\\.");
    const handler = buildFetchHandler(4820);
    const control = (path) => fetch("http://127.0.0.1:${sourcePort}" + path).then((response) => response.json());
    const counts = async () => {
      const { prs } = await (await handler(new Request("http://127.0.0.1:4820/api/inbox"))).json();
      const row = prs.find((pr) => pr.number === 301);
      return [row.additions, row.deletions, row.rawAdditions];
    };
    // The replica warms counts on a background worker in another process and exposes no completion
    // signal, so the inbox is polled until it reports the expected counts (bounded to 5s).
    const converge = async (expected) => {
      let observed = await counts();
      for (let attempt = 0; attempt < 100 && JSON.stringify(observed) !== JSON.stringify(expected); attempt++) {
        await Bun.sleep(50);
        observed = await counts();
      }
      return observed;
    };
    const result = {};
    (await startReplicaSync())();
    result.first = await counts();
    for (let attempt = 0; attempt < 100 && (await control("/__trace")).length === 0; attempt++) await Bun.sleep(20);
    result.heldAfterFirst = (await control("/__trace")).map((entry) => entry.answered);
    await control("/__release");
    result.head1 = await converge([20, 0, 49]);
    await control("/__state?name=head2");
    (await startReplicaSync())();
    result.head2First = await counts();
    result.head2 = await converge([16, 1, 52]);
    await control("/__state?name=base2");
    (await startReplicaSync())();
    result.base2First = await counts();
    result.base2 = await converge([16, 1, 52]);
    result.trace = await control("/__trace");
    result.replicaMirrorExists = (await import("node:fs")).existsSync(${JSON.stringify(join(root, "replica", "mirrors"))});
    console.log(JSON.stringify(result));
    process.exit(0);
  `;

  const source = Bun.spawn([Bun.which("bun") ?? "bun", "-e", sourceScript], {
    env: { ...Bun.env, COCKPIT_DATA_DIR: join(root, "source"), COCKPIT_MOCK: "", COCKPIT_REPLICA_SSH_HOST: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    await waitForServer(sourcePort, source);
    const replica = Bun.spawn([Bun.which("bun") ?? "bun", "-e", replicaScript], {
      env: {
        ...Bun.env,
        PATH: `${bin}:${Bun.env.PATH}`,
        COCKPIT_DATA_DIR: join(root, "replica"),
        COCKPIT_MOCK: "",
        COCKPIT_REPLICA_SSH_HOST: "fixture-source",
        COCKPIT_REPLICA_LOCAL_PORT: String(sourcePort),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      replica.exited,
      new Response(replica.stdout).text(),
      new Response(replica.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr);
    const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
    // Before the source answers: only the local .spec. pattern and .generated. names are excluded.
    expect(result.first).toEqual([40, 0, 49]);
    expect(result.heldAfterFirst).toEqual([false]);
    // gen/schema.json is generated at head one; src/app.test.ts stays (the source's default pattern would drop it).
    expect(result.head1).toEqual([20, 0, 49]);
    // A new head or base never reuses the previous range's counts.
    expect(result.head2First).toEqual([43, 1, 52]);
    expect(result.head2).toEqual([16, 1, 52]);
    expect(result.base2First).toEqual([43, 1, 52]);
    expect(result.base2).toEqual([16, 1, 52]);
    // One warm per range: inbox polls while a warm is in flight must not ask the source again.
    expect(result.trace.map((entry: { base: string; head: string; mode: string }) => `${entry.mode} ${entry.base}...${entry.head}`))
      .toEqual([`three-dot ${base}...${head1}`, `three-dot ${base}...${head2}`, `three-dot ${base2}...${head2}`]);
    for (const entry of result.trace) {
      expect(entry.status).toBe(200);
      expect([...entry.paths].sort()).toEqual(entry.head === head1 ? ["gen/schema.json"] : ["gen/schema.json", "vendor/lib.js"]);
    }
    expect(result.replicaMirrorExists).toBe(false);
    expect(existsSync(join(root, "replica", "mirrors", "fixture__cockpit"))).toBe(false);
  } finally {
    source.kill();
    await source.exited;
    rmSync(root, { recursive: true, force: true });
  }
});
